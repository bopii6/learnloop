"use client";

// /lesson/[courseId]/[lectureId] —— 分步学习课（样板，与白板课并存）
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CourseOutline } from "@/types";
import { StepLesson } from "@/components/StepLesson";

export default function LessonPage({ params }: { params: Promise<{ courseId: string; lectureId: string }> }) {
  const { courseId, lectureId } = use(params);
  const router = useRouter();
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/courses/${courseId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "课程不存在或已失效" : `加载失败 (${r.status})`);
        return r.json();
      })
      .then((d) => alive && setOutline(d.course.outline))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [courseId]);

  const unit = outline?.units.find((u) => u.lectures.some((l) => l.id === lectureId));
  const lecture = unit?.lectures.find((l) => l.id === lectureId);
  const exit = () => router.push(`/course/${courseId}`);

  if (error || (outline && (!unit || !lecture))) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center">
        <div>
          <div className="mb-4 text-[15px] text-ink-soft">{error ?? "课节不存在或已下线"}</div>
          <button onClick={exit} className="rounded-full bg-accent px-5 py-2 text-[13px] font-medium text-white hover:opacity-90">回课程页</button>
        </div>
      </div>
    );
  }
  if (!unit || !lecture) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
      </div>
    );
  }
  return <StepLesson courseId={courseId} unitId={unit.id} lectureId={lectureId} lectureTitle={lecture.title} onExit={exit} />;
}
