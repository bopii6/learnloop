// 白板课"分段 + 自适应"讲课引擎（服务端）。
//
// 旧做法：开讲时一次性生成整节讲稿（6-9 张卡 + 末尾 1 道题），从头播到尾——学员全程被动。
// 新做法（对标 Hyperknow 实测，并在节奏上更进一步）：
//   start → 规划整节课（4-5 段，每段只讲透一个点）+ 写出第 1 段；
//   每段 = 5-8 拍"一句话 + 白板证据"，段末一个检查问题（预测 / 判断 / 写一行代码）；
//   学员作答后 → next：带着他的原话与对错生成下一段，第一拍先接住他（答错就当场纠偏）；
//   最后一段答完 → 收尾：本节要点卡 + 徽章 + 下一讲预告。
// 生成过的段按（用户 × 课节）落盘：复习时直接读，不再花钱；回放链接也从这里拼。
import { z } from "zod";
import { generateJson, streamJsonLines } from "@/lib/agent/llm";
import { normalizeText } from "@/lib/board/snippet";
import type { BoardAction } from "@/types/board";
import type { MediaTask } from "@/lib/board/script-store";

// ---------------- 数据结构 ----------------

export interface LessonBeat {
  /** 老师这一拍说的一句话 */
  say: string;
  /** 这一拍写到白板上的卡片（Markdown；可省略） */
  board?: string;
  /** 圈出 board 里原样出现的短语 */
  circle?: string;
  /** 可选配图（仅出图通道可用时）：英文 prompt，无文字的教学插画 */
  image?: { caption?: string; prompt: string };
}

export interface LessonCheck {
  kind: "choice" | "open" | "code";
  question: string;
  options?: string[];
  correct_index?: number;
  explanation?: string;
  setup?: string;
  starter?: string;
  solution?: string;
}

export interface LessonSegment {
  beats: LessonBeat[];
  check?: LessonCheck;
}

export interface LessonPlanSegment {
  title: string;
  point: string;
  check?: string;
}

export interface LessonPlan {
  title: string;
  segments: LessonPlanSegment[];
}

export interface LessonReward {
  title: string;
  description: string;
}

// ---------------- 校验 ----------------

const t = (min = 1) => z.string().trim().min(min);

const beatSchema = z.object({ say: t(2) }).loose();

const checkSchema = z
  .object({ kind: z.enum(["choice", "open", "code"]).optional(), question: t(4) })
  .loose()
  .superRefine((c: Record<string, unknown>, ctx) => {
    const kind = c.kind ?? (Array.isArray(c.options) ? "choice" : "open");
    if (kind === "choice" && !(Array.isArray(c.options) && c.options.length >= 2)) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "选择题至少 2 个选项" });
    }
    if (kind === "code" && !(typeof c.solution === "string" && c.solution.trim())) {
      ctx.addIssue({ code: "custom", path: ["solution"], message: "代码题缺参考答案 solution" });
    }
  });

const segmentSchema = z.object({ beats: z.array(beatSchema).min(3, "一段至少 3 拍"), check: checkSchema.optional() }).loose();

/** 模型常把 beats / check 直接写在顶层而不是包进 segment（实测两次连续这样）：先抬进 segment 再校验 */
function liftSegment(v: unknown): unknown {
  if (v && typeof v === "object" && !("segment" in (v as object)) && Array.isArray((v as { beats?: unknown }).beats)) {
    const { beats, check, ...rest } = v as { beats: unknown; check?: unknown };
    return { ...rest, segment: { beats, check } };
  }
  return v;
}

const startSchema = z.preprocess(
  liftSegment,
  z
    .object({
      plan: z.object({ title: t(2), segments: z.array(z.object({ title: t(2), point: t(4) }).loose()).min(3, "至少 3 段").max(6) }).loose(),
      segment: segmentSchema, // 检查题缺失不判失败：这一段讲完自动接下一段（segment_end auto）
    })
    .loose()
);

const nextSchema = z.preprocess(liftSegment, z.object({ segment: segmentSchema }).loose());

const closingSchema = z.preprocess(
  liftSegment,
  z
    .object({
      segment: z.object({ beats: z.array(beatSchema).min(2) }).loose(),
      reward: z.object({ title: t(2), description: t(4) }).loose().optional(),
    })
    .loose()
);

