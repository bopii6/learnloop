// 分步学习课生成：一节课 = 开场 → 5-8 个"讲一点 → 例子 → 动手 → 反馈"小步 → 小结 + 复习题。
// 设计依据（学习科学）：学习者自控节奏 > 系统控制节奏；先例后练（worked example → practice）；
// 每步都要提取（retrieval）而不是只看；即时、具体的反馈；一次只讲一个点（分段原则）。
import { z } from "zod";
import { generateJson } from "@/lib/agent/llm";
import { constraintsBlock } from "@/lib/agent/lang";
import type { LectureContext } from "@/lib/agent/lecture-context";
import type { LessonSubject, StepLesson } from "@/types/lesson";

const text = (min = 1) => z.string().trim().min(min);

const practiceSchema = z
  .object({
    kind: z.enum(["code", "choice", "fill", "explain"]),
    prompt: text(4),
    explanation: text(4),
  })
  .loose()
  .superRefine((p: Record<string, unknown>, ctx) => {
    const need = (field: string, ok: boolean) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [field], message: `${p.kind} 题缺少 ${field}` });
    };
    if (p.kind === "code") need("solution", typeof p.solution === "string" && (p.solution as string).trim().length > 0);
    if (p.kind === "choice") {
      need("options", Array.isArray(p.options) && (p.options as unknown[]).length >= 2);
      need("answerIndex", typeof p.answerIndex === "number");
    }
    if (p.kind === "fill") need("answer", typeof p.answer === "string" && (p.answer as string).trim().length > 0);
    if (p.kind === "explain") need("rubric", Array.isArray(p.rubric) && (p.rubric as unknown[]).length >= 1);
  });

export const stepLessonSchema = z
  .object({
    subject: z.enum(["programming", "math", "exam", "concept"]),
    title: text(2),
    goal: text(4),
    hook: text(10),
    steps: z
      .array(z.object({ title: text(2), explain: text(80), practice: practiceSchema.optional() }).loose())
      .min(4, "至少 4 步")
      .max(9, "最多 9 步"),
    recap: z
      .object({
        points: z.array(text(4)).min(2),
        review: z.array(z.object({ q: text(4), a: text(2) })).min(2),
      })
      .loose(),
  })
  .loose();

const LESSON_SYSTEM = `你是一位极其耐心、讲得透的一对一私教，正在为学员写一节"分步学习课"。学员自己点"继续"推进，每一步读完要动手做一次。

【这节课的结构】
- hook：开场 2-3 句，把学员放进一个具体场景，说清楚"不会这个会卡在哪"。不要客套。
- steps：5-6 步。一步只讲一个点，按"由浅到深、前一步是后一步的台阶"排列。
- recap：points 3-5 条（每条一句能直接用的结论）；review 3 道复习题（问 + 简短答案），用于几天后回来自测。

【每一步怎么写】
- explain（讲解，Markdown，200-400 字）：
  1. 先说"为什么需要它"——它解决什么问题；
  2. 再讲"它是怎么工作的"——讲机制和原理，不只给结论；
  3. 点出一个最常见的误解或坑，说清楚错在哪。
  用短段落、口语化但精确；关键词加粗；编程类必须带最小可运行的代码片段；数学类公式用 $...$ / $$...$$。
  禁止空话（"非常重要""灵活运用"）、禁止只罗列要点不解释。
- example（完整例子，Markdown）：一个具体的、从头走到尾的例子。编程类给出完整代码 + 注释 + 运行输出（用 \`\`\`text 代码块写输出）；数学类给出完整推导；概念类给出真实案例的分析过程。
- practice（动手，除最后一步外每步都要有）：紧扣这一步刚讲的点，难度"稍微高于照抄例子"。

【练习形式按学科选】subject 取值与对应练习：
- programming（编程 / 数据分析）：优先 kind="code"。
  - setup：隐藏的准备代码，用代码直接构造小数据（DataFrame 等），不读文件、不联网、不画图。可以 import pandas as pd / numpy as np。
  - starter：学员编辑器里的初始代码，留出要学员补的部分（用注释 # TODO 标明），不能直接是答案。
  - solution：参考答案（完整可运行，接在 setup 之后执行）。
  - 题目必须要求"最后用 print 打印结果"，判题方式是比对学员和参考答案的打印输出，所以题面要说清楚打印什么、什么格式。
  - 也可以穿插 kind="choice" 的"预测输出"题。
- math（数学 / 理科）：kind="fill"（算出一个数或表达式，answer 写标准答案，多个等价写法用 | 分隔）或 kind="choice"（选下一步推导）。
- exam（考试类）：kind="choice"，真题风格，选项要有迷惑性。
- concept（概念类）：kind="explain"（用自己的话解释 / 判断案例，rubric 写 2-4 条评判要点）或 kind="choice"（案例判断）。
- 任何学科都要：hint 给思路不给答案；explanation 说清楚为什么，包括错误选项错在哪。
- choice 题：options 3-4 个，answerIndex 从 0 开始。

只输出 JSON：
{"subject":"programming","title":"...","goal":"学完能……","hook":"...",
 "steps":[{"title":"...","explain":"...","example":"...","practice":{"kind":"code","prompt":"...","setup":"...","starter":"...","solution":"...","hint":"...","explanation":"..."}}],
 "recap":{"points":["..."],"review":[{"q":"...","a":"..."}]}}`;

