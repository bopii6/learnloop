// POST /api/teach —— 白板教学 SSE 接口
// action: "start_teaching"（AI 产出 beat 脚本）| "chat"（学员打断提问）
import { NextRequest } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { runStartTeaching, runTeachChat, buildLectureContext } from "@/lib/agent/teach";
import { getProfile } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";
import { CHAT_LIMIT_PER_LECTURE, COST_TEACHING_SESSION, refundCredits, trySpend } from "@/lib/credits";
import { storageMode } from "@/lib/storage";
import { bumpChatCount, loadTeachScript, saveTeachScript } from "@/lib/teach-cache";
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
            // 把本节课引用的原文页推给前端：白板页"对照原文"面板展示，学员看得到讲师所讲内容的出处
            await send({
              type: "doc_pages",
              docTitle: state.docName || `${state.textbook.title}.pdf`,
              pages: relPages.map((p) => ({ page: p.page, text: p.text.slice(0, 1600) })),
            });
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

        // 跨课程学习者画像注入（按登录用户隔离；有摘要用摘要，否则退化为画像全文）
        const me = await userFromCookieHeader(req.headers.get("cookie"));
        const profile = await getProfile(me?.id);
        if (profile.summary) ctx.profileHint = profile.summary;
        if (profile.name) ctx.studentName = profile.name;

        if (body.action === "start_teaching") {
          // 讲稿缓存命中 = 复习：直接回放缓存事件，不生成、不扣积分。
          // （缓存按用户隔离：开场 beat 会点名学员名字，不能全局共享）
          const cached = await loadTeachScript(body.courseId || "", body.unitId || "", body.lectureId || "", me?.id);
          if (cached) {
            for (const e of cached.events) await send(e);
            await send({ type: "done", sessionId: `${body.courseId}:${body.lectureId}` });
            controller.close();
            return;
          }

          // 积分门卫：首次开讲 = 整节课讲稿生成（10+ 次 LLM 调用），课堂里最贵的一步。
          // 未登录：本地自用放行；公网部署（R2 模式）必须登录。
          if (!me && storageMode === "r2") {
            await send({ type: "error", message: "请先登录后再进入课堂（课堂消耗积分，与账号绑定）" });
            controller.close();
            return;
          }
          let creditsSpent = false;
          if (me) {
            const spend = await trySpend(me.id, COST_TEACHING_SESSION, `白板课堂：${(ctx.lectureTitle || "").slice(0, 24)}`);
            if (!spend.ok) {
              await send({ type: "credits_block", balance: spend.balance, need: COST_TEACHING_SESSION, reason: "开启白板课堂" });
              controller.close();
              return;
            }
            creditsSpent = true;
          }
          try {
            // 捕获事件流：讲稿生成一次就存档，复习时回放（见上方缓存命中分支）
            const captured: WhiteboardEvent[] = [];
            const capturingSend = async (e: WhiteboardEvent) => {
              captured.push(e);
              await send(e);
            };
            await runStartTeaching({ ctx, emit: capturingSend });
            try {
              await saveTeachScript(body.courseId || "", body.unitId || "", body.lectureId || "", me?.id, captured);
            } catch {
              // 缓存写入失败不影响本次课堂（下次复习会重新生成并再扣 1 分，可接受）
            }
            await send({ type: "done", sessionId: `${body.courseId}:${body.lectureId}` });
          } catch (e) {
            // 开讲失败退回积分（课没讲成不收费）
            if (creditsSpent && me) await refundCredits(me.id, COST_TEACHING_SESSION, "课堂启动失败退回");
            throw e;
          }
        } else if (body.action === "chat") {
          const message = (body.message || "").trim();
          if (!message) {
            await send({ type: "error", message: "empty message" });
            controller.close();
            return;
          }
          // 追问不扣积分（单条成本极低），但有每节课上限防滥用
          const chatGuard = await bumpChatCount(me?.id, body.courseId || "", body.unitId || "", body.lectureId || "", CHAT_LIMIT_PER_LECTURE);
          if (!chatGuard.ok) {
            await send({ type: "error", message: `本节课的提问已达上限（${CHAT_LIMIT_PER_LECTURE} 条）。换个课节继续，或明天再来复习巩固。` });
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
