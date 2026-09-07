// GET /api/profile —— 读取学习者画像；POST —— 设置称呼；DELETE —— 重置
import { NextRequest, NextResponse } from "next/server";
import { getProfile, resetProfile, saveProfileName } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getProfile();
  return NextResponse.json({ profile });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body?.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "empty name" }, { status: 400 });
    }
    const profile = await saveProfileName(name);
    return NextResponse.json({ profile });
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
}

export async function DELETE() {
  await resetProfile();
  return NextResponse.json({ ok: true });
}
