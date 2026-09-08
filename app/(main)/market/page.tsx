"use client";

// /market —— 课程集市独立路由
import { useRouter } from "next/navigation";
import { MarketView } from "@/components/MarketView";

export default function MarketPage() {
  const router = useRouter();
  return (
    <div className="flex-1 overflow-y-auto">
      <MarketView
        onOpenCourse={(id) => router.push(`/course/${id}`)}
        onGoHome={() => router.push("/")}
      />
    </div>
  );
}
