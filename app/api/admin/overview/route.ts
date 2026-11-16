// GET /api/admin/overview —— 运营总览（用户/课程/今日用量/近期错误）
// 最小运营面之一：不做后台系统， founders 用浏览器直接看这三个接口就够（见上线评审结论）。
import { NextResponse } from "next/server";
import { isAdminUser, userFromCookieHeader } from "@/lib/auth";
import { listKeys, readJson, storageMode } from "@/lib/storage";
import { recentOpsErrors, todayUsageTotals } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!isAdminUser(me?.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [usersDb, usage, errors, courseItems] = await Promise.all([
    readJson<{ users: { id: string; email: string; createdAt: number }[] }>("users.json", { users: [] }),
    todayUsageTotals(),
    recentOpsErrors(20),
    listKeys("courses/").catch(() => []),
  ]);
  const reports = await readJson<{ reports: unknown[] }>("market-reports.json", { reports: [] });

  return NextResponse.json({
    storageMode,
    users: {
      total: usersDb.users.length,
      latest: usersDb.users
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map((u) => ({ email: u.email, createdAt: u.createdAt })),
    },
    courses: { total: courseItems.length },
    todayUsage: usage,
    marketReports: reports.reports.length,
    recentErrors: errors,
  });
}
