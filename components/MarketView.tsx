"use client";

// 精品课程：货架页。定位是"课程印刷厂的书店"——用户来这里扫的是「一门门成体系的课」。
// 页面四层：头部（定位句+搜索）→ 学习路线合集（编辑部排好的顺序，解决"22 门课我从哪开始"）
// → 操纵台（标签筛选+排序+计数）→ 货架网格（卡片：封面/价格/标题/受众/交付承诺/进度/可展开目录）。
// 不做置顶大卡：没有真人精选，假 curated 比没有更伤信任。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MarketCollection, MarketEntry } from "@/types";
import { CourseCover } from "./CourseCover";

const fmtHours = (min?: number) =>
  min && min > 0 ? (min / 60).toFixed(1).replace(/\.0$/, "") + " 小时" : "";

// 标价经 JSON 存取可能是浮点脏值（29.700000000000003），展示统一格式化
const fmtPrice = (n: number) => `¥${n.toFixed(n % 1 === 0 ? 0 : 1)}`;

type SortKey = "new" | "big" | "short";

export function MarketView({
  onOpenCourse,
  onGoHome,
}: {
  onOpenCourse: (courseId: string) => void;
  onGoHome: () => void;
}) {
  const [entries, setEntries] = useState<MarketEntry[] | null>(null);
  const [collections, setCollections] = useState<MarketCollection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("全部");
  const [col, setCol] = useState<MarketCollection | null>(null);
  const [sort, setSort] = useState<SortKey>("new");
  const [openSyllabus, setOpenSyllabus] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/market");
      const d = await res.json();
      setEntries(d.entries || []);
      setCollections(d.collections || []);
    } catch {
      setError("精品课程加载失败");
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeFromMarket = useCallback(
    async (courseId: string) => {
      setEntries((prev) => (prev ? prev.filter((e) => e.courseId !== courseId) : prev));
      const res = await fetch(`/api/market?courseId=${encodeURIComponent(courseId)}`, { method: "DELETE" });
      if (!res.ok) void refresh(); // 服务端拒绝（权限变化等）：回读真实列表，别让本地假删
    },
    [refresh]
  );

  const [reported, setReported] = useState<Set<string>>(new Set());
  const reportCourse = useCallback(async (courseId: string) => {
    const reason = window.prompt("请说明举报原因（内容侵权 / 违规 / 质量造假等）");
    if (!reason || reason.trim().length < 2) return;
    const res = await fetch("/api/market/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId, reason }),
    });
    if (res.ok) {
      setReported((prev) => new Set(prev).add(courseId));
    } else {
      const d = await res.json().catch(() => ({ error: "举报失败" }));
      setError(d.error || "举报失败");
    }
  }, []);

  // 标签按出现频次排序取前 8：高频标签是真实的分类，长尾标签留在卡面上
  const cats = useMemo(() => {
    const pool = col ? (entries || []).filter((e) => col.courseIds.includes(e.courseId)) : entries || [];
    const freq = new Map<string, number>();
    for (const e of pool) for (const t of e.tags || []) freq.set(t, (freq.get(t) || 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  }, [entries, col]);

  const shown = useMemo(() => {
    let list = entries || [];
    if (col) {
      // 路线内的课按合集顺序展示（即建议的学习顺序）
      list = col.courseIds.map((id) => list.find((e) => e.courseId === id)).filter(Boolean) as MarketEntry[];
    }
    if (cat !== "全部") list = list.filter((e) => (e.tags || []).includes(cat));
    const kw = q.trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(kw) ||
          (e.note || "").toLowerCase().includes(kw) ||
          (e.audience || "").toLowerCase().includes(kw) ||
          (e.capstone || "").toLowerCase().includes(kw) ||
          (e.tags || []).some((t) => t.toLowerCase().includes(kw))
      );
    }
    const sorted = [...list];
    if (sort === "big") sorted.sort((a, b) => (b.lectures || 0) - (a.lectures || 0));
    else if (sort === "short") sorted.sort((a, b) => (a.totalMin || 1e9) - (b.totalMin || 1e9));
    else if (!col) sorted.sort((a, b) => b.addedAt - a.addedAt);
    return sorted;
  }, [entries, q, cat, col, sort]);

  const toggleSyllabus = (courseId: string) => {
    setOpenSyllabus((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  };

  return (
    <div className="pb-16">
      {/* 头部：左标题右搜索，一句话说清这里卖的是什么 */}
      <div className="max-w-5xl mx-auto px-6 pt-10 pb-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-[24px] font-bold tracking-tight">精品课程</h1>
            <p className="mt-1 text-[13px] text-ink-soft">
              每一门都是 AI 现做的体系课：有单元、有练习、有结课作品
            </p>
          </div>
          <div className="relative w-full sm:w-[280px]">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索课程主题、标签…"
              className="w-full rounded-full border border-[#e4e4e7] bg-white pl-9 pr-4 py-2 text-[13px] outline-none focus:border-accent/60 shadow-sm"
            />
            <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </div>
        </div>
      </div>

      {entries === null && (
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex gap-3 flex-wrap mb-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-[84px] w-[240px] rounded-2xl" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="rounded-2xl border border-[#e4e4e7] bg-white overflow-hidden">
                <div className="skeleton w-full h-[110px]" />
                <div className="p-3.5">
                  <div className="skeleton h-4 w-3/4 rounded mb-2" />
                  <div className="skeleton h-3 w-1/2 rounded mb-3" />
                  <div className="skeleton h-3 w-2/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {entries && entries.length === 0 && (
        <div className="max-w-2xl mx-auto px-6">
          <div className="rounded-2xl border border-dashed border-[#d4d4d8] bg-white px-6 py-12 text-center">
            <div className="text-[14px] font-medium mb-1.5">精品课程还空着</div>
            <div className="text-[12.5px] text-ink-soft mb-5 leading-relaxed">
              去「课程记录」打开一门好课，在课程页点「上架到精品课程」，它就会公开出现在这里。
            </div>
            <button
              onClick={onGoHome}
              className="rounded-full bg-accent px-5 py-2 text-[12.5px] text-white font-medium hover:opacity-90"
            >
              回首页做一门课 →
            </button>
          </div>
        </div>
      )}

      {entries && entries.length > 0 && (
        <div className="max-w-5xl mx-auto px-6">
          {/* 学习路线：编辑部把散课排成"从入门到交付"的顺序——新客的入口，老客的导航 */}
          {collections.length > 0 && !q && (
            <div className="mb-6">
              <div className="flex items-baseline justify-between mb-2.5">
                <div className="text-[13px] font-semibold text-ink">学习路线</div>
                <div className="text-[10.5px] text-ink-faint">按顺序学，从入门走到交付</div>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1.5 -mx-1 px-1">
                {collections.map((c) => {
                  const inCol = (entries || []).filter((e) => c.courseIds.includes(e.courseId));
                  const totalHrs = fmtHours(inCol.reduce((s, e) => s + (e.totalMin || 0), 0));
                  const active = col?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCol(active ? null : c)}
                      className={`shrink-0 w-[248px] text-left rounded-2xl border p-3.5 transition-all ${
                        active
                          ? "border-accent bg-accent-soft/50 shadow-[0_4px_16px_rgba(0,0,0,0.06)]"
                          : "border-[#e4e4e7] bg-white hover:border-accent/50 hover:shadow-[0_4px_16px_rgba(0,0,0,0.05)]"
                      }`}
                    >
                      <div className="text-[13.5px] font-semibold text-ink leading-snug">{c.name}</div>
                      <div className="mt-1 text-[11px] text-ink-soft leading-relaxed line-clamp-2">{c.desc}</div>
                      <div className="mt-2 text-[10.5px] text-ink-faint">
                        {inCol.length} 门课{totalHrs ? ` · 约 ${totalHrs}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 操纵台：路线态 + 标签筛选 + 排序 + 计数 */}
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {col && (
              <button
                onClick={() => setCol(null)}
                className="rounded-full pl-3 pr-2 py-1.5 text-[12px] font-medium bg-accent text-white shadow-sm inline-flex items-center gap-1"
                title="退出当前路线"
              >
                {col.name} <span className="opacity-80">✕</span>
              </button>
            )}
            <button
              onClick={() => setCat("全部")}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                cat === "全部"
                  ? "bg-accent text-white shadow-sm"
                  : "bg-white border border-[#e4e4e7] text-ink-soft hover:border-accent/50 hover:text-accent"
              }`}
            >
              全部
            </button>
            {cats.map((t) => (
              <button
                key={t}
                onClick={() => setCat(t)}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                  cat === t
                    ? "bg-accent text-white shadow-sm"
                    : "bg-white border border-[#e4e4e7] text-ink-soft hover:border-accent/50 hover:text-accent"
                }`}
              >
                {t}
              </button>
            ))}
            <span className="flex-1" />
            <span className="text-[11.5px] text-ink-faint">{shown.length} 门课</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[12px] text-ink-soft outline-none focus:border-accent/60 cursor-pointer"
            >
              <option value="new">最新上架</option>
              <option value="big">课节最多</option>
              <option value="short">时长最短</option>
            </select>
          </div>

          {shown.length === 0 && (
            <div className="text-[13px] text-ink-faint py-8 text-center">
              {cat !== "全部" ? `分类「${cat}」下暂无课程` : `没有匹配「${q}」的课程`}
            </div>
          )}

          {/* 货架网格 */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((e) => {
              const expanded = openSyllabus.has(e.courseId);
              return (
                <div
                  key={e.courseId}
                  className="group rounded-2xl border border-[#e4e4e7] bg-white overflow-hidden flex flex-col hover:border-accent/60 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-all fade-up"
                >
                  <button onClick={() => onOpenCourse(e.courseId)} className="relative block w-full overflow-hidden text-left">
                    <CourseCover seed={e.courseId} title={e.title} rounded="rounded-none" className="w-full h-[110px] transition-transform duration-300 group-hover:scale-[1.03]" />
                    <span
                      className={`absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10.5px] font-semibold shadow-sm ${
                        e.price > 0 ? "bg-white/95 text-[#b45309]" : "bg-white/95 text-[#4d7c43]"
                      }`}
                    >
                      {e.price > 0 ? fmtPrice(e.price) : "免费"}
                    </span>
                    {e.author === "official" && (
                      <span className="absolute top-2 left-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-white shadow-sm">
                        官方精选
                      </span>
                    )}
                  </button>
                  <div className="p-3.5 flex flex-col flex-1">
                    <button onClick={() => onOpenCourse(e.courseId)} className="text-left text-[14.5px] font-semibold leading-snug line-clamp-2 hover:text-accent transition-colors">
                      {e.title}
                    </button>
                    {e.audience && (
                      <div className="mt-1 text-[11.5px] text-ink-faint leading-relaxed line-clamp-1" title={e.audience}>
                        {e.audience}
                      </div>
                    )}
                    {e.capstone && (
                      <div className="mt-1.5 text-[11.5px] text-ink-soft truncate" title={`结课作品：${e.capstone}`}>
                        🎓 交付：<span className="text-ink font-medium">{e.capstone}</span>
                      </div>
                    )}
                    {e.myProgress && (
                      <div className="mt-2">
                        <div className="h-1 rounded-full bg-[#f4f4f5] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-accent transition-all duration-500"
                            style={{ width: `${Math.round((e.myProgress.visited / e.myProgress.total) * 100)}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[10.5px] text-ink-faint">
                          已学 {e.myProgress.visited}/{e.myProgress.total} 讲
                        </div>
                      </div>
                    )}
                    <div className="mt-auto pt-3">
                      <div className="text-[11px] text-ink-soft">
                        {[e.units != null ? `${e.units} 单元` : "", e.lectures ? `${e.lectures} 课节` : "", fmtHours(e.totalMin)]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      {(e.syllabus?.length || 0) > 0 && (
                        <button
                          onClick={() => toggleSyllabus(e.courseId)}
                          className="mt-1.5 text-[11px] text-accent hover:underline"
                        >
                          {expanded ? "收起目录 ▴" : "看目录 ▾"}
                        </button>
                      )}
                      {expanded && e.syllabus && (
                        <ol className="mt-1.5 space-y-1 rounded-xl bg-[#fafafa] border border-[#f4f4f5] p-2.5">
                          {e.syllabus.map((s, i) => (
                            <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-ink-soft">
                              <span className="shrink-0 font-bold text-accent/80">{i + 1}.</span>
                              <span className="min-w-0">{s.title}</span>
                            </li>
                          ))}
                          {e.capstone && (
                            <li className="flex gap-1.5 border-t border-[#f0efe8] pt-1.5 mt-1.5 text-[11px] text-ink">
                              <span className="shrink-0">🏆</span>
                              <span className="min-w-0">交付：{e.capstone}</span>
                            </li>
                          )}
                        </ol>
                      )}
                      <div className="mt-2 pt-2.5 border-t border-[#f5f4ee] flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[10.5px] text-ink-faint/80">
                          {(e.tags || []).slice(0, 2).join(" · ")}
                        </span>
                        <span className="flex shrink-0 items-center gap-2.5">
                          {e.canDelete ? (
                            <button
                              onClick={() => void removeFromMarket(e.courseId)}
                              className="text-[11.5px] text-ink-faint hover:text-red-500 transition-colors"
                              title="从精品课程下架（课程本身不受影响）"
                            >
                              下架
                            </button>
                          ) : reported.has(e.courseId) ? (
                            <span className="text-[11.5px] text-ink-faint">已举报</span>
                          ) : (
                            <button
                              onClick={() => void reportCourse(e.courseId)}
                              className="text-[11.5px] text-ink-faint hover:text-accent transition-colors"
                              title="内容侵权 / 违规 / 质量造假时可举报"
                            >
                              举报
                            </button>
                          )}
                          <button
                            onClick={() => onOpenCourse(e.courseId)}
                            className="text-[12px] font-medium text-accent hover:opacity-80"
                          >
                            {e.myProgress ? "继续学习 →" : "去学习 →"}
                          </button>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="max-w-5xl mx-auto px-6 mt-4">
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>
        </div>
      )}
    </div>
  );
}
