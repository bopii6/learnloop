// POST /api/quiz —— 单元测验（quiz 课节）
// action: "start"（出题，题目缓存后重考不再生成）
//       | "submit"（交卷，服务端判分；答案永不下发前端）
// GET  ?courseId=            —— 当前学员本课程全部测验的通过情况（课程页徽章用）
// GET  ?courseId=&lectureId= —— 单个测验的进行中档案（不含答案）
import { NextRequest, NextResponse } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import {
  generateUnitQuiz,
  gradeQuiz,
  listQuizRecordsForCourse,
  loadQuizRecord,
  saveQuizRecord,
  stripAnswers,
} from "@/lib/unit-quiz";
import { userFromCookieHeader } from "@/lib/auth";
import { storageMode } from "@/lib/storage";
import { logOpsError } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 及格线：60%。过关标准要真实但不吓人；不过可以重考（免费），考的是掌握不是运气 */
const PASS_RATIO = 0.6;

export async function GET(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const userId = me?.id || "anonymous";
  const courseId = req.nextUrl.searchParams.get("courseId") || "";
  const lectureId = req.nextUrl.searchParams.get("lectureId") || "";
  if (!courseId) return NextResponse.json({ error: "courseId required" }, { status: 400 });
  if (lectureId) {
    const record = await loadQuizRecord(courseId, lectureId, userId);
    return NextResponse.json({
      record: record?.quiz ? { ...record, quiz: stripAnswers(record.quiz) } : null,
    });
  }
  return NextResponse.json({ records: await listQuizRecordsForCourse(courseId, userId) });
}

export async function POST(req: NextRequest) {
  let body: { action?: string; courseId?: string; lectureId?: string; answers?: number[][] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const me = await userFromCookieHeader(req.headers.get("cookie"));
    if (!me && storageMode === "r2") {
      return NextResponse.json({ error: "请先登录后再参加单元测验（成绩跟着账号走）" }, { status: 401 });
    }
    const userId = me?.id || "anonymous";

    const state = await getCourseState(body.courseId || "");
    if (!state?.outline) return NextResponse.json({ error: "course not found" }, { status: 404 });
    let unit = null;
    let lecture = null;
    for (const u of state.outline.units) {
      const l = u.lectures.find((x) => x.id === (body.lectureId || ""));
      if (l) {
        unit = u;
        lecture = l;
        break;
      }
    }
    if (!unit || !lecture || lecture.content_type !== "quiz") {
      return NextResponse.json({ error: "lecture not found" }, { status: 404 });
    }

    if (body.action === "start") {
      // 题目缓存命中：重考直接用同一套题，不重新生成
      const existing = await loadQuizRecord(body.courseId || "", lecture.id, userId);
      if (existing?.quiz) {
        return NextResponse.json({ quiz: stripAnswers(existing.quiz), cached: true });
      }

      {
        const capstoneName = state.outline.capstone?.name;
        const genArgs = {
          courseTitle: state.outline.title || state.title || "",
          audience: state.outline.audience || "",
          unitTitle: unit.title,
          unitSummary: unit.summary || "",
          keyConcepts: unit.key_concepts || [],
          lectureLines: unit.lectures.map((l) => `${l.title}（${l.summary || ""}）`),
          capstoneName,
          lectureTitle: lecture.title,
          outputLanguage: state.outline.outputLanguage || state.outputLanguage,
          constraints: state.outline.constraints?.length ? state.outline.constraints : state.constraints,
        };
        // LLM 瞬断重试一次
        const quiz = (await generateUnitQuiz(genArgs)) || (await generateUnitQuiz(genArgs));
        if (!quiz) throw new Error("出题失败（模型暂不可用，稍后再试）");
        const rec = {
          courseId: body.courseId || "",
          userId,
          lectureId: lecture.id,
          quiz,
          attempts: existing?.attempts || [],
          passed: existing?.passed || false,
          bestScore: existing?.bestScore,
          updatedAt: Date.now(),
        };
        await saveQuizRecord(rec);
        return NextResponse.json({ quiz: stripAnswers(quiz) });
      }
    }

    if (body.action === "submit") {
      const existing = await loadQuizRecord(body.courseId || "", lecture.id, userId);
      if (!existing?.quiz) return NextResponse.json({ error: "先开始测验再交卷" }, { status: 400 });
      const answers = Array.isArray(body.answers) ? body.answers : [];
      const { score, total } = gradeQuiz(existing.quiz, answers);
      const passed = score / total >= PASS_RATIO;
      existing.attempts = [{ at: Date.now(), score, total }, ...(existing.attempts || [])].slice(0, 30);
      existing.passed = existing.passed || passed;
      existing.bestScore = Math.max(existing.bestScore ?? 0, score);
      await saveQuizRecord(existing);
      return NextResponse.json({
        score,
        total,
        passed,
        firstPass: passed && existing.attempts.filter((a) => a.score / a.total >= PASS_RATIO).length === 1,
        // 交卷后才带答案下发：对题 + 看解析
        review: existing.quiz,
      });
    }

    return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  } catch (e) {
    logOpsError({
      kind: "quiz",
      detail: `action=${body.action} ${e instanceof Error ? e.message : String(e)}`,
    }).catch(() => {});
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
