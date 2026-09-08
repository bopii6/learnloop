// 运营可观测性 + 每日软上限。
// 两件事共用同一套"每日计数文件"：
// 1) 成本遥测：每用户每天用了多少 LLM token / TTS 字符 / 对话次数 —— 这是将来
//    按 token 计费的对账地基（用户侧界面仍按资产计费，不受影响）
// 2) 防刷软上限：免费额度足够真实学习一整天，但让脚本党跑不出成本
// 文件布局：usage/{YYYY-MM-DD}/{userId}.json；IP 维度的键为 ip-{sha256 前 16 位}。
// 错误日志：ops/errors/{YYYY-MM}.json，每月一文件、封顶 500 条，管线失败时落一条。
import { readJson, writeJson } from "@/lib/storage";
import { drainLlmUsage } from "@/lib/agent/llm";
import { createHash } from "crypto";

export const CHAT_DAILY_LIMIT = 60; // 次/日
export const TTS_DAILY_CHARS = 30000; // 计费字符/日（≈ ¥2.4 的云端合成量）
export const ASR_DAILY_REQUESTS = 200; // 次/日
export const AUTH_CODE_IP_DAILY_LIMIT = 20; // 发码次数/IP/日

type UsageFields = {
  chat: number;
  ttsChars: number;
  asr: number;
  codeRequests: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
};

type UsageFile = UsageFields & { updatedAt: number };

const EMPTY_USAGE: UsageFields = {
  chat: 0,
  ttsChars: 0,
  asr: 0,
  codeRequests: 0,
  llmCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
};

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function usageKey(subject: string): string {
  return `usage/${today()}/${subject}.json`;
}

// 与 lib/credits.ts 同款的每键读改写锁（usage 文件高频小写，串行化防互相覆盖）
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  fileLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  }
}

/**
 * 消费每日配额：够则记账并返回 ok，不够则原样返回 ok:false（不记负数）。
 * subject 是 userId 或 ip-{hash}。
 */
export async function consumeDailyQuota(
  subject: string,
  field: keyof UsageFields,
  amount: number,
  limit: number
): Promise<{ ok: boolean; used: number; limit: number }> {
  return withFileLock(usageKey(subject), async () => {
    const key = usageKey(subject);
    const usage = await readJson<UsageFile>(key, { ...EMPTY_USAGE, updatedAt: 0 });
    const used = usage[field] || 0;
    if (used + amount > limit) {
      return { ok: false, used, limit };
    }
    usage[field] = used + amount;
    usage.updatedAt = Date.now();
    await writeJson(key, usage);
    return { ok: true, used: usage[field], limit };
  });
}

/** 纯遥测记账（无上限拦截）：LLM token 用量等只记不拦 */
export async function recordUsage(subject: string, patch: Partial<UsageFields>): Promise<void> {
  await withFileLock(usageKey(subject), async () => {
    const key = usageKey(subject);
    const usage = await readJson<UsageFile>(key, { ...EMPTY_USAGE, updatedAt: 0 });
    for (const [k, v] of Object.entries(patch)) {
      usage[k as keyof UsageFields] = (usage[k as keyof UsageFields] || 0) + (v || 0);
    }
    usage.updatedAt = Date.now();
    await writeJson(key, usage);
  });
}

/**
 * 把本次请求累计的 LLM 用量（lib/agent/llm.ts 的进程内计数）落到当日用量文件。
 * 在 SSE 流收尾时调用一次：这就是将来按 token 计费的对账数据源。
 */
export async function drainToUsage(subject: string): Promise<void> {
  const u = drainLlmUsage();
  if (!u.calls) return;
  await recordUsage(subject, {
    llmCalls: u.calls,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
  });
}

/** 请求方真实 IP（Cloudflare 场景 cf-connecting-ip 最可靠）→ 每日限频用的匿名键 */
export function ipSubject(req: Request): string {
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  return `ip-${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`;
}

export interface OpsErrorEntry {
  at?: number; // 落档时自动生成，调用方不用传
  kind: string; // course_generate / teach / chat / tts / asr ...
  userId?: string;
  detail: string;
}

const ERRORS_CAP = 500;

/** 线上错误落档：没有它，创始人只能靠用户骂才知道产品坏了 */
export async function logOpsError(entry: OpsErrorEntry): Promise<void> {
  const d = new Date();
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const key = `ops/errors/${month}.json`;
  await withFileLock(key, async () => {
    const log = await readJson<OpsErrorEntry[]>(key, []);
    log.push({ at: Date.now(), kind: entry.kind, userId: entry.userId, detail: (entry.detail || "").slice(0, 500) });
    if (log.length > ERRORS_CAP) log.splice(0, log.length - ERRORS_CAP);
    await writeJson(key, log);
  });
}

export async function recentOpsErrors(count = 30): Promise<OpsErrorEntry[]> {
  const d = new Date();
  const months = [
    `ops/errors/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.json`,
    (() => {
      const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      return `ops/errors/${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}.json`;
    })(),
  ];
  const [cur, prev] = await Promise.all(months.map((m) => readJson<OpsErrorEntry[]>(m, [])));
  return [...prev, ...cur].slice(-count);
}

/** 今日全体用量汇总（admin overview 用）：sum 当天 usage/ 目录下所有计数文件 */
export async function todayUsageTotals(): Promise<UsageFields & { users: number }> {
  const { listKeys } = await import("@/lib/storage");
  const items = await listKeys(`usage/${today()}/`);
  const totals = { ...EMPTY_USAGE, users: 0 };
  await Promise.all(
    items.map(async (it) => {
      const u = await readJson<UsageFile>(it.key, { ...EMPTY_USAGE, updatedAt: 0 });
      totals.users += 1;
      for (const k of Object.keys(EMPTY_USAGE) as (keyof UsageFields)[]) {
        totals[k] += u[k] || 0;
      }
    })
  );
  return totals;
}
