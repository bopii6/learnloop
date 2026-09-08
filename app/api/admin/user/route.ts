// GET /api/admin/user?email= —— 查单个用户：账号信息 + 积分账户 + 最近流水
import { NextRequest, NextResponse } from "next/server";
import { findUserByEmail, isAdminUser, normalizeEmail, userFromCookieHeader } from "@/lib/auth";
import { getOrCreateAccount } from "@/lib/credits";

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

  const acc = await getOrCreateAccount(user.id);
  return NextResponse.json({
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
    credits: { balance: acc.balance, granted: acc.granted, spent: acc.spent, updatedAt: acc.updatedAt },
    log: acc.log.slice(-20).reverse(),
  });
}
