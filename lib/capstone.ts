// 结课作品工坊的数据与生成逻辑：project 课节 = 学员亲手交付结课作品的地方。
// 产品的铁律是"每门课必须有结课作品"（以终为始），工坊就是兑现这个承诺的最后一公里：
// 任务书把"做出作品"拆成可执行的步骤，验收对照做成标准逐条判定，通过即结课。
// 存储按 课程×学员 一份记录（capstones/{courseId}__{userId}.json），跨设备跟账号走。
import { readJson, writeJson } from "@/lib/storage";
import { generateJson } from "@/lib/agent/llm";
import { constraintsBlock } from "@/lib/agent/lang";
import type { CapstoneBrief, CapstoneRecord, CapstoneReview } from "@/types";
import { capstoneBriefSchema, capstoneReviewSchema } from "@/lib/agent/schemas";

/** 生成任务书/验收时用到的大纲切片（course.ts 的 CourseGenState.outline 的结构子集） */
export interface CourseGenOutlineLite {
  units: { title: string; summary: string; lectures: { title: string }[] }[];
}

export type { CapstoneBrief, CapstoneRecord, CapstoneReview };

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function capstoneKey(courseId: string, userId: string): string {
  return `capstones/${sanitizeId(courseId)}__${sanitizeId(userId)}.json`;
}

export async function loadCapstoneRecord(
  courseId: string,
  userId: string
): Promise<CapstoneRecord | null> {
  return readJson<CapstoneRecord | null>(capstoneKey(courseId, userId), null);
}

export async function saveCapstoneRecord(rec: CapstoneRecord): Promise<void> {
  rec.updatedAt = Date.now();
  await writeJson(capstoneKey(rec.courseId, rec.userId), rec);
}

// ---- 任务书生成 ----

const BRIEF_SYSTEM = `你是结课作品导师。这门课以「结课作品」为终点倒推组织（以终为始：学完不是听完了，而是亲手做出了那个东西）。学员现在要动手做作品，请生成一份个性化的任务书，只输出 JSON：
{"title":"任务书标题（点明学员自己的场景，不要泛泛的『任务书』）","mission":"一句话说清最终要交出什么（名词性的东西，外人一看就能检查）","steps":[{"title":"步骤名","detail":"具体做什么、这一步结束手里多出什么，1-2 句"}],"references":["建议回看的课节标题，必须从课程大纲给出的课节里选，2-4 个"],"criteriaCheck":[{"text":"对照检查项","hint":"学员怎么自查这一条"}],"pitfalls":["最常见的 1-2 个翻车点，具体到动作层面"],"timeEstimate":"预计投入，如「3-5 小时，建议分两次」"}

规则：
- steps 4-6 步，每步都要有明确产出物；第一步必须是"先做出能跑起来的最小可展示版本"，最后一步必须是"对照做成标准逐条自查并补齐"。
- 因人而异：结合学习者画像调整场景与颗粒度（零基础：第一步更小、给足脚手架；进阶：给加分挑战）。
- criteriaCheck 必须逐条来自课程的做成标准，不许删减、替换或自行发挥。
- 所有文字对学员直接说话（你），不要输出任何 JSON 之外的内容。`;

export async function generateCapstoneBrief(opts: {
  courseTitle: string;
  audience: string;
  capstoneName: string;
  capstoneDescription: string;
  criteria: string[];
  lectureTitle: string;
  outline: CourseGenOutlineLite;
  outputLanguage?: string;
  constraints?: string[];
  profileHint?: string;
  studentName?: string;
}): Promise<CapstoneBrief | null> {
  const { outline } = opts;
  const unitLines = outline.units
    .map(
      (u) =>
        `《${u.title}》：${u.summary}（课节：${u.lectures.map((l) => l.title).join("、")}）`
    )
    .join("\n");
  const capstoneBlock = opts.criteria.length
    ? `做成标准（学员作品必须逐条满足，criteriaCheck 逐条来自这里，不许改写丢含义）：\n${opts.criteria
        .map((c, i) => `${i + 1}. ${c}`)
        .join("\n")}`
    : `这门课没有显式的做成标准，请从作品定义与项目课节《${opts.lectureTitle}》推断 2-4 条外人可对照检查的标准写入 criteriaCheck（text 填标准，hint 填自查方法）。`;
  const prompt = `课程：《${opts.courseTitle}》（面向：${opts.audience}）
项目课节：《${opts.lectureTitle}》

结课作品：${opts.capstoneName}
${opts.capstoneDescription}
${capstoneBlock}

课程大纲（references 只能从这里选）：
${unitLines}
${opts.profileHint ? `\n学习者画像（因人而异的任务书要吃透这段）：${opts.profileHint}` : ""}${
    opts.studentName ? `\n学员称呼：${opts.studentName}（标题或正文里可自然点名）` : ""
  }
${constraintsBlock(opts.outputLanguage, opts.constraints)}请生成任务书。`;
  const raw = await generateJson<Partial<CapstoneBrief>>(
    BRIEF_SYSTEM,
    prompt, { task: "design", maxTokens: 2200, onError: (e) => console.error("[capstone-brief]", e instanceof Error ? e.message : e), schema: capstoneBriefSchema }
  );
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) return null;
  return {
    title: String(raw.title || `结课任务：${opts.capstoneName}`).slice(0, 80),
    mission: String(raw.mission || opts.capstoneDescription).slice(0, 300),
    steps: raw.steps
      .filter((s) => s && (s.title || s.detail))
      .slice(0, 8)
      .map((s) => ({ title: String(s.title || "").slice(0, 60), detail: String(s.detail || "").slice(0, 300) })),
    references: Array.isArray(raw.references)
      ? raw.references.map((r) => String(r).slice(0, 80)).slice(0, 5)
      : [],
    criteriaCheck:
      Array.isArray(raw.criteriaCheck) && raw.criteriaCheck.length > 0
        ? raw.criteriaCheck
            .filter((c) => c && c.text)
            .slice(0, 6)
            .map((c) => ({ text: String(c.text).slice(0, 160), hint: String(c.hint || "").slice(0, 200) }))
        : opts.criteria.map((c) => ({ text: c, hint: "" })),
    pitfalls: Array.isArray(raw.pitfalls) ? raw.pitfalls.map((p) => String(p).slice(0, 140)).slice(0, 4) : [],
    timeEstimate: String(raw.timeEstimate || "").slice(0, 40),
  };
}

