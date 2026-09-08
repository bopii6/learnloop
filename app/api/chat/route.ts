// POST /api/chat —— SSE 流式聊天
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { runAgent, generateTitle } from "@/lib/agent/pipeline";
import {
  appendMessage,
  canAccess,
  createConversation,
  getConversation,
  setTitle,
} from "@/lib/store";
import { userFromCookieHeader } from "@/lib/auth";
import { CHAT_DAILY_LIMIT, consumeDailyQuota, drainToUsage, ipSubject, logOpsError, recordUsage } from "@/lib/ops";
import type { AgentEvent } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { conversationId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }
  const message = (body.message || "").trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "empty message" }), { status: 400 });
  }

  // 拿会话（没有就建）；有主会话仅本人可写
  const me = await userFromCookieHeader(req.headers.get("cookie"));

  // 每日软上限（登录按账号、匿名按 IP）：不收费，只防脚本党把 LLM 账单当免费算力
  const usageSubject = me?.id || ipSubject(req);
  const quota = await consumeDailyQuota(usageSubject, "chat", 1, CHAT_DAILY_LIMIT);
  if (!quota.ok) {
    return new Response(
      JSON.stringify({
        error: `今天的对话次数已达上限（${CHAT_DAILY_LIMIT} 次/日），明天再来。课程生成与听课不受影响。`,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  let conv = body.conversationId
    ? await getConversation(body.conversationId)
    : null;
  if (conv && !canAccess(conv, me?.id)) conv = null;
  if (!conv) conv = await createConversation(me?.id);

  const isFirstExchange = conv.messages.length === 0;

  // 用户消息先落盘
  await appendMessage(conv.id, {
    id: randomUUID(),
    role: "user",
    content: message,
    createdAt: Date.now(),
  });

  const history = conv.messages.slice(-8).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const encoder = new TextEncoder();
  const convId = conv.id;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // 客户端已断开
        }
      };
      try {
        const result = await runAgent({ message, history, emit: send });

        if (result.clarified) {
          // 澄清模式：不写 assistant 消息，前端拿 clarify 事件渲染卡片
          await send({ type: "done", conversationId: convId });
          controller.close();
          return;
        }

        // 助手消息落盘
        await appendMessage(convId, {
          id: randomUUID(),
          role: "assistant",
          content: result.answer,
          sources: result.sources,
          stages: result.stages,
          createdAt: Date.now(),
        });

        // 首轮自动生成标题
        let title: string | undefined;
        if (isFirstExchange) {
          title = await generateTitle(message, result.answer);
          await setTitle(convId, title);
        }

        await send({ type: "done", conversationId: convId, title });
      } catch (e) {
        await logOpsError({ kind: "chat", userId: me?.id, detail: e instanceof Error ? e.message : String(e) }).catch(() => {});
        await send({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        // 本次请求烧掉的 LLM token 落到当日用量文件（按 token 计费的对账地基）
        await drainToUsage(usageSubject).catch(() => {});
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
