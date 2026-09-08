"use client";

// 课程生成器的跨路由状态仓库。
// 侧栏 tab 切换是真实路由跳转（router.push），首页一离开 CourseGenerator 就整体卸载，
// 组件内 useState 会全部丢失，生成中的 SSE 事件也随之失联——表现为「切走再切回，
// 生成页面回到全新输入页」。这里把状态放在模块级 Map（存活于整个 SPA 生命周期），
// React state 只是它的镜像：卸载期间 handleEvent 继续经 setter 写入 Map，
// 切回首页重新挂载时从 Map 恢复到最新进度（含生成中/已完成）。
// 注意：Map 只活在当前页面会话里，整页刷新（F5）后仍是全新状态。
import { useCallback, useState } from "react";

const PREFIX = "courseGen:";
const store = new Map<string, unknown>();

/** 清空生成器快照：课程交付完成跳转后调用，让下次回到首页是全新输入页 */
export function resetGeneratorState() {
  for (const k of [...store.keys()]) {
    if (k.startsWith(PREFIX)) store.delete(k);
  }
}

export function useGeneratorState<T>(key: string, initial: T) {
  const fullKey = `${PREFIX}${key}`;
  const [value, setValue] = useState<T>(() => {
    // 首次挂载时把初始值落库，保证 setter 里永远能从 Map 取到 prev
    if (!store.has(fullKey)) store.set(fullKey, initial);
    return store.get(fullKey) as T;
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(store.get(fullKey) as T) : next;
      store.set(fullKey, resolved);
      // 组件已卸载时这是一次无害的空操作，仓库已经接住了值
      setValue(resolved);
    },
    [fullKey]
  );

  return [value, set] as const;
}
