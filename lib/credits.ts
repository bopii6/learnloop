// 积分系统：防刷的第一道闸门。
// 模型：新用户注册即得 20 积分（老用户首次被读取时自动补发，见 getOrCreateAccount 的惰性发放）；
// 生成一门课程扣 10 分，首次听一节课扣 1 分（讲稿缓存后复习免费，见 lib/board/script-store.ts）。
// 设计取舍：
// - 按资产生成计费而不是按 token 实时扣：用户看得懂、可预期；追问等边际交互不收费，
//   靠每节课 30 条的追问上限防滥用（滥用防在护栏，不在计费）
// - 积分跟账号走（credits/{userId}.json，每用户一个文件），流水只留最近 1000 条
// - 扣分在资产产生之前，管线失败自动退回：用户只为成功交付的东西付费
// - 读改写全程持每用户锁：并发扣分不再互相覆盖（雷区 2 修复）
// - 账户文件损坏时抛错拒操作（fail-closed）：宁可这一户暂时不可用，也不能静默重置成 20 分
import { listKeys, readBinary, readJson, readJsonStrict, writeJson } from "@/lib/storage";

const LEGACY_DB_KEY = "credits.json"; // 旧的单文件账本，只读用于迁移，不再写回
const ACCOUNT_PREFIX = "credits/";

export const NEW_USER_GRANT = 20;
export const COST_COURSE_GENERATE = 10;
export const COST_TEACHING_SESSION = 1;
/** 结课工坊：任务书生成一次 1 分（缓存后免费重看） */
export const COST_CAPSTONE_BRIEF = 1;
/** 结课工坊：作品验收每次 1 分（对照做成标准的逐条判定是一次实打实的 LLM 审稿） */
export const COST_CAPSTONE_REVIEW = 1;
/** 单元测验：出题一次 1 分（题目缓存，重考免费） */
export const COST_UNIT_QUIZ = 1;
/** 每用户每节课的追问上限（课堂 chat 不扣积分，用护栏防滥用） */
export const CHAT_LIMIT_PER_LECTURE = 30;
const LOG_CAP = 1000;

export interface CreditLogEntry {
  at: number;
  delta: number; // 负 = 消耗，正 = 发放/退回
  reason: string;
  balanceAfter: number;
}

export interface CreditAccount {
  balance: number;
  granted: number; // 累计发放（含注册赠送/管理员补分）
  spent: number; // 累计消耗（不含退回）
  updatedAt: number;
  log: CreditLogEntry[];
}

function newAccount(): CreditAccount {
  return {
    balance: NEW_USER_GRANT,
    granted: NEW_USER_GRANT,
    spent: 0,
    updatedAt: Date.now(),
    log: [{ at: Date.now(), delta: NEW_USER_GRANT, reason: "注册赠送", balanceAfter: NEW_USER_GRANT }],
  };
}

// 同用户的读改写串行化：trySpend/refund/grant 全程持锁，进程内不再有交错窗口。
// 跨实例（多 Worker 隔离）仍靠每用户单文件把碰撞面压到最小；接支付时账本迁 D1。
const userLocks = new Map<string, Promise<unknown>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  userLocks.set(userId, next);
  try {
    return await next;
  } finally {
    if (userLocks.get(userId) === next) userLocks.delete(userId);
  }
}

function accountKey(userId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) throw new Error(`credits: 非法 userId ${userId.slice(0, 8)}…`);
  return `${ACCOUNT_PREFIX}${userId}.json`;
}

/** 旧单文件账本 → 每用户文件的一次性惰性迁移；迁移后旧文件不再读写 */
async function readAccount(userId: string): Promise<CreditAccount | null> {
  const key = accountKey(userId);
  const buf = await readBinary(key);
  if (buf) {
    try {
      return JSON.parse(buf.toString("utf8")) as CreditAccount;
    } catch {
      // 损坏 = 拒绝服务，不静默重置（否则等于把余额清零再送 20 分）
      throw new Error(`积分账户文件损坏（${key}），已拒绝操作以防数据覆盖`);
    }
  }
  // 本户尚无独立文件：查旧账本迁移（旧文件损坏只意味着迁不了，不影响新户）
  const legacy = await readJson<{ accounts?: Record<string, CreditAccount> }>(LEGACY_DB_KEY, {});
  const old = legacy.accounts?.[userId];
  if (!old || typeof old.balance !== "number") return null;
  await writeJson(key, old);
  return old;
}

function appendLog(acc: CreditAccount, delta: number, reason: string): void {
  acc.log.push({ at: Date.now(), delta, reason, balanceAfter: acc.balance });
  if (acc.log.length > LOG_CAP) acc.log = acc.log.slice(-LOG_CAP);
  acc.updatedAt = Date.now();
}

/** 读取积分账户；不存在则按新用户发放 20 分（老用户从旧账本自动迁移，无需迁移脚本） */
export async function getOrCreateAccount(userId: string): Promise<CreditAccount> {
  return withUserLock(userId, async () => {
    const existing = await readAccount(userId);
    if (existing) return existing;
    const acc = newAccount();
    await writeJson(accountKey(userId), acc);
    return acc;
  });
}

export async function getBalance(userId: string): Promise<number> {
  return (await getOrCreateAccount(userId)).balance;
}

/** 扣分；余额不足返回 { ok: false, balance }，由调用方决定如何告知用户 */
export async function trySpend(
  userId: string,
  amount: number,
  reason: string
): Promise<{ ok: boolean; balance: number }> {
  return withUserLock(userId, async () => {
    let acc = await readAccount(userId);
    if (!acc) {
      acc = newAccount();
    }
    if (acc.balance < amount) {
      return { ok: false, balance: acc.balance };
    }
    acc.balance -= amount;
    acc.spent += amount;
    appendLog(acc, -amount, reason);
    await writeJson(accountKey(userId), acc);
    return { ok: true, balance: acc.balance };
  });
}

/** 管线失败后的退回：扣分在前、失败退回，保证"只为成功交付付费" */
export async function refundCredits(userId: string, amount: number, reason: string): Promise<void> {
  await withUserLock(userId, async () => {
    const acc = await readAccount(userId);
    if (!acc) return; // 没扣过就没得退
    acc.balance += amount;
    appendLog(acc, amount, reason);
    await writeJson(accountKey(userId), acc);
  });
}

/** 管理员补发/调整（正数发放，负数扣回）；写流水，理由必填（对账凭据） */
export async function grantCredits(userId: string, amount: number, reason: string): Promise<CreditAccount> {
  return withUserLock(userId, async () => {
    let acc = await readAccount(userId);
    if (!acc) acc = newAccount();
    acc.balance += amount;
    if (amount > 0) acc.granted += amount;
    appendLog(acc, amount, reason);
    await writeJson(accountKey(userId), acc);
    return acc;
  });
}

/** 遍历全体账户（admin overview 用）；单户损坏跳过并记名，不让一户坏文件拖垮总览 */
export async function listAccounts(): Promise<{ userId: string; acc: CreditAccount | null; corrupt?: boolean }[]> {
  const { listKeys } = await import("@/lib/storage");
  const items = await listKeys(ACCOUNT_PREFIX);
  const out: { userId: string; acc: CreditAccount | null; corrupt?: boolean }[] = [];
  for (const it of items) {
    const userId = it.key.slice(ACCOUNT_PREFIX.length).replace(/\.json$/, "");
    try {
      out.push({ userId, acc: await readJsonStrict<CreditAccount>(it.key) });
    } catch {
      out.push({ userId, acc: null, corrupt: true });
    }
  }
  return out;
}
