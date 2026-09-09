"use client";

// 课程记录：我自己生成的全部课程。点开即进入课程详情学习。
// 页面对标 Hyperknow「我的课程」：顶部「从上次学到的地方继续」+ 课程卡片网格（封面头图/新角标/进度条/悬浮继续学习）。
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
  visitedCount?: number;
  learnable?: number;
  nextTitle?: string | null;
  completed?: boolean;
  capstoneDone?: boolean;
  lastVisit?: number | null;
  source?: string;
  createdAt?: number;
  updatedAt: number;
}

type Filter = "all" | "doing" | "todo";

const isNew = (c: RecordCourse) =>
  Boolean(c.createdAt && Date.now() - c.createdAt < 12 * 3600 * 1000);

const fmtHours = (min: number) =>
  min > 0 ? (min / 60).toFixed(1).replace(/\.0$/, "") + " 小时" : "—";

const fmtDate = (ms: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
};

/** 进度区（继续学习大卡用）：进度条 + 下一讲 */
function ProgressBlock({ c }: { c: RecordCourse }) {
  const learnable = c.learnable || 0;
  const visited = c.visitedCount || 0;
  if (c.started && learnable > 0) {
    const pct = Math.min(100, Math.round((visited / learnable) * 100));
    return (
      <div>
        <div className="flex items-center justify-between text-[11.5px] mb-1.5">
          <span className="text-ink-soft">
            已学 <span className="font-semibold text-ink">{visited}</span> / {learnable} 讲
          </span>
          <span className={c.completed ? "text-accent font-semibold" : "text-ink-soft font-medium"}>
            {c.completed ? "✓ 全部学完" : `${pct}%`}
          </span>
        </div>
        <div className="h-2 rounded-full bg-[#f1efe8] overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent to-[#3aa981] transition-all duration-500"
            style={{ width: `${Math.max(pct, 5)}%` }}
          />
        </div>
        {!c.completed && c.nextTitle && (
          <div className="mt-1.5 text-[11.5px] text-ink-faint truncate">
            接下来：下一讲「{c.nextTitle}」
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="text-[11.5px] text-ink-faint">
      共 {learnable || c.lectures} 讲 · 约 {fmtHours(c.totalMin)} · 还没开始
    </div>
  );
}

/** 卡片底部进度区：紧凑版，不含下一讲文案 */
function CardProgress({ c }: { c: RecordCourse }) {
  const learnable = c.learnable || 0;
  const visited = c.visitedCount || 0;
  if (c.started && learnable > 0) {
    const pct = Math.min(100, Math.round((visited / learnable) * 100));
    return (
      <div>
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="text-ink-soft">
            已学 {visited} / {learnable} 讲
          </span>
          <span className={c.completed ? "text-accent font-semibold" : "text-ink-soft font-medium"}>
            {c.completed ? "✓ 学完" : `${pct}%`}
          </span>
        </div>
        <div className="h-2 rounded-full bg-[#f1efe8] overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent to-[#3aa981] transition-all duration-500"
            style={{ width: `${Math.max(pct, 5)}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="text-[11px] text-ink-faint">
      共 {learnable || c.lectures} 讲 · 约 {fmtHours(c.totalMin)}
    </div>
  );
}

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
  const totalHours = (courses || []).reduce((s, c) => s + (c.totalMin || 0), 0) / 60;

  // 「从上次学到的地方继续」：最近真的在学的那门（列表已按 lastStudy 排好序）
  const pickup = useMemo(() => (courses || []).find((c) => c.started) || null, [courses]);

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `全部${courses ? ` ${courses.length}` : ""}` },
    { key: "doing", label: `进行中 ${doingCount}` },
    { key: "todo", label: "未开始" },
  ];

  return (
    <div className="max-w-5xl mx-auto pt-10 px-6 pb-16">
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <div className="text-[26px] font-bold mb-1.5">课程记录</div>
          <div className="text-[13.5px] text-ink-soft leading-relaxed">
            {courses && courses.length > 0 ? (
              <>
                共 {courses.length} 门课
                {doingCount > 0 && <> · 学到一半的 {doingCount} 门</>}
                {totalHours > 0 && <> · 合计约 {totalHours.toFixed(0)} 小时</>}
                ，点开卡片继续学。
              </>
            ) : (
              <>你生成的所有课程都在这里，点开继续学。好课可以进详情页上架到精品课程。</>
            )}
          </div>
        </div>
        {courses && courses.length > 3 && (
          <div className="relative shrink-0 w-56">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索课程…"
              className="w-full rounded-full border border-[#e7e5dc] bg-white pl-9 pr-3 py-2 text-[12.5px] outline-none focus:border-accent/60"
            />
            <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </div>
        )}
      </div>

      {/* 从上次学到的地方继续（Hyperknow pickup 同款位置，渐变底突出） */}
      {pickup && (
        <button
          onClick={() => onOpenCourse(pickup.id)}
          className="group w-full text-left rounded-3xl border border-accent/25 bg-gradient-to-r from-accent-soft/60 via-white to-white px-6 py-5 mb-7 flex items-center gap-6 hover:border-accent/50 hover:shadow-[0_6px_24px_rgba(15,110,86,0.10)] transition-all fade-up"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="rounded-full bg-accent px-2.5 py-0.5 text-[10.5px] font-semibold text-white">
                从上次学到的地方继续
              </span>
              <span className="text-[11px] text-ink-faint">
                {pickup.source || "AI 生成"} · {fmtDate(pickup.createdAt || pickup.updatedAt)}
              </span>
              {isNew(pickup) && (
                <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] text-accent font-medium">新</span>
              )}
            </div>
            <div className="text-[18px] font-bold leading-snug mb-2 truncate">{pickup.title}</div>
            <ProgressBlock c={pickup} />
          </div>
          <div className="shrink-0 relative">
            <CourseCover seed={pickup.id} className="w-[132px] h-[88px]" />
            <span className="absolute left-1/2 -translate-x-1/2 -bottom-2.5 whitespace-nowrap rounded-full bg-accent px-4 py-1 text-[11.5px] text-white font-medium shadow-md transition-transform group-hover:scale-[1.04]">
              继续学习 →
            </span>
          </div>
        </button>
      )}

      {courses && courses.length > 0 && (
        <div className="flex gap-1.5 mb-5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                filter === t.key
                  ? "bg-accent text-white shadow-sm"
                  : "bg-white border border-[#e7e5dc] text-ink-soft hover:border-accent/50 hover:text-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {courses === null && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden">
              <div className="skeleton h-[110px] w-full" />
              <div className="p-4">
                <div className="skeleton h-4 w-11/12 rounded mb-2" />
                <div className="skeleton h-4 w-2/3 rounded mb-3" />
                <div className="skeleton h-3 w-1/3 rounded mb-2.5" />
                <div className="skeleton h-1.5 w-3/4 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      )}

      {courses && courses.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[#d3d1c7] bg-white px-6 py-12 text-center">
          <div className="text-[14px] font-medium mb-1.5">你的课程架暂时是空的</div>
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
        <div className="rounded-2xl border border-dashed border-[#d3d1c7] bg-white px-6 py-8 text-center">
          <div className="text-[13.5px] font-medium mb-1">没有找到匹配的课程</div>
          <div className="text-[12.5px] text-ink-soft">试试其他关键词，或清空搜索。</div>
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((c, idx) => (
            <button
              key={c.id}
              onClick={() => onOpenCourse(c.id)}
              style={{ animationDelay: `${Math.min(idx, 8) * 45}ms` }}
              className="card-fade-up group text-left rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/45 hover:shadow-[0_10px_28px_rgba(26,26,24,0.09)]"
            >
              {/* 封面头图：新/学完角标 + 悬浮「继续学习」遮罩 */}
              <div className="relative shrink-0">
                <CourseCover seed={c.id} rounded="rounded-none" className="w-full h-[110px]" />
                {isNew(c) && (
                  <span className="absolute top-2.5 left-2.5 rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-accent shadow-sm">
                    新
                  </span>
                )}
                {c.completed && (
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                    ✓ 已学完
                  </span>
                )}
                {c.capstoneDone && (
                  <span
                    className="absolute bottom-2.5 left-2.5 rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-accent shadow-sm"
                    title="结课作品已通过导师验收：这门课是「做出」的，不只是「听完」的"
                  >
                    🏆 已结课
                  </span>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-[#0f6e56]/0 transition-colors duration-200 group-hover:bg-[#0f6e56]/75">
                  <span className="opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 rounded-full bg-white px-4 py-1.5 text-[12px] font-semibold text-accent shadow-md">
                    {c.started ? "继续学习 →" : "开始学习 →"}
                  </span>
                </div>
              </div>
              <div className="flex flex-1 flex-col px-4 pt-3.5 pb-4">
                <div className="text-[14.5px] font-bold leading-snug line-clamp-2">{c.title}</div>
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <span className="rounded-full bg-[#f1efe8] px-1.5 py-px text-[10px] text-ink-soft">
                    {c.source || "AI 生成"}
                  </span>
                  <span>{fmtDate(c.createdAt || c.updatedAt)}</span>
                </div>
                <div className="mt-auto pt-3">
                  <CardProgress c={c} />
                </div>
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
