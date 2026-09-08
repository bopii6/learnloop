// 积分系统：防刷的第一道闸门。
// 模型：新用户注册即得 20 积分（老用户首次被读取时自动补发，见 getOrCreateAccount 的惰性发放）；
// 生成一门课程扣 10 分，开启一节白板课堂扣 5 分 —— 20 分正好体验完整闭环：1 门课 + 2 节课。
// 设计取舍：
// - 积分跟账号走（credits.json，经存储抽象层，本地/R2 双驱动一致）
// - 扣分在资产产生之前（大纲生成/开讲），管线失败自动退回：用户只为成功交付的东西付费
// - 流水只留最近 100 条：够成本核算用，不无限膨胀
import { readJson, writeJson } from "@/lib/storage";

const CREDITS_KEY = "credits.json";

export const NEW_USER_GRANT = 20;
export const COST_COURSE_GENERATE = 10;
export const COST_TEACHING_SESSION = 5;

export interface CreditLogEntry {
  at: number;
  delta: number; // 负 = 消耗，正 = 发放/退回
  reason: string;
  balanceAfter: number;
}

export interface CreditAccount {
  balance: number;
  granted: number; // 累计发放（含注册赠送）
  spent: number; // 累计消耗（不含退回）
  updatedAt: number;
  log: CreditLogEntry[];
}

interface CreditsDb {
  accounts: Record<string, CreditAccount>;
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

/** 读取积分账户；不存在则按新用户发放 20 分（老用户自动补发，无需迁移脚本） */
export async function getOrCreateAccount(userId: string): Promise<CreditAccount> {
  const db = await readJson<CreditsDb>(CREDITS_KEY, { accounts: {} });
  let acc = db.accounts[userId];
  if (!acc) {
    acc = newAccount();
    db.accounts[userId] = acc;
    await writeJson(CREDITS_KEY, db);
  }
  return acc;
}

export async function getBalance(userId: string): Promise<number> {
  return (await getOrCreateAccount(userId)).balance;
}

async function appendLog(acc: CreditAccount, delta: number, reason: string): Promise<void> {
  acc.log.push({ at: Date.now(), delta, reason, balanceAfter: acc.balance });
  if (acc.log.length > 100) acc.log = acc.log.slice(-100);
  acc.updatedAt = Date.now();
}

/** 扣分；余额不足返回 { ok: false, balance }，由调用方决定如何告知用户 */
export async function trySpend(
  userId: string,
  amount: number,
  reason: string
): Promise<{ ok: boolean; balance: number }> {
  const db = await readJson<CreditsDb>(CREDITS_KEY, { accounts: {} });
  const acc = db.accounts[userId] || (await getOrCreateAccount(userId));
  if (!db.accounts[userId]) db.accounts[userId] = acc;
  if (acc.balance < amount) {
    return { ok: false, balance: acc.balance };
  }
  acc.balance -= amount;
  acc.spent += amount;
  await appendLog(acc, -amount, reason);
  await writeJson(CREDITS_KEY, db);
  return { ok: true, balance: acc.balance };
}

/** 管线失败后的退回：扣分在前、失败退回，保证"只为成功交付付费" */
export async function refundCredits(userId: string, amount: number, reason: string): Promise<void> {
  const db = await readJson<CreditsDb>(CREDITS_KEY, { accounts: {} });
  const acc = db.accounts[userId];
  if (!acc) return; // 没扣过就没得退
  acc.balance += amount;
  await appendLog(acc, amount, reason);
  await writeJson(CREDITS_KEY, db);
}
