// 课程回放：保存/读取「整节课的 beat 剧本」，支撑 Manus Replay 式的只读回放链接。
// 剧本只有讲解词 + 板书动作（几十 KB 级），回放页用它现场重建白板，不存元素快照。
import { NextResponse } from "next/server";
import { readJson, writeJson } from "@/lib/storage";
import type { ReplayReel, BoardItem } from "@/types";

export const runtime = "nodejs";

const REPLAY_PREFIX = "replays/";

function safeId(s: string): string {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
}

function clampStr(v: unknown, n: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "";
}

function sanitizeItems(items: unknown): BoardItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it === "object" && typeof it.kind === "string")
    .slice(0, 4)
    .map((it: any) => ({
      kind: it.kind,
      text: clampStr(it.text, 40) || undefined,
      headers: Array.isArray(it.headers) ? it.headers.slice(0, 3).map((h: unknown) => clampStr(h, 8)) : undefined,
      rows: Array.isArray(it.rows) ? it.rows.slice(0, 4).map((r: unknown) => (Array.isArray(r) ? r.slice(0, 3).map((c: unknown) => clampStr(c, 8)) : [])) : undefined,
      nodes: Array.isArray(it.nodes) ? it.nodes.slice(0, 4).map((n: unknown) => clampStr(n, 6)) : undefined,
    }));
}

/** 保存回放剧本 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.beats) || body.beats.length === 0 || !clampStr(body.lectureTitle, 80)) {
    return NextResponse.json({ error: "invalid_reel" }, { status: 400 });
  }
  const id = `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const reel: ReplayReel = {
    id,
    courseId: safeId(body.courseId),
    unitId: safeId(body.unitId),
    lectureId: safeId(body.lectureId),
    courseTitle: clampStr(body.courseTitle, 80),
    lectureTitle: clampStr(body.lectureTitle, 80),
    createdAt: Date.now(),
    beats: body.beats.slice(0, 240).map((b: any) => ({
      say: clampStr(b?.say, 600),
      section: clampStr(b?.section, 8) || undefined,
      items: sanitizeItems(b?.items),
      segmentTitle: clampStr(b?.segmentTitle, 24) || "讲解",
    })).filter((b: { say: string }) => Boolean(b.say)),
  };
  if (reel.beats.length === 0) {
    return NextResponse.json({ error: "empty_beats" }, { status: 400 });
  }
  await writeJson(`${REPLAY_PREFIX}${id}.json`, reel);
  return NextResponse.json({ id });
}

/** 读取回放剧本：/api/replay?id=rp-xxx */
export async function GET(req: Request) {
  const id = safeId(new URL(req.url).searchParams.get("id") || "");
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  const reel = await readJson<ReplayReel | null>(`${REPLAY_PREFIX}${id}.json`, null);
  if (!reel) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ reel });
}
