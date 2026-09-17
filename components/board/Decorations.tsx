"use client";

// 文本锚定装饰：把 circle/highlight 的归一化 snippet 映射回卡面文字的包围盒，
// 渲染成 SVG 椭圆（手绘描画动画）或高亮块。文字怎么换行、缩放怎么变，圈都贴着字走。
import { useEffect, useRef, useState } from "react";
import type { BoardDecoration } from "@/types/board";
import { anchorRects, buildNormIndex, findSnippet } from "@/lib/board/snippet";

interface Geo {
  id: string;
  kind: "circle" | "highlight";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rect: { x: number; y: number; w: number; h: number };
  color?: string;
}

const CIRCLE_COLOR = "#c2410c";
const EMPTY_DECOS: BoardDecoration[] = [];

function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

interface DecorationsProps {
  rootRef: React.RefObject<HTMLElement | null>;
  decorations: BoardDecoration[];
  zoom: number;
  /** 变化时重算（高度测量后触发） */
  version: number;
}

export function Decorations({ rootRef, decorations = EMPTY_DECOS, zoom, version }: DecorationsProps) {
  const [geos, setGeos] = useState<Geo[]>(EMPTY_DECOS as unknown as Geo[]);
  const renderedRef = useRef("");

  useEffect(() => {
    if (decorations.length === 0) {
      // 只清一次，避免空数组每次渲染触发 setState 形成死循环
      setGeos((prev) => (prev.length === 0 ? prev : (EMPTY_DECOS as unknown as Geo[])));
      return;
    }
    const key = JSON.stringify(decorations) + ":" + version + ":" + zoom.toFixed(2);
    if (renderedRef.current === key) return;
    let cancelled = false;
    const compute = (retries: number) => {
      const root = rootRef.current;
      if (!root || cancelled) return;
      const index = buildNormIndex(root);
      const out: Geo[] = [];
      for (const d of decorations) {
        const refs = findSnippet(index, d.snippet);
        if (!refs) continue;
        const box = anchorRects(refs, root);
        if (!box) continue;
        const pad = Math.max(4, 0.06 * Math.min(box.right - box.left, box.bottom - box.top));
        const x = box.left / zoom;
        const y = box.top / zoom;
        const w = (box.right - box.left) / zoom;
        const h = (box.bottom - box.top) / zoom;
        out.push({
          id: d.id,
          kind: d.kind,
          cx: x + w / 2,
          cy: y + h / 2,
          rx: w / 2 + pad,
          ry: h / 2 + pad,
          rect: { x, y, w, h },
          color: d.color,
        });
      }
      if (!cancelled && out.length > 0) {
        setGeos(out);
        renderedRef.current = key;
      } else if (!cancelled && retries > 0) {
        window.setTimeout(() => compute(retries - 1), 120);
      }
    };
    const raf = requestAnimationFrame(() => compute(3));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [decorations, rootRef, zoom, version]);

  if (geos.length === 0) return null;
  return (
    <svg className="board-note-annotations" aria-hidden>
      {geos.map((g) =>
        g.kind === "highlight" ? (
          <rect
            key={g.id}
            className="board-highlight-rect"
            x={g.rect.x - 3}
            y={g.rect.y - 1}
            width={g.rect.w + 6}
            height={g.rect.h + 2}
            rx={5}
            fill="rgba(253, 230, 138, 0.55)"
          />
        ) : (
          <ellipse
            key={g.id}
            className="board-circle-draw"
            cx={g.cx}
            cy={g.cy}
            rx={g.rx}
            ry={g.ry}
            fill="none"
            stroke={g.color || CIRCLE_COLOR}
            strokeWidth={2}
            strokeLinecap="round"
            style={{
              strokeDasharray: ellipsePerimeter(g.rx, g.ry),
              strokeDashoffset: ellipsePerimeter(g.rx, g.ry),
            }}
          />
        )
      )}
    </svg>
  );
}
