// LLM 调用层：按任务路由模型与思考强度 + JSON 模式 + 结构校验与自动重试。
//
// 任务（LlmTask）决定用哪个模型、开不开思考、温度多少——调用方只说"我在干什么"，不碰模型细节：
//   fast   分类 / 检索规划 / 抽取 / 核对 / 标题 / 媒体决策   —— 要快，不思考
//   chat   面向用户的流式回答（问答、课堂追问、画像摘要）        —— 首字快，不思考
//   design 课程设计产物（澄清题、蓝图、大纲细节、课节规划、任务书、测验）—— 轻度思考（学员在等）
//   script 讲稿 / 板书脚本 / 互动动画（长输出，学员在等开讲）      —— 轻度思考
//   judge  评审与判分（蓝图自审、作品验收、理解度检查、eval 评委）  —— 深度思考，低温
//
// 环境变量（全部可选）：
//   LLM_MODEL                 全局默认模型（默认 deepseek-flash）
//   LLM_MODEL_<TASK>          单任务覆盖，如 LLM_MODEL_DESIGN=deepseek-v4-pro
//   LLM_THINKING_<TASK>       单任务思考强度：off | low | high | max
// DeepSeek 专有参数（thinking / reasoning_effort / response_format）只在 DeepSeek 端点上注入，
// 换成其他 OpenAI 兼容端点时自动不发，保证可迁移。
// 走 OpenAI 兼容的 Chat Completions 协议（@ai-sdk/openai 新版默认是 OpenAI 专有的 Responses 接口，不适合 DeepSeek）；
// 它会把 DeepSeek 的 reasoning_content 解析成 reasoning 通道，正文 text 里不会混进思考过程。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type LanguageModelUsage } from "ai";
import type { ZodTypeAny } from "zod";
import { jsonrepair } from "jsonrepair";

export type LlmTask = "fast" | "chat" | "design" | "script" | "judge";
type Thinking = "off" | "low" | "high" | "max";

interface TaskProfile {
  thinking: Thinking;
  temperature: number;
}

const TASK_DEFAULTS: Record<LlmTask, TaskProfile> = {
  fast: { thinking: "off", temperature: 0.2 },
  chat: { thinking: "off", temperature: 0.5 },
  // 实测（eval 3 题，2026-11-14）：design 轻思考 65/78、¥0.14、62s；深思考 62/78、¥0.16、73s——轻思考不掉分且更快
  design: { thinking: "low", temperature: 0.4 },
  script: { thinking: "low", temperature: 0.5 },
  judge: { thinking: "high", temperature: 0.1 },
};

// 思考 token 计入 max_tokens：开思考时在调用方给的输出预算上再加这么多，避免正文被截断
const THINKING_BUDGET: Record<Thinking, number> = { off: 0, low: 4000, high: 12000, max: 32000 };

const BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com";
const API_KEY = process.env.LLM_API_KEY || "";
const DEFAULT_MODEL = process.env.LLM_MODEL || "deepseek-flash";
const IS_DEEPSEEK = /deepseek\.com/i.test(BASE_URL);

function envFor(prefix: string, task: LlmTask): string | undefined {
  const v = process.env[`${prefix}_${task.toUpperCase()}`];
  return v && v.trim() ? v.trim() : undefined;
}

interface Route {
  model: string;
  thinking: Thinking;
  temperature: number;
}

export function routeFor(task: LlmTask): Route {
  const model = envFor("LLM_MODEL", task) || DEFAULT_MODEL;
  const t = envFor("LLM_THINKING", task);
  const thinking: Thinking =
    t === "off" || t === "low" || t === "high" || t === "max" ? t : TASK_DEFAULTS[task].thinking;
  return { model, thinking, temperature: TASK_DEFAULTS[task].temperature };
}

/** 老模型（deepseek-chat / deepseek-reasoner）不认思考参数，只给新一代模型注入 */
function supportsThinkingParams(model: string): boolean {
  return IS_DEEPSEEK && !/^deepseek-(chat|reasoner)$/.test(model);
}

function extraBody(route: Route, json: boolean): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (supportsThinkingParams(route.model)) {
    if (route.thinking === "off") extra.thinking = { type: "disabled" };
    else extra.reasoning_effort = route.thinking;
  }
  if (json && IS_DEEPSEEK) extra.response_format = { type: "json_object" };
  return extra;
}

