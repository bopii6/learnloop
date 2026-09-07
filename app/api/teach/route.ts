// POST /api/teach —— 白板教学 SSE 接口
// action: "start_teaching"（AI 产出 beat 脚本）| "chat"（学员打断提问）
import { NextRequest } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { runStartTeaching, runTeachChat, buildLectureContext } from "@/lib/agent/teach";
import { getProfile } from "@/lib/profile";
import { pagesForLecture } from "@/lib/textbook";
import type { WhiteboardEvent } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    courseId?: string;
    unitId?: string;
    lectureId?: string;
    message?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    context?: {
      segmentTitle?: string;
      boardOutline?: string;
      checkpointQuestion?: string;
      checkpointOptions?: string[];
    };
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (e: WhiteboardEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // 客户端已断开
        }
      };

      try {
        const state = await getCourseState(body.courseId || "");
        if (!state?.outline) {
          await send({ type: "error", message: "course not found" });
          controller.close();
          return;
        }

        const ctx = buildLectureContext(state.outline, body.unitId || "", body.lectureId || "");
        if (!ctx) {
          await send({ type: "error", message: "lecture not found" });
          controller.close();
          return;
        }

        // 讲解的事实来源。教材模式：按本节课挑最相关的教材页（词命中优先，
        // 全书均摊兜底——保证整本书都会被讲到）；摘录带页码，讲师会自然报页码。
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
          const relPages = pagesForLecture(
            state.textbook,
            ctx.lectureTitle,
            [...(ctx.keyConcepts || []), ctx.lectureSummary],
            lectureIdx,
            totalLectures,
            3
          );
          if (relPages.length > 0) {
            ctx.referenceMaterial = relPages
              .map((p) => `【教材《${state.textbook!.title}》第 ${p.page} 页】\n${p.text.slice(0, 1200)}`)
              .join("\n\n");
            grounded = true;
          }
        }
        if (!grounded && state.sources?.length && state.pageContents) {
          // 网页模式：建课时搜索并读取的网页正文。此前讲师只拿一行课节摘要，
          // 内容全靠模型现场编，是"讲解空泛、信息密度低"的直接原因。
          const blocks: string[] = [];
          for (const s of state.sources) {
            const text = state.pageContents[String(s.index)];
            if (!text) continue;
            blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1500)}`);
            if (blocks.length >= 4) break;
          }
          if (blocks.length > 0) {
            ctx.referenceMaterial = blocks.join("\n\n");
            grounded = true;
          }
        }
        // 本单元关键概念：给编剧当提纲，避免只从课节标题自由发挥
        const teachUnit = state.outline.units.find((u) => u.id === (body.unitId || ""));
        if (teachUnit?.key_concepts?.length) ctx.keyConcepts = teachUnit.key_concepts;

        // 跨课程学习者画像注入（有摘要用摘要，否则退化为画像全文）
        const profile = await getProfile();
        if (profile.summary) ctx.profileHint = profile.summary;
        if (profile.name) ctx.studentName = profile.name;

        if (body.action === "start_teaching") {
          await runStartTeaching({ ctx, emit: send });
          await send({ type: "done", sessionId: `${body.courseId}:${body.lectureId}` });
        } else if (body.action === "chat") {
          const message = (body.message || "").trim();
          if (!message) {
            await send({ type: "error", message: "empty message" });
            controller.close();
            return;
          }
          await runTeachChat({
            ctx,
            history: Array.isArray(body.history) ? body.history : [],
            message,
            context: body.context,
            emit: send,
          });
          await send({ type: "done", sessionId: `${body.courseId}:${body.lectureId}` });
        } else {
          await send({ type: "error", message: `unknown action: ${body.action}` });
        }
      } catch (e) {
        await send({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
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
