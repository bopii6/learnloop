// 课堂追问计数（每用户每节课）：防滥用的护栏，而不是计费——追问本身不扣积分。
import { readJson, writeJson } from "@/lib/storage";

const USAGE_PREFIX = "teach-usage/";

interface LectureUsage {
  // key: courseId:unitId:lectureId → { chatCount, updatedAt }
  [lecture: string]: { chatCount: number; updatedAt: number };
}

function safeId(s: string): string {
  return (s || "").replace(/[^a-zA-Z0-9_-]/g, "");
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
  const db = await readJson<LectureUsage>(usageKey(userId), {});
  const key = `${safeId(courseId)}:${safeId(unitId)}:${safeId(lectureId)}`;
  const rec = db[key] || { chatCount: 0, updatedAt: 0 };
  if (rec.chatCount >= limit) return { ok: false, count: rec.chatCount };
  rec.chatCount += 1;
  rec.updatedAt = Date.now();
  db[key] = rec;
  await writeJson(usageKey(userId), db);
  return { ok: true, count: rec.chatCount };
}