const followupSchema = z.object({ beats: z.array(beatSchema).min(1) }).loose();

// ---------------- 提示词 ----------------

const VOICE = `【怎么讲（最重要）】
- 你是一对一的白板私教，像当面讲课：一次只说一句话，边说边在白板上写，频繁停下来让学员动脑。
- say：一拍一句话，口语，≤45 字。「你看白板上这个数字」「注意，这里有个坑」。禁止长段落、禁止念白板原文、禁止「首先其次最后」式罗列。
- board：**几乎每一拍都写一点**——老师是边说边写的：这句话说到哪个要点，白板上就同时写下这一两行。
  每拍写的是一张小卡：1-3 行，总共 ≤32 字，宁少勿多——留白比堆字好看。可以是：一个短标题加一两条「- 」列表、一个关键数字的对比、一行公式、一小段代码（≤4 行）、一个小表格（≤3 行，要有 | --- | 分隔行）。
  同一个话题连着几拍，就连着写几张小卡（它们会一张接一张排在同一列里，看起来像一块板书慢慢长出来）。
  白板上写「看得见的证据」：具体例子、真实数字、正误对比、代码、公式——道理靠 say 讲，白板留证据。每张卡把**唯一**最关键的那个词/数字加 **粗**（会放大显示，让人一眼看到重点）；别处不加粗。
  只有纯过渡、纯提问的那一拍可以不写。卡片要能独立看懂，不写「如上所述」。
- circle：可选，圈出该拍 board 里**原样出现**的关键短语（≤14 字），一段最多 2 处。
- 术语第一次出现：一句大白话 + 一个具体例子。例子尽量落在学员自己的场景里。
- 文字里要引用词语时用「」，不要用英文双引号（会破坏 JSON）。表格要有表头分隔行 | --- |。`;

const CHECK_RULES = `【段末检查（check）】
{"kind":"choice|open|code","question":"≤30 字","options":["≤14 字"],"correct_index":0,"explanation":"≤40 字：为什么对，错的错在哪"}
- 字数是硬要求：题目一句话问到点上，选项是短语不是句子（好：「行数变多」；坏：「行数会变多，因为每个订单都匹配了多个客户」）。
- 考"预测 / 判断 / 应用"，不考背定义。好问题让人先猜后验证："如果把 X 换成 Y，结果会怎样？"
- choice：2-3 个选项，干扰项必须是真实的常见误区。open：让他用一句话说出预测或结论（不给 options）。
- code：只在编程类课程、且这段讲的正是代码时用；语言只能是 Python（可 import pandas / numpy）。
  另给 "setup"（隐藏的造数据代码：直接在代码里构造小数据，不读文件、不联网、不画图）、"starter"（学员编辑器里的初始代码，用 # TODO 标出要补的地方，不能就是答案）、"solution"（参考答案，接在 setup 后可直接运行）。
  question 里写清楚最后要 print 什么——判题是比对学员与参考答案的打印输出。
- 检查前最后一拍的 say 自然引出问题（"你来判断一下"），不要在 say 里把题目和选项念出来——界面会展示题目。`;

export const LESSON_START_SYSTEM = `你在给一位学员上一节白板课。先规划整节课，再写出第一段。只输出 JSON：
{"plan":{"title":"本节课标题","segments":[{"title":"段标题 ≤12 字","point":"这段要讲透的一个点（一句话）","check":"段末怎么检查他懂没懂（一句话）"}]},
 "segment":{"beats":[{"say":"...","board":"可选","circle":"可选"}],"check":{...}}}

【整节课规划】segments 4 段（内容多可到 5 段）。由浅入深，一段只讲透一个点，前一段是后一段的台阶。每段 1-2 分钟，段末都有检查。

【第一段的特殊要求】
- 第一拍写一张开场卡：卡上第一行直接写本节主题（不要写「课题卡」「开场卡」这类字样）；下面 3 条列表：要解决的一个具体问题、为什么重要、学完能做什么。
- 前 3-4 拍内抛出一个具体场景或常见误区，先让学员产生"咦？"——不要一上来讲定义。

${VOICE}

一段 6-9 拍。

${CHECK_RULES}`;

