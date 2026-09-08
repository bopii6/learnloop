// 白板讲稿缓存 + 课堂追问计数。
// 为什么缓存：一节课的开讲 = 10+ 次 LLM 调用（导演拆片段 + 逐片段剧本 + 练习出题），
// 是课堂最贵的一步。学员复习同一节课时重跑整条管线，等于重复花钱 + 重复扣用户积分。
// 缓存后：首次开讲生成并落盘，之后复习直接回放缓存事件，零成本零积分。
// 为什么按用户隔离：开场 beat 会点名学员（profile.name 注入），全局共享会把 A 的名字播给 B。
import { readJson, writeJson } from "@/lib/storage";
import type { WhiteboardEvent } from "@/types";

const SCRIPT_PREFIX = "teach-scripts/";
const USAGE_PREFIX = "teach-usage/";

export interface TeachScriptCache {
  events: WhiteboardEvent[];
  generatedAt: number;
}

function safeId(s: string): string {
  return (s || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function scriptKey(courseId: string, unitId: string, lectureId: string, userId?: string): string {
  const base = `${safeId(courseId)}_${safeId(unitId)}_${safeId(lectureId)}`;
  return `${SCRIPT_PREFIX}${userId ? `${safeId(userId)}_${base}` : base}.json`;
}

export async function loadTeachScript(
  courseId: string,
  unitId: string,
  lectureId: string,
  userId?: string
): Promise<TeachScriptCache | null> {
  const cached = await readJson<TeachScriptCache | null>(scriptKey(courseId, unitId, lectureId, userId), null as any);
  if (cached && Array.isArray(cached.events) && cached.events.length > 0) return cached;
  return null;
}

export async function saveTeachScript(
  courseId: string,
  unitId: string,
  lectureId: string,
  userId: string | undefined,
  events: WhiteboardEvent[]
): Promise<void> {
  await writeJson(scriptKey(courseId, unitId, lectureId, userId), { events, generatedAt: Date.now() });
}

// ---- 课堂追问计数（每用户每节课，防滥用护栏而非计费） ----

interface TeachUsage {
  // key: courseId:unitId:lectureId → { chatCount, updatedAt }
  [lecture: string]: { chatCount: number; updatedAt: number };
}

function usageKey(userId?: string): string {
  return `${USAGE_PREFIX}${safeId(userId || "anonymous")}.json`;
}

export async function bumpChatCount(
  userId: string | undefined,
  courseId: string,
  unitId: string,
  lectureId: string,
  limit: number
): Promise<{ ok: boolean; count: number }> {
  const db = await readJson<TeachUsage>(usageKey(userId), {});
  const key = `${safeId(courseId)}:${safeId(unitId)}:${safeId(lectureId)}`;
  const rec = db[key] || { chatCount: 0, updatedAt: 0 };
  if (rec.chatCount >= limit) return { ok: false, count: rec.chatCount };
  rec.chatCount += 1;
  rec.updatedAt = Date.now();
  db[key] = rec;
  await writeJson(usageKey(userId), db);
  return { ok: true, count: rec.chatCount };
}
