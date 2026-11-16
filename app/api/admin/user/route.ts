// GET /api/admin/user?email= —— 查单个用户的账号信息
import { NextRequest, NextResponse } from "next/server";
import { findUserByEmail, isAdminUser, normalizeEmail, userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!isAdminUser(me?.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const email = normalizeEmail(req.nextUrl.searchParams.get("email") || "");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const user = await findUserByEmail(email);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  return NextResponse.json({
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
  });
}
