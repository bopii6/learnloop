// GET /api/conversations/[id] 会话详情；DELETE 删除（有主会话仅本人可读写）
import { NextRequest, NextResponse } from "next/server";
import { deleteConversation, getConversation, canAccess } from "@/lib/store";
import { userFromCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const conv = await getConversation(id);
  if (!canAccess(conv, me?.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ conversation: conv });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  const conv = await getConversation(id);
  if (!canAccess(conv, me?.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteConversation(id);
  return NextResponse.json({ ok: true });
}