// 每种请求体附加参数一个 provider 实例（transformRequestBody 把 SDK 不认识的字段并进请求体）
const providers = new Map<string, ReturnType<typeof createOpenAICompatible>>();

function modelFor(route: Route, json: boolean) {
  const extra = extraBody(route, json);
  const key = JSON.stringify(extra);
  let p = providers.get(key);
  if (!p) {
    p = createOpenAICompatible({
      name: "llm",
      baseURL: BASE_URL,
      apiKey: API_KEY,
      includeUsage: true, // 流式回答也要拿到用量
      transformRequestBody: (body) => ({ ...body, ...extra }),
    });
    providers.set(key, p);
  }
  return p.chatModel(route.model);
}

function budget(route: Route, maxTokens: number): number {
  return maxTokens + (supportsThinkingParams(route.model) ? THINKING_BUDGET[route.thinking] : 0);
}

// ---- 用量统计（本进程内）：eval 与成本核算用。drainLlmUsage() 取走并清零 ----
interface UsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}
const usageAcc: UsageBucket = { calls: 0, promptTokens: 0, completionTokens: 0 };
const usageByTask: Partial<Record<LlmTask, UsageBucket>> = {};

export function drainLlmUsage(): UsageBucket & { byTask: Partial<Record<LlmTask, UsageBucket>> } {
  const snap = { ...usageAcc, byTask: JSON.parse(JSON.stringify(usageByTask)) };
  usageAcc.calls = usageAcc.promptTokens = usageAcc.completionTokens = 0;
  for (const k of Object.keys(usageByTask)) delete usageByTask[k as LlmTask];
  return snap;
}

function addUsage(task: LlmTask, u?: LanguageModelUsage) {
  if (!u) return;
  const b = (usageByTask[task] ??= { calls: 0, promptTokens: 0, completionTokens: 0 });
  for (const acc of [usageAcc, b]) {
    acc.calls += 1;
    acc.promptTokens += u.inputTokens || 0;
    acc.completionTokens += u.outputTokens || 0; // 含思考 token（DeepSeek 按输出计费）
  }
}

// ---- JSON 生成 ----
export interface JsonOptions<T> {
  task: LlmTask;
  /** 正文输出预算（不含思考 token，思考预算按任务自动追加） */
  maxTokens?: number;
  /** 结构校验（最低合格线，见 schemas.ts）：不通过时把错误反馈给模型重试一次；仍不通过返回 null */
  schema?: ZodTypeAny;
  temperature?: number;
  /** 指定模型，绕过任务路由（仅 eval 评委这类需要"固定裁判"的场景用） */
  model?: string;
  /** 调用方想拿真实失败原因（进 ops 日志）时给回调，不影响返回 null 的契约 */
  onError?: (e: unknown) => void;
}

const JSON_RULE = "\n\n【输出格式】只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码围栏。";

/** 非流式 JSON 生成。失败（网络 / 解析 / 校验两次不过）返回 null，调用方走降级分支。 */
export async function generateJson<T>(system: string, user: string, opts: JsonOptions<T>): Promise<T | null> {
  const route = opts.model ? { ...routeFor(opts.task), model: opts.model } : routeFor(opts.task);
  const maxTokens = opts.maxTokens ?? 1500;
  let prompt = user;
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, usage, finishReason } = await generateText({
        model: modelFor(route, true),
        system: system + JSON_RULE,
        prompt,
        temperature: opts.temperature ?? route.temperature,
        maxOutputTokens: budget(route, maxTokens),
        abortSignal: AbortSignal.timeout(180_000), // LLM 挂起时让管线走 error 分支，而不是无限等
      });
      addUsage(opts.task, usage);
      const parsed = parseJson(text);
      if (parsed === null) {
        lastProblem = finishReason === "length" ? "输出被截断（超长），请精简内容" : "输出不是合法 JSON";
        console.warn(`[llm:${opts.task}] 无法解析（finish=${finishReason}，${text.length} 字）：${text.slice(0, 160).replace(/\s+/g, " ")}`);
        if (process.env.LLM_DEBUG_DUMP) {
          try {
            JSON.parse(text.trim());
          } catch (e) {
            const m = /position (\d+)/.exec(String(e));
            const at = m ? Number(m[1]) : 0;
            console.warn(`[llm:debug] ${String(e).slice(0, 120)} …${JSON.stringify(text.slice(Math.max(0, at - 80), at + 40))}`);
          }
        }
      } else if (opts.schema) {
        const check = opts.schema.safeParse(parsed);
        if (check.success) return check.data as T;
        lastProblem = check.error.issues
          .slice(0, 6)
          .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
          .join("；");
      } else {
        return parsed as T;
      }
    } catch (e) {
      console.error(`[llm:${opts.task}] generateJson failed:`, e);
      opts.onError?.(e);
      return null;
    }
    console.warn(`[llm:${opts.task}] 第 ${attempt + 1} 次输出不合格：${lastProblem}`);
    prompt = `${user}\n\n【上次输出不合格，请修正后重新输出完整 JSON】${lastProblem}`;
  }
  opts.onError?.(new Error(`JSON 输出两次不合格：${lastProblem}`));
  return null;
}

