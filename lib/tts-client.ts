// 白板语音播报的云端 TTS 客户端：调用 /api/tts（阿里云百炼 qwen3-tts）。
// 服务端没嘴（501 未配置 key / 401·403 未登录，如回放页）时立即禁用本会话，不再空耗重试；
// 已配置但瞬时失败则重试，仍失败进入冷却窗口由调用方安静推进——不再用浏览器音色凑合。
// blob URL 进程内缓存：同一句重播/续播不再请求、不再计费。
const cache = new Map<string, string[]>(); // 原文 -> blob URL 分段
const inflight = new Map<string, Promise<string[] | null>>(); // 在途请求：预取与 speak 并发时去重，同句不双倍计费
let disabled = false; // 服务端没嘴（501/401/403）时置 true，本次会话不再发请求
let failStreak = 0; // 连续失败计数：瞬时抖动不该把课堂拖回生硬的浏览器音色
let failBackoffUntil = 0; // 连续失败后的快速失败窗口：先安静推进，稍后再探

export function ttsUnavailable(): boolean {
  return disabled;
}

/** 预取下一句的音频（当前句播放期间后台合成，消除逐句等待） */
export function prefetchTts(text: string | undefined | null): void {
  if (!text || disabled || cache.has(text) || inflight.has(text)) return;
  void fetchTtsSegments(text).catch(() => {});
}

function b64ToBlobUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/** 真发请求：瞬时故障重试一次（偶发网络抖动/5xx 第二击基本能中），仍失败进入冷却计数 */
async function requestSegments(text: string): Promise<string[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(20000),
      });
      // 服务端没嘴：501 未配置 key / 401·403 未登录（如回放页）——本会话立即禁用，不空耗重试
      if (res.status === 501 || res.status === 401 || res.status === 403) {
        disabled = true;
        return null;
      }
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const data = await res.json();
      const segs: unknown = data?.segments;
      if (!Array.isArray(segs) || segs.length === 0 || typeof segs[0] !== "string") {
        throw new Error("tts bad-response");
      }
      const urls = (segs as string[]).map(b64ToBlobUrl);
      if (cache.size >= 200) clearTtsCache();
      cache.set(text, urls);
      failStreak = 0;
      return urls;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }
  failStreak++;
  if (failStreak >= 2) failBackoffUntil = Date.now() + 30000; // 连续两轮失败：冷却 30s，期间安静推进
  return null;
}

/** 合成整句，返回按序播放的分段 blob URL；不可用返回 null */
export async function fetchTtsSegments(text: string): Promise<string[] | null> {
  if (!text || disabled) return null;
  const hit = cache.get(text);
  if (hit) return hit;
  if (Date.now() < failBackoffUntil) return null; // 冷却窗口：别让每句都干等超时拖垮课堂节奏
  const running = inflight.get(text);
  if (running) return running;
  const p = requestSegments(text).finally(() => inflight.delete(text));
  inflight.set(text, p);
  return p;
}

/** 缓存满时整体清空并释放 blob URL（防内存泄漏） */
function clearTtsCache(): void {
  for (const urls of cache.values()) urls.forEach((u) => URL.revokeObjectURL(u));
  cache.clear();
}
