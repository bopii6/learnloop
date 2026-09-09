// GET /api/courses/[id] —— 单个课程详情（含大纲 + 当前学员的已学课节集合）
import { NextResponse } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { listKeys } from "@/lib/storage";

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
