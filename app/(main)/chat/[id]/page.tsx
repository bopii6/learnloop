"use client";

// /chat/[id] —— 继续某个对话。可刷新、可收藏、可从侧栏直达。
import { use, useEffect, useState } from "react";
import type { StoredMessage } from "@/types";
import { ChatView, chatCache } from "@/components/ChatView";

export default function ChatDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = use(params).id;
  const [messages, setMessages] = useState<StoredMessage[] | null>(() => chatCache.get(id) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    // 会话内刚创建的对话已在缓存里，直接还原不重拉
    const cached = chatCache.get(id);
    setMessages(cached ?? null);
    if (cached) return;
    let alive = true;
    fetch(`/api/conversations/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "对话不存在或已删除" : `加载失败 (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (alive) setMessages(d.conversation.messages || []);
      })
      .catch((e) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setMessages([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (messages === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-[14px] text-ink-soft">{error}</div>
      </div>
    );
  }

  return <ChatView key={id} conversationId={id} initialMessages={messages} />;
}
