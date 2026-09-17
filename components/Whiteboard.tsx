"use client";

import { useEffect, useRef, useState } from "react";
// Excalidraw 的样式是独立 CSS 文件（非 CSS-in-JS），不导入会渲染成无样式裸文本
import "@excalidraw/excalidraw/index.css";

// 白板字体资源自托管（避免默认从 esm.sh CDN 拉导致 CJK 静默回退）。
// 墨纸主题起板书一律用无衬线（family 2，中文走系统黑体）：手写体是"低龄感"的主要来源，已停用。
if (typeof window !== "undefined") {
  (window as any).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
}

export interface WhiteboardCamera {
  scrollX: number;
  scrollY: number;
  zoom: number;
  vpW: number;
  vpH: number;
}

interface WhiteboardProps {
  initialElements?: any[];
  onElementsChange?: (elements: any[]) => void;
  onReady?: (api: any) => void;
  onZoomChange?: (zoom: number) => void;
  /** 相机状态（场景坐标/缩放/视口）：DOM 卡片层按它做平移与缩放 */
  onCameraChange?: (cam: WhiteboardCamera) => void;
  viewMode?: boolean;
  zenMode?: boolean;
  boardFont?: string;
  /** 点击白板（非拖拽平移）→ 回调场景坐标。白板可点（点哪条讲哪条）的入口 */
  onBoardClick?: (sceneX: number, sceneY: number) => void;
}

export function Whiteboard({
  initialElements = [],
  onElementsChange,
  onReady,
  onZoomChange,
  onCameraChange,
  viewMode = true,
  zenMode = false,
  boardFont = "clean",
  onBoardClick,
}: WhiteboardProps) {
  const excalidrawRef = useRef<any>(null);
  const lastCamRef = useRef<WhiteboardCamera | null>(null);
  const v2sRef = useRef<((p: { clientX: number; clientY: number }, appState: any) => { x: number; y: number }) | null>(null);
  const [Excalidraw, setExcalidraw] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [retrySeed, setRetrySeed] = useState(0); // 加载失败后的手动重试计数（重触发动态导入）
  // 区分"点一下"和"拖拽平移"：按下位置离抬起位置太远就当平移，不触发点击回调
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);

  const handleBoardClick = (e: { clientX: number; clientY: number }) => {
    if (!onBoardClick) return;
    const press = pressPointRef.current;
    pressPointRef.current = null;
    if (!press) return;
    if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 6) return; // 拖拽平移
    const v2s = v2sRef.current;
    const api = excalidrawRef.current;
    if (!v2s || !api) return;
    try {
      // viewportCoordsToSceneCoords 是包的导出工具（不在 api 对象上），坐标换算要带当前 appState
      const p = v2s({ clientX: e.clientX, clientY: e.clientY }, api.getAppState());
      onBoardClick(p.x, p.y);
    } catch {
      // 坐标换算失败（场景重置中）忽略
    }
  };

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const mod = await import("@excalidraw/excalidraw");
        if (mounted) {
          setExcalidraw(() => mod.Excalidraw);
          v2sRef.current = mod.viewportCoordsToSceneCoords || null;
          setLoading(false);
        }
      } catch (e) {
        console.error("Failed to load Excalidraw:", e);
        if (mounted) setLoading(false);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, [retrySeed]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center [background-color:var(--board-bg,#f6f7f9)]">
        <div className="text-[14px] text-ink-soft">正在加载白板…</div>
      </div>
    );
  }

  if (!Excalidraw) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 [background-color:var(--board-bg,#f6f7f9)]">
        <div className="text-[14px] text-red-600">白板加载失败（网络或资源问题）</div>
        {/* 白板就绪是开讲的硬前提：失败必须给一条自助重试路，不能让课堂永远停在"正在准备白板" */}
        <button
          onClick={() => {
            setLoading(true);
            setExcalidraw(null);
            setRetrySeed((n) => n + 1);
          }}
          className="rounded-lg bg-accent px-4 py-2 text-[12.5px] text-white font-medium hover:opacity-90"
        >
          重试加载
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex-1 relative excalidraw-host"
      data-board-font={boardFont}
      onPointerDown={(e) => {
        pressPointRef.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={handleBoardClick}
    >
      <Excalidraw
        excalidrawAPI={(api: any) => {
          excalidrawRef.current = api;
          onReady?.(api);
        }}
        initialData={{
          elements: initialElements,
          appState: {
            viewBackgroundColor: "transparent",
            // 墨纸主题：板书统一无衬线 family 2。family 5 是手写体（Excalifont/Xiaolai），已停用
            currentItemFontFamily: boardFont === "handwriting" ? 5 : 2,
          },
        }}
        onChange={(elements: any[], appState: any) => {
          onElementsChange?.(elements);
          onZoomChange?.(appState?.zoom?.value ?? 1);
          if (onCameraChange) {
            const next = {
              scrollX: typeof appState?.scrollX === "number" ? appState.scrollX : 0,
              scrollY: typeof appState?.scrollY === "number" ? appState.scrollY : 0,
              zoom: appState?.zoom?.value ?? 1,
              vpW: appState?.width ?? 1200,
              vpH: appState?.height ?? 700,
            };
            const prev = lastCamRef.current;
            if (
              !prev ||
              Math.abs(prev.scrollX - next.scrollX) > 0.5 ||
              Math.abs(prev.scrollY - next.scrollY) > 0.5 ||
              Math.abs(prev.zoom - next.zoom) > 0.001 ||
              prev.vpW !== next.vpW ||
              prev.vpH !== next.vpH
            ) {
              lastCamRef.current = next;
              onCameraChange(next);
            }
          }
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
        /* 课堂是"看"的模式：库自带的汉堡菜单 / 帮助 / 左下缩放全部隐藏，
           缩放由顶栏自研控件统一提供，避免两套 UI 并存 */
        .excalidraw-host .main-menu-trigger,
        .excalidraw-host .help-icon,
        .excalidraw-host .layer-ui__wrapper__footer-left {
          display: none !important;
        }
        .excalidraw-host {
          background-color: var(--board-bg, #f6f7f9);
        }
      `}</style>
    </div>
  );
}
