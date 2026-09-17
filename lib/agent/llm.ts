import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

// OpenAI 兼容协议：DeepSeek / GLM / 任意兼容端点
const provider = createOpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com",
  apiKey: process.env.LLM_API_KEY || "",
});

const modelId = process.env.LLM_MODEL || "deepseek-chat";

export function getModel() {
  return provider(modelId);
}

// 用量累计（本进程内）：eval 脚本与成本核算用。drainLlmUsage() 取走累计值并清零。
const usageAcc = { calls: 0, promptTokens: 0, completionTokens: 0 };

export function drainLlmUsage(): { calls: number; promptTokens: number; completionTokens: number } {
  const snap = { ...usageAcc };
  usageAcc.calls = 0;
  usageAcc.promptTokens = 0;
  usageAcc.completionTokens = 0;
  return snap;
}

function addUsage(u?: { promptTokens?: number | null; completionTokens?: number | null }) {
  if (!u) return;
  usageAcc.calls += 1;
  usageAcc.promptTokens += u.promptTokens || 0;
  usageAcc.completionTokens += u.completionTokens || 0;
}

/** 非流式 JSON 生成：用于意图分类、搜索词规划、标题生成、课程结构生成。
 *  onError：调用方想拿真实失败原因（进 ops 日志）时给回调，不影响返回 null 的契约。 */
export async function generateJson<T>(
  system: string,
  user: string,
  maxTokens = 1500,
  onError?: (e: unknown) => void
): Promise<T | null> {
  try {
    const { text, usage } = await generateText({
      model: getModel(),
      system,
      prompt: user,
      temperature: 0.2,
      maxTokens,
      abortSignal: AbortSignal.timeout(120_000), // LLM 挂起时让管线走 error 分支，而不是无限等
    });
    addUsage(usage);
    return extractJson<T>(text);
  } catch (e) {
    console.error("generateJson failed:", e);
    onError?.(e);
    return null;
  }
}

/** 从模型输出中容错提取 JSON（模型常带 ```json 包裹或多余文字） */
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
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          break;
        }
      }
    }
  }
  // 兜底：从后往前找闭合符（截断/轻微畸形时仍尽力解析）
  const end = candidate.lastIndexOf(closeChar);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 流式生成最终回答，逐 token 回调 */
export async function streamAnswer(
  system: string,
  user: string,
  onToken: (t: string) => void | Promise<void>
): Promise<string> {
  const result = streamText({
    model: getModel(),
    system,
    prompt: user,
    temperature: 0.5,
    maxTokens: 4000,
    abortSignal: AbortSignal.timeout(300_000),
  });
  let full = "";
  for await (const chunk of result.textStream) {
    full += chunk;
    await onToken(chunk);
  }
  try {
    addUsage(await result.usage); // 中途 abort 时 usage 可能不可用，别让统计拖垮主流程
  } catch {
    // 统计失败可忽略
  }
  return full;
}
