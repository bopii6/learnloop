// GET /api/profile —— 读取学习者画像；POST —— 设置称呼；DELETE —— 重置
// 画像按登录用户隔离（未登录走 anonymous 空间）
import { NextRequest, NextResponse } from "next/server";
import { getProfile, resetProfile, saveProfileName } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function meId(req: NextRequest): Promise<string | undefined> {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  return me?.id;
}

export async function GET(req: NextRequest) {
  const profile = await getProfile(await meId(req));
  return NextResponse.json({ profile });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body?.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "empty name" }, { status: 400 });
    }
    const profile = await saveProfileName(name, await meId(req));
    return NextResponse.json({ profile });
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  await resetProfile(await meId(req));
  return NextResponse.json({ ok: true });
}
