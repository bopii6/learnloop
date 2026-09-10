"use client";

// 课堂 WebSocket 通道：断线重连 + 状态恢复 + 进度上报。
// 服务端为 server.mjs 里的 /ws/classroom。
import { useCallback, useEffect, useRef, useState } from "react";

export interface ClassroomState {
  room: string;
  script: any[];
  points?: string[];
  messages?: any[];
  elements?: any[];
  cursor?: number;
  writer?: Record<string, any>; // 白板布局游标快照（BoardWriter.snapshot()）
  updated_at?: string;
}

export function useClassroomSocket(room: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ClassroomState | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);
  const connectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!room) return;
    // 所有状态收在 effect 世代内（而不是跨世代共享的 ref）：
    // StrictMode 双挂载 / room 切换时，旧世代 socket 的异步 onclose 不会误触发重连
    let disposed = false;
    let retryTimer: number | null = null;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/classroom`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || !ws) return;
        retryRef.current = 0;
        ws.send(JSON.stringify({ type: "join", room }));
      };
      ws.onmessage = (e) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "joined") {
            setConnected(true);
            setState(msg.state || null);
          } else if (msg.type === "saved") {
            setConnected(true);
          }
        } catch {
          // 忽略坏帧
        }
      };
      ws.onclose = () => {
        if (disposed) return; // 旧世代的关闭事件不重连
        setConnected(false);
        if (retryRef.current < 8) {
          retryRef.current += 1;
          retryTimer = window.setTimeout(connect, Math.min(500 * retryRef.current, 4000));
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // 忽略
        }
      };
    };
    connectRef.current = connect;

    connect();

    return () => {
      disposed = true;
      connectRef.current = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {
        // 忽略
      }
      if (wsRef.current === ws) wsRef.current = null; // 只清自己的 socket，不动新世代的
    };
  }, [room]);

  const send = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ room, ...payload }));
      return true;
    }
    return false;
  }, [room]);

  /** 手动重连：自动重试 8 次耗尽后，用户点"重连"时用（重置退避计数） */
  const reconnect = useCallback(() => {
    retryRef.current = 0;
    try {
      wsRef.current?.close(); // 触发 onclose → 走正常重连链路
    } catch {
      // 忽略
    }
    connectRef.current?.();
  }, []);

  return { state, connected, send, reconnect };
}
