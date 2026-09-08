// POST /api/asr —— 云端语音识别（浏览器录好的整句 WAV → 文字）
// 供应商：阿里云百炼 qwen3-asr-flash，与语音播报（qwen3-tts-flash）共用同一把
// DASHSCOPE_API_KEY，配过 TTS 就无需任何额外配置。Token Plan 专属 key（sk-ws- 开头）
// 必须走专属域名（TTS_ENDPOINT），已实测该网关 ASR 同样可用（2026-09-08）。
// 未配置时返回 501，客户端安静回退浏览器识别。
import { NextRequest } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";
import { ASR_DAILY_REQUESTS, consumeDailyQuota, logOpsError } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 与 /api/tts 同款端点选择：默认百炼公共端点；sk-ws- 专属 key 配 TTS_ENDPOINT 改走专属域名
const ENDPOINT =
  process.env.TTS_ENDPOINT ||
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export async function POST(req: NextRequest) {
  // 云端识别真金白银，必须登录才能调（与 /api/tts 同款闸门，防公网白嫖刷量）
  const user = await userFromCookieHeader(req.headers.get("cookie"));
  if (!user) return Response.json({ error: "请先登录后再使用语音识别" }, { status: 401 });

  let body: { audioB64?: string; durationMs?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const audioB64 = (body.audioB64 || "").trim();
  if (!audioB64) return Response.json({ error: "empty audio" }, { status: 400 });
  if (!process.env.DASHSCOPE_API_KEY) {
    return Response.json(
      {
        error: "ASR_NOT_CONFIGURED",
        hint: "云端语音识别未配置：与语音播报共用 DASHSCOPE_API_KEY，在 .env 填好后重启；未配置时自动用浏览器识别",
      },
      { status: 501 }
    );
  }

  // 每日软上限：识别是说话才触发，真人一天到不了 200 句；超限引导回浏览器识别
  const quota = await consumeDailyQuota(user.id, "asr", 1, ASR_DAILY_REQUESTS);
  if (!quota.ok) {
    return Response.json(
      { error: "ASR_QUOTA", detail: `今天的云端识别次数已达上限（${ASR_DAILY_REQUESTS} 次/日），可改用浏览器识别或打字` },
      { status: 429 }
    );
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-asr-flash",
        input: {
          messages: [
            {
              role: "user",
              content: [
                { type: "audio", audio: `data:audio/wav;base64,${audioB64}` },
                { type: "text", text: "" },
              ],
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return Response.json({ error: `ASR_ERR_${res.status}`, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = await res.json();
    const text =
      data?.output?.choices?.[0]?.message?.content
        ?.map((c: { text?: string }) => c?.text || "")
        .join("") || "";
    if (!text) return Response.json({ error: "ASR_EMPTY", detail: "no text in response" }, { status: 502 });
    return Response.json({ text });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: "ASR_FAILED", detail: msg }, { status: 502 });
  }
}
