// GET /api/courses —— 已生成课程列表（课程记录页 + 侧栏的入口）
// 返回学习所需的元信息：单元/课节数、总时长、受众、标签。
// 归属规则：登录后看到"自己的 + 无主的历史数据"；未登录只看无主数据。
// 数据源是 setCourseState 顺手维护的小索引 course-meta/（几百字节/门）。
// 课程全文档（courses/）里躺着澄清对话、网页正文、教材全文，直接逐份读在
// R2 模式下要好几秒；只有没建过索引的旧课程才并行回读全文档并补建索引。
import { NextRequest, NextResponse } from "next/server";
import { userFromCookieHeader } from "@/lib/auth";
import { listKeys, readJson, writeJson } from "@/lib/storage";
import { courseMetaFromState, metaKey, type CourseMeta } from "@/lib/agent/course";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safeList = (prefix: string) => listKeys(prefix).catch(() => []);
const baseName = (key: string) => key.split("/").pop()!.replace(/\.json$/, "");

export async function GET(req: NextRequest) {
  try {
    const me = await userFromCookieHeader(req.headers.get("cookie"));
    const mine = (ownerId: unknown) => !ownerId || (me ? ownerId === me.id : false);

    const [metaItems, courseItems, roomItems] = await Promise.all([
      safeList("course-meta/"),
      safeList("courses/"),
      // 课堂快照：本地模式由 server.mjs 写进 data/classrooms/；R2 模式下快照仍只在本地
      // （Workers 暂无 WS 快照），所以除了 listKeys 再并一份本地目录，"继续学习"角标才不丢
      (async () => {
        const [viaStorage, viaLocal] = await Promise.all([
          safeList("classrooms/"),
          (async () => {
            try {
              const { promises: fs } = await import("fs");
              const path = await import("path");
              return await fs.readdir(path.join(process.cwd(), "data", "classrooms"));
            } catch {
              return [] as string[];
            }
          })(),
        ]);
        return [...viaStorage.map((i) => i.key.split("/").pop()!), ...viaLocal];
      })(),
    ]);
    const roomIds = roomItems.map((r) => (r.includes("/") ? baseName(r) : r));
    const courseIds = courseItems
      .filter((i) => i.key.endsWith(".json"))
      .map((i) => baseName(i.key));

    const metaById = new Map<string, CourseMeta>();
    await Promise.all(
      metaItems
        .filter((i) => i.key.endsWith(".json"))
        .map(async (item) => {
          try {
            const m = await readJson<CourseMeta | null>(item.key, null);
            if (m && typeof m.title === "string") metaById.set(baseName(item.key), m);
          } catch {
            // 坏索引当不存在，走回读兜底
          }
        })
    );

    // 旧课程没有索引（或索引缺 source/createdAt 字段的早期版本）：并行回读全文档补建
    // （一次性，之后列表只读小文件）。日期用课程文件的真实修改时间，不用回填的现在。
    const unindexed = courseIds.filter((id) => {
      const m = metaById.get(id);
      return !m || !m.source || !m.createdAt;
    });
    await Promise.all(
      unindexed.map(async (id) => {
        try {
          const state = await readJson<{
            ownerId?: string;
            title?: string;
            outline?: Parameters<typeof courseMetaFromState>[0]["outline"];
            textbook?: { id: string } | null;
            docMode?: boolean;
          } | null>(`courses/${id}.json`, null);
          if (!state) return;
          const meta = courseMetaFromState(state);
          if (!meta) return; // 在制课程（大纲未出），不进列表也不建索引
          const lm = courseItems.find((i) => baseName(i.key) === id)?.lastModified;
          if (lm) {
            meta.updatedAt = lm;
            meta.createdAt = lm;
          } else {
            meta.createdAt = meta.updatedAt;
          }
          metaById.set(id, meta);
          writeJson(metaKey(id), meta).catch((e) => console.error("[courses-backfill] 写索引失败", id, e?.message || e));
        } catch {
          // 跳过损坏文件
        }
      })
    );

    const courses = courseIds
      .map((id) => {
        const m = metaById.get(id);
        if (!m || !mine(m.ownerId)) return null;
        return {
          id,
          title: m.title,
          audience: m.audience,
          tags: m.tags,
          units: m.units,
          lectures: m.lectures,
          totalMin: m.totalMin,
          source: m.source,
          started: roomIds.some((r) => r.startsWith(`${id}unit-`)),
          createdAt: m.createdAt || m.updatedAt,
          updatedAt: m.updatedAt,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // 课程记录页要看全部；量级上来后再分页
    return NextResponse.json({ courses });
  } catch {
    return NextResponse.json({ courses: [] });
  }
}
