// GET /api/auth/me —— 当前登录用户 + 是否管理员（未登录返回 null，前端以此显示登录态）
// POST /api/auth/logout —— 退出登录（清 cookie）
import { NextRequest, NextResponse } from "next/server";
import { isAdminUser, SESSION_COOKIE, userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await userFromCookieHeader(req.headers.get("cookie"));
  return NextResponse.json({ user, isAdmin: isAdminUser(user?.email) });
}

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
