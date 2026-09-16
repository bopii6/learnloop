"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CourseOutline, LectureQuizItem, ReplayReel, TeachBeat, WhiteboardEvent, WhiteboardMessage } from "@/types";
import type { BattleMapBlock, BattleMapData } from "@/lib/battle-map";
import { Whiteboard } from "./Whiteboard";
import { createBoardWriter, type BoardWriter } from "./board-writer";
import { LectureQuizPanel } from "./LectureQuizPanel";
import { useClassroomSocket, type ClassroomState } from "@/hooks/useClassroomSocket";
import { startVoiceCapture, type VoiceCapture } from "./voice-capture";
import { consumeSse } from "@/lib/sse";
import { planItemLines, splitSpeechLines } from "@/lib/speech-lines";
import { boardCssVars, CHROME_VARS, boardColors } from "@/lib/board-themes";
import { createTtsPlayer, fetchTtsSegments, prefetchTts, resetTtsDisabled, ttsDisabledReason, ttsUnavailable } from "@/lib/tts-client";
import { AuthModal } from "./AuthModal";
import { exportBoardPoster, exportScriptPoster, downloadBlob, copyImageToClipboard, safeFilename } from "@/lib/board-poster";
import { VerticalClipModal, type ClipBeat } from "./VerticalClipModal";
import { renderKnowledgeMapSkeleton } from "@/lib/comic-kb-render";
import type { KnowledgeStoryboard } from "@/lib/agent/comic";
import { Icon } from "./icons";

interface CourseSessionProps {
  courseId: string;
  outline: CourseOutline;
  unitId: string;
  lectureId: string;
  lectureTitle: string;
  /** 学员已进过的课节 id（classrooms 快照口径）：战况图按它点亮已经啃过的块 */
  visited?: string[];
  onExit?: () => void;
}

/** 课堂对话轻量排版：加粗与行内代码（讲师输出自带 markdown 标记，纯文本直出会漏星号） */
function LessonMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="rounded bg-[#00000010] px-1 py-px text-[12px] font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/** 播放队列里的一项：某个 segment 的一个 beat（ordinal = 全课唯一序号，用于断点恢复） */
interface PlayItem {
  segmentId: string;
  index: number;
  total: number;
  title: string;
  anchor?: string;
  beat: TeachBeat;
  lastOfSegment: boolean;
  ordinal: number;
}

type PlaybackStatus = "idle" | "playing" | "paused" | "done";

// 中文语音偏好：优先 Natural/Online 神经语音（最接近真人），再退到知名语音，最后交给浏览器默认
let cachedZhVoice: SpeechSynthesisVoice | null = null;
function pickZhVoice(): SpeechSynthesisVoice | null {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (cachedZhVoice && voices.includes(cachedZhVoice)) return cachedZhVoice;
  const zh = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("zh"));
  const preferred =
    zh.find((v) => /natural|neural|online/i.test(v.name)) ||
    zh.find((v) => /xiaoxiao|xiaoyi|yunxi|yunyang|yaoyao|huihui|ting-?ting|mei-?jia/i.test(v.name)) ||
    zh[0] ||
    null;
  cachedZhVoice = preferred;
  return preferred;
}
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedZhVoice = null;
    pickZhVoice();
  };
}

// Chromium 已知问题：SpeechSynthesisUtterance 没有外部强引用时可能被 GC，
// 表现为朗读中途静音且 onend 永不触发。持有"最近一次"的 utterance 保活即可。
let keepAliveUtterance: SpeechSynthesisUtterance | null = null;

/** 板书文本归一化：去空白/标点后小写，只用于"是不是同一条标题/同一句话"的比对 */
function normBoardText(s?: string | null): string {
  return (s || "").replace(/[\s，。：:、（）()[\]【】·\-—_？！?!.,'"'""]+/g, "").toLowerCase();
}

/** 把裸的 HTTP 状态码/超时翻译成学员能听懂、知道下一步做什么的话 */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "TimeoutError") {
    return "请求超时：服务长时间没有响应，请重试（你的进度已保存，已扣的积分会自动退回）";
  }
  const m = msg.match(/请求失败 \((\d+)\)/);
  if (m) {
    const code = m[1];
    if (["501", "502", "503", "504"].includes(code)) return `服务暂时不可用（${code}），稍等片刻重试一次；你的进度已保存`;
    return `请求失败（${code}），请稍后重试；你的进度已保存`;
  }
  return msg;
}

// 浏览器系统音色兜底（云端 TTS 未配置/失败时）：onend / 兜底超时 / 主动取消 三路收敛
function speakWithBrowser(
  text: string,
  rate: number,
  registerStop: (stop: () => void) => void,
  finish: () => void
) {
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  keepAliveUtterance = u; // 防止 utterance 被 GC 导致 onend 丢失
  u.lang = "zh-CN";
  u.rate = rate;
  const zh = pickZhVoice();
  if (zh) u.voice = zh;
  let started = false;
  u.onstart = () => {
    started = true;
  };
  u.onend = finish;
  u.onerror = finish;
  registerStop(() => {
    try {
      synth.cancel();
    } catch {
      // ignore
    }
    finish();
  });
  synth.speak(u);
  // 浏览器静默失败（无声卡/无语音包）时不要卡死课堂
  window.setTimeout(() => {
    if (!started) finish();
  }, 1800);
  window.setTimeout(finish, (text.length * 320 + 6000) / rate);
}

