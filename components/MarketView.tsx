"use client";

// 课程集市：官方精选 + 用户上架的课程。点开直接学；本机自用阶段，上架/下架即管理动作。
import { useCallback, useEffect, useState } from "react";
import type { MarketEntry } from "@/types";

export function MarketView({
  onOpenCourse,
  onGoHome,
}: {
  onOpenCourse: (courseId: string) => void;
  onGoHome: () => void;
}) {
  const [entries, setEntries] = useState<MarketEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/market");
      const d = await res.json();
      setEntries(d.entries || []);
    } catch {
      setError("集市加载失败");
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeFromMarket = useCallback(
    async (courseId: string) => {
      setEntries((prev) => (prev ? prev.filter((e) => e.courseId !== courseId) : prev));
      await fetch(`/api/market?courseId=${encodeURIComponent(courseId)}`, { method: "DELETE" });
    },
    []
  );

  return (
    <div className="max-w-4xl mx-auto pt-10 px-6 pb-16">
      <div className="mb-8">
        <div className="text-[24px] font-bold mb-1.5">课程集市</div>
        <div className="text-[13.5px] text-ink-soft leading-relaxed">
          官方精选和大家上架的好课，看中了直接学。付费与分成在支付链路接入后开放，现在全部免费。
        </div>
      </div>

      {entries === null && <div className="text-[13px] text-ink-faint">加载中…</div>}

      {entries && entries.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[#d3d1c7] bg-white px-6 py-12 text-center">
          <div className="text-[14px] font-medium mb-1.5">集市还空着</div>
          <div className="text-[12.5px] text-ink-soft mb-5 leading-relaxed">
            去「课程记录」打开一门好课，在课程页右上角点「上架到课程集市」，它就会出现在这里。
          </div>
          <button
            onClick={onGoHome}
            className="rounded-full bg-accent px-5 py-2 text-[12.5px] text-white font-medium hover:opacity-90"
          >
            回首页做一门课 →
          </button>
        </div>
      )}

      {entries && entries.length > 0 && (
        <div className="grid gap-3.5 sm:grid-cols-2">
          {entries.map((e) => (
            <div
              key={e.courseId}
              className="rounded-2xl border border-[#e7e5dc] bg-white p-5 flex flex-col hover:border-accent/50 transition-colors fade-up"
            >
              <div className="flex items-center gap-2 mb-2">
                {e.author === "official" && (
                  <span className="rounded-full bg-accent-soft text-accent px-2 py-0.5 text-[10px] font-medium">
                    官方精选
                  </span>
                )}
                <span className={`text-[11px] font-medium ${e.price > 0 ? "text-[#b45309]" : "text-emerald-600"}`}>
                  {e.price > 0 ? `¥${e.price}` : "免费"}
                </span>
              </div>
              <div className="text-[15px] font-semibold leading-snug mb-1.5">{e.title}</div>
              {e.note && <div className="text-[12px] text-ink-soft leading-relaxed mb-3 flex-1">{e.note}</div>}
              {!e.note && <div className="flex-1" />}
              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={() => onOpenCourse(e.courseId)}
                  className="rounded-full bg-accent px-5 py-1.5 text-[12.5px] text-white font-medium hover:opacity-90"
                >
                  ▶ 去学习
                </button>
                <button
                  onClick={() => void removeFromMarket(e.courseId)}
                  className="text-[11.5px] text-ink-faint hover:text-red-500 transition-colors"
                  title="从集市下架（课程本身不受影响）"
                >
                  下架
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>
      )}
    </div>
  );
}
