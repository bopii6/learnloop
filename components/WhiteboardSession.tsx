"use client";

// 白板课堂（分段 + 自适应讲课）：
//   讲师一拍一句话、边说边写；每讲一小段就停下来问一个问题（选择 / 一句话 / 写代码）；
//   学员答完立刻看到对错与解析，同时讲师带着他的回答生成下一段——答错了，下一段先当场纠偏。
// 播放模型：服务端下发动作 → 本地队列串行播放（组内 board 落字与 speak 并发）→ 每个动作真正完成才前进。
// 版面：列宽固定（场景坐标），相机按屏宽看 1-3 列、平滑跟随最新板书；字幕一行纯文字；右侧是课堂记录。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskState, BoardAction, BoardEvent, BoardItem, BoardPage, BoardState, NoteCardItem } from "@/types/board";
import { COL_STEP_GAP, addColumn, colWidth, colX, computeLayoutParams, createPageLayout, placeItem, reflowColumn } from "@/lib/board/layout";
import { consumeSse } from "@/lib/sse";
import { groupActions } from "@/lib/board/actions";
import { fetchTtsSegments, prefetchTts, ttsUnavailable } from "@/lib/tts-client";
import { Whiteboard, type WhiteboardCamera } from "./Whiteboard";
import { BoardLayer } from "./board/BoardLayer";
import { AskCard, type AskSubmit } from "./board/AskCard";
import type { CardHandle } from "./board/NoteCard";
import { setTypewriterPaused } from "./board/useTypewriter";
import { Icon } from "./icons";
import "./board/board.css";

interface WhiteboardSessionProps {
  courseId: string;
  unitId: string;
  lectureId: string;
  lectureTitle: string;
  onExit?: () => void;
  /** 下一讲（课程页按大纲算好）：讲完后一键进入 */
  nextLecture?: { id: string; title: string };
  onNextLecture?: () => void;
  /** 只读回放：动作序列来自分享快照，不请求讲师、不记进度；课堂题本地判对错 */
  replay?: { actions: BoardAction[]; courseTitle?: string };
}

interface QueueItem {
  actions: BoardAction[];
  gateStep?: number;
  /** script = 讲稿（计入进度）；reply = 即时反馈 / 追问回应（插队播放，不计进度） */
  origin: "script" | "reply";
}
type SingleAction = QueueItem & { action: BoardAction };

/** ready = 课前；preparing = 备课中；thinking = 等下一段生成；blocked = 需登录 / 失败 */
type Status = "ready" | "preparing" | "playing" | "ask" | "thinking" | "done" | "blocked";

interface SavedProgress {
  /** 最近开始的段（续播从这一段开头开始） */
  segment: number;
  finished: boolean;
  at: number;
}

interface LogMsg {
  id: string;
  kind: "say" | "user" | "ask" | "result" | "reward" | "note";
  text: string;
  label?: string;
  ok?: boolean;
}

const RATES = [0.8, 1, 1.25, 1.5];
const SUBTITLE_RESERVE = 120;
const ASK_RESERVE = 300;

function progressKey(courseId: string, unitId: string, lectureId: string) {
  return `wb-progress:v2:${courseId}:${unitId}:${lectureId}`;
}
function loadProgress(key: string): SavedProgress | null {
  try {
    const raw = window.localStorage.getItem(key);
    const p = raw ? (JSON.parse(raw) as SavedProgress) : null;
    return p && typeof p.segment === "number" ? p : null;
  } catch {
    return null;
  }
}
function saveProgress(key: string, p: SavedProgress) {
  try {
    window.localStorage.setItem(key, JSON.stringify(p));
  } catch {
    // 存储不可用：续播退化为从头开始
  }
}

const EMPTY_STATE: BoardState = {
  version: 1,
  revision: 0,
  activePageId: "page-1",
  pages: [{ id: "page-1", items: [], layout: null }],
};

/** 右侧浮动面板占去的宽度（含边距） */
const PANEL_W = 340;
const PANEL_GUTTER = 24;

/**
 * 相机：在可用宽度里尽量多看几列，但缩放不低于 0.66（实测 Hyperknow 宽屏约 0.7：17px 正文落到屏幕约 12px）；
 * 窄屏只看 1 列、最多放大到 0.9。
 */
function viewFit(availW: number, step: number, gap: number) {
  const margin = 60;
  const n = Math.max(1, Math.floor((availW / 0.66 - margin + gap) / step));
  const zoom = Math.max(0.6, Math.min(0.9, availW / (n * step - gap + margin)));
  return { n, zoom };
}

