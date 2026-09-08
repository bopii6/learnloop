"use client";

// /wrapped —— 学习战报独立路由
import { WrappedView } from "@/components/WrappedView";

export default function WrappedPage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <WrappedView />
    </div>
  );
}