export const LESSON_NEXT_SYSTEM = `你在给一位学员上一节白板课，刚讲完一段，学员回答了段末检查。现在写下一段。只输出 JSON：
{"segment":{"beats":[{"say":"...","board":"可选","circle":"可选"}],"check":{...}}}

【先接住学员（第 1-2 拍）】
- 学员已经在屏幕上看到了标准解析，不要重复解析原文。
- 答对：一句话肯定，点出他做对的关键（引用他的原话或选项）。
- 答错 / 部分对：先说"不完全对"，点出他的想法错在哪个具体环节；必要时写一张"纠错卡"把他的想法和正确机制并排对比。
- 开放题：判断他说对了多少，补上漏掉的那一半。
- 代码题：通过了就点出写法里值得记住的一点；没通过就针对他的代码 / 输出指出具体哪一行的问题。
然后用一句话过渡到本段要讲的点。

${VOICE}

一段 6-9 拍（含开头接住学员的拍）。

${CHECK_RULES}`;

export const LESSON_CLOSING_SYSTEM = `你在给一位学员上一节白板课，最后一段的检查他刚答完。现在收尾。只输出 JSON：
{"segment":{"beats":[{"say":"...","board":"可选"}]},"reward":{"title":"能力徽章 ≤8 字","description":"≤30 字，把他这节课获得的能力写成一句肯定语"}}

收尾 3-5 拍：
1. 第一拍接住他最后一题的回答（规则同上：不重复标准解析，答错就点出错在哪）。
2. 写一张 **本节要点** 卡：3 条，每条一句能直接用的结论（不是标题）。
3. 一拍讲这节课最容易踩的一个坑。
4. 最后一拍预告下一讲（给了下一讲标题就点出来，否则鼓励他回到课程页继续）。

${VOICE}`;

export const LESSON_FOLLOWUP_SYSTEM = `你在给一位学员上白板课，他在课上主动开口了（追问一个点，或说刚才没听懂）。像一对一老师那样接住他，然后回到主线。只输出 JSON：
{"beats":[{"say":"...","board":"可选","circle":"可选"}]}
- 2-5 拍。第一拍复述他卡在哪（引用他的原话）。
- 他说没听懂：必须换角度——更生活化的类比或一个更小的具体例子，写一张新卡；不许把原话重说一遍。
- 最后一拍一句话把他带回刚才讲到的地方。不要出题。

${VOICE}`;

// ---------------- 生成 ----------------

export interface LessonContextLines {
  /** 课程 / 课节 / 单元 / 学员 / 资料等上下文（已拼好的多行文本） */
  context: string;
  imagesAllowed: boolean;
}

const imageLine = (allowed: boolean) =>
  allowed
    ? `\n【配图】整节课最多 2 张：只在"一眼看图就懂结构"的地方，在那一拍加 "image":{"caption":"≤12 字","prompt":"English: a flat educational illustration, absolutely no text"}。`
    : "";

function planText(plan: LessonPlan, current: number) {
  return plan.segments
    .map(
      (s, i) =>
        `${i + 1}. ${s.title} —— ${s.point}${s.check ? `；段末检查：${s.check}` : ""}${i < current ? "（已讲）" : i === current ? "（← 现在写这段，段末检查按规划的形式出）" : ""}`
    )
    .join("\n");
}

export async function generateLessonStart(input: LessonContextLines): Promise<{ plan: LessonPlan; segment: LessonSegment } | null> {
  const r = await generateJson<{ plan: LessonPlan; segment: LessonSegment }>(
    LESSON_START_SYSTEM + imageLine(input.imagesAllowed),
    `${input.context}\n\n请规划这节课并写出第一段。`,
    { task: "script", maxTokens: 3600, schema: startSchema, onError: (e) => console.error("[lesson] start failed:", e instanceof Error ? e.message : e) }
  );
  return r ? { plan: r.plan, segment: cleanSegment(r.segment) } : null;
}

export interface LearnerAnswer {
  question: string;
  kind: LessonCheck["kind"];
  options?: string[];
  text: string;
  /** 选择题 / 代码题本地已判出的对错；开放题为 undefined（交给讲师判断） */
  correct?: boolean;
  /** 代码题：学员代码与输出 */
  code?: string;
  output?: string;
  explanation?: string;
}

