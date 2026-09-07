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

/** 非流式 JSON 生成：用于意图分类、搜索词规划、标题生成、课程结构生成 */
export async function generateJson<T>(
  system: string,
  user: string,
  maxTokens = 1500
): Promise<T | null> {
  try {
    const { text } = await generateText({
      model: getModel(),
      system,
      prompt: user,
      temperature: 0.2,
      maxTokens,
      abortSignal: AbortSignal.timeout(120_000), // LLM 挂起时让管线走 error 分支，而不是无限等
    });
    return extractJson<T>(text);
  } catch (e) {
    console.error("generateJson failed:", e);
    return null;
  }
}

/** 从模型输出中容错提取 JSON（模型常带 ```json 包裹或多余文字） */
export function extractJson<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  // 从后往前找匹配的闭合符
  const openChar = candidate[start];
  const closeChar = openChar === "{" ? "}" : "]";
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
  return full;
}
