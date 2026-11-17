// POST /api/board —— 白板课服务端（分段 + 自适应讲课，见 lib/board/lesson-engine.ts）
// action=start  → 本节规划 + 第 1 段（或断点续播：已生成的前几段）。SSE 按白板帧格式下发。
// action=next   → 学员答完第 k 段的检查：带着他的回答生成第 k+1 段（最后一段之后是收尾段）。
// action=answer → 课堂追问 / "没听懂"：讲师现场接住，插在当前这一拍之后，不计进度。
// 生成过的段按（用户 × 课节）落盘：复习直接读，不再生成。公网（R2 模式）必须登录；追问有每节上限。
import { NextRequest } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { buildLectureContext } from "@/lib/agent/lecture-context";
import { getProfile } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";
import { newPageId } from "@/lib/board/layout";
import { generateBoardImage, imageGenerationAvailable } from "@/lib/board/images";
import { CHAT_LIMIT_PER_LECTURE, bumpChatCount } from "@/lib/chat-limit";
import { storageMode } from "@/lib/storage";
import { logStruggle } from "@/lib/ops";
import { pagesForLecture } from "@/lib/textbook";
import { groupActions } from "@/lib/board/actions";
import { loadLesson, saveLesson, type CachedLesson, type MediaTask } from "@/lib/board/script-store";
import {
  createSegmentBuilder,
  generateFollowup,
  generateLessonClosing,
  generateLessonNext,
  generateLessonStart,
  segmentToActions,
  streamLessonClosing,
  streamLessonNext,
  streamLessonStart,
  summarizeSegments,
  verifyCheck,
  type LearnerAnswer,
  type LessonBeat,
  type LessonPlan,
} from "@/lib/board/lesson-engine";
import type { BoardAction, BoardEvent } from "@/types/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const safeId = (s: unknown) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

