// 板卡配图：复用项目既有的出图通道（tuzi / momoai / zhipu / wanx），用"教学插画"风格头。
// 产物落盘（data/board-images/<hash>.png，R2 模式自动上桶），按 prompt 哈希缓存：
// 同一个 prompt 第二次不再出图（复习/回放零成本、零等待）。
import crypto from "node:crypto";
import { readBinary, writeBinary } from "@/lib/storage";

const BOARD_STYLE_HEAD =
  "Clean modern educational illustration, flat 2D vector style, soft muted palette " +
  "(deep blue, warm amber, neutral gray), simple geometry with generous white space, " +
  "crisp line work, no photorealism, no 3D render. " +
  "Absolutely NO text, NO letters, NO numbers, NO labels, NO watermark in the image. " +
  "Concept: ";

const KEY_PREFIX = "board-images/";

function channels(): string[] {
  // 板卡配图通道：BOARD_IMAGE_PROVIDER 锁定单通道，否则按顺序自动降级
  const p = process.env.BOARD_IMAGE_PROVIDER?.trim();
  if (p === "tuzi" || p === "zhipu" || p === "momoai" || p === "wanx") return [p];
  return ["momoai", "zhipu", "wanx", "tuzi"];
}

export interface BoardImageAsset {
  key: string;
  url: string;
  width: number;
  height: number;
  cached: boolean;
}

/** PNG 头解析（生成通道基本都回 png；非 PNG 时给 4:3 默认比例） */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载生成图失败 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** 调一个通道出图；返回图片字节 */
async function generateVia(channel: string, prompt: string): Promise<Buffer> {
  const full = BOARD_STYLE_HEAD + prompt;
  if (channel === "tuzi" || channel === "momoai") {
    const key = channel === "tuzi" ? process.env.TUZI_API_KEY : process.env.MOMOAI_API_KEY;
    if (!key) throw new Error(`${channel.toUpperCase()}_API_KEY 未配置`);
    const base = (
      channel === "tuzi" ? process.env.TUZI_BASE_URL || "https://api.tu-zi.com" : process.env.MOMOAI_BASE_URL || "https://momoai.asia"
    ).replace(/\/+$/, "");
    const model =
      channel === "tuzi" ? process.env.TUZI_IMAGE_MODEL || "gpt-image-2.5" : process.env.MOMOAI_IMAGE_MODEL || "gpt-image-2";
    const res = await fetch(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: full, size: "1024x1024", n: 1 }),
      signal: AbortSignal.timeout(200_000),
    });
    const json: any = await res.json();
    const item = json?.data?.[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
    if (item?.url) return fetchBytes(item.url);
    throw new Error(JSON.stringify(json?.error || json).slice(0, 140));
  }
  if (channel === "zhipu") {
    const key = process.env.ZHIPU_API_KEY;
    if (!key) throw new Error("ZHIPU_API_KEY 未配置");
    const model = process.env.ZHIPU_IMAGE_MODEL || "glm-image";
    const res = await fetch("https://open.bigmodel.cn/api/paas/v4/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: full }),
      signal: AbortSignal.timeout(120_000),
    });
    const json: any = await res.json();
    const url = json?.data?.[0]?.url;
    if (url) return fetchBytes(url);
    throw new Error(JSON.stringify(json?.error || json).slice(0, 140));
  }
  // wanx（DashScope 异步任务）
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error("DASHSCOPE_API_KEY 未配置");
  const submit = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify({ model: "wanx2.1-t2i-turbo", input: { prompt: full }, parameters: { size: "1024*1024", n: 1 } }),
  });
  const submitJson: any = await submit.json();
  const taskId = submitJson?.output?.task_id;
  if (!taskId) throw new Error(JSON.stringify(submitJson?.message || submitJson).slice(0, 140));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const pj: any = await poll.json();
    const status = pj?.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = pj?.output?.results?.[0]?.url;
      if (url) return fetchBytes(url);
      throw new Error("wanx 成功但无图 URL");
    }
    if (status === "FAILED") throw new Error(JSON.stringify(pj?.output || pj).slice(0, 140));
  }
  throw new Error("wanx 出图超时");
}

/** 出一张板卡插画（带缓存）。失败抛出，由调用方决定是否降级 */
export async function generateBoardImage(prompt: string): Promise<BoardImageAsset> {
  const clean = prompt.replace(/\s+/g, " ").trim().slice(0, 800);
  const hash = crypto.createHash("sha1").update(clean).digest("hex").slice(0, 20);
  const key = `${KEY_PREFIX}${hash}.png`;
  const existing = await readBinary(key);
  if (existing) {
    const size = pngSize(existing) || { width: 1024, height: 1024 };
    return { key, url: `/api/board/image/${hash}`, width: size.width, height: size.height, cached: true };
  }
  const errors: string[] = [];
  const list = channels();
  for (const ch of list) {
    try {
      const buf = await generateVia(ch, clean);
      await writeBinary(key, buf);
      const size = pngSize(buf) || { width: 1024, height: 1024 };
      return { key, url: `/api/board/image/${hash}`, width: size.width, height: size.height, cached: false };
    } catch (e) {
      errors.push(`${ch}: ${e instanceof Error ? e.message : String(e)}`);
      if (list.length === 1) break;
    }
  }
  throw new Error(`全部出图通道失败：${errors.join(" | ")}`);
}

export async function readBoardImage(assetId: string): Promise<Buffer | null> {
  const safe = assetId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (!safe) return null;
  return readBinary(`${KEY_PREFIX}${safe}.png`);
}
