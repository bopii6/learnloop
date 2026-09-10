"use client";

// 课程生成器的跨路由状态仓库。
// 侧栏 tab 切换是真实路由跳转（router.push），首页一离开 CourseGenerator 就整体卸载，
// 组件内 useState 会全部丢失，生成中的 SSE 事件也随之失联——表现为「切走再切回，
// 生成页面回到全新输入页」。这里把状态放在模块级 Map（存活于整个 SPA 生命周期），
// React state 只是它的镜像：卸载期间 handleEvent 继续经 setter 写入 Map，
// 切回首页重新挂载时从 Map 恢复到最新进度（含生成中/已完成）。
// F5 兜底：Map 同步落 sessionStorage——整页刷新后恢复到刷新前的快照。
// 课堂的断点恢复（WS 快照）就是这么对待用户的，生成器不该更娇气。
// 注意：sessionStorage 关标签即清，跨会话不保证（这是刻意的：半途而废的草稿不值得跨天保留）。
import { useCallback, useState } from "react";

const PREFIX = "courseGen:";
const store = new Map<string, unknown>();

function sessionAvailable(): boolean {
  try {
    return typeof window !== "undefined" && !!window.sessionStorage;
  } catch {
    return false;
  }
}

function sessionRead<T>(fullKey: string): T | undefined {
  if (!sessionAvailable()) return undefined;
  try {
    const raw = window.sessionStorage.getItem(fullKey);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function sessionWrite(fullKey: string, value: unknown) {
  if (!sessionAvailable()) return;
  try {
    window.sessionStorage.setItem(fullKey, JSON.stringify(value));
  } catch {
    // 序列化失败/容量满：静默降级，刷新丢进度可接受
  }
}

function sessionDelete(fullKey: string) {
  if (!sessionAvailable()) return;
  try {
    window.sessionStorage.removeItem(fullKey);
  } catch {
    // ignore
  }
}

/** 清空生成器快照：课程交付完成跳转后调用，让下次回到首页是全新输入页 */
export function resetGeneratorState() {
  for (const k of [...store.keys()]) {
    if (k.startsWith(PREFIX)) store.delete(k);
  }
  if (!sessionAvailable()) return;
  try {
    for (const k of [...window.sessionStorage.keys]) {
      if (k.startsWith(PREFIX)) window.sessionStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}

export function useGeneratorState<T>(key: string, initial: T) {
  const fullKey = `${PREFIX}${key}`;
  const [value, setValue] = useState<T>(() => {
    // 优先恢复刷新前的快照，其次首次挂载落库初始值（保证 setter 里永远能从 Map 取到 prev）
    const saved = sessionRead<T>(fullKey);
    if (!store.has(fullKey)) {
      store.set(fullKey, saved !== undefined ? saved : initial);
    }
    return store.get(fullKey) as T;
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(store.get(fullKey) as T) : next;
      store.set(fullKey, resolved);
      sessionWrite(fullKey, resolved);
      // 组件已卸载时这是一次无害的空操作，仓库已经接住了值
      setValue(resolved);
    },
    [fullKey]
  );

  return [value, set] as const;
}
