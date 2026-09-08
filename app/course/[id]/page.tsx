"use client";

// /course/[id] —— 课程详情独立路由：可刷新、可收藏、可分享找回。
// 此前课程页只是首页内存态，登录态一丢/一刷新课程就"消失"（实测踩过的坑）。
// 数据接口 /api/courses/[id] 本就是公开的，这里只是给它一个 URL 入口。
import { use, useEffect, useState } from "react";
import Link from "next/link";
import type { CourseOutline } from "@/types";
import { CourseOutlineView } from "@/components/CourseOutlineView";

export default function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = use(params).id;

  useEffect(() => {
    let alive = true;
    fetch(`/api/courses/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "课程不存在或已失效" : `加载失败 (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (alive) setOutline(d.course.outline);
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
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <div className="text-[15px] text-ink-soft mb-4">{error}</div>
          <Link href="/" className="rounded-full bg-accent px-5 py-2 text-[13px] text-white font-medium hover:opacity-90">
            回首页
          </Link>
        </div>
      </div>
    );
  }

  if (!outline) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-6xl mx-auto px-6 pt-5">
        <Link href="/" className="text-[12.5px] text-ink-faint hover:text-accent transition-colors">
          ← 返回 LearnLoop
        </Link>
      </div>
      <CourseOutlineView outline={outline} courseId={id} />
    </div>
  );
}
