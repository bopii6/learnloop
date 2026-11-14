"use client";

// /classroom/[courseId]/[lectureId] —— 课节入口路由：按课节类型分流。
// 白板课 → 白板课堂；测验课 → 单元测验；项目课 → 结课作品工坊。退出回课程详情页。
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CourseOutline } from "@/types";
import { WhiteboardSession } from "@/components/WhiteboardSession";
import { CapstoneStudio } from "@/components/CapstoneStudio";
import { QuizLesson } from "@/components/QuizLesson";

export default function LecturePage({
  params,
}: {
  params: Promise<{ courseId: string; lectureId: string }>;
}) {
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
      .then((d) => {
        if (alive) setOutline(d.course.outline);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [courseId]);

  const unit = outline?.units.find((u) => u.lectures.some((l) => l.id === lectureId));
  const lecture = unit?.lectures.find((l) => l.id === lectureId);

  if (error || (outline && (!unit || !lecture))) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <div className="text-[15px] text-ink-soft mb-4">
            {error ?? "课节不存在或已下线"}
          </div>
          <button
            onClick={() => router.push(`/course/${courseId}`)}
            className="rounded-full bg-accent px-5 py-2 text-[13px] text-white font-medium hover:opacity-90"
          >
            回课程页
          </button>
        </div>
      </div>
    );
  }

  if (!outline || !unit || !lecture) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
      </div>
    );
  }

  if (lecture.content_type === "project") {
    return (
      <CapstoneStudio
        courseId={courseId}
        outline={outline}
        unitId={unit.id}
        lecture={lecture}
        onExit={() => router.push(`/course/${courseId}`)}
      />
    );
  }
  if (lecture.content_type === "quiz") {
    return (
      <QuizLesson
        courseId={courseId}
        outline={outline}
        unitId={unit.id}
        lecture={lecture}
        onExit={() => router.push(`/course/${courseId}`)}
      />
    );
  }

  return (
    <WhiteboardSession
      courseId={courseId}
      unitId={unit.id}
      lectureId={lectureId}
      lectureTitle={lecture.title}
      onExit={() => router.push(`/course/${courseId}`)}
    />
  );
}
