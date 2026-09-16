// 课程集市：上架课程的登记表
// GET 列出（公开条目全网可见 + 自己的未公开条目）/ POST 上架（=公开发布） / DELETE ?courseId= 下架
// 登记表经存储抽象层持久化（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）
import { NextRequest, NextResponse } from "next/server";
import type { MarketCollection, MarketEntry } from "@/types";
import { isAdminUser, userFromCookieHeader } from "@/lib/auth";
import { getCourseState, metaKey, type CourseMeta } from "@/lib/agent/course";
import { listKeys, readJson, writeJson, storageMode } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MARKET_KEY = "marketplace.json";
const COLLECTIONS_KEY = "market-collections.json";

interface OwnedEntry extends MarketEntry {
  ownerId?: string;
}

async function readMarket(): Promise<OwnedEntry[]> {
  return readJson<{ entries: OwnedEntry[] }>(MARKET_KEY, { entries: [] }).then((j) => j.entries);
}

async function writeMarket(entries: OwnedEntry[]): Promise<void> {
  await writeJson(MARKET_KEY, { entries }, { pretty: true });
}

export async function GET(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const entries = await readMarket();
  // 可见性：无主条目（官方/历史数据）与 isPublic 条目所有人可见；
  // 有主且未标记 isPublic 的旧条目维持原行为（仅主人可见），不把存量私货突然公开
  const visible = entries.filter(
    (e) => !e.ownerId || e.isPublic === true || (me && e.ownerId === me.id)
  );
  visible.sort((a, b) => b.addedAt - a.addedAt);

  // 我的进度：扫课堂快照（与 /api/courses 同口径）。快照名 = courseId+unitId+lecId，
  // 本地模式快照在 data/classrooms/，R2 模式也是本地写——两路并一份再归课。
  const visitedByCourse = new Map<string, Set<string>>();
  try {
    const roomItems = await listKeys("classrooms/").catch(() => []);
    let localKeys: string[] = [];
    try {
      const { promises: fs } = await import("fs");
      const path = await import("path");
      const dir = path.join(process.cwd(), "data", "classrooms");
      localKeys = (await fs.readdir(dir)).map((n) => `classrooms/${n}`);
    } catch {
      // 本地目录不存在（R2 部署）时忽略
    }
    for (const key of [...roomItems.map((i) => i.key), ...localKeys]) {
      const name = key.split("/").pop()!.replace(/\.json$/, "");
      const unitIdx = name.indexOf("unit-");
      const lecIdx = name.indexOf("lec-");
      if (unitIdx <= 0 || lecIdx <= unitIdx) continue;
      const courseId = name.slice(0, unitIdx);
      const lectureId = name.slice(lecIdx);
      if (!visitedByCourse.has(courseId)) visitedByCourse.set(courseId, new Set());
      visitedByCourse.get(courseId)!.add(lectureId);
    }
  } catch {
    // 快照不可用时进度为空，货架照常
  }

  // 从 course-meta 小索引并行带出课程规模（集市卡徽标用；索引缺失就静默省略），
  // 再回读课程文件补两样货架上的"硬货"：体系目录（syllabus）与交付承诺（capstone）
  const enriched = await Promise.all(
    visible.map(async (e) => {
      let meta: CourseMeta | null = null;
      try {
        meta = await readJson<CourseMeta | null>(metaKey(e.courseId), null);
      } catch {
        meta = null;
      }
      let syllabus: { title: string; lecs: number }[] | undefined;
      let capstone: string | null | undefined;
      try {
        const st = await getCourseState(e.courseId);
        const units = st?.outline?.units;
        if (st && Array.isArray(units)) {
          syllabus = units.map((u) => ({ title: String(u.title || ""), lecs: u.lectures?.length || 0 }));
          const cap = (st.outline as { capstone?: { name?: string } } | undefined)?.capstone;
          capstone = cap?.name || null;
        }
      } catch {
        // 课程文件读不到时目录留空，卡片照常
      }
      const total = meta?.lecs?.length || 0;
      const visitedSet = visitedByCourse.get(e.courseId);
      const visited = visitedSet ? meta?.lecs?.filter((l) => visitedSet.has(l.id)).length || 0 : 0;
      return {
        ...e,
        canDelete:
          Boolean(me && e.ownerId === me.id) ||
          (!e.ownerId && (storageMode !== "r2" || isAdminUser(me?.email))),
        audience: meta?.audience,
        tags: meta?.tags,
        units: meta?.units,
        // 课节数口径与课程记录页一致：只数可学的白板课节（lecs），不含测验/项目
        lectures: meta?.lecs?.length || meta?.lectures,
        totalMin: meta?.totalMin,
        syllabus,
        capstone,
        myProgress: total > 0 && visited > 0 ? { visited, total } : null,
      };
    })
  );

  // 学习路线合集：编辑部排好的顺序，前端按它组织货架
  const collections = await readJson<{ collections: MarketCollection[] } | null>(COLLECTIONS_KEY, null);

  return NextResponse.json({ entries: enriched, collections: collections?.collections || [] });
}

