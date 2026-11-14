// 旧课节入口：已统一到 /classroom（v2 白板课堂）。保留此路由只为让历史链接 / 收藏不失效。
import { redirect } from "next/navigation";

export default async function LegacyLecturePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; lectureId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { courseId, lectureId } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") qs.set(k, v);
  }
  const q = qs.toString();
  redirect(`/classroom/${encodeURIComponent(courseId)}/${encodeURIComponent(lectureId)}${q ? `?${q}` : ""}`);
}
