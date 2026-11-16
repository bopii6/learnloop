// POST /api/admin/backup —— 关键数据备份：复制到 backup/{YYYY-MM-DD}/ 前缀
// 覆盖"丢了无法再生"的小而关键的文件：用户、集市登记表、举报、课程索引。
// 课程正文不在此列（可重新生成，且应开启 R2 版本控制兜底——控制台开关，见上线评审）。
// 建议节奏：每天收工时点一次；将来挂 Cloudflare Cron Trigger 可全自动。
import { NextResponse } from "next/server";
import { isAdminUser, userFromCookieHeader } from "@/lib/auth";
import { listKeys, readBinary, writeBinary } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TODAY = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export async function POST(req: Request) {
  const me = await userFromCookieHeader(req.headers.get("cookie"));
  if (!isAdminUser(me?.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const dest = (key: string) => `backup/${TODAY()}/${key}`;
  const copied: string[] = [];
  const failed: { key: string; error: string }[] = [];

  async function copyKey(key: string) {
    try {
      const buf = await readBinary(key);
      if (!buf) return; // 不存在就跳过
      await writeBinary(dest(key), buf);
      copied.push(key);
    } catch (e) {
      failed.push({ key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 固定关键文件
  for (const key of ["users.json", "marketplace.json", "market-reports.json"]) {
    await copyKey(key);
  }
  // 课程小索引（整目录）
  for (const prefix of ["course-meta/"]) {
    const items = await listKeys(prefix).catch(() => []);
    for (const it of items) await copyKey(it.key);
  }

  return NextResponse.json({ ok: failed.length === 0, date: TODAY(), copied: copied.length, failed, keys: copied });
}
