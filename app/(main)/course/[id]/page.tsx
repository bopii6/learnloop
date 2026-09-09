"use client";

// /course/[id] —— 课程详情独立路由（挂在外壳组里，带侧栏）。
// 可刷新、可收藏、可分享找回；侧栏「打开课程」、集市、课程记录都跳到这里。
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CourseOutline } from "@/types";
import { CourseOutlineView } from "@/components/CourseOutlineView";

export default function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const id = use(params).id;

  useEffect(() => {
    let alive = true;
    fetch(`/api/courses/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "课程不存在或已失效" : `加载失败 (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (!alive) return;
        setOutline(d.course.outline);
        setVisited(new Set<string>(d.visited || []));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center">
          <div className="text-[15px] text-ink-soft mb-4">{error}</div>
          <button
            onClick={() => router.push("/")}
            className="rounded-full bg-accent px-5 py-2 text-[13px] text-white font-medium hover:opacity-90"
          >
            回首页
          </button>
        </div>
      </div>
    );
  }

  if (!outline) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <CourseOutlineView outline={outline} courseId={id} visited={visited} />
    </div>
  );
}
