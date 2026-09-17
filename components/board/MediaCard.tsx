"use client";

// 媒体卡：AI 生图 / AI 生成 HTML 动画 / Mermaid 图。
// 语义对齐 Hyperknow：先占位（不阻塞讲解）→ 资源到达替换 → 列内回流；等图有上限（2.8s）。
import { memo, useEffect, useRef, useState } from "react";
import type { BoardAnimationItem, BoardImageItem, MermaidGraphItem } from "@/types/board";
import { MermaidRenderer } from "@/components/MermaidRenderer";

interface BaseProps {
  zoom: number;
  onHeight: (id: string, h: number) => void;
  onLoaded?: (id: string) => void;
}

function useMeasure(rootRef: React.RefObject<HTMLElement | null>, id: string, deps: unknown[], onHeight: (id: string, h: number) => void, zoom: number) {
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const h = Math.max(40, Math.round(el.getBoundingClientRect().height / zoom));
      onHeight(id, h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const BoardImageCard = memo(function BoardImageCard({
  item,
  zoom,
  onHeight,
  onLoaded,
}: BaseProps & { item: BoardImageItem }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const img = item.boardImage;
  const ratio = img.width > 0 ? img.height / img.width : 1;
  const imgH = Math.round(item.w * ratio) + (img.caption ? 34 : 0);
  useMeasure(rootRef, item.id, [item.id, item.w, loaded], onHeight, zoom);

  useEffect(() => {
    if (img.pending || !img.imageUrl) {
      // 等图上限：超时也照常推进（由播放器保险丝兜底）
      const t = window.setTimeout(() => onLoaded?.(item.id), 15000);
      return () => window.clearTimeout(t);
    }
  }, [img.pending, img.imageUrl, item.id, onLoaded]);

  return (
    <div
      ref={rootRef}
      className="board-media-card wb-hand"
      style={{ left: item.x, top: item.y, width: item.w }}
      data-item-id={item.id}
    >
      {img.pending || !img.imageUrl ? (
        <div className="board-media-pending" style={{ height: imgH || 240 }}>
          配图中…
        </div>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="board-media-img"
            src={img.imageUrl}
            alt={img.caption || ""}
            onLoad={() => {
              setLoaded(true);
              onLoaded?.(item.id);
            }}
            onError={() => onLoaded?.(item.id)}
          />
          {img.caption ? <div className="board-media-caption">{img.caption}</div> : null}
        </>
      )}
    </div>
  );
});

export const BoardAnimationCard = memo(function BoardAnimationCard({
  item,
  zoom,
  onHeight,
  onLoaded,
}: BaseProps & { item: BoardAnimationItem }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anim = item.boardAnimation;
  const height = Math.round(item.w * 1.4); // 实测动画卡比例 ≈ 380×532
  useMeasure(rootRef, item.id, [item.id, item.w, !!anim.html], onHeight, zoom);

  useEffect(() => {
    if (!anim.pending && anim.html) {
      const t = window.setTimeout(() => onLoaded?.(item.id), 400);
      return () => window.clearTimeout(t);
    }
  }, [anim.pending, anim.html, item.id, onLoaded]);

  const html = anim.html || "";
  const withCsp = html.includes("Content-Security-Policy")
    ? html
    : html.replace(
        /<head([^>]*)>/i,
        `<head$1><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`
      );

  return (
    <div
      ref={rootRef}
      className="board-media-card wb-hand"
      style={{ left: item.x, top: item.y, width: item.w }}
      data-item-id={item.id}
    >
      {anim.pending || !anim.html ? (
        <div className="board-media-pending" style={{ height }}>
          正在生成互动动画…
        </div>
      ) : (
        <iframe
          className="board-anim-frame"
          style={{ height }}
          sandbox="allow-scripts"
          title={anim.task || "互动动画"}
          srcDoc={withCsp}
        />
      )}
      {anim.task ? <div className="board-media-caption">{anim.task.slice(0, 40)}</div> : null}
    </div>
  );
});

export const MermaidCard = memo(function MermaidCard({
  item,
  zoom,
  onHeight,
  onLoaded,
}: BaseProps & { item: MermaidGraphItem }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useMeasure(rootRef, item.id, [item.id, item.w], onHeight, zoom);
  useEffect(() => {
    const t = window.setTimeout(() => onLoaded?.(item.id), 600);
    return () => window.clearTimeout(t);
  }, [item.id, onLoaded]);
  return (
    <div
      ref={rootRef}
      className="board-media-card"
      style={{ left: item.x, top: item.y, width: item.w }}
      data-item-id={item.id}
    >
      <MermaidRenderer code={item.mermaidGraph.source} />
    </div>
  );
});
