"use client";

// 课程记录：我自己生成的全部课程。点开即进入课程详情学习。
// 卡片对标 Hyperknow「我的课程」：大横卡 + 插画 + 来源/日期 + 底部规模行。
import { useCallback, useEffect, useMemo, useState } from "react";
import { CourseCover } from "./CourseCover";

interface RecordCourse {
  id: string;
  title: string;
  audience: string;
  tags: string[];
  units: number;
  lectures: number;
  totalMin: number;
  started?: boolean;
  createdAt?: number;
  updatedAt: number;
  source?: string;
}

type Filter = "all" | "doing" | "todo";

const fmtHours = (min: number) =>
  min > 0 ? (min / 60).toFixed(1).replace(/\.0$/, "") + " 小时" : "—";

const fmtDate = (ms: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

export function CourseRecordsView({
  onOpenCourse,
  onGoHome,
}: {
  onOpenCourse: (courseId: string) => void;
  onGoHome: () => void;
}) {
  const [courses, setCourses] = useState<RecordCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

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

  const shown = useMemo(() => {
    let list = courses || [];
    if (filter === "doing") list = list.filter((c) => c.started);
    if (filter === "todo") list = list.filter((c) => !c.started);
    const kw = q.trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(kw) ||
          c.audience.toLowerCase().includes(kw) ||
          c.tags.some((t) => t.toLowerCase().includes(kw))
      );
    }
    return list;
  }, [courses, q, filter]);

  const doingCount = (courses || []).filter((c) => c.started).length;

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `全部${courses ? ` ${courses.length}` : ""}` },
    { key: "doing", label: `进行中 ${doingCount}` },
    { key: "todo", label: "未开始" },
  ];

  return (
    <div className="max-w-5xl mx-auto pt-10 px-6 pb-16">
      <div className="flex items-end justify-between gap-4 mb-2">
        <div>
          <div className="text-[26px] font-bold mb-1.5">课程记录</div>
          <div className="text-[13.5px] text-ink-soft leading-relaxed">
            你生成的所有课程都在这里，点开继续学。好课可以进详情页上架到课程集市。
          </div>
        </div>
        {courses && courses.length > 3 && (
          <div className="relative shrink-0 w-56">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索课程..."
              className="w-full rounded-full border border-[#e7e5dc] bg-white pl-9 pr-3 py-2 text-[12.5px] outline-none focus:border-accent/60"
            />
            <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </div>
        )}
      </div>

      {courses && courses.length > 0 && (
        <div className="flex gap-1.5 mb-5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                filter === t.key
                  ? "bg-[#2c2c2a] text-white"
                  : "bg-white border border-[#e7e5dc] text-ink-soft hover:border-accent/50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

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

      {courses && courses.length > 0 && shown.length === 0 && (
        <div className="text-[13px] text-ink-faint py-8 text-center">没有匹配「{q}」的课程</div>
      )}

      {shown.length > 0 && (
        <div className="grid gap-4">
          {shown.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenCourse(c.id)}
              className="group text-left rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden flex flex-col hover:border-accent/60 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-all fade-up"
            >
              <div className="flex min-h-[128px]">
                <div className="flex-1 min-w-0 p-5 pb-3">
                  <div className="text-[10.5px] tracking-wider text-ink-faint mb-1">课程名称</div>
                  <div className="text-[16.5px] font-bold leading-snug mb-1.5 line-clamp-2">{c.title}</div>
                  {c.audience && (
                    <div className="text-[12.5px] text-ink-soft leading-relaxed line-clamp-2 mb-2.5">{c.audience}</div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-ink-faint">
                    <span>{c.source || "AI 生成"}</span>
                    <span>·</span>
                    <span>{fmtDate(c.createdAt || c.updatedAt)}</span>
                    {c.tags.slice(0, 2).map((t) => (
                      <span key={t} className="rounded-full bg-[#f1efe8] px-2 py-0.5 text-[10.5px] text-ink-soft">
                        #{t}
                      </span>
                    ))}
                  </div>
                </div>
                <CourseCover seed={c.id} className="w-[168px] shrink-0 my-4 mr-4" />
              </div>
              <div className="border-t border-[#f5f4ee] px-5 py-2.5 flex items-center justify-between">
                <span className="text-[11.5px] text-ink-faint">
                  {c.units} 单元 · {c.lectures} 课节 · 约 {fmtHours(c.totalMin)}
                </span>
                <span className={`text-[12px] font-medium ${c.started ? "text-accent" : "text-ink-soft group-hover:text-accent"} transition-colors`}>
                  {c.started ? "▶ 继续学习" : "▶ 开始学习"}
                </span>
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
