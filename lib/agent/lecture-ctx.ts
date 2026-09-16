// 组装完整课节上下文（与 /api/teach 同构）：教材页 grounding / 前情 / 画像 / 结课作品。
// 供新形态课堂（漫画/苏格拉底等）复用；/api/teach 自身的组装保持原样不动。
import type { NextRequest } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { buildLectureContext, type LectureContext } from "@/lib/agent/teach";
import { pagesForLecture } from "@/lib/textbook";
import { getProfile } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";

export async function buildFullLectureContext(
  req: NextRequest,
  ids: { courseId?: string; unitId?: string; lectureId?: string }
): Promise<LectureContext | null> {
  const state = await getCourseState(ids.courseId || "");
  if (!state?.outline) return null;
  const ctx = buildLectureContext(state.outline, ids.unitId || "", ids.lectureId || "");
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
      const j = u.lectures.findIndex((l) => l.id === (ids.lectureId || ""));
      if (j >= 0) {
        lectureIdx += j;
        break;
      }
      lectureIdx += u.lectures.length;
    }
    const relPages = pagesForLecture(state.textbook, ctx.lectureTitle, [...(ctx.keyConcepts || []), ctx.lectureSummary], lectureIdx, totalLectures, 3);
    if (relPages.length > 0) {
      ctx.referenceMaterial = relPages
        .map((p) => `【教材《${state.textbook!.title}》第 ${p.page} 页】\n${p.text.slice(0, 1200)}`)
        .join("\n\n");
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

  const teachUnit = state.outline.units.find((u) => u.id === (ids.unitId || ""));
  if (teachUnit?.key_concepts?.length) ctx.keyConcepts = teachUnit.key_concepts;

  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (me) {
    const profile = await getProfile(me.id);
    if (profile.summary) ctx.profileHint = profile.summary;
    if (profile.name) ctx.studentName = profile.name;
  }
  return ctx;
}
