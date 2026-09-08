// 学习战报统计：聚合数据（课程/会话/课堂/画像）算出 Wrapped 式战报指标。
// 单机自用产品，直接聚合全部数据即可；已按用户场景做了并行读，课程走小索引。
import { NextResponse } from "next/server";
import { listKeys, readJson } from "@/lib/storage";

export const runtime = "nodejs";

const safeList = (prefix: string) => listKeys(prefix).catch(() => []);
const baseName = (key: string) => key.split("/").pop()!.replace(/\.json$/, "");

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseMs(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export async function GET() {
  const daySet = new Set<string>();
  let boardChars = 0;
  let spokenChars = 0;
  let lecturesTouched = 0;

  // ---- 课程 ----
  // course-meta/ 小索引为主；旧课程没索引才并行回读课程全文档。
  const [courseKeys, metaKeys] = await Promise.all([safeList("courses/"), safeList("course-meta/")]);
  const metaById = new Map<string, any>();
  await Promise.all(
    metaKeys
      .filter((k) => k.key.endsWith(".json"))
      .map(async (k) => {
        try {
          const m = await readJson<any>(k.key, null);
          if (m?.title) metaById.set(baseName(k.key), m);
        } catch {
          // 坏索引忽略，走回读
        }
      })
  );
  const courses: { title: string; tags: string[]; createdAt: number; lectures: number; minutes: number }[] = [];
  await Promise.all(
    courseKeys.map(async (k) => {
      const id = baseName(k.key);
      const m = metaById.get(id);
      if (m) {
        courses.push({
          title: String(m.title).slice(0, 40),
          tags: (Array.isArray(m.tags) ? m.tags : []).map(String).slice(0, 8),
          createdAt: Number(m.updatedAt) || k.lastModified || 0,
          lectures: Number(m.lectures) || 0,
          minutes: Number(m.totalMin) || 0,
        });
        return;
      }
      const c = await readJson<any>(k.key, null);
      if (!c?.outline) return; // 半途废弃（无大纲）的课程不算进战报，与课程记录口径一致
      const outline = c.outline || {};
      const units: any[] = Array.isArray(outline.units) ? outline.units : [];
      const lectures = units.reduce((s: number, u) => s + (Array.isArray(u?.lectures) ? u.lectures.length : 0), 0);
      const minutes = units.reduce(
        (s: number, u) => s + (Array.isArray(u?.lectures) ? u.lectures.reduce((t: number, l: any) => t + (Number(l?.duration_min) || 0), 0) : 0),
        0
      );
      const concepts = units.flatMap((u) => (Array.isArray(u?.key_concepts) ? u.key_concepts : [])).map((x) => String(x).slice(0, 12));
      courses.push({
        title: String(c.title || "未命名课程").slice(0, 40),
        tags: (Array.isArray(outline.tags) && outline.tags.length ? outline.tags : concepts).map((t: unknown) => String(t)).slice(0, 8),
        createdAt: parseMs(c.createdAt) || (k.lastModified ?? 0),
        lectures,
        minutes,
      });
    })
  );

  // ---- 会话 ----
  const convKeys = await safeList("conversations/");
  let convCount = 0;
  await Promise.all(
    convKeys.map(async (k) => {
      const c = await readJson<any>(k.key, null);
      if (!c) return;
      convCount += 1;
      const ms = parseMs(c.updatedAt) || parseMs(c.createdAt);
      if (ms > 0) daySet.add(dayOf(ms));
    })
  );

  // ---- 课堂（白板字数 + 讲解字数 + 上过的课节） ----
  const roomKeys = await safeList("classrooms/");
  await Promise.all(
    roomKeys.map(async (k) => {
      const r = await readJson<any>(k.key, null);
      if (!r) return;
      const elements: any[] = Array.isArray(r.elements) ? r.elements : [];
      for (const el of elements) {
        if (el?.type === "text" && typeof el.text === "string") boardChars += el.text.replace(/\s/g, "").length;
      }
      const script: any[] = Array.isArray(r.script) ? r.script : [];
      for (const seg of script) {
        for (const b of Array.isArray(seg?.beats) ? seg.beats : []) {
          if (typeof b?.say === "string") spokenChars += b.say.replace(/\s/g, "").length;
        }
      }
      if ((Number(r.cursor) || 0) > 0) lecturesTouched += 1;
      const ms = parseMs(r.updated_at);
      if (ms > 0) daySet.add(dayOf(ms));
    })
  );

  // ---- 课程创建日也计入活跃日 ----
  for (const c of courses) if (c.createdAt > 0) daySet.add(dayOf(c.createdAt));

  // ---- 画像（profiles/{userId}.json，取事实最多的一份；无则是新 learner） ----
  let name = "";
  let facts = 0;
  const profileKeys = await safeList("profiles/");
  await Promise.all(
    profileKeys.map(async (k) => {
      const p = await readJson<any>(k.key, null);
      if (!p) return;
      const pFacts = Array.isArray(p.facts) ? p.facts.length : 0;
      if (!name && typeof p.name === "string" && p.name) name = p.name;
      if (pFacts > facts) facts = pFacts;
    })
  );

  // ---- 连续学习天数（今天或昨天为终点向回数） ----
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 3600 * 1000;
  let streak = 0;
  let cursorDay = daySet.has(dayOf(today.getTime())) ? today.getTime() : today.getTime() - dayMs;
  if (daySet.has(dayOf(cursorDay))) {
    while (daySet.has(dayOf(cursorDay))) {
      streak += 1;
      cursorDay -= dayMs;
    }
  }

  // ---- 最近 14 天活跃 ----
  const recentDays: { date: string; active: boolean }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = dayOf(today.getTime() - i * dayMs);
    recentDays.push({ date: d, active: daySet.has(d) });
  }

  // ---- 标签 Top ----
  const tagCount = new Map<string, number>();
  for (const c of courses) {
    for (const t of c.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const topTags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag, count]) => ({ tag, count }));

  const totalMinutes = courses.reduce((s, c) => s + c.minutes, 0);
  const totalLectures = courses.reduce((s, c) => s + c.lectures, 0);
  const topCourses = [...courses].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3).map((c) => ({ title: c.title, lectures: c.lectures }));

  return NextResponse.json({
    name,
    facts,
    coursesCount: courses.length,
    lecturesCount: totalLectures,
    lecturesTouched,
    totalMinutes,
    convCount,
    boardChars,
    spokenChars,
    streak,
    activeDays: daySet.size,
    recentDays,
    topTags,
    topCourses,
    generatedAt: Date.now(),
  });
}
