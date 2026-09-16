// 回填存量课的结课作品（capstone）：老课生成时 blueprint 还没有 capstone 结构，
// 导致课程页「结课作品 —」、学习路径条没有终点、集市卡没有交付行。
// 逐门用 LLM 按课程内容生成匹配的 capstone（对齐末单元的结课实操课），写回
// outline.capstone 与 blueprint.capstone 两处（课堂的作品注入读后者）。
// 用法：npx tsx scripts/backfill-capstone.mts   （幂等：已有 capstone 的课跳过）
import { readFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

interface Capstone {
  name: string;
  description: string;
  criteria: string[];
}

async function main() {
  const { getCourseState, setCourseState } = await import("../lib/agent/course.ts");
  const { generateJson } = await import("../lib/agent/llm.ts");
  const { listKeys } = await import("../lib/storage.ts");

  const keys = await listKeys("courses/");
  const ids = keys.map((k: any) => String(k?.key ?? k).split("/").pop()!.replace(/\.json$/, "")).filter(Boolean);
  let filled = 0;
  let skipped = 0;

  for (const id of ids) {
    const state = await getCourseState(id);
    const outline = state?.outline as
      | { capstone?: Capstone; units?: { title: string; lectures?: { title: string; content_type?: string }[] }[] }
      | undefined;
    if (!outline?.units?.length) continue;
    if (outline.capstone?.name) {
      skipped++;
      continue;
    }
    const units = outline.units;
    const lastUnit = units[units.length - 1];
    const projectLec = lastUnit?.lectures?.[lastUnit.lectures.length - 1];
    const unitLines = units.map((u, i) => `单元${i + 1} ${u.title}`).join("\n");

    let cap: Capstone | null | undefined;
    try {
      cap = await generateJson<Capstone>(`你是课程设计师。为一门已经存在的课补写"结课作品"定义：学员学完这门课，亲手做出一个可以展示给他人的东西。只输出 JSON：
{"name":"作品名（≤16字）","description":"一句话说明学员交出的是什么、长什么样（≤80字）","criteria":["可逐条验收的标准1","标准2","标准3"]}

规则：
- 作品必须恰好是这门课教的那些能力的综合产出——从单元结构里长出来，不是外加的泛化项目。
- 难度与课时匹配：这是 ${units.length} 个单元的课程，作品要一个人在几天内能做完。
- criteria 3 条，每条是一个 outsiders 能亲眼验证的证据（"报告包含…""应用支持…"），禁止"掌握了""理解了"这类状态词。
${projectLec?.title ? `- 全课最后一节是结课实操课《${projectLec.title}》，作品要与它对齐。` : ""}
- 使用与课程相同的语言。`,
        `课程：《${state?.title || ""}》
受众：${outline.audience || "未注明"}
单元结构：
${unitLines}
请生成结课作品定义。`,
        700
      );
    } catch (e) {
      console.log(`✗ ${id} 生成异常：${e instanceof Error ? e.message.slice(0, 120) : e}`);
      continue;
    }

    if (!cap?.name || !Array.isArray(cap.criteria) || cap.criteria.length === 0) {
      console.log(`✗ ${id} ${state?.title} 生成失败，跳过`);
      continue;
    }
    const clean: Capstone = {
      name: String(cap.name).slice(0, 24),
      description: String(cap.description || "").slice(0, 140),
      criteria: cap.criteria.map((c) => String(c).slice(0, 80)).filter(Boolean).slice(0, 4),
    };
    outline.capstone = clean;
    const st = state as { blueprint?: unknown };
    // 老课的 blueprint 可能是字符串（mermaid 思维导图等旧格式），只在对象上回写
    if (st.blueprint && typeof st.blueprint === "object") {
      (st.blueprint as { capstone?: Capstone }).capstone = clean;
    }
    await setCourseState(id, state as any);
    filled++;
    console.log(`✓ ${id}《${state?.title}》→ ${clean.name}`);
  }
  console.log(`\n回填 ${filled} 门，跳过（已有）${skipped} 门`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