export async function POST(req: NextRequest) {
  let body: { courseId?: string; price?: number; note?: string; author?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const courseId = (body.courseId || "").trim();
  if (!courseId) return NextResponse.json({ error: "courseId required" }, { status: 400 });

  const me = await userFromCookieHeader(req.headers.get("cookie"));
  // 上架是公开发布动作：公网部署必须登录（防匿名刷登记表）；本地自用放行
  if (!me && storageMode === "r2") {
    return NextResponse.json({ error: "请先登录后再上架课程" }, { status: 401 });
  }

  // 课程必须真实存在，标题以课程文件为准（防伪造）
  const state = await getCourseState(courseId);
  if (!state?.outline) {
    return NextResponse.json({ error: "course not found" }, { status: 404 });
  }
  const title = state.title || state.outline.title || "";
  const courseOwner = state.ownerId;

  if (courseOwner && (!me || me.id !== courseOwner)) {
    return NextResponse.json({ error: "只能上架自己的课程" }, { status: 403 });
  }
  // 无主课程（历史数据）在公网只有管理员能（重新）上架，防止任何人认领官方课
  if (!courseOwner && storageMode === "r2" && !isAdminUser(me?.email)) {
    return NextResponse.json({ error: "无主课程仅管理员可上架" }, { status: 403 });
  }

  const entries = await readMarket();
  const existing = entries.find((e) => e.courseId === courseId);
  // 「官方精选」是平台背书：只有管理员能标；已有的官方徽章重新上架时不丢
  const author =
    body.author === "official" && isAdminUser(me?.email)
      ? "official"
      : existing?.author === "official"
        ? "official"
        : "self";
  const entry: OwnedEntry = {
    courseId,
    title,
    author,
    price: typeof body.price === "number" && body.price > 0 ? Math.round(body.price) : 0,
    note: (body.note || existing?.note || "").slice(0, 80) || undefined,
    addedAt: existing?.addedAt || Date.now(),
    ownerId: courseOwner || me?.id,
    isPublic: true, // 上架 = 公开发布
  };
  const next = entries.filter((e) => e.courseId !== courseId).concat(entry);
  await writeMarket(next);
  return NextResponse.json({ entry });
}

export async function DELETE(req: NextRequest) {
  const courseId = req.nextUrl.searchParams.get("courseId") || "";
  if (!courseId) return NextResponse.json({ error: "courseId required" }, { status: 400 });
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const entries = await readMarket();
  const target = entries.find((e) => e.courseId === courseId);
  if (target?.ownerId) {
    // 有主条目只有主人能下架
    if (!me || target.ownerId !== me.id) {
      return NextResponse.json({ error: "没有权限下架" }, { status: 403 });
    }
  } else if (storageMode === "r2" && !isAdminUser(me?.email)) {
    // 无主条目（官方/历史数据）在公网只有管理员能下架；本地自用不受限
    return NextResponse.json({ error: "没有权限下架" }, { status: 403 });
  }
  await writeMarket(entries.filter((e) => e.courseId !== courseId));
  return NextResponse.json({ ok: true });
}
