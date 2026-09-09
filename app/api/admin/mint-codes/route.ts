// POST /api/admin/mint-codes —— 造兑换码（founders 收款后发码用，见 lib/redeem.ts）
// GET  /api/admin/mint-codes —— 全量码列表（/admin 后台的「兑换码记录」用）
import { NextResponse } from "next/server";
import { isAdminUser, userFromCookieHeader } from "@/lib/auth";
import { listCodes, mintCodes } from "@/lib/redeem";

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
  const codes = await listCodes();
  return NextResponse.json({
    codes,
    summary: {
      total: codes.length,
      unused: codes.filter((c) => !c.redeemedBy).length,
      unusedCredits: codes.filter((c) => !c.redeemedBy).reduce((s, c) => s + c.credits, 0),
    },
  });
}