function answerText(a: LearnerAnswer) {
  const lines = [`段末检查：${a.question}`];
  if (a.options?.length) lines.push(`选项：${a.options.join(" / ")}`);
  if (a.kind === "code") {
    lines.push(`学员的代码：\n${(a.code || "").slice(0, 1200)}`);
    lines.push(`运行输出：\n${(a.output || "（无输出）").slice(0, 600)}`);
    lines.push(`判题结果：${a.correct ? "通过（输出与参考答案一致）" : "未通过"}`);
  } else {
    lines.push(`学员的回答：${a.text.slice(0, 400)}`);
    if (a.correct != null) lines.push(`判定：${a.correct ? "答对" : "答错"}`);
  }
  if (a.explanation) lines.push(`学员已看到的标准解析：${a.explanation}`);
  return lines.join("\n");
}

function nextUserPrompt(input: LessonContextLines & { plan: LessonPlan; index: number; covered: string; answer: LearnerAnswer }) {
  return `${input.context}

本节课规划：
${planText(input.plan, input.index)}

前面已经讲过（白板与讲解摘要）：
${input.covered.slice(-2400)}

${answerText(input.answer)}

请写第 ${input.index + 1} 段《${input.plan.segments[input.index]?.title || ""}》。`;
}

function closingUserPrompt(input: LessonContextLines & { plan: LessonPlan; covered: string; answer: LearnerAnswer; nextLectureTitle?: string }) {
  return `${input.context}

本节课规划：
${planText(input.plan, input.plan.segments.length)}

前面讲过（摘要）：
${input.covered.slice(-2000)}

${answerText(input.answer)}
${input.nextLectureTitle ? `下一讲：《${input.nextLectureTitle}》` : "这是本单元最后一讲。"}

请收尾。`;
}

export async function generateLessonNext(
  input: LessonContextLines & { plan: LessonPlan; index: number; covered: string; answer: LearnerAnswer }
): Promise<LessonSegment | null> {
  const r = await generateJson<{ segment: LessonSegment }>(LESSON_NEXT_SYSTEM + imageLine(input.imagesAllowed), nextUserPrompt(input), {
    task: "script",
    maxTokens: 2600,
    schema: nextSchema,
    onError: (e) => console.error("[lesson] next failed:", e instanceof Error ? e.message : e),
  });
  return r ? cleanSegment(r.segment) : null;
}

export async function generateLessonClosing(
  input: LessonContextLines & { plan: LessonPlan; covered: string; answer: LearnerAnswer; nextLectureTitle?: string }
): Promise<{ segment: LessonSegment; reward?: LessonReward } | null> {
  const r = await generateJson<{ segment: LessonSegment; reward?: LessonReward }>(LESSON_CLOSING_SYSTEM, closingUserPrompt(input), {
    task: "script",
    maxTokens: 1800,
    schema: closingSchema,
    onError: (e) => console.error("[lesson] closing failed:", e instanceof Error ? e.message : e),
  });
  if (!r) return null;
  const seg = cleanSegment(r.segment);
  delete seg.check;
  return { segment: seg, reward: r.reward };
}

const VERIFY_SYSTEM = `你是严格的出题审校。给你一段白板课的板书与讲解，以及段末的一道检查题。
你要自己一步步把正确答案算出来 / 推出来（不要相信题目自带的答案标注），然后：
- 标注的正确答案错了：改 correct_index；
- 正确答案根本不在选项里：把一个最弱的干扰项换成正确答案；
- 题干有歧义或缺条件：改到只有一个正确答案；
- explanation 与正确答案一致、≤40 字，说清为什么对、错的错在哪；不许出现自我否定或演算痕迹（如「不对——」「？」）。
题目没问题就原样返回。保持题目考的点不变、口吻不变。
只输出 JSON：{"question":"...","options":["..."],"correct_index":0,"explanation":"..."}`;

const verifySchema = z
  .object({ question: t(4), options: z.array(t()).min(2), correct_index: z.number().int().min(0), explanation: t(4) })
  .loose()
  .refine((v) => v.correct_index < v.options.length, { message: "correct_index 越界" });

/**
 * 检查题审校：讲解为了快不开思考，但"算对答案"需要推理——在学员听这一段的 1-2 分钟里，
 * 开思考把题重新算一遍（实测曾出现解析算出 8、却把 7 标成正确答案）。只审选择题；失败则原样返回。
 */
