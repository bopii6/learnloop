"use client";

// 课程记录：我自己生成的全部课程。点开即进入课程详情学习。
// 页面对标 Hyperknow「我的课程」：顶部「从上次学到的地方继续」+ 课程卡片网格（封面头图/新角标/进度条/悬浮继续学习）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { CourseCover } from "./CourseCover";
import { fmtDuration } from "@/lib/format";

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
type SortKey = "recent" | "created" | "title";

const isNew = (c: RecordCourse) =>
  Boolean(c.createdAt && Date.now() - c.createdAt < 12 * 3600 * 1000);

const fmtDate = (ms: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
};

/** 主题相近检测：把标题里的"从X到Y"式副标题去掉后比较主干，主干撞车视为相近 */
function duplicateGroups(courses: RecordCourse[]): Map<string, RecordCourse[]> {
  const groups = new Map<string, RecordCourse[]>();
  for (const c of courses) {
    const base = c.title
      .replace(/[:：].*$/, "")
      .replace(/[（(].*?[)）]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (!base) continue;
    const list = groups.get(base) || [];
    list.push(c);
    groups.set(base, list);
  }
  for (const [k, g] of groups) if (g.length < 2) groups.delete(k);
  return groups;
}

/** 进度区（继续学习大卡用）：进度条 + 下一讲。已学讲数 + 进度条就够，不再叠一个百分比 */
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
            <span className="text-ink-faint"> · 约 {fmtDuration(c.totalMin)}</span>
          </span>
          {c.completed && <span className="text-accent font-semibold">✓ 全部学完</span>}
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
      共 {learnable || c.lectures} 讲 · {fmtDuration(c.totalMin)} · 还没开始
    </div>
  );
}

