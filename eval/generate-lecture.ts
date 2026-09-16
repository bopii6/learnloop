// 生成一节课的讲稿事件流，与 /api/teach 的 start_teaching 完全同构
// （同 ctx 组装：教材页 grounding / 前情 / 画像 / 结课作品），但不走积分。
// 用途：验证导演层改造、以及把新版讲稿写进用户缓存做免费升级。
//
// 用法：npx tsx eval/generate-lecture.ts <data/courses/course-xxx.json> <unitId> <lectureId> [userId]
//   给了 userId 就把结果按讲稿缓存格式落盘（该用户下次进课堂直接回放新版，不扣积分）。
//   生成的原始事件流同时存一份到 data/teach-scripts/_measure_latest_<lectureId>.json 供测量。
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const safeId = (s: string) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "");

async function main() {
  const { runStartTeaching, buildLectureContext } = await import("../lib/agent/teach");
  const { pagesForLecture } = await import("../lib/textbook");
  const { getProfile } = await import("../lib/profile");
  const { drainLlmUsage } = await import("../lib/agent/llm");

  const courseFile = process.argv[2];
  const unitId = process.argv[3];
  const lectureId = process.argv[4];
  const userId = process.argv[5];
  if (!courseFile || !unitId || !lectureId) {
    console.error("用法：npx tsx eval/generate-lecture.ts <course.json> <unitId> <lectureId> [userId]");
    process.exit(1);
  }
  const courseId = path.basename(courseFile).replace(/\.json$/, "");
  const state = JSON.parse(readFileSync(path.join(__dirname, "..", courseFile), "utf8"));
  const ctx = buildLectureContext(state.outline, unitId, lectureId);
  if (!ctx) throw new Error("lecture not found");

  // ——以下与 app/api/teach/route.ts 的 ctx 组装保持同构——
  const capstone = state.outline?.capstone || state.blueprint?.capstone;
  if (capstone?.name) {
    const clarifyHit = (state.clarifyAnswers || []).find((a: any) => /亲手做出|结课作品/.test(a.question || ""));
    ctx.capstoneGoal = [clarifyHit?.answer && clarifyHit.answer !== capstone.name ? clarifyHit.answer : capstone.name, capstone.description]
      .filter(Boolean)
      .join("——")
      .slice(0, 300);
  }
  let grounded = false;
  if (state.textbook?.pages?.length) {
    const totalLectures = state.outline.units.reduce((s: number, u: any) => s + u.lectures.length, 0);
    let lectureIdx = 0;
    for (const u of state.outline.units) {
      const j = u.lectures.findIndex((l: any) => l.id === lectureId);
      if (j >= 0) {
        lectureIdx += j;
        break;
      }
      lectureIdx += u.lectures.length;
    }
    const relPages = pagesForLecture(state.textbook, ctx.lectureTitle, [...(ctx.keyConcepts || []), ctx.lectureSummary], lectureIdx, totalLectures, 3);
    if (relPages.length > 0) {
      ctx.referenceMaterial = relPages.map((p: any) => `【教材《${state.textbook!.title}》第 ${p.page} 页】\n${p.text.slice(0, 1200)}`).join("\n\n");
      grounded = true;
      console.log(`grounding：教材第 ${relPages.map((p: any) => p.page).join("、")} 页`);
    }
  }
  if (!grounded && state.sources?.length && state.pageContents) {
    const blocks: string[] = [];
    for (const s of state.sources) {
      const text = state.pageContents[String(s.index)];
      if (!text) continue;
      blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1500)}`);
      if (blocks.length >= 4) break;
    }
    if (blocks.length > 0) ctx.referenceMaterial = blocks.join("\n\n");
  }
  const teachUnit = state.outline.units.find((u: any) => u.id === unitId);
  if (teachUnit?.key_concepts?.length) ctx.keyConcepts = teachUnit.key_concepts;
  if (userId) {
    const profile = await getProfile(userId);
    if (profile.summary) ctx.profileHint = profile.summary;
    if (profile.name) ctx.studentName = profile.name;
    console.log(`学员：${profile.name || "（无名）"}`);
  }

  drainLlmUsage();
  const t0 = Date.now();
  const events: unknown[] = [];
  await runStartTeaching({ ctx, emit: async (e) => void events.push(e) });
  const u = drainLlmUsage();

  const stamp = path.join(__dirname, "..", "data", "teach-scripts", `_measure_latest_${safeId(lectureId)}.json`);
  writeFileSync(stamp, JSON.stringify({ events, generatedAt: Date.now() }, null, 2));
  console.log(`\n事件流已存：${path.relative(process.cwd(), stamp)}（LLM ${u.calls} 次 · 用时 ${Math.round((Date.now() - t0) / 1000)}s）`);
  if (userId) {
    const cacheFile = path.join(
      __dirname,
      "..",
      "data",
      "teach-scripts",
      `${safeId(userId)}_${safeId(courseId)}_${safeId(unitId)}_${safeId(lectureId)}.json`
    );
    writeFileSync(cacheFile, JSON.stringify({ events, generatedAt: Date.now() }, null, 2));
    console.log(`讲稿缓存已升级：${path.relative(process.cwd(), cacheFile)}（该用户下次进课堂回放新版，不扣积分）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
