"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CourseOutline, LectureQuizItem, ReplayReel, TeachBeat, WhiteboardEvent, WhiteboardMessage } from "@/types";
import { Whiteboard } from "./Whiteboard";
import { createBoardWriter, type BoardWriter } from "./board-writer";
import { LectureQuizPanel } from "./LectureQuizPanel";
import { useClassroomSocket, type ClassroomState } from "@/hooks/useClassroomSocket";
import { startVoiceCapture, type VoiceCapture } from "./voice-capture";
import { consumeSse } from "@/lib/sse";
import { splitSpeechLines } from "@/lib/speech-lines";
import { boardCssVars, CHROME_VARS } from "@/lib/board-themes";
import { createTtsPlayer, fetchTtsSegments, prefetchTts, ttsUnavailable } from "@/lib/tts-client";
import { exportBoardPoster, exportScriptPoster, downloadBlob, copyImageToClipboard, safeFilename } from "@/lib/board-poster";
import { VerticalClipModal, type ClipBeat } from "./VerticalClipModal";

interface CourseSessionProps {
  courseId: string;
  outline: CourseOutline;
  unitId: string;
  lectureId: string;
  lectureTitle: string;
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
  onExit,
}: CourseSessionProps) {
  const [messages, setMessages] = useState<WhiteboardMessage[]>([]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
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
  const [chatMode, setChatMode] = useState<"text" | "voice">("text");
  // 学员称呼：只在第一次（画像里还没有名字时）在预告卡顺口问一次，之后自动记住
  const [profileName, setProfileName] = useState<string | null>(null); // null = 还没加载
  const [introName, setIntroName] = useState("");
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
  const [posterMsg, setPosterMsg] = useState("");
  const [replayUrl, setReplayUrl] = useState("");
  const [clipOpen, setClipOpen] = useState(false);
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
  const startedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const { state: wsState, connected: wsConnected, send: wsSend } = useClassroomSocket(room);
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
      if (!voiceOnRef.current || !("speechSynthesis" in window)) {
        // 静音模式：按阅读节奏推进（约 4 行/秒 的中文语速）
        window.setTimeout(resolve, Math.max(minMs, (text.length * 170 + 400) / spd));
        return;
      }
      let settled = false;
      let cancelled = false; // 云端合成等待期间被暂停/退出
      const finish = () => {
        if (!settled) {
          settled = true;
          speechStopRef.current = null;
          resolve();
        }
      };
      speechStopRef.current = () => {
        cancelled = true;
        finish();
      };
      void (async () => {
        const segs = await fetchTtsSegments(text);
        if (cancelled || settled) return;
        if (segs) {
          const player = createTtsPlayer(segs, spd);
          speechStopRef.current = () => player.stop();
          await player.promise;
          finish();
        } else if (ttsUnavailable()) {
          // 服务端没配云端 TTS（自部署）：回退浏览器系统音色
          speakWithBrowser(text, spd, (stop) => {
            speechStopRef.current = stop;
          }, finish);
        } else {
          // 云端已配置但这句暂时失败（重试仍失败）：字幕/板书照常、按阅读节奏安静推进，
          // 绝不回退浏览器音色——生硬的机器声突兀插进来比安静几秒糟糕得多
          window.setTimeout(finish, Math.max(minMs, (text.length * 170 + 400) / spd));
        }
      })();
    });
  }, []);

  const pausePlayback = useCallback(() => {
    if (playbackRef.current !== "playing") return;
    pausedRef.current = true;
    speechStopRef.current?.();
    setPlayback("paused");
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

      // 白板逐条书写（每句话都有板书动作，镜头以模块为单位切换）
      const boardItems = item.beat.items || [];
      await writerRef.current?.write(item.beat.section, boardItems);
      if (item.lastOfSegment) writerRef.current?.removePencil();

      // 逐行朗读（或静音节奏计时）；播放本行期间预取下一行的云端音频，不空等。
      // 静音时不预取：TTS 占首听成本八成，为永远不会播的句子付合成费是纯浪费；
      // 取消静音后下一拍恢复预取，当拍首句改为即时合成（多等一两秒）
      const nextBeatLines = queueRef.current[0] ? splitSpeechLines(queueRef.current[0].beat.say) : [];
      for (let li = 0; li < speechLines.length; li++) {
        if (pausedRef.current || exitedRef.current) break;
        setSubtitle(speechLines[li]);
        if (voiceOnRef.current) prefetchTts(speechLines[li + 1] ?? nextBeatLines[0]);
        await speak(speechLines[li]);
      }

      // 片段收尾：有课堂练习则停下来，选项内嵌在字幕区等学员作答
      if (item.lastOfSegment) {
        const cp = segCheckpointRef.current.get(item.segmentId);
        if (cp && cp.question && cp.options.length > 0) {
          setCheckpoint({ id: item.segmentId, question: cp.question, options: cp.options });
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
      const res = await fetch("/api/teach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_teaching", courseId, unitId, lectureId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
      await consumeSse<WhiteboardEvent>(res, (e) => {
        if (lectureGenRef.current !== gen) return; // 旧流（已被 abort/替换）的事件全部丢弃
        if (e.type === "beats") {
          enqueueBeats(e);
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
        setError(e instanceof Error ? e.message : String(e));
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
  const sendChat = useCallback(
    async (
      raw: string,
      checkpointInfo?: { question: string; options: string[] }
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
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        await consumeSse<WhiteboardEvent>(res, (e) => {
          if (e.type === "token") {
            acc += e.text;
            setDraft(acc);
          } else if (e.type === "achievement") {
            setAchievement({ title: e.title, desc: e.desc });
          } else if (e.type === "error") {
            setError(e.message);
          }
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
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

    // 全新开课
    setPlayback("idle");
    if (chatMode === "voice") {
      window.setTimeout(() => startListening(), 1200);
    }
    void startLecture();
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

  // ---- 产物一：知识海报（优先讲义式：片段要点+图表+金句；无剧本时退回白板终态） ----
  const generatePoster = async () => {
    if (posterBusy) return;
    setPosterBusy(true);
    setPosterMsg("");
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
      setPosterMsg(copied ? "已下载并复制到剪贴板" : "海报已下载");
      window.setTimeout(() => setPosterMsg(""), 2600);
    } catch (e) {
      setPosterMsg(e instanceof Error ? e.message : "海报生成失败");
      window.setTimeout(() => setPosterMsg(""), 3200);
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
    let url = replayUrl;
    // window.open 必须在 await 前同步调用（放 await 后会被弹窗拦截）：已生成 → 直接开回放页；
    // 未生成 → 先开空白标签，生成成功后导向过去（失败就关掉）
    const existing = Boolean(url);
    const win = window.open(existing ? url : "about:blank", "_blank");
    if (!existing) {
      url = await saveReplay();
      if (!url) {
        win?.close();
        setPosterMsg("回放还没准备好，讲师讲完就有了");
        window.setTimeout(() => setPosterMsg(""), 2600);
        return;
      }
      if (win) win.location.href = url;
    }
    try {
      await navigator.clipboard.writeText(url);
      setPosterMsg("回放已在新的标签页打开（自己随时回看），链接也复制好了，发给朋友看同一条");
    } catch {
      setPosterMsg(url);
    }
    window.setTimeout(() => setPosterMsg(""), 3200);
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

  // 退出课堂：清空恢复状态（主动离开 = 下次从头开始）；刷新/断线则保留
  const exitAndClear = () => {
    wsSend({ type: "end" });
    handleExit();
  };

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
      className="classroom-sunny fixed inset-0 bg-[#fffcf4] flex flex-col z-50"
      style={{ ...boardCssVars(), ...CHROME_VARS } as React.CSSProperties}
    >
      {/* 顶部栏（Hyperknow 风格：标题 + 播放控制 + 缩放 + 操作） */}
      <div className="h-14 border-b border-[#eadfc8] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={exitAndClear}
            className="text-ink-soft hover:text-ink text-[18px]"
            aria-label="退出"
          >
            ×
          </button>
          <div className="text-[14px] font-medium truncate max-w-md">{lectureTitle}</div>
          <span
            className="hidden md:inline-block rounded-full bg-[#f7edda] px-2 py-0.5 text-[10px] text-ink-soft shrink-0"
            title="AI 生成内容可能存在错误，请以权威来源为准"
          >
            AI 生成
          </span>
        </div>
        <div className="flex items-center gap-2">
          {(playback === "playing" || playback === "paused") && (
            <button
              onClick={playback === "playing" ? pausePlayback : resumePlayback}
              className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                playback === "paused" ? "border-accent text-accent" : "border-[#e0d6c2] text-ink-soft"
              }`}
            >
              {playback === "playing" ? "⏸ 暂停" : "▶ 播放"}
            </button>
          )}
          <button
            onClick={toggleVoice}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${voiceOn ? "border-accent text-accent" : "border-[#e0d6c2] text-ink-soft"}`}
            aria-pressed={voiceOn}
            title={voiceOn ? "关闭语音讲解" : "开启语音讲解"}
          >
            {voiceOn ? "◖ 语音" : "◌ 静音"}
          </button>
          {/* 语速：嫌节奏慢就提速 */}
          <button
            onClick={() => setRate((r) => (r >= 2 ? 1 : Math.round((r + 0.25) * 100) / 100))}
            className="rounded-lg border border-[#e0d6c2] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
            title="讲解语速（点击切换）"
          >
            ⏩ {rate}x
          </button>
          <button
            onClick={toggleAutoListen}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
              micArmed ? "border-accent text-accent animate-pulse" : "border-[#e0d6c2] text-ink-soft"
            }`}
            aria-pressed={micArmed}
            title={micArmed ? "自动聆听中：开口即打断 · 点击暂停聆听" : "开启自动聆听：开口说话即打断老师"}
          >
            {micArmed ? "🎙 聆听中" : "🎙 聆听"}
          </button>
          {/* 缩放控制 */}
          <div className="flex items-center border border-[#e0d6c2] rounded-lg overflow-hidden">
            <button
              onClick={() => excalidrawApiRef.current?.updateScene({ appState: { ...excalidrawApiRef.current.getAppState(), zoom: { value: Math.max(0.2, (excalidrawApiRef.current.getAppState().zoom?.value || 1) - 0.1) } } })}
              className="px-2.5 py-1.5 text-[13px] text-ink-soft hover:bg-[#f7edda]"
            >
              −
            </button>
            <button
              onClick={() => excalidrawApiRef.current?.updateScene({ appState: { ...excalidrawApiRef.current.getAppState(), zoom: { value: 1 } } })}
              className="px-2 py-1.5 text-[11px] text-ink-soft hover:bg-[#f7edda] min-w-[3rem] text-center border-x border-[#e0d6c2]"
            >
              {Math.round((excalidrawApiRef.current?.getAppState?.()?.zoom?.value || 1) * 100)}%
            </button>
            <button
              onClick={() => excalidrawApiRef.current?.updateScene({ appState: { ...excalidrawApiRef.current.getAppState(), zoom: { value: Math.min(3, (excalidrawApiRef.current.getAppState().zoom?.value || 1) + 0.1) } } })}
              className="px-2.5 py-1.5 text-[13px] text-ink-soft hover:bg-[#f7edda]"
            >
              +
            </button>
          </div>
          {/* 适应内容 */}
          <button
            onClick={fitAll}
            className="rounded-lg border border-[#e0d6c2] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent"
            title="适应内容"
          >
            ⛶
          </button>
          {/* 对照原文（文档建课模式）：讲师讲到的原文页 */}
          {docPages && (
            <button
              onClick={() => setDocOpen((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                docOpen ? "border-accent text-accent" : "border-[#e0d6c2] text-ink-soft hover:border-accent hover:text-accent"
              }`}
              title="查看讲师本节课引用的上传文档原文"
            >
              📄 对照原文
            </button>
          )}
          {/* 传播产物：海报 / 竖屏速览 / 回放链接。海报 = 全节讲义，讲完才生成，保证与白板终态一致 */}
          <button
            onClick={() => void generatePoster()}
            disabled={posterBusy || playback !== "done"}
            className="rounded-lg border border-[#e0d6c2] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-50 disabled:hover:border-[#e0d6c2] disabled:hover:text-ink-soft"
            title={playback === "done" ? "把整节讲义生成竖版知识海报" : "讲完本节后可生成（内容为整节讲义，和板书终态一致）"}
          >
            {posterBusy ? "生成中…" : "🖼 海报"}
          </button>
          <button
            onClick={() => setClipOpen(true)}
            disabled={wsScriptRef.current.length === 0}
            className="rounded-lg border border-[#e0d6c2] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            title="录一条 60 秒竖屏速览视频，直接发抖音/小红书"
          >
            🎬 竖屏速览
          </button>
          <button
            onClick={() => void copyReplayLink()}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
              replayUrl ? "border-accent text-accent" : "border-[#e0d6c2] text-ink-soft hover:border-accent hover:text-accent"
            }`}
            title="打开只读回放页（自己回看 / 复制链接发给朋友）"
          >
            🔗 回放
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 课后练习面板 */}
        {quizOpen && lectureQuiz && lectureQuiz.length > 0 && (
          <LectureQuizPanel quiz={lectureQuiz} onClose={() => setQuizOpen(false)} />
        )}

        {/* 成就徽章弹窗（原版同款激励闭环） */}
        {achievement && (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-white/75 backdrop-blur-[2px]">
            <div className="w-[430px] max-w-[88%] rounded-3xl border border-[#eadfc8] bg-white shadow-2xl p-7 flex items-start gap-5 fade-up">
              <div className="text-[52px] leading-none select-none">🏅</div>
              <div className="flex-1">
                <div className="text-[11px] text-accent font-semibold tracking-[.1em] mb-1">你获得了奖励</div>
                <div className="text-[20px] font-bold leading-snug mb-1.5">{achievement.title}</div>
                <div className="text-[12.5px] text-ink-soft leading-relaxed">{achievement.desc}</div>
                <button
                  onClick={() => setAchievement(null)}
                  className="mt-4 rounded-lg bg-[#2c2c2a] px-5 py-2 text-[12.5px] text-white hover:opacity-85"
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
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/70 backdrop-blur-[2px]">
              <div className="w-[420px] max-w-[90%] rounded-3xl border border-[#eadfc8] bg-white shadow-xl p-8 fade-up">
                <div className="text-[11px] text-ink-faint uppercase tracking-[.12em] mb-2">本节学习内容</div>
                <div className="text-[21px] font-bold leading-snug mb-3">{lectureTitle}</div>
                <div className="text-[13px] text-ink-soft leading-relaxed mb-5">
                  {unit?.lectures.find((l) => l.id === lectureId)?.summary ||
                    `围绕「${lectureTitle}」的白板讲解，边讲边画，随时打断提问。`}
                </div>
                <div className="flex items-center gap-2 mb-5">
                  {(unit?.lectures.find((l) => l.id === lectureId)?.depth_tags || []).map((tag) => (
                    <span key={tag} className="rounded-full bg-[#f7edda] px-2.5 py-0.5 text-[11px] text-ink-soft">
                      {tag}
                    </span>
                  ))}
                  <span className="text-[11px] text-ink-faint">
                    约 {unit?.lectures.find((l) => l.id === lectureId)?.duration_min ?? 20} 分钟
                  </span>
                </div>
                {/* 交流方式（原版同款：文字 / 语音+文字全双工） */}
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
                          chatMode === opt.key ? "border-accent bg-accent/5" : "border-[#eadfc8] bg-white hover:border-accent/60"
                        }`}
                      >
                        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                          {opt.title}
                          {opt.key === "voice" && (
                            <span className="rounded bg-[#fff3e0] px-1.5 py-px text-[9.5px] text-[#b45309]">BETA</span>
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
                      className="flex-1 min-w-0 rounded-lg border border-[#eadfc8] px-3 py-1.5 text-[13px] outline-none focus:border-accent"
                    />
                  </div>
                )}
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
          />
          <div className="board-subtitle" aria-live="polite">
            {voiceHeard ? (
              <div className="board-voice-heard">
                <span className="board-voice-heard-label">
                  {voiceHeard.status === "interim" ? "🎙 正在听" : voiceHeard.status === "hint" ? "🎙 提示" : "🎙 听到"}
                </span>
                <span className="board-voice-heard-text">{voiceHeard.text}</span>
                {voiceHeard.status === "echo" && <span className="board-voice-heard-note">（与老师声音重叠，已忽略）</span>}
                {voiceHeard.status === "dup" && <span className="board-voice-heard-note">（重复，已忽略）</span>}
                {voiceHeard.status === "short" && <span className="board-voice-heard-note">（太短）</span>}
                {voiceHeard.status === "error" && <span className="board-voice-heard-note">（服务不稳，改用 Edge 或打字）</span>}
              </div>
            ) : checkpoint ? (
              <div className="board-quiz">
                <div className="board-quiz-q">{checkpoint.question}</div>
                <div className="board-quiz-options">
                  {checkpoint.options.map((option) => (
                    <button key={option} onClick={() => answerCheckpoint(option)} className="board-quiz-option">
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ) : playback === "playing" && subtitle ? (
              <>
                <span className="board-subtitle-label">讲师</span>
                <span>{subtitle}</span>
              </>
            ) : playback === "paused" ? (
              <>
                <span className="board-subtitle-idle">已暂停 · 可随时提问，或</span>
                <button onClick={resumePlayback} className="board-resume-btn">▶ 继续上课</button>
              </>
            ) : playback === "done" ? (
              <span className="board-subtitle-idle">
                本节课讲完 · 可继续提问或回看板书
                {lectureQuiz && lectureQuiz.length > 0 && (
                  <button onClick={() => setQuizOpen(true)} className="board-resume-btn ml-2">
                    📝 做课后练习（{lectureQuiz.length} 题）
                  </button>
                )}
                <button onClick={() => void generatePoster()} disabled={posterBusy} className="board-resume-btn ml-2">
                  🖼 生成知识海报
                </button>
                <button onClick={() => void copyReplayLink()} className="board-resume-btn ml-2">
                  🔗 {replayUrl ? "复制回放链接" : "生成回放链接"}
                </button>
              </span>
            ) : (
              <span className="board-subtitle-idle">{!boardReady ? "正在准备白板…" : preparing ? "AI 讲师正在备课…" : "白板课堂"}</span>
            )}
          </div>
        </div>

        {/* 对照原文面板（文档建课模式）：讲师本节课引用的上传文档页 */}
        {docOpen && docPages && (
          <div className="w-80 border-l border-[#eadfc8] bg-[#faf9f6] flex flex-col shrink-0">
            <div className="p-3 border-b border-[#eadfc8] flex items-center justify-between">
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
                <div key={p.page} className="rounded-xl border border-[#eadfc8] bg-white p-3">
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
          <div className="w-80 border-l border-[#eadfc8] bg-white flex flex-col shrink-0">
            <div className="p-3 border-b border-[#eadfc8] flex items-center justify-between">
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
                      m.role === "user" ? "bg-accent text-white ml-8" : m.kind === "highlight" ? "bg-[#fff7d6] text-ink mr-8" : m.kind === "board" ? "bg-[#eaf6f1] text-ink mr-8" : "bg-[#f7edda] text-ink mr-8"
                    }`}
                  >
                    {m.role === "assistant" && <div className="lesson-message-label">{m.label || (m.kind === "board" ? "白板动作" : m.kind === "highlight" ? "互动提问" : "课程讲解")}</div>}
                    <LessonMarkdown text={m.content} />
                  </div>
                ))
              )}
              {draft && (
                <div className="bg-[#f7edda] text-ink rounded-xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap mr-8">
                  <LessonMarkdown text={draft} />
                </div>
              )}
              {chatStreaming && !draft && (
                <div className="bg-[#f7edda] text-ink rounded-xl px-3 py-2 text-[13px] mr-8">
                  <span className="animate-pulse">AI 讲师正在思考...</span>
                </div>
              )}
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                  {error}
                </div>
              )}
            </div>
            <div className="p-3 border-t border-[#eadfc8]">
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
                  placeholder="输入问题，打断讲师..."
                  rows={1}
                  className="flex-1 resize-none rounded-lg border border-[#e0d6c2] px-3 py-2 text-[13px] outline-none focus:border-accent"
                />
                <button
                  onClick={toggleMic}
                  title="语音输入（说完自动填入）"
                  aria-pressed={listening}
                  className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                    listening ? "border-red-400 text-red-600 bg-red-50 animate-pulse" : "border-[#e0d6c2] text-ink-soft hover:border-accent hover:text-accent"
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
      <div className="h-12 border-t border-[#eadfc8] flex items-center justify-end px-4 shrink-0">
        <div className="flex items-center gap-2">
          {!chatOpen && (
            <button
              onClick={() => setChatOpen(true)}
              className="rounded-lg border border-[#e0d6c2] px-3 py-1.5 text-[12px] text-ink-soft"
            >
              打开对话
            </button>
          )}
        </div>
      </div>

      {/* 产物操作反馈（海报/回放） */}
      {posterMsg && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-20 z-[75] rounded-xl bg-[#2c2c2a] px-4 py-2.5 text-[12.5px] text-white shadow-xl fade-up max-w-[70%] text-center">
          {posterMsg}
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