/** 估算一张卡写出来的高度（场景坐标）：决定要不要换列 */
function estimateCardHeight(content: string, colW: number) {
  const perLine = Math.max(10, Math.floor(colW / 20));
  let h = 20;
  let inCode = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      h += 6;
      continue;
    }
    if (inCode) h += 24;
    else h += Math.max(1, Math.ceil(line.length / perLine)) * 33;
  }
  return h;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function WhiteboardSession({ courseId, unitId, lectureId, lectureTitle, onExit, nextLecture, onNextLecture, replay }: WhiteboardSessionProps) {
  const isReplay = Boolean(replay);
  const [status, setStatus] = useState<Status>("ready");
  const [blocked, setBlocked] = useState<{ title: string; message: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);
  const [saved, setSaved] = useState<SavedProgress | null>(null);
  const progKey = progressKey(courseId, unitId, lectureId);
  const [board, setBoard] = useState<BoardState>(EMPTY_STATE);
  const [camera, setCamera] = useState<WhiteboardCamera>({ scrollX: 0, scrollY: 0, zoom: 1, vpW: 1200, vpH: 700 });
  const [caption, setCaption] = useState<{ text: string; reveal: number }>({ text: "", reveal: 0 });
  const [ask, setAsk] = useState<AskState | null>(null);
  const [reward, setReward] = useState<{ title: string; desc: string } | null>(null);
  const [log, setLog] = useState<LogMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryNext, setRetryNext] = useState<null | (() => void)>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [plan, setPlan] = useState<{ title: string; segments: { title: string }[] } | null>(null);
  const [segIndex, setSegIndex] = useState(-1);
  const [finalSeg, setFinalSeg] = useState(false);
  // 沉浸优先：课堂记录默认收起，白板占满；用户打开过就记住
  const [panelOpen, setPanelOpen] = useState(false);
  // 讲课进行中鼠标静止一会儿，四周的按钮就淡出，只留板书和字幕
  const [chromeIdle, setChromeIdle] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const apiRef = useRef<any>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const boardRef = useRef(board);
  boardRef.current = board;
  if (typeof window !== "undefined") {
    (window as unknown as { __wbBoard?: BoardState }).__wbBoard = board;
  }
  const queueRef = useRef<QueueItem[]>([]);
  const busyRef = useRef(false);
  const cardHandles = useRef(new Map<string, CardHandle>());
  const cardWaiters = useRef(new Map<string, { resolve: () => void }>());
  const mediaWaiters = useRef(new Map<string, { resolve: () => void }>());
  const mediaStash = useRef(new Map<string, BoardAction>());
  const speechStopRef = useRef<(() => void) | null>(null);
  const exitedRef = useRef(false);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;
  const pausedRef = useRef(false);
  const rateRef = useRef(1);
  rateRef.current = rate;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpeechRef = useRef("");
  const askWaiterRef = useRef<(() => void) | null>(null);
  const askRef = useRef<AskState | null>(null);
  askRef.current = ask;
  /** 续播：段号小于它的都快进（无动画、无语音、跳过题目） */
  const resumeSegRef = useRef(0);
  const segRef = useRef(-1);
  const fastRef = useRef(false);
  const replyInsertRef = useRef(0);
  const failedMediaRef = useRef(new Set<number>());
  /** 下一段正在生成 */
  const waitingNextRef = useRef(false);
  /** 收尾段的 done 已播完 */
  const finishedRef = useRef(false);
  /** 下一句讲话在课堂记录里的标签（板书 / 圈画 / 配图） */
  const sayLabelRef = useRef<string | undefined>(undefined);
  const tweenRef = useRef(0);
  /** fetchNext 定义在 runAction 之后：经由 ref 调用 */
  const fetchNextRef = useRef<((index: number, answer: Record<string, unknown>) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!isReplay) setSaved(loadProgress(progKey));
    try {
      if (window.localStorage.getItem("wb-panel") === "open") setPanelOpen(true);
    } catch {
      // ignore
    }
  }, [isReplay, progKey]);

  const layoutParams = useMemo(() => computeLayoutParams(camera.vpW || 1200, camera.vpH || 700), [camera.vpW, camera.vpH]);
  const lpRef = useRef(layoutParams);
  lpRef.current = layoutParams;

  const activePage = useCallback((): BoardPage => {
    const st = boardRef.current;
    return st.pages.find((p) => p.id === st.activePageId) ?? st.pages[0];
  }, []);

  const pushLog = useCallback((m: Omit<LogMsg, "id">) => {
    setLog((l) => [...l, { ...m, id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }]);
  }, []);

  // ---------------- 相机 ----------------

  const panelOpenRef = useRef(true);
  panelOpenRef.current = panelOpen;
  /** 白板可用宽度：面板浮在右侧，被它挡住的部分不放板书 */
  const availWidth = useCallback((vpW: number) => Math.max(320, vpW - (panelOpenRef.current ? PANEL_W + PANEL_GUTTER : 0)), []);
  const fit = useCallback(
    (vpW: number) => viewFit(availWidth(vpW), colWidth(lpRef.current) + COL_STEP_GAP, COL_STEP_GAP),
    [availWidth]
  );
  const targetZoom = useCallback((vpW: number) => fit(vpW).zoom, [fit]);

  /** 平滑移动相机（420ms 缓动）；连续调用时以最新目标为准 */
  const moveCamera = useCallback((to: { scrollX: number; scrollY: number; zoom: number }, instant = false) => {
    const api = apiRef.current;
    if (!api) return;
    const from = cameraRef.current;
    const id = ++tweenRef.current;
    const apply = (s: { scrollX: number; scrollY: number; zoom: number }) => {
      try {
        api.updateScene({ appState: { scrollX: s.scrollX, scrollY: s.scrollY, zoom: { value: s.zoom } } });
      } catch {
        // 画布未就绪
      }
    };
    if (instant || fastRef.current) return apply(to);
    const t0 = performance.now();
    const dur = 420;
    const step = (now: number) => {
      if (id !== tweenRef.current) return;
      const k = easeOut(Math.min(1, (now - t0) / dur));
      apply({
        scrollX: from.scrollX + (to.scrollX - from.scrollX) * k,
        scrollY: from.scrollY + (to.scrollY - from.scrollY) * k,
        zoom: from.zoom + (to.zoom - from.zoom) * k,
      });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  /** 跟随：当前列（及其左边能放下的列）可见；当前列写满一屏时让最新内容贴住视口下沿 */
  const follow = useCallback(
    (focus?: { columnIndex: number; bottom: number }, instant = false) => {
      const cam = cameraRef.current;
      const lp = lpRef.current;
      const vpW = window.innerWidth || cam.vpW || 1200;
      const vpH = window.innerHeight || cam.vpH || 700;
      const page = activePage();
      const active = focus?.columnIndex ?? page.layout?.activeIndex ?? 0;
      const { zoom, n } = fit(vpW);
      const start = Math.max(0, active - n + 1);
      const scrollX = -(colX(lp, start) - lp.gridLeft);
      let bottom = focus?.bottom ?? lp.gridTop;
      for (const it of page.items) if (it.columnIndex === active) bottom = Math.max(bottom, it.y + Math.max(40, it.h));
      const reserve = askRef.current ? ASK_RESERVE : SUBTITLE_RESERVE;
      const viewH = (vpH - reserve) / zoom;
      const top = lp.gridTop;
      // 内容从顶部浮动按钮下方（屏幕 90px）开始；写满一屏后让最新内容贴住字幕上沿
      const scrollY = bottom - top + 90 / zoom + 20 <= viewH ? -(top - 90 / zoom) : -(bottom + 28 - viewH);
      moveCamera({ scrollX, scrollY, zoom }, instant);
    },
    [activePage, fit, moveCamera]
  );

  // 视口变化（拉窗口 / 收起面板）：重新对准
  useEffect(() => {
    if (status === "ready" || status === "preparing") return;
    const t = window.setTimeout(() => follow(undefined, true), 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.vpW, camera.vpH, panelOpen]);

  // ---------------- 语音：TTS + 字幕逐字 ----------------

  const speak = useCallback(async (text: string): Promise<void> => {
    lastSpeechRef.current = text;
    const estMs = Math.max(1100, text.length * 165 + 350);
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        speechStopRef.current = null;
        audioRef.current = null;
        setCaption((c) => ({ ...c, reveal: text.length }));
        resolve();
      };
      if (exitedRef.current) return finish();
      const readAlong = () => {
        let elapsed = 0;
        let last = performance.now();
        let raf = 0;
        const tick = (now: number) => {
          if (!pausedRef.current) elapsed += (now - last) * rateRef.current;
          last = now;
          const p = Math.min(1, elapsed / estMs);
          setCaption({ text, reveal: Math.round(p * text.length) });
          if (p < 1 && !exitedRef.current) raf = requestAnimationFrame(tick);
          else finish();
        };
        raf = requestAnimationFrame(tick);
        speechStopRef.current = () => {
          cancelAnimationFrame(raf);
          finish();
        };
      };
      if (!voiceRef.current || ttsUnavailable()) return readAlong();
      void (async () => {
        const segs = await fetchTtsSegments(text);
        if (settled) return;
        if (!segs || segs.length === 0) return readAlong();
        const audios = segs.map((u) => {
          const a = new Audio(u);
          a.preload = "auto";
          a.playbackRate = rateRef.current;
          return a;
        });
        const durations = await Promise.all(
          audios.map(
            (a) =>
              new Promise<number>((res) => {
                if (a.duration && isFinite(a.duration)) return res(a.duration);
                const done = () => res(isFinite(a.duration) && a.duration > 0 ? a.duration : (text.length * 0.18) / segs.length);
                a.addEventListener("loadedmetadata", done, { once: true });
                a.addEventListener("error", done, { once: true });
                window.setTimeout(done, 800);
              })
          )
        );
        const totalDur = durations.reduce((s, d) => s + d, 0) || estMs / 1000;
        let doneDur = 0;
        let stopped = false;
        for (let i = 0; i < audios.length; i++) {
          if (stopped || settled) break;
          const a = audios[i];
          await new Promise<void>((next) => {
            const onTime = () => {
              const frac = a.duration > 0 ? Math.min(1, a.currentTime / a.duration) : 0;
              const overall = Math.min(1, (doneDur + frac * durations[i]) / totalDur);
              setCaption({ text, reveal: Math.round(overall * text.length) });
            };
            a.addEventListener("timeupdate", onTime);
            a.addEventListener("ended", () => next(), { once: true });
            a.addEventListener("error", () => next(), { once: true });
            audioRef.current = a;
            a.playbackRate = rateRef.current;
            if (!pausedRef.current) void a.play().catch(() => next());
            speechStopRef.current = () => {
              stopped = true;
              try {
                a.pause();
                a.src = "";
              } catch {
                // ignore
              }
              next();
            };
          });
          doneDur += durations[i];
        }
        finish();
      })();
    });
  }, []);

  // ---------------- 卡片注册 / 等待 ----------------

  const registerCard = useCallback((id: string, h: CardHandle) => {
    cardHandles.current.set(id, h);
  }, []);
  const waitCard = useCallback((id: string) => new Promise<void>((resolve) => cardWaiters.current.set(id, { resolve })), []);
  const waitMedia = useCallback((id: string) => new Promise<void>((resolve) => mediaWaiters.current.set(id, { resolve })), []);
  const onTypingDone = useCallback((id: string) => {
    const w = cardWaiters.current.get(id);
    if (w) {
      cardWaiters.current.delete(id);
      w.resolve();
    }
  }, []);
  const onMediaLoaded = useCallback((id: string) => {
    const w = mediaWaiters.current.get(id);
    if (w) {
      mediaWaiters.current.delete(id);
      w.resolve();
    }
  }, []);
  const onHeight = useCallback((id: string, h: number) => {
    setBoard((st) => {
      const pages = st.pages.map((p) => {
        const item = p.items.find((i) => i.id === id);
        if (!item || Math.abs(item.h - h) < 1) return p;
        let items = p.items.map((i) => (i.id === id ? ({ ...i, h } as BoardItem) : i));
        const layout = p.layout ? { ...p.layout, columns: p.layout.columns.map((c) => ({ ...c })) } : null;
        if (layout) items = reflowColumn(layout, items, item.columnIndex);
        return { ...p, items, layout };
      });
      return { ...st, pages };
    });
  }, []);

  /** 新卡落点：当前列放不下一屏就换列（列高按相机实际能看到的高度算） */
  const placeNew = useCallback(
    (estH: number) => {
      const cur = activePage();
      let layout = cur.layout ?? createPageLayout(lpRef.current);
      const col = layout.columns[layout.activeIndex];
      const cam = cameraRef.current;
      const zoom = targetZoom(window.innerWidth || cam.vpW || 1200);
      const maxColH = Math.max(380, ((window.innerHeight || cam.vpH || 700) - SUBTITLE_RESERVE - 90) / zoom - 30);
      if (col && col.nextY > layout.lp.gridTop + 10 && col.nextY + estH > layout.lp.gridTop + maxColH) {
        layout = addColumn(layout);
      }
      return { cur, layout, pos: placeItem(layout) };
    },
    [activePage, targetZoom]
  );

  const addItem = useCallback((pageId: string, layout: BoardPage["layout"], item: BoardItem) => {
    setBoard((st) => ({
      ...st,
      revision: st.revision + 1,
      pages: st.pages.map((p) => (p.id === pageId ? { ...p, layout, items: [...p.items, item] } : p)),
    }));
  }, []);

  // ---------------- 动作执行 ----------------

  const runAction = useCallback(
    async (item: SingleAction): Promise<void> => {
      const { action } = item;
      switch (action.type) {
        case "new_page": {
          const layout = createPageLayout(lpRef.current);
          const p: BoardPage = { id: action.page_id, title: action.title, items: [], layout };
          setBoard((st) => {
            const exists = st.pages.find((x) => x.id === action.page_id);
            if (exists) return { ...st, activePageId: exists.id };
            const kept = st.pages.filter((x) => !(x.id === "page-1" && x.items.length === 0));
            return { ...st, revision: st.revision + 1, activePageId: p.id, pages: [...kept, p] };
          });
          await new Promise((r) => setTimeout(r, 60));
          return;
        }
        case "segment_start": {
          segRef.current = action.segment;
          setSegIndex(action.segment);
          setFinalSeg(Boolean(action.final));
          fastRef.current = item.origin === "script" && action.segment < resumeSegRef.current;
          // 上一段的题卡收起
          if (askRef.current?.answered) setAsk(null);
          // 新的一段另起一列（板面上一段一列，回看时一目了然）
          const cur = activePage();
          if (cur.layout) {
            const col = cur.layout.columns[cur.layout.activeIndex];
            if (col && col.nextY > cur.layout.lp.gridTop + 10) {
              const layout = addColumn(cur.layout);
              setBoard((st) => ({ ...st, revision: st.revision + 1, pages: st.pages.map((p) => (p.id === cur.id ? { ...p, layout } : p)) }));
            }
          }
          if (!isReplay) {
            const p = { segment: action.segment, finished: false, at: Date.now() };
            saveProgress(progKey, p);
          }
          if (action.segment > 0 && !fastRef.current) {
            pushLog({ kind: "note", text: action.final ? "收尾" : `第 ${action.segment + 1} 段 · ${action.title}` });
          }
          await new Promise((r) => setTimeout(r, fastRef.current ? 0 : 80));
          return;
        }
        case "new_column": {
          const pageId = activePage().id;
          setBoard((st) => ({
            ...st,
            revision: st.revision + 1,
            pages: st.pages.map((p) => (p.id === pageId && p.layout ? { ...p, layout: addColumn(p.layout) } : p)),
          }));
          await new Promise((r) => setTimeout(r, 30));
          return;
        }
        case "board": {
          sayLabelRef.current = "板书";
          const lp = lpRef.current;
          const { cur, layout, pos } = placeNew(estimateCardHeight(action.board_content, colWidth(lp)));
          const id = `card-${action.board_uid}-${Date.now().toString(36)}`;
          // 字跟着话写：整卡在配对那句讲解的约 85% 时长内写完（与字幕逐字推进同一套估时）
          const paired = item.actions.find((a) => a.type === "speak") as { spoken_text: string } | undefined;
          const revealMs = paired ? (Math.max(1100, paired.spoken_text.length * 165 + 350) / rateRef.current) * 0.85 : undefined;
          const card: NoteCardItem = {
            id,
            kind: "note_card",
            x: pos.x,
            y: pos.y,
            w: pos.w,
            h: 90,
            columnIndex: pos.columnIndex,
            boardUid: action.board_uid,
            content: action.board_content,
            title: action.title,
            decorations: [],
            animateReveal: !fastRef.current,
            revealGateStep: item.gateStep,
            revealMs,
          };
          addItem(cur.id, layout, card);
          await new Promise((r) => window.setTimeout(r, 50));
          follow({ columnIndex: pos.columnIndex, bottom: pos.y + estimateCardHeight(action.board_content, pos.w) });
          if (fastRef.current) {
            await new Promise((r) => window.setTimeout(r, 30));
            return;
          }
          // 保险丝：按期望书写时长留足余量（太短会把慢写的卡强行一次性显出）；暂停时由打字机自己停，不在这里计
          const failSafe = new Promise<void>((r) =>
            window.setTimeout(r, Math.min(45000, Math.max(4000 + 24 * action.board_content.length, (revealMs ?? 0) * 1.6 + 3000)))
          );
          await Promise.race([waitCard(id), failSafe]);
          cardHandles.current.get(id)?.forceFinish();
          await new Promise((r) => window.setTimeout(r, 60));
          follow({ columnIndex: pos.columnIndex, bottom: 0 });
          return;
        }
        case "speak": {
          const label = sayLabelRef.current;
          sayLabelRef.current = undefined;
          if (fastRef.current) {
            lastSpeechRef.current = action.spoken_text;
            for (const [, h] of cardHandles.current) h.openGate();
            pushLog({ kind: "say", text: action.spoken_text, label });
            return;
          }
          pushLog({ kind: "say", text: action.spoken_text, label });
          prefetchTts(action.spoken_text);
          await speak(action.spoken_text);
          if (item.gateStep != null) for (const [, h] of cardHandles.current) h.openGate();
          return;
        }
        case "circle":
        case "highlight": {
          sayLabelRef.current = "圈画";
          const cur = activePage();
          const target = cur.items.find((i) => i.kind === "note_card" && (i as NoteCardItem).boardUid === action.target_board_id) as NoteCardItem | undefined;
          if (target) {
            const deco = { id: `deco-${Date.now().toString(36)}`, kind: action.type as "circle" | "highlight", snippet: action.snippet };
            setBoard((st) => ({
              ...st,
              revision: st.revision + 1,
              pages: st.pages.map((p) =>
                p.id === cur.id
                  ? { ...p, items: p.items.map((i) => (i.id === target.id ? { ...(i as NoteCardItem), decorations: [...((i as NoteCardItem).decorations || []), deco] } : i)) }
                  : p
              ),
            }));
          }
          await new Promise((r) => setTimeout(r, fastRef.current ? 10 : action.type === "circle" ? 900 : 140));
          return;
        }
        case "image_gen_pending": {
          if (failedMediaRef.current.has(action.placement_step_id)) return;
          sayLabelRef.current = "配图";
          const lp = lpRef.current;
          const { cur, layout, pos } = placeNew(Math.round(colWidth(lp) * 0.9));
          const id = `img-${Date.now().toString(36)}`;
          addItem(cur.id, layout, {
            id,
            kind: "board_image",
            x: pos.x,
            y: pos.y,
            w: pos.w,
            h: Math.round(pos.w * 0.9),
            columnIndex: pos.columnIndex,
            placementStepId: action.placement_step_id,
            boardImage: { imageUrl: "", width: 512, height: 512, caption: action.caption, pending: true },
          });
          follow({ columnIndex: pos.columnIndex, bottom: pos.y + Math.round(pos.w * 0.9) });
          const key = `image:${action.placement_step_id}`;
          const stashed = mediaStash.current.get(key);
          if (stashed) {
            mediaStash.current.delete(key);
            window.setTimeout(() => void runAction({ actions: [], action: stashed, origin: "script" }), 60);
          }
          return;
        }
        case "generated_image": {
          const cur = activePage();
          const pending = (cur.items.find(
            (i) => i.kind === "board_image" && i.boardImage.pending && (action.placement_step_id == null || i.placementStepId === action.placement_step_id)
          ) ?? cur.items.find((i) => i.kind === "board_image" && i.boardImage.pending)) as (BoardItem & { kind: "board_image" }) | undefined;
          if (!pending && action.placement_step_id != null) {
            mediaStash.current.set(`image:${action.placement_step_id}`, action);
            return;
          }
          if (pending) {
            setBoard((st) => ({
              ...st,
              revision: st.revision + 1,
              pages: st.pages.map((p) =>
                p.id === cur.id
                  ? {
                      ...p,
                      items: p.items.map((i) =>
                        i.id === pending.id
                          ? ({ ...i, h: Math.round(i.w * 0.9), boardImage: { imageUrl: action.image_url, width: action.width, height: action.height, caption: action.caption, pending: false } } as BoardItem)
                          : i
                      ),
                    }
                  : p
              ),
            }));
            await Promise.race([waitMedia(pending.id), new Promise((r) => setTimeout(r, 2800))]);
          }
          return;
        }
        case "animation_pending": {
          if (failedMediaRef.current.has(action.placement_step_id)) return;
          const lp = lpRef.current;
          const { cur, layout, pos } = placeNew(Math.round(colWidth(lp) * 1.4));
          addItem(cur.id, layout, {
            id: `anim-${Date.now().toString(36)}`,
            kind: "board_animation",
            x: pos.x,
            y: pos.y,
            w: pos.w,
            h: Math.round(pos.w * 1.4),
            columnIndex: pos.columnIndex,
            placementStepId: action.placement_step_id,
            boardAnimation: { pending: true, task: action.task_preview },
          });
          follow({ columnIndex: pos.columnIndex, bottom: pos.y + Math.round(pos.w * 1.4) });
          const key = `anim:${action.placement_step_id}`;
          const stashed = mediaStash.current.get(key);
          if (stashed) {
            mediaStash.current.delete(key);
            window.setTimeout(() => void runAction({ actions: [], action: stashed, origin: "script" }), 60);
          }
          return;
        }
        case "generated_animation": {
          const cur = activePage();
          const pending = cur.items.find(
            (i) => i.kind === "board_animation" && i.boardAnimation.pending && (action.placement_step_id == null || i.placementStepId === action.placement_step_id)
          );
          if (!pending && action.placement_step_id != null) {
            mediaStash.current.set(`anim:${action.placement_step_id}`, action);
            return;
          }
          if (pending) {
            setBoard((st) => ({
              ...st,
              revision: st.revision + 1,
              pages: st.pages.map((p) =>
                p.id === cur.id
                  ? { ...p, items: p.items.map((i) => (i.id === pending.id ? ({ ...i, boardAnimation: { html: action.html, task: action.task, pending: false } } as BoardItem) : i)) }
                  : p
              ),
            }));
            await Promise.race([waitMedia(pending.id), new Promise((r) => setTimeout(r, 3000))]);
          }
          return;
        }
        case "graph": {
          const { cur, layout, pos } = placeNew(220);
          const id = `graph-${Date.now().toString(36)}`;
          addItem(cur.id, layout, { id, kind: "mermaid_graph", x: pos.x, y: pos.y, w: pos.w, h: 220, columnIndex: pos.columnIndex, mermaidGraph: { source: action.mermaid } });
          follow({ columnIndex: pos.columnIndex, bottom: pos.y + 220 });
          await Promise.race([waitMedia(id), new Promise((r) => setTimeout(r, 800))]);
          return;
        }
        case "ask": {
          if (fastRef.current) return; // 续播快进：已经答过的题不再拦
          const next: AskState = {
            stepId: action.step_id,
            kind: action.kind ?? (action.options?.length ? "choice" : "open"),
            segment: action.segment,
            question: action.question,
            options: action.options || [],
            correctIndex: action.correct_index,
            explanation: action.explanation,
            code: action.code,
          };
          setAsk(next);
          askRef.current = next;
          pushLog({ kind: "ask", text: action.question, label: "提问" });
          setStatus("ask");
          window.setTimeout(() => follow(undefined), 50);
          await new Promise<void>((resolve) => {
            askWaiterRef.current = resolve;
          });
          return;
        }
        case "segment_end": {
          if (action.auto && !isReplay && !fastRef.current) {
            void fetchNextRef.current?.(action.segment, { question: "（这一段没有检查题）", kind: "open", text: "（直接继续）" });
          }
          return;
        }
        case "reward_user": {
          setReward({ title: action.master_concept_title, desc: action.master_concept_description });
          if (!fastRef.current) pushLog({ kind: "reward", text: action.master_concept_title, label: action.master_concept_description });
          return;
        }
        case "done": {
          finishedRef.current = true;
          if (!isReplay) {
            const p = { segment: 0, finished: true, at: Date.now() };
            saveProgress(progKey, p);
            setSaved(p);
          }
          return;
        }
        default:
          return;
      }
    },
    [activePage, addItem, follow, isReplay, placeNew, progKey, pushLog, speak, waitCard, waitMedia]
  );

  // ---------------- 队列 ----------------

  const pump = useCallback(async () => {
    if (busyRef.current || exitedRef.current || pausedRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      setStatus((s) => {
        if (s === "ask" || s === "blocked" || s === "ready") return s;
        if (finishedRef.current) return "done";
        return waitingNextRef.current ? "thinking" : s === "preparing" ? s : "thinking";
      });
      return;
    }
    busyRef.current = true;
    if (next.origin === "reply" && replyInsertRef.current > 0) replyInsertRef.current -= 1;
    setStatus((s) => (s === "ask" ? s : "playing"));
    try {
      await Promise.all(next.actions.map((action) => runAction({ ...next, action })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
    }
    if (!exitedRef.current) window.setTimeout(() => void pump(), fastRef.current ? 0 : 60);
  }, [runAction]);

  const enqueue = useCallback(
    (actions: BoardAction[], origin: QueueItem["origin"]) => {
      const immediate = actions.filter((a) => a.type === "generated_image" || a.type === "generated_animation");
      const queued = actions.filter((a) => a.type !== "generated_image" && a.type !== "generated_animation");
      for (const a of immediate) void runAction({ actions: [], action: a, origin });
      if (queued.length > 0) {
        const speakStep = queued.find((a) => a.type === "speak")?.step_id;
        const item: QueueItem = { actions: queued, gateStep: speakStep, origin };
        if (origin === "reply") {
          queueRef.current.splice(replyInsertRef.current, 0, item);
          replyInsertRef.current += 1;
        } else {
          queueRef.current.push(item);
        }
        void pump();
      }
    },
    [pump, runAction]
  );

  const dropMedia = useCallback(
    (placementStep: number) => {
      failedMediaRef.current.add(placementStep);
      setBoard((st) => ({
        ...st,
        revision: st.revision + 1,
        pages: st.pages.map((p) => {
          const victim = p.items.find((i) => (i.kind === "board_image" || i.kind === "board_animation") && i.placementStepId === placementStep);
          if (!victim) return p;
          let items = p.items.filter((i) => i.id !== victim.id);
          const layout = p.layout ? { ...p.layout, columns: p.layout.columns.map((c) => ({ ...c })) } : null;
          if (layout) items = reflowColumn(layout, items, victim.columnIndex);
          onMediaLoaded(victim.id);
          return { ...p, items, layout };
        }),
      }));
    },
    [onMediaLoaded]
  );

  const handleEvent = useCallback(
    (e: BoardEvent, origin: QueueItem["origin"]) => {
      if (e.type === "group") return enqueue(e.actions, origin);
      if (e.type === "media_failed") return dropMedia(e.placement_step_id);
      if (e.type === "lesson_plan") return setPlan({ title: e.title, segments: e.segments });
      const t = (e as { type: string }).type;
      if (t === "session_ready" || t === "response_complete" || t === "error" || t === "auth_required" || t === "tts_segment") return;
      enqueue([e as BoardAction], origin);
    },
    [dropMedia, enqueue]
  );

  // ---------------- 开课 / 下一段 ----------------

  const startLesson = useCallback(
    async (resumeFrom: number) => {
      exitedRef.current = false;
      finishedRef.current = false;
      resumeSegRef.current = resumeFrom;
      setBlocked(null);
      setError(null);
      setStatus("preparing");
      if (replay) {
        for (const g of groupActions(replay.actions)) handleEvent({ type: "group", actions: g }, "script");
        return;
      }
      try {
        const res = await fetch("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", courseId, unitId, lectureId, resumeSegment: resumeFrom }),
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        let started = false;
        await consumeSse<BoardEvent>(res, (e) => {
          if (exitedRef.current) return;
          if (e.type === "session_ready") started = true;
          else if (e.type === "auth_required") {
            setBlocked({ title: "先登录再上课", message: e.message });
            setStatus("blocked");
          } else if (e.type === "error") {
            if (started) setError(e.message);
            else {
              setBlocked({ title: "这节课没能开讲", message: e.message });
              setStatus("blocked");
            }
          } else handleEvent(e, "script");
        });
      } catch (e) {
        setBlocked({ title: "网络出了点问题", message: e instanceof Error ? e.message : String(e) });
        setStatus("blocked");
      }
    },
    [courseId, handleEvent, lectureId, replay, unitId]
  );

  /** 学员答完第 index 段的检查 → 拉下一段（缓存命中秒回；否则讲师带着他的回答现写） */
  const fetchNext = useCallback(
    async (index: number, answer: Record<string, unknown>) => {
      waitingNextRef.current = true;
      setRetryNext(null);
      setError(null);
      try {
        const res = await fetch("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "next", courseId, unitId, lectureId, index, answer }),
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        let failed: string | null = null;
        await consumeSse<BoardEvent>(res, (e) => {
          if (exitedRef.current) return;
          if (e.type === "error") failed = e.message;
          else handleEvent(e, "script");
        });
        if (failed) throw new Error(failed);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRetryNext(() => () => void fetchNext(index, answer));
      } finally {
        waitingNextRef.current = false;
        void pump();
      }
    },
    [courseId, handleEvent, lectureId, pump, unitId]
  );

  fetchNextRef.current = fetchNext;

  const releaseAsk = useCallback(() => {
    const release = askWaiterRef.current;
    askWaiterRef.current = null;
    setStatus("playing");
    release?.();
  }, []);

  /** 作答：本地立判（选择 / 代码）+ 即时一句反馈 → 放行 → 讲师接着讲 */
  const answerAsk = useCallback(
    (a: AskSubmit) => {
      const cur = askRef.current;
      if (!cur || cur.answered) return;
      const answered: AskState = { ...cur, answered: { text: a.text, correct: a.correct } };
      setAsk(answered);
      askRef.current = answered;
      if (cur.kind !== "code") pushLog({ kind: "user", text: a.text });
      else pushLog({ kind: "user", text: a.correct ? "提交了代码（运行通过）" : "提交了代码（还没通过）" });
      if (a.correct != null) pushLog({ kind: "result", text: a.correct ? "答对了" : "不完全对", ok: a.correct });

      // 即时反馈：先说一句，讲师那边同时在写下一段
      let quick = "";
      // 判词（对 / 不完全对）由讲师下一段第一拍说，这里只给一句不重复的过渡
      if (cur.kind === "code") quick = a.correct ? "跑通了。" : "我们一起看看。";
      else if (cur.kind === "choice" && a.correct != null) quick = a.correct ? "嗯。" : "我们来看看。";
      else quick = "好，我看看你的想法。";
      replyInsertRef.current = 0;
      if (!fastRef.current) enqueue([{ type: "speak", step_id: -1, spoken_text: quick }], "reply");
      releaseAsk();

      if (replay) return; // 回放：后面的段已经在队列里
      void fetchNext(cur.segment ?? segRef.current, {
        question: cur.question,
        kind: cur.kind,
        options: cur.options,
        text: a.text,
        correct: a.correct,
        code: a.code,
        output: a.output,
        explanation: cur.explanation,
      });
    },
    [enqueue, fetchNext, pushLog, releaseAsk, replay]
  );

  const skipAsk = useCallback(() => {
    const cur = askRef.current;
    if (!cur) return;
    setAsk(null);
    askRef.current = null;
    pushLog({ kind: "note", text: "跳过了这题" });
    releaseAsk();
    if (replay) return;
    void fetchNext(cur.segment ?? segRef.current, { question: cur.question, kind: cur.kind, options: cur.options, text: "（跳过了这题）", explanation: cur.explanation });
  }, [fetchNext, pushLog, releaseAsk, replay]);

  /** 追问 / 没听懂：讲师接住后回到主线（插在当前这一拍之后） */
  const followup = useCallback(
    async (text: string, simpler = false) => {
      const t = text.trim();
      if (!t || chatBusy || replay) return;
      setChatBusy(true);
      pushLog({ kind: "user", text: t });
      setInput("");
      replyInsertRef.current = 0;
      try {
        const res = await fetch("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "answer", courseId, unitId, lectureId, message: t, simpler, pageId: boardRef.current.activePageId }),
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        await consumeSse<BoardEvent>(res, (e) => {
          if (exitedRef.current) return;
          if (e.type === "error") setError(e.message);
          else handleEvent(e, "reply");
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChatBusy(false);
      }
    },
    [chatBusy, courseId, handleEvent, lectureId, pushLog, replay, unitId]
  );

  /** 输入框：有题待答 → 当作答案；否则 → 追问 */
  const submitInput = useCallback(() => {
    const t = input.trim();
    if (!t) return;
    const cur = askRef.current;
    if (cur && !cur.answered && cur.kind !== "code") {
      setInput("");
      const idx = cur.options.findIndex((o) => o.trim() === t);
      answerAsk({ text: t, correct: cur.kind === "choice" && idx >= 0 && cur.correctIndex != null ? idx === cur.correctIndex : undefined });
      return;
    }
    void followup(t);
  }, [answerAsk, followup, input]);

  const shareReplay = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, unitId, lectureId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.id) throw new Error(d.error || `生成失败 (${res.status})`);
      const url = `${window.location.origin}/replay/${d.id}`;
      try {
        await navigator.clipboard.writeText(url);
        setShareMsg("回放链接已复制，发给朋友就能看这节课");
      } catch {
        setShareMsg(url);
      }
    } catch (e) {
      setShareMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSharing(false);
      window.setTimeout(() => setShareMsg(null), 5000);
    }
  }, [courseId, lectureId, sharing, unitId]);

  useEffect(() => {
    return () => {
      exitedRef.current = true;
      speechStopRef.current?.();
      askWaiterRef.current?.();
      setTypewriterPaused(false);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  // ---------------- 播放控制 ----------------

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    setTypewriterPaused(next);
    const a = audioRef.current;
    if (next) a?.pause();
    else {
      if (a) void a.play().catch(() => {});
      void pump();
    }
  }, [pump]);

  const changeRate = useCallback((r: number) => {
    setRate(r);
    rateRef.current = r;
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  const replayLast = useCallback(() => {
    const text = lastSpeechRef.current;
    if (!text) return;
    queueRef.current.unshift({ actions: [{ type: "speak", step_id: -1, spoken_text: text }], origin: "reply" });
    if (pausedRef.current) togglePause();
    speechStopRef.current?.();
    void pump();
  }, [pump, togglePause]);

  // 空格 = 暂停 / 继续（输入框里不拦）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.code === "Space" && (status === "playing" || status === "thinking")) {
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, togglePause]);

  // 沉浸：讲课进行中鼠标静止 2.5 秒，四周的按钮淡出；一动鼠标/按键就回来。暂停、作答、讲完时不藏
  const immersive = (status === "playing" || status === "thinking") && !paused && !(ask && !ask.answered);
  useEffect(() => {
    if (!immersive) {
      setChromeIdle(false);
      return;
    }
    let t = window.setTimeout(() => setChromeIdle(true), 2500);
    const wake = () => {
      setChromeIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setChromeIdle(true), 2500);
    };
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("touchstart", wake);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("touchstart", wake);
    };
  }, [immersive]);

  const togglePanel = useCallback(() => {
    setPanelOpen((v) => {
      try {
        window.localStorage.setItem("wb-panel", v ? "closed" : "open");
      } catch {
        // ignore
      }
      return !v;
    });
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const api = apiRef.current;
    if (!api) return;
    const z = Math.max(0.3, Math.min(2.2, cameraRef.current.zoom + delta));
    try {
      api.updateScene({ appState: { zoom: { value: z } } });
    } catch {
      // ignore
    }
  }, []);

  // 课堂记录自动滚到底
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, chatBusy]);

  const live = status === "playing" || status === "ask" || status === "thinking";
  const totalSegs = plan?.segments.length ?? 0;
  /** 浮在白板上的元素（字幕、题卡、控制条）只占面板左边那块 */
  const rightInset = panelOpen ? PANEL_W + PANEL_GUTTER : 0;
  const lastSayId = [...log].reverse().find((m) => m.kind === "say" || m.kind === "ask")?.id;
  const pill = "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_2px_10px_rgba(0,0,0,0.05)]";
  /** 四周控件：沉浸时淡出（不占交互） */
  const chromeFade = `transition-opacity duration-700 ${chromeIdle ? "pointer-events-none opacity-0" : "opacity-100"}`;

  return (
    <div className="fixed inset-0 z-50 bg-[#fcfcfc]">
      {/* 白板（铺满） */}
      <div className="absolute inset-0 overflow-hidden">
        <Whiteboard
          initialElements={[]}
          onReady={(api) => {
            apiRef.current = api;
          }}
          onCameraChange={(cam) => setCamera(cam)}
          boardFont="handwriting"
        />
        <BoardLayer
          state={board}
          camera={camera}
          register={registerCard}
          onHeight={onHeight}
          onTypingDone={onTypingDone}
          onMediaLoaded={onMediaLoaded}
          thinking={status === "thinking" && !paused && !error}
          onCardClick={(_id, text) => {
            if (isReplay) return;
            setInput(`白板上「${text.slice(0, 30)}」这条，能再展开讲讲吗？`);
            setPanelOpen(true);
          }}
        />
      </div>

      {/* 左上：退出 + 课题胶囊（含分段进度） */}
      <div className={`absolute left-5 top-5 z-[40] flex items-center gap-3 ${chromeFade}`}>
        <button
          onClick={() => setExitOpen(true)}
          className={`flex h-10 w-10 items-center justify-center rounded-full text-[18px] text-[#737373] hover:text-ink ${pill}`}
          aria-label="退出课堂"
        >
          ×
        </button>
        <div className={`flex h-10 max-w-[min(520px,calc(100vw-760px))] min-w-[180px] items-center gap-3 rounded-full pl-[18px] pr-3.5 ${pill}`}>
          <span className="truncate text-[14px] font-semibold text-[#262626]">{lectureTitle}</span>
          {totalSegs > 0 && (
            <span className="flex shrink-0 items-center gap-1" aria-label={`第 ${Math.min(segIndex + 1, totalSegs)} 段，共 ${totalSegs} 段`}>
              {plan!.segments.map((s, i) => (
                <span
                  key={i}
                  title={s.title}
                  className={`h-1.5 rounded-full transition-all ${i < segIndex || finalSeg ? "w-3 bg-[#262626]/45" : i === segIndex ? "w-5 bg-[#262626]" : "w-3 bg-[#e5e5e5]"}`}
                />
              ))}
            </span>
          )}
        </div>
      </div>

      {/* 右上（面板左侧）：缩放 · 语速 · 声音 · 分享 · 课堂记录 */}
      <div className={`absolute top-5 z-[40] flex justify-end ${chromeFade}`} style={{ right: rightInset + 20 }}>
        <div className={`flex h-10 items-center rounded-full px-1.5 text-[13px] text-[#525252] ${pill}`}>
          <button onClick={() => zoomBy(-0.1)} className="h-8 rounded-full px-2.5 hover:bg-[#f5f5f5]" aria-label="缩小">
            −
          </button>
          <button onClick={() => follow(undefined)} className="h-8 min-w-[3.2rem] rounded-full px-1 tabular-nums hover:bg-[#f5f5f5]" title="回到讲师正在写的地方">
            {Math.round(camera.zoom * 100)}%
          </button>
          <button onClick={() => zoomBy(0.1)} className="h-8 rounded-full px-2.5 hover:bg-[#f5f5f5]" aria-label="放大">
            +
          </button>
          <span className="mx-1 h-4 w-px bg-[#e5e5e5]" />
          <select
            value={rate}
            onChange={(e) => changeRate(Number(e.target.value))}
            className="h-8 cursor-pointer rounded-full bg-transparent px-2 text-[12.5px] outline-none hover:bg-[#f5f5f5]"
            aria-label="讲解语速"
            title="讲解语速"
          >
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}x
              </option>
            ))}
          </select>
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className={`flex h-8 items-center rounded-full px-2.5 hover:bg-[#f5f5f5] ${voiceOn ? "" : "text-[#a3a3a3]"}`}
            title={voiceOn ? "关闭语音（只看字幕）" : "开启语音"}
            aria-label={voiceOn ? "关闭语音" : "开启语音"}
          >
            <Icon name={voiceOn ? "voice" : "voice-off"} />
          </button>
          {!isReplay && (
            <button
              onClick={() => void shareReplay()}
              disabled={sharing || !finishedRef.current}
              className="flex h-8 items-center rounded-full px-2.5 hover:bg-[#f5f5f5] disabled:opacity-35"
              title={finishedRef.current ? "生成这节课的只读回放链接" : "讲完后可以分享回放"}
              aria-label="分享回放链接"
            >
              <Icon name="link" />
            </button>
          )}
          {!panelOpen && (
            <>
              <span className="mx-1 h-4 w-px bg-[#e5e5e5]" />
              <button onClick={togglePanel} className="h-8 rounded-full px-3 hover:bg-[#f5f5f5]" aria-label="展开课堂记录">
                课堂记录
              </button>
            </>
          )}
        </div>
      </div>
      {shareMsg && (
        <div className="absolute top-[72px] z-[90] flex justify-center" style={{ left: 0, right: rightInset }}>
          <div className="rounded-lg bg-[#16181c] px-4 py-2 text-[12.5px] text-white shadow-lg">{shareMsg}</div>
        </div>
      )}

      {/* 备课中 */}
      {status === "preparing" && (
        <div className="absolute inset-0 z-[30] flex items-center justify-center bg-[#fcfcfc]/80" style={{ right: rightInset }}>
          <div className="text-center">
            <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
            <div className="mt-3 text-[13px] text-ink-soft">{resumeSegRef.current > 0 ? "正在回到你上次停下的地方…" : "讲师正在备课，第一次开讲大约 15 秒…"}</div>
          </div>
        </div>
      )}

      {/* 课前 / 受阻 */}
      {(status === "ready" || status === "blocked") && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-[#fcfcfc]/92 px-4">
          <div className="w-[440px] max-w-full rounded-3xl bg-white p-7 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_20px_50px_rgba(0,0,0,0.08)]">
            {status === "blocked" && blocked ? (
              <>
                <div className="mb-2 text-[18px] font-bold">{blocked.title}</div>
                <div className="mb-5 text-[13px] leading-relaxed text-ink-soft">{blocked.message}</div>
                <div className="flex justify-end gap-2.5">
                  <button onClick={() => onExit?.()} className="rounded-full border border-[#e6e8eb] px-4 py-2 text-[12.5px] text-ink-soft hover:text-ink">
                    回到课程页
                  </button>
                  <button onClick={() => void startLesson(0)} className="rounded-full bg-[#262626] px-4 py-2 text-[12.5px] text-white hover:opacity-90">
                    重试
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-1 text-[11px] font-semibold tracking-[.1em] text-[#a3a3a3]">{isReplay ? "课堂回放" : "本节课"}</div>
                <div className="mb-2 text-[19px] font-bold leading-snug text-[#262626]">{lectureTitle}</div>
                <div className="mb-6 text-[13px] text-[#8a8a8a]">
                  {isReplay && replay?.courseTitle ? `《${replay.courseTitle}》 · ` : ""}
                  {plan ? `${plan.segments.length} 小段` : "边讲边写"}，每段停下来问你一句
                </div>
                <div className="flex flex-col gap-2">
                  {saved && !saved.finished && saved.segment > 0 ? (
                    <>
                      <button onClick={() => void startLesson(saved.segment)} className="rounded-full bg-[#262626] px-4 py-2.5 text-[13.5px] font-medium text-white hover:opacity-90">
                        从第 {saved.segment + 1} 段继续
                      </button>
                      <button onClick={() => void startLesson(0)} className="rounded-full border border-[#e6e8eb] px-4 py-2 text-[12.5px] text-ink-soft hover:text-ink">
                        从头开始
                      </button>
                    </>
                  ) : (
                    <button onClick={() => void startLesson(0)} className="rounded-full bg-[#262626] px-4 py-2.5 text-[13.5px] font-medium text-white hover:opacity-90">
                      {isReplay ? "播放回放" : saved?.finished ? "再上一遍" : "开始上课"}
                    </button>
                  )}
                  <div className="mt-1 text-center text-[11px] text-[#b5b5b5]">空格暂停</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 底部（面板左侧区域）：题卡 + 字幕 + 状态 */}
      <div className="pointer-events-none absolute bottom-0 left-0 z-[35] flex flex-col items-center gap-3 px-6 pb-6" style={{ right: rightInset }}>
        {status === "done" && (
          <div className={`pointer-events-auto w-[460px] max-w-full rounded-2xl p-5 ${pill}`}>
            <div className="text-[11px] font-semibold tracking-[.1em] text-[#a3a3a3]">{isReplay ? "回放播完了" : "本节完成"}</div>
            {reward ? (
              <>
                <div className="mt-1 text-[18px] font-bold leading-snug text-[#262626]">{reward.title}</div>
                <div className="mt-1 text-[13px] leading-relaxed text-ink-soft">{reward.desc}</div>
              </>
            ) : (
              <div className="mt-1 text-[16px] font-bold">{lectureTitle}</div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {nextLecture && onNextLecture && !isReplay && (
                <button onClick={onNextLecture} className="rounded-full bg-[#262626] px-4 py-2 text-[13px] font-medium text-white hover:opacity-90">
                  下一讲：{nextLecture.title.length > 16 ? `${nextLecture.title.slice(0, 16)}…` : nextLecture.title} →
                </button>
              )}
              <button onClick={() => onExit?.()} className="rounded-full border border-[#e6e8eb] px-4 py-2 text-[13px] text-ink-soft hover:text-ink">
                回课程页
              </button>
            </div>
          </div>
        )}
        {ask && <AskCard key={ask.stepId} ask={ask} busy={chatBusy} onSubmit={answerAsk} onSkip={skipAsk} />}
        {caption.text && status !== "done" && !(ask && !ask.answered) && (
          <div className="max-w-[800px] px-4 text-center">
            <span className="inline rounded-[14px] bg-[rgba(250,250,250,0.82)] px-3.5 py-1.5 text-[16px] font-medium leading-[1.7] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
              <span className="text-[#1f1f1f]">{caption.text.slice(0, caption.reveal)}</span>
              <span className="text-[#c4c4c4]">{caption.text.slice(caption.reveal)}</span>
            </span>
          </div>
        )}
        {/* 等下一句：不放转圈和文字，笔停在板上要落笔的地方轻点（见 BoardLayer thinking） */}
        {paused && live && (
          <div className="rounded-full bg-[rgba(250,250,250,0.86)] px-3.5 py-1 text-[13px] text-[#8a8a8a]">已暂停 · 空格继续</div>
        )}
        {error && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-red-200 bg-red-50 px-4 py-1.5 text-[12.5px] text-red-700">
            {error}
            {retryNext && (
              <button onClick={retryNext} className="font-medium underline underline-offset-2">
                重试
              </button>
            )}
          </div>
        )}
      </div>

      {/* 左下：暂停 · 重听 · 没听懂（面板收起时；展开时这组按钮在面板输入框上方） */}
      {live && !panelOpen && (
        <div className={`absolute bottom-6 left-5 z-[36] flex h-10 items-center gap-0.5 rounded-full px-1.5 text-[12.5px] text-[#404040] ${pill} ${chromeFade}`}>
          <button onClick={togglePause} className="h-8 rounded-full px-3 hover:bg-[#f5f5f5]" aria-label={paused ? "继续讲解" : "暂停讲解"} title="空格键">
            {paused ? "▶ 继续" : "❚❚ 暂停"}
          </button>
          <button onClick={replayLast} className="h-8 rounded-full px-3 hover:bg-[#f5f5f5]" aria-label="重听上一句">
            重听
          </button>
          {!isReplay && (
            <button
              onClick={() => void followup("刚才这段我没听懂，能换个说法、举个具体例子再讲一遍吗？", true)}
              disabled={chatBusy}
              className="h-8 rounded-full px-3 hover:bg-[#f5f5f5] disabled:opacity-40"
              aria-label="没听懂，请讲师换个说法再讲"
            >
              没听懂
            </button>
          )}
          {!isReplay && (
            <button onClick={togglePanel} className="h-8 rounded-full px-3 hover:bg-[#f5f5f5]" aria-label="打开课堂记录，打字提问">
              提问
            </button>
          )}
        </div>
      )}

      {/* 右侧浮动面板：课堂记录（讲师的每一句 + 你的回答），底部随时提问 / 作答 */}
      {panelOpen && (
        <div className="absolute bottom-4 right-3 top-4 z-[45] flex flex-col overflow-hidden rounded-[18px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_8px_30px_rgba(0,0,0,0.06)]" style={{ width: PANEL_W }}>
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#f0f0f0] px-4">
            <span className="text-[14px] font-semibold text-[#262626]">课堂记录</span>
            <button onClick={togglePanel} className="text-[18px] leading-none text-[#a3a3a3] hover:text-ink" aria-label="收起课堂记录">
              ×
            </button>
          </div>
          <div ref={logRef} className="flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
            {log.length === 0 && <div className="pt-6 text-center text-[12.5px] text-[#b5b5b5]">讲过的话会留在这里</div>}
            {log.map((m) =>
              m.kind === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-[14px_14px_3px_14px] bg-[#f0f0f0] px-3.5 py-2 text-[13.5px] leading-[1.55] text-[#333]">{m.text}</div>
                </div>
              ) : m.kind === "note" ? (
                <div key={m.id} className="pt-1 text-center text-[11px] text-[#b5b5b5]">— {m.text} —</div>
              ) : m.kind === "result" ? (
                <div key={m.id} className={`text-[12px] ${m.ok ? "text-emerald-600" : "text-amber-600"}`}>
                  {m.ok ? "✓" : "✗"} {m.text}
                </div>
              ) : m.kind === "reward" ? (
                <div key={m.id} className="rounded-xl bg-[#fafafa] px-3.5 py-2.5">
                  <div className="text-[11px] text-[#a3a3a3]">本节成就</div>
                  <div className="text-[13.5px] font-semibold text-[#262626]">{m.text}</div>
                  {m.label && <div className="text-[12px] text-[#737373]">{m.label}</div>}
                </div>
              ) : (
                <div key={m.id}>
                  {m.kind === "ask" && <div className="mb-0.5 text-[11px] text-[#b5b5b5]">提问</div>}
                  <div className={`text-[13.5px] leading-[1.55] ${m.id === lastSayId ? "font-medium text-[#1f1f1f]" : "text-[#7a7a7a]"}`}>{m.text}</div>
                </div>
              )
            )}
            {chatBusy && <div className="text-[12px] text-[#a3a3a3]">讲师在想怎么回答你…</div>}
          </div>
          {live && (
            <div className="flex items-center gap-1 px-3 pt-2 text-[12px] text-[#525252]">
              <button onClick={togglePause} className="rounded-full px-2.5 py-1 hover:bg-[#f5f5f5]" aria-label={paused ? "继续讲解" : "暂停讲解"} title="空格键">
                {paused ? "▶ 继续" : "❚❚ 暂停"}
              </button>
              <button onClick={replayLast} className="rounded-full px-2.5 py-1 hover:bg-[#f5f5f5]" aria-label="重听上一句">
                重听
              </button>
              {!isReplay && (
                <button
                  onClick={() => void followup("刚才这段我没听懂，能换个说法、举个具体例子再讲一遍吗？", true)}
                  disabled={chatBusy}
                  className="rounded-full px-2.5 py-1 hover:bg-[#f5f5f5] disabled:opacity-40"
                  aria-label="没听懂，请讲师换个说法再讲"
                >
                  没听懂
                </button>
              )}
            </div>
          )}
          {!isReplay && (
            <div className="p-3 pt-1.5">
              <div className="flex items-end gap-2 rounded-[14px] border border-[#ececec] bg-[#fafafa] px-3 py-2 focus-within:border-[#d4d4d4] focus-within:bg-white">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submitInput();
                    }
                  }}
                  placeholder={ask && !ask.answered && ask.kind !== "code" ? "在这里输入你的答案…" : "输入问题…"}
                  aria-label="向讲师提问或作答"
                  rows={1}
                  className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent text-[13.5px] outline-none placeholder:text-[#a3a3a3]"
                />
                <button
                  onClick={submitInput}
                  disabled={!input.trim() || chatBusy}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#262626] text-white disabled:opacity-20"
                  aria-label="发送"
                >
                  ↑
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 退出确认 */}
      {exitOpen && (
        <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#16181c]/40">
          <div className="w-[360px] max-w-[86%] rounded-3xl bg-white p-6 shadow-2xl">
            <div className="mb-1.5 text-[17px] font-bold">{isReplay ? "退出回放？" : "退出这节课？"}</div>
            <div className="mb-5 text-[13px] leading-relaxed text-ink-soft">
              {isReplay ? "回放链接随时可以再打开。" : "进度已自动保存，下次进来可以从这一段继续。"}
            </div>
            <div className="flex justify-end gap-2.5">
              <button onClick={() => setExitOpen(false)} className="rounded-full border border-[#e6e8eb] px-4 py-2 text-[12.5px] text-ink-soft hover:text-ink">
                继续上课
              </button>
              <button
                onClick={() => {
                  exitedRef.current = true;
                  speechStopRef.current?.();
                  onExit?.();
                }}
                className="rounded-full bg-[#262626] px-4 py-2 text-[12.5px] text-white hover:opacity-90"
              >
                退出课堂
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
