// POST /api/tts —— 云端语音合成（白板播报用，比浏览器系统音色自然得多）
// 供应商：阿里云百炼 qwen3-tts-flash（0.8 元/万字符，1 个汉字算 2 字符；
// 开通百炼后每款 TTS 模型送 1 万字符免费额度）。
// 环境变量：DASHSCOPE_API_KEY（必填）；TTS_MODEL / TTS_VOICE / TTS_INSTRUCTIONS（可选）。
// 音色建议 Elias（墨讲师，唯一为"讲课"设计的音色）；模型用 qwen3-tts-instruct-flash + 语气指令，
// 同价但能压住"播音腔/表演腔"——只有 instruct 系列模型认 instructions 参数。
// 未配置时返回 501，客户端自动回退浏览器 speechSynthesis，功能不受影响。
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { userFromCookieHeader } from "@/lib/auth";
import { readJson, writeJson } from "@/lib/storage";
import { TTS_DAILY_CHARS, consumeDailyQuota, logOpsError } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 默认走百炼公共端点；Token Plan 专属 API Key（sk-ws- 开头）必须改走专属域名，
// 在 .env 配 TTS_ENDPOINT=<专属域名>/api/v1/services/aigc/multimodal-generation/generation
const ENDPOINT =
  process.env.TTS_ENDPOINT ||
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

const MAX_CHUNK = 200; // qwen3-tts 对输入文本有长度限制，长句切块并行合成
const CACHE_MAX = 300; // 进程内缓存（同文本重播不再计费），超出整体清空
// 持久化缓存：合成结果按 (model|voice|text) 哈希落 R2/本地，跨进程跨部署都命中。
// 没有它，"复习免费"每次重听都真金白银重合成（0.8元/万字符），重度用户持续失血。
const PERSIST_PREFIX = "tts-cache/";

const cache = new Map<string, string[]>(); // cacheKey -> base64 wav 分段

function persistentKey(model: string, voice: string, instructions: string, text: string): string {
  const hash = createHash("sha256").update(`${model}|${voice}|${instructions}|${text}`).digest("hex").slice(0, 32);
  return `${PERSIST_PREFIX}${hash}.json`;
}

function defaults() {
  return {
    model: process.env.TTS_MODEL || "qwen3-tts-flash",
    voice: process.env.TTS_VOICE || "Elias",
    instructions: process.env.TTS_INSTRUCTIONS || "",
  };
}

/** 只有 instruct 系列模型认 instructions 参数，别的模型带上会报 InvalidParameter */
function supportsInstructions(model: string): boolean {
  return model.includes("instruct");
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
  const { model, voice, instructions } = defaults();
  const input: Record<string, unknown> = { text: chunk, voice, language_type: "Chinese" };
  if (instructions && supportsInstructions(model)) {
    input.instructions = instructions;
    input.optimize_instructions = true; // 让模型自己把指令润色成更适合合成的内部描述
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input }),
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

  const { model, voice, instructions } = defaults();
  // 语气指令参与缓存键：改指令后不能命中旧音频
  const cacheKey = `${model}|${voice}|${instructions}|${text}`;
  let segments: string[] | null | undefined = cache.get(cacheKey);
  if (!segments) {
    // 二级缓存：落盘的历史合成结果（跨进程/跨部署命中，重听零成本）
    segments = await readJson<string[] | null>(persistentKey(model, voice, instructions, text), null);
    if (segments) cache.set(cacheKey, segments);
  }
  if (!segments) {
    // 只有真合成才消耗每日字符配额；缓存命中不花钱也不扣量
    const quota = await consumeDailyQuota(user.id, "ttsChars", text.length, TTS_DAILY_CHARS);
    if (!quota.ok) {
      return Response.json(
        {
          error: "TTS_QUOTA",
          detail: `今天的语音播报量已达上限（约 ${Math.round(TTS_DAILY_CHARS / 2)} 字/日），明天继续。已缓存的内容不受影响。`,
        },
        { status: 429 }
      );
    }
    try {
      segments = await synthesize(text);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await logOpsError({ kind: "tts", userId: user.id, detail }).catch(() => {});
      return Response.json({ error: "TTS_FAILED", detail }, { status: 502 });
    }
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, segments);
    await writeJson(persistentKey(model, voice, instructions, text), segments).catch(() => {
      // 缓存落盘失败不影响本次播放，代价只是下次重合成
    });
  }
  return Response.json({ segments });
}
