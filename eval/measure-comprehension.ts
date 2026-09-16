// 讲稿「可理解度」测量：跑一节真实白板课，量化「一遍能不能听懂」。
// 与 measure-teach.ts 同源（同 grounding、同入口），改提示词前后各跑一次做对比。
//
// 用法：npx tsx eval/measure-comprehension.ts [courseFile] [unitIndex] [lectureIndex]
//
// 指标口径（越小越好/越大越好已在输出里标注）：
//   时长        —— 讲稿总字数 / 250 字每分（中文口播语速）；目标 7-10 分钟
//   平均句长    —— 听力友好区 ≤ 40 字/句
//   超长句占比  —— > 45 字的句子占比（听一遍必丢）
//   复述率      —— 带"换句话说/也就是说/用人话说"类标记的段占比（关键机制讲两遍的信号）
//   首现未解释  —— 术语第一次出现时，同句或下一句没有解释/举例标记（听不明白的头号来源）
import { readFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const RESTATE_MARKS = ["换句话说", "也就是说", "用人话说", "说人话", "再直白", "直白点", "简单说", "更简单地说", "翻译成大白话", "大白话", "通俗地", "说白了", "意思是"];
const EXPLAIN_MARKS = ["意思是", "指的是", "就是指", "也就是说", "就是", "比如", "例如", "举个", "举个例子", "你可以把它理解", "相当于", "打个比方", "简单理解", "可以理解为", "为了", "作用是把", "用来"];
const TERM_RE = /[A-Za-z][A-Za-z0-9_.\-]{2,}|[「『]([^」』]{2,12})[」』]/g;

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？；\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

interface Seg {
  index: number;
  title: string;
  says: string[];
  items: number;
  itemKinds: string[];
}

async function main() {
  const { runStartTeaching, buildLectureContext } = await import("../lib/agent/teach");
  const { drainLlmUsage } = await import("../lib/agent/llm");

  const file = process.argv[2] || "data/courses/course-e1f781a4.json";
  const unitIdx = Number(process.argv[3] || 0);
  const lecIdx = Number(process.argv[4] || 0);
  const state = JSON.parse(readFileSync(path.join(__dirname, "..", file), "utf8"));
  const unit = state.outline.units[unitIdx];
  const ctx = buildLectureContext(state.outline, unit.id, unit.lectures[lecIdx].id);
  if (!ctx) throw new Error("lecture not found");

  // 与 /api/teach 相同的 grounding
  const blocks: string[] = [];
  for (const s of state.sources || []) {
    const text = state.pageContents?.[String(s.index)];
    if (!text) continue;
    blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1500)}`);
    if (blocks.length >= 4) break;
  }
  if (blocks.length) ctx.referenceMaterial = blocks.join("\n\n");
  if (unit.key_concepts?.length) ctx.keyConcepts = unit.key_concepts;

  // 与 /api/teach 相同的结课作品注入（P1-3：例子落在学员自己的作品场景）
  const capstone = state.outline?.capstone || state.blueprint?.capstone;
  if (capstone?.name) {
    const clarifyHit = (state.clarifyAnswers || []).find((a: any) => /亲手做出|结课作品/.test(a.question || ""));
    ctx.capstoneGoal = [clarifyHit?.answer && clarifyHit.answer !== capstone.name ? clarifyHit.answer : capstone.name, capstone.description]
      .filter(Boolean)
      .join("——")
      .slice(0, 300);
  }

  drainLlmUsage();
  const t0 = Date.now();
  const segs: Seg[] = [];
  await runStartTeaching({
    ctx,
    emit: async (e: any) => {
      if (e.type !== "beats") return;
      const says: string[] = (e.beats || []).map((b: any) => String(b.say || ""));
      const items = (e.beats || []).flatMap((b: any) => b.items || []);
      segs.push({
        index: e.index ?? segs.length,
        title: String(e.title || ""),
        says,
        items: items.length,
        itemKinds: items.map((i: any) => String(i.kind)),
      });
    },
  });

  const allSays = segs.flatMap((s) => s.says);
  const sentences = allSays.flatMap(splitSentences);
  const totalChars = allSays.join("").length;
  const avgLen = sentences.length ? totalChars / sentences.length : 0;
  const longSent = sentences.filter((s) => s.length > 45).length;
  const restateSegs = segs.filter((s) => s.says.some((x) => RESTATE_MARKS.some((m) => x.includes(m)))).length;

  // 术语首现是否被解释：整篇按顺序走，术语第一次出现时看当句+下一句有无解释标记
  const seq: string[] = [];
  for (const s of segs) for (const say of s.says) seq.push(...splitSentences(say));
  const seen = new Set<string>();
  let firstUseTotal = 0;
  let firstUseExplained = 0;
  const unexplained: string[] = [];
  for (let i = 0; i < seq.length; i++) {
    const sent = seq[i];
    TERM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TERM_RE.exec(sent))) {
      const term = (m[1] || m[0]).trim();
      if (seen.has(term)) continue;
      seen.add(term);
      firstUseTotal++;
      const window = sent + " " + (seq[i + 1] || "");
      if (EXPLAIN_MARKS.some((k) => window.includes(k))) firstUseExplained++;
      else unexplained.push(term);
    }
  }

  const itemKindsAll = segs.flatMap((s) => s.itemKinds);
  const textOnly = itemKindsAll.filter((k) => k === "bullet" || k === "note").length;
  const u = drainLlmUsage();
  const minutes = totalChars / 250;

  console.log(`\n=== 可理解度报告：${ctx.lectureTitle}（${path.basename(file)}）===`);
  console.log(`片段数 ${segs.length} · 讲稿 ${totalChars} 字 · 估算时长 ${minutes.toFixed(1)} 分钟（目标 7-10）`);
  console.log(`句数 ${sentences.length} · 平均句长 ${avgLen.toFixed(1)} 字/句（目标 ≤40）`);
  console.log(`超长句(>45字) ${longSent} 句 = ${((longSent / Math.max(1, sentences.length)) * 100).toFixed(0)}%（目标 <10%）`);
  console.log(`复述段 ${restateSegs}/${segs.length} = ${((restateSegs / Math.max(1, segs.length)) * 100).toFixed(0)}%（目标 ≥50%）`);
  console.log(`术语首现 ${firstUseTotal} 个 · 已解释 ${firstUseExplained} = ${((firstUseExplained / Math.max(1, firstUseTotal)) * 100).toFixed(0)}%（目标 ≥80%）`);
  if (unexplained.length) console.log(`  未解释术语（前12）：${unexplained.slice(0, 12).join("、")}`);
  console.log(`板书 ${itemKindsAll.length} 条 · 纯文字占比 ${((textOnly / Math.max(1, itemKindsAll.length)) * 100).toFixed(0)}%（目标 ≤50%）`);
  console.log(`每段：${segs.map((s) => `${s.says.length}句/${s.items}条`).join("  ")}`);
  console.log(`LLM ${u.calls} 次（${u.promptTokens} in / ${u.completionTokens} out）· 用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`\n--- 讲稿逐句（人工体感核对）---`);
  for (const s of segs) {
    console.log(`\n[${s.index + 1}] ${s.title}`);
    for (const say of s.says) console.log(`   ${say}  〔${say.length}字〕`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
