"use client";

// 精品课程：官方精选 + 用户上架的课程。点开直接学；本机自用阶段，上架/下架即管理动作。
// 版式对标 Hyperknow 精品课程：居中大标题 + 搜索、首条 hero 大卡、徽标（课节/时长/价格）、
// 标签分类筛选条。评分/报名人数没有真实数据，不虚构。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MarketEntry } from "@/types";
import { CourseCover } from "./CourseCover";

const fmtHours = (min?: number) =>
  min && min > 0 ? (min / 60).toFixed(1).replace(/\.0$/, "") + " 小时" : "";

// 标价经 JSON 存取可能是浮点脏值（29.700000000000003），展示统一格式化
const fmtPrice = (n: number) => `¥${n.toFixed(n % 1 === 0 ? 0 : 1)}`;

export function MarketView({
  onOpenCourse,
  onGoHome,
}: {
  onOpenCourse: (courseId: string) => void;
  onGoHome: () => void;
}) {
  const [entries, setEntries] = useState<MarketEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("全部");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/market");
      const d = await res.json();
      setEntries(d.entries || []);
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

  const cats = useMemo(() => {
    const seen: string[] = [];
    for (const e of entries || []) for (const t of e.tags || []) if (!seen.includes(t)) seen.push(t);
    return seen.slice(0, 9);
  }, [entries]);

  const shown = useMemo(() => {
    let list = entries || [];
    if (cat !== "全部") list = list.filter((e) => (e.tags || []).includes(cat));
    const kw = q.trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(kw) ||
          (e.note || "").toLowerCase().includes(kw) ||
          (e.audience || "").toLowerCase().includes(kw)
      );
    }
    return list;
  }, [entries, q, cat]);

  const hero = shown[0];
  const rest = shown.slice(1);

  const MetaChips = ({ e }: { e: MarketEntry }) => (
    <div className="flex gap-1.5 flex-wrap">
      {(e.lectures ? [`${e.lectures} 课节`, fmtHours(e.totalMin)].filter(Boolean) : []).map((t) => (
        <span key={t} className="rounded-full bg-[#f4f4f5] px-2 py-0.5 text-[10.5px] text-ink-soft">
          {t}
        </span>
      ))}
    </div>
  );

  return (
    <div className="pb-16">
      {/* 头部 hero：居中大标题 + 搜索 */}
      <div className="text-center pt-12 pb-8 px-6">
        <h1 className="text-[30px] font-bold leading-tight mb-1.5">
          发现最适合你的课程
          <br />
          <span className="bg-[linear-gradient(transparent_62%,rgba(252,190,120,0.55)_62%)] px-0.5 text-[22px] font-semibold">
            专为你的学习方式打造
          </span>
        </h1>
        <div className="max-w-md mx-auto mt-6 relative">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="在精品课程中搜索课程"
            className="w-full rounded-full border border-[#e4e4e7] bg-white pl-10 pr-4 py-2.5 text-[13px] outline-none focus:border-accent/60 shadow-sm"
          />
          <svg viewBox="0 0 24 24" className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </div>
      </div>

      {entries === null && (
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex gap-1.5 flex-wrap mb-5">
            {["w-12", "w-16", "w-20", "w-14", "w-16"].map((w, i) => (
              <div key={i} className={`skeleton rounded-full h-[30px] ${w}`} />
            ))}
          </div>
          <div className="rounded-3xl border border-[#e4e4e7] bg-white overflow-hidden flex mb-5">
            <div className="skeleton w-[280px] shrink-0 min-h-[190px]" />
            <div className="flex-1 p-6 py-5">
              <div className="flex gap-2 mb-3">
                <div className="skeleton h-4 w-16 rounded-full" />
                <div className="skeleton h-4 w-10 rounded-full" />
              </div>
              <div className="skeleton h-6 w-2/3 rounded mb-3" />
              <div className="skeleton h-3.5 w-full rounded mb-2" />
              <div className="skeleton h-3.5 w-4/5 rounded mb-4" />
              <div className="flex gap-2">
                <div className="skeleton h-4 w-14 rounded-full" />
                <div className="skeleton h-4 w-16 rounded-full" />
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl border border-[#e4e4e7] bg-white overflow-hidden">
                <div className="skeleton w-full h-[104px]" />
                <div className="p-4">
                  <div className="skeleton h-3 w-24 rounded mb-2" />
                  <div className="skeleton h-4 w-3/4 rounded mb-2.5" />
                  <div className="skeleton h-3 w-1/2 rounded mb-3" />
                  <div className="flex gap-1.5">
                    <div className="skeleton h-4 w-14 rounded-full" />
                    <div className="skeleton h-4 w-16 rounded-full" />
                  </div>
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
          {/* 分类筛选条 */}
          <div className="flex gap-1.5 flex-wrap mb-5">
            {["全部", ...cats].map((t) => (
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
          </div>

          {shown.length === 0 && (
            <div className="text-[13px] text-ink-faint py-8 text-center">
              {cat !== "全部" ? `分类「${cat}」下暂无课程` : `没有匹配「${q}」的课程`}
            </div>
          )}

          {/* hero 大卡：置顶的第一门课 */}
          {hero && (
            <button
              onClick={() => onOpenCourse(hero.courseId)}
              className="group w-full text-left rounded-3xl border border-[#e4e4e7] bg-white overflow-hidden flex mb-5 hover:border-accent/60 hover:shadow-[0_6px_24px_rgba(0,0,0,0.07)] transition-all fade-up"
            >
              <div className="overflow-hidden">
                <CourseCover seed={hero.courseId} title={hero.title} rounded="rounded-none" className="w-[280px] shrink-0 min-h-[190px] h-full transition-transform duration-300 group-hover:scale-[1.03]" />
              </div>
              <div className="flex-1 min-w-0 p-6 flex flex-col">
                <div className="flex items-center gap-2 mb-2">
                  {hero.author === "official" && (
                    <span className="rounded-full bg-accent-soft text-accent px-2 py-0.5 text-[10px] font-medium">官方精选</span>
                  )}
                  <span className={`text-[11.5px] font-semibold ${hero.price > 0 ? "text-[#b45309]" : "rounded-full bg-[#eaf3e6] px-2 py-0.5 text-[10.5px] text-[#4d7c43]"}`}>
                    {hero.price > 0 ? fmtPrice(hero.price) : "免费"}
                  </span>
                </div>
                <div className="text-[20px] font-bold leading-snug mb-2 line-clamp-2">{hero.title}</div>
                <div className="text-[13px] text-ink-soft leading-relaxed line-clamp-3 flex-1">
                  {hero.note || hero.audience}
                </div>
                <div className="mt-3">
                  <MetaChips e={hero} />
                </div>
                <div className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-accent font-medium">
                  ▶ 去学习
                  <span className="inline-block transition-transform group-hover:translate-x-0.5">→</span>
                </div>
              </div>
            </button>
          )}

          {/* 其余课程网格 */}
          {rest.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {rest.map((e) => (
                <div
                  key={e.courseId}
                  className="group rounded-2xl border border-[#e4e4e7] bg-white overflow-hidden flex flex-col hover:border-accent/60 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-all fade-up"
                >
                  <button onClick={() => onOpenCourse(e.courseId)} className="block w-full overflow-hidden text-left">
                    <CourseCover seed={e.courseId} title={e.title} rounded="rounded-none" className="w-full h-[104px] transition-transform duration-300 group-hover:scale-[1.03]" />
                  </button>
                  <div className="p-4 flex flex-col flex-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[11px] text-ink-faint">{e.author === "official" ? "官方精选" : "学员上架"}</span>
                      <span className={`font-semibold ${e.price > 0 ? "text-[11.5px] text-[#b45309]" : "rounded-full bg-[#eaf3e6] px-2 py-0.5 text-[10.5px] text-[#4d7c43]"}`}>
                        {e.price > 0 ? fmtPrice(e.price) : "免费"}
                      </span>
                    </div>
                    <button onClick={() => onOpenCourse(e.courseId)} className="text-left text-[15px] font-semibold leading-snug mb-1 line-clamp-2 hover:text-accent transition-colors">
                      {e.title}
                    </button>
                    {(e.note || e.audience) && (
                      <div className="text-[12px] text-ink-soft leading-relaxed line-clamp-2 mb-2.5 flex-1">
                        {e.note || e.audience}
                      </div>
                    )}
                    <MetaChips e={e} />
                    <div className="mt-3 pt-2.5 border-t border-[#f5f4ee] flex items-center justify-between">
                      <button
                        onClick={() => onOpenCourse(e.courseId)}
                        className="text-[12px] text-accent font-medium hover:opacity-80"
                      >
                        ▶ 去学习
                      </button>
                      {e.canDelete ? (
                        <button
                          onClick={() => void removeFromMarket(e.courseId)}
                          className="text-[11.5px] text-ink-faint hover:text-red-500 transition-colors"
                          title="从精品课程下架（课程本身不受影响）"
                        >
                          下架
                        </button>
                      ) : reported.has(e.courseId) ? (
                        <span className="text-[11.5px] text-ink-faint">已举报，待处理</span>
                      ) : (
                        <button
                          onClick={() => void reportCourse(e.courseId)}
                          className="text-[11.5px] text-ink-faint hover:text-accent transition-colors"
                          title="内容侵权 / 违规 / 质量造假时可举报"
                        >
                          举报
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
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
