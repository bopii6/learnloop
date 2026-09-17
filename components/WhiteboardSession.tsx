"use client";

// 白板课堂（对标 Hyperknow 交互逻辑）：
//   服务端按 Hyperknow 帧格式下发动作 → 本地 step 队列串行播放 → 每个动作真正完成才"回执"并前进。
//   落字=逐字溶解；圈画=文本锚定；讲话=TTS + 卡拉OK字幕；结尾 ask → 作答 → 点评 + 徽章。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardAction, BoardEvent, BoardItem, BoardPage, BoardState, AskState, NoteCardItem } from "@/types/board";
import { addColumn, commitHeight, computeLayoutParams, createPageLayout, newPageId, placeItem, reflowColumn } from "@/lib/board/layout";
import { consumeSse } from "@/lib/sse";
import { fetchTtsSegments, prefetchTts, ttsUnavailable } from "@/lib/tts-client";
import { splitSpeechLines } from "@/lib/speech-lines";
import { Whiteboard, type WhiteboardCamera } from "./Whiteboard";
import { BoardLayer } from "./board/BoardLayer";
import type { CardHandle } from "./board/NoteCard";
import { Icon } from "./icons";
import "./board/board.css";

interface WhiteboardSessionProps {
  courseId: string;
  unitId: string;
  lectureId: string;
  lectureTitle: string;
  onExit?: () => void;
}

interface QueueItem {
  /** 一个 group：组内动作并发执行（board 落字与 speak 讲解同时进行），组间串行 */
  actions: BoardAction[];
  /** 本组 speak 的 step（board 的闸门） */
  gateStep?: number;
}

/** 单个动作的执行上下文（runAction 入参） */
type SingleAction = QueueItem & { action: BoardAction };

type Status = "idle" | "preparing" | "playing" | "paused" | "ask" | "done";

interface ChatMsg {
  id: string;
  kind: "board" | "circle" | "image" | "animation" | "quiz" | "user" | "reward";
  text: string;
  detail?: string;
}

const EMPTY_STATE: BoardState = {
  version: 1,
  revision: 0,
  activePageId: "page-1",
  pages: [{ id: "page-1", items: [], layout: null }],
};

function stepWords(text: string) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]/g) || []).length;
  return { cjk, latin, total: cjk + latin };
}

