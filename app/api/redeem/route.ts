// POST /api/redeem —— 兑换码换积分（侧栏「兑换」入口）
import { NextRequest, NextResponse } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";
import { redeemCode } from "@/lib/redeem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!me) {
    return NextResponse.json({ error: "请先登录再兑换（积分跟账号走）" }, { status: 401 });
  }
  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const code = String(body.code || "");
  if (!code.trim()) {
    return NextResponse.json({ error: "请输入兑换码" }, { status: 400 });
  }
  const result = await redeemCode(code, me.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason === "used" ? "这个码已被使用" : "兑换码不存在，检查一下大小写和连字符" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, credits: result.credits, balance: result.balance });
}
