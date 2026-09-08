// POST /api/capstone —— 结课作品工坊
// action: "brief"（生成个性化任务书，⚡1 积分，缓存后免费）
//       | "review"（验收提交的作品，对照做成标准逐条判定，⚡1 积分/次）
// GET  ?courseId= —— 拉当前学员的工坊记录（任务书/提交历史/是否结课）
import { NextRequest, NextResponse } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import {
  generateCapstoneBrief,
  loadCapstoneRecord,
  reviewCapstoneSubmission,
  saveCapstoneRecord,
} from "@/lib/capstone";
import { getProfile } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";
import { COST_CAPSTONE_BRIEF, COST_CAPSTONE_REVIEW, refundCredits, trySpend } from "@/lib/credits";
import { storageMode } from "@/lib/storage";
import { logOpsError } from "@/lib/ops";
import type { CapstoneRecord, CourseLecture, CourseUnit, CourseOutline } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function findLecture(
  outline: CourseOutline,
  lectureId: string
): { unit: CourseUnit; lecture: CourseLecture } | null {
  for (const unit of outline.units) {
    const lecture = unit.lectures.find((l) => l.id === lectureId);
    if (lecture) return { unit, lecture };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const courseId = req.nextUrl.searchParams.get("courseId") || "";
  if (!courseId) return NextResponse.json({ error: "courseId required" }, { status: 400 });
  const record = await loadCapstoneRecord(courseId, me?.id || "anonymous");
  return NextResponse.json({ record });
}

export async function POST(req: NextRequest) {
  let body: { action?: string; courseId?: string; lectureId?: string; text?: string; link?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const me = await userFromCookieHeader(req.headers.get("cookie"));
    // 与课堂同规则：本地自用放行匿名，公网部署（R2 模式）消耗积分必须登录
    if (!me && storageMode === "r2") {
      return NextResponse.json({ error: "请先登录后再使用结课工坊（验收消耗积分，与账号绑定）" }, { status: 401 });
    }
    const userId = me?.id || "anonymous";

    const state = await getCourseState(body.courseId || "");
    if (!state?.outline) return NextResponse.json({ error: "course not found" }, { status: 404 });
    const found = findLecture(state.outline, body.lectureId || "");
    if (!found || found.lecture.content_type !== "project") {
      return NextResponse.json({ error: "lecture not found" }, { status: 404 });
    }
    const { unit, lecture } = found;
    const capstone = state.outline.capstone;
    const capstoneName = capstone?.name || lecture.title;
    const capstoneDescription = capstone?.description || lecture.summary || "";
    const criteria = capstone?.criteria || [];
    const langCommon = {
      outputLanguage: state.outline.outputLanguage || state.outputLanguage,
      constraints: state.outline.constraints?.length ? state.outline.constraints : state.constraints,
    };

    const profile = await getProfile(me?.id);
    const shared = {
      courseTitle: state.outline.title || state.title || "",
      audience: state.outline.audience || "",
      capstoneName,
      capstoneDescription,
      criteria,
      lectureTitle: lecture.title,
      studentName: profile.name,
    };

    if (body.action === "brief") {
      // 缓存命中：任务书已生成过就不再收费（改要求后可手动重新生成，重新计费）
      const existing = await loadCapstoneRecord(body.courseId || "", userId);
      if (existing?.brief) return NextResponse.json({ record: existing, cached: true });

      let spent = 0;
      if (me) {
        const spend = await trySpend(me.id, COST_CAPSTONE_BRIEF, `结课任务书：${shared.courseTitle.slice(0, 24)}`);
        if (!spend.ok) {
          return NextResponse.json(
            { error: "credits_block", balance: spend.balance, need: COST_CAPSTONE_BRIEF, reason: "生成结课任务书" },
            { status: 402 }
          );
        }
        spent = COST_CAPSTONE_BRIEF;
      }
      try {
        // LLM 瞬断重试一次：任务书是学员动手前的第一脚，不能一脚踩空
        const brief =
          (await generateCapstoneBrief({
            ...shared,
            outline: state.outline,
            profileHint: profile.summary,
            ...langCommon,
          })) ||
          (await generateCapstoneBrief({
            ...shared,
            outline: state.outline,
            profileHint: profile.summary,
            ...langCommon,
          }));
        if (!brief) throw new Error("任务书生成失败（模型暂不可用，稍后再试）");
        const rec: CapstoneRecord = {
          courseId: body.courseId || "",
          userId,
          lectureId: lecture.id,
          capstoneName,
          brief,
          briefAt: Date.now(),
          submissions: existing?.submissions || [],
          passed: existing?.passed || false,
          passedAt: existing?.passedAt,
          updatedAt: Date.now(),
        };
        await saveCapstoneRecord(rec);
        return NextResponse.json({ record: rec, spent });
      } catch (e) {
        if (spent && me) await refundCredits(me.id, spent, "任务书生成失败退回");
        throw e;
      }
    }

    if (body.action === "review") {
      const text = (body.text || "").trim();
      if (text.length < 20) {
        return NextResponse.json({ error: "多写一点：做了什么、怎么做的、结果如何（至少 20 字），导师才能对照标准验收" }, { status: 400 });
      }
      let spent = 0;
      if (me) {
        const spend = await trySpend(me.id, COST_CAPSTONE_REVIEW, `作品验收：${shared.courseTitle.slice(0, 24)}`);
        if (!spend.ok) {
          return NextResponse.json(
            { error: "credits_block", balance: spend.balance, need: COST_CAPSTONE_REVIEW, reason: "验收结课作品" },
            { status: 402 }
          );
        }
        spent = COST_CAPSTONE_REVIEW;
      }
      try {
        const review = await reviewCapstoneSubmission({
          ...shared,
          submissionText: text,
          submissionLink: (body.link || "").trim() || undefined,
          ...langCommon,
        });
        if (!review) throw new Error("验收失败");
        const rec =
          (await loadCapstoneRecord(body.courseId || "", userId)) ||
          ({
            courseId: body.courseId || "",
            userId,
            lectureId: lecture.id,
            capstoneName,
            submissions: [],
            passed: false,
            updatedAt: Date.now(),
          } as CapstoneRecord);
        rec.submissions = [
          { at: Date.now(), text: text.slice(0, 4000), link: (body.link || "").trim() || undefined, review },
          ...(rec.submissions || []),
        ].slice(0, 20);
        if (review.passed && !rec.passed) {
          rec.passed = true;
          rec.passedAt = Date.now();
        }
        await saveCapstoneRecord(rec);
        return NextResponse.json({ record: rec, review, spent });
      } catch (e) {
        if (spent && me) await refundCredits(me.id, spent, "验收失败退回");
        throw e;
      }
    }

    return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  } catch (e) {
    logOpsError({
      kind: "capstone",
      detail: `action=${body.action} ${e instanceof Error ? e.message : String(e)}`,
    }).catch(() => {});
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