export function WhiteboardSession({ courseId, unitId, lectureId, lectureTitle, onExit }: WhiteboardSessionProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [board, setBoard] = useState<BoardState>(EMPTY_STATE);
  const [camera, setCamera] = useState<WhiteboardCamera>({ scrollX: 0, scrollY: 0, zoom: 1, vpW: 1440, vpH: 700 });
  const [caption, setCaption] = useState<{ text: string; reveal: number }>({ text: "", reveal: 0 });
  const [ask, setAsk] = useState<AskState | null>(null);
  const [reward, setReward] = useState<{ title: string; desc: string } | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

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
  /** 媒体信箱：generated_* 先于占位卡到达时暂存（回放/缓存命中会瞬时到达），占位出现后立即回填 */
  const mediaStash = useRef(new Map<string, BoardAction>());
  const speechStopRef = useRef<(() => void) | null>(null);
  const exitedRef = useRef(false);
  const uidCounter = useRef(0);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;

  const layoutParams = useMemo(
    () => computeLayoutParams(camera.vpW || 1440, camera.vpH || 700),
    [camera.vpW, camera.vpH]
  );
  const lpRef = useRef(layoutParams);
  lpRef.current = layoutParams;

  // ---- 页面工具 ----
  const activePage = useCallback((): BoardPage => {
    const st = boardRef.current;
    return st.pages.find((p) => p.id === st.activePageId) ?? st.pages[0];
  }, []);

  const updatePage = useCallback((pageId: string, fn: (p: BoardPage) => BoardPage) => {
    setBoard((st) => ({ ...st, revision: st.revision + 1, pages: st.pages.map((p) => (p.id === pageId ? fn(p) : p)) }));
  }, []);

  const pushMsg = useCallback((kind: ChatMsg["kind"], text: string, detail?: string) => {
    setMessages((m) => [...m, { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, text, detail }]);
  }, []);

  // ---- 相机：跟随书写（列可见 + 底部可见） ----
  const focusItem = useCallback((item: { x: number; y: number; w: number; h?: number }) => {
    const api = apiRef.current;
    if (!api) return;
    const cam = cameraRef.current;
    const vpW = cam.vpW || 1200;
    const vpH = cam.vpH || 640;
    const page = activePage();
    let contentRight = 0;
    for (const it of page.items) contentRight = Math.max(contentRight, it.x + it.w);
    contentRight = Math.max(contentRight, item.x + item.w);
    const zoom = Math.max(0.5, Math.min(1.05, vpW / (contentRight + item.w + 100)));
    const colX = item.x;
    const bottom = Math.max(...page.items.map((i) => i.y + Math.max(40, i.h)), item.y + (item.h ?? 90));
    const scrollX = -(colX - 40);
    const viewSceneH = vpH / zoom;
    const top = lpRef.current.gridTop;
    // 整屏装得下 → 顶部对齐；装不下 → 底边（最新板书）贴住视口下沿
    const scrollY =
      bottom - top + 140 <= viewSceneH ? -(top - 70) : -(bottom + 90 - viewSceneH);
    try {
      api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoom } } });
    } catch {
      // 画布未就绪
    }
  }, [activePage]);

  const focusPage = useCallback((page: BoardPage) => {
    const api = apiRef.current;
    if (!api) return;
    const cam = cameraRef.current;
    const vpW = cam.vpW || 1200;
    const vpH = cam.vpH || 640;
    let right = 0;
    let bottom = lpRef.current.gridTop;
    for (const it of page.items) {
      right = Math.max(right, it.x + it.w);
      bottom = Math.max(bottom, it.y + Math.max(40, it.h));
    }
    const zoom = right > 0 ? Math.max(0.5, Math.min(1.05, vpW / (right + 140))) : 1;
    const scrollX = -20;
    const viewSceneH = vpH / zoom;
    const top = lpRef.current.gridTop;
    const scrollY = bottom - top + 140 <= viewSceneH ? -(top - 70) : -(bottom + 90 - viewSceneH);
    try {
      api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoom } } });
    } catch {
      // ignore
    }
  }, []);

  // ---- 回执（本地推进 + 留痕；服务端预生成模式下不需等待网络） ----
  const ack = useCallback((stepId: number) => {
    if (typeof window !== "undefined") {
      const w = window as unknown as { __wbAcks?: number[] };
      w.__wbAcks = w.__wbAcks || [];
      w.__wbAcks.push(stepId);
    }
  }, []);

  // ---- 语音：TTS + 卡拉OK（revealFrom 按播放进度推进） ----
  const speak = useCallback(
    async (text: string): Promise<void> => {
      const { total } = stepWords(text);
      const estMs = Math.max(1200, (text.length * 170 + 400) / (voiceRef.current ? 1 : 1));
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          speechStopRef.current = null;
          setCaption((c) => ({ ...c, reveal: text.length }));
          resolve();
        };
        if (exitedRef.current) return finish();
        if (!voiceRef.current || ttsUnavailable()) {
          // 静音/无云端语音：按阅读节奏推进（字幕照常卡拉OK）
          const t0 = performance.now();
          let raf = 0;
          const tick = (now: number) => {
            const p = Math.min(1, (now - t0) / estMs);
            setCaption({ text, reveal: Math.round(p * text.length) });
            if (p < 1 && !exitedRef.current) raf = requestAnimationFrame(tick);
            else finish();
          };
          raf = requestAnimationFrame(tick);
          speechStopRef.current = () => {
            cancelAnimationFrame(raf);
            finish();
          };
          return;
        }
        void (async () => {
          const segs = await fetchTtsSegments(text);
          if (settled) return;
          if (!segs || segs.length === 0) {
            const t0 = performance.now();
            let raf = 0;
            const tick = (now: number) => {
              const p = Math.min(1, (now - t0) / estMs);
              setCaption({ text, reveal: Math.round(p * text.length) });
              if (p < 1 && !exitedRef.current) raf = requestAnimationFrame(tick);
              else finish();
            };
            raf = requestAnimationFrame(tick);
            speechStopRef.current = () => {
              cancelAnimationFrame(raf);
              finish();
            };
            return;
          }
          const audios = segs.map((u) => {
            const a = new Audio(u);
            a.preload = "auto";
            return a;
          });
          // 先量时长（blob 本地，秒回）
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
              void a.play().catch(() => next());
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
    },
    []
  );

  // ---- 卡片注册 / 完成等待 ----
  const registerCard = useCallback((id: string, h: CardHandle) => {
    cardHandles.current.set(id, h);
  }, []);

  const waitCard = useCallback((id: string) => {
    return new Promise<void>((resolve) => {
      cardWaiters.current.set(id, { resolve });
    });
  }, []);

  const waitMedia = useCallback((id: string) => {
    return new Promise<void>((resolve) => {
      mediaWaiters.current.set(id, { resolve });
    });
  }, []);

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

  const onHeight = useCallback(
    (id: string, h: number) => {
      setBoard((st) => {
        const pages = st.pages.map((p) => {
          const item = p.items.find((i) => i.id === id);
          if (!item || Math.abs(item.h - h) < 1) return p;
          let items = p.items.map((i) => (i.id === id ? ({ ...i, h } as BoardItem) : i));
          const layout = p.layout ? { ...p.layout, columns: p.layout.columns.map((c) => ({ ...c })) } : null;
          if (layout) {
            items = reflowColumn(layout, items, item.columnIndex);
          }
          return { ...p, items, layout };
        });
        return { ...st, pages };
      });
    },
    []
  );

  // ---- 动作执行 ----
  const runAction = useCallback(
    async (item: SingleAction): Promise<void> => {
      const { action } = item;
      const page = activePage();
      const pageId = page.id;
      switch (action.type) {
        case "new_page": {
          const layout = createPageLayout(lpRef.current);
          const p: BoardPage = { id: action.page_id, title: action.title, items: [], layout };
          setBoard((st) => {
            // 丢弃初始空占位页；同 id 旧页替换
            const kept = st.pages.filter((x) => x.id !== action.page_id && !(x.id === "page-1" && x.items.length === 0));
            const pages = [...kept, p];
            return { ...st, revision: st.revision + 1, activePageId: p.id, pages };
          });
          await new Promise((r) => setTimeout(r, 60));
          ack(action.step_id);
          return;
        }
        case "new_column": {
          setBoard((st) => ({
            ...st,
            revision: st.revision + 1,
            pages: st.pages.map((p) => (p.id === pageId && p.layout ? { ...p, layout: addColumn(p.layout) } : p)),
          }));
          await new Promise((r) => setTimeout(r, 30));
          ack(action.step_id);
          return;
        }
        case "board": {
          const cur = activePage();
          const layout = cur.layout ?? createPageLayout(lpRef.current);
          const pos = placeItem(layout);
          const id = `card-${action.board_uid}-${Date.now().toString(36)}`;
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
            animateReveal: true,
            revealGateStep: item.gateStep,
          };
          setBoard((st) => ({
            ...st,
            revision: st.revision + 1,
            pages: st.pages.map((p) =>
              p.id === cur.id
                ? { ...p, layout, items: [...p.items, card] }
                : p
            ),
          }));
          pushMsg("board", (action.title || "").trim() || action.board_content.replace(/[#*`$\\]/g, "").slice(0, 22), action.board_content);
          await new Promise((r) => window.setTimeout(r, 50));
          focusItem(pos);
          // 等落字完成（保险丝：4000 + 24ms/字，上限 30s）
          const failSafe = new Promise<void>((r) => window.setTimeout(r, Math.min(30000, 4000 + 24 * action.board_content.length)));
          await Promise.race([waitCard(id), failSafe]);
          cardHandles.current.get(id)?.forceFinish();
          // 用真实高度推进 nextY
          await new Promise((r) => window.setTimeout(r, 60));
          ack(action.step_id);
          return;
        }
        case "speak": {
          prefetchTts(action.spoken_text);
          await speak(action.spoken_text);
          // 讲完：打开配对卡片的闸门
          const gate = item.gateStep;
          if (gate != null) {
            for (const [, h] of cardHandles.current) h.openGate();
          }
          ack(action.step_id);
          return;
        }
        case "circle":
        case "highlight": {
          const targetUid = action.target_board_id;
          const cur = activePage();
          const target = cur.items.find((i) => i.kind === "note_card" && (i as NoteCardItem).boardUid === targetUid) as NoteCardItem | undefined;
          if (target) {
            const deco = {
              id: `deco-${Date.now().toString(36)}`,
              kind: action.type as "circle" | "highlight",
              snippet: action.snippet,
            };
            setBoard((st) => ({
              ...st,
              revision: st.revision + 1,
              pages: st.pages.map((p) =>
                p.id === cur.id
                  ? { ...p, items: p.items.map((i) => (i.id === target.id ? { ...(i as NoteCardItem), decorations: [...(((i as NoteCardItem).decorations) || []), deco] } : i)) }
                  : p
              ),
            }));
            pushMsg("circle", action.type === "circle" ? "圈画重点" : "高亮重点", action.snippet);
          }
          await new Promise((r) => setTimeout(r, action.type === "circle" ? 920 : 140));
          ack(action.step_id);
          return;
        }
        case "image_gen_pending": {
          const cur = activePage();
          const layout = cur.layout ?? createPageLayout(lpRef.current);
          const pos = placeItem(layout);
          const id = `img-${Date.now().toString(36)}`;
          const card: BoardItem = {
            id,
            kind: "board_image",
            x: pos.x,
            y: pos.y,
            w: pos.w,
            h: Math.round(pos.w * 0.9),
            columnIndex: pos.columnIndex,
            placementStepId: action.placement_step_id,
            boardImage: { imageUrl: "", width: 512, height: 512, caption: action.caption, pending: true },
          };
          setBoard((st) => ({
            ...st,
            revision: st.revision + 1,
            pages: st.pages.map((p) => (p.id === cur.id ? { ...p, layout, items: [...p.items, card] } : p)),
          }));
          pushMsg("image", "配图", action.caption || action.prompt_preview || "");
          focusItem(pos);
          // placement 步立即回执
          ack(action.placement_step_id);
          // 媒体先到（回放）：占位一出现就回填
          {
            const key = `image:${action.placement_step_id}`;
            const stashed = mediaStash.current.get(key);
            if (stashed) {
              mediaStash.current.delete(key);
              window.setTimeout(() => void runAction({ actions: [], action: stashed }), 60);
            }
          }
          return;
        }
        case "generated_image": {
          const cur = activePage();
          const pending = (cur.items.find(
            (i) =>
              i.kind === "board_image" &&
              i.boardImage.pending &&
              (action.placement_step_id == null || i.placementStepId === action.placement_step_id)
          ) ??
            cur.items.find((i) => i.kind === "board_image" && i.boardImage.pending)) as
            | (BoardItem & { kind: "board_image" })
            | undefined;
          if (!pending && action.placement_step_id != null) {
            // 占位还没出现（回放瞬时到达）：先存进信箱，等占位帧处理时回填
            mediaStash.current.set(`image:${action.placement_step_id}`, action);
            ack(action.step_id);
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
          ack(action.step_id);
          return;
        }
        case "animation_pending": {
          const cur = activePage();
          const layout = cur.layout ?? createPageLayout(lpRef.current);
          const pos = placeItem(layout);
          const id = `anim-${Date.now().toString(36)}`;
          const card: BoardItem = {
            id,
            kind: "board_animation",
            x: pos.x,
            y: pos.y,
            w: pos.w,
            h: Math.round(pos.w * 1.4),
            columnIndex: pos.columnIndex,
            placementStepId: action.placement_step_id,
            boardAnimation: { pending: true, task: action.task_preview },
          };
          setBoard((st) => ({
            ...st,
            revision: st.revision + 1,
            pages: st.pages.map((p) => (p.id === cur.id ? { ...p, layout, items: [...p.items, card] } : p)),
          }));
          pushMsg("animation", "互动动画", action.task_preview || "");
          focusItem(pos);
          ack(action.placement_step_id);
          {
            const key = `anim:${action.placement_step_id}`;
            const stashed = mediaStash.current.get(key);
            if (stashed) {
              mediaStash.current.delete(key);
              window.setTimeout(() => void runAction({ actions: [], action: stashed }), 60);
            }
          }
          return;
        }
        case "generated_animation": {
          const cur = activePage();
          const pending = (cur.items.find(
            (i) =>
              i.kind === "board_animation" &&
              i.boardAnimation.pending &&
              (action.placement_step_id == null || i.placementStepId === action.placement_step_id)
          ) ?? cur.items.find((i) => i.kind === "board_animation" && i.boardAnimation.pending));
          if (!pending && action.placement_step_id != null) {
            mediaStash.current.set(`anim:${action.placement_step_id}`, action);
            ack(action.step_id);
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
                          ? ({ ...i, boardAnimation: { html: action.html, task: action.task, pending: false } } as BoardItem)
                          : i
                      ),
                    }
                  : p
              ),
            }));
            await Promise.race([waitMedia(pending.id), new Promise((r) => setTimeout(r, 3000))]);
          }
          ack(action.step_id);
          return;
        }
        case "graph": {
          const cur = activePage();
          const layout = cur.layout ?? createPageLayout(lpRef.current);
          const pos = placeItem(layout);
          const id = `graph-${Date.now().toString(36)}`;
          const card: BoardItem = {
            id,
            kind: "mermaid_graph",
            x: pos.x,
            y: pos.y,
            w: pos.w,
            h: 220,
            columnIndex: pos.columnIndex,
            mermaidGraph: { source: action.mermaid },
          };
          setBoard((st) => ({
            ...st,
            revision: st.revision + 1,
            pages: st.pages.map((p) => (p.id === cur.id ? { ...p, layout, items: [...p.items, card] } : p)),
          }));
          focusItem(pos);
          await Promise.race([waitMedia(id), new Promise((r) => setTimeout(r, 800))]);
          ack(action.step_id);
          return;
        }
        case "ask": {
          setAsk({
            stepId: action.step_id,
            question: action.question,
            options: action.options || [],
            correctIndex: action.correct_index,
            explanation: action.explanation,
          });
          pushMsg("quiz", "小测", action.question);
          setStatus("ask");
          ack(action.step_id);
          return;
        }
        case "reward_user": {
          setReward({ title: action.master_concept_title, desc: action.master_concept_description });
          pushMsg("reward", action.master_concept_title, action.master_concept_description);
          await new Promise((r) => setTimeout(r, 120));
          ack(action.step_id);
          return;
        }
        case "done": {
          ack(action.step_id);
          return;
        }
        default:
          return;
      }
    },
    [ack, activePage, focusItem, pushMsg, speak, waitCard, waitMedia]
  );

  // ---- 队列泵：串行执行，逐拍回执 ----
  const pump = useCallback(async () => {
    if (busyRef.current || exitedRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      setStatus((s) => (s === "ask" ? s : "done"));
      return;
    }
    busyRef.current = true;
    setStatus((s) => (s === "ask" ? s : "playing"));
    try {
      // 组内并发：board 落字 + speak 讲解同时进行；组间串行（上一组全部完成才走下一组）
      await Promise.all(next.actions.map((action) => runAction({ ...next, action })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
    }
    if (!exitedRef.current) window.setTimeout(() => void pump(), 60);
  }, [runAction]);

  const enqueue = useCallback(
    (actions: BoardAction[]) => {
      // generated_* 是"回填空位"，必须到达即生效（不能排在几分钟的播放队列末尾）
      const immediate = actions.filter((a) => a.type === "generated_image" || a.type === "generated_animation");
      const queued = actions.filter((a) => a.type !== "generated_image" && a.type !== "generated_animation");
      for (const a of immediate) {
        void runAction({ actions: [], action: a });
      }
      if (queued.length > 0) {
        // group 打包语义：同组的 speak 是 board 的闸门（board 完成时不早于讲完）
        const speakStep = queued.find((a) => a.type === "speak")?.step_id;
        queueRef.current.push({ actions: queued, gateStep: speakStep });
        if (typeof window !== "undefined") {
          const w = window as unknown as { __wbQueue?: string[][] };
          w.__wbQueue = w.__wbQueue || [];
          w.__wbQueue.push(queued.map((a) => a.type));
        }
        void pump();
      }
    },
    [pump, runAction]
  );

  /** SSE 事件分发：group 包 或 顶层动作帧都能吃（两种形态都在协议里） */
  const handleEvent = useCallback(
    (e: BoardEvent) => {
      if (e.type === "group") {
        enqueue(e.actions);
        return;
      }
      const actionTypes = [
        "board",
        "speak",
        "new_page",
        "new_column",
        "circle",
        "highlight",
        "ask",
        "reward_user",
        "image_gen_pending",
        "generated_image",
        "animation_pending",
        "generated_animation",
        "graph",
        "done",
      ];
      if (actionTypes.includes(e.type)) {
        enqueue([e as BoardAction]);
      }
    },
    [enqueue]
  );

  // ---- 开课：拉取脚本（SSE） ----
  useEffect(() => {
    exitedRef.current = false;
    let cancelled = false;
    void (async () => {
      setStatus("preparing");
      try {
        const res = await fetch("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", courseId, unitId, lectureId }),
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        await consumeSse<BoardEvent>(res, (e) => {
          if (cancelled || exitedRef.current) return;
          if (e.type === "session_ready") {
            setStatus("idle");
          } else if (e.type === "error") {
            setError(e.message);
            setStatus("idle");
          } else if (e.type === "response_complete") {
            // 脚本流结束：队列泵自然收尾
          } else {
            handleEvent(e);
          }
        });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("idle");
        }
      }
    })();
    return () => {
      cancelled = true;
      exitedRef.current = true;
      speechStopRef.current?.();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, unitId, lectureId]);

  // ---- 作答 / 追问 ----
  const submit = useCallback(
    async (text: string, fromAsk?: AskState) => {
      const t = text.trim();
      if (!t || chatBusy) return;
      setChatBusy(true);
      pushMsg("user", t);
      setInput("");
      if (fromAsk) {
        const correct = fromAsk.correctIndex == null ? undefined : fromAsk.options[fromAsk.correctIndex] === t;
        setAsk({ ...fromAsk, answered: { text: t, correct } });
        setStatus("playing");
      }
      try {
        const res = await fetch("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "answer",
            courseId,
            unitId,
            lectureId,
            message: t,
            // 点评追加在当前页（与 Hyperknow 一致：作答反馈不另开一页）
            pageId: boardRef.current.activePageId,
            ask: fromAsk ? { question: fromAsk.question, options: fromAsk.options, correct_index: fromAsk.correctIndex } : undefined,
          }),
        });
        if (!res.ok || !res.body) throw new Error(`请求失败 (${res.status})`);
        await consumeSse<BoardEvent>(res, (e) => {
          if (exitedRef.current) return;
          if (e.type === "error") setError(e.message);
          else handleEvent(e);
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChatBusy(false);
        setAsk(null);
      }
    },
    [chatBusy, courseId, enqueue, lectureId, pushMsg, unitId]
  );

  const pageIndex = board.pages.findIndex((p) => p.id === board.activePageId);

  const gotoPage = useCallback(
    (delta: number) => {
      const st = boardRef.current;
      const idx = st.pages.findIndex((p) => p.id === st.activePageId);
      const next = st.pages[idx + delta];
      if (!next) return;
      setBoard((s) => ({ ...s, activePageId: next.id }));
      window.setTimeout(() => focusPage(next), 30);
    },
    [focusPage]
  );

  const zoomBy = useCallback((delta: number) => {
    const api = apiRef.current;
    if (!api) return;
    const cam = cameraRef.current;
    const z = Math.max(0.3, Math.min(2.2, cam.zoom + delta));
    try {
      api.updateScene({ appState: { zoom: { value: z } } });
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="fixed inset-0 flex flex-col z-50 bg-[#fcfcfc]">
      {/* 顶栏 */}
      <div className="h-14 border-b border-[#e6e8eb] bg-white/80 backdrop-blur flex items-center justify-between gap-3 px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => setExitOpen(true)} className="text-ink-soft hover:text-ink text-[18px] leading-none" aria-label="退出课堂">
            ×
          </button>
          <div className="text-[14px] font-medium truncate max-w-md">{lectureTitle}</div>
          <span className="hidden md:inline-block rounded-full bg-[#f3f4f6] px-2 py-0.5 text-[10px] text-ink-soft shrink-0">AI 生成</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border border-[#e6e8eb] rounded-lg overflow-hidden">
            <button onClick={() => zoomBy(-0.1)} className="px-2.5 py-1.5 text-ink-soft hover:bg-[#f3f4f6]" aria-label="缩小">−</button>
            <button
              onClick={() => apiRef.current?.updateScene({ appState: { zoom: { value: 1 } } })}
              className="px-2 py-1.5 text-[11px] text-ink-soft hover:bg-[#f3f4f6] min-w-[3.1rem] text-center border-x border-[#e6e8eb]"
            >
              {Math.round(camera.zoom * 100)}%
            </button>
            <button onClick={() => zoomBy(0.1)} className="px-2.5 py-1.5 text-ink-soft hover:bg-[#f3f4f6]" aria-label="放大">+</button>
          </div>
          <div className="flex items-center border border-[#e6e8eb] rounded-lg overflow-hidden">
            <button onClick={() => gotoPage(-1)} disabled={pageIndex <= 0} className="px-2.5 py-1.5 text-ink-soft hover:bg-[#f3f4f6] disabled:opacity-35" aria-label="上一页">‹</button>
            <span className="px-2 py-1.5 text-[11px] text-ink-soft min-w-[3rem] text-center border-x border-[#e6e8eb]">
              {pageIndex + 1} / {board.pages.length}
            </span>
            <button onClick={() => gotoPage(1)} disabled={pageIndex >= board.pages.length - 1} className="px-2.5 py-1.5 text-ink-soft hover:bg-[#f3f4f6] disabled:opacity-35" aria-label="下一页">›</button>
          </div>
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${voiceOn ? "border-accent text-accent" : "border-[#e6e8eb] text-ink-soft"}`}
            title={voiceOn ? "关闭语音" : "开启语音"}
          >
            <Icon name={voiceOn ? "voice" : "voice-off"} />
            {voiceOn ? "语音" : "静音"}
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 白板主体 */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <div className="flex-1 relative min-h-0 overflow-hidden">
            <Whiteboard
              initialElements={[]}
              onReady={(api) => {
                apiRef.current = api;
                // 等 Excalidraw 挂载提交完成再动相机（同步 updateScene 会触发渲染循环）
                window.setTimeout(() => focusPage(activePage()), 80);
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
              onCardClick={(id, text) => {
                setInput(`请把白板上「${text}」这条展开讲一讲`);
              }}
            />
            {status === "preparing" && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#fcfcfc]/85">
                <div className="text-[13px] text-ink-soft">AI 讲师正在备课…</div>
              </div>
            )}
          </div>

          {/* 底部：字幕 + 小测 */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex flex-col items-center gap-2 pb-3 px-4">
            {ask && (
              <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-[#e6e8eb] bg-white shadow-lg px-4 py-3">
                <div className="text-[12px] text-accent mb-1">小测 · 答完讲师继续</div>
                <div className="text-[14px] font-medium mb-2">{ask.question}</div>
                {ask.answered ? (
                  <div className="text-[12.5px] text-ink-soft">
                    你选了「{ask.answered.text}」
                    {ask.answered.correct != null ? (ask.answered.correct ? "（正确）" : "（再想想）") : ""}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {ask.options.map((o) => (
                      <button
                        key={o}
                        onClick={() => void submit(o, ask)}
                        disabled={chatBusy}
                        className="rounded-lg border border-[#e6e8eb] px-3 py-1.5 text-[12.5px] hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {caption.text && (
              <div className="w-full max-w-3xl rounded-xl bg-[#16181c]/85 px-4 py-2 text-[13px] leading-relaxed text-white">
                {caption.text.slice(0, caption.reveal)}
                <span className="text-[#ffd9a8]">{caption.text.slice(caption.reveal)}</span>
              </div>
            )}
          </div>
        </div>

        {/* 右栏：对话记录 */}
        <div className="w-80 border-l border-[#e6e8eb] bg-white flex flex-col shrink-0">
          <div className="p-3 border-b border-[#e6e8eb] text-[13px] font-medium">对话记录</div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.map((m) => (
              <div key={m.id} className={`rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${m.kind === "user" ? "bg-accent text-white ml-6" : "bg-[#f7f7f6] text-ink mr-4"}`}>
                {m.kind !== "user" && (
                  <div className="text-[10.5px] text-ink-faint mb-0.5">
                    {m.kind === "board" ? "板书" : m.kind === "circle" ? "圈画" : m.kind === "image" ? "配图" : m.kind === "animation" ? "互动动画" : m.kind === "quiz" ? "小测" : m.kind === "reward" ? "徽章" : ""}
                  </div>
                )}
                <div className="line-clamp-3">{m.text}</div>
              </div>
            ))}
            {chatBusy && <div className="text-[12px] text-ink-soft px-2">讲师正在回应…</div>}
            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</div>}
          </div>
          <div className="p-3 border-t border-[#e6e8eb]">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit(input);
                  }
                }}
                placeholder="向讲师提问 / 作答…"
                rows={1}
                className="flex-1 resize-none rounded-lg border border-[#e6e8eb] px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
              <button
                onClick={() => void submit(input)}
                disabled={!input.trim() || chatBusy}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40"
              >
                发送
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 徽章 */}
      {reward && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-[#16181c]/45">
          <div className="w-[420px] max-w-[88%] rounded-3xl border border-[#e6e8eb] bg-white shadow-2xl p-7">
            <div className="text-[11px] text-accent font-semibold tracking-[.1em] mb-1">课堂成就</div>
            <div className="text-[20px] font-bold leading-snug mb-1.5">{reward.title}</div>
            <div className="text-[12.5px] text-ink-soft leading-relaxed mb-4">{reward.desc}</div>
            <button onClick={() => setReward(null)} className="rounded-lg bg-accent px-5 py-2 text-[12.5px] text-white hover:opacity-90">
              知道了
            </button>
          </div>
        </div>
      )}

      {/* 退出确认 */}
      {exitOpen && (
        <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#16181c]/45">
          <div className="w-[360px] max-w-[86%] rounded-3xl border border-[#e6e8eb] bg-white shadow-2xl p-6">
            <div className="text-[17px] font-bold mb-1.5">退出这节课？</div>
            <div className="text-[13px] text-ink-soft leading-relaxed mb-5">讲解进度会保留，下次进来可以继续。</div>
            <div className="flex gap-2.5 justify-end">
              <button onClick={() => setExitOpen(false)} className="rounded-lg border border-[#e6e8eb] px-4 py-2 text-[12.5px] text-ink-soft hover:border-accent hover:text-accent">
                继续上课
              </button>
              <button
                onClick={() => {
                  exitedRef.current = true;
                  speechStopRef.current?.();
                  onExit?.();
                }}
                className="rounded-lg bg-accent px-4 py-2 text-[12.5px] text-white hover:opacity-90"
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