/** JSON 模式下正常直接可解析；非 DeepSeek 端点或个别畸形时退回容错提取 */
function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text.trim());
  } catch {
    const got = extractJson(text);
    if (got != null) return got;
    // 常见畸形：中文句子里夹了英文双引号（谁是"一"谁是"多"），把字符串提前截断了——换成「」再试
    const repaired = repairCjkQuotes(text);
    const fixedQuotes = repaired !== text ? extractJson(repaired) : null;
    if (fixedQuotes != null) return fixedQuotes;
    // 结构性畸形（括号没闭合 / 多了一层 / 漏逗号）：交给 jsonrepair
    try {
      return JSON.parse(jsonrepair(repaired));
    } catch {
      return null;
    }
  }
}

/** 两侧紧贴中文（或中文标点）的成对英文双引号 → 「」。JSON 结构里的引号两侧是 : , { [ 空白，不会被误伤 */
export function repairCjkQuotes(text: string): string {
  // 引号内容不能以 JSON 结构符号开头（否则会把 "正常","好" 两个字符串之间的边界误当成一对引号）
  const re = /([㐀-鿿＀-￯　-〿])"(?![\s,:[\]{}])([^"\n]{1,40}?)"(?=[㐀-鿿＀-￯　-〿]|"\s*[,}\]])/g;
  return text.replace(re, "$1「$2」");
}

/** 从模型输出中容错提取 JSON（模型带 ```json 包裹或多余文字时） */
export function extractJson<T>(text: string): T | null {
  // 只在明确 ```json 围栏时先剥壳：卡面正文里的 ```python 之类代码块不能当围栏
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const openChar = candidate[start];
  const closeChar = openChar === "{" ? "}" : "]";
  // 括号平衡扫描（字符串/转义感知）：正文里的花括号、反引号都不干扰
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1)) as T;
      } catch {
        break;
      }
    }
  }
  // 兜底：从后往前找闭合符（轻微畸形时仍尽力解析）
  const end = candidate.lastIndexOf(closeChar);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ---- 纯文本生成（非流式）：标题、互动动画 HTML 等 ----
