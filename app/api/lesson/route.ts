// POST /api/lesson —— 分步学习课（样板）
// action=get    → 取本节课（按 用户 × 课节 缓存；首次生成约 1 分钟）
// action=grade  → 批改"用自己的话解释"类练习
// action=ask    → 学员在某一步卡住时提问，讲师换角度讲
// 公网（R2 模式）必须登录；提问每节课有上限（与白板课共用计数）。
import { NextRequest, NextResponse } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { buildLectureContext } from "@/lib/agent/lecture-context";
import { userFromCookieHeader } from "@/lib/auth";
import { getProfile } from "@/lib/profile";
import { readJson, writeJson, storageMode } from "@/lib/storage";
import { pagesForLecture } from "@/lib/textbook";
import { CHAT_LIMIT_PER_LECTURE, bumpChatCount } from "@/lib/chat-limit";
import { generateStepLesson, gradeExplanation, tutorReply } from "@/lib/lesson/generate";
import type { StepLesson } from "@/types/lesson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const safe = (s: unknown) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

function lessonKey(courseId: string, unitId: string, lectureId: string, userId?: string) {
  return `lessons/v1_${userId ? `${safe(userId)}_` : ""}${safe(courseId)}_${safe(unitId)}_${safe(lectureId)}.json`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    courseId?: string;
    unitId?: string;
    lectureId?: string;
    regenerate?: boolean;
    stepIndex?: number;
    question?: string;
    answer?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "invalid json" }, { status: 400 });

  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!me && storageMode === "r2") return NextResponse.json({ error: "请先登录再上课" }, { status: 401 });

  const courseId = safe(body.courseId);
  const unitId = safe(body.unitId);
  const lectureId = safe(body.lectureId);
  const state = await getCourseState(courseId);
  if (!state?.outline) return NextResponse.json({ error: "课程不存在" }, { status: 404 });
  const ctx = buildLectureContext(state.outline, unitId, lectureId);
  if (!ctx) return NextResponse.json({ error: "课节不存在" }, { status: 404 });
  const key = lessonKey(courseId, unitId, lectureId, me?.id);

  if (body.action === "get") {
    if (!body.regenerate) {
      const cached = await readJson<StepLesson | null>(key, null);
      if (cached?.steps?.length) return NextResponse.json({ lesson: cached, cached: true });
    }
    // 事实来源：教材按课节挑页，否则用建课时读到的网页正文
    let referenceMaterial = "";
    if (state.textbook?.pages?.length) {
      let idx = 0;
      let total = 0;
      for (const u of state.outline.units) {
        const j = u.lectures.findIndex((l) => l.id === lectureId);
        if (j >= 0) idx = total + j;
        total += u.lectures.length;
      }
      referenceMaterial = pagesForLecture(state.textbook, ctx.lectureTitle, [...(ctx.keyConcepts || []), ctx.lectureSummary], idx, total, 3)
        .map((p) => `【教材第 ${p.page} 页】\n${p.text.slice(0, 1500)}`)
        .join("\n\n");
    } else if (state.sources?.length && state.pageContents) {
      const blocks: string[] = [];
      for (const s of state.sources) {
        const t = state.pageContents[String(s.index)];
        if (!t) continue;
        blocks.push(`《${s.title}》（${s.domain}）：${t.slice(0, 1500)}`);
        if (blocks.length >= 3) break;
      }
      referenceMaterial = blocks.join("\n\n");
    }
    const profile = await getProfile(me?.id);
    const lesson = await generateStepLesson(ctx, {
      referenceMaterial,
      profileLine: profile.summary ? `学员画像：${profile.summary}` : undefined,
    });
    if (!lesson) return NextResponse.json({ error: "讲师备课失败了，请稍后重试" }, { status: 502 });
    await writeJson(key, lesson).catch(() => {});
    return NextResponse.json({ lesson });
  }

  if (body.action === "grade") {
    const lesson = await readJson<StepLesson | null>(key, null);
    const step = lesson?.steps?.[Number(body.stepIndex)];
    const p = step?.practice;
    if (!p || p.kind !== "explain" || !p.rubric?.length) return NextResponse.json({ error: "这一步没有需要批改的题" }, { status: 400 });
    const answer = String(body.answer || "").trim();
    if (answer.length < 6) return NextResponse.json({ error: "多写一点，用你自己的话说说看" }, { status: 400 });
    const r = await gradeExplanation({ prompt: p.prompt, rubric: p.rubric, answer });
    if (!r) return NextResponse.json({ error: "批改失败，请重试" }, { status: 502 });
    return NextResponse.json(r);
  }

  if (body.action === "ask") {
    const question = String(body.question || "").trim();
    if (!question) return NextResponse.json({ error: "问题不能为空" }, { status: 400 });
    const guard = await bumpChatCount(me?.id, courseId, unitId, lectureId, CHAT_LIMIT_PER_LECTURE);
    if (!guard.ok) return NextResponse.json({ error: `本节课的提问已达上限（${CHAT_LIMIT_PER_LECTURE} 条）` }, { status: 429 });
    const lesson = await readJson<StepLesson | null>(key, null);
    const step = lesson?.steps?.[Number(body.stepIndex)];
    const reply = await tutorReply({
      lessonTitle: lesson?.title || ctx.lectureTitle,
      stepTitle: step?.title || ctx.lectureTitle,
      stepExplain: step?.explain || ctx.lectureSummary,
      question,
      audience: ctx.audience,
    });
    if (!reply) return NextResponse.json({ error: "讲师这次没接住，再问一次试试" }, { status: 502 });
    return NextResponse.json({ reply });
  }

  return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
}
