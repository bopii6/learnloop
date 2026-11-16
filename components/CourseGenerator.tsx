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
import { Icon } from "./icons";
import { consumeSse } from "@/lib/sse";
import { uploadTextbookPdf } from "@/lib/textbook-client";
import { useRouter } from "next/navigation";
import { resetGeneratorState, useGeneratorState } from "@/hooks/useGeneratorState";
import { OutOfCredits } from "./OutOfCredits";

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

// F5 找回进行中的生成：courseId 落在 sessionStorage（课程号在 course_created 事件里第一时间下发）
const RESUME_KEY = "ll:gen-course";

const TTS_COST = 10; // 与后端 COST_COURSE_GENERATE 对齐：确认大纲时才真正扣分

// 输入页底部特性区：三个卖点一句话讲清产品（线性 SVG 图标，统一品牌气质）
const HOME_FEATURES = [
  { icon: "board", title: "白板讲师课", desc: "逐句讲解配板书，像一对一辅导" },
  { icon: "flag", title: "先过关，再拔高", desc: "课节配练习与关卡，学完就检验" },
  { icon: "doc", title: "用你的资料建课", desc: "上传教材 PDF，讲解对齐你的书" },
] as const;

// 线性图标：与侧栏同一套描边风格（stroke=currentColor）
function FeatureIcon({ name }: { name: "board" | "flag" | "doc" }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-5 w-5",
    "aria-hidden": true,
  };
  if (name === "board")
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M12 16v3M8.5 21h7" />
        <path d="M7 12c2-3.5 4-3.5 5.5-1.5S16 12 17 9" />
      </svg>
    );
  if (name === "flag")
    return (
      <svg {...common}>
        <path d="M5 21V4" />
        <path d="M5 4c3-1.8 6 1.8 9 0s5 0 5 0v9c-3 1.8-6-1.8-9 0s-5 0-5 0z" />
        <path d="m9.5 11.5 1.8 1.8 3.2-3.6" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

/** 首页课堂演示：板书逐条"写"出来、字幕逐句换——产品的核心是"活的课堂"，预览也必须是活的 */
const BOARD_DEMO_LINES = [
  { n: 1, text: "Agent = 感知 → 思考 → 行动 的循环", say: "今天我们用三句话讲清楚 Agent。" },
  { n: 2, text: "Tool Use：把「模型会想」变成「模型会做」", say: "光会想还不够，得能动手做事。" },
  { n: 3, text: "Function Calling 三要素：名称 · 参数 · 结果", say: "名字、参数、返回结果，缺一个都调不动。" },
];

function BoardPreview() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    // 0=写第1条 → 1=写第2条 → 2=写第3条 → 3=收笔 → 4=停留 → 回到 0
    const t = window.setInterval(() => setPhase((p) => (p + 1) % 5), 1600);
    return () => window.clearInterval(t);
  }, []);
  const visibleCount = Math.min(phase + 1, BOARD_DEMO_LINES.length);
  const say = BOARD_DEMO_LINES[Math.min(phase, BOARD_DEMO_LINES.length - 1)].say;
  const writing = phase < BOARD_DEMO_LINES.length;
  return (
    <div className="relative border-b border-[#f4f4f5] bg-[linear-gradient(160deg,#fdfdfb,#f6f8f4)] p-6 sm:border-b-0 sm:border-r">
      <div className="min-h-[132px] space-y-3.5 text-[12.5px] leading-relaxed text-ink/85">
        {BOARD_DEMO_LINES.map((line, i) => {
          const visible = i < visibleCount;
          const isWriting = visible && writing && i === visibleCount - 1;
          return (
            <div
              key={line.n}
              className={`flex items-center gap-2.5 transition-all duration-500 ${
                visible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
              }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-white">
                {line.n}
              </span>
              <span className={i === 2 ? "border-b-2 border-accent-border/60 pb-0.5" : ""}>{line.text}</span>
              {isWriting && <span className="inline-block h-3.5 w-[2px] animate-pulse bg-accent" aria-hidden />}
            </div>
          );
        })}
      </div>
      {/* 手绘感圈注 */}
      <svg viewBox="0 0 120 40" className="absolute right-5 top-5 w-24 text-accent-border/70" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M6 30 C 20 8, 60 4, 88 14 S 116 30, 108 34" />
        <path d="M100 26 l8 8 -11 2" />
      </svg>
      <div className="mt-4 inline-flex max-w-full items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-[10.5px] text-ink-faint shadow-sm ring-1 ring-[#eceadf]">
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[9px] font-bold text-accent">师</span>
        <span className="truncate">{writing ? "讲师正在边说边写…" : "写完了，随时打断提问"}</span>
      </div>
      <div className="mt-2.5 truncate text-[11px] text-ink-faint/90">
        <span className="mr-1.5 font-semibold text-accent/80">讲师</span>
        {say}
      </div>
    </div>
  );
}

export function CourseGenerator({ onComplete }: CourseGeneratorProps) {
  const router = useRouter();
  // 全部状态走 useGeneratorState（模块级仓库）：tab 切走组件卸载后，
  // SSE 事件仍写入仓库，切回首页原样恢复进度
  const [query, setQuery] = useGeneratorState("query", "");
  const [step, setStep] = useGeneratorState<
    "input" | "search" | "clarify" | "blueprint" | "outline" | "done"
  >("step", "input");
  const [sources, setSources] = useGeneratorState<SourceItem[]>("sources", []);
  const [searchQueries, setSearchQueries] = useGeneratorState<string[]>("searchQueries", []);
  const [showAllSources, setShowAllSources] = useGeneratorState("showAllSources", false);
  const [question, setQuestion] = useGeneratorState<ClarifyQuestion | null>("question", null);
  const [round, setRound] = useGeneratorState("round", 1);
  const [totalRounds, setTotalRounds] = useGeneratorState("totalRounds", 4);
  const [answeredRounds, setAnsweredRounds] = useGeneratorState<AnsweredRound[]>("answeredRounds", []);
  const [blueprint, setBlueprint] = useGeneratorState<CourseBlueprint | null>("blueprint", null);
  const [editedBlueprint, setEditedBlueprint] = useGeneratorState<CourseBlueprint | null>("editedBlueprint", null);
  const [outline, setOutline] = useGeneratorState<CourseOutline | null>("outline", null);
  const [courseId, setCourseId] = useGeneratorState("courseId", "");
  const [error, setError] = useGeneratorState<string | null>("error", null);
  // 积分不够：给出买积分 / 兑换码两条路，充值后直接接着生成
  // 公网未登录：到扣费点时请登录，登录成功后自动接着生成
  const [authBlock, setAuthBlock] = useGeneratorState<string | null>("authBlock", null);
  const [creditsBlock, setCreditsBlock] = useGeneratorState<{ what: string; need: number; balance: number } | null>("creditsBlock", null);
  const [selectedOptions, setSelectedOptions] = useGeneratorState<string[]>("selectedOptions", []);
  const [customAnswer, setCustomAnswer] = useGeneratorState("customAnswer", "");
  const [loading, setLoading] = useGeneratorState("loading", false);
  const [progress, setProgress] = useGeneratorState<{ current: number; total: number; optimized?: number } | null>("progress", null);
  const [showFeedback, setShowFeedback] = useGeneratorState("showFeedback", false);
  const [feedback, setFeedback] = useGeneratorState("feedback", "");
  const [designNotes, setDesignNotes] = useGeneratorState<string[]>("designNotes", []);
  const [chatReply, setChatReply] = useGeneratorState<string | null>("chatReply", null);
  // 入口问答回路：真问题不建课，直接在输入页给出带引用的回答
  const [qaPending, setQaPending] = useGeneratorState<string | null>("qaPending", null);
  const [qaResult, setQaResult] = useGeneratorState<{ reply: string; sources: SourceItem[] } | null>("qaResult", null);
  // 教材模式：上传 PDF 后对着课本建课（蓝图镜像目录，讲解标页码）
  const [textbookId, setTextbookId] = useGeneratorState("textbookId", "");
  const [textbookTitle, setTextbookTitle] = useGeneratorState("textbookTitle", "");
  const [textbookPages, setTextbookPages] = useGeneratorState("textbookPages", 0);
  const [textbookOcr, setTextbookOcr] = useGeneratorState("textbookOcr", false);
  const [textbookSize, setTextbookSize] = useGeneratorState("textbookSize", 0);
  const [textbookNotice, setTextbookNotice] = useGeneratorState<string | null>("textbookNotice", null);
  const [uploading, setUploading] = useGeneratorState("uploading", false);
  const [uploadLabel, setUploadLabel] = useGeneratorState<string | null>("uploadLabel", null);
  const [uploadError, setUploadError] = useGeneratorState<string | null>("uploadError", null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const queryRef = useRef<HTMLTextAreaElement | null>(null);
  const [statusLine, setStatusLine] = useGeneratorState("statusLine", 0);
  // 以下为纯本页 UI 状态：刷新后不需要恢复
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [completionToast, setCompletionToast] = useState(false);
  const doneSectionRef = useRef<HTMLElement | null>(null);
  const [resumeInfo, setResumeInfo] = useState<
    | null
    | { courseId: string; step: string; query: string; title?: string; generating?: boolean; outline?: CourseOutline | null }
  >(null);
  // 文档建课 5 步管线：第 1 步「正在查看你的文档」+ 蓝图确认后的行内回执
  const [readingDoc, setReadingDoc] = useGeneratorState<"idle" | "running" | "done">("readingDoc", "idle");
  const [confirmed, setConfirmed] = useGeneratorState("confirmed", false);
  const [saveFailed, setSaveFailed] = useGeneratorState("saveFailed", false);

  const abortRef = useRef<AbortController | null>(null);

  // 运行中阶段的动态状态文案（"翻开了书本"式的推理感）
  useEffect(() => {
    if (!loading || step === "input") return;
    const t = window.setInterval(() => setStatusLine((s) => s + 1), 3200);
    return () => window.clearInterval(t);
  }, [loading, step]);

  // 生成完成：自动把就绪卡滚进视野 + 轻提醒（完成入口曾埋在长页底部无人知晓）
  useEffect(() => {
    if (step !== "done" || !outline) return;
    const t = window.setTimeout(() => {
      doneSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setCompletionToast(true);
      window.setTimeout(() => setCompletionToast(false), 5000);
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // F5 找回：挂载时若本地记着一次生成（且当前是全新输入页），问服务端要状态
  useEffect(() => {
    if (step !== "input") return;
    const saved = sessionStorage.getItem(RESUME_KEY);
    if (!saved) return;
    let alive = true;
    fetch("/api/course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "state", courseId: saved }),
      signal: AbortSignal.timeout(10000),
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        if (!d || d.cancelled) {
          sessionStorage.removeItem(RESUME_KEY);
          return;
        }
        setResumeInfo({ courseId: saved, step: d.step, query: d.query, title: d.title, generating: d.generating, outline: d.outline });
      })
      .catch(() => {
        sessionStorage.removeItem(RESUME_KEY);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvent = useCallback((e: CourseEvent) => {
    if (e.type === "stage") {
      if (e.name === "search") setStep((s) => (s === "input" ? "search" : s));
      if (e.name === "reading_doc") {
        if (e.status === "start") {
          setReadingDoc("running");
          setStep("search");
        } else {
          setReadingDoc("done");
        }
      }
    } else if (e.type === "course_created") {
      // 建课第一时间拿到 id：落 sessionStorage，F5 后能找回这次生成
      setCourseId(e.courseId);
      sessionStorage.setItem(RESUME_KEY, e.courseId);
      setResumeInfo(null);
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
      // optimized 只在每单元完成时下发，单元进行中保留上次的计数（避免"已优化 N 个课节"闪烁）
      setProgress((p) => ({ current: e.current, total: e.total, optimized: e.optimized ?? p?.optimized }));
    } else if (e.type === "outline") {
      setOutline(e.outline);
    } else if (e.type === "done") {
      setStep("done");
      setLoading(false);
      setProgress(null);
      setSaveFailed(Boolean(e.saveFailed));
      // 课程交付完毕，积分已扣：通知侧栏刷新余额
      window.dispatchEvent(new Event("ll:credits-changed"));
    } else if (e.type === "save_ok") {
      setSaveFailed(false);
    } else if (e.type === "auth_required") {
      setAuthBlock(e.message);
      setLoading(false);
    } else if (e.type === "credits_block") {
      setCreditsBlock({ what: e.reason, need: e.need, balance: e.balance });
      setLoading(false);
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
        // 整条管线最贵到 4-5 分钟：给 10 分钟硬超时，服务端挂起时用户看到的是报错而不是永远转圈
        const timeout = AbortSignal.timeout(10 * 60_000);
        const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, timeout]) : controller.signal;
        const res = await fetch("/api/course", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);

        await consumeSse<CourseEvent>(res, handleEvent);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          // 超时与裸状态码都要翻译成人话：用户得知道该等还是该重试、钱退不退
          if (e instanceof Error && e.name === "TimeoutError") {
            setError("请求超时：服务长时间没有响应，请重试。已扣的积分会自动退回。");
          } else {
            setError(e instanceof Error ? e.message : String(e));
          }
          setLoading(false);
        }
      }
    },
    [handleEvent]
  );

  /** 上传教材 PDF：浏览器端抽取逐页文字（Workers 服务端扛不动解析），之后建课全程以教材为准 */
  const uploadTextbook = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setUploadLabel("📄 文档解析中…");
    try {
      const d = await uploadTextbookPdf(file, setUploadLabel);
      setTextbookId(d.id);
      setTextbookTitle(d.title);
      setTextbookPages(d.textPages ?? d.pageCount ?? 0);
      setTextbookOcr(Boolean(d.ocr));
      setTextbookSize(file.size);
      setTextbookNotice(d.notice || null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      setUploadLabel(null);
    }
  }, []);

  const startGeneration = useCallback(async () => {
    if ((!query.trim() && !textbookId) || loading) return;
    setLoading(true);
    setError(null);
    setCreditsBlock(null);
    setCancelNotice(null);
    setStep("search");
    setSources([]);
    setSearchQueries([]);
    setQuestion(null);
    setBlueprint(null);
    setEditedBlueprint(null);
    setOutline(null);
    setAnsweredRounds([]);
    setProgress(null);
    setDesignNotes([]);
    setChatReply(null);
    setQaPending(null);
    setQaResult(null);
    setReadingDoc(textbookId ? "running" : "idle");
    setConfirmed(false);
    setSaveFailed(false);
    await streamRequest({
      action: "start",
      query: query.trim() || `系统学习《${textbookTitle}》教材`,
      textbookId: textbookId || undefined,
    });
  }, [query, textbookId, textbookTitle, loading, streamRequest]);

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
    setCreditsBlock(null);
    setAuthBlock(null);
    setLoading(true);
    setStep("outline");
    setProgress(null);
    setConfirmed(true); // 行内回执「✓ 已确认，正在生成完整课程…」
    // 如果用户编辑过蓝图，把编辑后的版本发给后端
    const body: Record<string, unknown> = { action: "generate", courseId };
    if (editedBlueprint && editedBlueprint !== blueprint) {
      body.blueprint = editedBlueprint;
    }
    await streamRequest(body);
  }, [courseId, loading, streamRequest, editedBlueprint, blueprint]);

  // 被登录拦下的生成：登录成功后自动接着走（不用再找按钮）
  useEffect(() => {
    if (!authBlock || !courseId) return;
    const onLoggedIn = () => void confirmBlueprint();
    window.addEventListener("ll:logged-in", onLoggedIn);
    return () => window.removeEventListener("ll:logged-in", onLoggedIn);
  }, [authBlock, courseId, confirmBlueprint]);

  const submitFeedback = useCallback(async () => {
    if (!courseId || loading || !feedback.trim()) return;
    setLoading(true);
    // 手动编辑过的蓝图一并送回服务端：反馈重生成以用户手改后的结构为基准，
    // 而不是悄悄用旧蓝图覆盖本地编辑
    const body: Record<string, unknown> = { action: "blueprint_feedback", courseId, feedback: feedback.trim() };
    if (editedBlueprint && editedBlueprint !== blueprint) body.blueprint = editedBlueprint;
    await streamRequest(body);
    setFeedback("");
  }, [courseId, loading, feedback, streamRequest, editedBlueprint, blueprint]);

  const retrySave = useCallback(async () => {
    if (!courseId || loading) return;
    setLoading(true);
    await streamRequest({ action: "save_course", courseId });
    setLoading(false);
  }, [courseId, loading, streamRequest]);

  // 真取消：告诉服务端停掉管线（事件边界抛错中止 LLM 调用），已扣的积分立即退回
  const cancelGeneration = useCallback(async () => {
    const cid = courseId;
    abortRef.current?.abort();
    let refunded = false;
    if (cid) {
      try {
        const res = await fetch("/api/course", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", courseId: cid }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const d = await res.json();
          refunded = Boolean(d.refunded);
        }
      } catch {
        // 取消请求失败也照样本地退出：不能因为通知不到就不让用户走
      }
    }
    sessionStorage.removeItem(RESUME_KEY);
    setStep("input");
    setLoading(false);
    setQuestion(null);
    setProgress(null);
    setReadingDoc("idle");
    setConfirmed(false);
    setSaveFailed(false);
    setCancelNotice(
      refunded
        ? "已取消生成，本次消耗的积分已全额退回。"
        : "已取消生成。本次未产生扣费（积分只在确认大纲后才扣）。"
    );
    window.setTimeout(() => setCancelNotice(null), 8000);
  }, [courseId]);

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

  // ---- 内联阶段标题（accent 粗体 ｜ 第 N 步，共 M 步 ✓/…；文档建课为 5 步）----
  const stageTotal = textbookId ? 5 : 4;
  // 生成被拦下（积分不够 / 需要登录 / 出错）时，进行中的阶段改显"已暂停"，不再假装还在转
  const halted = !loading && Boolean(creditsBlock || authBlock || error);
  const StageHeader = ({ title, n, state }: { title: string; n: number; state: "running" | "done" }) => (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="text-[14.5px] font-bold text-accent">{title}</span>
      <span className="text-ink-faint text-[12.5px]">｜</span>
      <span className="text-[12.5px] text-ink-soft">第 {n} 步，共 {stageTotal} 步</span>
      {state === "done" ? (
        <span className="text-accent text-[13px]">✓</span>
      ) : halted ? (
        <span className="text-[12px] text-ink-faint">已暂停</span>
      ) : (
        <span className="text-[13px] text-accent animate-pulse">…</span>
      )}
    </div>
  );

  // ---- 动态状态行（"翻开了书本"式的推理感） ----
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

  // ---- 输入页：hero + 输入卡 + 示例主题 + 产品特性 ----
  if (step === "input") {
    return (
      <div className="relative">
        <div className="relative mx-auto max-w-3xl px-6 pb-16 pt-16">
          {/* Hero：模式切换 + 蓝色荧光标注（Hyperknow 同款结构） */}
          <div className="mb-8 text-center">
            <div className="mb-6 inline-flex items-center rounded-full bg-[#f4f4f5] p-1">
              <span className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-ink shadow-[0_1px_4px_rgba(24,24,27,0.10)] ring-1 ring-[#e4e4e7]">打造课程</span>
              <button
                onClick={() => router.push("/chat")}
                className="rounded-full px-4 py-1.5 text-[13px] text-ink-soft transition-colors hover:text-ink"
              >
                即时协助
              </button>
            </div>
            <h1 className="mb-3 text-[30px] font-bold leading-[1.4] tracking-tight text-ink">
              使用 <span className="inline-block align-[-0.12em] text-[26px]">🛸</span> Superlearn 打造你的
              <span className="rounded-md bg-[linear-gradient(transparent_58%,rgb(var(--accent-border-rgb)/0.9)_58%)] px-1">专属课程</span>
            </h1>
            <p className="text-[14px] text-ink-soft">
              讲解 + 板书 + 课后练习，像一对一辅导一样系统学完一学期的内容
            </p>
          </div>

          {qaPending && (
            <div className="fade-up mb-4 flex items-center gap-2 rounded-2xl border border-[#e4e4e7] bg-white px-4 py-3.5 text-[13.5px] text-ink-soft shadow-sm">
              <span className="stage-spinner inline-block shrink-0" style={{ width: 11, height: 11 }} />
              {qaPending}
            </div>
          )}
          {qaResult && (
            <div className="fade-up mb-4 rounded-2xl border border-[#e4e4e7] bg-white px-5 py-4 text-[13.5px] text-ink shadow-sm">
                <div className="mb-1.5 text-[10.5px] tracking-wide text-ink-faint">Superlearn · 直接回答</div>
              <div className="prose-course">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{qaResult.reply}</ReactMarkdown>
              </div>
              {qaResult.sources.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[#f4f4f5] pt-2.5">
                  {qaResult.sources.map((s) => (
                    <a
                      key={s.index}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      title={s.title}
                      className="max-w-[220px] truncate rounded-full bg-[#f4f4f5] px-2.5 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:text-accent"
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
                  className="text-[11.5px] text-ink-faint transition-colors hover:text-accent"
                >
                  知道了
                </button>
              </div>
            </div>
          )}
          {chatReply && (
            <div className="fade-up mb-4 rounded-2xl border border-[#e4e4e7] bg-white px-5 py-4 text-[13.5px] leading-relaxed text-ink shadow-sm">
              <div className="mb-1.5 text-[10.5px] tracking-wide text-ink-faint">Superlearn</div>
              {chatReply}
              <button
                onClick={() => setChatReply(null)}
                className="ml-2 text-[11.5px] text-ink-faint transition-colors hover:text-accent"
              >
                知道了
              </button>
            </div>
          )}
          {/* F5 找回：上次有一门课没走完（或已在后台完成），给一条显眼的回去路 */}
          {resumeInfo && !loading && (
            <div className="fade-up mb-4 rounded-2xl border border-accent/30 bg-accent/5 px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[12px] text-accent font-semibold mb-1">上次还有一门课</div>
                  {resumeInfo.outline ? (
                    <div className="text-[13.5px] text-ink leading-relaxed">
                      《{resumeInfo.outline.title}》已经生成完成，随时可以去上课。
                    </div>
                  ) : resumeInfo.generating ? (
                    <div className="text-[13.5px] text-ink leading-relaxed">
                      《{resumeInfo.query || resumeInfo.title || "未命名课程"}》正在后台生成课程细节，完成后可在课程记录里打开。
                    </div>
                  ) : (
                    <div className="text-[13.5px] text-ink leading-relaxed">
                      《{resumeInfo.query || resumeInfo.title || "未命名课程"}》上次没生成完，可以接着来，不用从头填。
                    </div>
                  )}
                </div>
                <div className="shrink-0 flex flex-col gap-2">
                  {resumeInfo.outline ? (
                    <a
                      href={`/course/${resumeInfo.courseId}`}
                      onClick={() => {
                        sessionStorage.removeItem(RESUME_KEY);
                        setResumeInfo(null);
                      }}
                      className="rounded-full bg-accent px-4 py-2 text-[12.5px] text-white font-medium hover:opacity-90 text-center"
                    >
                      前往课程 →
                    </a>
                  ) : (
                    !resumeInfo.generating && (
                      <button
                        onClick={() => {
                          // 从服务端快照恢复生成现场：输入、来源、已答轮次、当前问题、蓝图
                          const cid = resumeInfo.courseId;
                          fetch("/api/course", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "state", courseId: cid }),
                            signal: AbortSignal.timeout(10000),
                          })
                            .then((r) => (r.ok ? r.json() : null))
                            .then((d) => {
                              if (!d) return;
                              setCourseId(cid);
                              sessionStorage.setItem(RESUME_KEY, cid);
                              if (d.query) setQuery(d.query);
                              if (Array.isArray(d.sources) && d.sources.length) setSources(d.sources);
                              const restored: AnsweredRound[] = (d.clarifyAnswers || []).map((a: { question: string; answer: string }, i: number) => ({
                                question: {
                                  id: `restored-q-${i}`,
                                  question: a.question,
                                  options: [],
                                  multi: false,
                                  skippable: true,
                                } as ClarifyQuestion,
                                selected: [],
                                freeText: a.answer,
                              }));
                              if (restored.length) {
                                setAnsweredRounds(restored);
                                setRound(restored.length + 1);
                              }
                              if (d.currentQuestion) {
                                setQuestion(d.currentQuestion);
                                setRound(Math.max(1, (d.clarifyAnswers || []).length + 1));
                              }
                              if (d.blueprint) {
                                setBlueprint(d.blueprint);
                                setEditedBlueprint(d.blueprint);
                              }
                              if (Array.isArray(d.designNotes) && d.designNotes.length) setDesignNotes(d.designNotes);
                              setStep(d.step === "blueprint" ? "blueprint" : "clarify");
                              setResumeInfo(null);
                            })
                            .catch(() => {
                              setCancelNotice("恢复失败：课程状态已过期，请重新生成。");
                            });
                        }}
                        className="rounded-full bg-accent px-4 py-2 text-[12.5px] text-white font-medium hover:opacity-90"
                      >
                        继续这次生成
                      </button>
                    )
                  )}
                  <button
                    onClick={() => {
                      void fetch("/api/course", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "cancel", courseId: resumeInfo.courseId }),
                      }).catch(() => {});
                      sessionStorage.removeItem(RESUME_KEY);
                      setResumeInfo(null);
                    }}
                    className="text-[11.5px] text-ink-faint hover:text-red-500 transition-colors"
                  >
                    不用了，放弃
                  </button>
                </div>
              </div>
            </div>
          )}
          {cancelNotice && (
            <div className="fade-up mb-4 rounded-2xl border border-accent/30 bg-accent/5 px-4 py-3 text-[13px] text-ink">
              {cancelNotice}
            </div>
          )}
          {/* 输入卡：Hyperknow 同款——大圆角白卡 + 卡内工具行 + 圆形提交 */}
          <div className="rounded-[24px] border border-[#e4e4e7] bg-white px-5 py-4 shadow-[0_6px_32px_rgba(24,24,27,0.07)] transition-all duration-300 focus-within:border-[#c9c9cf] focus-within:shadow-[0_8px_36px_rgba(24,24,27,0.10)]">
            <textarea
              ref={queryRef}
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
              className="w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-faint/80"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              {/* 文档上传：附件卡（图标+文件名+大小）+ 实时改价 10 → 13 */}
              <div className="flex min-w-0 items-center gap-2">
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
                {!textbookId && (
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    title="上传教材 PDF，围绕它生成课程"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#e4e4e7] text-ink-soft transition-colors hover:border-[#c9c9cf] hover:text-ink disabled:opacity-50"
                  >
                    {uploading ? <span className="stage-spinner inline-block" style={{ width: 13, height: 13 }} /> : <span className="text-[16px] leading-none">+</span>}
                  </button>
                )}
                {textbookId && (
                  <div className="flex items-start gap-3">
                    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-1.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-500 text-[9px] font-bold text-white">
                        PDF
                      </span>
                      <span className="min-w-0">
                        <span className="block max-w-[200px] truncate text-[12.5px] font-medium leading-tight text-ink">
                          《{textbookTitle}》
                        </span>
                        <span className="block text-[10.5px] text-ink-faint">
                          {textbookPages} 页文本{textbookOcr ? " · 已 OCR" : ""}
                        </span>
                      </span>
                      <button
                        onClick={() => {
                          setTextbookId("");
                          setTextbookTitle("");
                          setTextbookPages(0);
                          setTextbookOcr(false);
                          setTextbookSize(0);
                          setTextbookNotice(null);
                        }}
                        className="self-start leading-none text-ink-faint transition-colors hover:text-red-500"
                        title="移除文档"
                      >
                        ×
                      </button>
                    </div>
                    {textbookNotice && (
                      <span className="mt-1 text-[11px] leading-snug text-ink-faint">{textbookNotice}</span>
                    )}
                  </div>
                )}
                {uploadError && <span className="truncate text-[11.5px] text-red-600">{uploadError}</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span
                  className="inline-flex cursor-help items-center gap-1 rounded-full bg-[#f4f4f5] px-2.5 py-1 text-[12px] text-ink-soft"
                  title={`生成本课程需消耗 ${textbookId ? 13 : 10} 个积分${textbookId ? "（含文档处理 3 积分）" : ""}`}
                >
                  ✦ {textbookId ? 13 : 10}
                </span>
                <button
                  onClick={() => {
                    // 空输入不置灰（主按钮保持视觉引力），点了聚焦输入框
                    if (!query.trim() && !textbookId) {
                      queryRef.current?.focus();
                      return;
                    }
                    void startGeneration();
                  }}
                  disabled={loading}
                  aria-label={loading ? "生成中" : "开始打造课程"}
                  title="开始打造课程"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-[#18181b] text-white transition-colors hover:bg-[#3f3f46] disabled:opacity-50"
                >
                  {loading ? <span className="stage-spinner inline-block" style={{ width: 14, height: 14, borderTopColor: "rgba(255,255,255,0.35)" }} /> : <span className="text-[16px] leading-none">↑</span>}
                </button>
              </div>
            </div>
          </div>
          <div className="mt-3 text-center text-[12px] text-ink-faint">
            或{" "}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="text-ink-soft underline decoration-[#d4d4d8] underline-offset-2 transition-colors hover:text-accent disabled:opacity-50"
            >
              上传你的教材 PDF
            </button>
            ，围绕它生成课程
          </div>

          {/* 示例主题 chip（点击直接填入） */}
          <div className="mt-6 text-center">
            <div className="mb-3 text-[12px] text-ink-faint">不知道从哪开始？试试这些</div>
            <div className="flex flex-wrap justify-center gap-2">
              {["LLM Agent 的 Tool Use 设计模式", "雅思 vs 托福备考策略", "Python 数据分析入门"].map((s) => (
                <button
                  key={s}
                  onClick={() => setQuery(`系统讲解 ${s}`)}
                  className="rounded-full border border-[#e4e4e7] bg-white px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent"
                >
                  <span className="mr-1.5 text-accent/80">✦</span>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* 能力信任条：只说产品真做到的事，不虚构数据 */}
          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] text-ink-faint">
            {["引用真实网页来源", "逐句板书讲解", "课后练习即时检验"].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
                {t}
              </span>
            ))}
          </div>

          {/* 产品特性 */}
          <div className="mt-9 grid gap-3 sm:grid-cols-3">
            {HOME_FEATURES.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-[#e4e4e7] bg-white px-4 py-5 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-[#c9c9cf] hover:shadow-[0_8px_24px_rgba(24,24,27,0.07)]"
              >
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft/60 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                  <FeatureIcon name={f.icon} />
                </div>
                <div className="text-[13px] font-semibold text-ink">{f.title}</div>
                <div className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">{f.desc}</div>
              </div>
            ))}
          </div>

          {/* 课堂演示：动画演示「边讲边画」的真实节奏，不再是挂着假文案的静态截图 */}
          <div className="mt-10 overflow-hidden rounded-3xl border border-[#e4e4e7] bg-white shadow-[0_8px_32px_rgba(24,24,27,0.06)]">
            <div className="flex items-center gap-2 border-b border-[#f4f4f5] bg-[#fafafa] px-5 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#e4e4e7]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#e4e4e7]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#e4e4e7]" />
              <span className="ml-3 text-[11px] text-ink-faint">白板课堂 · 交互演示</span>
            </div>
            <div className="grid sm:grid-cols-[1.35fr_1fr]">
              <BoardPreview />
              {/* 右侧要点 */}
              <div className="flex flex-col justify-center gap-3.5 px-6 py-6">
                {[
                  { t: "讲到哪，写到哪", d: "讲解逐句播报，板书同步生成，节奏完全一致" },
                  { t: "随时打断提问", d: "停在任意一句追问，讲师先回答再从断点续讲" },
                  { t: "学完即检验", d: "课节末尾嵌练习，答对才算过关" },
                ].map((p) => (
                  <div key={p.t}>
                    <div className="text-[12.5px] font-semibold text-ink">{p.t}</div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">{p.d}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 页脚：品牌 + 法务入口 */}
          <footer className="mt-12 border-t border-[#f4f4f5] pt-5 pb-2 text-center">
            <div className="flex items-center justify-center gap-1.5 text-[12px] font-semibold text-ink-soft">
              <span className="flex h-4 w-4 items-center justify-center rounded bg-[#18181b] text-[9px] font-bold text-white">
                S
              </span>
              Superlearn
            </div>
            <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-ink-faint">
              <a href="/privacy" className="transition-colors hover:text-accent">隐私政策</a>
              <span className="text-[#d4d4d8]">·</span>
              <a href="/terms" className="transition-colors hover:text-accent">服务条款</a>
              <span className="text-[#d4d4d8]">·</span>
              <span>课程内容由 AI 生成，请自行核实关键信息</span>
            </div>
          </footer>

          {error && (
            <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              出错了：{error}
            </div>
          )}
        </div>
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
        <div className="rounded-2xl bg-[#f4f4f5] px-4 py-2.5 text-[13.5px] text-ink max-w-[70%]">
          {query || (textbookId ? `📖 《${textbookTitle}》教材课程` : "课程生成")}
        </div>
      </div>

      {/* 阶段 1（文档建课）：正在查看你的文档 */}
      {textbookId && (
        <section className="mb-8">
          <StageHeader title="正在查看你的文档" n={1} state={readingDoc === "done" ? "done" : "running"} />
          <div className="inline-flex items-center gap-3 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3.5 py-2.5 max-w-full fade-up">
            <span className="w-8 h-8 shrink-0 rounded-lg bg-red-500 text-white flex items-center justify-center text-[9px] font-bold">
              PDF
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink truncate max-w-[260px]">
                《{textbookTitle}》
              </span>
              <span className="block text-[10.5px] text-ink-faint">
                {textbookPages} 页文本{textbookOcr ? " · 已 OCR" : ""}
              </span>
            </span>
          </div>
        </section>
      )}

      {/* 阶段 2（文档建课）/ 1（纯文字）：搜索网络资料 */}
      <section className="mb-8">
        <StageHeader title="正在搜索网络资料" n={textbookId ? 2 : 1} state={searchDone ? "done" : "running"} />
        {step === "search" && sources.length === 0 && !halted && <LiveStatus pool={SEARCH_STATUS} />}
        {searchQueries.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {searchQueries.map((q) => (
              <span key={q} className="rounded-full bg-[#f4f4f5] px-3 py-1 text-[12px] text-ink-soft">
                {q}
              </span>
            ))}
          </div>
        )}
        {sources.length > 0 && (
          <div className="space-y-1">
            {(showAllSources ? sources : sources.slice(0, 5)).map((s) => (
              <div key={s.index} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[#fafafa] fade-up">
                <span
                  className="w-4.5 h-4.5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                  style={{ width: 18, height: 18, background: `hsl(${(s.index * 67) % 360} 42% 52%)` }}
                >
                  {s.domain[0]?.toUpperCase()}
                </span>
                <span className="flex-1 truncate text-[13px] text-ink">{s.title}</span>
                <span className="shrink-0 text-[10.5px] text-ink-faint border border-[#e4e4e7] rounded px-1.5 py-px">
                  {s.domain}
                </span>
              </div>
            ))}
            {sources.length > 5 && (
              <button
                onClick={() => setShowAllSources((v) => !v)}
                className="text-[12px] text-ink-faint px-2 py-1 hover:text-accent transition-colors"
              >
                {showAllSources
                  ? "⋯ 收起剩余来源"
                  : `⋯ 还有 ${sources.length - 5} 个来源没展开，点击查看`}
              </button>
            )}
          </div>
        )}
      </section>

      {/* 阶段 3（文档建课）/ 2（纯文字）：澄清（进行中或已完成，整轮堆叠回显） */}
      {step !== "search" && (
        <section className="mb-8">
          <StageHeader title="构思初步思路" n={textbookId ? 3 : 2} state={clarifyDone ? "done" : "running"} />
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
                {r.question.options.length > 0 ? (
                  r.question.options.map((opt) => {
                    const picked = r.selected.includes(opt.label) || r.freeText === opt.label;
                    return (
                      <div
                        key={opt.label}
                        className={`text-left rounded-xl border px-4 py-3 ${
                          picked ? "border-accent bg-accent/5" : "border-[#e4e4e7] bg-[#fafafa]"
                        }`}
                      >
                        <div className="text-[13px] font-medium mb-0.5">{opt.label}</div>
                        {opt.desc && <div className="text-[11.5px] text-ink-soft leading-relaxed">{opt.desc}</div>}
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-[13px] text-ink sm:col-span-2">
                    你的回答：{r.freeText}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* 当前轮次的问题卡 */}
          {question && step === "clarify" && (
            <div className="rounded-2xl border border-[#e4e4e7] bg-white p-5 fade-up">
              <div className="flex items-start justify-between mb-1">
                <div className="text-[15px] font-medium flex-1">
                  <span className="text-ink-faint mr-2">Q{round}</span>
                  {question.question}
                  <span className="ml-2 text-[11px] text-ink-faint font-normal">已答 {answeredRounds.length} 题 · 一般 2~4 题，答完就出蓝图</span>
                </div>
                <div className="flex gap-2 shrink-0 ml-4">
                  <span className="text-[11.5px] text-ink-faint border border-[#e4e4e7] rounded px-2 py-0.5">
                    {question.multi ? "多选题" : "单选题"}
                  </span>
                  {question.skippable && (
                    <button
                      onClick={() => submitAnswer("跳过")}
                      disabled={loading}
                      className="text-[11.5px] text-ink-faint border border-[#e4e4e7] rounded px-2 py-0.5 hover:border-accent hover:text-accent transition-colors"
                    >
                      跳过
                    </button>
                  )}
                </div>
              </div>
              {question.reason && (
                <div className="text-[12px] text-ink-faint mb-4 flex items-start gap-1.5">
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
                        : "border-[#e4e4e7] bg-white hover:border-accent/60"
                    }`}
                  >
                    <div className="font-semibold text-[13.5px] mb-1">{opt.label}</div>
                    {opt.desc && <div className="text-[12px] text-ink-soft leading-relaxed">{opt.desc}</div>}
                  </button>
                ))}
                <div
                  className={`rounded-2xl border px-5 py-4 sm:col-span-2 transition-colors ${
                    customAnswer ? "border-accent bg-accent/5" : "border-[#e4e4e7] bg-white"
                  }`}
                >
                  <div className="text-[12.5px] text-ink-soft mb-2">都不太对？写个自己的</div>
                  <input
                    value={customAnswer}
                    onChange={(e) => {
                      setCustomAnswer(e.target.value);
                      if (e.target.value) setSelectedOptions([]);
                    }}
                    placeholder="其他…"
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
                  className="rounded-full border border-[#d4d4d8] px-6 py-2 text-[13px] text-ink hover:border-accent hover:text-accent disabled:opacity-40 transition-colors"
                >
                  {loading ? "继续中..." : "继续"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 阶段 4（文档建课）/ 3（纯文字）：蓝图 */}
      {(step === "blueprint" || step === "outline" || step === "done") && blueprint && (
        <section className="mb-8">
          <StageHeader title="打造课程" n={textbookId ? 4 : 3} state={step === "blueprint" ? (loading ? "running" : "done") : "done"} />
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
              {(editedBlueprint || blueprint)?.capstone?.name && (
                <div className="mb-4 rounded-2xl border border-accent/30 bg-accent/5 p-5 fade-up">
                  <div className="text-[12px] text-accent font-semibold tracking-wide mb-1.5">
                    🎯 结课作品 · 学完你将亲手做出
                  </div>
                  <div className="text-[15px] font-semibold text-ink">
                    {(editedBlueprint || blueprint)!.capstone!.name}
                  </div>
                  {(editedBlueprint || blueprint)!.capstone!.description && (
                    <div className="text-[12.5px] text-ink-soft mt-1 leading-relaxed">
                      {(editedBlueprint || blueprint)!.capstone!.description}
                    </div>
                  )}
                  {(editedBlueprint || blueprint)!.capstone!.criteria.length > 0 && (
                    <div className="mt-2.5 text-[12px] text-ink-soft">
                      <span className="font-medium text-ink">做成标准（对照检查）：</span>
                      <ul className="mt-1 space-y-0.5">
                        {(editedBlueprint || blueprint)!.capstone!.criteria.map((c, i) => (
                          <li key={i} className="flex gap-1.5 leading-relaxed">
                            <span className="text-accent shrink-0">✓</span>
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              <BlueprintEditor
                blueprint={editedBlueprint || blueprint || { title: "", audience: "", tags: [], units: [] }}
                onChange={setEditedBlueprint}
                loading={loading}
              />
              {showFeedback && (
                <div className="mt-4 rounded-2xl border border-[#e4e4e7] bg-white p-4 flex gap-3">
                  <input
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="说说你想怎么调整，如：增加一个关于部署的单元、去掉数学推导部分…"
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
                  className="rounded-full border border-[#d4d4d8] bg-white px-6 py-2.5 text-[13px] text-ink hover:border-accent transition-colors disabled:opacity-40"
                >
                  我想修改课程讲解结构
                </button>
                <button
                  onClick={confirmBlueprint}
                  disabled={loading}
                  className="rounded-full bg-accent px-6 py-2.5 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40"
                  title="从这一步起开始消耗积分：生成失败或中途取消会自动退回"
                >
                  ✓ 没问题，继续生成课程细节（消耗 {TTS_COST} 积分）
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* 阶段 5（文档建课）/ 4（纯文字）：生成课程细节 */}
      {step === "outline" && (
        <section className="mb-8">
          <StageHeader title="完善课程" n={stageTotal} state="running" />
          {confirmed && (
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-[#fafafa] border border-[#e4e4e7] px-3.5 py-1.5 text-[12.5px] text-ink-soft fade-up">
              <span className="text-accent">✓</span> 已确认，正在生成完整课程…
            </div>
          )}
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
          <div className="rounded-2xl border border-[#e4e4e7] bg-white p-6 mb-4">
            {progress && progress.total > 0 && (
              <div className="mb-4">
                <div className="flex justify-between text-[12px] text-ink-soft mb-1.5">
                  <span>
                    {progress.current} / {progress.total} 单元
                    {typeof progress.optimized === "number" && (
                      <span className="text-ink-faint"> · 已优化 {progress.optimized} 个课节</span>
                    )}
                  </span>
                  <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#f4f4f5] overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-500"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-[#e4e4e7] rounded w-2/3"></div>
              <div className="h-4 bg-[#e4e4e7] rounded w-1/2"></div>
              <div className="h-4 bg-[#e4e4e7] rounded w-3/5"></div>
            </div>
          </div>
          <div className="rounded-2xl border border-[#e4e4e7] bg-white p-5 flex gap-4 items-start">
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
        <section className="mb-8" ref={doneSectionRef}>
          <StageHeader title="完善课程" n={stageTotal} state="done" />
          <div className="rounded-2xl border border-[#e4e4e7] bg-white p-6 relative overflow-hidden fade-up">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-accent via-accent-border to-accent-soft" />
            <div className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[11.5px] text-accent font-medium mb-3">
              ✓ 课程已就绪
            </div>
            <div className="text-[22px] font-bold mb-2">{outline.title}</div>
          {saveFailed && (
            <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 flex items-center gap-3">
              <span className="text-[12.5px] text-amber-800 flex-1 leading-relaxed">
                ⚠ 课程保存时网络连续失败，目前只在当前页面可见。课程已生成本地副本，可随时重试保存。
              </span>
              <button
                onClick={() => void retrySave()}
                disabled={loading}
                className="shrink-0 rounded-full bg-amber-500 px-4 py-1.5 text-[12px] text-white font-medium hover:opacity-90 disabled:opacity-50"
              >
                {loading ? "保存中…" : "重试保存"}
              </button>
            </div>
          )}
            <div className="text-[13.5px] text-ink-soft mb-3 leading-relaxed">{outline.audience}</div>
            <div className="flex gap-2 flex-wrap mb-4">
              {outline.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-[#f4f4f5] px-3 py-1 text-[12px] text-ink-soft">
                  #{tag}
                </span>
              ))}
            </div>
            <div className="text-[13px] text-ink-soft mb-1">
              共 {outline.units.length} 个单元，{outline.units.reduce((s, u) => s + u.lectures.length, 0)} 个课节
            </div>
            {(() => {
              // 只统计可学的白板课节：测验/项目环节计入"总时长"是虚假承诺
              const totalMin = outline.units.reduce(
                (s, u) =>
                  s +
                  u.lectures
                    .filter((l) => (l as any).content_type === "whiteboard" || !(l as any).content_type)
                    .reduce((t, l) => t + (l.duration_min || 0), 0),
                0
              );
              if (totalMin <= 0) return null;
              const hours = (totalMin / 60).toFixed(1).replace(/\.0$/, "");
              return (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[12px] text-accent font-medium">
                  ⏱ 总时长约 {hours} 小时，一门系统知识，{hours} 小时稳稳学完
                </div>
              );
            })()}
            {designNotes.length > 0 && (
              <div className="mt-3 rounded-xl bg-[#fafafa] border border-[#e4e4e7] p-3.5">
                <div className="text-[11.5px] text-ink-faint mb-1.5">这门课为什么这样设计</div>
                <ol className="space-y-1">
                  {designNotes.map((note, i) => (
                    <li key={i} className="text-[12.5px] text-ink-soft leading-relaxed">· {note}</li>
                  ))}
                </ol>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-3 items-center">
              {courseId && (
                <a
                  href={`/course/${courseId}`}
                  onClick={() => resetGeneratorState()}
                  className="text-[12px] text-ink-faint hover:text-accent transition-colors underline decoration-dotted underline-offset-2"
                  title="独立链接，可刷新、可收藏、可找回"
                >
                  用链接打开这门课 ↗
                </a>
              )}
              <button
                onClick={() => {
                  if (onComplete && courseId) {
                    // 交付完成：清空生成快照，下次回首页是全新输入页
                    resetGeneratorState();
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

      {authBlock && (
        <div className="mt-4 rounded-2xl border border-[#e4e4e7] bg-white px-5 py-4" role="alert">
          <div className="text-[13.5px] font-semibold mb-1">差一步：登录后生成完整课程</div>
          <div className="text-[12.5px] text-ink-soft leading-relaxed mb-3">{authBlock}</div>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("ll:open-login"))}
            className="rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
          >
            登录 / 注册
          </button>
        </div>
      )}

      {creditsBlock && (
        <div className="mt-4">
          <OutOfCredits what={creditsBlock.what} need={creditsBlock.need} balance={creditsBlock.balance} onRecharged={() => void (courseId ? confirmBlueprint() : startGeneration())} />
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          出错了：{error}
        </div>
      )}

      {/* 完成提醒（配合自动滚动：生成完不再靠用户自己发现） */}
      {completionToast && (
        <div className="fixed left-1/2 -translate-x-1/2 top-6 z-[80] rounded-full bg-[#2b2a26] px-5 py-2.5 text-[12.5px] text-white shadow-xl fade-up">
          课程已生成完毕
        </div>
      )}

      {/* 取消生成：跟在内容流尾部、靠右弱化呈现——此前孤零零绝对居中在空白页中央，像个走丢的按钮 */}
      {step !== "done" && (
        <div className="mt-10 flex justify-end">
          <button
            onClick={() => void cancelGeneration()}
            className="rounded-full border border-[#d4d4d8] px-4 py-1.5 text-[12px] text-ink-faint hover:border-red-300 hover:text-red-600 transition-colors"
          >
            取消生成
          </button>
        </div>
      )}
    </div>
  );
}
