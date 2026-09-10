// GET /api/courses/[id] —— 单个课程详情（含大纲 + 当前学员的已学课节集合）
// DELETE /api/courses/[id] —— 删除课程及其学习痕迹（进度快照/回放/测验/结课作品/讲稿缓存）
import { NextRequest, NextResponse } from "next/server";
import { getCourseState, metaKey } from "@/lib/agent/course";
import { listKeys, readJson, removeKey } from "@/lib/storage";
import { userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const state = await getCourseState(id);
  if (!state?.outline) {
    return NextResponse.json({ error: "course not found" }, { status: 404 });
  }
  // 已学课节：课堂快照文件名 = {courseId}unit-*lec-*（与 /api/courses 列表口径一致）。
  // 读失败按没学过处理——进度缺失不该挡住课程打开。
  let visited: string[] = [];
  try {
    const items = await listKeys("classrooms/");
    visited = items
      .map((i) => i.key.replace(/\.json$/, ""))
      .filter((k) => k.startsWith(`classrooms/${id}unit-`))
      .map((k) => k.slice(k.indexOf("lec-")))
      .filter((k) => k.startsWith("lec-"));
  } catch {
    // 进度拿不到就当全新
  }
  return NextResponse.json({
    course: {
      id,
      title: state.title || state.outline.title,
      outline: state.outline,
    },
    visited,
  });
}

const sanitizeIdPart = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "");

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const cleanId = sanitizeIdPart(id);
  const me = await userFromCookieHeader(req.headers.get("cookie"));

  // 归属校验与列表接口同口径：有主的课只有主人能删，无主的历史数据登录后可删
  const meta = await readJson<{ ownerId?: string } | null>(metaKey(cleanId), null).catch(() => null);
  if (meta?.ownerId && (!me || meta.ownerId !== me.id)) {
    return NextResponse.json({ error: "not your course" }, { status: 403 });
  }

  const removeMatching = async (prefix: string, match: (key: string) => boolean) => {
    const items = await listKeys(prefix).catch(() => []);
    for (const item of items) {
      const key = item.key.replace(/\.json$/, "");
      if (match(key)) await removeKey(`${key}.json`).catch(() => {});
    }
  };

  try {
    // 课程本体 + 列表索引
    await removeKey(`courses/${cleanId}.json`).catch(() => {});
    await removeKey(`course-meta/${cleanId}.json`).catch(() => {});
    // 学习痕迹：课堂进度快照（classrooms/{id}unit-*）、讲稿缓存（teach-scripts/）、
    // 测验（quizzes/{id}__*）、结课作品（capstones/{id}__*）、回放（按内容里的 courseId 匹配）
    await removeMatching("classrooms/", (k) => k.startsWith(`classrooms/${cleanId}unit-`));
    await removeMatching("teach-scripts/", (k) => k.includes(`${cleanId}unit-`));
    await removeMatching("quizzes/", (k) => k.startsWith(`quizzes/${cleanId}__`));
    await removeMatching("capstones/", (k) => k.startsWith(`capstones/${cleanId}__`));
    const replayItems = await listKeys("replays/").catch(() => []);
    for (const item of replayItems) {
      const key = item.key.replace(/\.json$/, "");
      const reel = await readJson<{ courseId?: string } | null>(`${key}.json`, null).catch(() => null);
      if (reel?.courseId === id || reel?.courseId === cleanId) {
        await removeKey(`${key}.json`).catch(() => {});
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status: 500 }
    );
  }
}
