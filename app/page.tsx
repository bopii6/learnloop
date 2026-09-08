"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  ClarifyQuestion,
  ConversationMeta,
  CourseOutline,
  SourceItem,
  StoredMessage,
} from "@/types";
import { Sidebar } from "@/components/Sidebar";
import { MessageItem } from "@/components/MessageItem";
import { ClarifyCard } from "@/components/ClarifyCard";
import { LiveTimeline, LiveStage } from "@/components/StageTimeline";
import { SourcesStrip } from "@/components/SourcesStrip";
import { CourseGenerator } from "@/components/CourseGenerator";
import { CourseOutlineView } from "@/components/CourseOutlineView";
import { MarketView } from "@/components/MarketView";
import { CourseRecordsView } from "@/components/CourseRecordsView";
import { WrappedView } from "@/components/WrappedView";
import { AuthModal } from "@/components/AuthModal";
import { consumeSse } from "@/lib/sse";

const STARTERS = [
  "系统讲解 RAG 的原理：检索、重排、生成各阶段都在做什么",
  "解释一下 Transformer 里的自注意力机制，用直觉+公式",
  "对比 React Server Components 和传统 SSR 的区别",
  "什么是 MCP 协议？它和 Function Calling 是什么关系",
];

type HomeMode = "course" | "chat" | "market" | "records" | "wrapped";

export default function Home() {
  // 产品只有一个入口：首页即课程生成。问答/闲聊由意图门卫在入口内消化，
  // chat 视图只承载历史对话的继续追问。
  const [mode, setMode] = useState<HomeMode>("course");
  const [courseOutline, setCourseOutline] = useState<CourseOutline | null>(null);
  const [courseId, setCourseId] = useState<string>("");
  const [pastCourses, setPastCourses] = useState<{ id: string; title: string }[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveStages, setLiveStages] = useState<LiveStage[]>([]);
  const [liveSources, setLiveSources] = useState<SourceItem[]>([]);
  const [draft, setDraft] = useState("");
  const [clarify, setClarify] = useState<ClarifyQuestion[] | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const [highlight, setHighlight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 登录态：课程记录/教材/集市条目按归属过滤
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const refreshList = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(data.conversations || []);
  }, []);

  // 侧栏"继续学习"：已生成课程列表
  const refreshCourses = useCallback(async () => {
    try {
      const res = await fetch("/api/courses");
      if (res.ok) {
        const d = await res.json();
        setPastCourses(d.courses || []);
      }
    } catch {
      // 静默
    }
  }, []);

  useEffect(() => {
    refreshList();
    refreshCourses();
  }, [refreshList, refreshCourses]);

  // 登录态拉取 + 积分余额（扣积分的流程完成后发 ll:credits-changed 事件，侧栏数字随之刷新）
  const refreshMe = useCallback(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setUser(d?.user || null);
        setCredits(typeof d?.credits === "number" ? d.credits : null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    const onCreditsChanged = () => refreshMe();
    window.addEventListener("ll:credits-changed", onCreditsChanged);
    return () => window.removeEventListener("ll:credits-changed", onCreditsChanged);
  }, [refreshMe]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/me", { method: "POST" }).catch(() => {});
    setUser(null);
    refreshCourses();
    refreshList();
  }, [refreshCourses, refreshList]);

  // 从侧栏打开已有课程
  const openPastCourse = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/courses/${id}`);
      if (!res.ok) return;
      const d = await res.json();
      setCourseId(d.course.id);
      setCourseOutline(d.course.outline);
      setMode("course");
    } catch {
      // 忽略
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setCurrentId(id);
    setMessages(data.conversation.messages || []);
    setMode("chat"); // 历史对话在 chat 视图里继续追问
    setClarify(null);
    setDraft("");
    setLiveStages([]);
    setLiveSources([]);
    setError(null);
    scrollBottom();
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setCurrentId(null);
    setMessages([]);
    setClarify(null);
    setDraft("");
    setLiveStages([]);
    setLiveSources([]);
    setError(null);
    setStreaming(false);
  }, []);

  const deleteConv = useCallback(
    async (id: string) => {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (id === currentId) newChat();
      refreshList();
    },
    [currentId, newChat, refreshList]
  );

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

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: currentId, message }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);

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
            if (e.title) {
              setConversations((prev) =>
                prev.map((c) => (c.id === e.conversationId ? { ...c, title: e.title! } : c))
              );
            }
            if (!currentId && e.conversationId) setCurrentId(e.conversationId);
            refreshList();
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
          setMessages((prev) => [...prev, assistantMsg]);
          setDraft("");
          setLiveStages([]);
          setLiveSources([]);
          scrollBottom();
        }
      }
    },
    [currentId, streaming, refreshList]
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

  const handleCourseComplete = (id: string, title: string, outline: CourseOutline) => {
    setCourseId(id);
    setCourseOutline(outline);
  };

  return (
    <div className="flex h-screen home-bg">
      <Sidebar
        mode={mode}
        onMode={(m) => {
          setMode(m);
          if (m === "course") {
            // 首页 = 新的课程入口；打开具体课程走 openPastCourse
            setCourseOutline(null);
            setCourseId("");
          }
        }}
        courses={pastCourses}
        onOpenCourse={openPastCourse}
        conversations={conversations}
        currentId={currentId}
        onSelect={loadConversation}
        onDelete={deleteConv}
        user={user}
        onLogin={() => setAuthOpen(true)}
        onLogout={() => void logout()}
        credits={credits}
      />

      <main className="flex-1 flex flex-col min-w-0">
        {/* 内容区 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {mode === "market" ? (
            <MarketView
              onOpenCourse={(id) => {
                setMode("course");
                void openPastCourse(id);
              }}
              onGoHome={() => setMode("course")}
            />
          ) : mode === "wrapped" ? (
            <WrappedView />
          ) : mode === "records" ? (
            <CourseRecordsView
              onOpenCourse={(id) => {
                setMode("course");
                void openPastCourse(id);
              }}
              onGoHome={() => setMode("course")}
            />
          ) : mode === "course" ? (
            courseOutline ? (
              <CourseOutlineView outline={courseOutline} courseId={courseId} />
            ) : (
              <CourseGenerator onComplete={handleCourseComplete} />
            )
          ) : (
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
                      className="group rounded-xl border border-[#e7e5dc] bg-white px-4 py-3 text-[13.5px] text-ink hover:border-accent transition-colors text-left flex items-center gap-3"
                    >
                      <span className="text-accent opacity-60 group-hover:opacity-100 transition-opacity">▸</span>
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
          )}
        </div>

        {/* 输入区（仅 chat 模式显示） */}
        {mode === "chat" && (
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
        )}
      </main>

      {/* 登录弹窗 */}
      {authOpen && (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onLoggedIn={(u) => {
            setUser(u);
            setAuthOpen(false);
            // 登录后课程列表与积分余额按归属变化，刷新
            refreshMe();
            refreshCourses();
            refreshList();
          }}
        />
      )}
    </div>
  );
}
