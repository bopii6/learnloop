// POST /api/asr —— 云端语音识别（浏览器录好的整句 WAV → 文字）
// 供应商：百度短语音识别（国内可达，有免费额度）。
// 环境变量：BAIDU_ASR_API_KEY / BAIDU_ASR_SECRET_KEY（百度智能云控制台创建）。
// 未配置时返回 501，客户端给出明确指引。
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getBaiduToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const key = process.env.BAIDU_ASR_API_KEY;
  const secret = process.env.BAIDU_ASR_SECRET_KEY;
  if (!key || !secret) throw new Error("ASR_NOT_CONFIGURED");
  const res = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(
      key
    )}&client_secret=${encodeURIComponent(secret)}`,
    { method: "POST", signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`token ${res.status}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 600) * 1000 };
  return cachedToken.token;
}

export async function POST(req: NextRequest) {
  let body: { audioB64?: string; durationMs?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const audioB64 = (body.audioB64 || "").trim();
  if (!audioB64) return Response.json({ error: "empty audio" }, { status: 400 });
  if (!process.env.BAIDU_ASR_API_KEY || !process.env.BAIDU_ASR_SECRET_KEY) {
    return Response.json(
      {
        error: "ASR_NOT_CONFIGURED",
        hint: "云端语音识别未配置：注册百度智能云「短语音识别」（有免费额度），在 .env 填 BAIDU_ASR_API_KEY / BAIDU_ASR_SECRET_KEY 后重启",
      },
      { status: 501 }
    );
  }

  try {
    const token = await getBaiduToken();
    const speechLen = Math.floor((audioB64.length * 3) / 4); // base64 解码后的字节数
    const res = await fetch(`https://vop.baidu.com/server_api?dev_pid=1537`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        format: "wav",
        rate: 16000,
        channel: 1,
        token,
        cuid: "learnloop-classroom",
        speech: audioB64,
        len: speechLen,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (data.err_no !== 0) {
      return Response.json({ error: `ASR_ERR_${data.err_no}`, detail: data.err_msg }, { status: 502 });
    }
    return Response.json({ text: (data.result || []).join("") });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: "ASR_FAILED", detail: msg }, { status: 502 });
  }
}