/** 卡片底部进度区：紧凑版，不含下一讲文案。同一信息只编码一次：讲数 + 条，不重复给百分比 */
function CardProgress({ c }: { c: RecordCourse }) {
  const learnable = c.learnable || 0;
  const visited = c.visitedCount || 0;
  if (c.started && learnable > 0) {
    const pct = Math.min(100, Math.round((visited / learnable) * 100));
    return (
      <div>
        <div className="text-[11px] text-ink-soft mb-1">
          已学 {visited} / {learnable} 讲
          {c.completed && <span className="text-accent font-semibold ml-1.5">✓ 学完</span>}
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
      共 {learnable || c.lectures} 讲 · {fmtDuration(c.totalMin)}
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
  const [sort, setSort] = useState<SortKey>("recent");
  const [pendingDelete, setPendingDelete] = useState<RecordCourse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dupBannerDismissed, setDupBannerDismissed] = useState(false);

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
    const sorted = [...list];
    if (sort === "recent") {
      // 列表接口默认按最近学习排序，这里只保证稳定
      sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } else if (sort === "created") {
      sorted.sort((a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0));
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    }
    return sorted;
  }, [courses, q, filter, sort]);

  const doingCount = (courses || []).filter((c) => c.started).length;
  const todoCount = (courses || []).filter((c) => !c.started).length;
  const totalHours = (courses || []).reduce((s, c) => s + (c.totalMin || 0), 0) / 60;
  const dupGroups = useMemo(() => duplicateGroups(courses || []), [courses]);
  const dupCount = Array.from(dupGroups.values()).reduce((s, g) => s + g.length, 0);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/courses/${pendingDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`删除失败 (${res.status})`);
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  // 「从上次学到的地方继续」：最近真的在学的那门（列表已按 lastStudy 排好序）
  const pickup = useMemo(() => (courses || []).find((c) => c.started) || null, [courses]);

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `全部${courses ? ` ${courses.length}` : ""}` },
    { key: "doing", label: `进行中 ${doingCount}` },
    { key: "todo", label: `未开始 ${todoCount}` },
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
            <CourseCover seed={pickup.id} title={pickup.title} className="w-[132px] h-[88px]" />
            <span className="absolute left-1/2 -translate-x-1/2 -bottom-2.5 whitespace-nowrap rounded-full bg-accent px-4 py-1 text-[11.5px] text-white font-medium shadow-md transition-transform group-hover:scale-[1.04]">
              继续学习 →
            </span>
          </div>
        </button>
      )}

      {courses && courses.length > 0 && (
        <div className="flex gap-1.5 mb-5 items-center">
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
          <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ink-faint">
            排序
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-[#e7e5dc] bg-white px-2 py-1 text-[11.5px] text-ink-soft outline-none focus:border-accent/60"
            >
              <option value="recent">最近学习</option>
              <option value="created">创建时间</option>
              <option value="title">标题</option>
            </select>
          </label>
        </div>
      )}

      {/* 重复建课提示：主题相近的课程扎堆时轻轻说一句，不拦着 */}
      {courses && courses.length >= 4 && dupGroups.size > 0 && !dupBannerDismissed && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#efe8d2] bg-[#fdf9ee] px-4 py-3 text-[12.5px] text-ink-soft">
          <span className="shrink-0 font-semibold text-accent">提示</span>
          <span className="flex-1 leading-relaxed">
            有 {dupGroups.size} 组主题相近的课程（共 {dupCount} 门），可能是重复创建的。不需要的可以在卡片上删除。
          </span>
          <button
            onClick={() => setDupBannerDismissed(true)}
            className="shrink-0 text-ink-faint hover:text-ink"
            aria-label="关闭提示"
          >
            ×
          </button>
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
            <div key={c.id} className="relative group card-fade-up" style={{ animationDelay: `${Math.min(idx, 8) * 45}ms` }}>
              <button
                onClick={() => onOpenCourse(c.id)}
                aria-label={`${c.started ? "继续学习" : "开始学习"}：${c.title}`}
                className="w-full text-left rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/45 hover:shadow-[0_10px_28px_rgba(26,26,24,0.09)]"
              >
                {/* 封面头图：左上角标堆（新/学完），右上角留给删除按钮 */}
                <div className="relative shrink-0">
                  <CourseCover seed={c.id} title={c.title} rounded="rounded-none" className="w-full h-[110px]" />
                  {(isNew(c) || c.completed) && (
                    <div className="absolute top-2.5 left-2.5 flex gap-1.5">
                      {isNew(c) && (
                        <span className="rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-accent shadow-sm">
                          新
                        </span>
                      )}
                      {c.completed && (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                          ✓ 已学完
                        </span>
                      )}
                    </div>
                  )}
                  {c.capstoneDone && (
                    <span
                      className="absolute bottom-2.5 left-2.5 rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-accent shadow-sm"
                      title="结课作品已通过导师验收：这门课是「做出」的，不只是「听完」的"
                    >
                      已结课
                    </span>
                  )}
                  <div aria-hidden className="absolute inset-0 flex items-center justify-center bg-[#0f6e56]/0 transition-colors duration-200 group-hover:bg-[#0f6e56]/75">
                    <span aria-hidden className="opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 rounded-full bg-white px-4 py-1.5 text-[12px] font-semibold text-accent shadow-md">
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
              {/* 删除：卡片右上角的独立按钮，悬停浮现——不嵌在卡片按钮里（嵌套交互元素既不合法也误触） */}
              <button
                onClick={() => setPendingDelete(c)}
                aria-label={`删除课程：${c.title}`}
                title="删除这门课"
                className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-white/95 shadow-sm flex items-center justify-center text-ink-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-600 transition-opacity"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-13M9 7V4h6v3" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>
      )}

      {/* 删除确认：课程连同学习记录一起消失，不可恢复，必须确认一次 */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#2b2a26]/45 backdrop-blur-[2px]" onClick={() => !deleting && setPendingDelete(null)}>
          <div
            className="w-[400px] max-w-[88%] rounded-3xl border border-[#e7e5dc] bg-white shadow-2xl p-6 fade-up"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="删除课程确认"
          >
            <div className="text-[16px] font-bold text-ink mb-1.5">删除这门课？</div>
            <div className="text-[13px] text-ink-soft leading-relaxed mb-1.5 line-clamp-2">{pendingDelete.title}</div>
            <div className="text-[12px] text-ink-faint leading-relaxed mb-5">
              学习进度、课堂回放、测验和结课作品会一起删除，无法恢复。
            </div>
            <div className="flex gap-2.5 justify-end">
              <button
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="rounded-lg border border-[#e7e5dc] px-4 py-2 text-[12.5px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-[12.5px] text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