// ---- 验收 ----

const REVIEW_SYSTEM = `你是结课作品的验收导师。学员提交了结课作品，请对照做成标准铁面无私地验收，只输出 JSON：
{"passed":true|false,"overall":"总评 2-3 句：先说做到了什么（具体到证据），再说差距在哪","criteria":[{"text":"做成标准原文","met":true|false,"comment":"判定依据：学员作品里的什么证据满足/缺失了这条"}],"strengths":["亮点 1-2 条，具体"],"improvements":["具体改进动作：不通过时=改哪里怎么改（可执行）；通过时=让作品更进一步的加分建议"]}

规则：
- 判定只看证据：提交描述里必须有能对照标准的具件事（做了什么、结果是什么、外人能看到什么）；"我觉得做得不错"这类空泛自述不算证据，按 met=false 处理并在 comment 里说明缺什么证据。
- passed=true 的门槛：全部标准 met=true。有一条不满足就不通过，不因努力放水。
- 不吹毛求疵：标准之外的个人偏好不作为否决项，最多写进 improvements。
- improvements 每条都是可执行的动作（"把 X 加进 Y，让别人能 Z"），不是"多加油"。`;

export async function reviewCapstoneSubmission(opts: {
  courseTitle: string;
  audience: string;
  capstoneName: string;
  capstoneDescription: string;
  criteria: string[];
  lectureTitle: string;
  submissionText: string;
  submissionLink?: string;
  outputLanguage?: string;
  constraints?: string[];
  studentName?: string;
}): Promise<CapstoneReview | null> {
  const criteriaBlock = opts.criteria.length
    ? opts.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : `（本课无显式做成标准：请从作品定义与《${opts.lectureTitle}》推断 2-4 条标准，逐条给出判定）`;
  const prompt = `课程：《${opts.courseTitle}》（面向：${opts.audience}）
项目课节：《${opts.lectureTitle}》

结课作品：${opts.capstoneName}
${opts.capstoneDescription}

做成标准（逐条判定，全部满足才算通过）：
${criteriaBlock}
${opts.studentName ? `\n学员称呼：${opts.studentName}` : ""}
学员提交：
"""
${opts.submissionText.slice(0, 4000)}
"""
${opts.submissionLink ? `作品链接：${opts.submissionLink.slice(0, 300)}\n` : ""}
${constraintsBlock(opts.outputLanguage, opts.constraints)}请验收。`;
  const raw = await generateJson<Partial<CapstoneReview>>(
    REVIEW_SYSTEM,
    prompt, { task: "judge", maxTokens: 2000, onError: (e) => console.error("[capstone-review]", e instanceof Error ? e.message : e), schema: capstoneReviewSchema }
  );
  if (!raw || !Array.isArray(raw.criteria) || raw.criteria.length === 0) return null;
  const criteria = raw.criteria
    .filter((c) => c && c.text)
    .slice(0, 8)
    .map((c) => ({
      text: String(c.text).slice(0, 160),
      met: Boolean(c.met),
      comment: String(c.comment || "").slice(0, 300),
    }));
  const passed = criteria.length > 0 && criteria.every((c) => c.met);
  return {
    passed,
    overall: String(raw.overall || "").slice(0, 600),
    criteria,
    strengths: Array.isArray(raw.strengths) ? raw.strengths.map((s) => String(s).slice(0, 160)).slice(0, 4) : [],
    improvements: Array.isArray(raw.improvements)
      ? raw.improvements.map((s) => String(s).slice(0, 200)).slice(0, 4)
      : [],
  };
}
