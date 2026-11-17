"use client";

// 白板层：DOM 卡片层，按相机（Excalidraw 的 scroll/zoom）整体平移缩放。
// 与 Hyperknow 一致：卡片是 DOM 覆盖物，画布只当相机与点阵背景。
import { memo } from "react";
import type { BoardItem, BoardState } from "@/types/board";
import type { WhiteboardCamera } from "@/components/Whiteboard";
import { NoteCard, type CardHandle } from "./NoteCard";
import { BoardAnimationCard, BoardImageCard, MermaidCard } from "./MediaCard";

interface BoardLayerProps {
  state: BoardState;
  camera: WhiteboardCamera;
  register: (id: string, h: CardHandle) => void;
  onHeight: (id: string, h: number) => void;
  onTypingDone: (id: string) => void;
  onMediaLoaded: (id: string) => void;
  onCardClick?: (id: string, text: string) => void;
  /** 讲师在想下一句：笔停在当前列要落笔的位置轻点 */
  thinking?: boolean;
}

function renderItem(
  item: BoardItem,
  camera: WhiteboardCamera,
  handlers: Pick<BoardLayerProps, "register" | "onHeight" | "onTypingDone" | "onMediaLoaded" | "onCardClick">
) {
  switch (item.kind) {
    case "note_card":
      return (
        <NoteCard
          key={item.id}
          item={item}
          zoom={camera.zoom}
          register={handlers.register}
          onHeight={handlers.onHeight}
          onTypingDone={handlers.onTypingDone}
          onCardClick={handlers.onCardClick}
        />
      );
    case "board_image":
      return <BoardImageCard key={item.id} item={item} zoom={camera.zoom} onHeight={handlers.onHeight} onLoaded={handlers.onMediaLoaded} />;
    case "board_animation":
      return <BoardAnimationCard key={item.id} item={item} zoom={camera.zoom} onHeight={handlers.onHeight} onLoaded={handlers.onMediaLoaded} />;
    case "mermaid_graph":
      return <MermaidCard key={item.id} item={item} zoom={camera.zoom} onHeight={handlers.onHeight} onLoaded={handlers.onMediaLoaded} />;
    default:
      return null;
  }
}

export const BoardLayer = memo(function BoardLayer({ state, camera, thinking, ...handlers }: BoardLayerProps) {
  const page = state.pages.find((p) => p.id === state.activePageId) ?? state.pages[0];
  if (!page) return null;
  const t = {
    transform: `translate(${camera.scrollX * camera.zoom}px, ${camera.scrollY * camera.zoom}px) scale(${camera.zoom})`,
    transformOrigin: "0 0",
  } as const;
  const col = page.layout ? page.layout.columns[page.layout.activeIndex] : undefined;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden={false}>
      {/* 手绘抖动：表格边框（wob-a/b）与圈画（rough）共用的 SVG 位移滤镜 */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <filter id="wb-wob-a" x="-15%" y="-15%" width="130%" height="130%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.2" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="wb-wob-b" x="-15%" y="-15%" width="130%" height="130%">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="8" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.9" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="wb-rough" x="-10%" y="-30%" width="120%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="5" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <div style={t}>
        {page.items.map((it) => renderItem(it, camera, handlers))}
        {thinking && col && (
          <span className="board-idle-pen" style={{ left: col.x + 2, top: col.nextY + 4 }} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fde68a" stroke="#b45309" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
            <span className="board-idle-dots">
              <i />
              <i />
              <i />
            </span>
          </span>
        )}
      </div>
    </div>
  );
});
