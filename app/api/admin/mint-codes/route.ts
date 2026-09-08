// POST /api/admin/mint-codes —— 造兑换码（founders 收款后发码用，见 lib/redeem.ts）
// 浏览器直接调：先在响应里拿码，发给已收款的用户。附 GET 说明用法。
import { NextResponse } from "next/server";
import { isAdminUser, userFromCookieHeader } from "@/lib/auth";
import { mintCodes } from "@/lib/redeem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!isAdminUser(me?.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { count?: number; credits?: number; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const codes = await mintCodes(Number(body.count) || 1, Number(body.credits) || 20, body.note);
  return NextResponse.json({ codes });
}

export async function GET(req: Request) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!isAdminUser(me?.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    usage: `POST /api/admin/mint-codes  {"count": 5, "credits": 20, "note": "0910 收款"}`,
    hint: "count 1-50，credits 1-10000；返回的 codes 复制发给用户，用户在侧栏「兑换」输入即可到账",
  });
}
