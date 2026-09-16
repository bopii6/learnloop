"use client";

// 苏格拉底私教课堂入口（原型）：/socratic?course=&unit=&lec=
// 例：/socratic?course=course-d5d3e4de&unit=unit-2&lec=lec-2-2
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { SocraticClassroom } from "@/components/SocraticClassroom";

function Inner() {
  const params = useSearchParams();
  const courseId = params.get("course") || "";
  const unitId = params.get("unit") || "";
  const lectureId = params.get("lec") || "";
  if (!courseId || !unitId || !lectureId) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-neutral-500">
        缺少课程参数：/socratic?course=…&unit=…&lec=…
      </div>
    );
  }
  return <SocraticClassroom courseId={courseId} unitId={unitId} lectureId={lectureId} />;
}

export default function SocraticPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
