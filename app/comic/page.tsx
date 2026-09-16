"use client";

// 连环画课堂入口：/comic?course=&unit=&lec=
// 默认走手绘引擎（Excalidraw，零图费）；?engine=img 切到 AI 生图版（tu-zi/万相等）。
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ComicBoard } from "@/components/ComicBoard";
import { ComicClassroom } from "@/components/ComicClassroom";

function Inner() {
  const params = useSearchParams();
  const courseId = params.get("course") || "";
  const unitId = params.get("unit") || "";
  const lectureId = params.get("lec") || "";
  const engine = params.get("engine") || "board";
  if (!courseId || !unitId || !lectureId) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-100 text-sm text-neutral-500">
        缺少课程参数：/comic?course=…&unit=…&lec=…
      </div>
    );
  }
  return engine === "img" ? (
    <ComicClassroom courseId={courseId} unitId={unitId} lectureId={lectureId} />
  ) : (
    <ComicBoard courseId={courseId} unitId={unitId} lectureId={lectureId} />
  );
}

export default function ComicPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
