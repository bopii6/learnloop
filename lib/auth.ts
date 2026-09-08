// 邮箱验证码登录：用户/验证码/会话的最小实现。
// 用户与验证码经存储抽象层持久化（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）；
// 会话签名密钥保持在本地 data/.auth-secret（每实例一份）。
import { promises as fs } from "fs";
import path from "path";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { readJson, readJsonStrict, writeJson } from "@/lib/storage";

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

/** 别名归一化：+tag 后缀与 gmail 点号视为同一邮箱（免费积分防刷：一人不能靠别名无限建号） */
export function canonicalEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  const domain = email.slice(at + 1);
  let local = email.slice(0, at);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  if (isGmail) local = local.replace(/\./g, "");
  return `${local}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

// 常见临时/一次性邮箱域（够拦住批量薅羊毛的主流玩法，不用引第三方库）
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "guerrillamailblock.com",
  "yopmail.com", "trashmail.com", "throwawaymail.com", "sharklasers.com", "getnada.com",
  "dispostable.com", "tempmail.plus", "temp-mail.org", "1secmail.com", "moakt.com",
  "emailondeck.com", "fakeinbox.com", "maildrop.cc", "spamgourmet.com", "mytemp.email",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return DISPOSABLE_DOMAINS.has(domain);
}

/** 该邮箱是否是某个已有账号的别名变体（同箱不同写法）；返回冲突的原邮箱 */
export async function findAliasConflict(email: string): Promise<string | null> {
  const db = await readJson<{ users: AuthUser[] }>(USERS_KEY, { users: [] });
  const canon = canonicalEmail(email);
  const other = db.users.find((u) => u.email !== email && canonicalEmail(u.email) === canon);
  return other?.email || null;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

let ephemeralSecret: string | null = null; // Workers 等无文件系统环境的兜底（进程生命周期内有效）

/** 会话签名密钥：.env 的 AUTH_SECRET 优先 → 本地文件 → 内存兜底（部署时务必设置 AUTH_SECRET） */
async function getSecret(): Promise<string> {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    return (await fs.readFile(SECRET_FILE, "utf8")).trim();
  } catch {
    if (ephemeralSecret) return ephemeralSecret;
    ephemeralSecret = randomBytes(32).toString("hex");
    try {
      await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true });
      await fs.writeFile(SECRET_FILE, ephemeralSecret, "utf8");
    } catch {
      // 无文件系统（Workers）：用内存密钥，重启后旧会话失效
    }
    return ephemeralSecret;
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
  // 严格读：users.json 是全体账号的唯一副本，解析失败必须拒写，
  // 否则一次坏读 + 一次注册 = 用只含新用户的文件覆盖全部账号（静默清空）
  const db = await readJsonStrict<{ users: AuthUser[] }>(USERS_KEY);
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
  // 顺手清掉过期/陈旧的验证码，防止 auth-codes.json 无限增长
  const now = Date.now();
  for (const [k, rec] of Object.entries(db.codes)) {
    if (now > rec.expiresAt) delete db.codes[k];
  }
  const prev = db.codes[email];
  if (prev && now - prev.lastSentAt < RESEND_INTERVAL_MS) return { ok: false };
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

// ---- 管理员 ----
// 平台运营者：管理官方/无主集市条目、标记「官方精选」。在 .env / Worker vars 配
// ADMIN_EMAIL（多个用逗号分隔）；不配则公网环境无人能动无主条目，属预期（保守默认）。
export function isAdminUser(email?: string | null): boolean {
  const list = (process.env.ADMIN_EMAIL || "")
    .split(/[,;，；]/)
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  return Boolean(email) && list.includes(normalizeEmail(email || ""));
}

export const SESSION_COOKIE = "ll_session";
export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);
