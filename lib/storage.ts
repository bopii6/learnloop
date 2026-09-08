// 存储抽象层：本地文件系统 / Cloudflare R2 双驱动，按 .env 自动选择。
//
// 设计：所有业务数据（课程/教材/会话/画像/用户/集市/验证码）都是"键 → JSON/二进制"的
// 文档读写。本地模式 key = data/ 下的相对路径；R2 模式 key = 桶内对象名。
// 迁移到 Cloudflare 时业务代码零改动，填好 .env 的 CF_* 变量即生效。
//
// 例外（保持本地，刻意不上云）：
// - data/ocr-cache：tesseract 语言包缓存，worker 需要文件路径
// - data/classrooms：课堂断线恢复快照（临时缓存，非珍贵数据；上 Workers 时挪 Durable Object）
// - data/.auth-secret：本机会话签名密钥
import { promises as fs } from "fs";
import path from "path";

const LOCAL_ROOT = path.join(process.cwd(), "data");

export type StorageMode = "local" | "r2";

const R2_CONFIGURED = Boolean(
  process.env.CF_ACCOUNT_ID &&
  process.env.CF_R2_BUCKET &&
  process.env.CF_R2_ACCESS_KEY_ID &&
  process.env.CF_R2_SECRET_ACCESS_KEY
);

export const storageMode: StorageMode = R2_CONFIGURED ? "r2" : "local";

/** 键约束：data/ 相对路径风格，防目录穿越；allowEmpty 仅供 R2 桶根列出使用 */
function safeKey(key: string, allowEmpty = false): string {
  const cleaned = key.replace(/\\/g, "/").replace(/\.\.+/g, "").replace(/^\/+/, "");
  if (!cleaned) {
    if (allowEmpty) return "";
    throw new Error("storage: empty key");
  }
  return cleaned;
}

function localPath(key: string): string {
  return path.join(LOCAL_ROOT, safeKey(key));
}

// 同 key 写入串行化：并发"读-改-写"（如连续 appendMessage）不再交错踩踏，
// 最后一个写者胜，但文件本身不会出现新旧内容交错的中间态。
const writeLocks = new Map<string, Promise<unknown>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (writeLocks.get(key) === next) writeLocks.delete(key);
  }
}

// ---- R2 驱动（S3 兼容 API，aws4fetch 签名） ----

interface R2Client {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

let r2Client: R2Client | null = null;

async function getR2(): Promise<R2Client> {
  if (r2Client) return r2Client;
  const { AwsClient } = await import("aws4fetch");
  r2Client = new AwsClient({
    accessKeyId: process.env.CF_R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
  return r2Client;
}

function r2Url(key: string, query?: Record<string, string>): string {
  const base = `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.CF_R2_BUCKET}`;
  const k = safeKey(key, true);
  const encoded = k ? k.split("/").map(encodeURIComponent).join("/") : "";
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  return encoded ? `${base}/${encoded}${qs}` : `${base}${qs}`;
}

async function r2Get(key: string): Promise<Buffer | null> {
  const client = await getR2();
  const res = await client.fetch(r2Url(key), { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function r2Put(key: string, data: Buffer): Promise<void> {
  const client = await getR2();
  const res = await client.fetch(r2Url(key), {
    method: "PUT",
    body: new Uint8Array(data),
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`R2 PUT ${key} -> ${res.status}`);
}

async function r2Delete(key: string): Promise<void> {
  const client = await getR2();
  const res = await client.fetch(r2Url(key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} -> ${res.status}`);
}

interface R2ListItem {
  key: string;
  lastModified?: number;
}

async function r2List(prefix: string): Promise<R2ListItem[]> {
  const client = await getR2();
  const items: R2ListItem[] = [];
  let cursor: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix: safeKey(prefix) };
    if (cursor) query["continuation-token"] = cursor;
    const res = await client.fetch(r2Url("", query), { method: "GET" });
    if (!res.ok) throw new Error(`R2 LIST ${prefix} -> ${res.status}`);
    const xml = await res.text();
    for (const block of xml.split("<Contents>").slice(1)) {
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1];
      const lm = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1];
      if (key) {
        items.push({
          key: key,
          lastModified: lm ? new Date(lm).getTime() : undefined,
        });
      }
    }
    cursor = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
  } while (cursor);
  return items;
}

// ---- 对外 API ----

export async function readBinary(key: string): Promise<Buffer | null> {
  const k = safeKey(key);
  if (storageMode === "local") {
    try {
      return await fs.readFile(localPath(k));
    } catch {
      return null;
    }
  }
  return r2Get(k);
}

export async function writeBinary(key: string, data: Buffer): Promise<void> {
  const k = safeKey(key);
  return withKeyLock(k, async () => {
    if (storageMode === "local") {
      const p = localPath(k);
      await fs.mkdir(path.dirname(p), { recursive: true });
      // 原子写：先落临时文件再 rename，进程崩溃/断电不会留下截断的半截 JSON
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, p);
      } catch (e) {
        try {
          await fs.unlink(tmp);
        } catch {
          // 临时文件清理失败可忽略
        }
        throw e;
      }
      return;
    }
    await r2Put(k, data);
  });
}

export async function removeKey(key: string): Promise<void> {
  const k = safeKey(key);
  if (storageMode === "local") {
    try {
      await fs.unlink(localPath(k));
    } catch {
      // 已不存在则忽略
    }
    return;
  }
  await r2Delete(k);
}

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  const buf = await readBinary(key);
  if (!buf) return fallback;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown, opts?: { pretty?: boolean }): Promise<void> {
  const space = opts?.pretty ? 2 : 0;
  await writeBinary(key, Buffer.from(JSON.stringify(value, null, space), "utf8"));
}

export interface StorageListItem {
  key: string;
  lastModified?: number;
}

export async function listKeys(prefix: string): Promise<StorageListItem[]> {
  const p = safeKey(prefix);
  if (storageMode === "local") {
    const dir = localPath(p);
    try {
      const entries = await fs.readdir(dir);
      const items: StorageListItem[] = [];
      for (const name of entries) {
        const st = await fs.stat(path.join(dir, name));
        if (st.isFile()) {
          items.push({ key: `${p}${name}`, lastModified: st.mtimeMs });
        }
      }
      return items;
    } catch {
      return [];
    }
  }
  return r2List(p);
}

/** 存储自检（/api/storage-check 用）：一次读写删的往返 */
export async function probe(): Promise<{ ok: boolean; mode: StorageMode; detail: string }> {
  const key = `__storage-check/${Date.now()}.json`;
  try {
    const payload = { hello: "learnloop", at: Date.now() };
    await writeJson(key, payload);
    const back = await readJson<{ hello: string }>(key, { hello: "" });
    const listed = await listKeys("__storage-check/");
    await removeKey(key);
    if (back.hello !== payload.hello) return { ok: false, mode: storageMode, detail: "读回的内容不一致" };
    return {
      ok: true,
      mode: storageMode,
      detail: `往返成功，list 返回 ${listed.length} 项${storageMode === "r2" ? "（R2）" : "（本地 data/）"}`,
    };
  } catch (e) {
    return { ok: false, mode: storageMode, detail: e instanceof Error ? e.message : String(e) };
  }
}
