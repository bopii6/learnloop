// POST /api/tts —— 云端语音合成（白板播报用，比浏览器系统音色自然得多）
// 供应商：阿里云百炼 qwen3-tts-flash（0.8 元/万字符，1 个汉字算 2 字符；
// 开通百炼后每款 TTS 模型送 1 万字符免费额度）。
// 环境变量：DASHSCOPE_API_KEY（必填）；TTS_MODEL / TTS_VOICE（可选，默认 qwen3-tts-flash / Cherry）。
// 未配置时返回 501，客户端自动回退浏览器 speechSynthesis，功能不受影响。
import { NextRequest } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 默认走百炼公共端点；Token Plan 专属 API Key（sk-ws- 开头）必须改走专属域名，
// 在 .env 配 TTS_ENDPOINT=<专属域名>/api/v1/services/aigc/multimodal-generation/generation
const ENDPOINT =
  process.env.TTS_ENDPOINT ||
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

const MAX_CHUNK = 200; // qwen3-tts 对输入文本有长度限制，长句切块并行合成
const CACHE_MAX = 300; // 进程内缓存（同文本重播不再计费），超出整体清空

const cache = new Map<string, string[]>(); // cacheKey -> base64 wav 分段

function defaults() {
  return {
    model: process.env.TTS_MODEL || "qwen3-tts-flash",
    voice: process.env.TTS_VOICE || "Cherry",
  };
}

/** 按句末标点切块，每块不超过 MAX_CHUNK（qwen3-tts 输入上限） */
function splitText(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts = text.split(/(?<=[。！？；!?;\n])/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + p).length > MAX_CHUNK) {
      chunks.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function synthesizeChunk(chunk: string): Promise<string> {
  const { model, voice } = defaults();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: { text: chunk, voice, language_type: "Chinese" },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`upstream ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const audio = data?.output?.audio;
  // 非流式响应返回 24 小时有效的音频 URL；流式/SSE 才逐段带 base64 data，两种都兼容
  if (typeof audio?.data === "string" && audio.data) return audio.data;
  if (typeof audio?.url === "string" && audio.url) {
    const wav = await fetch(audio.url, { signal: AbortSignal.timeout(30000) });
    if (!wav.ok) throw new Error(`audio download ${wav.status}`);
    return Buffer.from(await wav.arrayBuffer()).toString("base64");
  }
  throw new Error("no audio in response");
}

async function synthesize(text: string): Promise<string[]> {
  return Promise.all(splitText(text).map(synthesizeChunk));
}

export async function POST(req: NextRequest) {
  // 云端合成真金白银，必须登录才能调（防公网白嫖刷量）
  const user = await userFromCookieHeader(req.headers.get("cookie"));
  if (!user) return Response.json({ error: "请先登录后再使用语音播报" }, { status: 401 });

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const text = (body.text || "").trim();
  if (!text) return Response.json({ error: "empty text" }, { status: 400 });
  if (!process.env.DASHSCOPE_API_KEY) {
    return Response.json(
      {
        error: "TTS_NOT_CONFIGURED",
        hint: "云端语音合成未配置：注册阿里云百炼（0.8元/万字符，送1万字符额度），在 .env 填 DASHSCOPE_API_KEY 后重启；不配置则继续用浏览器系统音色",
      },
      { status: 501 }
    );
  }

  const { model, voice } = defaults();
  const cacheKey = `${model}|${voice}|${text}`;
  let segments = cache.get(cacheKey);
  if (!segments) {
    try {
      segments = await synthesize(text);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return Response.json({ error: "TTS_FAILED", detail }, { status: 502 });
    }
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, segments);
  }
  return Response.json({ segments });
}
