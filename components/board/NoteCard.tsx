"use client";

// 板卡：Markdown + KaTeX 渲染 + 逐字落字 + 文本锚定装饰（圈画/高亮）。
// 结构对标 Hyperknow 实测 DOM：卡片绝对定位（场景坐标）→ 卡体 → 注释 SVG 层。
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "katex/dist/katex.min.css";
import type { NoteCardItem } from "@/types/board";
import { renderMarkdownToHtml } from "@/lib/board/markdown";
import { useTypewriter } from "./useTypewriter";
import { Decorations } from "./Decorations";

export interface CardHandle {
  openGate: () => void;
  forceFinish: () => void;
}

interface NoteCardProps {
  item: NoteCardItem;
  zoom: number;
  /** 注册进播放器的卡片注册表（按 item.id） */
  register: (id: string, h: CardHandle) => void;
  /** 落字/保险丝完成（或尺寸变化）时上报卡片高度 */
  onHeight: (id: string, h: number) => void;
  onTypingDone: (id: string) => void;
  /** 点击卡片（点板书提问） */
  onCardClick?: (id: string, text: string) => void;
}

function NoteCardInner({ item, zoom, register, onHeight, onTypingDone, onCardClick }: NoteCardProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const penRef = useRef<HTMLSpanElement | null>(null);
  const [decorReady, setDecorReady] = useState(0);

  // 笔尖直接改 DOM（不进 React state）：逐字重渲染会打断打字机的 DOM 引用
  const handlePen = useCallback((p: { x: number; y: number } | null) => {
    const el = penRef.current;
    if (!el) return;
    if (!p) {
      el.style.opacity = "0";
      return;
    }
    el.style.opacity = "1";
    el.style.left = `${p.x + 1}px`;
    el.style.top = `${p.y - 16}px`;
  }, []);

  const onDone = useCallback(() => {
    handlePen(null);
    onTypingDone(item.id);
  }, [handlePen, item.id, onTypingDone]);

  const typewriter = useTypewriter(bodyRef, {
    enabled: true,
    contentKey: `${item.id}:${item.content.length}`,
    onDone,
    onPen: handlePen,
  });

  useLayoutEffect(() => {
    register(item.id, { openGate: typewriter.openGate, forceFinish: typewriter.forceFinish });
  }, [item.id, register, typewriter.openGate, typewriter.forceFinish]);

  // 高度测量：内容渲染/装饰/字体加载后都要重测（列流靠它推进 nextY）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const h = Math.max(40, Math.round(el.getBoundingClientRect().height / zoom));
      onHeight(item.id, h);
      setDecorReady((n) => n + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const timers = [80, 280, 700].map((t) => window.setTimeout(measure, t));
    return () => {
      ro.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [item.id, item.content, zoom, onHeight]);

  // 一次性渲染成 HTML：React 不再协调这棵子树，打字机的 span 不会被重渲染冲掉
  const html = useMemo(() => renderMarkdownToHtml(item.content), [item.content]);

  return (
    <div
      ref={rootRef}
      className="board-note-card wb-hand"
      data-item-id={item.id}
      style={{ left: item.x, top: item.y, width: item.w }}
      onClick={() => {
        if (!onCardClick) return;
        const text = (bodyRef.current?.textContent || "").trim().slice(0, 60);
        if (text) onCardClick(item.id, text);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const text = (bodyRef.current?.textContent || "").trim().slice(0, 60);
          if (text) onCardClick?.(item.id, text);
        }
      }}
    >
      <div ref={bodyRef} className="board-note-body" dangerouslySetInnerHTML={{ __html: html }} />
      {item.decorations && item.decorations.length > 0 ? (
        <Decorations rootRef={bodyRef} decorations={item.decorations} zoom={zoom} version={decorReady} />
      ) : null}
      <span ref={penRef} className="board-write-pen" style={{ opacity: 0 }} aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fde68a" stroke="#b45309" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </span>
    </div>
  );
}

export const NoteCard = memo(NoteCardInner, (a, b) => {
  return (
    a.item.id === b.item.id &&
    a.item.content === b.item.content &&
    a.item.x === b.item.x &&
    a.item.y === b.item.y &&
    a.item.w === b.item.w &&
    (a.item.decorations || []).length === (b.item.decorations || []).length &&
    a.zoom === b.zoom
  );
});
