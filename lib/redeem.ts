// 兑换码：支付链路接通前的第一块商业化积木。
// 打法：创始人收款（微信/支付宝/淘宝都行）→ /admin 后台造码发给用户 →
// 用户在侧栏输入兑换码到账积分。账本复用 lib/credits 的 grantCredits（带流水），可对账。
// 码格式 SL-XXXXX-XXXXX：去掉易混淆字符（0/O/1/I/L），全大写好念好抄。
// （LL- 前缀是 LearnLoop 时代的历史码，兑换时仍然认，只是不再新发。）
// 并发防护：进程内按码加锁（与 credits 的用户锁同一模式）；跨实例重复兑换的面
// 由"一码一文件 + 原子写"压到最小，接支付时这层整体替换掉。
import { randomBytes } from "crypto";
import { listKeys, readJson, writeJson } from "@/lib/storage";
import { grantCredits } from "@/lib/credits";

const PREFIX = "redeem-codes/";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface RedeemCode {
  code: string;
  credits: number;
  note?: string;
  createdAt: number;
  redeemedBy?: string;
  redeemedAt?: number;
}

function codeKey(code: string): string {
  return `${PREFIX}${code.replace(/[^A-Z0-9-]/g, "")}.json`;
}

function genCode(): string {
  const buf = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return `SL-${s.slice(0, 5)}-${s.slice(5)}`;
}

/** 全量码列表（admin 后台用），新码在前；单码损坏跳过，不让一户拖垮列表 */
export async function listCodes(): Promise<RedeemCode[]> {
  const items = await listKeys(PREFIX);
  const out: RedeemCode[] = [];
  for (const it of items) {
    try {
      const rec = await readJson<RedeemCode | null>(it.key, null);
      if (rec?.code) out.push(rec);
    } catch {
      // 跳过坏文件
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
}

/** 造 N 张面额 credits 的码，返回码列表（founders 复制发给用户） */
export async function mintCodes(
  count: number,
  credits: number,
  note?: string
): Promise<RedeemCode[]> {
  const n = Math.max(1, Math.min(50, Math.floor(count)));
  const amount = Math.max(1, Math.min(10000, Math.floor(credits)));
  const out: RedeemCode[] = [];
  for (let i = 0; i < n; i++) {
    const rec: RedeemCode = { code: genCode(), credits: amount, note: note?.slice(0, 100), createdAt: Date.now() };
    await writeJson(codeKey(rec.code), rec);
    out.push(rec);
  }
  return out;
}

const codeLocks = new Map<string, Promise<unknown>>();

export type RedeemResult =
  | { ok: true; credits: number; balance: number }
  | { ok: false; reason: "not_found" | "used" };

export async function redeemCode(codeRaw: string, userId: string): Promise<RedeemResult> {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!/^(SL|LL)-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code)) return { ok: false, reason: "not_found" };
  const prev = codeLocks.get(code) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const key = codeKey(code);
    const rec = await readJson<RedeemCode | null>(key, null);
    if (!rec) return { ok: false, reason: "not_found" } as RedeemResult;
    if (rec.redeemedBy) return { ok: false, reason: "used" } as RedeemResult;
    rec.redeemedBy = userId;
    rec.redeemedAt = Date.now();
    await writeJson(key, rec);
    const acc = await grantCredits(userId, rec.credits, `兑换码充值 ${code}`);
    return { ok: true, credits: rec.credits, balance: acc.balance } as RedeemResult;
  });
  codeLocks.set(code, next);
  try {
    return await next;
  } finally {
    if (codeLocks.get(code) === next) codeLocks.delete(code);
  }
}