export async function verifyCheck(check: LessonCheck, beats: LessonBeat[]): Promise<LessonCheck> {
  if (check.kind !== "choice" || !check.options?.length) return check;
  const lesson = beats.map((b) => [b.board ? `[白板]\n${b.board}\n[/白板]` : "", b.say].filter(Boolean).join("\n")).join("\n");
  const r = await generateJson<{ question: string; options: string[]; correct_index: number; explanation: string }>(
    VERIFY_SYSTEM,
    `这一段讲了：\n${lesson.slice(-3000)}\n\n检查题：${JSON.stringify({ question: check.question, options: check.options, correct_index: check.correct_index, explanation: check.explanation })}`,
    { task: "judge", maxTokens: 900, schema: verifySchema, onError: (e) => console.error("[lesson] verify failed:", e instanceof Error ? e.message : e) }
  );
  if (!r) return check;
  const fixed = cleanSegment({ beats: [], check: { kind: "choice", question: r.question, options: r.options, correct_index: r.correct_index, explanation: r.explanation } }).check;
  if (!fixed || fixed.correct_index == null) return check;
  if (fixed.correct_index !== check.correct_index || JSON.stringify(fixed.options) !== JSON.stringify(check.options)) {
    console.warn(`[lesson] verify corrected check: ${check.correct_index} → ${fixed.correct_index}「${fixed.question.slice(0, 30)}」`);
  }
  return fixed;
}

export async function generateFollowup(input: { context: string; covered: string; message: string }): Promise<LessonBeat[] | null> {
  const r = await generateJson<{ beats: LessonBeat[] }>(
    LESSON_FOLLOWUP_SYSTEM,
    `${input.context}\n\n刚才讲到（摘要）：\n${input.covered.slice(-1500)}\n\n学员说：${input.message.slice(0, 300)}\n请接住他。`,
    { task: "script", maxTokens: 1500, schema: followupSchema }
  );
  return r ? cleanSegment({ beats: r.beats }).beats : null;
}

/**
 * 板书 Markdown 规整：模型习惯用单个换行分行，而 Markdown 会把单换行并成一段（标题和正文挤成一行）；
 * 表格常缺表头分隔行（渲染成一串竖线）。这里把"行"还原成行：
 * - 普通文字行之间补空行（各自成段）；列表、表格内部保持连续；代码块原样；
 * - 表格缺 |---| 分隔行时补上，表格前后补空行。
 */
