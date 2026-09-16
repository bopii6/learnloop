// 讲稿「看得进去」测量：对一份已落盘的讲稿缓存（events JSON）算参与度指标。
// 与 measure-comprehension.ts（可理解度）互补：那边量"听不听得懂"，这边量"想不想听下去"。
//
// 用法：npx tsx eval/measure-engagement.ts data/teach-scripts/<file>.json [--full]
//
// 指标口径：
//   讲内重复   —— 片段两两 8 字 n-gram 重叠率（按较短段计）。>5% 的段对逐对列出。
//                 换措辞的复述抓不到，只抓逐字重复；配合人工看逐句。
//   口头禅     —— "换句话说/说白了/大部分人以为/就这句"全讲次数（每讲合计目标 ≤3）。
//   段首同腔   —— 以"这一节/上一节/这节课"开头的段数（目标 ≤2/段数）。
//   钩子       —— 第 1 段第 1 拍是否含"？"或数字（具体钩子的粗信号）。
//   预测题     —— checkpoint 数与所在片段（理想：揭晓段之前，1-2 个）。
import { readFileSync } from "fs";
import path from "path";

interface BeatLike {
  say?: string;
  items?: unknown[];
}
interface BeatsEvent {
  type: string;
  title?: string;
  index?: number;
  beats?: BeatLike[];
  checkpoint?: { question?: string; options?: string[] };
}

function ngrams(s: string, n: number): Set<string> {
  const g = new Set<string>();
  for (let i = 0; i <= s.length - n; i++) g.add(s.slice(i, i + n));
  return g;
}

function main() {
  const file = process.argv[2];
  const full = process.argv.includes("--full");
  if (!file) {
    console.error("用法：npx tsx eval/measure-engagement.ts <teach-script.json> [--full]");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  const events: BeatsEvent[] = data.events || [];
  const segs = events
    .filter((e) => e.type === "beats")
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((e) => ({
      title: String(e.title || ""),
      says: (e.beats || []).map((b) => String(b.say || "").replace(/\s+/g, "")),
      checkpoint: e.checkpoint?.question ? String(e.checkpoint.question) : "",
    }));

  const allSays = segs.flatMap((s) => s.says);
  const totalChars = allSays.join("").length;

  // 讲内重复：段两两 8-gram
  let pairs = 0;
  let overlapSum = 0;
  let maxOverlap = 0;
  const hotPairs: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = ngrams(segs[i].says.join(""), 8);
      const b = ngrams(segs[j].says.join(""), 8);
      if (a.size === 0 || b.size === 0) continue;
      let inter = 0;
      a.forEach((x) => {
        if (b.has(x)) inter++;
      });
      const r = inter / Math.min(a.size, b.size);
      pairs++;
      overlapSum += r;
      if (r > maxOverlap) maxOverlap = r;
      if (r > 0.05) hotPairs.push(`「${segs[i].title}」×「${segs[j].title}」 ${(r * 100).toFixed(0)}%`);
    }
  }

  // 口头禅
  const tics = ["换句话说", "说白了", "大部分人以为", "就这句"];
  const ticCounts = tics.map((t) => ({ t, n: allSays.join("|").split(t).length - 1 }));

  // 段首同腔
  const openers = ["这一节", "上一节", "这节课", "这一小节", "接下来我们"];
  const sameOpening = segs.filter((s) => s.says[0] && openers.some((o) => s.says[0].startsWith(o))).length;

  // 钩子：前两拍内出现问句或数字（开场就抛具体问题/场景）
  const openingTwo = (segs[0]?.says[0] || "") + (segs[0]?.says[1] || "");
  const hasHook = /[？?]/.test(openingTwo) || /[0-9０-９]/.test(openingTwo);

  console.log(`\n=== 看得进去报告：${path.basename(file)} ===`);
  console.log(`片段数 ${segs.length} · 讲稿 ${totalChars} 字 · 估算时长 ${(totalChars / 250).toFixed(1)} 分钟（目标 7-10）`);
  console.log(
    `讲内重复（段两两 8 字重叠）：平均 ${((overlapSum / Math.max(1, pairs)) * 100).toFixed(1)}% · 最大 ${(
      maxOverlap * 100
    ).toFixed(0)}%（目标：最大 <5%）`
  );
  if (hotPairs.length) console.log(`  重叠段对：\n  - ${hotPairs.join("\n  - ")}`);
  console.log(
    `口头禅：${ticCounts.map((x) => `「${x.t}」${x.n}`).join(" · ")}（合计 ${ticCounts.reduce((s, x) => s + x.n, 0)} 次，目标 ≤3）`
  );
  console.log(`段首同腔：${sameOpening}/${segs.length} 段以"这一节/上一节/这节课"开头（目标 ≤2）`);
  console.log(`开场钩子：${hasHook ? "有（第一拍含问句或数字）" : "无——第一拍是平铺直叙"}`);
  const cps = segs.map((s, i) => (s.checkpoint ? `第 ${i + 1} 段后：${s.checkpoint}` : "")).filter(Boolean);
  console.log(`弹题 ${cps.length} 个：\n  ${cps.join("\n  ") || "（无）"}`);
  console.log(`每段拍数：${segs.map((s) => s.says.length).join(" / ")}`);
  if (full) {
    for (const s of segs) {
      console.log(`\n[${s.title}]${s.checkpoint ? `  ⟨弹题：${s.checkpoint}⟩` : ""}`);
      for (const say of s.says) console.log(`   ${say}`);
    }
  }
}

main();
