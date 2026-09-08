// 一次性测量脚本：用一门现成课程跑一节完整的白板课，报告 token 用量与成本
import { readFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PRICE_IN = 2, PRICE_OUT = 8; // 元/百万token

async function main() {
  const { runStartTeaching, buildLectureContext } = await import("../lib/agent/teach");
  const { drainLlmUsage } = await import("../lib/agent/llm");

  const file = process.argv[2] || "data/courses/course-0fe39cf8.json";
  const state = JSON.parse(readFileSync(path.join(__dirname, "..", file), "utf8"));
  const ctx = buildLectureContext(state.outline, state.outline.units[0].id, state.outline.units[0].lectures[0].id);
  if (!ctx) throw new Error("lecture not found");
  // 与 /api/teach 相同的 grounding：建课时读的网页正文
  const blocks: string[] = [];
  for (const s of state.sources || []) {
    const text = state.pageContents?.[String(s.index)];
    if (!text) continue;
    blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1500)}`);
    if (blocks.length >= 4) break;
  }
  if (blocks.length) ctx.referenceMaterial = blocks.join("\n\n");
  if (state.outline.units[0].key_concepts?.length) ctx.keyConcepts = state.outline.units[0].key_concepts;

  drainLlmUsage();
  const t0 = Date.now();
  let beats = 0;
  await runStartTeaching({ ctx, emit: async (e: any) => { if (e.type === "beats") beats++; } });
  const u = drainLlmUsage();
  const cost = (u.promptTokens / 1e6) * PRICE_IN + (u.completionTokens / 1e6) * PRICE_OUT;
  console.log(`课节：${ctx.lectureTitle}`);
  console.log(`片段数：${beats}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`tokens：${u.promptTokens} in / ${u.completionTokens} out（${u.calls} 次 LLM 调用）`);
  console.log(`成本：≈ ¥${cost.toFixed(3)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
