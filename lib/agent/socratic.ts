// 苏格拉底私教：没有预设逐句讲稿，老师一步步问、学员答、老师边接边在白板上画。
// 课程仍然成体系——导演先把一节课编成一条「探究链」（4-6 问），每一问建一个概念；
// 课堂上的每一轮 = 学员答 + 老师现场接（引用他的原话、翻案/深化）+ 白板落结论。
// 与白板讲稿课（teach.ts）共用 LectureContext / BoardItem / 白板 writer，但推进权在学员手里。
import type { BoardItem } from "@/types";
import type { LectureContext } from "./teach";
import { generateJson, streamAnswer } from "./llm";
import { constraintsBlock } from "./lang";

/** 探究链的一步：一问 + 应答要点 + 这一步要在白板上落下的结论 */
export interface SocraticStep {
  module: string; // 白板模块标题（≤6 字）
  ask: string; // 抛给学员的真问题（具体到场景/代码/数字）
  options: string[]; // 2-3 个候选答案（学员可以只点不打字），含一个最常见的直觉误区
  concept: string; // 这一步建立的概念（≤8 字）
  good: string; // 答对的深化要点（老师的私货，≤50 字）
  wrong: string; // 答错的翻案要点（≤50 字）
  items: BoardItem[]; // 这一步的候选板书（结论，不是问题；每轮取 1-3 条）
}

export interface SocraticPlan {
  ability: string; // 走完这条链，学员"现在你可以……"
  steps: SocraticStep[];
}

const KINDS = ["subtitle", "bullet", "note", "table", "diagram", "tree", "chart", "vs", "judge", "quote", "underline", "circle", "burst"];

function clampItem(it: any): BoardItem | null {
  if (!it || !KINDS.includes(String(it.kind))) return null;
  const clamp = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const out: any = { kind: it.kind };
  if (typeof it.text === "string") out.text = clamp(it.text, it.kind === "quote" ? 16 : 22);
  if (Array.isArray(it.headers)) out.headers = it.headers.slice(0, 3).map((h: unknown) => clamp(h, 6));
  if (Array.isArray(it.rows)) out.rows = it.rows.slice(0, 4).map((r: unknown[]) => (Array.isArray(r) ? r.slice(0, 3).map((c) => clamp(c, 6)) : []));
  if (Array.isArray(it.nodes)) out.nodes = it.nodes.slice(0, 4).map((n: unknown) => clamp(n, 6));
  if (Array.isArray(it.values)) out.values = it.values.slice(0, 5).map((v: unknown) => Math.max(0, Math.min(100, Number(v) || 0)));
  if (it.verdict === "good" || it.verdict === "bad") out.verdict = it.verdict;
  if (["star", "alert", "question"].includes(String(it.style))) out.style = it.style;
  if (typeof it.text2 === "string") out.text2 = clamp(it.text2, 8);
  return out;
}

function contextLine(ctx: LectureContext): string {
  return `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
单元：${ctx.unitTitle}
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}${ctx.keyConcepts?.length ? `\n本单元关键概念：${ctx.keyConcepts.join("、")}` : ""}${
    ctx.capstoneGoal ? `\n学员的结课作品：${ctx.capstoneGoal}（问题和例子尽量落在他的作品场景里）` : ""
  }${ctx.previousLectures?.length ? `\n前情（学员已按顺序听完）：${ctx.previousLectures.map((l) => `「${l.title}」`).join("、")}` : ""}${
    ctx.referenceMaterial ? `\n参考资料（事实、数字、案例优先取自这里）：\n${ctx.referenceMaterial.slice(0, 4000)}` : ""
  }${constraintsBlock(ctx.outputLanguage, ctx.constraints) ? `\n${constraintsBlock(ctx.outputLanguage, ctx.constraints)}` : ""}`;
}

