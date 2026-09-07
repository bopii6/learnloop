// GET /api/conversations 会话列表（按登录用户过滤）；POST 新建（归属当前用户）
import { NextRequest, NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/store";
import { userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const list = await listConversations(me?.id);
  return NextResponse.json({ conversations: list });
}

export async function POST(req: NextRequest) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const conv = await createConversation(me?.id);
  return NextResponse.json({ conversation: conv });
}
