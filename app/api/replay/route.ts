// 课程回放：一个只读链接完整重演一节白板课（分享获客的落地页）。
// POST { courseId, unitId, lectureId } → 取当前学员这节课的讲稿缓存（动作序列），
//   富媒体从哈希缓存取回并内联进序列（复习时已生成过，零成本），存一份快照返回 id。
// GET ?id= → 读取快照。旧版 v1 课堂的回放（beats 剧本）照常可读，播放端转成卡片。
import { NextRequest, NextResponse } from "next/server";
import { readJson, writeJson, storageMode } from "@/lib/storage";
import { userFromCookieHeader } from "@/lib/auth";
import { getCourseState } from "@/lib/agent/course";
import { buildLectureContext } from "@/lib/agent/lecture-context";
import { loadBoardScript } from "@/lib/board/script-store";
import { generateBoardImage, imageGenerationAvailable } from "@/lib/board/images";
import { generateBoardAnimation } from "@/lib/board/animation";
import type { ReplayReel } from "@/types";
import type { BoardAction } from "@/types/board";

export const runtime = "nodejs";

const REPLAY_PREFIX = "replays/";

function safeId(s: unknown): string {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
}

/** 保存回放快照 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { courseId?: string; unitId?: string; lectureId?: string } | null;
  const courseId = safeId(body?.courseId);
  const unitId = safeId(body?.unitId);
  const lectureId = safeId(body?.lectureId);
  if (!courseId || !unitId || !lectureId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!me && storageMode === "r2") return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const script = await loadBoardScript(courseId, unitId, lectureId, me?.id);
  if (!script) return NextResponse.json({ error: "这节课还没上过，上完才能分享回放" }, { status: 404 });

  const state = await getCourseState(courseId);
  const ctx = state?.outline ? buildLectureContext(state.outline, unitId, lectureId) : null;

  // 富媒体：成功的内联成 generated_* 帧，失败的连同占位一起剔除
  const failedPlacements = new Set<number>();
  const generated: BoardAction[] = [];
  for (const m of script.media || []) {
    try {
      if (m.kind === "image" && m.prompt && imageGenerationAvailable()) {
        const asset = await generateBoardImage(m.prompt);
        generated.push({
          type: "generated_image",
          step_id: m.genStep,
          placement_step_id: m.placementStep,
          page_id: m.pageId,
          image_url: asset.url,
          width: asset.width,
          height: asset.height,
          caption: m.caption,
        });
      } else if (m.kind === "animation" && m.task) {
        const html = await generateBoardAnimation(m.task);
        generated.push({
          type: "generated_animation",
          step_id: m.genStep,
          placement_step_id: m.placementStep,
          page_id: m.pageId,
          html,
          task: m.task,
        });
      } else {
        failedPlacements.add(m.placementStep);
      }
    } catch {
      failedPlacements.add(m.placementStep);
    }
  }
  const actions = script.actions.filter(
    (a) =>
      !((a.type === "image_gen_pending" || a.type === "animation_pending") && failedPlacements.has(a.placement_step_id))
  );

  const id = `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const reel: ReplayReel = {
    id,
    kind: "board",
    courseId,
    unitId,
    lectureId,
    courseTitle: ctx?.courseTitle || "",
    lectureTitle: ctx?.lectureTitle || "白板课回放",
    createdAt: Date.now(),
    actions: [...actions, ...generated],
  };
  await writeJson(`${REPLAY_PREFIX}${id}.json`, reel);
  return NextResponse.json({ id });
}

/** 读取回放：/api/replay?id=rp-xxx */
export async function GET(req: NextRequest) {
  const id = safeId(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  const reel = await readJson<ReplayReel | null>(`${REPLAY_PREFIX}${id}.json`, null);
  if (!reel) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ reel });
}
