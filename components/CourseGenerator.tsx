"use client";

// 课程生成：单页滚动堆叠流（对齐 Hyperknow 原版）
// 任务气泡悬顶 → 搜索 → 澄清 → 蓝图 → 生成 → 就绪，完成阶段保留在页面上方
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  CourseEvent,
  CourseBlueprint,
  CourseOutline,
  ClarifyQuestion,
  SourceItem,
} from "@/types";
import { BlueprintEditor } from "./BlueprintEditor";

interface CourseGeneratorProps {
  onComplete?: (courseId: string, title: string, outline: CourseOutline) => void;
}

interface AnsweredRound {
  question: ClarifyQuestion;
  selected: string[];
  freeText?: string;
}

const TIPS = [
  "上传你自己的文件，用你的资料丰富任意课程内容。",
  "项目卡住了？点击右上角的助手问问看。",
  "学完一门课程了吗？别忘了去练习巩固所学的内容。",
  "课节越深，越建议先看「建立直觉」再进「公式推导」。",
];

const SEARCH_STATUS = ["正在筛选权威来源", "正在阅读网页正文", "正在对比学习路径", "正在剔除低质内容"];
const CLARIFY_STATUS = ["正在构思整体框架", "翻开了书本", "正在对照资料要点", "正在推敲下一个问题"];

