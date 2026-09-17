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

export const BoardLayer = memo(function BoardLayer({ state, camera, ...handlers }: BoardLayerProps) {
  const page = state.pages.find((p) => p.id === state.activePageId) ?? state.pages[0];
  if (!page) return null;
  const t = {
    transform: `translate(${camera.scrollX * camera.zoom}px, ${camera.scrollY * camera.zoom}px) scale(${camera.zoom})`,
    transformOrigin: "0 0",
  } as const;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden={false}>
      <div style={t}>
        {page.items.map((it) => renderItem(it, camera, handlers))}
      </div>
    </div>
  );
});