export async function generatePlainText(
  system: string,
  user: string,
  opts: { task: LlmTask; maxTokens?: number; temperature?: number; timeoutMs?: number }
): Promise<string> {
  const route = routeFor(opts.task);
  const { text, usage } = await generateText({
    model: modelFor(route, false),
    system,
    prompt: user,
    temperature: opts.temperature ?? route.temperature,
    maxOutputTokens: budget(route, opts.maxTokens ?? 1000),
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  addUsage(opts.task, usage);
  return text;
}

// ---- 流式回答 ----
/**
 * JSON Lines 增量解析器（纯函数，可单测）：push(文本块) 逐块喂，end() 收尾。
 * 一行是完整对象就立刻交出；模型若把一个对象美化成多行（实测会），就继续攒行，
 * 括号配平（字符串感知）后再解析——宁可晚一点交，也不丢内容。坏块先修引号、再 jsonrepair，修不了记 badLines。
 */
export function createJsonLinesParser(onObject: (obj: Record<string, unknown>) => void | Promise<void>) {
  let buf = "";
  let pending = "";
  const stats = { objects: 0, badLines: 0 };
  const depthOf = (s: string) => {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (const ch of s) {
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
    }
    return depth;
  };
  const parseLoose = (s: string): unknown => {
    const body = s.trim().replace(/,\s*$/, "");
    try {
      return JSON.parse(body);
    } catch {
      try {
        return JSON.parse(jsonrepair(repairCjkQuotes(body)));
      } catch {
        return null;
      }
    }
  };
  const emit = async (obj: unknown) => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      stats.objects += 1;
      await onObject(obj as Record<string, unknown>);
    } else stats.badLines += 1;
  };
  const take = async (line: string) => {
    const raw = line.replace(/\r$/, "");
    const s = raw.trim();
    if (/^```(json|jsonl)?$/i.test(s)) return;
    if (!pending) {
      if (!s.startsWith("{")) return;
      pending = s;
    } else {
      pending += "\n" + raw;
    }
    if (depthOf(pending) > 0) {
      // 多行对象还没写完：等下一行；防失控：攒太长就放弃这一块
      if (pending.length > 24000) {
        stats.badLines += 1;
        pending = "";
      }
      return;
    }
    const block = pending;
    pending = "";
    await emit(parseLoose(block));
  };
  return {
    stats,
    async push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        await take(line);
      }
    },
    async end() {
      await take(buf);
      buf = "";
      if (pending) {
        // 流结束时还没配平（被截断）：尽力修一次
        const block = pending;
        pending = "";
        await emit(parseLoose(block));
      }
    },
  };
}

/**
 * 流式逐行 JSON（JSONL）：模型每写完一个对象就回调一次——白板课靠它"边生成边上板"，不必等整段写完。
 */
export async function streamJsonLines(
  system: string,
  user: string,
  onObject: (obj: Record<string, unknown>) => void | Promise<void>,
  opts: { task: LlmTask; maxTokens?: number; temperature?: number; thinking?: Thinking } = { task: "script" }
): Promise<{ objects: Record<string, unknown>[]; text: string; badLines: number; firstLineMs: number | null }> {
  const base = routeFor(opts.task);
  const route = opts.thinking ? { ...base, thinking: opts.thinking } : base;
  const t0 = Date.now();
  const result = streamText({
    model: modelFor(route, false),
    system: system + "\n\n【输出格式】JSON Lines：每行一个完整的 JSON 对象，行与行之间只有换行；不要 Markdown 围栏、不要任何解释。字符串里的换行写成 \\n。",
    prompt: user,
    temperature: opts.temperature ?? route.temperature,
    maxOutputTokens: budget(route, opts.maxTokens ?? 3000),
    abortSignal: AbortSignal.timeout(240_000),
  });
  const objects: Record<string, unknown>[] = [];
  let text = "";
  let firstLineMs: number | null = null;
  const parser = createJsonLinesParser(async (obj) => {
    if (firstLineMs == null) firstLineMs = Date.now() - t0;
    objects.push(obj);
    await onObject(obj);
  });
  for await (const chunk of result.textStream) {
    text += chunk;
    await parser.push(chunk);
  }
  await parser.end();
  try {
    addUsage(opts.task, await result.usage);
  } catch {
    // 统计失败可忽略
  }
  return { objects, text, badLines: parser.stats.badLines, firstLineMs };
}

export async function streamAnswer(
  system: string,
  user: string,
  onToken: (t: string) => void | Promise<void>,
  opts: { task?: LlmTask; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const task = opts.task ?? "chat";
  const route = routeFor(task);
  const result = streamText({
    model: modelFor(route, false),
    system,
    prompt: user,
    temperature: opts.temperature ?? route.temperature,
    maxOutputTokens: budget(route, opts.maxTokens ?? 4000),
    abortSignal: AbortSignal.timeout(300_000),
  });
  let full = "";
  for await (const chunk of result.textStream) {
    full += chunk;
    await onToken(chunk);
  }
  try {
    addUsage(task, await result.usage); // 中途 abort 时 usage 可能不可用，别让统计拖垮主流程
  } catch {
    // 统计失败可忽略
  }
  return full;
}
