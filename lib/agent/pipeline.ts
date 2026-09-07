// Agent 主管线：classify → (clarify | chat | plan → search → read → write)
import type { AgentEvent, SourceItem, StageName, StageRecord } from "@/types";
import { generateJson, streamAnswer } from "./llm";
import { webSearch } from "./search";
import { readUrl } from "./read";
import {
  CLASSIFY_SYSTEM,
  PLAN_SYSTEM,
  CHAT_SYSTEM,
  TITLE_SYSTEM,
  VERIFY_SYSTEM,
  buildAnswerSystem,
} from "./prompts";
import { generateText } from "ai";
import { getModel } from "./llm";

type Emit = (e: AgentEvent) => Promise<void> | void;

interface HistoryMsg {
  role: "user" | "assistant";
  content: string;
}

function fmtHistory(history: HistoryMsg[]): string {
  return history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 500)}`)
    .join("\n\n");
}

export async function runAgent(opts: {
  message: string;
  history: HistoryMsg[];
  emit: Emit;
}): Promise<{ answer: string; sources: SourceItem[]; stages: StageRecord[]; clarified: boolean }> {
  const { message, history, emit } = opts;
  const stages: StageRecord[] = [];
  const sources: SourceItem[] = [];

  const stageStart = async (name: StageName, label: string, detail?: string) => {
    stages.push({ name, label, detail });
    await emit({ type: "stage", name, label, status: "start", detail });
  };
  const stageEnd = async (name: StageName, label: string) => {
    await emit({ type: "stage", name, label, status: "end" });
  };

  // ---- 第 1 步：意图分类 ----
  await stageStart("classify", "正在理解你的问题");
  const histText = fmtHistory(history);
  const cls = await generateJson<{
    mode: "chat" | "search" | "clarify";
    questions?: any[];
  }>(
    CLASSIFY_SYSTEM,
    `${histText ? `最近对话：\n${histText}\n\n` : ""}用户最新消息：${message}`
  );
  const mode = cls?.mode || "search";
  await stageEnd("classify", "正在理解你的问题");

  // ---- 分支 A：需要澄清 ----
  if (mode === "clarify" && cls?.questions?.length) {
    const questions = cls.questions.slice(0, 4).map((q: any, i: number) => ({
      id: q.id || `q${i + 1}`,
      question: String(q.question || ""),
      multi: Boolean(q.multi),
      skippable: q.skippable !== false,
      options: (q.options || []).slice(0, 4).map((o: any) => ({
        label: String(o.label || ""),
        desc: o.desc ? String(o.desc) : undefined,
      })),
    })).filter((q: any) => q.question && q.options.length >= 2);
    if (questions.length > 0) {
      await emit({ type: "clarify", questions });
      return { answer: "", sources, stages, clarified: true };
    }
  }

  // ---- 分支 B：闲聊直答 ----
  if (mode === "chat") {
    await stageStart("write", "正在回答");
    const answer = await streamAnswer(
      CHAT_SYSTEM,
      `${histText ? `最近对话：\n${histText}\n\n` : ""}用户：${message}`,
      async (t) => emit({ type: "token", text: t })
    );
    await stageEnd("write", "正在回答");
    return { answer, sources, stages, clarified: false };
  }

  // ---- 分支 C：搜索 → 阅读 → 写作 ----
  await stageStart("plan", "正在规划检索");
  const plan = await generateJson<{ queries: string[] }>(
    PLAN_SYSTEM,
    `用户问题：${message}`
  );
  const queries = (plan?.queries || [message]).slice(0, 3);
  await emit({
    type: "stage",
    name: "plan",
    label: "正在规划检索",
    status: "end",
    detail: queries.join(" ｜ "),
  });
  if (stages.length) stages[stages.length - 1].detail = queries.join(" ｜ ");

  // 搜索（并行）
  await stageStart("search", "正在搜索网络资料", queries.join(" ｜ "));
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q, 5)));
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const item of s.value) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      sources.push({ ...item, index: sources.length + 1 });
      if (sources.length >= 10) break;
    }
    if (sources.length >= 10) break;
  }
  await emit({ type: "sources", items: sources });
  await emit({
    type: "stage",
    name: "search",
    label: "正在搜索网络资料",
    status: "end",
    detail: `找到 ${sources.length} 个来源`,
  });

  // 阅读 top 页面（多读几页：源头质量决定讲解质量）
  const toRead = sources.slice(0, 6);
  const pageContents: Record<number, string> = {};
  if (toRead.length > 0) {
    await stageStart("read", "正在阅读网页内容", `0/${toRead.length}`);
    let doneCount = 0;
    await Promise.all(
      toRead.map(async (s) => {
        const text = await readUrl(s.url);
        if (text.length > 200) pageContents[s.index] = text;
        doneCount += 1;
        await emit({
          type: "stage",
          name: "read",
          label: "正在阅读网页内容",
          status: "start",
          detail: `${doneCount}/${toRead.length} · ${s.domain}`,
        });
      })
    );
    await emit({
      type: "stage",
      name: "read",
      label: "正在阅读网页内容",
      status: "end",
      detail: `读完 ${Object.keys(pageContents).length}/${toRead.length} 个页面`,
    });
  }

  // 组装资料块
  const sourceBlocks = sources
    .map((s) => {
      const body = pageContents[s.index] || s.snippet || "";
      return `[${s.index}] ${s.title}（${s.domain}）\n${body.slice(0, 6000)}`;
    })
    .join("\n\n---\n\n");

  // 写作前先核对证据，降低引用错配和把推断写成事实的风险。
  let evidenceSummary = "";
  if (sourceBlocks) {
    await stageStart("verify", "正在核对来源证据", `检查 ${sources.length} 个来源是否支持结论`);
    const verification = await generateJson<{
      facts?: Array<{ claim?: string; sources?: number[] }>;
      conflicts?: string[];
      gaps?: string[];
    }>(VERIFY_SYSTEM, `用户问题：${message}\n\n网页资料：\n${sourceBlocks}`, 2200);
    const facts = (verification?.facts || [])
      .filter(
        (f) =>
          f.claim &&
          Array.isArray(f.sources) &&
          f.sources.length > 0 &&
          f.sources.every((n) => Number.isInteger(n) && n >= 1 && n <= sources.length)
      )
      .slice(0, 8)
      .map((f) => `- ${f.claim}（来源：${f.sources!.map((n) => `[${n}]`).join(" ")}）`);
    const conflicts = (verification?.conflicts || []).slice(0, 3).map((x) => `- 资料冲突：${x}`);
    const gaps = (verification?.gaps || []).slice(0, 3).map((x) => `- 资料缺口：${x}`);
    evidenceSummary = [...facts, ...conflicts, ...gaps].join("\n");
    await stageEnd("verify", "正在核对来源证据");
    const verifyRecord = stages[stages.length - 1];
    if (verifyRecord) verifyRecord.detail = facts.length ? `确认 ${facts.length} 条可引用事实` : "未找到足够的直接证据";
  }

  await stageStart("write", "正在组织讲解");
  const answer = await streamAnswer(
    buildAnswerSystem(sources.length),
    `用户问题：${message}\n\n` +
      (histText ? `最近对话上下文：\n${histText}\n\n` : "") +
      (evidenceSummary ? `资料核验摘要（仅据此确认事实）：\n${evidenceSummary}\n\n` : "") +
      `以下是可以引用的网页资料（编号即引用编号）：\n\n${sourceBlocks}`,
    async (t) => emit({ type: "token", text: t })
  );
  await stageEnd("write", "正在组织讲解");
  return { answer, sources, stages, clarified: false };
}

export async function generateTitle(firstMessage: string, firstAnswer: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: getModel(),
      system: TITLE_SYSTEM,
      prompt: `用户：${firstMessage.slice(0, 200)}\n助手：${firstAnswer.slice(0, 300)}`,
      temperature: 0.3,
      maxTokens: 30,
    });
    const t = text.trim().replace(/["'《》。.]/g, "").slice(0, 16);
    return t || "新对话";
  } catch {
    return firstMessage.slice(0, 12) || "新对话";
  }
}
