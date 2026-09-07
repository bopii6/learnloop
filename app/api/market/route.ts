// 课程集市：官方精选与用户上架课程的登记表
// GET 列出（按登录态过滤归属） / POST 上架（可标价，记录归属） / DELETE ?courseId= 下架
// 登记表经存储抽象层持久化（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）
import { NextRequest, NextResponse } from "next/server";
import type { MarketEntry } from "@/types";
import { userFromCookieHeader } from "@/lib/auth";
import { getCourseState } from "@/lib/agent/course";
import { readJson, writeJson } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MARKET_KEY = "marketplace.json";

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
  // 上架者的私有库存对未登录/他人隐藏；无主条目（官方/历史数据）所有人可见
  const visible = entries.filter((e) => !e.ownerId || (me && e.ownerId === me.id));
  visible.sort((a, b) => b.addedAt - a.addedAt);
  return NextResponse.json({ entries: visible });
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

  // 课程必须真实存在，标题以课程文件为准（防伪造）
  const state = await getCourseState(courseId);
  if (!state?.outline) {
    return NextResponse.json({ error: "course not found" }, { status: 404 });
  }
  const title = state.title || state.outline.title || "";
  const courseOwner = state.ownerId;

  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (courseOwner && (!me || me.id !== courseOwner)) {
    return NextResponse.json({ error: "只能上架自己的课程" }, { status: 403 });
  }

  const entries = await readMarket();
  const existing = entries.find((e) => e.courseId === courseId);
  const entry: OwnedEntry = {
    courseId,
    title,
    author: body.author === "official" ? "official" : existing?.author || "self",
    price: typeof body.price === "number" && body.price > 0 ? Math.round(body.price) : 0,
    note: (body.note || existing?.note || "").slice(0, 80) || undefined,
    addedAt: existing?.addedAt || Date.now(),
    ownerId: courseOwner || me?.id,
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
  // 有主条目只有主人能下架
  if (target?.ownerId && (!me || target.ownerId !== me.id)) {
    return NextResponse.json({ error: "没有权限下架" }, { status: 403 });
  }
  await writeMarket(entries.filter((e) => e.courseId !== courseId));
  return NextResponse.json({ ok: true });
}
