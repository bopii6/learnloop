// GET /api/conversations/[id] 会话详情；DELETE 删除
import { NextRequest, NextResponse } from "next/server";
import { deleteConversation, getConversation } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const conv = await getConversation(id);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ conversation: conv });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  await deleteConversation(id);
  return NextResponse.json({ ok: true });
}
