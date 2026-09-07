// GET /api/storage-check —— 存储层自检：报告当前驱动（本地/R2），做一次读写删往返。
// 配置好 .env 的 CF_* 变量后，访问这个接口确认 Cloudflare 存储已生效。
import { NextResponse } from "next/server";
import { probe, storageMode } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await probe();
  return NextResponse.json({
    ...result,
    hint:
      storageMode === "local"
        ? "当前为本地驱动。在 .env 填入 CF_ACCOUNT_ID / CF_R2_BUCKET / CF_R2_ACCESS_KEY_ID / CF_R2_SECRET_ACCESS_KEY 并重启后，数据自动写入你的 R2 桶。"
        : "R2 驱动已生效，业务数据读写走你的 Cloudflare 桶。",
  });
}