/** 课程导演：把一节课编成一条探究链。体系在这里保证——问的顺序就是概念的搭建顺序。 */
const SOCRATIC_PLAN_SYSTEM = `你是苏格拉底式私教的课程导演。把一节课编成一条「探究链」：不是你讲他听，而是你一步步问、让他自己把结论走出来。只输出 JSON：
{"ability":"...","steps":[{"module":"...","ask":"...","options":["...","..."],"concept":"...","good":"...","wrong":"...","items":[{"kind":"bullet","text":"..."}]}]}

规则：
- 4 到 6 步，一步只建一个概念。链路沿这个感觉走：具体场景/事故 → 学员的直觉方案 → 暴露方案的漏洞 → 正确机制 → 拆参数/细节 → 边界与下一步。
- ask 是你真会问出口的问题：具体到场景、代码、数字（"这版代码敢不敢直接上线？""这把锁会出什么事？"），学员靠直觉就敢猜。禁止"什么是XX"这种定义题。
- options 恰好 2-3 个：学员可能给的具体答案，其中一个是**最常见的直觉误区**——猜它的人最多，翻案才精彩。每个 ≤16 字。
- good / wrong 是给老师自己看的应答要点（各 ≤50 字）：答对怎么深化、答错怎么翻案，都要落到机制，不许只说"对/不对"。
- concept 是这一步学员建立的概念（≤8 字，如"非原子的缝隙"）。
- module 是白板模块标题（≤6 字）；items 是这一步白板上要落下的 2-4 条**结论**板书（不是问题）：
  - kind 可用 subtitle/bullet/note/table/diagram/tree/chart/vs/judge/quote；bullet ≤18 字、note ≤12 字、diagram/tree 节点 ≤6 字、quote ≤16 字、judge 用 verdict:"good"/"bad"。
  - 图文并茂：整条链至少用 3 种类型，讲对比用 vs/table、讲流程用 diagram、讲误区用 judge。
- 第一步必须从具体场景/事故起步（优先取参考资料里的真实案例），不是从定义起步；默认学员零基础，用到的前置概念要么前几步建立、要么在本步 items 里补一句。
- ability：走完这条链，"现在你可以……"的具体能力（≤40 字，具体到能上手）。`;

export async function runSocraticPlan(ctx: LectureContext): Promise<SocraticPlan> {
  const raw = await generateJson<SocraticPlan>(SOCRATIC_PLAN_SYSTEM, `${contextLine(ctx)}\n\n请为这节课设计探究链。`, 2400);
  const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
    .filter((s: any) => s && s.ask && Array.isArray(s.options) && s.options.length >= 2)
    .slice(0, 6)
    .map((s: any) => ({
      module: String(s.module || "探究").slice(0, 6),
      ask: String(s.ask).slice(0, 60),
      options: s.options.slice(0, 3).map((o: unknown) => String(o).slice(0, 16)),
      concept: String(s.concept || "").slice(0, 8),
      good: String(s.good || "").slice(0, 60),
      wrong: String(s.wrong || "").slice(0, 60),
      items: (Array.isArray(s.items) ? s.items : []).map(clampItem).filter(Boolean).slice(0, 4) as BoardItem[],
    }));
  return {
    ability: String(raw?.ability || `你能独立讲清「${ctx.lectureTitle}」在做什么`).slice(0, 60),
    steps:
      steps.length >= 3
        ? steps
        : [
            {
              module: "起点",
              ask: ctx.lectureSummary ? `关于「${ctx.lectureTitle}」，你目前的理解是什么？` : `你最想搞懂「${ctx.lectureTitle}」的哪一点？`,
              options: ["只听过名字", "用过但不懂原理", "大概懂想查漏"],
              concept: "起点",
              good: "从他已有的理解出发深化",
              wrong: "先建立动机再进入主题",
              items: [{ kind: "subtitle", text: ctx.lectureTitle.slice(0, 10) }],
            },
          ],
  };
}

/** 课堂上一轮：学员答了，老师接。reply 是说的话；items 是这一轮白板上落的结论；verdict 用来调节奏。 */
export interface SocraticTurnResult {
  reply: string;
  verdict: "good" | "partial" | "wrong";
  items: BoardItem[];
}

