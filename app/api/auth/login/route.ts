// POST /api/auth/login —— 邮箱 + 验证码登录（新邮箱自动注册）
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  isValidEmail,
  normalizeEmail,
  signSession,
  upsertUserByEmail,
  verifyCode,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { email?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const email = normalizeEmail(body.email || "");
  const code = (body.code || "").trim();
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "邮箱或验证码格式不对" }, { status: 400 });
  }

  const ok = await verifyCode(email, code);
  if (!ok) {
    return NextResponse.json({ error: "验证码不对或已过期" }, { status: 401 });
  }

  const user = await upsertUserByEmail(email);
  const token = await signSession(user.id);
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}
