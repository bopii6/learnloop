"use client";

// 首页 = 课程生成入口。生成完成后跳独立路由 /course/[id]（可刷新、可分享）。
import { useRouter } from "next/navigation";
import { CourseGenerator } from "@/components/CourseGenerator";

export default function HomePage() {
  const router = useRouter();
  return (
    <div className="flex-1 overflow-y-auto">
      <CourseGenerator
        onComplete={(courseId) => {
          window.dispatchEvent(new Event("ll:courses-changed"));
          router.push(`/course/${courseId}`);
        }}
      />
    </div>
  );
}
