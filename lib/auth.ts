// 邮箱验证码登录：用户/验证码/会话的最小实现。
// 用户与验证码经存储抽象层持久化（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）；
// 会话签名密钥保持在本地 data/.auth-secret（每实例一份）。
import { promises as fs } from "fs";
import path from "path";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { readJson, writeJson } from "@/lib/storage";

const USERS_KEY = "users.json";
const CODES_KEY = "auth-codes.json";
const SECRET_FILE = path.join(process.cwd(), "data", ".auth-secret");

export interface AuthUser {
  id: string;
  email: string;
  createdAt: number;
}

interface CodeRecord {
  codeHash: string;
  expiresAt: number;
  lastSentAt: number;
  attempts: number;
}

export function normalizeEmail(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 会话签名密钥：.env 的 AUTH_SECRET 优先，否则本地生成并持久化 */
async function getSecret(): Promise<string> {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    return (await fs.readFile(SECRET_FILE, "utf8")).trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true });
    await fs.writeFile(SECRET_FILE, secret, "utf8");
    return secret;
  }
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function signSession(userId: string): Promise<string> {
  const secret = await getSecret();
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = createHmac("sha256", secret).update(`${userId}.${exp}`).digest("hex").slice(0, 32);
  return `${userId}.${exp}.${sig}`;
}

export async function verifySession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const secret = await getSecret();
  const expect = createHmac("sha256", secret).update(`${userId}.${expStr}`).digest("hex").slice(0, 32);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  return userId;
}

// ---- 用户 ----

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const db = await readJson<{ users: AuthUser[] }>(USERS_KEY, { users: [] });
  return db.users.find((u) => u.email === email) || null;
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  const db = await readJson<{ users: AuthUser[] }>(USERS_KEY, { users: [] });
  return db.users.find((u) => u.id === id) || null;
}

export async function upsertUserByEmail(email: string): Promise<AuthUser> {
  const db = await readJson<{ users: AuthUser[] }>(USERS_KEY, { users: [] });
  const existing = db.users.find((u) => u.email === email);
  if (existing) return existing;
  const user: AuthUser = { id: `u-${randomBytes(5).toString("hex")}`, email, createdAt: Date.now() };
  db.users.push(user);
  await writeJson(USERS_KEY, db, { pretty: true });
  return user;
}

// ---- 验证码 ----

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_ATTEMPTS = 6;

function hashCode(email: string, code: string): string {
  return createHash("sha256").update(`${email}:${code}`).digest("hex");
}

/** 发码；返回 false = 触发重发间隔 */
export async function issueCode(email: string): Promise<{ ok: boolean; code?: string }> {
  const db = await readJson<{ codes: Record<string, CodeRecord> }>(CODES_KEY, { codes: {} });
  const prev = db.codes[email];
  if (prev && Date.now() - prev.lastSentAt < RESEND_INTERVAL_MS) return { ok: false };
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  db.codes[email] = {
    codeHash: hashCode(email, code),
    expiresAt: Date.now() + CODE_TTL_MS,
    lastSentAt: Date.now(),
    attempts: 0,
  };
  await writeJson(CODES_KEY, db);
  return { ok: true, code };
}

export async function verifyCode(email: string, code: string): Promise<boolean> {
  const db = await readJson<{ codes: Record<string, CodeRecord> }>(CODES_KEY, { codes: {} });
  const rec = db.codes[email];
  if (!rec) return false;
  if (Date.now() > rec.expiresAt) return false;
  if (rec.attempts >= MAX_ATTEMPTS) return false;
  rec.attempts += 1;
  const ok = rec.codeHash === hashCode(email, code.trim());
  if (ok) delete db.codes[email]; // 一次性
  await writeJson(CODES_KEY, db);
  return ok;
}

// ---- 请求侧的会话解析 ----

export async function userFromCookieHeader(cookieHeader: string | null): Promise<AuthUser | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith("ll_session="));
  if (!match) return null;
  const token = decodeURIComponent(match.slice("ll_session=".length));
  const userId = await verifySession(token);
  if (!userId) return null;
  return findUserById(userId);
}

export const SESSION_COOKIE = "ll_session";
export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);
