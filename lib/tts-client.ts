// 白板语音播报的云端 TTS 客户端：调用 /api/tts（阿里云百炼 qwen3-tts）。
// 服务端未配置 key（501）或请求失败时返回 null，调用方回退浏览器 speechSynthesis。
// blob URL 进程内缓存：同一句重播/续播不再请求、不再计费。
const cache = new Map<string, string[]>(); // 原文 -> blob URL 分段
let disabled = false; // 服务端未配置时置 true，本次会话不再发请求

export function ttsUnavailable(): boolean {
  return disabled;
}

/** 预取下一句的音频（当前句播放期间后台合成，消除逐句等待） */
export function prefetchTts(text: string | undefined | null): void {
  if (!text || disabled || cache.has(text)) return;
  void fetchTtsSegments(text).catch(() => {});
}

function b64ToBlobUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/** 合成整句，返回按序播放的分段 blob URL；不可用返回 null */
export async function fetchTtsSegments(text: string): Promise<string[] | null> {
  if (!text || disabled) return null;
  const hit = cache.get(text);
  if (hit) return hit;
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(35000),
    });
    if (res.status === 501) {
      disabled = true;
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const segs: unknown = data?.segments;
    if (!Array.isArray(segs) || segs.length === 0 || typeof segs[0] !== "string") return null;
    const urls = (segs as string[]).map(b64ToBlobUrl);
    if (cache.size >= 200) clearTtsCache();
    cache.set(text, urls);
    return urls;
  } catch {
    return null;
  }
}

export function clearTtsCache(): void {
  for (const urls of cache.values()) urls.forEach((u) => URL.revokeObjectURL(u));
  cache.clear();
}

export type TtsPlayer = { promise: Promise<void>; stop: () => void };

/** 按序播放分段音频；stop() 立即停止并让 promise 收敛（暂停/退出/切换语音时调用） */
export function createTtsPlayer(urls: string[], rate: number): TtsPlayer {
  let stopped = false;
  let audio: HTMLAudioElement | null = null;
  let onStopped: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    onStopped = resolve; // stop() 时立即收敛；后续自然播完的 resolve 是空操作
    (async () => {
      for (const url of urls) {
        if (stopped) return;
        await new Promise<void>((next) => {
          audio = new Audio(url);
          audio.playbackRate = Math.max(0.5, Math.min(3, rate || 1));
          audio.onended = () => next();
          audio.onerror = () => next();
          void audio.play().catch(() => next());
        });
      }
      resolve();
    })();
  });
  return {
    promise,
    stop: () => {
      stopped = true;
      try {
        if (audio) {
          audio.pause();
          audio.src = "";
        }
      } catch {
        // ignore
      }
      onStopped?.();
    },
  };
}
