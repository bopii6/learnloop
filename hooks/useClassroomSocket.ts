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
  const closedRef = useRef(false);

  useEffect(() => {
    if (!room) return;
    closedRef.current = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/classroom`);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        ws.send(JSON.stringify({ type: "join", room }));
      };
      ws.onmessage = (e) => {
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
        setConnected(false);
        if (!closedRef.current && retryRef.current < 8) {
          retryRef.current += 1;
          setTimeout(connect, Math.min(500 * retryRef.current, 4000));
        }
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // 忽略
        }
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      try {
        wsRef.current?.close();
      } catch {
        // 忽略
      }
      wsRef.current = null;
    };
  }, [room]);

  const send = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ room, ...payload }));
      return true;
    }
    return false;
  }, [room]);

  return { state, connected, send };
}