export function CourseSession({
  courseId,
  outline,
  unitId,
  lectureId,
  lectureTitle,
  visited,
  onExit,
}: CourseSessionProps) {
  const [messages, setMessages] = useState<WhiteboardMessage[]>([]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  // 窄屏默认收起对话面板：固定 320px 常开曾把白板挤成一条缝
  const [chatOpen, setChatOpen] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1024));
  const scrollRef = useRef<HTMLDivElement>(null);
  // 文档建课：讲师讲到的原文页（teach 流的 doc_pages 事件），"对照原文"面板展示
  const [docPages, setDocPages] = useState<{ docTitle: string; pages: { page: number; text: string }[] } | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [subtitle, setSubtitle] = useState("");
  const [playback, setPlayback] = useState<PlaybackStatus>("idle");
  const [preparing, setPreparing] = useState(true);
  // 白板就绪：Excalidraw 动态加载（含手写字体）可能比开讲慢——就绪前不开讲/不恢复，
  // 否则写板器等画布超时后前几拍板书静默丢弃（讲师在讲、白板是空的）
  const [boardReady, setBoardReady] = useState(false);
  const [introCard, setIntroCard] = useState(true); // 本节预告卡：点"开始学习"才开讲
  // 交流方式记住上次的选择：每节课都被重新问一遍"想怎样交流"是纯摩擦
  const [chatMode, setChatModeState] = useState<"text" | "voice">(() => {
    if (typeof window === "undefined") return "text";
    try {
      return window.localStorage.getItem("ll:chat-mode") === "voice" ? "voice" : "text";
    } catch {
      return "text";
    }
  });
  const setChatMode = (m: "text" | "voice") => {
    setChatModeState(m);
    try {
      window.localStorage.setItem("ll:chat-mode", m);
    } catch {
      // 隐私模式等场景下存不了就算了
    }
  };
  // ---- 战况图（征途计分牌）：结课作品是终点旗，课程单元是路上的每一块。
  // 以终为始——单元的 summary 本来就是"为作品贡献哪一块"，直接就是骨架的砖。
  const battleMap = useMemo<BattleMapData>(() => {
    const visitedSet = new Set(visited || []);
    const blocks: BattleMapBlock[] = outline.units.map((u, i) => {
      const lectures = u.lectures
        .filter((l) => l.content_type === "whiteboard")
        .map((l) => ({ id: l.id, title: l.title, done: visitedSet.has(l.id) }));
      const doneCount = lectures.filter((l) => l.done).length;
      const state: BattleMapBlock["state"] =
        u.id === unitId
          ? "today"
          : lectures.length > 0 && doneCount === lectures.length
            ? "done"
            : doneCount > 0
              ? "doing"
              : "todo";
      return { index: i + 1, title: u.title, contribution: u.summary, state, lectures };
    });
    return {
      goal: outline.capstone?.name || outline.title,
      goalDesc: outline.capstone?.description,
      blocks,
      criteria: outline.capstone?.criteria,
    };
  }, [outline, unitId, visited]);
  const battleMapRef = useRef(battleMap);
  battleMapRef.current = battleMap;
  const battleFreshRef = useRef(false); // 本次是否为全新开课（决定结课盖不盖章）

  // 结课收尾（峰终）：讲完最后一拍，镜头拉回战况图，在今日这块盖上"啃下"的章。
  // 恢复路径（二次进入）只撒花——画面里已含上次盖的章，不再重复盖。
  useEffect(() => {
    if (playback !== "done" || !boardReady) return;
    const w = writerRef.current;
    if (!w) return;
    if (battleFreshRef.current) {
      battleFreshRef.current = false;
      const idx = battleMapRef.current.blocks.findIndex((b) => b.state === "today");
      if (idx >= 0) void w.crownBlock(idx);
      else w.characterCelebrate();
      return;
    }
    w.characterCelebrate();
  }, [playback, boardReady]);
  // 学员称呼：只在第一次（画像里还没有名字时）在预告卡顺口问一次，之后自动记住
  const [profileName, setProfileName] = useState<string | null>(null); // null = 还没加载
  const [introName, setIntroName] = useState("");
  // 纸面色（卡片冷调）：SSR 水合不会重写内联 style（客户端与客户端 diff 恒等），挂载后直写 DOM
  const classroomRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = classroomRootRef.current;
    if (!el) return;
    el.style.setProperty("--board-bg", boardColors.boardBg);
    el.style.setProperty("--board-dot", boardColors.boardDot);
    el.style.backgroundColor = boardColors.boardBg;
  }, []);
  useEffect(() => {
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProfileName(d?.profile?.name ?? ""))
      .catch(() => setProfileName(""));
  }, []);
  const [checkpoint, setCheckpoint] = useState<{ id: string; question: string; options: string[] } | null>(null);
  const [achievement, setAchievement] = useState<{ title: string; desc: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [micArmed, setMicArmed] = useState(false); // 语音模式：自动聆听是否开启
  // 课后练习：课末由讲师脚本下发，讲完即可作答
  const [lectureQuiz, setLectureQuiz] = useState<LectureQuizItem[] | null>(null);
  const [quizOpen, setQuizOpen] = useState(false);
  // 讲解语速：嫌慢可以直接提速，不用等讲师"讲快点"
  const [rate, setRate] = useState(1);
  // ---- 面向传播的三个产物：知识海报 / 回放链接 / 60 秒竖屏速览 ----
  const [posterBusy, setPosterBusy] = useState(false);
  const [kbBusy, setKbBusy] = useState(false);
  const [kbDone, setKbDone] = useState(false);
  const [posterMsg, setPosterMsg] = useState<{ text: string; href?: string } | null>(null);
  const [replayUrl, setReplayUrl] = useState("");
  const [clipOpen, setClipOpen] = useState(false);
  // 白板缩放（单一控件）：由 Whiteboard onChange 实时上报，摄像机自动运镜时读数跟着走
  const [zoomPct, setZoomPct] = useState(100);
  // 退出确认：× 是破坏性操作的入口（停讲解、断语音），必须有一步确认
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  // —— 讲解的细粒度控制与反馈 ——
  const [prepStage, setPrepStage] = useState<string | null>(null); // 备课进度（服务端逐片段 stage 事件）
  const [ttsIssue, setTtsIssue] = useState(false); // 云端语音连续失败：提示学员并提供自救
  const [ttsAuthNeeded, setTtsAuthNeeded] = useState(false); // 云端音色因未登录被禁：明示学员并提供登录入口
  const [authOpen, setAuthOpen] = useState(false); // 课堂内登录弹窗（课堂页不在 AppShell 内，没有侧栏登录入口）
  const browserVoicePrefRef = useRef(false); // 学员选择过"改用浏览器音色"
  const replayReqRef = useRef(false); // 重听本句：speak 收敛后原地重讲
  const lastSectionKeyRef = useRef(""); // 白板标题去重：最近写上的小节标题（归一化键）
  // 断连提示：从未连上不提示（首连失败由备课态兜住），连上后又断才提示
  const wsEverRef = useRef(false);
  const [wsLost, setWsLost] = useState(false);
  const replaySavedRef = useRef(false);
  const profileNameRef = useRef("");
  profileNameRef.current = profileName === null ? "" : profileName;

  const unit = outline.units.find((u) => u.id === unitId);

  // ---- refs（播放器引擎状态，避免闭包过期） ----
  const abortLectureRef = useRef<AbortController | null>(null);
  const abortChatRef = useRef<AbortController | null>(null);
  const excalidrawApiRef = useRef<any>(null);
  // writer 提前建好（append 内部会等画布 API，最长 15s）：不能等 onReady 才建，
  // 否则白板加载慢/失败时，前面几拍的板书会被静默丢弃、讲解与板书从此对不上
  const writerRef = useRef<BoardWriter | null>(null);
  if (!writerRef.current) writerRef.current = createBoardWriter(() => excalidrawApiRef.current);
  // E2E 调试锚点：画布不在无障碍树/截图里，自动化测试靠 window.__board 观察板书命中与点击换算
  if (typeof window !== "undefined") {
    (window as any).__board = {
      hitTest: (x: number, y: number) => writerRef.current?.hitTest(x, y) ?? null,
      focusBattleMap: () => writerRef.current?.focusBattleMap(),
      crownBlock: (i: number) => writerRef.current?.crownBlock(i),
      lastClick: null as null | { sx: number; sy: number; text: string | null },
    };
  }
  const startedRef = useRef(false);
  const messagesRef = useRef<WhiteboardMessage[]>([]);
  messagesRef.current = messages;

  const queueRef = useRef<PlayItem[]>([]);
  const playingRef = useRef(false);
  const pausedRef = useRef(false);
  const streamDoneRef = useRef(false);
  const playbackRef = useRef<PlaybackStatus>("idle");
  playbackRef.current = playback;
  const currentSegmentRef = useRef<string | null>(null);
  const segBeatIndexRef = useRef(0); // 当前片段内第几句（对话区逐句分段用）
  const segCheckpointRef = useRef<Map<string, { question: string; options: string[] }>>(new Map());
  const speechStopRef = useRef<(() => void) | null>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  // ---- 课堂状态通道（WS 恢复 + 进度上报） ----
  const room = `${courseId}:${unitId}:${lectureId}`;
  const { state: wsState, connected: wsConnected, send: wsSend, reconnect: wsReconnect } = useClassroomSocket(room);
  // 连接断了必须让学员看见：此前重连 8 次失败后课堂静默死掉，UI 毫无表示
  useEffect(() => {
    if (wsConnected) {
      wsEverRef.current = true;
      setWsLost(false);
    } else if (wsEverRef.current && !exitedRef.current) {
      setWsLost(true);
    }
  }, [wsConnected]);
  const savedStateRef = useRef<ClassroomState | null>(null); // join 后拿到的历史状态
  const nextOrdinalRef = useRef(0); // 全课 beat 序号（剧本顺序）
  const wsScriptRef = useRef<any[]>([]); // 已接收的剧本片段（上报服务端）
  const wsPointsRef = useRef<string[]>([]);
  const lastSaveRef = useRef(0); // 进度上报节流
  const spokenRef = useRef(""); // 老师最近朗读的句子（回声过滤用）
  const restoredRef = useRef(false); // 本次播放是否为断线恢复（恢复时不重画片段胶囊）
  const resumeSegmentRef = useRef<string | null>(null); // 恢复快照里模块页归属的片段（只跳过它的胶囊）
  const micArmedRef = useRef(false); // 语音模式：自动聆听开关
  const recRef = useRef<any>(null);
  const recTimerRef = useRef<number | null>(null);
  const lastVoiceRef = useRef(""); // 上一条已处理的语音（去重）
  const spokenAtRef = useRef(0); // 老师最近一句话的播报时间（回声窗口）
  const [voiceHeard, setVoiceHeard] = useState<{ text: string; status: "interim" | "ok" | "echo" | "short" | "dup" | "hint" | "error" } | null>(null);
  const sendChatRef = useRef<((t: string, cp?: { question: string; options: string[] }) => Promise<void>) | undefined>(undefined);
  const cloudStopRef = useRef<VoiceCapture | null>(null);
  const cloudActiveRef = useRef(false); // Chrome 原生识别不可达时，云端录音链路是否在跑
  const cloudAsrHintedRef = useRef(false); // 云端识别未配置只提示一次，不反复打扰
  // 退出/卸载守卫：置位后 pump/speak/续播全部短路，防止卸载后 TTS 继续朗读（幽灵朗读）
  const exitedRef = useRef(false);
  const lectureGenRef = useRef(0); // 讲课流的代数：旧流被 abort 后其 finally 不得污染新流的状态
  const sseSegmentsRef = useRef<Set<string>>(new Set()); // 本次讲课已收到的片段（服务端重发时去重）

  // 保存的历史状态同步到 ref（beginLecture 判断走恢复还是新开）
  useEffect(() => {
    if (wsState && (wsState.script?.length || 0) > 0) {
      savedStateRef.current = wsState;
    }
  }, [wsState]);

  // 恢复预览：预告卡还挂着时就把上次的板书画出来当背景——
  // 学员在点"继续学习"之前就知道自己回到了哪，而不是盯着一块空白白板
  useEffect(() => {
    if (!introCard || !boardReady || !wsState) return;
    if ((wsState.cursor || 0) <= 0) return;
    try {
      if ((wsState.elements?.length || 0) > 0) {
        excalidrawApiRef.current?.updateScene({ elements: wsState.elements || [] });
      }
      if (wsState.writer) {
        writerRef.current?.restore(wsState.writer);
        writerRef.current?.recolor();
        window.setTimeout(() => writerRef.current?.focusCurrent(), 200);
      }
    } catch {
      // 预览失败不影响正式恢复（点开始后的完整恢复链路会再来一遍）
    }
  }, [introCard, boardReady, wsState]);

  // ---- 语音全双工（BETA）：自动聆听常开，检测到学员开口 → 打断提问 → 答完续播 ----
  const normSpeech = (s: string) => s.replace(/[\s，。！？、：""''.!?,.…-]/g, "");
  const handleVoiceUtterance = useCallback(
    (text: string): "ok" | "echo" | "short" | "dup" => {
      const t = normSpeech(text);
      if (t.length < 2) return "short";
      // 回声过滤：仅在老师正在播报/刚说完 2 秒内生效，防止 TTS 从扬声器漏进麦克风误触发
      const spoken = normSpeech(spokenRef.current);
      const inEchoWindow = Date.now() - spokenAtRef.current < 2000;
      if (inEchoWindow && spoken.length > 6 && (spoken.includes(t) || (t.includes(spoken) && t.length >= spoken.length - 4))) {
        return "echo";
      }
      // 去重：同一句话不重复提问
      if (t === lastVoiceRef.current) return "dup";
      lastVoiceRef.current = t;
      void sendChatRef.current?.(text);
      return "ok";
    },
    []
  );

  // ---- 云端识别兜底链路（Chrome 原生识别不可达时）：本地录整句 → /api/asr → 文字 ----
  const stopCloudCapture = useCallback(() => {
    cloudActiveRef.current = false;
    cloudStopRef.current?.stop();
    cloudStopRef.current = null;
  }, []);

  const startCloudCapture = useCallback(async () => {
    if (cloudActiveRef.current) return;
    cloudActiveRef.current = true;
    try {
      const capture = await startVoiceCapture({
        onUtterance: async (wavB64) => {
          try {
            const res = await fetch("/api/asr", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ audioB64: wavB64 }),
            });
            const d = await res.json().catch(() => ({}));
            if (res.ok && d.text) {
              const status = handleVoiceUtterance(d.text);
              setVoiceHeard({ text: d.text, status: status === "ok" ? "ok" : status });
              window.setTimeout(() => setVoiceHeard((v) => (v?.text === d.text ? null : v)), 1500);
            } else if (d.error === "ASR_NOT_CONFIGURED") {
              // 自部署没配云端识别是常态而非事故：浏览器识别链路仍在自动重试，
              // 不要弹红卡报错（学员不需要看到百度注册教程），安静提示一次即可
              stopCloudCapture();
              if (!cloudAsrHintedRef.current) {
                cloudAsrHintedRef.current = true;
                setVoiceHeard({ text: "云端识别未配置，正在用浏览器识别", status: "hint" });
                window.setTimeout(() => setVoiceHeard((v) => (v?.status === "hint" ? null : v)), 4000);
              }
            } else {
              setVoiceHeard({ text: `识别失败：${d.detail || d.error || ""}`, status: "error" });
            }
          } catch {
            setVoiceHeard({ text: "识别请求失败", status: "error" });
          }
        },
        onError: (code) => {
          setError(`麦克风不可用（${code}），云端语音链路已停用`);
          stopCloudCapture();
        },
      });
      // getUserMedia 授权可能耗时数秒：期间用户已关闭聆听的话，立即释放，
      // 否则这路录音会变成孤儿——麦克风常开、持续触发打断，再开启还会叠第二路
      if (!cloudActiveRef.current) {
        capture.stop();
        return;
      }
      cloudStopRef.current = capture;
    } catch (e) {
      cloudActiveRef.current = false;
      setError("麦克风启动失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }, [handleVoiceUtterance, stopCloudCapture]);

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("当前浏览器不支持语音识别（需要 Chrome / Edge）");
      return;
    }
    micArmedRef.current = true;
    setMicArmed(true);
    const run = () => {
      if (!micArmedRef.current) return;
      try {
        const rec = new SR();
        rec.lang = "zh-CN";
        rec.continuous = false;
        rec.interimResults = true; // 中间结果实时显示，让"听到什么"可见
        rec.maxAlternatives = 1;
        rec.onresult = (e: any) => {
          let interim = "";
          for (let i = 0; i < e.results.length; i++) {
            const r = e.results[i];
            const text = r[0]?.transcript?.trim() || "";
            if (r.isFinal) {
              if (!text) continue;
              const status = handleVoiceUtterance(text);
              setVoiceHeard({ text, status });
              window.setTimeout(() => setVoiceHeard((v) => (v?.text === text ? null : v)), status === "ok" ? 1500 : 3000);
            } else if (text) {
              interim = text;
            }
          }
          if (interim) setVoiceHeard({ text: interim, status: "interim" });
        };
        rec.onend = () => {
          if (micArmedRef.current) {
            recTimerRef.current = window.setTimeout(run, 300);
          }
        };
        rec.onerror = (e: any) => {
          const code = e?.error || "unknown";
          if (code === "not-allowed" || code === "service-not-allowed") {
            micArmedRef.current = false;
            setMicArmed(false);
            setError("麦克风权限被拒绝：请在浏览器地址栏重新授权，语音模式已停用");
          } else if (code === "network") {
            // 浏览器自带识别服务不可达（国内网络常见）→ 自动切换"本地录音 + 云端识别"链路
            setVoiceHeard({ text: "浏览器识别不稳，已自动切换识别链路", status: "error" });
            window.setTimeout(() => setVoiceHeard((v) => (v?.text?.includes("识别链路") ? null : v)), 4000);
            void startCloudCapture();
          } else if (code === "audio-capture") {
            micArmedRef.current = false;
            setMicArmed(false);
            setError("未检测到可用麦克风，语音模式已停用");
          }
          // no-speech / aborted：正常静音与重启，静默
        };
        recRef.current = rec;
        rec.start();
      } catch {
        window.setTimeout(() => {
          if (micArmedRef.current) run();
        }, 500);
      }
    };
    run();
  }, [handleVoiceUtterance]);

  const stopListening = useCallback(() => {
    micArmedRef.current = false;
    setMicArmed(false);
    if (recTimerRef.current) window.clearTimeout(recTimerRef.current);
    try {
      recRef.current?.stop();
      recRef.current?.abort?.();
    } catch {
      // 忽略
    }
  }, []);

  const toggleAutoListen = useCallback(() => {
    if (micArmedRef.current) {
      stopListening();
      stopCloudCapture();
    } else {
      startListening();
    }
  }, [startListening, stopListening, stopCloudCapture]);

  // ---- 语音：逐句朗读。云端 TTS 优先（音色自然），未配置/失败回退浏览器系统音色；
  // onend / 兜底超时 / 主动取消 三路收敛为一个 Promise ----
  const speak = useCallback((text: string) => {
    spokenRef.current = text; // 供语音模式的回声过滤比对
    spokenAtRef.current = Date.now();
    const spd = Math.max(0.5, Math.min(3, rateRef.current || 1)); // 语速：所有计时随倍速收敛
    // 已暂停/已退出时不再发声（暂停可能落在板书阶段——上一句的 stop 已清空，不拦这里喇叭会继续讲）
    if (pausedRef.current || exitedRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const minMs = 1800 / spd;
      // finish 必须在所有分支之前定义：静音分支提前 return，
      // 若它在后面才声明，stop() 触发时会因 TDZ 抛 ReferenceError、promise 永不收敛
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          speechStopRef.current = null;
          resolve();
        }
      };
      if (!voiceOnRef.current || !("speechSynthesis" in window)) {
        // 静音模式：按阅读节奏推进（约 4 行/秒 的中文语速）。
        // 计时器也挂到 speechStopRef 上：否则跳过本句在静音下是空操作（实测踩过）
        let timer = 0;
        const stop = () => {
          if (timer) window.clearTimeout(timer);
          finish();
        };
        timer = window.setTimeout(stop, Math.max(minMs, (text.length * 170 + 400) / spd));
        speechStopRef.current = stop;
        return;
      }
      let cancelled = false; // 云端合成等待期间被暂停/退出
      speechStopRef.current = () => {
        cancelled = true;
        finish();
      };
      void (async () => {
        const segs = await fetchTtsSegments(text);
        if (cancelled || settled) return;
        if (segs) {
          setTtsIssue(false); // 云端语音恢复了，撤掉降级提示
          const player = createTtsPlayer(segs, spd);
          speechStopRef.current = () => player.stop();
          await player.promise;
          finish();
        } else if (ttsUnavailable()) {
          // 服务端没嘴：501=自部署没配 key（安静顶上）；401/403=未登录——必须明说，
          // 不然学员只觉得"声音变了"，不知道登录就能换回云端讲师音色
          if (ttsDisabledReason() === "unauthenticated") setTtsAuthNeeded(true);
          speakWithBrowser(text, spd, (stop) => {
            speechStopRef.current = stop;
          }, finish);
        } else if (browserVoicePrefRef.current) {
          // 学员在提示里选过"改用浏览器音色"：云端抖动期间用系统音色顶上，不再闷声安静
          speakWithBrowser(text, spd, (stop) => {
            speechStopRef.current = stop;
          }, finish);
        } else {
          // 云端已配置但这句暂时失败（重试仍失败）：字幕/板书照常、按阅读节奏推进。
          // 但不能安静装没事——学员不知道"没声音"和"讲到哪了"，提示 + 给一条自救路
          setTtsIssue(true);
          window.setTimeout(finish, Math.max(minMs, (text.length * 170 + 400) / spd));
        }
      })();
    });
  }, []);

  const pausePlayback = useCallback(() => {
    if (playbackRef.current !== "playing") return;
    pausedRef.current = true;
    replayReqRef.current = false;
    speechStopRef.current?.();
    setPlayback("paused");
  }, []);

  // 跳过本句：立即收掉当前句的语音/合成等待，直接进下一句（未写的板书由拍末兜底补齐）
  const skipLine = useCallback(() => {
    if (playbackRef.current !== "playing") return;
    speechStopRef.current?.();
  }, []);

  // 重听本句：停掉当前播报，pump 在原句原地重讲一遍（不重复写板书）
  const replayLine = useCallback(() => {
    if (playbackRef.current !== "playing") return;
    replayReqRef.current = true;
    speechStopRef.current?.();
  }, []);

  // ---- 播放器主循环：从队列取一个 beat，同步驱动 字幕 / 对话 / 白板 / 语音 ----
  const pump = useCallback(async () => {
    if (exitedRef.current || pausedRef.current || playingRef.current) return;
    const item = queueRef.current.shift();
    if (!item) {
      if (streamDoneRef.current) setPlayback("done");
      return;
    }
    playingRef.current = true;
    setPlayback("playing");
    // checkpoint 处会停在原句等作答：游标不跨过这一拍，断线恢复时才能重放并重新出题
    let cursorAdvance = 1;
    try {
      // 进入新片段：白板另起一行、对话区重置句计数
      if (currentSegmentRef.current !== item.segmentId) {
        currentSegmentRef.current = item.segmentId;
        segBeatIndexRef.current = 0;
        // 新片段的标题已经写进页眉：小节标题若与它同文，后面 beginBeat 时要跳过
        lastSectionKeyRef.current = normBoardText(item.title);
        // 断线恢复只跳过落点片段的胶囊（画面快照已含）；之后的片段照常另起模块起纸，
        // restoredRef 必须在此消费掉——不清会导致恢复后整节课都不再画纸和页眉
        const skipCapsule = restoredRef.current && resumeSegmentRef.current === item.segmentId;
        restoredRef.current = false;
        resumeSegmentRef.current = null;
        if (!skipCapsule) {
          await writerRef.current?.beginSegment(item.title, { index: item.index + 1, total: item.total }, item.anchor, item.segmentId);
        }
      }

      // 对话区逐句分段：每句一条消息，片段首句带标题分隔
      const isFirstBeat = segBeatIndexRef.current === 0;
      segBeatIndexRef.current += 1;
      setMessages((prev) => [
        ...prev,
        {
          id: `beat-${item.segmentId}-${segBeatIndexRef.current}-${Date.now()}`,
          role: "assistant",
          content: item.beat.say,
          createdAt: Date.now(),
          kind: "lecture",
          segmentId: item.segmentId,
          label: isFirstBeat ? `${item.index + 1} · ${item.title}` : undefined,
        },
      ]);
      // 电视字幕式：beat 按句切成字幕行，字幕一次只显示一行、语音逐句跟读
      const speechLines = splitSpeechLines(item.beat.say);
      if (speechLines[0]) setSubtitle(speechLines[0]);

      // 同步节拍：板书条目按句分配——说到哪句，那条板书才落笔（一句话带一个动作，不再整块先出后说）
      // 标题去重：小节标题与片段标题同文的不写；条目正文复述标题的也跳过——
      // 白板只写新信息，"标准语言"连写三遍这种事不能再发生
      const segTitleKey = normBoardText(item.title);
      let sectionForBoard: string | undefined = item.beat.section;
      const secKey = normBoardText(sectionForBoard || "");
      if (!secKey || secKey === segTitleKey || secKey === lastSectionKeyRef.current) {
        sectionForBoard = undefined;
      } else {
        lastSectionKeyRef.current = secKey;
      }
      const boardItems = (item.beat.items || [])
        .filter((it) => it && it.kind)
        .slice(0, 6)
        .filter((it) => {
          if (it.kind === "diagram" || it.kind === "cast" || it.kind === "circle" || it.kind === "underline" || it.kind === "burst") return true;
          const k = normBoardText((it as { text?: string }).text);
          return !k || (k !== segTitleKey && k !== secKey);
        });
      await writerRef.current?.beginBeat(sectionForBoard, boardItems.length);
      const itemAtLine = planItemLines(speechLines.length, boardItems.length);
      const nextBeatLines = queueRef.current[0] ? splitSpeechLines(queueRef.current[0].beat.say) : [];
      // 拍开始就把本拍全部字幕行 + 下一拍首行预取掉：上一句念完时下一句音频已在手。
      // 旧的逐行预取只提前一句、和念的耗时打平，一有抖动就得干等（实测踩过）。
      // 静音时仍不预取：为永远不会播的句子付合成费是纯浪费，取消静音后下一拍恢复。
      if (voiceOnRef.current) {
        for (const line of speechLines) prefetchTts(line);
        prefetchTts(nextBeatLines[0]);
      }
      let drawn = 0;
      let li = 0;
      while (li < speechLines.length) {
        if (pausedRef.current || exitedRef.current) {
          replayReqRef.current = false;
          break;
        }
        setSubtitle(speechLines[li]);
        while (drawn < boardItems.length && itemAtLine[drawn] <= li) {
          await writerRef.current?.writeItem(boardItems[drawn]);
          writerRef.current?.highlightLast(); // 荧光笔跟随：正在念的这句对应哪条，视觉上锚住
          drawn += 1;
        }
        await speak(speechLines[li]);
        // 重听本句：原地再讲一遍，不前进（跳过则无需标记——speak 被叫停后自然落进下一句）
        if (replayReqRef.current) {
          replayReqRef.current = false;
          continue;
        }
        li += 1;
      }
      // 收尾兜底：句子里没排上的条目（超短拍/中途暂停）在本拍结束前补齐，板书不缺内容
      while (drawn < boardItems.length) {
        await writerRef.current?.writeItem(boardItems[drawn]);
        drawn += 1;
      }
      if (item.lastOfSegment) writerRef.current?.removePencil();

      // 片段收尾：有课堂练习则停下来，选项内嵌在字幕区等学员作答
      if (item.lastOfSegment) {
        const cp = segCheckpointRef.current.get(item.segmentId);
        if (cp && cp.question && cp.options.length > 0) {
          setCheckpoint({ id: item.segmentId, question: cp.question, options: cp.options });
          writerRef.current?.characterAsk(true); // 角色举手出题，头顶浮问号
          setMessages((prev) => [
            ...prev,
            {
              id: `checkpoint-${item.segmentId}-${Date.now()}`,
              role: "assistant",
              content: `小练一下：${cp.question}`,
              createdAt: Date.now(),
              kind: "highlight",
              segmentId: item.segmentId,
            },
          ]);
          pausePlayback();
          cursorAdvance = 0;
        }
      }

      // 进度上报（节流 2.5s）：白板快照 + 播放游标 + 对话记录 → 服务端持久化
      const now = Date.now();
      if (now - lastSaveRef.current > 2500) {
        lastSaveRef.current = now;
        try {
          const elements = (excalidrawApiRef.current?.getSceneElements?.() || []).filter((el: any) => !el.isDeleted);
          wsSend({
            type: "progress",
            cursor: item.ordinal + cursorAdvance,
            elements,
            messages: messagesRef.current.slice(-50), // 裁剪上报量：整课无界增长会撞 WS 8MB 上限被断连
            points: wsPointsRef.current,
            writer: writerRef.current?.snapshot(),
          });
        } catch {
          // 快照失败不影响播放
        }
      }
    } finally {
      playingRef.current = false;
    }
    if (!pausedRef.current && !exitedRef.current) {
      window.setTimeout(() => void pump(), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak, pausePlayback]);

  const resumePlayback = useCallback(() => {
    if (exitedRef.current) return;
    writerRef.current?.characterAsk(false); // 收起问号，角色回平常姿势
    if (playbackRef.current === "done") return;
    if (queueRef.current.length === 0 && streamDoneRef.current) {
      // 队列空且脚本流已结束 = 没有更多内容：收尾进入 done，
      // 而不是永远停在 paused（最后一个片段带 checkpoint 时必现的死锁）
      pausedRef.current = false;
      setPlayback("done");
      return;
    }
    pausedRef.current = false;
    setPlayback("playing");
    void pump();
  }, [pump]);

  /** beats 事件入队并尝试启动播放 */
  const enqueueBeats = useCallback(
    (e: Extract<WhiteboardEvent, { type: "beats" }>) => {
      setPreparing(false);
      // 同一片段重发只更新登记信息，不重复入队（否则同样内容会播两遍）
      const firstDelivery = !sseSegmentsRef.current.has(e.segmentId);
      sseSegmentsRef.current.add(e.segmentId);
      if (e.checkpoint?.question && e.checkpoint.options?.length) {
        segCheckpointRef.current.set(e.segmentId, { question: e.checkpoint.question, options: e.checkpoint.options });
      }
      if (firstDelivery) {
        e.beats.forEach((beat, bi) => {
          queueRef.current.push({
            segmentId: e.segmentId,
            index: e.index,
            total: e.total,
            title: e.title,
            anchor: e.anchor,
            beat,
            lastOfSegment: bi === e.beats.length - 1,
            ordinal: nextOrdinalRef.current++,
          });
        });
      }
      // 剧本上报服务端（WS 持久化，用于断线恢复）
      wsScriptRef.current = [
        ...wsScriptRef.current.filter((s) => s.segmentId !== e.segmentId),
        { segmentId: e.segmentId, index: e.index, total: e.total, title: e.title, anchor: e.anchor, beats: e.beats, checkpoint: e.checkpoint || null },
      ];
      if (Array.isArray(e.points) && e.points.length > 0) wsPointsRef.current = e.points;
      wsSend({ type: "script", segments: wsScriptRef.current, points: wsPointsRef.current });
      void pump();
    },
    [pump, wsSend]
  );

  // ---- 开讲：拉取整节课的 beat 脚本，边到边播 ----
  const startLecture = useCallback(async () => {
    const gen = ++lectureGenRef.current;
    streamDoneRef.current = false;
    sseSegmentsRef.current.clear();
    const controller = new AbortController();
    abortLectureRef.current = controller;
    setError(null);
    setPreparing(true);
    try {
      // 备课正常十几秒，慢网/服务抖动也给个 3 分钟硬上限：不能让学员对着"正在备课"永远等
      const timeout = AbortSignal.timeout(3 * 60_000);
      const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, timeout]) : controller.signal;
      const res = await fetch("/api/teach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_teaching", courseId, unitId, lectureId }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
      await consumeSse<WhiteboardEvent>(res, (e) => {
        if (lectureGenRef.current !== gen) return; // 旧流（已被 abort/替换）的事件全部丢弃
        if (e.type === "beats") {
          setPrepStage(null); // 第一拍到了：备课态结束
          enqueueBeats(e);
        } else if (e.type === "stage") {
          // 服务端逐片段上报备课进度（拆片段 → 写剧本 1/6 → …），不再是一句笼统的"正在备课"
          const d = e.detail || "";
          setPrepStage(/^\d+\/\d+$/.test(d) ? `正在编写剧本 ${d} · ${e.label}` : d ? `${e.label} · ${d}` : e.label);
        } else if (e.type === "doc_pages") {
          // 本节课引用的文档原文页：右上角"对照原文"入口点亮
          setDocPages({ docTitle: e.docTitle, pages: e.pages });
        } else if (e.type === "lecture_quiz") {
          // 课后练习已出好：讲完后从字幕条入口作答
          setLectureQuiz(e.quiz);
        } else if (e.type === "error") {
          setError(e.message);
          setPreparing(false);
        } else if (e.type === "credits_block") {
          setError(
            `积分不足：${e.reason}需要 ${e.need} 积分，当前余额 ${e.balance}。注册赠送 20 积分（生成一门课 10 分，首次听一节课 1 分、复习免费）。`
          );
          setPreparing(false);
        } else if (e.type === "done") {
          streamDoneRef.current = true;
          setPreparing(false);
          // 开讲扣过积分了：通知侧栏刷新余额
          window.dispatchEvent(new Event("ll:credits-changed"));
          if (!playingRef.current && queueRef.current.length === 0 && !pausedRef.current) {
            setPlayback("done");
          }
        }
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(friendlyError(e));
        setPreparing(false);
      }
    } finally {
      // 只有当前代才收尾：被 abort 的旧流不得把新进行中的流标记为已结束
      if (lectureGenRef.current === gen) {
        streamDoneRef.current = true;
        setPreparing(false);
      }
    }
  }, [courseId, unitId, lectureId, enqueueBeats]);

  // ---- 学员打断/答题：打断播放，问答后自动断点续播 ----
  // simpler=true 是「没跟上」：一键求讲师用大白话重讲刚讲完的那一段（含白板补课卡）。
  const sendChat = useCallback(
    async (
      raw: string,
      checkpointInfo?: { question: string; options: string[] },
      simpler?: boolean
    ) => {
      const content = raw.trim();
      if (!content || chatStreaming || exitedRef.current) return;
      // 记住提问前的播放状态：学员手动暂停时提问，答完不应被强行续播（答 checkpoint 除外）
      const wasPlaying = playbackRef.current === "playing";
      pausePlayback();

      const userMsg: WhiteboardMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: checkpointInfo ? `我选：${content}` : content,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setChatStreaming(true);
      setDraft("");
      setError(null);

      const history = messagesRef.current.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      const controller = new AbortController();
      abortChatRef.current = controller;
      let acc = "";
      try {
        // 提问响应给 90 秒硬上限：流式回答挂起时不能让"正在思考"永远转下去
        const timeout = AbortSignal.timeout(90_000);
        const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, timeout]) : controller.signal;
        const res = await fetch("/api/teach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "chat",
            courseId,
            unitId,
            lectureId,
            message: content,
            history,
            context: {
              segmentTitle: currentSegmentRef.current || undefined,
              boardOutline: writerRef.current?.outline().join("、") || undefined,
              checkpointQuestion: checkpointInfo?.question,
              checkpointOptions: checkpointInfo?.options,
              simpler: simpler ? true : undefined,
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        await consumeSse<WhiteboardEvent>(res, (e) => {
          if (e.type === "token") {
            acc += e.text;
            setDraft(acc);
          } else if (e.type === "board_aside") {
            // 「没跟上」补课卡：把大白话小结钉到白板上，之后随时能回看
            void writerRef.current?.write(e.title, e.items);
          } else if (e.type === "achievement") {
            setAchievement({ title: e.title, desc: e.desc });
          } else if (e.type === "error") {
            setError(e.message);
          }
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError(friendlyError(e));
        }
      } finally {
        setChatStreaming(false);
        setDraft("");
        if (acc) {
          setMessages((prev) => [
            ...prev,
            { id: `assistant-${Date.now()}`, role: "assistant", content: acc, createdAt: Date.now() },
          ]);
        }
        // 真实课堂行为：讲师答完学员的问题，自动接着讲课。
        // 已退出课堂则绝不续播（否则组件卸载后 TTS 会继续朗读，且无 UI 可停）；
        // 提问前本来就暂停的，保持暂停。
        // 答案按长度给保留阅读时间：文字答案一闪而过 = 用户以为提问没被理。
        if (!exitedRef.current && (checkpointInfo || wasPlaying)) {
          const readingMs = Math.min(6000, 1200 + acc.length * 55);
          window.setTimeout(() => resumePlayback(), readingMs);
        }
      }
    },
    [chatStreaming, courseId, unitId, lectureId, pausePlayback, resumePlayback]
  );
  sendChatRef.current = sendChat;

  // 进入课节：点过"开始学习"且白板就绪才真正启动（预告卡是课堂的仪式入口，也正好给
  // Excalidraw 首次加载留时间；未就绪就开讲，前几拍板书会写进空气）。恢复路径同样等就绪。
  // React 18 StrictMode 会双挂载：cleanup 时复位 startedRef，二次挂载可重新开始。
  useEffect(() => {
    if (startedRef.current || introCard || restoredRef.current || !boardReady) return;
    startedRef.current = true;
    const cleanup = () => {
      abortLectureRef.current?.abort();
      startedRef.current = false;
    };

    // 有已保存的课堂状态（播放过）→ 走恢复：还原白板画面 + 断点续播，不走 SSE。
    // 画面元素可能为空（如断线前白板还没就绪）：只要剧本在，就恢复游标继续，别从头重播
    const saved = savedStateRef.current;
    if (saved && (saved.cursor || 0) > 0 && (saved.script?.length || 0) > 0) {
      restoredRef.current = true;
      battleFreshRef.current = false; // 恢复路径不再重画战况图、结课也不再盖章（画面里已含）
      resumeSegmentRef.current = typeof saved.writer?.lastSegmentKey === "string" ? saved.writer.lastSegmentKey : null;
      try {
        excalidrawApiRef.current?.updateScene({ elements: saved.elements || [] });
        writerRef.current?.restore(saved.writer || {});
        writerRef.current?.recolor(); // 恢复出的旧板书按当前配色重着色
        // 镜头对准恢复出的黑板（否则 Excalidraw 停在默认原点，画面空一块）
        window.setTimeout(() => writerRef.current?.focusCurrent(), 200);
      } catch {
        // 画面恢复失败也不阻塞续播
      }
      setMessages((saved.messages || []) as WhiteboardMessage[]);

      // 重建队列：只重播 cursor 之后的 beat（画面已包含 cursor 之前的内容）
      let ordinal = 0;
      const segs = [...(saved.script || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const seg of segs) {
        segCheckpointRef.current.set(
          seg.segmentId,
          seg.checkpoint ? { question: seg.checkpoint.question || "", options: seg.checkpoint.options || [] } : { question: "", options: [] }
        );
        (seg.beats || []).forEach((beat: TeachBeat, bi: number) => {
          const ord = ordinal++;
          if (ord < (saved.cursor || 0)) return;
          queueRef.current.push({
            segmentId: seg.segmentId,
            index: seg.index,
            total: seg.total,
            title: seg.title,
            anchor: seg.anchor,
            beat,
            lastOfSegment: bi === (seg.beats?.length || 0) - 1,
            ordinal: ord,
          });
        });
      }
      wsScriptRef.current = segs;
      wsPointsRef.current = saved.points || [];
      streamDoneRef.current = true;
      setPreparing(false);
      if (chatMode === "voice") {
        window.setTimeout(() => startListening(), 800);
      }
      pausedRef.current = false;
      setPlayback("playing");
      void pump();
      return cleanup;
    }

    // 全新开课：第一画先把"我的征途"（结课作品骨架）画在长卷最左，再开讲。
    // 镜头先给地图再上路（以终为始），教学模块从地图右侧接纸。
    setPlayback("idle");
    battleFreshRef.current = true;
    if (chatMode === "voice") {
      window.setTimeout(() => startListening(), 1200);
    }
    void (async () => {
      await writerRef.current?.drawBattleMap(battleMapRef.current);
      if (exitedRef.current) return;
      void startLecture();
    })();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, unitId, lectureId, introCard, boardReady]);

  const beginLecture = async () => {
    // 第一次进课堂填了称呼 → 记住，之后不再问（登录后此值从账号自动同步）
    const name = introName.trim();
    if (profileName === "" && name) {
      setProfileName(name);
      try {
        await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } catch {
        // 保存失败不阻塞开课
      }
    }
    // 开讲/恢复都交给上面的 effect：introCard 翻 false 且白板就绪才启动；
    // 未就绪时字幕区会显示"正在准备白板…"，就绪后自动续上
    setIntroCard(false);
  };

  useEffect(() => {
    exitedRef.current = false; // StrictMode 二次挂载时复位，不能只在 cleanup 置位
    return () => {
      exitedRef.current = true; // 卸载后 pump/speak/续播全部短路，杜绝幽灵朗读
      speechStopRef.current?.(); // 云端音频走 <audio>，必须显式停
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  // 聊天自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, draft]);

  const handleExit = () => {
    exitedRef.current = true; // 先置位：进行中的问答流 finally 里的续播会被短路
    abortLectureRef.current?.abort();
    abortChatRef.current?.abort();
    pausedRef.current = true;
    stopListening();
    stopCloudCapture();
    speechStopRef.current?.(); // 云端音频走 <audio>，必须显式停
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    onExit?.();
  };

  const toggleVoice = () => {
    setVoiceOn((on) => {
      const next = !on;
      if (!next) speechStopRef.current?.();
      return next;
    });
  };

  const answerCheckpoint = (answer: string) => {
    const cp = checkpoint;
    setCheckpoint(null);
    if (cp) void sendChat(answer, { question: cp.question, options: cp.options });
  };

  // ---- 产物〇：知识地图（讲完本节，把知识卡片长图画到长卷末尾；与 /comic 知识地图共用同一份数据） ----
  const generateKnowledgeMap = async () => {
    if (kbBusy || kbDone) return;
    setKbBusy(true);
    setPosterMsg(null);
    try {
      const res = await fetch("/api/comic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "storyboard_knowledge", courseId, unitId, lectureId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "知识地图生成失败");
      const kb = data.storyboard as KnowledgeStoryboard;
      const api = excalidrawApiRef.current;
      if (!api) throw new Error("白板还没就绪");
      // 长卷末尾 = 当前场景最大底边
      let maxY = 0;
      for (const e of api.getSceneElements?.() || []) {
        if (e.isDeleted) continue;
        const bottom = (e.y || 0) + (e.height || 0);
        if (bottom > maxY) maxY = bottom;
      }
      const { elements, height } = renderKnowledgeMapSkeleton(kb, 60, maxY + 90);
      void height;
      const mod = await import("@excalidraw/excalidraw");
      const converted = mod.convertToExcalidrawElements(elements as any);
      const keep = (api.getSceneElements?.() || []).filter((e: any) => !e.isDeleted);
      api.updateScene({ elements: [...keep, ...converted] });
      try {
        api.scrollToContent(converted, { fitToViewport: true, viewportZoomFactor: 0.8 });
      } catch {
        // 老版本 API 不支持数组入参，忽略（用户可自己拖到末尾）
      }
      setKbDone(true);
      setPosterMsg({ text: "知识地图已长到长卷末尾，往下滚就是" });
      window.setTimeout(() => setPosterMsg(null), 3200);
    } catch (e) {
      setPosterMsg({ text: e instanceof Error ? e.message : "知识地图生成失败" });
      window.setTimeout(() => setPosterMsg(null), 3200);
    } finally {
      setKbBusy(false);
    }
  };

  // ---- 产物一：知识海报（优先讲义式：片段要点+图表+金句；无剧本时退回白板终态） ----
  const generatePoster = async () => {
    if (posterBusy) return;
    setPosterBusy(true);
    setPosterMsg(null);
    try {
      let blob: Blob;
      const segs = [...wsScriptRef.current].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (segs.length > 0) {
        ({ blob } = await exportScriptPoster({
          segments: segs.map((seg) => ({
            title: seg.title,
            beats: (seg.beats || []).map((b: TeachBeat) => ({ say: b.say, items: b.items })),
          })),
          courseTitle: outline.title,
          lectureTitle,
          studentName: profileNameRef.current || undefined,
        }));
      } else {
        ({ blob } = await exportBoardPoster({
          api: excalidrawApiRef.current,
          courseTitle: outline.title,
          lectureTitle,
          studentName: profileNameRef.current || undefined,
        }));
      }
      downloadBlob(blob, `learnloop_poster_${safeFilename(lectureTitle)}.png`);
      const copied = await copyImageToClipboard(blob);
      setPosterMsg({ text: copied ? "海报已下载并复制到剪贴板" : "海报已下载" });
      window.setTimeout(() => setPosterMsg(null), 2600);
    } catch (e) {
      setPosterMsg({ text: e instanceof Error ? e.message : "海报生成失败" });
      window.setTimeout(() => setPosterMsg(null), 3200);
    } finally {
      setPosterBusy(false);
    }
  };

  // ---- 产物二：回放链接（讲完自动把剧本存为只读回放页） ----
  const buildReelFromScript = useCallback((): ReplayReel | null => {
    const segs = [...wsScriptRef.current].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const beats = segs.flatMap((seg) =>
      (seg.beats || []).map((b: TeachBeat) => ({
        say: b.say,
        section: b.section,
        items: b.items,
        segmentTitle: seg.title,
      }))
    );
    if (beats.length === 0) return null;
    return {
      courseId,
      unitId,
      lectureId,
      courseTitle: outline.title,
      lectureTitle,
      createdAt: Date.now(),
      beats,
    };
  }, [courseId, unitId, lectureId, outline.title, lectureTitle]);

  const saveReplay = useCallback(async (): Promise<string> => {
    if (replayUrl) return replayUrl;
    const reel = buildReelFromScript();
    if (!reel) return "";
    try {
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reel),
      });
      if (!res.ok) return "";
      const d = await res.json();
      if (d.id) {
        const url = `${window.location.origin}/replay/${d.id}`;
        setReplayUrl(url);
        return url;
      }
    } catch {
      // 保存失败不影响上课
    }
    return "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildReelFromScript, replayUrl]);

  const copyReplayLink = async () => {
    // 未讲完：不再"先开空白标签再关掉"——那是用户眼里的闪屏事故。直接说明，讲完自动生成。
    if (!replayUrl && playbackRef.current !== "done") {
      setPosterMsg({ text: "回放还没准备好：讲师讲完本节会自动生成，到时点这里就能分享" });
      window.setTimeout(() => setPosterMsg(null), 3200);
      return;
    }
    // 已有链接：同步打开（用户手势窗口内，不会被弹窗拦截）并复制
    if (replayUrl) {
      window.open(replayUrl, "_blank");
      try {
        await navigator.clipboard.writeText(replayUrl);
        setPosterMsg({ text: "回放已在新的标签页打开，链接也复制好了，发给朋友看同一条" });
      } catch {
        setPosterMsg({ text: "回放已在新的标签页打开（链接复制失败，可在地址栏复制）" });
      }
      window.setTimeout(() => setPosterMsg(null), 3200);
      return;
    }
    // 讲完但还没存过：生成后不自动开窗（await 之后开窗会被浏览器拦截），用 toast 里的链接打开
    const url = await saveReplay();
    if (!url) {
      setPosterMsg({ text: "回放生成失败，稍后再试一次" });
      window.setTimeout(() => setPosterMsg(null), 3200);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 剪贴板权限失败不影响链接本身
    }
    setPosterMsg({ text: "回放已生成，链接已复制，发给朋友看同一条", href: url });
    window.setTimeout(() => setPosterMsg(null), 6000);
  };

  // 讲完自动保存回放（一次）
  useEffect(() => {
    if (playback !== "done" || replaySavedRef.current) return;
    const reel = buildReelFromScript();
    if (!reel) return;
    replaySavedRef.current = true;
    void saveReplay();
  }, [playback, buildReelFromScript, saveReplay]);

  // ---- 产物三：60 秒竖屏速览的素材（从剧本里均匀取拍） ----
  const buildClipBeats = useCallback((): ClipBeat[] => {
    const segs = [...wsScriptRef.current].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const flat = segs.flatMap((seg) =>
      (seg.beats || []).map((b: TeachBeat) => ({
        say: b.say,
        section: b.section,
        items: b.items || [],
        segmentTitle: seg.title,
      }))
    );
    if (flat.length === 0) return [];
    const N = Math.min(7, flat.length);
    const picked: typeof flat = [];
    for (let i = 0; i < N; i++) {
      picked.push(flat[Math.round((i * (flat.length - 1)) / (N - 1))]);
    }
    let lastSection = "";
    return picked.map((b) => {
      if (b.section) lastSection = b.section;
      const withText = b.items.find((it: { text?: string; kind: string }) => it.text && it.kind !== "note");
      const keyText =
        withText?.text ||
        (b.items.find((it: { kind: string }) => it.kind === "diagram")?.nodes || []).join("→") ||
        b.say.slice(0, 12);
      return {
        keyText: keyText.slice(0, 20),
        sectionLabel: lastSection || b.segmentTitle,
        say: b.say,
      };
    });
  }, []);

  // ---- 语音输入（文字模式下的辅助：说完填入输入框；语音模式用顶栏的自动聆听） ----
  const manualRecRef = useRef<any>(null);
  const toggleMic = () => {
    if (chatMode === "voice") {
      // 语音模式：麦克风按钮切换"自动聆听"（说话即打断）
      toggleAutoListen();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("当前浏览器不支持语音输入，请用 Chrome / Edge");
      return;
    }
    if (listening) {
      manualRecRef.current?.stop();
      setListening(false);
      return;
    }
    try {
      const rec = new SR();
      rec.lang = "zh-CN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: any) => {
        const text = e.results?.[0]?.[0]?.transcript || "";
        if (text) setInput((prev) => (prev ? `${prev}${text}` : text));
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      manualRecRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  // 退出课堂：不再清空恢复状态——主动离开和刷新/断线同等对待，下次进来从暂停处继续。
  // 此前主动退出会清掉服务端快照（"从头重学"），误触一次 × 的代价是整节课归零，太重了。
  // 服务端的 "end" 消息保留但客户端不再发送；未来"重听本节"功能可以接上。

  // 适应内容：把整块已写板书收进视口（自算 scroll/zoom，scrollToContent 在 viewMode 下会失效）
  const fitAll = () => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const els = api.getSceneElements().filter((el: any) => !el.isDeleted && el.id !== "camera-anchor" && el.id !== "pencil-cursor");
    if (els.length === 0) return;
    const minX = Math.min(...els.map((e: any) => e.x));
    const minY = Math.min(...els.map((e: any) => e.y));
    const maxX = Math.max(...els.map((e: any) => e.x + (e.width || 0)));
    const maxY = Math.max(...els.map((e: any) => e.y + (e.height || 0)));
    const st = api.getAppState();
    const vpW = st.width || 1100;
    const vpH = st.height || 620;
    const w = maxX - minX + 120;
    const h = maxY - minY + 220;
    const zoom = Math.max(0.3, Math.min(1.4, Math.min(vpW / w, vpH / h)));
    api.updateScene({
      appState: {
        scrollX: -(minX - 60 + w / 2) + vpW / (2 * zoom),
        scrollY: -(minY - 110 + h / 2) + vpH / (2 * zoom),
        zoom: { value: zoom },
      },
    });
  };

  return (
    <div
      ref={classroomRootRef}
      className="classroom-sunny fixed inset-0 flex flex-col z-50"
      style={{ ...boardCssVars(), ...CHROME_VARS, backgroundColor: "var(--board-bg)" } as React.CSSProperties}
    >
      {/* 顶部栏（Hyperknow 风格：标题 + 播放控制 + 缩放 + 操作） */}
      {/* 顶部栏（Hyperknow 风格：标题 + 播放控制 + 缩放 + 操作）；窄屏下控制组横向滚动，不再溢出 */}
      <div className="h-14 border-b border-[#e6e8eb] flex items-center justify-between gap-3 px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setExitConfirmOpen(true)}
            className="text-ink-soft hover:text-ink text-[18px] leading-none"
            aria-label="退出课堂"
            title="退出课堂（进度会保留）"
          >
            ×
          </button>
          <div className="text-[14px] font-medium truncate max-w-md">{lectureTitle}</div>
          <span
            className="hidden md:inline-block rounded-full bg-[#f3f4f6] px-2 py-0.5 text-[10px] text-ink-soft shrink-0"
            title="AI 生成内容可能存在错误，请以权威来源为准"
          >
            AI 生成
          </span>
        </div>
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto py-1" role="toolbar" aria-label="课堂控制">
          {(playback === "playing" || playback === "paused") && (
            <button
              onClick={playback === "playing" ? pausePlayback : resumePlayback}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                playback === "paused" ? "border-accent text-accent" : "border-[#e6e8eb] text-ink-soft"
              }`}
            >
              <Icon name={playback === "playing" ? "pause" : "play"} />
              {playback === "playing" ? "暂停" : "播放"}
            </button>
          )}
          <button
            onClick={toggleVoice}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${voiceOn ? "border-accent text-accent" : "border-[#e6e8eb] text-ink-soft"}`}
            aria-pressed={voiceOn}
            title={voiceOn ? "关闭语音讲解" : "开启语音讲解"}
          >
            <Icon name={voiceOn ? "voice" : "voice-off"} />
            {voiceOn ? "语音" : "静音"}
          </button>
          {/* 语速：嫌节奏慢就提速 */}
          <button
            onClick={() => setRate((r) => (r >= 2 ? 1 : Math.round((r + 0.25) * 100) / 100))}
            className="flex items-center gap-1.5 rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
            title="讲解语速（点击切换）"
          >
            <Icon name="speed" />
            {rate}x
          </button>
          <button
            onClick={toggleAutoListen}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
              micArmed ? "border-accent text-accent animate-pulse" : "border-[#e6e8eb] text-ink-soft"
            }`}
            aria-pressed={micArmed}
            title={micArmed ? "自动聆听中：开口即打断 · 点击暂停聆听" : "开启自动聆听：开口说话即打断老师"}
          >
            <Icon name="mic" />
            {micArmed ? "聆听中" : "聆听"}
          </button>
          {/* 缩放控制（全课堂唯一一处；读数由 Whiteboard onChange 实时回报，运镜时不再显示旧值） */}
          <div className="flex items-center border border-[#e6e8eb] rounded-lg overflow-hidden">
            <button
              onClick={() => excalidrawApiRef.current?.updateScene({ appState: { ...excalidrawApiRef.current.getAppState(), zoom: { value: Math.max(0.2, (excalidrawApiRef.current.getAppState().zoom?.value || 1) - 0.1) } } })}
              className="px-2.5 py-1.5 text-ink-soft hover:bg-[#f3f4f6]"
              aria-label="缩小"
              title="缩小"
            >
              <Icon name="zoom-out" />
            </button>
            <button
              onClick={() => excalidrawApiRef.current?.updateScene({ appState: { ...excalidrawApiRef.current.getAppState(), zoom: { value: 1 } } })}
              className="px-2 py-1.5 text-[11px] text-ink-soft hover:bg-[#f3f4f6] min-w-[3rem] text-center border-x border-[#e6e8eb]"
              title="重置为 100%"
            >
              {zoomPct}%
            </button>
            <button
              onClick={() => excalidrawApiRef.current?.updateScene({ appState: { ...excalidrawApiRef.current.getAppState(), zoom: { value: Math.min(3, (excalidrawApiRef.current.getAppState().zoom?.value || 1) + 0.1) } } })}
              className="px-2.5 py-1.5 text-ink-soft hover:bg-[#f3f4f6]"
              aria-label="放大"
              title="放大"
            >
              <Icon name="zoom-in" />
            </button>
          </div>
          {/* 适应内容 */}
          <button
            onClick={fitAll}
            className="rounded-lg border border-[#e6e8eb] px-2.5 py-1.5 text-ink-soft hover:border-accent hover:text-accent"
            title="适应内容：把整块板书收进视口"
            aria-label="适应内容"
          >
            <Icon name="fit" />
          </button>
          {/* 对照原文（文档建课模式）：讲师讲到的原文页 */}
          {docPages && (
            <button
              onClick={() => setDocOpen((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                docOpen ? "border-accent text-accent" : "border-[#e6e8eb] text-ink-soft hover:border-accent hover:text-accent"
              }`}
              title="查看讲师本节课引用的上传文档原文"
            >
              对照原文
            </button>
          )}
          {/* 传播产物：海报 / 竖屏速览 / 回放链接。海报 = 全节讲义，讲完才生成，保证与白板终态一致。
              未就绪的按钮用外层 span 承接点击给出解释——disabled 按钮点了没反应，用户只会以为坏了 */}
          <span
            onClick={() => {
              if (playback !== "done" && !posterBusy) {
                setPosterMsg({ text: "海报讲完本节才能生成：内容是整节讲义，和板书终态一致" });
                window.setTimeout(() => setPosterMsg(null), 3200);
              }
            }}
            className="inline-flex"
            title={playback === "done" ? "把整节讲义生成竖版知识海报" : "讲完本节后可生成（内容为整节讲义，和板书终态一致）"}
          >
            <button
              onClick={() => void generatePoster()}
              disabled={posterBusy || playback !== "done"}
              className="flex items-center gap-1.5 rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-45 disabled:hover:border-[#e6e8eb] disabled:hover:text-ink-soft disabled:cursor-not-allowed"
            >
              <Icon name="poster" />
              {posterBusy ? "生成中…" : "海报"}
            </button>
          </span>
          {/* 知识地图：讲完本节后把知识卡片长图画到长卷末尾（与 /comic 知识地图共用数据） */}
          <button
            onClick={() => void generateKnowledgeMap()}
            disabled={kbBusy || playback !== "done"}
            className="flex items-center gap-1.5 rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-45 disabled:hover:border-[#e6e8eb] disabled:hover:text-ink-soft disabled:cursor-not-allowed"
            title={playback === "done" ? "把这节课的知识地图画到白板长卷末尾" : "讲完本节后可生成"}
          >
            {kbBusy ? "长出中…" : kbDone ? "知识地图 ✓" : "知识地图"}
          </button>
          <button
            onClick={() => setClipOpen(true)}
            disabled={wsScriptRef.current.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
            title="录一条 60 秒竖屏速览视频，直接发抖音/小红书"
          >
            <Icon name="clip" />
            竖屏速览
          </button>
          <span
            onClick={() => {
              if (!replayUrl && playbackRef.current !== "done") {
                setPosterMsg({ text: "回放还没准备好：讲师讲完本节会自动生成，到时点这里就能分享" });
                window.setTimeout(() => setPosterMsg(null), 3200);
              }
            }}
            className="inline-flex"
            title={replayUrl || playback === "done" ? "打开只读回放页（自己回看 / 复制链接发给朋友）" : "讲完本节后自动生成回放"}
          >
            <button
              onClick={() => void copyReplayLink()}
              disabled={!replayUrl && playback !== "done"}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                replayUrl ? "border-accent text-accent" : "border-[#e6e8eb] text-ink-soft enabled:hover:border-accent enabled:hover:text-accent"
              }`}
            >
              <Icon name="link" />
              回放
            </button>
          </span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 课后练习面板 */}
        {quizOpen && lectureQuiz && lectureQuiz.length > 0 && (
          <LectureQuizPanel quiz={lectureQuiz} onClose={() => setQuizOpen(false)} />
        )}

        {/* 成就徽章弹窗：暗蒙层聚焦（白色蒙层会让整页像没加载完） */}
        {achievement && (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-[#16181c]/45 backdrop-blur-[2px]">
            <div className="w-[430px] max-w-[88%] rounded-3xl border border-[#e6e8eb] bg-white shadow-2xl p-7 flex items-start gap-5 fade-up">
              <div className="text-accent leading-none select-none">
                <Icon name="medal" />
              </div>
              <div className="flex-1">
                <div className="text-[11px] text-accent font-semibold tracking-[.1em] mb-1">课堂成就</div>
                <div className="text-[20px] font-bold leading-snug mb-1.5">{achievement.title}</div>
                <div className="text-[12.5px] text-ink-soft leading-relaxed">{achievement.desc}</div>
                <button
                  onClick={() => setAchievement(null)}
                  className="mt-4 rounded-lg bg-accent px-5 py-2 text-[12.5px] text-white hover:opacity-90"
                >
                  知道了
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 白板主体 */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {introCard && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#16181c]/45 backdrop-blur-[2px]">
              <div className="w-[420px] max-w-[90%] rounded-3xl border border-[#e6e8eb] bg-white shadow-xl p-8 fade-up">
                <div className="text-[11px] text-ink-faint uppercase tracking-[.12em] mb-2">本节学习内容</div>
                <div className="text-[21px] font-bold leading-snug mb-3">{lectureTitle}</div>
                <div className="text-[13px] text-ink-soft leading-relaxed mb-5">
                  {unit?.lectures.find((l) => l.id === lectureId)?.summary ||
                    `围绕「${lectureTitle}」的白板讲解，边讲边画，随时打断提问。`}
                </div>
                <div className="flex items-center gap-2 mb-5">
                  {(unit?.lectures.find((l) => l.id === lectureId)?.depth_tags || []).map((tag) => (
                    <span key={tag} className="rounded-full bg-[#f3f4f6] px-2.5 py-0.5 text-[11px] text-ink-soft">
                      {tag}
                    </span>
                  ))}
                  <span className="text-[11px] text-ink-faint">
                    约 {unit?.lectures.find((l) => l.id === lectureId)?.duration_min ?? 20} 分钟
                  </span>
                </div>
                {/* 交流方式：记住上次选择，默认选中，不再每次从零问起 */}
                <div className="mb-5">
                  <div className="text-[12.5px] font-medium mb-2">你想怎样和老师交流？</div>
                  <div className="space-y-2">
                    {([
                      { key: "text", title: "仅用文字", desc: "在输入框里打字提问，老师照常讲解和板书。", beta: false },
                      { key: "voice", title: "语音 + 文字", desc: "直接开口说就行。老师一听到你说话就会停下来，先回答你的问题，再从暂停的地方继续讲。建议戴耳机。识别无反应时会自动切换云端识别，稍等片刻即可。", beta: true },
                    ] as const).map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => setChatMode(opt.key)}
                        className={`w-full text-left rounded-xl border px-3.5 py-2.5 transition-colors ${
                          chatMode === opt.key ? "border-accent bg-accent/5" : "border-[#e6e8eb] bg-white hover:border-accent/60"
                        }`}
                      >
                        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                          {opt.title}
                          {opt.key === "voice" && (
                            <span className="rounded bg-[#eef2f7] px-1.5 py-px text-[9.5px] text-[#1f3a5f]">BETA</span>
                          )}
                        </div>
                        <div className="text-[11.5px] text-ink-soft mt-0.5 leading-relaxed">{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                  {chatMode === "voice" && (
                    <div className="mt-2 text-[11px] text-ink-faint leading-relaxed">
                      进入课堂后点右上角 🎙 开启自动聆听；开口说话即打断，讲完自动续播。
                    </div>
                  )}
                </div>
                {/* 第一次进课堂：顺口问一次称呼（可跳过），之后自动记住不再显示 */}
                {profileName === "" && (
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-[12px] text-ink-faint shrink-0">怎么称呼你？（讲师会点名，可跳过）</span>
                    <input
                      value={introName}
                      onChange={(e) => setIntroName(e.target.value)}
                      placeholder="昵称"
                      className="flex-1 min-w-0 rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[13px] outline-none focus:border-accent"
                    />
                  </div>
                )}
                {/* 计费透明：进入前就把这一步花多少钱说清楚（数值与 lib/credits.ts 对应） */}
                <div className="mb-4 text-[11.5px] text-ink-faint">
                  首次听本节消耗 1 积分，复习免费；课堂提问不另收费（每节上限 30 条）。
                </div>
                <button
                  onClick={() => void beginLecture()}
                  className="w-full rounded-xl bg-accent py-3 text-[14px] font-medium text-white hover:opacity-90 transition-opacity"
                >
                  {(wsState?.cursor || 0) > 0 ? "▶ 继续学习（从上次暂停处）" : "开始学习"}
                </button>
              </div>
            </div>
          )}
          <Whiteboard
            onReady={(api) => {
              excalidrawApiRef.current = api;
              setBoardReady(true);
            }}
            onZoomChange={(z) => {
              const pct = Math.round(z * 100);
              setZoomPct((prev) => (prev === pct ? prev : pct));
            }}
            onBoardClick={(sx, sy) => {
              // 白板可点：点中某条板书 → 预填提问并打开对话面板（用户确认后再发送，不抢跑）
              const text = writerRef.current?.hitTest(sx, sy);
              if (typeof window !== "undefined" && (window as any).__board) {
                (window as any).__board.lastClick = { sx, sy, text };
              }
              if (!text) return;
              setChatOpen(true);
              setInput(`请把白板上「${text}」这条展开讲一讲，我还没完全懂`);
            }}
          />
          {/* 底部堆叠：弹题卡 / 聆听反馈各自成卡，字幕条常驻——弹题不再吃掉讲师正在说的那句话 */}
          <div className="board-bottom-stack">
            {checkpoint && (
              <div className="board-quiz">
                <div className="board-quiz-title">小练一下 · 答完讲师自动继续</div>
                <div className="board-quiz-q">{checkpoint.question}</div>
                <div className="board-quiz-options">
                  {checkpoint.options.map((option) => (
                    <button key={option} onClick={() => answerCheckpoint(option)} className="board-quiz-option">
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {voiceHeard && (
              <div className="board-voice-heard">
                <span className="board-voice-heard-label">
                  {voiceHeard.status === "interim" ? "正在听" : voiceHeard.status === "hint" ? "提示" : "听到"}
                </span>
                <span className="board-voice-heard-text">{voiceHeard.text}</span>
                {voiceHeard.status === "echo" && <span className="board-voice-heard-note">（与老师声音重叠，已忽略）</span>}
                {voiceHeard.status === "dup" && <span className="board-voice-heard-note">（重复，已忽略）</span>}
                {voiceHeard.status === "short" && <span className="board-voice-heard-note">（太短）</span>}
                {voiceHeard.status === "error" && <span className="board-voice-heard-note">（服务不稳，改用 Edge 或打字）</span>}
              </div>
            )}
            <div className="board-subtitle" aria-live="polite">
              {playback === "playing" && subtitle ? (
                <>
                  <span className="board-subtitle-label">讲师</span>
                  <span>{subtitle}</span>
                  {/* 句级控制：听漏了重听一遍，嫌慢直接跳过——此前唯一的控制是暂停整节课 */}
                  <span className="ml-2 flex items-center gap-1">
                    {/* 「没跟上」：听不懂时的一键求救——不用组织语言，讲师原地换大白话重讲 +
                        白板钉一张补课卡。也是导演层最该改哪里的埋点来源。 */}
                    <button
                      onClick={() => void sendChat("没跟上，请用更简单的话再讲一遍", undefined, true)}
                      className="board-resume-btn board-stuck-btn"
                      title="没听懂？让讲师用大白话把这一段重讲一遍（白板会补一张小卡片）"
                    >
                      🙋 没跟上
                    </button>
                    <button onClick={replayLine} className="board-resume-btn" title="把这句再讲一遍">↻ 重听</button>
                    <button onClick={skipLine} className="board-resume-btn" title="跳过这句，讲下一句">⏭ 跳过</button>
                  </span>
                </>
              ) : playback === "paused" ? (
                chatStreaming ? (
                  <span className="board-subtitle-idle">讲师作答中，答完自动从这里继续…</span>
                ) : (
                  <>
                    {/* 暂停也要看得到刚讲的那句：字幕消失会让学员失去"讲到哪了"的坐标 */}
                    {subtitle && (
                      <>
                        <span className="board-subtitle-label">讲师</span>
                        <span className="opacity-60">{subtitle}</span>
                      </>
                    )}
                    <span className="board-subtitle-idle">已暂停 · 可随时提问，或</span>
                    <button
                      onClick={() => void sendChat("没跟上，请用更简单的话再讲一遍", undefined, true)}
                      className="board-resume-btn board-stuck-btn"
                      title="没听懂？让讲师用大白话把这一段重讲一遍（白板会补一张小卡片）"
                    >
                      🙋 没跟上
                    </button>
                    <button onClick={resumePlayback} className="board-resume-btn">▶ 继续上课</button>
                  </>
                )
              ) : playback === "done" ? (
                <span className="board-subtitle-idle">
                  本节课讲完 · 可继续提问或回看板书
                  {lectureQuiz && lectureQuiz.length > 0 && (
                    <button onClick={() => setQuizOpen(true)} className="board-resume-btn ml-2">
                      做课后练习（{lectureQuiz.length} 题）
                    </button>
                  )}
                  <button onClick={() => void generatePoster()} disabled={posterBusy} className="board-resume-btn ml-2">
                    生成知识海报
                  </button>
                  <button onClick={() => void copyReplayLink()} className="board-resume-btn ml-2">
                    {replayUrl ? "复制回放链接" : "生成回放链接"}
                  </button>
                </span>
              ) : (
                <span className="board-subtitle-idle">
                  {!boardReady
                    ? "正在准备白板…"
                    : preparing
                      ? (wsState && (wsState.script?.length || 0) > 0
                          ? "正在恢复课堂…"
                          : prepStage || "AI 讲师正在备课…")
                      : "白板课堂"}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 对照原文面板（文档建课模式）：讲师本节课引用的上传文档页 */}
        {docOpen && docPages && (
          <div className="w-80 border-l border-[#e6e8eb] bg-[#fbfbfa] flex flex-col shrink-0">
            <div className="p-3 border-b border-[#e6e8eb] flex items-center justify-between">
              <span className="text-[13px] font-medium">对照原文</span>
              <button onClick={() => setDocOpen(false)} className="text-ink-soft hover:text-ink text-[14px]">
                ×
              </button>
            </div>
            <div className="px-3 pt-2 pb-1 text-[11px] text-ink-faint truncate">
              📄 {docPages.docTitle} · 讲师本节引用 {docPages.pages.length} 页
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {docPages.pages.map((p) => (
                <div key={p.page} className="rounded-xl border border-[#e6e8eb] bg-white p-3">
                  <div className="text-[11px] text-accent font-medium mb-1.5">第 {p.page} 页</div>
                  <div className="text-[12px] text-ink-soft leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto">
                    {p.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 右侧聊天 */}
        {chatOpen && (
          <div className="w-80 max-w-[85vw] border-l border-[#e6e8eb] bg-white flex flex-col shrink-0">
            <div className="p-3 border-b border-[#e6e8eb] flex items-center justify-between">
              <span className="text-[13px] font-medium">对话记录</span>
              <button
                onClick={() => setChatOpen(false)}
                className="text-ink-soft hover:text-ink text-[14px]"
              >
                ×
              </button>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
              {messages.length === 0 && !draft && !chatStreaming ? (
                <div className="text-[12px] text-ink-soft text-center pt-8">
                  {preparing ? "AI 讲师正在备课…" : "向 AI 提问，打断讲师"}
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`lesson-message rounded-xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap ${
                      m.role === "user" ? "bg-accent text-white ml-8" : m.kind === "highlight" ? "bg-[#eef2f7] text-ink mr-8" : m.kind === "board" ? "bg-[#f3f4f6] text-ink mr-8" : "bg-[#f3f4f6] text-ink mr-8"
                    }`}
                  >
                    {m.role === "assistant" && <div className="lesson-message-label">{m.label || (m.kind === "board" ? "白板动作" : m.kind === "highlight" ? "互动提问" : "课程讲解")}</div>}
                    <LessonMarkdown text={m.content} />
                  </div>
                ))
              )}
              {draft && (
                <div className="bg-[#f3f4f6] text-ink rounded-xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap mr-8">
                  <LessonMarkdown text={draft} />
                </div>
              )}
              {chatStreaming && !draft && (
                <div className="bg-[#f3f4f6] text-ink rounded-xl px-3 py-2 text-[13px] mr-8">
                  <span className="animate-pulse">AI 讲师正在思考…</span>
                </div>
              )}
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                  {error}
                </div>
              )}
            </div>
            <div className="p-3 border-t border-[#e6e8eb]">
              <div className="flex gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void sendChat(input);
                    }
                  }}
                  placeholder="输入问题，打断讲师…"
                  rows={1}
                  className="flex-1 resize-none rounded-lg border border-[#e6e8eb] px-3 py-2 text-[13px] outline-none focus:border-accent"
                />
                <button
                  onClick={toggleMic}
                  title="语音输入（说完自动填入）"
                  aria-pressed={listening}
                  className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                    listening ? "border-red-400 text-red-600 bg-red-50 animate-pulse" : "border-[#e6e8eb] text-ink-soft hover:border-accent hover:text-accent"
                  }`}
                >
                  {listening ? "●" : "🎙"}
                </button>
                <button
                  onClick={() => void sendChat(input)}
                  disabled={!input.trim() || chatStreaming}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* 底部控制栏 */}
      <div className="h-12 border-t border-[#e6e8eb] flex items-center justify-end px-4 shrink-0">
        <div className="flex items-center gap-2">
          {!chatOpen && (
            <button
              onClick={() => setChatOpen(true)}
              className="rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[12px] text-ink-soft"
            >
              打开对话
            </button>
          )}
        </div>
      </div>

      {/* 断连警示：连接断了必须被看见（重连 8 次失败后此前是无声死亡），给手动重连入口 */}
      {wsLost && (
        <div className="absolute left-1/2 -translate-x-1/2 top-16 z-[76] rounded-xl bg-[#b45309] px-4 py-2 text-[12.5px] text-white shadow-lg fade-up flex items-center gap-3">
          <span>与服务器的连接已断开，进度暂停保存</span>
          <button onClick={() => wsReconnect()} className="underline underline-offset-2 hover:opacity-80">
            重连
          </button>
        </div>
      )}
      {/* 错误对聊天面板外的可见性：面板关着时错误不该被一起藏掉 */}
      {error && !chatOpen && (
        <div className="absolute left-1/2 -translate-x-1/2 top-28 z-[76] max-w-[70%] rounded-xl bg-red-600 px-4 py-2 text-[12.5px] text-white shadow-lg fade-up text-center">
          {error}
        </div>
      )}
      {/* 语音降级提示：云端 TTS 暂时失败时不再"安静装没事"，说明现状 + 给自救入口 */}
      {ttsIssue && !wsLost && (
        <div className="absolute left-1/2 -translate-x-1/2 top-16 z-[75] rounded-xl bg-[#16181c] px-4 py-2.5 text-[12.5px] text-white shadow-xl fade-up flex items-center gap-3">
          <span>语音合成暂时不可用，讲师正按字幕节奏默讲</span>
          {!browserVoicePrefRef.current && (
            <button
              onClick={() => {
                browserVoicePrefRef.current = true;
                setTtsIssue(false);
              }}
              className="shrink-0 underline underline-offset-2 text-[#ffd9a8] hover:opacity-80"
            >
              改用浏览器音色
            </button>
          )}
        </div>
      )}

      {/* 云端音色因未登录被禁：浏览器音色顶上，但必须明说 + 给登录入口，登录后当堂恢复 */}
      {ttsAuthNeeded && !wsLost && (
        <div className="absolute left-1/2 -translate-x-1/2 top-16 z-[75] rounded-xl bg-[#16181c] px-4 py-2.5 text-[12.5px] text-white shadow-xl fade-up flex items-center gap-3">
          <span>登录后才能用云端讲师音色，现在用的是浏览器系统音色</span>
          <button
            onClick={() => setAuthOpen(true)}
            className="shrink-0 underline underline-offset-2 text-[#ffd9a8] hover:opacity-80"
          >
            登录
          </button>
        </div>
      )}
      {authOpen && (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onLoggedIn={() => {
            setAuthOpen(false);
            setTtsAuthNeeded(false);
            resetTtsDisabled(); // 下一句起恢复云端音色，无需刷新页面
          }}
        />
      )}

      {/* 产物操作反馈（海报/回放）：深色 toast + 可选回放链接 */}
      {posterMsg && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-20 z-[75] rounded-xl bg-[#16181c] px-4 py-2.5 text-[12.5px] text-white shadow-xl fade-up max-w-[70%] text-center">
          {posterMsg.text}
          {posterMsg.href && (
            <a href={posterMsg.href} target="_blank" rel="noreferrer" className="ml-2 underline underline-offset-2 text-[#ffd9a8]">
              打开回放页
            </a>
          )}
        </div>
      )}

      {/* 退出确认：× 会停掉讲解和聆听，破坏性操作给一步反悔的机会 */}
      {exitConfirmOpen && (
        <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#16181c]/45 backdrop-blur-[2px]">
          <div className="w-[360px] max-w-[86%] rounded-3xl border border-[#e6e8eb] bg-white shadow-2xl p-6 fade-up">
            <div className="text-[17px] font-bold text-ink mb-1.5">退出这节课？</div>
            <div className="text-[13px] text-ink-soft leading-relaxed mb-5">
              讲解进度会保留，下次进来从暂停的地方继续；正在播放的语音会停下。
            </div>
            <div className="flex gap-2.5 justify-end">
              <button
                onClick={() => setExitConfirmOpen(false)}
                className="rounded-lg border border-[#e6e8eb] px-4 py-2 text-[12.5px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
              >
                继续上课
              </button>
              <button
                onClick={() => {
                  setExitConfirmOpen(false);
                  handleExit();
                }}
                className="rounded-lg bg-accent px-4 py-2 text-[12.5px] text-white hover:opacity-90 transition-opacity"
              >
                退出课堂
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 60 秒竖屏速览录制器 */}
      <VerticalClipModal
        open={clipOpen}
        onClose={() => setClipOpen(false)}
        courseTitle={outline.title}
        lectureTitle={lectureTitle}
        beats={buildClipBeats()}
      />
    </div>
  );
}
