// GET /api/auth/me —— 当前登录用户 + 积分余额（未登录返回 null，前端以此显示登录态）
// POST /api/auth/logout —— 退出登录（清 cookie）
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, userFromCookieHeader } from "@/lib/auth";
import { getBalance } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await userFromCookieHeader(req.headers.get("cookie"));
  const credits = user ? await getBalance(user.id) : null;
  return NextResponse.json({ user, credits });
}

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
