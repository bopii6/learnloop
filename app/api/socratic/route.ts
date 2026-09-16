// POST /api/socratic —— 苏格拉底私教课堂（原型）
// action:
//   "start"   生成探究链（plan），返回 meta + steps + 第一问
//   "answer"  学员回答 → 老师接（reply/verdict/板书 items），不推进步骤（步骤由客户端持有 plan 推进）
//   "simpler" 「没跟上」：用更基础的说法重讲上一轮，不推进
// 原型不接积分/缓存：每轮一次 LLM 调用，本地自用。
import { NextRequest } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { buildLectureContext, type LectureContext } from "@/lib/agent/teach";
import { runSocraticPlan, runSocraticTurn, runSocraticSimpler, type SocraticStep } from "@/lib/agent/socratic";
import { pagesForLecture } from "@/lib/textbook";
import { getProfile } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 与 /api/teach 同构的 ctx 组装：教材页 grounding / 前情 / 画像 / 结课作品 */
async function buildContext(req: NextRequest, body: { courseId?: string; unitId?: string; lectureId?: string }): Promise<LectureContext | null> {
  const state = await getCourseState(body.courseId || "");
  if (!state?.outline) return null;
  const ctx = buildLectureContext(state.outline, body.unitId || "", body.lectureId || "");
  if (!ctx) return null;
  if (!ctx.outputLanguage && state.outputLanguage) ctx.outputLanguage = state.outputLanguage;
  if (!ctx.constraints?.length && state.constraints?.length) ctx.constraints = state.constraints;

  const capstone = (state.outline as { capstone?: { name?: string; description?: string } } | undefined)?.capstone
    || (state.blueprint as { capstone?: { name?: string; description?: string } } | undefined)?.capstone;
  if (capstone?.name) {
    const clarifyHit = (state.clarifyAnswers || []).find((a) => /亲手做出|结课作品/.test(a.question || ""));
    ctx.capstoneGoal = [clarifyHit?.answer && clarifyHit.answer !== capstone.name ? clarifyHit.answer : capstone.name, capstone.description]
      .filter(Boolean)
      .join("——")
      .slice(0, 300);
  }

  let grounded = false;
  if (state.textbook?.pages?.length) {
    const totalLectures = state.outline.units.reduce((s, u) => s + u.lectures.length, 0);
    let lectureIdx = 0;
    for (const u of state.outline.units) {
      const j = u.lectures.findIndex((l) => l.id === (body.lectureId || ""));
      if (j >= 0) {
        lectureIdx += j;
        break;
      }
      lectureIdx += u.lectures.length;
    }
    const relPages = pagesForLecture(state.textbook, ctx.lectureTitle, [...(ctx.keyConcepts || []), ctx.lectureSummary], lectureIdx, totalLectures, 3);
    if (relPages.length > 0) {
      ctx.referenceMaterial = relPages.map((p) => `【教材《${state.textbook!.title}》第 ${p.page} 页】\n${p.text.slice(0, 1200)}`).join("\n\n");
      grounded = true;
    }
  }
  if (!grounded && state.sources?.length && state.pageContents) {
    const blocks: string[] = [];
    for (const s of state.sources) {
      const text = state.pageContents[String(s.index)];
      if (!text) continue;
      blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1500)}`);
      if (blocks.length >= 4) break;
    }
    if (blocks.length > 0) ctx.referenceMaterial = blocks.join("\n\n");
  }

  const teachUnit = state.outline.units.find((u) => u.id === (body.unitId || ""));
  if (teachUnit?.key_concepts?.length) ctx.keyConcepts = teachUnit.key_concepts;

  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (me) {
    const profile = await getProfile(me.id);
    if (profile.summary) ctx.profileHint = profile.summary;
    if (profile.name) ctx.studentName = profile.name;
  }
  return ctx;
}

export async function POST(req: NextRequest) {
  let body: {
    action?: "start" | "answer" | "simpler";
    courseId?: string;
    unitId?: string;
    lectureId?: string;
    step?: SocraticStep;
    nextAsk?: string;
    question?: string;
    lastReply?: string;
    answer?: string;
    history?: { role: "teacher" | "student"; content: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const ctx = await buildContext(req, body);
    if (!ctx) return Response.json({ error: "course or lecture not found" }, { status: 404 });

    if (body.action === "start") {
      const plan = await runSocraticPlan(ctx);
      return Response.json({
        meta: {
          courseTitle: ctx.courseTitle,
          lectureTitle: ctx.lectureTitle,
          studentName: ctx.studentName || "",
          audience: ctx.audience,
        },
        plan,
      });
    }

    if (body.action === "answer") {
      const step = body.step;
      if (!step?.ask) return Response.json({ error: "step required" }, { status: 400 });
      const answer = String(body.answer || "").trim();
      if (!answer) return Response.json({ error: "empty answer" }, { status: 400 });
      const turn = await runSocraticTurn({
        ctx,
        step,
        nextAsk: body.nextAsk || undefined,
        answer,
        history: Array.isArray(body.history) ? body.history.slice(-4) : [],
      });
      return Response.json(turn);
    }

    if (body.action === "simpler") {
      const reply = await runSocraticSimpler({
        ctx,
        question: String(body.question || "").slice(0, 80),
        lastReply: String(body.lastReply || "").slice(0, 500),
      });
      return Response.json({ reply });
    }

    return Response.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
