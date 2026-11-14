// 学习者画像：跨课程持久化（profile.json，经存储抽象层）
// 每门课的澄清问答与课程记录沉淀为画像事实，定期蒸馏成摘要，
// 注入后续的课程生成（蓝图/大纲/澄清）与白板教学，让个性化跨课程生效。
import { streamAnswer } from "./agent/llm";
import { readJson, writeJson } from "@/lib/storage";

export interface ProfileFact {
  question: string;
  answer: string;
  captured_at: string;
}

export interface LearnerProfile {
  name: string; // 学员称呼：课堂点名开场用
  summary: string; // 供 prompt 注入的画像摘要
  facts: ProfileFact[];
  courses: string[]; // 学过/生成过的课程标题
  updated_at: string;
}

// 画像按登录用户隔离：profiles/{userId}.json；未登录共用 anonymous 空间。
// 旧版全局单文件会让 A 的画像注入 B 的课程与课堂，属于上线阻断级隐私问题。
const PROFILE_KEY_PREFIX = "profiles/";

function profileKey(userId?: string): string {
  const safe = (userId || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "");
  return `${PROFILE_KEY_PREFIX}${safe}.json`;
}

function emptyProfile(): LearnerProfile {
  return { name: "", summary: "", facts: [], courses: [], updated_at: "" };
}

export async function getProfile(userId?: string): Promise<LearnerProfile> {
  const p = await readJson<Partial<LearnerProfile>>(profileKey(userId), {});
  return {
    name: typeof p.name === "string" ? p.name.slice(0, 20) : "",
    summary: typeof p.summary === "string" ? p.summary : "",
    facts: Array.isArray(p.facts) ? p.facts : [],
    courses: Array.isArray(p.courses) ? p.courses : [],
    updated_at: p.updated_at || "",
  };
}

export async function saveProfileName(name: string, userId?: string): Promise<LearnerProfile> {
  const profile = await getProfile(userId);
  profile.name = name.trim().slice(0, 20);
  await saveProfile(profile, userId);
  return profile;
}

export async function saveProfile(p: LearnerProfile, userId?: string): Promise<void> {
  p.updated_at = new Date().toISOString();
  await writeJson(profileKey(userId), p, { pretty: true });
}

export async function resetProfile(userId?: string): Promise<void> {
  await saveProfile(emptyProfile(), userId);
}

/** 序列化画像为可注入 prompt 的文本（空画像返回空串） */
export function profileText(p: LearnerProfile): string {
  const facts = p.facts
    .slice(-12)
    .map((f) => `- ${f.question}：${f.answer}`)
    .join("\n");
  if (!p.summary && !facts) return "";
  const courses = p.courses.length > 0 ? `\n学过的课程：${p.courses.slice(-8).join("、")}` : "";
  return `${p.summary ? `画像摘要：${p.summary}\n` : ""}${facts ? `历史问答：\n${facts}` : ""}${courses}`;
}

const DISTILL_SYSTEM = `你是学习画像分析师。根据学习者的历史问答和课程记录，输出一段 3-6 句的学习者画像。
覆盖：基础水平、学习目标与取向（学术/工程）、偏好的讲解深度和方式、已掌握的概念。
直接输出画像正文，不要标题、不要列表、不要客套。`;

/** 把一门课的澄清问答沉淀进画像；每累计 2 条新事实（或首次）重新蒸馏摘要，失败静默 */
export async function captureCourseProfile(opts: {
  courseTitle: string;
  clarifyAnswers: { question: string; answer: string }[];
}, userId?: string): Promise<LearnerProfile> {
  const profile = await getProfile(userId);
  const seen = new Set(profile.facts.map((f) => f.question));
  let added = 0;
  for (const { question, answer } of opts.clarifyAnswers) {
    const trimmed = (answer || "").trim();
    if (!trimmed || trimmed === "跳过" || seen.has(question)) continue;
    profile.facts.push({ question, answer: trimmed, captured_at: new Date().toISOString() });
    seen.add(question);
    added += 1;
  }
  if (opts.courseTitle && !profile.courses.includes(opts.courseTitle)) {
    profile.courses.push(opts.courseTitle);
  }

  if (added > 0 && (!profile.summary || added % 2 === 0)) {
    try {
      const text = await streamAnswer(
        DISTILL_SYSTEM,
        profileText(profile) || `学习者刚学了课程《${opts.courseTitle}》`,
        () => {},
        { task: "fast", maxTokens: 800 }
      );
      const cleaned = (text || "").trim();
      if (cleaned.length >= 20) profile.summary = cleaned.slice(0, 600);
    } catch {
      // 蒸馏失败不影响主流程，保留旧摘要
    }
  }

  await saveProfile(profile, userId);
  return profile;
}

/** 澄清提问时用：告知 LLM 哪些维度画像已覆盖，避免重复提问 */
export function profileHintForClarify(p: LearnerProfile): string {
  if (p.facts.length === 0) return "";
  const known = p.facts.slice(-12).map((f) => `${f.question} → ${f.answer}`).join("\n");
  return `该学习者已有的画像信息（这些维度不要再问，优先问没覆盖过的维度，如目标、场景、时间投入等）：\n${known}`;
}