export function CourseGenerator({ onComplete }: CourseGeneratorProps) {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<
    "input" | "search" | "clarify" | "blueprint" | "outline" | "done"
  >("input");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [searchQueries, setSearchQueries] = useState<string[]>([]);
  const [showAllSources, setShowAllSources] = useState(false);
  const [question, setQuestion] = useState<ClarifyQuestion | null>(null);
  const [round, setRound] = useState(1);
  const [totalRounds, setTotalRounds] = useState(4);
  const [answeredRounds, setAnsweredRounds] = useState<AnsweredRound[]>([]);
  const [blueprint, setBlueprint] = useState<CourseBlueprint | null>(null);
  const [editedBlueprint, setEditedBlueprint] = useState<CourseBlueprint | null>(null);
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [courseId, setCourseId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [customAnswer, setCustomAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [designNotes, setDesignNotes] = useState<string[]>([]);
  const [chatReply, setChatReply] = useState<string | null>(null);
  // 入口问答回路：真问题不建课，直接在输入页给出带引用的回答
  const [qaPending, setQaPending] = useState<string | null>(null);
  const [qaResult, setQaResult] = useState<{ reply: string; sources: SourceItem[] } | null>(null);
  // 教材模式：上传 PDF 后对着课本建课（蓝图镜像目录，讲解标页码）
  const [textbookId, setTextbookId] = useState("");
  const [textbookTitle, setTextbookTitle] = useState("");
  const [textbookPages, setTextbookPages] = useState(0);
  const [textbookOcr, setTextbookOcr] = useState(false);
  const [textbookNotice, setTextbookNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [courseSource, setCourseSource] = useState<"自学" | "学校同步">("自学");
  const [statusLine, setStatusLine] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const outlineRef = useRef<CourseOutline | null>(null);

  // 学习者画像（跨课程沉淀）：首页只留一行提示，细节藏在悬停里
  const [profile, setProfile] = useState<{ name?: string; summary: string; facts: { question: string; answer: string }[] } | null>(null);
  useEffect(() => {
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.profile) setProfile(d.profile);
      })
      .catch(() => {});
  }, []);

  // 运行中阶段的动态状态文案（"翻开了书本"式的推理感）
  useEffect(() => {
    if (!loading || step === "input") return;
    const t = window.setInterval(() => setStatusLine((s) => s + 1), 3200);
    return () => window.clearInterval(t);
  }, [loading, step]);

  const handleEvent = useCallback((e: CourseEvent) => {
    if (e.type === "stage") {
      if (e.name === "search") setStep((s) => (s === "input" ? "search" : s));
    } else if (e.type === "sources") {
      setSources(e.items);
    } else if (e.type === "clarify_round") {
      setQuestion(e.question);
      setRound(e.round);
      setTotalRounds(e.total_rounds);
      setCourseId(e.courseId);
      setStep("clarify");
      setSelectedOptions([]);
      setCustomAnswer("");
      setLoading(false);
    } else if (e.type === "blueprint") {
      setBlueprint(e.data);
      setEditedBlueprint(e.data);
      setStep("blueprint");
      setLoading(false);
      setShowFeedback(false);
    } else if (e.type === "design_notes") {
      setDesignNotes(e.notes);
    } else if (e.type === "search_queries") {
      setSearchQueries(e.queries);
    } else if (e.type === "chitchat_reply") {
      // 意图门卫：闲聊不建课，退回输入页并给出对话回复
      setQaPending(null);
      setChatReply(e.reply);
      setStep("input");
      setLoading(false);
    } else if (e.type === "qa_status") {
      // 问答回路进度：输入页显示"正在查资料"的推理感状态
      setQaPending(e.text);
    } else if (e.type === "qa_reply") {
      setQaPending(null);
      setQaResult({ reply: e.reply, sources: e.sources });
      setStep("input");
      setLoading(false);
    } else if (e.type === "outline_progress") {
      setProgress({ current: e.current, total: e.total });
    } else if (e.type === "outline") {
      setOutline(e.outline);
      outlineRef.current = e.outline;
    } else if (e.type === "done") {
      setStep("done");
      setLoading(false);
      setProgress(null);
    } else if (e.type === "error") {
      setError(e.message);
      setLoading(false);
    }
  }, []);

  /** 发起一次 SSE 请求并逐帧消费事件 */
  const streamRequest = useCallback(
    async (body: Record<string, unknown>) => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/course", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              handleEvent(JSON.parse(line.slice(5).trim()));
            } catch {
              // 忽略坏帧
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    },
    [handleEvent]
  );

  /** 上传教材 PDF：抽文字 + 提目录，之后建课全程以教材为准 */
  const uploadTextbook = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/textbook", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `上传失败 (${res.status})`);
      setTextbookId(d.id);
      setTextbookTitle(d.title);
      setTextbookPages(d.textPages ?? d.pageCount ?? 0);
      setTextbookOcr(Boolean(d.ocr));
      setTextbookNotice(d.notice || null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }, []);

  const startGeneration = useCallback(async () => {
    if ((!query.trim() && !textbookId) || loading) return;
    setLoading(true);
    setError(null);
    setStep("search");
    setSources([]);
    setSearchQueries([]);
    setQuestion(null);
    setBlueprint(null);
    setEditedBlueprint(null);
    setOutline(null);
    outlineRef.current = null;
    setAnsweredRounds([]);
    setProgress(null);
    setDesignNotes([]);
    setChatReply(null);
    setQaPending(null);
    setQaResult(null);
    await streamRequest({
      action: "start",
      query: query.trim() || `系统学习《${textbookTitle}》教材`,
      courseSource,
      textbookId: textbookId || undefined,
    });
  }, [query, textbookId, textbookTitle, loading, streamRequest, courseSource]);

  const submitAnswer = useCallback(
    async (answerText: string) => {
      if (!question || !courseId || loading || !answerText.trim()) return;
      setLoading(true);
      // 保存整轮快照（问题+选项+所选），堆叠视图按原版样式完整回显
      setAnsweredRounds((prev) => [
        ...prev,
        { question, selected: [...selectedOptions], freeText: answerText },
      ]);
      setQuestion(null);
      setSelectedOptions([]);
      setCustomAnswer("");
      await streamRequest({ action: "answer", courseId, answer: answerText });
    },
    [question, courseId, loading, streamRequest, selectedOptions]
  );

  const confirmBlueprint = useCallback(async () => {
    if (!courseId || loading) return;
    setLoading(true);
    setStep("outline");
    setProgress(null);
    // 如果用户编辑过蓝图，把编辑后的版本发给后端
    const body: Record<string, unknown> = { action: "generate", courseId };
    if (editedBlueprint && editedBlueprint !== blueprint) {
      body.blueprint = editedBlueprint;
    }
    await streamRequest(body);
  }, [courseId, loading, streamRequest, editedBlueprint, blueprint]);

  const submitFeedback = useCallback(async () => {
    if (!courseId || loading || !feedback.trim()) return;
    setLoading(true);
    await streamRequest({ action: "blueprint_feedback", courseId, feedback: feedback.trim() });
    setFeedback("");
  }, [courseId, loading, feedback, streamRequest]);

  const cancelGeneration = useCallback(() => {
    abortRef.current?.abort();
    setStep("input");
    setLoading(false);
    setQuestion(null);
    setProgress(null);
  }, []);

  const toggleOption = (label: string) => {
    if (!question) return;
    if (question.multi) {
      setSelectedOptions((prev) =>
        prev.includes(label) ? prev.filter((o) => o !== label) : [...prev, label]
      );
    } else {
      setSelectedOptions([label]);
    }
  };

  // ---- 内联阶段标题（原版同款：蓝粗体 ｜ 第 N 步，共 4 步 ✓/…） ----
  const StageHeader = ({ title, n, state }: { title: string; n: number; state: "running" | "done" }) => (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="text-[14.5px] font-bold text-[#1d4ed8]">{title}</span>
      <span className="text-ink-faint text-[12.5px]">｜</span>
      <span className="text-[12.5px] text-ink-soft">第 {n} 步，共 4 步</span>
      {state === "done" ? (
        <span className="text-accent text-[13px]">✓</span>
      ) : (
        <span className="text-[13px] text-[#1d4ed8] animate-pulse">…</span>
      )}
    </div>
  );

  // ---- 动态状态行（"翻开了书本"式） ----
  const LiveStatus = ({ pool }: { pool: string[] }) => {
    const text = pool[statusLine % pool.length];
    return (
      <div className="flex items-center gap-2 text-[12px] text-ink-faint mb-3">
        <span className="stage-spinner inline-block shrink-0" style={{ width: 11, height: 11 }}>
        </span>
        <span>{text}</span>
      </div>
    );
  };

  // ---- 输入页（原版首页：hero + 输入卡 + 来源radio + 示例chip + 继续学习） ----
  if (step === "input") {
    return (
      <div className="max-w-2xl mx-auto pt-16 px-6">
        <div className="text-center mb-8">
          <div className="text-[26px] font-semibold mb-2">一句话，生成一门 12 小时学完的系统课程</div>
          <div className="text-[14px] text-ink-soft">把一学期的内容压缩成讲解 + 板书 + 课后练习，先过关，再拔高</div>
        </div>
        {qaPending && (
          <div className="mb-4 rounded-2xl border border-[#e7e5dc] bg-white px-4 py-3.5 text-[13.5px] text-ink-soft fade-up shadow-sm flex items-center gap-2">
            <span className="stage-spinner inline-block shrink-0" style={{ width: 11, height: 11 }} />
            {qaPending}
          </div>
        )}
        {qaResult && (
          <div className="mb-4 rounded-2xl border border-[#e7e5dc] bg-white px-4 py-3.5 text-[13.5px] text-ink leading-relaxed fade-up shadow-sm">
            <div className="text-[10.5px] text-ink-faint mb-1 tracking-wide">LearnLoop · 直接回答</div>
            <div className="prose-course">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{qaResult.reply}</ReactMarkdown>
            </div>
            {qaResult.sources.length > 0 && (
              <div className="mt-3 pt-2.5 border-t border-[#f1efe8] flex flex-wrap gap-1.5">
                {qaResult.sources.map((s) => (
                  <a
                    key={s.index}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    title={s.title}
                    className="rounded-full bg-[#f1efe8] px-2.5 py-0.5 text-[10.5px] text-ink-soft hover:text-accent transition-colors max-w-[220px] truncate"
                  >
                    [{s.index}] {s.domain}
                  </a>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-ink-faint">想系统学透？把主题输在下面，我来打造课程</span>
              <button
                onClick={() => setQaResult(null)}
                className="text-[11.5px] text-ink-faint hover:text-accent"
              >
                知道了
              </button>
            </div>
          </div>
        )}
        {chatReply && (
          <div className="mb-4 rounded-2xl border border-[#e7e5dc] bg-white px-4 py-3.5 text-[13.5px] text-ink leading-relaxed fade-up shadow-sm">
            <div className="text-[10.5px] text-ink-faint mb-1 tracking-wide">LearnLoop</div>
            {chatReply}
            <button
              onClick={() => setChatReply(null)}
              className="ml-2 text-[11.5px] text-ink-faint hover:text-accent"
            >
              知道了
            </button>
          </div>
        )}
        {profile && (
          <div
            className="mb-4 flex items-center justify-center gap-1.5 text-[12px] text-ink-faint"
            title={profile.summary || profile.facts.map((f) => `${f.question}：${f.answer}`).join("；")}
          >
            <span className="text-accent">🎯</span>
            <span className="truncate max-w-[520px]">
              已按你的画像定制课程：
              {profile.summary ? profile.summary.slice(0, 42) + "…" : (profile.facts[profile.facts.length - 1]?.answer || "").slice(0, 42)}
            </span>
          </div>
        )}
        <div className="rounded-2xl border border-[#d3d1c7] bg-white shadow-sm p-6">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (query.trim() || textbookId)) {
                e.preventDefault();
                void startGeneration();
              }
            }}
            placeholder={textbookId ? `想怎么学《${textbookTitle}》？可留空直接生成，如：两周过完这本书` : "输入你想系统学习的主题，如：系统讲解 LLM Agent 的 Tool Use 设计模式"}
            rows={3}
            className="w-full resize-none rounded-xl border border-[#e7e5dc] px-4 py-3 text-[14px] outline-none focus:border-accent"
          />
          {/* 教材上传：上传后蓝图镜像教材目录，讲解标注页码 */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadTextbook(f);
                e.target.value = "";
              }}
            />
            {textbookId ? (
              <>
                <span className="inline-flex items-center gap-2 rounded-full bg-accent-soft border border-accent/30 px-3 py-1 text-[12px] text-accent">
                  📖 《{textbookTitle}》· {textbookPages} 页文本{textbookOcr ? " · OCR" : ""}
                  <button
                    onClick={() => {
                      setTextbookId("");
                      setTextbookTitle("");
                      setTextbookPages(0);
                      setTextbookOcr(false);
                      setTextbookNotice(null);
                    }}
                    className="hover:text-red-500"
                    title="移除教材"
                  >
                    ×
                  </button>
                </span>
                {textbookNotice && (
                  <span className="text-[11px] text-ink-faint leading-snug">{textbookNotice}</span>
                )}
              </>
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="rounded-full border border-[#e7e5dc] px-3 py-1 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
              >
                {uploading ? "📖 教材解析中…（扫描版会自动 OCR，较慢）" : "📎 上传教材 PDF，对着课本讲"}
              </button>
            )}
            {uploadError && <span className="text-[11.5px] text-red-600">{uploadError}</span>}
          </div>
          <div className="mt-4 flex items-center justify-between">
            {/* 课程来源（原版同款 radio）：随任务传给澄清环节 */}
            <div className="flex items-center gap-4">
              {(["自学", "学校同步"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setCourseSource(m)}
                  className="flex items-center gap-1.5 text-[12.5px] transition-colors"
                >
                  <span
                    className={`inline-flex w-3.5 h-3.5 rounded-full border-2 items-center justify-center ${
                      courseSource === m ? "border-accent" : "border-[#d3d1c7]"
                    }`}
                  >
                    {courseSource === m && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className={courseSource === m ? "text-ink font-medium" : "text-ink-soft"}>{m}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => void startGeneration()}
              disabled={(!query.trim() && !textbookId) || loading}
              className="rounded-full bg-accent px-6 py-2.5 text-[13.5px] text-white font-medium hover:opacity-90 disabled:opacity-40"
            >
              {loading ? "生成中..." : "开始打造课程 →"}
            </button>
          </div>
        </div>
        {/* 示例主题 chip（点击直接填入） */}
        <div className="mt-3 flex flex-wrap gap-2">
          {["LLM Agent 的 Tool Use 设计模式", "雅思 vs 托福备考策略", "Python 数据分析入门"].map((s) => (
            <button
              key={s}
              onClick={() => setQuery(`系统讲解 ${s}`)}
              className="rounded-full border border-[#e7e5dc] bg-white px-3 py-1 text-[11.5px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
            >
              <span className="text-accent mr-1">学习</span>
              {s}
            </button>
          ))}
        </div>
        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            出错了：{error}
          </div>
        )}
      </div>
    );
  }

  // ---- 生成中/已生成的单页堆叠流（原版同款） ----
  const searchDone = step !== "search";
  const clarifyDone = step === "blueprint" || step === "outline" || step === "done";
  const outlineDone = step === "done";
  const tipIndex = (progress?.current ?? answeredRounds.length) % TIPS.length;

  return (
    <div className="max-w-3xl mx-auto pt-8 px-6 pb-24">
      {/* 任务气泡（悬右） */}
      <div className="flex justify-end mb-8">
        <div className="rounded-2xl bg-[#f1efe8] px-4 py-2.5 text-[13.5px] text-ink max-w-[70%]">
          {query || (textbookId ? `📖 《${textbookTitle}》教材课程` : "课程生成")}
        </div>
      </div>

      {/* 阶段 1：搜索 / 读教材 */}
      <section className="mb-8">
        <StageHeader title={textbookId ? "正在读取教材内容" : "正在搜索网络资料"} n={1} state={searchDone ? "done" : "running"} />
        {step === "search" && sources.length === 0 && <LiveStatus pool={SEARCH_STATUS} />}
        {searchQueries.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {searchQueries.map((q) => (
              <span key={q} className="rounded-full bg-[#f1efe8] px-3 py-1 text-[12px] text-ink-soft">
                {q}
              </span>
            ))}
          </div>
        )}
        {sources.length > 0 && (
          <div className="space-y-1">
            {(showAllSources ? sources : sources.slice(0, 6)).map((s) => (
              <div key={s.index} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[#fafaf7] fade-up">
                <span
                  className="w-4.5 h-4.5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                  style={{ width: 18, height: 18, background: `hsl(${(s.index * 67) % 360} 42% 52%)` }}
                >
                  {s.domain[0]?.toUpperCase()}
                </span>
                <span className="flex-1 truncate text-[13px] text-ink">{s.title}</span>
                <span className="shrink-0 text-[10.5px] text-ink-faint border border-[#e7e5dc] rounded px-1.5 py-px">
                  {s.domain}
                </span>
              </div>
            ))}
            {sources.length > 6 && !showAllSources && (
              <button
                onClick={() => setShowAllSources(true)}
                className="text-[12px] text-ink-faint px-2 py-1 hover:text-accent"
              >
                ⋯ 还有 {sources.length - 6} 个...
              </button>
            )}
          </div>
        )}
      </section>

      {/* 阶段 2：澄清（进行中或已完成，整轮堆叠回显） */}
      {step !== "search" && (
        <section className="mb-8">
          <StageHeader title="构思初步思路" n={2} state={clarifyDone ? "done" : "running"} />
          {step === "clarify" && !question && loading && <LiveStatus pool={CLARIFY_STATUS} />}

          {/* 已回答轮次：完整卡片回显（选项高亮所选） */}
          {answeredRounds.map((r, i) => (
            <div key={i} className="mb-5 opacity-75">
              <div className="flex items-start justify-between mb-2">
                <div className="text-[14px] font-medium flex-1">
                  <span className="text-ink-faint mr-2">Q{i + 1}</span>
                  {r.question.question}
                </div>
                <span className="text-[11px] text-accent border border-accent/30 rounded px-2 py-0.5 shrink-0">
                  ✓ 已回答
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {r.question.options.map((opt) => {
                  const picked = r.selected.includes(opt.label) || r.freeText === opt.label;
                  return (
                    <div
                      key={opt.label}
                      className={`text-left rounded-xl border px-4 py-3 ${
                        picked ? "border-accent bg-accent/5" : "border-[#e7e5dc] bg-[#fafaf7]"
                      }`}
                    >
                      <div className="text-[13px] font-medium mb-0.5">{opt.label}</div>
                      {opt.desc && <div className="text-[11.5px] text-ink-soft leading-relaxed">{opt.desc}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* 当前轮次的问题卡 */}
          {question && step === "clarify" && (
            <div className="rounded-2xl border border-[#e7e5dc] bg-white p-5 fade-up">
              <div className="flex items-start justify-between mb-1">
                <div className="text-[15px] font-medium flex-1">
                  <span className="text-ink-faint mr-2">Q{round}</span>
                  {question.question}
                </div>
                <div className="flex gap-2 shrink-0 ml-4">
                  <span className="text-[11.5px] text-ink-faint border border-[#e7e5dc] rounded px-2 py-0.5">
                    {question.multi ? "多选题" : "单选题"}
                  </span>
                  {question.skippable && (
                    <button
                      onClick={() => submitAnswer("跳过")}
                      disabled={loading}
                      className="text-[11.5px] text-ink-faint border border-[#e7e5dc] rounded px-2 py-0.5 hover:border-accent hover:text-accent transition-colors"
                    >
                      跳过
                    </button>
                  )}
                </div>
              </div>
              {question.reason && (
                <div className="text-[12px] text-ink-faint mb-4 flex items-start gap-1.5">
                  <span className="shrink-0">🤔</span>
                  <span>{question.reason}</span>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {question.options.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => toggleOption(opt.label)}
                    className={`text-left rounded-2xl border px-5 py-4 transition-colors ${
                      selectedOptions.includes(opt.label)
                        ? "border-accent bg-accent/5"
                        : "border-[#e7e5dc] bg-white hover:border-accent/60"
                    }`}
                  >
                    <div className="font-semibold text-[13.5px] mb-1">{opt.label}</div>
                    {opt.desc && <div className="text-[12px] text-ink-soft leading-relaxed">{opt.desc}</div>}
                  </button>
                ))}
                <div
                  className={`rounded-2xl border px-5 py-4 sm:col-span-2 transition-colors ${
                    customAnswer ? "border-accent bg-accent/5" : "border-[#e7e5dc] bg-white"
                  }`}
                >
                  <div className="text-[12.5px] text-ink-soft mb-2">都不太对？写个自己的</div>
                  <input
                    value={customAnswer}
                    onChange={(e) => {
                      setCustomAnswer(e.target.value);
                      if (e.target.value) setSelectedOptions([]);
                    }}
                    placeholder="其他..."
                    className="w-full bg-transparent outline-none text-[13.5px]"
                  />
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() =>
                    submitAnswer(customAnswer.trim() ? customAnswer.trim() : selectedOptions.join("、"))
                  }
                  disabled={loading || (!customAnswer.trim() && selectedOptions.length === 0)}
                  className="rounded-full border border-[#d3d1c7] px-6 py-2 text-[13px] text-ink hover:border-accent hover:text-accent disabled:opacity-40 transition-colors"
                >
                  {loading ? "继续中..." : "继续"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 阶段 3：蓝图 */}
      {(step === "blueprint" || step === "outline" || step === "done") && blueprint && (
        <section className="mb-8">
          <StageHeader title="打造课程" n={3} state={step === "blueprint" ? (loading ? "running" : "done") : "done"} />
          {step === "blueprint" && (
            <>
              {designNotes.length > 0 && (
                <div className="mb-5 rounded-2xl border border-accent/25 bg-accent/5 p-5 fade-up">
                  <div className="text-[12px] text-accent font-semibold tracking-wide mb-2">AI 的设计思路</div>
                  <ol className="space-y-1.5">
                    {designNotes.map((note, i) => (
                      <li key={i} className="text-[13px] text-ink leading-relaxed flex gap-2">
                        <span className="text-accent font-medium shrink-0">{i + 1}.</span>
                        <span>{note}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="text-[13.5px] text-ink leading-relaxed mb-4">
                这是本课程的结构预览。可将鼠标悬停在单元或 lecture 上，删除、拆分或加深内容。
              </div>
              <BlueprintEditor
                blueprint={editedBlueprint || blueprint || { title: "", audience: "", tags: [], units: [] }}
                onChange={setEditedBlueprint}
                loading={loading}
              />
              {showFeedback && (
                <div className="mt-4 rounded-2xl border border-[#e7e5dc] bg-white p-4 flex gap-3">
                  <input
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="说说你想怎么调整，如：增加一个关于部署的单元、去掉数学推导部分..."
                    className="flex-1 outline-none text-[13.5px] bg-transparent"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) submitFeedback();
                    }}
                  />
                  <button
                    onClick={submitFeedback}
                    disabled={loading || !feedback.trim()}
                    className="rounded-lg bg-accent px-4 py-2 text-[12.5px] text-white font-medium hover:opacity-90 disabled:opacity-40"
                  >
                    重新生成
                  </button>
                </div>
              )}
              <div className="mt-6 flex justify-center gap-3">
                <button
                  onClick={() => setShowFeedback((v) => !v)}
                  disabled={loading}
                  className="rounded-full border border-[#d3d1c7] bg-white px-6 py-2.5 text-[13px] text-ink hover:border-accent transition-colors disabled:opacity-40"
                >
                  我想修改课程讲解结构
                </button>
                <button
                  onClick={confirmBlueprint}
                  disabled={loading}
                  className="rounded-full bg-accent px-6 py-2.5 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40"
                >
                  ✓ 没问题，继续生成课程细节
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* 阶段 4：生成课程细节 */}
      {step === "outline" && (
        <section className="mb-8">
          <StageHeader title="完善课程细节" n={4} state="running" />
          {designNotes.length > 0 && (
            <div className="rounded-2xl border border-accent/25 bg-accent/5 p-5 mb-4 fade-up">
              <div className="text-[12px] text-accent font-semibold tracking-wide mb-2">按这个思路逐单元展开</div>
              <ol className="space-y-1">
                {designNotes.map((note, i) => (
                  <li key={i} className="text-[12.5px] text-ink-soft leading-relaxed">· {note}</li>
                ))}
              </ol>
            </div>
          )}
          <div className="rounded-2xl border border-[#e7e5dc] bg-white p-6 mb-4">
            {progress && (
              <div className="mb-4">
                <div className="flex justify-between text-[12px] text-ink-soft mb-1.5">
                  <span>{progress.current} / {progress.total} 单元</span>
                  <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#f1efe8] overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-500"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-[#e7e5dc] rounded w-2/3"></div>
              <div className="h-4 bg-[#e7e5dc] rounded w-1/2"></div>
              <div className="h-4 bg-[#e7e5dc] rounded w-3/5"></div>
            </div>
          </div>
          <div className="rounded-2xl border border-[#e7e5dc] bg-white p-5 flex gap-4 items-start">
            <div className="text-[22px]">💡</div>
            <div>
              <div className="text-[13px] font-medium mb-1">学习小贴士</div>
              <div className="text-[12.5px] text-ink-soft leading-relaxed">{TIPS[tipIndex]}</div>
            </div>
          </div>
        </section>
      )}

      {/* 完成：课程就绪卡 */}
      {step === "done" && outline && (
        <section className="mb-8">
          <StageHeader title="完善课程细节" n={4} state="done" />
          <div className="rounded-2xl border border-[#e7e5dc] bg-white p-6 relative overflow-hidden fade-up">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-accent via-accent-border to-accent-soft" />
            <div className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[11.5px] text-accent font-medium mb-3">
              ✓ 课程已就绪
            </div>
            <div className="text-[22px] font-bold mb-2">{outline.title}</div>
            <div className="text-[13.5px] text-ink-soft mb-3 leading-relaxed">{outline.audience}</div>
            <div className="flex gap-2 flex-wrap mb-4">
              {outline.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-[#f1efe8] px-3 py-1 text-[12px] text-ink-soft">
                  #{tag}
                </span>
              ))}
            </div>
            <div className="text-[13px] text-ink-soft mb-1">
              共 {outline.units.length} 个单元，{outline.units.reduce((s, u) => s + u.lectures.length, 0)} 个课节
            </div>
            {(() => {
              const totalMin = outline.units.reduce(
                (s, u) => s + u.lectures.reduce((t, l) => t + (l.duration_min || 0), 0),
                0
              );
              if (totalMin <= 0) return null;
              const hours = (totalMin / 60).toFixed(1).replace(/\.0$/, "");
              return (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[12px] text-accent font-medium">
                  ⏱ 总时长约 {hours} 小时 —— 一门系统知识，12 小时量级拿下
                </div>
              );
            })()}
            {designNotes.length > 0 && (
              <div className="mt-3 rounded-xl bg-[#fafaf7] border border-[#e7e5dc] p-3.5">
                <div className="text-[11.5px] text-ink-faint mb-1.5">这门课为什么这样设计</div>
                <ol className="space-y-1">
                  {designNotes.map((note, i) => (
                    <li key={i} className="text-[12.5px] text-ink-soft leading-relaxed">· {note}</li>
                  ))}
                </ol>
              </div>
            )}
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => {
                  if (onComplete && courseId) {
                    onComplete(courseId, outline.title, outline);
                  }
                }}
                className="rounded-full bg-accent px-8 py-3 text-[14px] text-white font-medium hover:opacity-90"
              >
                前往课程 →
              </button>
            </div>
          </div>
        </section>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          出错了：{error}
        </div>
      )}

      {/* 底部取消 */}
      {step !== "done" && (
        <div className="mt-12 flex justify-center">
          <button
            onClick={cancelGeneration}
            className="rounded-full border border-[#d3d1c7] px-5 py-2 text-[12.5px] text-ink-soft hover:border-red-300 hover:text-red-600 transition-colors"
          >
            ⏸ 取消生成
          </button>
        </div>
      )}
    </div>
  );
}
