"use client";

// 对话视图：从旧首页整体迁出，独立承载 /chat（新对话）与 /chat/[id]（继续追问）。
// 新对话创建成功后 replace 到 /chat/[id]，让 URL 与会话一一对应。
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentEvent, ClarifyQuestion, SourceItem, StoredMessage } from "@/types";
import { MessageItem } from "./MessageItem";
import { ClarifyCard } from "./ClarifyCard";
import { LiveTimeline, LiveStage } from "./StageTimeline";
import { SourcesStrip } from "./SourcesStrip";
import { consumeSse } from "@/lib/sse";

const STARTERS = [
  "系统讲解 RAG 的原理：检索、重排、生成各阶段都在做什么",
  "解释一下 Transformer 里的自注意力机制，用直觉+公式",
  "对比 React Server Components 和传统 SSR 的区别",
  "什么是 MCP 协议？它和 Function Calling 是什么关系",
];

// 会话内消息缓存：刚创建的对话跳转 /chat/[id] 时页面组件会重挂载，
// 先把消息放进这里，目标页首帧即可还原，避免「消息闪空」。
export const chatCache = new Map<string, StoredMessage[]>();

export function ChatView({
  conversationId,
  initialMessages,
}: {
  conversationId: string | null;
  initialMessages?: StoredMessage[] | null;
}) {
  const router = useRouter();
  const [currentId, setCurrentId] = useState<string | null>(conversationId);
  const [messages, setMessages] = useState<StoredMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveStages, setLiveStages] = useState<LiveStage[]>([]);
  const [liveSources, setLiveSources] = useState<SourceItem[]>([]);
  const [draft, setDraft] = useState("");
  const [clarify, setClarify] = useState<ClarifyQuestion[] | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const [highlight, setHighlight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<StoredMessage[]>([]);
  messagesRef.current = messages;

  // 离开页面对话流还在跑时，中止请求避免对已卸载组件 setState
  useEffect(() => () => abortRef.current?.abort(), []);

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const send = useCallback(
    async (rawMessage: string) => {
      const message = rawMessage.trim();
      if (!message || streaming) return;
      setError(null);
      setClarify(null);
      setStreaming(true);
      setLiveStages([]);
      setLiveSources([]);
      setDraft("");
      setLastQuestion(message);

      // 乐观插入用户消息
      const userMsg: StoredMessage = {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: message,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      scrollBottom();

      const controller = new AbortController();
      abortRef.current = controller;

      // 流式累积
      let stages: LiveStage[] = [];
      let sources: SourceItem[] = [];
      let answer = "";
      let clarified = false;
      // done 事件带回的新对话 id：必须在闭包内传递。
      // setState 后要等下一次渲染 ref 才可见，而 finally 紧跟着执行，读 ref 会拿到旧值。
      let createdConvId: string | null = null;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: currentId, message }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          // 429/401 等业务拒绝带 JSON 错误说明，优先展示后端给的人话
          const d = await res.json().catch(() => null);
          throw new Error(d?.error || `请求失败 (${res.status})`);
        }

        const handle = (e: AgentEvent) => {
          if (e.type === "stage") {
            if (e.status === "start") {
              // 同名阶段更新 detail，否则追加
              const idx = stages.findIndex(
                (s) => s.name === e.name && s.status === "active"
              );
              if (idx >= 0) {
                stages[idx] = { ...stages[idx], detail: e.detail };
              } else {
                stages.push({
                  name: e.name,
                  label: e.label,
                  detail: e.detail,
                  status: "active",
                });
              }
            } else {
              const idx = stages.map((s) => s.name).lastIndexOf(e.name);
              if (idx >= 0) stages[idx] = { ...stages[idx], status: "done", detail: e.detail ?? stages[idx].detail };
            }
            setLiveStages([...stages]);
            scrollBottom();
          } else if (e.type === "sources") {
            sources = e.items;
            setLiveSources(e.items);
          } else if (e.type === "token") {
            answer += e.text;
            setDraft(answer);
            scrollBottom();
          } else if (e.type === "clarify") {
            clarified = true;
            setClarify(e.questions);
            setStreaming(false);
            scrollBottom();
          } else if (e.type === "done") {
            if (!currentId && e.conversationId) {
              createdConvId = e.conversationId;
              setCurrentId(e.conversationId);
            }
            window.dispatchEvent(new Event("ll:conversations-changed"));
          } else if (e.type === "error") {
            setError(e.message);
          }
        };

        await consumeSse<AgentEvent>(res, handle);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        if (!clarified && answer) {
          const assistantMsg: StoredMessage = {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: answer,
            sources,
            stages: stages.map(({ name, label, detail }) => ({ name, label, detail })),
            createdAt: Date.now(),
          };
          const finalMessages = [...messagesRef.current, assistantMsg];
          setMessages(finalMessages);
          setDraft("");
          setLiveStages([]);
          setLiveSources([]);
          scrollBottom();
          // 新对话落地：写缓存再替换 URL，目标页首帧从缓存还原，无闪空
          if (!currentId && createdConvId) {
            chatCache.set(createdConvId, finalMessages);
            router.replace(`/chat/${createdConvId}`);
          }
        }
      }
    },
    [currentId, streaming, router]
  );

  const stop = () => {
    abortRef.current?.abort();
  };

  const onClarifySubmit = (summary: string) => {
    const combined = `${lastQuestion}\n\n（我的补充背景：${summary}）`;
    send(combined);
  };

  const onClarifySkip = () => {
    send(`${lastQuestion}\n\n（我跳过补充，请按通用读者直接回答）`);
  };

  const onCite = (index: number) => {
    setHighlight(index);
    const el = document.getElementById(`src-${index}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    setTimeout(() => setHighlight(null), 2500);
  };

  const empty = messages.length === 0 && !streaming && !clarify;

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
          {empty && (
            <div className="pt-20 text-center fade-up">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#e7e5dc] bg-white px-3.5 py-1 text-[11.5px] text-ink-soft mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                全网搜索 · 画像个性化 · 白板课堂
              </div>
              <div className="text-[30px] font-bold leading-tight mb-3">
                问点什么，
                <span className="text-accent">让它去替你搜、替你读</span>
              </div>
              <div className="text-[14px] text-ink-soft mb-10">
                搜索过程全程可见，回答带真实来源引用，还能一键变成白板课程
              </div>
              <div className="grid gap-2.5 max-w-xl mx-auto text-left">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="group rounded-xl border border-[#e7e5dc] bg-white px-4 py-3 text-[13.5px] text-ink transition-all text-left flex items-center gap-3 hover:-translate-y-px hover:border-accent/50 hover:shadow-sm"
                  >
                    <span className="text-accent/70 group-hover:text-accent transition-colors">✦</span>
                    <span className="flex-1">{s}</span>
                    <span className="text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <MessageItem key={m.id} msg={m} onCite={onCite} highlight={highlight} />
          ))}

          {clarify && (
            <ClarifyCard
              questions={clarify}
              onSubmit={onClarifySubmit}
              onSkip={onClarifySkip}
            />
          )}

          {streaming && (
            <div className="space-y-4">
              {liveStages.length > 0 && <LiveTimeline stages={liveStages} />}
              {draft && (
                <div className="fade-up">
                  <MessageItem
                    msg={{
                      id: "draft",
                      role: "assistant",
                      content: draft,
                      sources: [],
                      createdAt: Date.now(),
                    }}
                    onCite={onCite}
                    highlight={highlight}
                  />
                </div>
              )}
              {liveSources.length > 0 && !draft && (
                <SourcesStrip sources={liveSources} highlight={highlight} />
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              出错了：{error}
              {error.includes("LLM") || error.includes("401") || error.includes("apikey") ? (
                <div className="mt-1 text-red-500">
                  检查 .env 里的 LLM_API_KEY 是否已填
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[#e7e5dc] bg-paper">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <div className="rounded-2xl border border-[#d3d1c7] bg-white shadow-sm focus-within:border-accent transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="问一个你想真正搞懂的问题…（Enter 发送，Shift+Enter 换行）"
              rows={2}
              className="w-full resize-none rounded-t-2xl px-4 pt-3 pb-1 text-[14px] outline-none bg-transparent"
            />
            <div className="flex items-center justify-between px-3 pb-2.5">
              <span className="text-[11px] text-ink-faint">
                {streaming ? "Agent 正在工作…" : "深度搜索 · 带引用回答"}
              </span>
              {streaming ? (
                <button
                  onClick={stop}
                  className="rounded-lg border border-[#d3d1c7] px-3.5 py-1.5 text-[12.5px] text-ink-soft hover:border-red-300 hover:text-red-600 transition-colors"
                >
                  ■ 停止
                </button>
              ) : (
                <button
                  onClick={() => send(input)}
                  disabled={!input.trim()}
                  className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] text-white font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  发送 ↑
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