const SOCRATIC_TURN_SYSTEM = `你是一对一私教，正在给一个学员上课。他刚回答了你的问题，你要接住。只输出 JSON：
{"reply":"...","verdict":"good|partial|wrong","items":[{"kind":"bullet","text":"..."}]}

reply（对学员说的话，90-200 字）：
- 先接住他的答案：引用他答案里的关键词（几个字就够），对就深化，错了直说"这条路走不通"，部分对就说清哪半对哪半错——不许和稀泥。
- 然后把这一步的机制讲透：一句一件事，每句 ≤ 38 字（两个句号就拆句）；术语第一次出现给一句人话加一个例子。
- 讲完用学员自己的场景复述一遍（"放到你的订单上就是……"）。
- 最后一两句把话头自然引向下一个问题（题目由系统出，你不要替他回答，也不要重复题目原文）。
- 像对一个人说话：用"你"；他答错你要有"来，看这里"的着急，答对要有"对，就是这个"的高兴。
- 事实、数字取参考资料，不发明。

verdict：他的答案 good / 部分对 partial / 走进误区 wrong。

items：这一轮白板上要落下的 1-3 条**结论**板书：
- 答对 → 写结论条；答错 → 先写一条反例（judge bad 或 vs）再写正确结论；部分对 → 写补全后的结论。
- kind 可用 subtitle/bullet/note/table/diagram/tree/chart/vs/judge/quote；bullet ≤18 字、note ≤12 字、节点 ≤6 字、quote ≤16 字。
- 写结论不写问题，不复述模块标题；本轮不写新板书时用 1 条 note 兜底。`;

export async function runSocraticTurn(opts: {
  ctx: LectureContext;
  step: SocraticStep;
  nextAsk?: string; // 下一个问题（reply 结尾要往这里搭桥）
  answer: string; // 学员的回答（自由文本或所选选项）
  history: { role: "teacher" | "student"; content: string }[]; // 最近几轮对话
}): Promise<SocraticTurnResult> {
  const { ctx, step, nextAsk, answer, history } = opts;
  const histText = history
    .slice(-4)
    .map((m) => `${m.role === "student" ? "学员" : "老师"}：${m.content.slice(0, 160)}`)
    .join("\n");
  const raw = await generateJson<{ reply?: string; verdict?: string; items?: any[] }>(
    SOCRATIC_TURN_SYSTEM,
    `${contextLine(ctx)}

【本轮的问题】${step.ask}
【应答要点】他若答对：${step.good || "（自由深化）"}；他若答错（常见误区）：${step.wrong || "（按机制翻案）"}
${nextAsk ? `【下一个问题（只搭桥不回答）】${nextAsk}` : "【这是最后一问】reply 结尾落到「现在你可以……」的具体能力上，把这条探究链收住。"}
${histText ? `\n【最近对话】\n${histText}\n` : ""}
【学员的回答】${answer.slice(0, 200)}

请接住他。`,
    1400
  );
  const reply = String(raw?.reply || "").trim() || "嗯，我们换个角度看这个问题。";
  const verdict = raw?.verdict === "good" || raw?.verdict === "wrong" ? raw.verdict : "partial";
  const items = (Array.isArray(raw?.items) ? raw.items : []).map(clampItem).filter(Boolean).slice(0, 3) as BoardItem[];
  return { reply, verdict, items };
}

/** 「没跟上」：把老师刚才的回应换成更基础的说法重讲一遍，不推进探究链 */
const SOCRATIC_SIMPLER_SYSTEM = `你是一对一私教。学员刚听完你的回应，举手说"没跟上"。把同一个点用更基础的方式重讲，只输出纯文本（不要 JSON）。
- 每句 ≤ 20 字，先一句结论 → 一个最小例子（他的场景）→ 再回机制。
- 只讲刚才那个点，不引入新内容、不推进下一问。
- 80-150 字，结尾一句确认（"这样清楚一点了吗？"）。`;

export async function runSocraticSimpler(opts: { ctx: LectureContext; question: string; lastReply: string }): Promise<string> {
  const { ctx, question, lastReply } = opts;
  let out = "";
  await streamAnswer(
    `${SOCRATIC_SIMPLER_SYSTEM}\n\n${contextLine(ctx)}`,
    `你刚才的问题是：「${question}」
你刚才的回应是：「${lastReply.slice(0, 400)}」
学员说没跟上。请用更基础的方式重讲。`,
    (t) => {
      out += t;
    }
  );
  return out.trim();
}
