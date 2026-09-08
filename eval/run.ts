/**
 * Eval 运行器：把 10 道固定题直接灌进真实课程管线（搜索 → 分轮澄清 → 蓝图 → 大纲），
 * 机器打分 + LLM 评委打分，产出报告并与上一次全量运行对比。
 *
 * 用法：
 *   npm run eval                                 # 全量 10 题，结束后更新 eval/results/latest.json
 *   npm run eval -- --only=ml-systematic,cooking-zero --tag=v3   # 指定题目（不更新 latest.json）
 *   npm run eval -- --skip-judge                 # 只跑机器打分（省钱快速冒烟）
 *
 * 评分标准见 eval/rubric.md。核心纪律：改 prompt 前后各跑一次，总分涨了才采纳。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

// ---- 0. 轻量 .env 加载（必须在动态 import 管线之前：llm.ts 在模块加载时读 env） ----
const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// ---- 1. 参数 ----
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const onlyIds = getArg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const tag = getArg("tag");
const skipJudge = args.includes("--skip-judge");
const FULL_RUN = !onlyIds; // 只有全量运行才更新 latest.json（部分运行会污染对比基线）

// DeepSeek deepseek-chat 价目（元/百万 token）。官方调价后改这里。
const PRICE_IN = 2;
const PRICE_OUT = 8;

const RESULTS_DIR = path.join(__dirname, "results");
const LATEST_PATH = path.join(RESULTS_DIR, "latest.json");

interface EvalCase {
  id: string;
  query: string;
  persona: string;
  expect: string;
}

const BOILERPLATE = [
  "掌握核心", "核心概念", "深入学习", "全面了解", "基本概念",
  "基础知识", "相关知识", "初步了解", "深入探讨", "综合概述",
];
const DEFAULT_SUMMARY_PREFIX = "深入讲解「"; // runOutlineStep 的兜底摘要句式，出现 = 细节填充失败

const noop = async () => {};

function machineScore(outline: any, blueprint: any) {
  const units: any[] = outline.units || [];
  // 蓝图兜底特征：单单元 + lec-1-1（runBlueprintStep 的 fallback 结构）
  const blueprintFallback =
    blueprint.units.length === 1 && blueprint.units[0].lectures?.[0]?.id === "lec-1-1";

  let structure = 0;
  if (!blueprintFallback) {
    if (units.length >= 3 && units.length <= 6) structure += 1;
    if (units.every((u) => u.lectures.length >= 2 && u.lectures.length <= 5)) structure += 1;
  }

  const titles: string[] = units.flatMap((u) => u.lectures.map((l: any) => String(l.title || "")));
  const avgTitleLen = titles.reduce((s, t) => s + t.length, 0) / Math.max(1, titles.length);
  const titleHits = titles.filter((t) => BOILERPLATE.some((w) => t.includes(w))).length;
  const titleSpecific = avgTitleLen >= 12 ? 1 : 0;
  const noBoilerTitles = titleHits === 0 ? 1 : titleHits <= 2 ? 0.5 : 0;

  const summaries: string[] = units.flatMap((u) => u.lectures.map((l: any) => String(l.summary || "")));
  const defaultSummaries = summaries.filter((s) => s.startsWith(DEFAULT_SUMMARY_PREFIX) || !s.trim()).length;
  const detailFill = defaultSummaries === 0 ? 1 : 0;
  const summaryHits = summaries.filter((s) => BOILERPLATE.some((w) => s.includes(w))).length;

  return {
    blueprintFallback,
    structure,
    titleSpecific,
    noBoilerTitles,
    detailFill,
    noBoilerSummaries: summaryHits === 0 ? 1 : 0,
    machine: structure + titleSpecific + noBoilerTitles + detailFill + (summaryHits === 0 ? 1 : 0),
    avgTitleLen: Math.round(avgTitleLen * 10) / 10,
    titleHits,
    summaryHits,
    defaultSummaries,
  };
}

const JUDGE_SYSTEM = `你是严格的课程质量评审。你会收到一门课程的大纲 JSON、学习者画像（persona）、该题的考察点（expect）。
请按四个维度各打 0-5 的整数分：
- specificity 课节标题具体性：标题是否具体到机制/场景/考点，能否一眼看出这节课学什么、学完能做什么
- structure_logic 结构逻辑：单元之间递进关系是否合理，先修依赖顺序对不对
- audience_fit 受众适配：深度、节奏、语言是否贴合 persona（70 岁老人和大三学生的课必须有明显差异）
- overall 总体印象：作为一门要交付的课，你是否愿意把它交给这位学习者
打分纪律：两个档位之间犹豫时打低的那档；没有明显亮点不给 5 分；必须至少给一条 issue。
只输出 JSON：{"scores":{"specificity":0,"structure_logic":0,"audience_fit":0,"overall":0},"issues":["..."]}`;

async function main() {
  const { runSearchStep, runClarifyStep, runBlueprintStep, runOutlineStep } = await import("../lib/agent/course");
  const { generateJson, drainLlmUsage } = await import("../lib/agent/llm");

  const allCases: EvalCase[] = JSON.parse(readFileSync(path.join(__dirname, "cases.json"), "utf8")).cases;
  const cases = onlyIds ? allCases.filter((c) => onlyIds.includes(c.id)) : allCases;
  if (cases.length === 0) {
    console.error(`没有匹配的题目。可用 id：${allCases.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  // 对比基线：先读旧 latest，运行结束后再覆盖
  const previous = existsSync(LATEST_PATH)
    ? JSON.parse(readFileSync(LATEST_PATH, "utf8"))
    : null;

  const runId = tag ? `${tag}-${stamp()}` : stamp();
  const runDir = path.join(RESULTS_DIR, runId);
  mkdirSync(runDir, { recursive: true });

  const rows: any[] = [];
  console.log(`\n===== Eval run ${runId} =====`);
  console.log(`模式：${FULL_RUN ? "全量（会更新 latest.json）" : `指定 ${cases.length} 题`}${skipJudge ? "（跳过 LLM 评委）" : ""}\n`);

  for (const c of cases) {
    const t0 = Date.now();
    drainLlmUsage(); // 清零，本题结束时取走
    const phaseTiming: Record<string, number> = {};
    try {
      // 1) 搜索
      let t = Date.now();
      const sr = await runSearchStep({ query: c.query, history: [], emit: noop });
      phaseTiming.search = Date.now() - t;
      const sources = sr.sources;
      const pageContents = sr.pageContents;

      // 资料摘要（与 /api/course 的 buildPageExcerpts 同规则：top4 × 1800 字）
      const blocks: string[] = [];
      for (const s of sources) {
        const text = pageContents[s.index];
        if (!text) continue;
        blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1800)}`);
        if (blocks.length >= 4) break;
      }
      const excerpts = blocks.join("\n\n");

      // 2) 分轮澄清：用 persona 自动作答（和真人选选项等价），最多 4 轮
      t = Date.now();
      const clarifyAnswers: { question: string; answer: string }[] = [];
      for (let round = 1; round <= 4; round++) {
        const { question, done } = await runClarifyStep({
          query: c.query,
          history: [],
          sources,
          clarifyAnswers,
          round,
          courseId: `eval-${c.id}`,
          pageExcerpts: excerpts,
          emit: noop,
        });
        if (done || !question) break;
        clarifyAnswers.push({ question: question.question, answer: c.persona });
      }
      phaseTiming.clarify = Date.now() - t;

      // 3) 蓝图
      t = Date.now();
      const { blueprint } = await runBlueprintStep({
        query: c.query,
        clarifyAnswers,
        pageExcerpts: excerpts,
        emit: noop,
      });
      phaseTiming.blueprint = Date.now() - t;

      // 4) 大纲
      t = Date.now();
      const { outline, title } = await runOutlineStep({
        query: c.query,
        clarifyAnswers,
        blueprint,
        emit: noop,
      });
      phaseTiming.outline = Date.now() - t;

      const usage = drainLlmUsage();
      const costYuan = (usage.promptTokens / 1e6) * PRICE_IN + (usage.completionTokens / 1e6) * PRICE_OUT;

      const m = machineScore(outline, blueprint);
      let judge: { scores?: Record<string, number>; issues?: string[] } | null = null;
      if (!skipJudge) {
        const lean = {
          title,
          units: (outline.units || []).map((u: any) => ({
            unit: u.title,
            lectures: u.lectures.map((l: any) => ({ title: l.title, summary: l.summary })),
          })),
        };
        judge = await generateJson<{ scores: Record<string, number>; issues: string[] }>(
          JUDGE_SYSTEM,
          `学习者画像：${c.persona}\n考察点：${c.expect}\n\n大纲 JSON：\n${JSON.stringify(lean, null, 1)}`,
          1200
        );
      }
      const judgeScore = judge?.scores
        ? Object.values(judge.scores).reduce((s, v) => s + (Number(v) || 0), 0)
        : null;
      const total = m.machine + (judgeScore ?? 0);
      const maxScore = 6 + (judgeScore !== null ? 20 : 0);

      rows.push({
        id: c.id, query: c.query, title, total, maxScore,
        machine: m.machine, machineDetail: m, judge: judgeScore, judgeDetail: judge,
        usage, costYuan: Math.round(costYuan * 1000) / 1000,
        durationMs: Date.now() - t0, phaseTiming,
        error: null,
      });
      console.log(
        `✅ ${c.id.padEnd(15)} 总分 ${String(total)}/${maxScore}（机器 ${m.machine}/6${judgeScore !== null ? ` + 评委 ${judgeScore}/20` : ""}）` +
          ` tokens ${usage.promptTokens}in/${usage.completionTokens}out ≈¥${costYuan.toFixed(2)} ` +
          `${Math.round((Date.now() - t0) / 1000)}s`
      );
      if (judge?.issues?.length) console.log(`   评委 issues: ${judge.issues.join("；")}`);
    } catch (e) {
      rows.push({
        id: c.id, query: c.query, title: null, total: 0, maxScore: 26,
        machine: 0, machineDetail: null, judge: null, judgeDetail: null,
        usage: drainLlmUsage(), costYuan: null, durationMs: Date.now() - t0,
        phaseTiming, error: e instanceof Error ? e.message : String(e),
      });
      console.log(`❌ ${c.id.padEnd(15)} 失败：${rows[rows.length - 1].error}`);
    }
  }

  // ---- 汇总 ----
  const okRows = rows.filter((r) => !r.error);
  const totalScore = rows.reduce((s, r) => s + r.total, 0);
  const totalMax = rows.reduce((s, r) => s + r.maxScore, 0);
  const totalCost = rows.reduce((s, r) => s + (r.costYuan || 0), 0);
  const avgCost = okRows.length ? totalCost / okRows.length : 0;

  const summaryLines = [
    `# Eval 报告：${runId}`,
    "",
    `- 时间：${new Date().toISOString()}`,
    `- 范围：${FULL_RUN ? "全量 10 题" : `${rows.length} 题（${rows.map((r) => r.id).join(", ")}）`}`,
    `- 总分：**${totalScore} / ${totalMax}**`,
    `- 单课平均成本：≈ ¥${avgCost.toFixed(2)}（输入 ${PRICE_IN} 元/M + 输出 ${PRICE_OUT} 元/M）`,
    "",
    "| 题目 | 得分 | 机器/6 | 评委/20 | 平均标题长 | tokens | ≈成本 | 用时 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id}${r.error ? `（失败：${r.error}）` : ""} | ${r.total}/${r.maxScore} | ${r.machine} | ${
          r.judge ?? "-"
        } | ${r.machineDetail?.avgTitleLen ?? "-"} | ${r.usage?.promptTokens ?? "-"}/${r.usage?.completionTokens ?? "-"} | ${
          r.costYuan !== null ? `¥${r.costYuan.toFixed(2)}` : "-"
        } | ${Math.round(r.durationMs / 1000)}s |`
    ),
  ];

  // 与上次全量对比
  if (previous && previous.perCase) {
    summaryLines.push("", "## 与上一次全量（" + previous.runId + " 总分 " + previous.totalScore + "）对比", "");
    for (const r of rows) {
      const prev = previous.perCase[r.id];
      if (!prev) continue;
      const delta = r.total - prev.total;
      const mark = delta > 0 ? "📈" : delta < 0 ? "📉" : "➖";
      summaryLines.push(`- ${mark} ${r.id}: ${prev.total} → ${r.total}（${delta >= 0 ? "+" : ""}${delta}）`);
    }
    summaryLines.push("", `总分变化：${previous.totalScore} → ${totalScore}（${totalScore - previous.totalScore >= 0 ? "+" : ""}${totalScore - previous.totalScore}）`);
  }

  writeFileSync(path.join(runDir, "summary.md"), summaryLines.join("\n"), "utf8");
  for (const r of rows) {
    writeFileSync(path.join(runDir, `case-${r.id}.json`), JSON.stringify(r, null, 2), "utf8");
  }

  if (FULL_RUN) {
    const latest = {
      runId,
      at: Date.now(),
      totalScore,
      totalMax,
      perCase: Object.fromEntries(rows.map((r) => [r.id, { total: r.total, machine: r.machine, judge: r.judge }])),
      avgCostYuan: Math.round(avgCost * 1000) / 1000,
    };
    writeFileSync(LATEST_PATH, JSON.stringify(latest, null, 2), "utf8");
    console.log(`\nlatest.json 已更新（全量运行基线）。`);
  }

  console.log(`\n报告目录：eval/results/${runId}/`);
  console.log(`总分 ${totalScore}/${totalMax}，单课平均成本 ≈ ¥${avgCost.toFixed(2)}`);
  // 采纳纪律的机器提醒
  if (previous && FULL_RUN) {
    const delta = totalScore - previous.totalScore;
    console.log(`对比上次全量：${delta >= 0 ? "+" : ""}${delta} —— ${delta > 0 ? "可采纳 ✅" : delta < 0 ? "建议回滚 ❌" : "持平，看 issues 决定"}`);
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

main().catch((e) => {
  console.error("eval runner 挂了：", e);
  process.exit(1);
});
