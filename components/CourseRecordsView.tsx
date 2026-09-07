"use client";

// 课程记录：我自己生成的全部课程。点开即进入课程详情学习。
import { useCallback, useEffect, useState } from "react";

interface RecordCourse {
  id: string;
  title: string;
  audience: string;
  tags: string[];
  units: number;
  lectures: number;
  totalMin: number;
  updatedAt: number;
}

export function CourseRecordsView({
  onOpenCourse,
  onGoHome,
}: {
  onOpenCourse: (courseId: string) => void;
  onGoHome: () => void;
}) {
  const [courses, setCourses] = useState<RecordCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/courses");
      const d = await res.json();
      setCourses(d.courses || []);
    } catch {
      setError("课程记录加载失败");
      setCourses([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fmtHours = (min: number) =>
    min > 0 ? (min / 60).toFixed(1).replace(/\.0$/, "") + " 小时" : "—";

  return (
    <div className="max-w-4xl mx-auto pt-10 px-6 pb-16">
      <div className="mb-8">
        <div className="text-[24px] font-bold mb-1.5">课程记录</div>
        <div className="text-[13.5px] text-ink-soft leading-relaxed">
          你生成的所有课程都在这里，点开继续学。好课可以进详情页上架到课程集市。
        </div>
      </div>

      {courses === null && <div className="text-[13px] text-ink-faint">加载中…</div>}

      {courses && courses.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[#d3d1c7] bg-white px-6 py-12 text-center">
          <div className="text-[14px] font-medium mb-1.5">还没有课程</div>
          <div className="text-[12.5px] text-ink-soft mb-5 leading-relaxed">
            回首页输入一个想搞懂的主题，或者上传教材 PDF，一分钟生成一门课。
          </div>
          <button
            onClick={onGoHome}
            className="rounded-full bg-accent px-5 py-2 text-[12.5px] text-white font-medium hover:opacity-90"
          >
            去首页打造第一门课 →
          </button>
        </div>
      )}

      {courses && courses.length > 0 && (
        <div className="grid gap-3.5 sm:grid-cols-2">
          {courses.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenCourse(c.id)}
              className="text-left rounded-2xl border border-[#e7e5dc] bg-white p-5 flex flex-col hover:border-accent/60 transition-colors fade-up"
            >
              <div className="text-[15px] font-semibold leading-snug mb-1.5">{c.title}</div>
              {c.audience && (
                <div className="text-[12px] text-ink-soft leading-relaxed mb-2 line-clamp-2">{c.audience}</div>
              )}
              <div className="flex gap-1.5 flex-wrap mb-3">
                {c.tags.map((t) => (
                  <span key={t} className="rounded-full bg-[#f1efe8] px-2 py-0.5 text-[10.5px] text-ink-soft">
                    #{t}
                  </span>
                ))}
              </div>
              <div className="mt-auto flex items-center justify-between pt-2 border-t border-[#f5f4ee]">
                <span className="text-[11.5px] text-ink-faint">
                  {c.units} 单元 · {c.lectures} 课节 · 约 {fmtHours(c.totalMin)}
                </span>
                <span className="text-[12px] text-accent font-medium">▶ 继续学习</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>
      )}
    </div>
  );
}
