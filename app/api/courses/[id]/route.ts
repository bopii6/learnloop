// GET /api/courses/[id] —— 单个课程详情（含大纲）
import { NextResponse } from "next/server";
import { getCourseState } from "@/lib/agent/course";

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
  return NextResponse.json({
    course: {
      id,
      title: state.title || state.outline.title,
      outline: state.outline,
    },
  });
}
