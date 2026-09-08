// POST /api/market/report —— 举报集市课程 { courseId, reason }
// UGC 平台免责的基础设施：有举报入口 + 有处理留痕。管理员在 /api/admin/overview 里看总量，
// 处理完走集市的 DELETE 下架，再把对应条目标记 resolved。
import { NextRequest, NextResponse } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";
import { readJsonStrict, writeJson } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORTS_KEY = "market-reports.json";

interface ReportEntry {
  at: number;
  courseId: string;
  userId: string;
  email: string;
  reason: string;
  resolved: boolean;
}

export async function POST(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!me) return NextResponse.json({ error: "请先登录后再举报" }, { status: 401 });

  let body: { courseId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const courseId = (body.courseId || "").trim();
  const reason = (body.reason || "").trim().slice(0, 200);
  if (!courseId) return NextResponse.json({ error: "courseId required" }, { status: 400 });
  if (reason.length < 2) return NextResponse.json({ error: "请简单说明举报原因（10 字以上更好处理）" }, { status: 400 });

  // 严格读：登记文件损坏时拒写，防止整份举报记录被空文件覆盖
  const db = await readJsonStrict<{ reports: ReportEntry[] }>(REPORTS_KEY).catch(() => ({ reports: [] as ReportEntry[] }));
  if (db.reports.some((r) => r.courseId === courseId && r.userId === me.id && !r.resolved)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  db.reports.push({ at: Date.now(), courseId, userId: me.id, email: me.email, reason, resolved: false });
  if (db.reports.length > 1000) db.reports = db.reports.slice(-1000);
  await writeJson(REPORTS_KEY, db);
  return NextResponse.json({ ok: true });
}