export function normalizeBoardMarkdown(md: string): string {
  // 兜底：模型偶尔把多行压成一行「标题 / - 甲 / - 乙」——拆回多行（代码块里不会出现这种写法）
  const unflattened = md.replace(/\r/g, "").replace(/\s+\/\s+(?=[-*]\s|\d+[.)]\s)/g, "\n");
  const lines = unflattened.split("\n");
  type Kind = "blank" | "fence" | "code" | "table" | "list" | "plain";
  const out: string[] = [];
  let inFence = false;
  let prev: Kind = "blank";
  let tableRows = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (!inFence && prev !== "blank") out.push("");
      out.push(line);
      inFence = !inFence;
      prev = inFence ? "code" : "fence";
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let kind: Kind;
    if (!trimmed) kind = "blank";
    else if (trimmed.startsWith("|")) kind = "table";
    else if (/^([-*+]|\d+[.)])\s/.test(trimmed)) kind = "list";
    else kind = "plain";
    if (kind === "blank") {
      if (prev !== "blank") out.push("");
      prev = "blank";
      tableRows = 0;
      continue;
    }
    if (kind === "table") {
      if (prev !== "table" && prev !== "blank") out.push("");
      const isSep = /^\|?\s*:?-{2,}/.test(trimmed);
      if (prev === "table" && tableRows === 1 && !isSep) {
        const cols = Math.max(1, trimmed.replace(/^\||\|$/g, "").split("|").length);
        out.push(`|${" --- |".repeat(cols)}`);
      }
      tableRows = prev === "table" ? tableRows + 1 : 1;
      out.push(trimmed);
      prev = "table";
      continue;
    }
    if (prev !== "blank" && !(kind === "list" && prev === "list")) out.push("");
    out.push(line);
    prev = kind;
    tableRows = 0;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanSegment(seg: LessonSegment): LessonSegment {
  const beats = (seg.beats || [])
    .map((b) => ({
      say: String(b.say || "").trim(),
      board: b.board ? normalizeBoardMarkdown(String(b.board).trim()) : undefined,
      circle: b.circle ? String(b.circle).trim() : undefined,
      image: b.image?.prompt ? { caption: b.image.caption ? String(b.image.caption).slice(0, 16) : undefined, prompt: String(b.image.prompt).slice(0, 600) } : undefined,
    }))
    .filter((b) => b.say || b.board);
  let check: LessonCheck | undefined;
  if (seg.check?.question) {
    const c = seg.check;
    const kind: LessonCheck["kind"] = c.kind === "code" && c.solution ? "code" : Array.isArray(c.options) && c.options.length >= 2 ? "choice" : "open";
    check = {
      kind,
      question: String(c.question).trim().slice(0, 160),
      explanation: c.explanation ? String(c.explanation).trim().slice(0, 140) : undefined,
    };
    if (kind === "choice") {
      // 不截断：代码式选项的差别常在末尾（customer_id vs customer_name）
      check.options = (c.options || []).slice(0, 4).map((o) => String(o).replace(/`/g, "").trim().slice(0, 90));
      check.correct_index = typeof c.correct_index === "number" && c.correct_index >= 0 && c.correct_index < check.options.length ? c.correct_index : undefined;
    }
    if (kind === "code") {
      check.setup = c.setup ? String(c.setup) : "";
      check.starter = c.starter ? String(c.starter) : "";
      check.solution = String(c.solution);
    }
  }
  return { beats, check };
}

// ---------------- 段 → 白板动作 ----------------

/** 归一化后的片段 → 卡面里的原句锚点（客户端各自归一化匹配） */
export function anchorFromCard(content: string, snippet?: string): string | undefined {
  if (!snippet) return undefined;
  const target = normalizeText(snippet);
  if (!target) return undefined;
  const flat = content.replace(/\s+/g, " ").trim();
  for (let len = Math.min(flat.length, target.length + 8); len >= Math.min(4, target.length); len--) {
    for (let i = 0; i + len <= flat.length; i++) {
      const piece = flat.slice(i, i + len);
      if (normalizeText(piece) === target) return piece;
    }
  }
  return undefined;
}

/** 每段的 step / board_uid 编号空间互不重叠（媒体回填、圈画都按编号对位） */
const STEP_SPACE = 1000;
const UID_SPACE = 100;

export interface SegmentBuildOptions {
  index: number;
  pageId: string;
  /** 第一段：先开一页（页标题 = 本节标题） */
  newPage?: { title: string };
  segmentTitle?: string;
  total?: number;
  /** 收尾段：结尾发徽章 + done */
  final?: boolean;
  /** 追问回应：不开段、不计入进度 */
  reply?: boolean;
}

/**
 * 增量构建一段的白板动作：begin() → 每到一拍 beat() → end()。
 * 流式生成时每拍到达就能立刻下发；整段一次构建（缓存 / 追问）也走同一套编号规则。
 */
export function createSegmentBuilder(opts: SegmentBuildOptions) {
  let step = (opts.reply ? 900 + Math.floor(Math.random() * 90) : opts.index) * STEP_SPACE;
  let uid = (opts.reply ? 90 + Math.floor(Math.random() * 9) : opts.index) * UID_SPACE;
  const pageId = opts.pageId;
  let images = 0;
  return {
    begin(): BoardAction[] {
      const out: BoardAction[] = [];
      if (opts.newPage) out.push({ type: "new_page", step_id: step++, page_id: pageId, title: opts.newPage.title });
      if (!opts.reply) {
        out.push({ type: "segment_start", step_id: step++, segment: opts.index, title: opts.segmentTitle || "", total: opts.total ?? 0, final: Boolean(opts.final) });
      }
      return out;
    },
    beat(beat: LessonBeat): { actions: BoardAction[]; media: MediaTask[] } {
      const actions: BoardAction[] = [];
      const media: MediaTask[] = [];
      if (beat.board) actions.push({ type: "board", step_id: step++, board_uid: uid++, page_id: pageId, board_content: beat.board });
      if (beat.say) actions.push({ type: "speak", step_id: step++, spoken_text: beat.say });
      if (beat.board) {
        const anchor = anchorFromCard(beat.board, beat.circle);
        if (anchor) actions.push({ type: "circle", step_id: step++, target_board_id: uid - 1, page_id: pageId, snippet: anchor });
      }
      if (beat.image?.prompt && images < 1) {
        images += 1;
        const pendingStep = step++;
        const placementStep = step++;
        actions.push({ type: "image_gen_pending", step_id: pendingStep, placement_step_id: placementStep, page_id: pageId, caption: beat.image.caption, prompt_preview: beat.image.prompt.slice(0, 120) });
        media.push({ kind: "image", caption: beat.image.caption, prompt: beat.image.prompt, genStep: pendingStep, placementStep, pageId });
      }
      return { actions, media };
    },
    end(check?: LessonCheck, reward?: LessonReward): BoardAction[] {
      const out: BoardAction[] = [];
      if (check) {
        out.push({
          type: "ask",
          step_id: step++,
          mode: check.kind === "choice" ? "choice" : "open",
          kind: check.kind,
          segment: opts.index,
          question: check.question,
          options: check.options,
          correct_index: check.correct_index,
          explanation: check.explanation,
          code: check.kind === "code" ? { setup: check.setup || "", starter: check.starter || "", solution: check.solution || "" } : undefined,
        });
      } else if (!opts.final && !opts.reply) {
        // 模型漏了检查题：讲完这段自动接下一段（不让学员看到"生成失败"）
        out.push({ type: "segment_end", step_id: step++, segment: opts.index, auto: true });
      }
      if (reward?.title) {
        out.push({
          type: "reward_user",
          step_id: step++,
          master_concept_title: String(reward.title).slice(0, 12),
          master_concept_description: String(reward.description || "").slice(0, 40),
        });
      }
      if (opts.final) out.push({ type: "done", step_id: step++ });
      return out;
    },
  };
}

export function segmentToActions(seg: LessonSegment, opts: SegmentBuildOptions & { reward?: LessonReward }): { actions: BoardAction[]; media: MediaTask[] } {
  const b = createSegmentBuilder(opts);
  const actions: BoardAction[] = [...b.begin()];
  const media: MediaTask[] = [];
  for (const beat of seg.beats) {
    const r = b.beat(beat);
    actions.push(...r.actions);
    media.push(...r.media);
  }
  actions.push(...b.end(seg.check, opts.reward));
  return { actions, media };
}

// ---------------- 流式生成（边写边上板） ----------------

export const STREAM_START_FORMAT = `按下面顺序逐行输出（JSON Lines，一行一个 JSON 对象）：
第 1 行：{"plan":{"title":"本节课标题","segments":[{"title":"段标题 ≤12 字","point":"这段要讲透的一个点（一句话）","check":"段末怎么检查他懂没懂（一句话）"}]}}
接着第一段的每一拍各占一行：{"say":"...","board":"可选","circle":"可选"}
最后一行：{"check":{...}}`;

export const STREAM_SEGMENT_FORMAT = `逐行输出（JSON Lines，一行一个 JSON 对象）：
每一拍各占一行：{"say":"...","board":"可选","circle":"可选"}
最后一行：{"check":{...}}`;

export const STREAM_CLOSING_FORMAT = `逐行输出（JSON Lines，一行一个 JSON 对象）：
每一拍各占一行：{"say":"...","board":"可选"}
最后一行：{"reward":{"title":"能力徽章 ≤8 字","description":"≤30 字，把他这节课获得的能力写成一句肯定语"}}`;

/** 把"只输出 JSON：{…}"那段格式说明换成逐行格式（其余讲课规则不变） */
export const toStream = (system: string, format: string) => system.replace(/只输出 JSON：[\s\S]*?\n\n/, `${format}\n\n`);

export interface StreamHandlers {
  onPlan?: (plan: LessonPlan) => void | Promise<void>;
  onBeat: (beat: LessonBeat) => void | Promise<void>;
}

export interface StreamResult {
  plan?: LessonPlan;
  segment: LessonSegment;
  reward?: LessonReward;
  firstLineMs: number | null;
}

/**
 * 流式讲课默认不开思考：实测开"轻思考"时首行要 19 秒才出来（全在思考），正文本身只要 6 秒。
 * 不思考时讲师立刻开口。需要更深的推理可用 LLM_THINKING_STREAM=low|high 打开。
 */
function streamThinking(): "off" | "low" | "high" {
  const v = process.env.LLM_THINKING_STREAM?.trim();
  return v === "low" || v === "high" ? v : "off";
}

async function streamLesson(system: string, user: string, maxTokens: number, h: StreamHandlers): Promise<StreamResult> {
  let plan: LessonPlan | undefined;
  let check: LessonCheck | undefined;
  let reward: LessonReward | undefined;
  const beats: LessonBeat[] = [];
  const emit = async (raw: LessonBeat) => {
    const beat = cleanSegment({ beats: [raw] }).beats[0];
    if (!beat) return;
    beats.push(beat);
    await h.onBeat(beat);
  };
  const r = await streamJsonLines(
    system,
    user,
    async (obj) => {
      // 一个对象里可能同时带着 plan / beats / segment / check / reward（模型没逐行写时）：逐项都收，不提前 return
      if (obj.plan && typeof obj.plan === "object" && !plan) {
        const p = obj.plan as LessonPlan;
        if (Array.isArray(p.segments) && p.segments.length >= 2) {
          plan = { title: String(p.title || ""), segments: p.segments.slice(0, 6).map((s) => ({ title: String(s.title || ""), point: String(s.point || ""), check: s.check ? String(s.check) : undefined })) };
          await h.onPlan?.(plan);
        }
      }
      const seg = (obj.segment as LessonSegment | undefined) ?? (Array.isArray(obj.beats) ? (obj as unknown as LessonSegment) : undefined);
      if (seg && Array.isArray(seg.beats)) {
        for (const b of seg.beats) await emit(b);
        if (seg.check && !check) check = cleanSegment({ beats: [], check: seg.check }).check;
      }
      if (obj.check && typeof obj.check === "object" && !check) {
        check = cleanSegment({ beats: [], check: obj.check as LessonCheck }).check;
      }
      if (obj.reward && typeof obj.reward === "object") {
        const rw = obj.reward as LessonReward;
        if (rw.title) reward = { title: String(rw.title), description: String(rw.description || "") };
      }
      if (typeof obj.say === "string" || typeof obj.board === "string") await emit(obj as unknown as LessonBeat);
    },
    { task: "script", maxTokens, thinking: streamThinking() }
  );
  if (r.badLines) console.warn(`[lesson] stream: ${r.badLines} 行解析失败`);
  return { plan, segment: { beats, check }, reward, firstLineMs: r.firstLineMs };
}

export function streamLessonStart(input: LessonContextLines, h: StreamHandlers) {
  return streamLesson(toStream(LESSON_START_SYSTEM, STREAM_START_FORMAT) + imageLine(input.imagesAllowed), `${input.context}\n\n请规划这节课并写出第一段。`, 3600, h);
}

export function streamLessonNext(input: LessonContextLines & { plan: LessonPlan; index: number; covered: string; answer: LearnerAnswer }, h: StreamHandlers) {
  return streamLesson(toStream(LESSON_NEXT_SYSTEM, STREAM_SEGMENT_FORMAT) + imageLine(input.imagesAllowed), nextUserPrompt(input), 2600, h);
}

export function streamLessonClosing(input: LessonContextLines & { plan: LessonPlan; covered: string; answer: LearnerAnswer; nextLectureTitle?: string }, h: StreamHandlers) {
  return streamLesson(toStream(LESSON_CLOSING_SYSTEM, STREAM_CLOSING_FORMAT), closingUserPrompt(input), 1800, h);
}

/** 已讲内容摘要（给下一段的生成当上下文）：白板原文 + 讲解句子 */
export function summarizeSegments(segments: LessonSegment[]): string {
  const out: string[] = [];
  segments.forEach((s, i) => {
    out.push(`【第 ${i + 1} 段】`);
    for (const b of s.beats) {
      // 保留真实换行：摘要里若把换行压成「 / 」，模型会照抄这种格式写下一段的板书
      if (b.board) out.push(`[白板]\n${b.board.replace(/\n{2,}/g, "\n")}\n[/白板]`);
      if (b.say) out.push(b.say);
    }
    if (s.check) out.push(`[检查] ${s.check.question}`);
  });
  return out.join("\n");
}
