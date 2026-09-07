// GET /api/conversations 会话列表；POST 新建
import { NextRequest, NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const list = await listConversations();
  return NextResponse.json({ conversations: list });
}

export async function POST() {
  const conv = await createConversation();
  return NextResponse.json({ conversation: conv });
}
