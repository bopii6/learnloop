"use client";

// /records —— 课程记录独立路由
import { useRouter } from "next/navigation";
import { CourseRecordsView } from "@/components/CourseRecordsView";

export default function RecordsPage() {
  const router = useRouter();
  return (
    <div className="flex-1 overflow-y-auto">
      <CourseRecordsView
        onOpenCourse={(id) => router.push(`/course/${id}`)}
        onGoHome={() => router.push("/")}
      />
    </div>
  );
}
