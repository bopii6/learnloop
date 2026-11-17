// 白板课讲稿缓存（按 用户 × 课节）：首次开讲生成并落存储，之后复习 / 回放直接读，零成本。
import { listKeys, readJson, writeJson } from "@/lib/storage";
import type { BoardAction } from "@/types/board";
import type { LessonPlan, LessonReward, LessonSegment } from "@/lib/board/lesson-engine";

const SCRIPT_PREFIX = "board-scripts/";

/** 富媒体任务：占位已在动作序列里，生成结果到达后按 step 回填 */
export interface MediaTask {
  kind: "image" | "animation";
  caption?: string;
  prompt?: string;
  task?: string;
  /** 媒体自己的 step（到达后回执） */
  genStep: number;
  /** 占位 / 布局 step（立即回执） */
  placementStep: number;
  pageId: string;
}

export interface CachedBoardScript {
  actions: BoardAction[];
  media?: MediaTask[];
  pageId: string;
  generatedAt: number;
}

const safe = (s: string) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "");

export function boardScriptKey(courseId: string, unitId: string, lectureId: string, userId?: string): string {
  // v2：脚本协议升级（含富媒体占位步骤）后旧缓存不再命中
  return `${SCRIPT_PREFIX}v2_${userId ? `${safe(userId)}_` : ""}${safe(courseId)}_${safe(unitId)}_${safe(lectureId)}.json`;
}

/** 回放 / 分享用：整节课的动作序列（分段课把已生成的段首尾相接；旧版 v2 讲稿照常读） */
export async function loadBoardScript(
  courseId: string,
  unitId: string,
  lectureId: string,
  userId?: string
): Promise<CachedBoardScript | null> {
  const lesson = await loadLesson(courseId, unitId, lectureId, userId);
  if (lesson?.segments.length) {
    const actions: BoardAction[] = [];
    const media: MediaTask[] = [];
    for (const s of lesson.segments) {
      actions.push(...s.actions);
      media.push(...(s.media || []));
    }
    if (!actions.some((a) => a.type === "done")) actions.push({ type: "done", step_id: 999_999 });
    return { actions, media, pageId: lesson.pageId, generatedAt: lesson.generatedAt };
  }
  const hit = await readJson<CachedBoardScript | null>(boardScriptKey(courseId, unitId, lectureId, userId), null);
  return hit?.actions?.length ? hit : null;
}

// ---------------- 分段课（v3） ----------------

export interface CachedLessonSegment {
  seg: LessonSegment;
  actions: BoardAction[];
  media?: MediaTask[];
}

export interface CachedLesson {
  version: 3;
  plan: LessonPlan;
  pageId: string;
  /** 已生成的段（按顺序；最后一段可能是收尾段） */
  segments: CachedLessonSegment[];
  reward?: LessonReward;
  /** 收尾段已生成 = 整节课完整 */
  complete: boolean;
  generatedAt: number;
}

export function lessonKey(courseId: string, unitId: string, lectureId: string, userId?: string): string {
  return `${SCRIPT_PREFIX}v3_${userId ? `${safe(userId)}_` : ""}${safe(courseId)}_${safe(unitId)}_${safe(lectureId)}.json`;
}

export async function loadLesson(courseId: string, unitId: string, lectureId: string, userId?: string): Promise<CachedLesson | null> {
  const hit = await readJson<CachedLesson | null>(lessonKey(courseId, unitId, lectureId, userId), null);
  return hit?.version === 3 && hit.segments?.length ? hit : null;
}

export async function saveLesson(courseId: string, unitId: string, lectureId: string, userId: string | undefined, lesson: CachedLesson): Promise<void> {
  await writeJson(lessonKey(courseId, unitId, lectureId, userId), lesson);
}

export async function saveBoardScript(
  courseId: string,
  unitId: string,
  lectureId: string,
  userId: string | undefined,
  script: CachedBoardScript
): Promise<void> {
  await writeJson(boardScriptKey(courseId, unitId, lectureId, userId), script);
}

/** 删除课程时一并清理：键名形如 board-scripts/v2_{user}_{courseId}_{unit}_{lecture}.json */
export function isBoardScriptOfCourse(key: string, courseId: string): boolean {
  return key.startsWith(SCRIPT_PREFIX) && key.includes(`_${safe(courseId)}_`);
}

export interface AttendedLecture {
  courseId: string;
  unitId: string;
  lectureId: string;
  /** 讲稿生成时间（≈ 第一次上这节课的时间） */
  lastModified: number;
}

/**
 * 某个学员上过的课节：讲稿缓存按 用户 × 课节 落盘，存在即"上过"。
 * 进度标记（开始/继续学习、最近在学、货架上的我的进度）都以此为准，天然按用户隔离。
 */
export async function listAttendedLectures(userId?: string): Promise<AttendedLecture[]> {
  const items = await listKeys(SCRIPT_PREFIX).catch(() => []);
  const me = userId ? safe(userId) : "";
  const out: AttendedLecture[] = [];
  for (const item of items) {
    const name = item.key.split("/").pop()!.replace(/\.json$/, "");
    if (!name.startsWith("v2_") && !name.startsWith("v3_")) continue;
    // v2_/v3_{user}_{courseId}_{unitId}_{lectureId}；匿名时没有 user 段。课程/单元/课节 id 本身不含下划线
    const parts = name.slice(3).split("_");
    if (parts.length < 3) continue;
    const lectureId = parts.pop()!;
    const unitId = parts.pop()!;
    const courseId = parts.pop()!;
    if (parts.join("_") !== me) continue;
    if (out.some((o) => o.courseId === courseId && o.unitId === unitId && o.lectureId === lectureId)) continue;
    out.push({ courseId, unitId, lectureId, lastModified: item.lastModified ?? 0 });
  }
  return out;
}