export async function generateStepLesson(ctx: LectureContext, opts: { referenceMaterial?: string; profileLine?: string } = {}): Promise<StepLesson | null> {
  const user = `课程：《${ctx.courseTitle}》
学员：${ctx.audience}
${opts.profileLine ? `${opts.profileLine}\n` : ""}本单元：${ctx.unitTitle}${ctx.keyConcepts?.length ? `（关键概念：${ctx.keyConcepts.join("、")}）` : ""}
本节课：${ctx.lectureTitle} —— ${ctx.lectureSummary}
${ctx.previousLectures?.length ? `本单元前面已学过：${ctx.previousLectures.map((l) => `《${l.title}》`).join("、")}（可以直接用，不要重讲）\n` : ""}${
    opts.referenceMaterial ? `参考资料（事实、数字、案例优先取自这里）：\n${opts.referenceMaterial.slice(0, 5000)}\n` : ""
  }${constraintsBlock(ctx.outputLanguage, ctx.constraints)}请写这节分步学习课。`;
  const raw = await generateJson<Omit<StepLesson, "version" | "generatedAt">>(LESSON_SYSTEM, user, {
    task: "design",
    maxTokens: 16000,
    schema: stepLessonSchema,
    onError: (e) => console.error("[lesson] generate failed:", e instanceof Error ? e.message : e),
  });
  if (!raw) return null;
  return { ...raw, subject: raw.subject as LessonSubject, version: 1, generatedAt: Date.now() };
}

const GRADE_SYSTEM = `你是一对一私教，正在批改学员"用自己的话解释"的作答。对照评判要点逐条看学员有没有说到（意思对即可，不要求原话）。
只输出 JSON：{"pass":true|false,"feedback":"2-4 句：先肯定说对的具体部分，再指出漏掉或说错的要点并补上正确说法"}
至少覆盖一半要点、且没有原则性错误算 pass。语气像老师当面点评，不要套话。`;

export async function gradeExplanation(input: { prompt: string; rubric: string[]; answer: string }): Promise<{ pass: boolean; feedback: string } | null> {
  return generateJson<{ pass: boolean; feedback: string }>(
    GRADE_SYSTEM,
    `题目：${input.prompt}\n评判要点：\n${input.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\n学员作答：${input.answer.slice(0, 1500)}`,
    { task: "judge", maxTokens: 600, schema: z.object({ pass: z.boolean(), feedback: text(4) }).loose() }
  );
}

const TUTOR_SYSTEM = `你是一对一私教。学员在分步学习课的某一步卡住了，向你提问。
回答要求：先用一句话复述他卡在哪；然后换一个角度讲清楚——更生活化的类比或一个更小的例子，不要把原讲解重说一遍；编程类可以给 3-8 行代码。
控制在 120-300 字，Markdown。最后一句把他带回这一步的练习。`;

export async function tutorReply(input: { lessonTitle: string; stepTitle: string; stepExplain: string; question: string; audience: string }): Promise<string | null> {
  const r = await generateJson<{ reply: string }>(
    TUTOR_SYSTEM + `\n只输出 JSON：{"reply":"Markdown 回答"}`,
    `课：${input.lessonTitle}\n学员：${input.audience}\n当前这一步：${input.stepTitle}\n这一步的讲解：\n${input.stepExplain.slice(0, 1500)}\n\n学员的问题：${input.question.slice(0, 500)}`,
    { task: "script", maxTokens: 1200, schema: z.object({ reply: text(10) }).loose() }
  );
  return r?.reply ?? null;
}
