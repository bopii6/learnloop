// 单元测验：quiz 课节的真实体验。此前测验课节是"即将开放"的死按钮，
// 大纲里三分之一课节不可学，是对学员的虚假承诺。现在出题交给 LLM（按单元出 5 题，
// 场景化、覆盖不同课节），判分在服务端（答案不下发前端），通过即记入档案。
// 出题一次收费、重考免费（quizzes/{courseId}__{lectureId}__{userId}.json 缓存题目）。
import { listKeys, readJson, writeJson } from "@/lib/storage";
import { generateJson } from "@/lib/agent/llm";
import { constraintsBlock } from "@/lib/agent/lang";
import type { CourseGenOutlineLite } from "@/lib/capstone";
import type { UnitQuizItem, QuizRecord } from "@/types";

export type { QuizRecord, UnitQuizItem };

const QUIZ_PREFIX = "quizzes/";

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function quizKey(courseId: string, lectureId: string, userId: string): string {
  return `${QUIZ_PREFIX}${sanitizeId(courseId)}__${sanitizeId(lectureId)}__${sanitizeId(userId)}.json`;
}

export async function loadQuizRecord(
  courseId: string,
  lectureId: string,
  userId: string
): Promise<QuizRecord | null> {
  return readJson<QuizRecord | null>(quizKey(courseId, lectureId, userId), null);
}

export async function saveQuizRecord(rec: QuizRecord): Promise<void> {
  rec.updatedAt = Date.now();
  await writeJson(quizKey(rec.courseId, rec.lectureId, rec.userId), rec);
}

/** 学员自己的测验通过情况列表（课程详情页徽章用） */
export async function listQuizRecordsForCourse(
  courseId: string,
  userId: string
): Promise<{ lectureId: string; passed: boolean }[]> {
  const prefix = `${QUIZ_PREFIX}${sanitizeId(courseId)}__${sanitizeId(userId)}__`;
  const items = await listKeys(QUIZ_PREFIX).catch(() => []);
  const out: { lectureId: string; passed: boolean }[] = [];
  for (const it of items) {
    const name = it.key.includes("/") ? it.key.split("/").pop()! : it.key;
    if (!name.startsWith(prefix.slice(QUIZ_PREFIX.length)) || !name.endsWith(".json")) continue;
    const lectureId = name.slice(prefix.length, -".json".length);
    const rec = await readJson<QuizRecord | null>(`${QUIZ_PREFIX}${name}`, null);
    if (rec) out.push({ lectureId, passed: Boolean(rec.passed) });
  }
  return out;
}

/** 下发学员前剥离答案：判分必须在服务端，否则 F12 就能满分 */
export function stripAnswers(quiz: UnitQuizItem[]): Omit<UnitQuizItem, "answerIndexes">[] {
  return quiz.map(({ question, multi, options, explain }) => ({ question, multi, options, explain }));
}

const UNIT_QUIZ_SYSTEM = `你是课程讲师。学员刚学完这个单元的全部课节，现在用一份单元测验检验真实掌握（不是考记忆，是考会不会用）。只输出 JSON：
{"quiz":[{"question":"...","multi":false,"options":["A","B","C"],"answerIndexes":[0],"explain":"..."}]}

规则：
- 恰好 5 道题，覆盖单元内不同课节（每道题锚定一个课节的要点，不要都考同一个点）。
- 大部分单选（multi=false），最多 1 道多选（multi=true）。禁止"下列哪项正确"的考试腔，题目要场景化：给一个具体情境，逼学员用刚学的判断。
- 至少 1 道题结合本课程的结课作品场景（若给出）出应用题。
- options 3-4 个，每个 ≤ 20 字；干扰项要像真实误区（学员真会选的那种），不要 obviously wrong 的凑数项。
- answerIndexes 是正确选项的下标数组（单选 1 个，多选可多个）。
- explain ≤ 60 字：为什么对、错在哪，一句话讲透。`;

export async function generateUnitQuiz(opts: {
  courseTitle: string;
  audience: string;
  unitTitle: string;
  unitSummary: string;
  keyConcepts: string[];
  lectureLines: string[]; // 本单元课节（标题 + 一句摘要）
  capstoneName?: string;
  lectureTitle: string;
  outputLanguage?: string;
  constraints?: string[];
}): Promise<UnitQuizItem[] | null> {
  const prompt = `课程：《${opts.courseTitle}》（面向：${opts.audience}）
测验课节：《${opts.lectureTitle}》

单元：《${opts.unitTitle}》
${opts.unitSummary}
关键概念：${opts.keyConcepts.join("、")}
本单元课节：
${opts.lectureLines.map((l) => `- ${l}`).join("\n")}
${opts.capstoneName ? `\n本课程结课作品（应用题结合它出）：${opts.capstoneName}` : ""}
${constraintsBlock(opts.outputLanguage, opts.constraints)}请出测验。`;
  const raw = await generateJson<{ quiz?: Partial<UnitQuizItem>[] }>(UNIT_QUIZ_SYSTEM, prompt, 2400);
  const quiz = raw?.quiz;
  if (!Array.isArray(quiz) || quiz.length === 0) return null;
  const items: UnitQuizItem[] = [];
  for (const q of quiz) {
    if (!q || !q.question || !Array.isArray(q.options) || q.options.length < 2) continue;
    const opts: string[] = q.options;
    const answers = (Array.isArray(q.answerIndexes) ? q.answerIndexes : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < opts.length);
    if (answers.length === 0) continue;
    items.push({
      question: String(q.question).slice(0, 240),
      multi: Boolean(q.multi) && answers.length > 1,
      options: opts.map((o) => String(o).slice(0, 60)).slice(0, 5),
      answerIndexes: [...new Set(answers)].slice(0, 5),
      explain: String(q.explain || "").slice(0, 200),
    });
    if (items.length >= 6) break;
  }
  return items.length > 0 ? items : null;
}

/** 判分：多选题按"全对才得分"（选多/选少都算错），与直觉一致且防蒙 */
export function gradeQuiz(quiz: UnitQuizItem[], answers: number[][]): { score: number; total: number } {
  let score = 0;
  for (let i = 0; i < quiz.length; i++) {
    const correct = [...new Set(quiz[i].answerIndexes)].sort().join(",");
    const given = [...new Set((answers[i] || []).filter((n) => Number.isInteger(n) && n >= 0 && n < quiz[i].options.length))]
      .sort()
      .join(",");
    if (correct === given && given !== "") score++;
  }
  return { score, total: quiz.length };
}
