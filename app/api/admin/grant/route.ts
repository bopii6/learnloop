// POST /api/admin/grant —— 管理员补发/扣回积分 { email, amount, reason }
// 场景：用户投诉生成失败被扣分、客诉补偿、活动发放。理由必填并写进账户流水（对账凭据）。
import { NextRequest, NextResponse } from "next/server";
import { findUserByEmail, isAdminUser, normalizeEmail, userFromCookieHeader } from "@/lib/auth";
import { grantCredits } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!isAdminUser(me?.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { email?: string; amount?: number; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const email = normalizeEmail(body.email || "");
  const amount = Math.trunc(Number(body.amount) || 0);
  const reason = (body.reason || "").trim();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!amount || Math.abs(amount) > 10000) {
    return NextResponse.json({ error: "amount 必须是非零整数，单次 ±10000 以内" }, { status: 400 });
  }
  if (reason.length < 2) return NextResponse.json({ error: "reason 必填（写进流水的对账凭据）" }, { status: 400 });

  const user = await findUserByEmail(email);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const acc = await grantCredits(user.id, amount, `管理员调整（${me!.email}）：${reason}`);
  return NextResponse.json({ ok: true, balance: acc.balance });
}