interface Body {
  action?: "start" | "next" | "answer";
  courseId?: string;
  unitId?: string;
  lectureId?: string;
  /** start：断点续播到第几段（把已生成的 0..resumeSegment 段一起下发，客户端快进） */
  resumeSegment?: number;
  /** next：刚答完的是第几段 */
  index?: number;
  answer?: LearnerAnswer;
  /** answer：学员的追问 */
  message?: string;
  simpler?: boolean;
  /** answer：回应追加到客户端当前页 */
  pageId?: string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }
  const courseId = safeId(body.courseId);
  const unitId = safeId(body.unitId);
  const lectureId = safeId(body.lectureId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (e: BoardEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // 客户端断开
        }
      };
      const sendActions = async (actions: BoardAction[]) => {
        for (const g of groupActions(actions)) await send({ type: "group", actions: g });
      };
      /** 富媒体：占位已在动作里，这里生成并回填（图片按 prompt 哈希缓存，复习零成本） */
      const runMedia = async (media: MediaTask[]) => {
        await Promise.allSettled(
          media.map(async (m) => {
            try {
              if (m.kind === "image" && m.prompt) {
                const asset = await generateBoardImage(m.prompt);
                await send({
                  type: "generated_image",
                  step_id: m.genStep,
                  placement_step_id: m.placementStep,
                  page_id: m.pageId,
                  image_url: asset.url,
                  width: asset.width,
                  height: asset.height,
                  caption: m.caption,
                });
              }
            } catch (e) {
              console.error("[board] media failed:", e instanceof Error ? e.message : e);
              await send({ type: "media_failed", step_id: m.genStep, placement_step_id: m.placementStep, kind: m.kind });
            }
          })
        );
      };
      const fail = async (message: string) => {
        await send({ type: "error", message });
      };

      try {
        const state = await getCourseState(courseId);
        if (!state?.outline) return await fail("course not found");
        const ctx = buildLectureContext(state.outline, unitId, lectureId);
        if (!ctx) return await fail("lecture not found");
        const me = await userFromCookieHeader(req.headers.get("cookie"));
        if (!me && storageMode === "r2") {
          await send({ type: "auth_required", message: "登录后就能开始上课（课堂进度跟着账号走）" });
          return;
        }
        const profile = await getProfile(me?.id);

        // ---- 上下文：课程 / 学员 / 前情 / 事实来源 ----
        let referenceMaterial = "";
        let lectureIndex = 0;
        let totalLectures = 0;
        const flat: { id: string; title: string; type?: string }[] = [];
        for (const u of state.outline.units) {
          const j = u.lectures.findIndex((l) => l.id === lectureId);
          if (j >= 0) lectureIndex = totalLectures + j;
          totalLectures += u.lectures.length;
          for (const l of u.lectures) flat.push({ id: l.id, title: l.title, type: (l as { content_type?: string }).content_type });
        }
        const pos = flat.findIndex((l) => l.id === lectureId);
        const nextLecture = flat.slice(pos + 1).find((l) => l.type !== "quiz" && l.type !== "project");
        const textbookPages = state.textbook?.pages?.length
          ? pagesForLecture(state.textbook, ctx.lectureTitle, [...(ctx.keyConcepts || []), ctx.lectureSummary], lectureIndex, totalLectures, 3)
          : [];
        if (textbookPages.length > 0) {
          referenceMaterial = textbookPages.map((p) => `【教材《${state.textbook!.title}》第 ${p.page} 页】\n${p.text.slice(0, 1200)}`).join("\n\n");
        } else if (state.sources?.length && state.pageContents) {
          const blocks: string[] = [];
          for (const s of state.sources) {
            const t = state.pageContents[String(s.index)];
            if (!t) continue;
            blocks.push(`《${s.title}》（${s.domain}）：${t.slice(0, 1200)}`);
            if (blocks.length >= 3) break;
          }
          referenceMaterial = blocks.join("\n\n");
        }
        const capstone = (state.outline as { capstone?: { name?: string; description?: string } }).capstone;
        const context = [
          `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）`,
          `本单元：${ctx.unitTitle}${ctx.keyConcepts?.length ? `（关键概念：${ctx.keyConcepts.join("、")}）` : ""}`,
          `本节课：${ctx.lectureTitle} —— ${ctx.lectureSummary}`,
          profile.name ? `称呼学员「${profile.name}」。` : "",
          profile.summary ? `学员画像：${profile.summary}` : "",
          capstone?.name ? `学员的结课作品：${capstone.name}${capstone.description ? `（${capstone.description}）` : ""}。例子尽量落在他的作品场景里。` : "",
          ctx.previousLectures?.length
            ? `本单元前面已讲过：${ctx.previousLectures.map((l) => `《${l.title}》`).join("、")}。第一段开场一句话接住上一讲，不要重讲。`
            : "",
          referenceMaterial ? `参考资料（事实、数字、案例优先取自这里）：\n${referenceMaterial.slice(0, 4000)}` : "没有参考资料：按你的知识讲，不发明统计数字。",
        ]
          .filter(Boolean)
          .join("\n");
        const imagesAllowed = imageGenerationAvailable();
        const save = (lesson: CachedLesson) => saveLesson(courseId, unitId, lectureId, me?.id, lesson).catch(() => {});

        // ---- 追问 / 没听懂 ----
        if (body.action === "answer") {
          const guard = await bumpChatCount(me?.id, courseId, unitId, lectureId, CHAT_LIMIT_PER_LECTURE);
          if (!guard.ok) {
            return await fail(`本节课的提问已达上限（${CHAT_LIMIT_PER_LECTURE} 条）。换个课节继续，或明天再来复习巩固。`);
          }
          const message = String(body.message || "").slice(0, 300);
          if (body.simpler) await logStruggle({ userId: me?.id, courseId, unitId, lectureId });
          const lesson = await loadLesson(courseId, unitId, lectureId, me?.id);
          const beats = await generateFollowup({
            context,
            covered: lesson ? summarizeSegments(lesson.segments.map((s) => s.seg)) : "",
            message,
          });
          if (!beats?.length) return await fail("讲师这次没接住，再问一次试试。");
          const pageId = safeId(body.pageId) || newPageId();
          const { actions } = segmentToActions({ beats }, { index: 0, pageId, reply: true });
          await sendActions(actions);
          await send({ type: "response_complete", is_complete: true, status: "completed" });
          return;
        }

        // ---- 下一段（流式：讲师每写完一拍就上板） ----
        if (body.action === "next") {
          const lesson = await loadLesson(courseId, unitId, lectureId, me?.id);
          if (!lesson) return await fail("这节课的进度丢了，请重新开始。");
          const target = Math.max(0, Math.floor(Number(body.index) || 0)) + 1;
          const cached = lesson.segments[target];
          if (cached) {
            await sendActions(cached.actions);
            await runMedia(cached.media || []);
            await send({ type: "response_complete", is_complete: true, status: "completed" });
            return;
          }
          if (lesson.complete || target !== lesson.segments.length) {
            // 已收尾，或越过了还没生成的段（不允许跳段）
            await send({ type: "response_complete", is_complete: true, status: "completed" });
            return;
          }
          const answer: LearnerAnswer = {
            question: String(body.answer?.question || "").slice(0, 200),
            kind: body.answer?.kind === "code" || body.answer?.kind === "choice" ? body.answer.kind : "open",
            options: Array.isArray(body.answer?.options) ? body.answer!.options!.slice(0, 4).map((o) => String(o).slice(0, 60)) : undefined,
            text: String(body.answer?.text || "（跳过了这题）").slice(0, 400),
            correct: typeof body.answer?.correct === "boolean" ? body.answer.correct : undefined,
            code: body.answer?.code ? String(body.answer.code).slice(0, 2000) : undefined,
            output: body.answer?.output ? String(body.answer.output).slice(0, 800) : undefined,
            explanation: body.answer?.explanation ? String(body.answer.explanation).slice(0, 200) : undefined,
          };
          const covered = summarizeSegments(lesson.segments.map((s) => s.seg));
          const total = lesson.plan.segments.length;
          const final = target >= total;
          const builder = createSegmentBuilder({
            index: target,
            pageId: lesson.pageId,
            segmentTitle: final ? "收尾" : lesson.plan.segments[target]?.title,
            total,
            final,
          });
          const all: BoardAction[] = [];
          const media: MediaTask[] = [];
          let begun = false;
          const push = async (actions: BoardAction[]) => {
            all.push(...actions);
            await sendActions(actions);
          };
          const onBeat = async (beat: LessonBeat) => {
            if (!begun) {
              begun = true;
              await push(builder.begin());
            }
            const r = builder.beat(beat);
            media.push(...r.media);
            await push(r.actions);
          };
          const t0 = Date.now();
          const streamed = final
            ? await streamLessonClosing({ context, imagesAllowed, plan: lesson.plan, covered, answer, nextLectureTitle: nextLecture?.title }, { onBeat }).catch((e) => {
                console.error("[lesson] closing stream failed:", e instanceof Error ? e.message : e);
                return null;
              })
            : await streamLessonNext({ context, imagesAllowed, plan: lesson.plan, index: target, covered, answer }, { onBeat }).catch((e) => {
                console.error("[lesson] next stream failed:", e instanceof Error ? e.message : e);
                return null;
              });
          let seg = streamed?.segment;
          let reward = streamed?.reward;
          if (!begun) {
            // 流式一拍都没出来：退回整段生成
            if (final) {
              const c = await generateLessonClosing({ context, imagesAllowed, plan: lesson.plan, covered, answer, nextLectureTitle: nextLecture?.title });
              seg = c?.segment;
              reward = c?.reward;
            } else {
              seg = (await generateLessonNext({ context, imagesAllowed, plan: lesson.plan, index: target, covered, answer })) ?? undefined;
            }
            if (!seg?.beats.length) return await fail("讲师这次没接上，点「重试」再来一次。");
            await push(builder.begin());
            for (const b of seg.beats) {
              const r = builder.beat(b);
              media.push(...r.media);
              await push(r.actions);
            }
          } else {
            console.log(`[lesson] segment ${target} streamed: first beat ${streamed?.firstLineMs}ms, total ${Date.now() - t0}ms`);
          }
          if (final) delete seg!.check;
          // 检查题审校（开思考重算答案）：学员此刻还在听这一段，不占他的等待时间
          if (seg!.check) seg!.check = await verifyCheck(seg!.check, seg!.beats);
          await push(builder.end(final ? undefined : seg!.check, final ? reward : undefined));
          lesson.segments.push({ seg: seg!, actions: all, media });
          if (final) {
            lesson.reward = reward;
            lesson.complete = true;
          }
          await save(lesson);
          await runMedia(media);
          await send({ type: "response_complete", is_complete: true, status: "completed" });
          return;
        }

        // ---- 开讲 ----
        let lesson = await loadLesson(courseId, unitId, lectureId, me?.id);
        if (lesson) {
          await send({ type: "session_ready", session_id: `${courseId}__${lectureId}`, session_title: ctx.lectureTitle, status: "active" });
          await send({ type: "lesson_plan", title: lesson.plan.title || ctx.lectureTitle, segments: lesson.plan.segments.map((s) => ({ title: s.title })) });
          const upto = Math.min(lesson.segments.length - 1, Math.max(0, Math.floor(Number(body.resumeSegment) || 0)));
          const media: MediaTask[] = [];
          for (let i = 0; i <= upto; i++) {
            await sendActions(lesson.segments[i].actions);
            media.push(...(lesson.segments[i].media || []));
          }
          await runMedia(media);
          await send({ type: "response_complete", is_complete: true, status: "completed" });
          return;
        }

        // 首次开讲（流式）：规划一到就开页，之后每一拍写完就上板
        const pageId = newPageId();
        let plan: LessonPlan | undefined;
        let builder: ReturnType<typeof createSegmentBuilder> | null = null;
        const all: BoardAction[] = [];
        const media: MediaTask[] = [];
        const pending: LessonBeat[] = [];
        const push = async (actions: BoardAction[]) => {
          all.push(...actions);
          await sendActions(actions);
        };
        const openLesson = async (p: LessonPlan) => {
          plan = p;
          await send({ type: "session_ready", session_id: `${courseId}__${lectureId}`, session_title: ctx.lectureTitle, status: "active" });
          await send({ type: "lesson_plan", title: p.title || ctx.lectureTitle, segments: p.segments.map((s) => ({ title: s.title })) });
          builder = createSegmentBuilder({ index: 0, pageId, newPage: { title: p.title || ctx.lectureTitle }, segmentTitle: p.segments[0]?.title, total: p.segments.length });
          await push(builder.begin());
        };
        const beatOut = async (beat: LessonBeat) => {
          const r = builder!.beat(beat);
          media.push(...r.media);
          await push(r.actions);
        };
        const t0 = Date.now();
        const streamed = await streamLessonStart(
          { context, imagesAllowed },
          {
            onPlan: openLesson,
            onBeat: async (beat) => {
              if (!builder) pending.push(beat); // 规划还没到（模型没按顺序写）：先攒着
              else await beatOut(beat);
            },
          }
        ).catch((e) => {
          console.error("[lesson] start stream failed:", e instanceof Error ? e.message : e);
          return null;
        });
        let seg = streamed?.segment;
        if (!plan || !seg?.beats.length) {
          if (all.length > 0) return await fail("讲师备课中断了，请重试。");
          // 流式没成：退回整段生成
          const r = await generateLessonStart({ context, imagesAllowed });
          if (!r) return await fail("讲师备课失败了，请稍后重试。");
          await openLesson(r.plan);
          seg = r.segment;
          for (const b of seg.beats) await beatOut(b);
        } else {
          for (const b of pending) await beatOut(b);
          console.log(`[lesson] start streamed: first line ${streamed?.firstLineMs}ms, total ${Date.now() - t0}ms`);
        }
        if (seg.check) seg.check = await verifyCheck(seg.check, seg.beats);
        await push(builder!.end(seg.check));
        lesson = {
          version: 3,
          plan: plan!,
          pageId,
          segments: [{ seg, actions: all, media }],
          complete: false,
          generatedAt: Date.now(),
        };
        await save(lesson);
        await runMedia(media);
        await send({ type: "response_complete", is_complete: true, status: "completed" });
      } catch (e) {
        await send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
