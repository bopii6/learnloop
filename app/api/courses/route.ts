// GET /api/courses —— 已生成课程列表（课程记录页 + 侧栏的入口）
// 返回学习所需的元信息：单元/课节数、总时长、受众、标签。
// 归属规则：登录后看到"自己的 + 无主的历史数据"；未登录只看无主数据。
// 课程文档经存储抽象层读取（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）。
import { NextRequest, NextResponse } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";
import { listKeys, readJson } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const me = await userFromCookieHeader(req.headers.get("cookie"));
    const mine = (ownerId: unknown) => !ownerId || (me ? ownerId === me.id : false);
    const items = await listKeys("courses/");
    const courses: {
      id: string;
      title: string;
      audience: string;
      tags: string[];
      units: number;
      lectures: number;
      totalMin: number;
      updatedAt: number;
    }[] = [];
    for (const item of items) {
      if (!item.key.endsWith(".json")) continue;
      try {
        const j = await readJson<{
          title?: string;
          ownerId?: string;
          outline?: {
            title?: string;
            audience?: string;
            tags?: string[];
            units?: { lectures?: { duration_min?: number }[] }[];
          };
        }>(item.key, {});
        // 只列出真正生成完成的课程（有大纲），半途失败的空状态文件不进列表
        const outline = j.outline;
        if (!outline) continue;
        if (!mine(j.ownerId)) continue;
        const units = Array.isArray(outline.units) ? outline.units : [];
        const lectures = units.reduce<number>((s, u) => s + (u.lectures?.length || 0), 0);
        const totalMin = units.reduce<number>(
          (s, u) => s + (u.lectures || []).reduce<number>((t, l) => t + (l.duration_min || 0), 0),
          0
        );
        courses.push({
          id: item.key.split("/").pop()!.replace(/\.json$/, ""),
          title: j.title || outline.title || "未命名课程",
          audience: outline.audience || "",
          tags: Array.isArray(outline.tags) ? outline.tags.slice(0, 3) : [],
          units: units.length,
          lectures,
          totalMin,
          updatedAt: item.lastModified || 0,
        });
      } catch {
        // 跳过损坏文件
      }
    }
    courses.sort((a, b) => b.updatedAt - a.updatedAt);
    // 课程记录页要看全部；量级上来后再分页
    return NextResponse.json({ courses });
  } catch {
    return NextResponse.json({ courses: [] });
  }
}
