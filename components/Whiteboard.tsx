"use client";

import { useEffect, useRef, useState } from "react";
// Excalidraw 的样式是独立 CSS 文件（非 CSS-in-JS），不导入会渲染成无样式裸文本
import "@excalidraw/excalidraw/index.css";

// 白板字体（含中文手写体 Xiaolai）自托管：默认从 esm.sh CDN 拉，国内不稳定且会导致
// CJK 手写体静默回退成系统印刷体。字体文件拷贝在 public/excalidraw-assets/fonts/。
if (typeof window !== "undefined") {
  (window as any).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
}

interface WhiteboardProps {
  initialElements?: any[];
  onElementsChange?: (elements: any[]) => void;
  onReady?: (api: any) => void;
  viewMode?: boolean;
  zenMode?: boolean;
  boardFont?: string;
  boardDots?: boolean;
}

export function Whiteboard({
  initialElements = [],
  onElementsChange,
  onReady,
  viewMode = true,
  zenMode = false,
  boardFont = "handwriting",
  boardDots = true,
}: WhiteboardProps) {
  const excalidrawRef = useRef<any>(null);
  const [Excalidraw, setExcalidraw] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const mod = await import("@excalidraw/excalidraw");
        if (mounted) {
          setExcalidraw(() => mod.Excalidraw);
          setLoading(false);
        }
      } catch (e) {
        console.error("Failed to load Excalidraw:", e);
        setLoading(false);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#faf9f6]">
        <div className="text-[14px] text-ink-soft">正在加载白板...</div>
      </div>
    );
  }

  if (!Excalidraw) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#faf9f6]">
        <div className="text-[14px] text-red-600">白板加载失败</div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative excalidraw-host" data-board-font={boardFont} data-board-dots={boardDots ? "on" : "off"}>
      <Excalidraw
        excalidrawAPI={(api: any) => {
          excalidrawRef.current = api;
          onReady?.(api);
        }}
        initialData={{
          elements: initialElements,
          appState: {
            viewBackgroundColor: "transparent",
            // Excalidraw 0.18：CJK 手写回退链（Xiaolai）只挂在 family 5（Excalifont）上，1 是无中文的 Virgil
            currentItemFontFamily: boardFont === "handwriting" ? 5 : 2,
          },
        }}
        onChange={(elements: any[]) => {
          onElementsChange?.(elements);
        }}
        viewModeEnabled={viewMode}
        zenModeEnabled={zenMode}
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
          },
        }}
      />
      <style>{`
        .excalidraw-host {
          --ws-bg-size: 28px;
          --ws-bg-x: 0px;
          --ws-bg-y: 0px;
          --ws-dot-r0: 0.55px;
          --ws-dot-r1: 1.7px;
        }
        .excalidraw-host[data-board-dots="on"] {
          background-color: #faf9f6;
          background-image:
            radial-gradient(circle at 1px 1px, #d3d1c7 var(--ws-dot-r0), transparent 0),
            radial-gradient(circle at 14px 14px, #d3d1c7 var(--ws-dot-r1), transparent 0);
          background-size: var(--ws-bg-size) var(--ws-bg-size);
          background-position: var(--ws-bg-x) var(--ws-bg-y);
        }
        .excalidraw-host[data-board-dots="off"] {
          background-color: #faf9f6;
        }
      `}</style>
    </div>
  );
}
