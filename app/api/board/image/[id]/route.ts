// 板卡配图服务端：GET /api/board/image/<hash> → 落盘的教学插画
import { NextRequest } from "next/server";
import { readBoardImage } from "@/lib/board/images";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const buf = await readBoardImage(id);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
