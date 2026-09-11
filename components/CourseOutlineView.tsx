"use client";

// 课程详情页：一屏看懂「这是什么课 · 学到哪了 · 下一讲学什么」。
// 旧版左右两栏把 8 个单元全部平铺 + 每行挂标签 chip，信息密度过高（用户反馈"密密麻麻吓人"）；
// 现在收成单列：hero（标题/进度/继续学习 CTA）→ 结课作品承诺 → 追加材料 → 单元手风琴
// （默认只展开下一讲所在的单元，行内只留 讲次/标题/时长/按钮，标签噪声全部收掉）。
import type { CourseOutline } from "@/types";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { uploadTextbookPdf } from "@/lib/textbook-client";
import { fmtDuration } from "@/lib/format";
import { CourseCover } from "./CourseCover";
import { Icon } from "./icons";

interface CourseOutlineViewProps {
  outline: CourseOutline;
  courseId: string;
  visited: Set<string>;
}

type LectureLike = CourseOutline["units"][number]["lectures"][number];

const isLearnable = (l: LectureLike) => l.content_type === "whiteboard" || !l.content_type;

export function CourseOutlineView({ outline, courseId, visited }: CourseOutlineViewProps) {
  const router = useRouter();
  // 课程页三方案切换（用户选定后把选中的方案固化成唯一实现，切换器下线）
  const [variant, setVariant] = useState<"a" | "b" | "c">(() => {
    if (typeof window === "undefined") return "a";
    const u = new URLSearchParams(window.location.search).get("v");
    if (u === "b" || u === "c") return u;
    try { const v = localStorage.getItem("ll:course-variant"); if (v === "b" || v === "c") return v; } catch {}
    return "a";
  });
  const pickVariant = (v: "a" | "b" | "c") => {
    setVariant(v);
    try { localStorage.setItem("ll:course-variant", v); } catch {}
  };
  // 上架到精品课程：好课标个价放进精品课，别人点开就能学
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketPrice, setMarketPrice] = useState("");
  const [marketNote, setMarketNote] = useState("");
  const [marketState, setMarketState] = useState<"idle" | "saving" | "done" | "error">("idle");
  // 课程内追加材料（原版同款「上传材料，扩展这门课程」）：先收文件，融入课程的后端在下一迭代
  const [materialName, setMaterialName] = useState<string | null>(null);
  const [materialState, setMaterialState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const materialRef = useRef<HTMLInputElement | null>(null);
  // 结课进度：本学员的测验通过清单 + 结课作品是否已交付（徽章来自真实记录，不是装饰）
  const [quizPassed, setQuizPassed] = useState<Map<string, boolean>>(new Map());
  const [capstonePassed, setCapstonePassed] = useState(false);
  // 手风琴：默认展开"下一讲"所在的单元（没学过就展开第 1 单元）
  const allLectures = outline.units.flatMap((u) => u.lectures);
  const learnableLectures = allLectures.filter(isLearnable);
  const visitedCount = learnableLectures.filter((l) => visited.has(l.id)).length;
  const nextLecture = learnableLectures.find((l) => !visited.has(l.id)) || null;
  const firstOpenUnit =
    outline.units.find((u) => nextLecture && u.lectures.some((l) => l.id === nextLecture.id))?.id ||
    outline.units[0]?.id ||
    "";
  const [openUnits, setOpenUnits] = useState<Set<string>>(new Set([firstOpenUnit]));

  useEffect(() => {
    let alive = true;
    fetch(`/api/quiz?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !Array.isArray(d?.records)) return;
        const map = new Map<string, boolean>();
        for (const r of d.records) map.set(r.lectureId, Boolean(r.passed));
        setQuizPassed(map);
      })
      .catch(() => {});
    fetch(`/api/capstone?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setCapstonePassed(Boolean(d?.record?.passed));
      })
      .catch(() => {});
    const onCoursesChanged = () => {
      fetch(`/api/quiz?courseId=${encodeURIComponent(courseId)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive || !Array.isArray(d?.records)) return;
          const map = new Map<string, boolean>();
          for (const r of d.records) map.set(r.lectureId, Boolean(r.passed));
          setQuizPassed(map);
        })
        .catch(() => {});
    };
    window.addEventListener("ll:courses-changed", onCoursesChanged);
    return () => {
      alive = false;
      window.removeEventListener("ll:courses-changed", onCoursesChanged);
    };
  }, [courseId]);

  const uploadMaterial = async (file: File) => {
    setMaterialState("uploading");
    setMaterialName(file.name);
    try {
      // 与首页上传同流程：浏览器端抽取（Workers 服务端扛不动解析），扫描版回退文件上传
      await uploadTextbookPdf(file);
      setMaterialState("done");
    } catch {
      setMaterialState("error");
    }
  };

  const totalLectures = allLectures.length;
  const totalMin = learnableLectures.reduce((t, l) => t + (l.duration_min || 0), 0);
  const completed = learnableLectures.length > 0 && visitedCount >= learnableLectures.length;
  // 课节的结课状态（徽章跟学员的真实记录走）
  const projectLecture = allLectures.find((l) => l.content_type === "project");
  const toggleUnit = (unitId: string) => {
    setOpenUnits((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  };

  const publishToMarket = async () => {
    setMarketState("saving");
    try {
      const res = await fetch("/api/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          price: Number(marketPrice) || 0,
          note: marketNote.trim() || undefined,
        }),
      });
      setMarketState(res.ok ? "done" : "error");
    } catch {
      setMarketState("error");
    }
  };

  // 进入课节（原版同款：点"学习"开白板课堂）—— 独立路由，可刷新、可后退
  const openLecture = (lec: { id: string; title: string }) => {
    router.push(`/learn/${courseId}/${lec.id}`);
  };

  /* 方案 A：封面横幅 + 文档正文（当前线上版） */
  const VariantA = () => (
    <div className="max-w-[760px] mx-auto pt-10 px-6 pb-24">
      {/* 封面横幅：给页面一个视觉头图（母题居中、色场铺满） */}
      <CourseCover
        seed={courseId}
        title={outline.title}
        className="h-[190px] w-full rounded-2xl border border-[#e4e4e7] shadow-[0_6px_28px_rgba(24,24,27,0.06)]"
        rounded="rounded-2xl"
      />

      {/* 文档头：标题 → 受众 → 进度 → 继续学习 */}
      <header className="mt-7">
        <h1 className="text-[26px] font-bold leading-snug tracking-tight">{outline.title}</h1>
        <p className="mt-2 text-[14px] text-ink-soft leading-relaxed">{outline.audience}</p>
        {outline.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-faint">
            {outline.tags.slice(0, 5).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}

        <div className="mt-6 flex items-center gap-3">
          <span className="shrink-0 text-[13px] font-medium">
            已学 {visitedCount} / {learnableLectures.length} 讲
          </span>
          <div className="h-1 flex-1 rounded-full bg-[#e4e4e7] overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: `${Math.max((visitedCount / Math.max(learnableLectures.length, 1)) * 100, visitedCount > 0 ? 3 : 0)}%` }}
            />
          </div>
          <span className="shrink-0 text-[12px] text-ink-faint">
            {outline.units.length} 单元 · {totalLectures} 节{totalMin > 0 ? ` · ${fmtDuration(totalMin)}` : ""}
          </span>
        </div>

        <div className="mt-5 flex items-center gap-3">
          {completed ? (
            <button
              onClick={() => nextLecture && openLecture(nextLecture)}
              className="rounded-lg bg-[#18181b] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#3f3f46]"
            >
              🎉 已学完 · 随意复习
            </button>
          ) : (
            <>
              <button
                onClick={() => nextLecture && openLecture(nextLecture)}
                className="shrink-0 rounded-lg bg-[#18181b] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#3f3f46]"
              >
                ▶ {visitedCount > 0 ? "继续学习" : "开始学习"}
              </button>
              {nextLecture && (
                <div className="min-w-0 truncate text-[12.5px] text-ink-faint">
                  下一讲：<span className="text-ink-soft">{nextLecture.title}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-4 text-[12px] text-ink-faint">
          <button
            onClick={() => materialRef.current?.click()}
            disabled={materialState === "uploading"}
            className="transition-colors hover:text-accent disabled:opacity-50"
          >
            上传材料
          </button>
          {!marketOpen && (
            <button
              onClick={() => {
                setMarketOpen(true);
                setMarketState("idle");
              }}
              className="transition-colors hover:text-accent"
            >
              上架到精品课程
            </button>
          )}
          <span className="flex-1" />
          <span className="text-[10.5px] text-ink-faint/80">内容由 AI 生成，请以权威来源为准</span>
        </div>
        <input
          ref={materialRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadMaterial(f);
            e.target.value = "";
          }}
        />
        {(materialState !== "idle" || marketState === "done") && (
          <div className="mt-3 text-[11.5px]">
            {materialState === "done" && <div className="text-[#4d7c43]">✓ 已解析入库《{materialName}》（纳入讲解的能力开发中，先帮你存好了）</div>}
            {materialState === "uploading" && <div className="text-ink-faint">正在解析《{materialName}》…</div>}
            {materialState === "error" && <div className="text-red-600">《{materialName}》解析失败，换个文件试试</div>}
            {marketState === "done" && <div className="text-[#4d7c43]">✓ 已上架精品课程，所有访客都能看到</div>}
          </div>
        )}
        {marketOpen && marketState !== "done" && (
          <div className="mt-3 rounded-xl border border-[#e4e4e7] bg-[#fafafa] p-3 space-y-2">
            <input
              value={marketNote}
              onChange={(e) => setMarketNote(e.target.value)}
              placeholder="一句话推荐语（可选）"
              className="w-full rounded-lg border border-[#e4e4e7] px-2.5 py-1.5 text-[12px] outline-none focus:border-accent bg-white"
            />
            <div className="flex items-center gap-2">
              <input
                value={marketPrice}
                onChange={(e) => setMarketPrice(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="标价，留空 = 免费"
                className="flex-1 min-w-0 rounded-lg border border-[#e4e4e7] px-2.5 py-1.5 text-[12px] outline-none focus:border-accent bg-white"
              />
              <button
                onClick={() => void publishToMarket()}
                disabled={marketState === "saving"}
                className="shrink-0 rounded-lg bg-[#18181b] px-3.5 py-1.5 text-[12px] text-white font-medium hover:bg-[#3f3f46] disabled:opacity-40"
              >
                {marketState === "saving" ? "上架中…" : "确认上架"}
              </button>
              <button onClick={() => setMarketOpen(false)} className="shrink-0 text-[11.5px] text-ink-faint hover:text-ink">
                取消
              </button>
            </div>
            {marketState === "error" && <div className="text-[11px] text-red-600">上架失败，稍后再试</div>}
          </div>
        )}
      </header>

      <hr className="my-9 border-[#e4e4e7]" />

      {/* 结课作品：文档式一段，不是横幅卡片 */}
      {outline.capstone?.name && (
        <section className="mb-9">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-accent">🎯 结课作品 · 学完你将亲手做出</div>
          <div className="mt-1.5 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[16px] font-semibold text-ink">{outline.capstone.name}</div>
              {outline.capstone.description && (
                <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">{outline.capstone.description}</p>
              )}
            </div>
            {projectLecture && (
              <button
                onClick={() => openLecture(projectLecture)}
                className={`shrink-0 self-center rounded-lg px-3.5 py-2 text-[12px] font-medium transition-colors ${
                  capstonePassed ? "border border-[#e4e4e7] text-ink-soft hover:border-accent hover:text-accent" : "bg-accent text-white hover:opacity-90"
                }`}
              >
                {capstonePassed ? "已结课" : "进入结课工坊 →"}
              </button>
            )}
          </div>
        </section>
      )}

      <hr className="mb-10 border-[#e4e4e7]" />

      {/* 单元目录：文档树（已学实心 / 当前高亮 / 未学空心），点行即学 */}
      <div>
        {outline.units.map((unit, ui) => {
          const open = openUnits.has(unit.id);
          const unitLearnable = unit.lectures.filter(isLearnable);
          const unitVisited = unitLearnable.filter((l) => visited.has(l.id)).length;
          const isCurrentUnit = Boolean(nextLecture && unit.lectures.some((l) => l.id === nextLecture.id));
          return (
            <section key={unit.id} className="mb-8">
              <button onClick={() => toggleUnit(unit.id)} className="group flex w-full items-baseline gap-3 text-left">
                <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${isCurrentUnit ? "text-accent" : "text-ink-faint"}`}>
                  {String(ui + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-[15px] font-semibold leading-snug text-ink transition-colors group-hover:text-accent">
                    {unit.title}
                  </span>
                  <span className="ml-2 text-[12px] text-ink-faint">
                    {unit.lectures.length} 讲{unitVisited > 0 ? ` · 已学 ${unitVisited}` : ""}
                  </span>
                </span>
                <span className={`shrink-0 text-[11px] text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
              </button>

              {open && (
                <>
                  {unit.summary && (
                    <p className="mt-2 pl-8 text-[12.5px] leading-relaxed text-ink-soft">{unit.summary}</p>
                  )}
                  <div className="ml-[7px] mt-2 border-l border-[#e4e4e7]">
                    {unit.lectures.map((lec) => {
                      const done = visited.has(lec.id);
                      const isNext = nextLecture?.id === lec.id;
                      return (
                        <div
                          key={lec.id}
                          onClick={() => openLecture(lec)}
                          className={`-ml-px flex cursor-pointer items-center gap-3 border-l-2 py-2 pl-4 pr-2 transition-colors ${
                            isNext ? "border-accent bg-accent/[0.04]" : "border-transparent hover:bg-[#fafafa]"
                          }`}
                        >
                          <span
                            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] ${
                              done
                                ? "bg-accent text-white"
                                : isNext
                                  ? "border-[1.5px] border-accent text-accent"
                                  : "border-[1.5px] border-[#d4d4d8] text-transparent"
                            }`}
                            aria-hidden
                          >
                            {done ? "✓" : "•"}
                          </span>
                          <span className={`min-w-0 flex-1 truncate text-[13px] ${done ? "text-ink-faint" : isNext ? "font-medium text-ink" : "text-ink"}`}>
                            {lec.title}
                          </span>
                          {lec.content_type === "quiz" ? (
                            <span className={`shrink-0 text-[11.5px] ${quizPassed.get(lec.id) ? "text-[#4d7c43]" : "text-ink-faint"}`}>
                              {quizPassed.get(lec.id) ? "✓ 测验通过" : "📝 单元测验"}
                            </span>
                          ) : lec.content_type === "project" ? (
                            <span className={`shrink-0 text-[11.5px] ${capstonePassed ? "text-[#4d7c43]" : "text-ink-faint"}`}>
                              {capstonePassed ? "✓ 已结课" : "🏆 结课作品"}
                            </span>
                          ) : (
                            <span className="shrink-0 text-[11px] text-ink-faint">{lec.duration_min} 分钟</span>
                          )}
                          <span
                            className={`shrink-0 text-[12px] font-medium text-accent transition-opacity ${
                              isNext ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            {lec.content_type === "quiz"
                              ? quizPassed.get(lec.id) ? "" : "去测验 →"
                              : lec.content_type === "project"
                                ? capstonePassed ? "" : "去结课工坊 →"
                                : done ? "复习 →" : "▶ 学习"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
  /* 方案 B：课堂前奏（暖阳白板语言延续到课程页） */
  const VariantB = () => (
    <div className="classroom-sunny min-h-screen bg-[#fffcf4]">
      <div className="mx-auto max-w-[720px] px-6 pt-10 pb-24">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#eadfc8] bg-white px-3 py-1 text-[11.5px] text-ink-soft">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          白板讲师课 · {visitedCount > 0 ? `已学 ${visitedCount}/${learnableLectures.length} 讲` : `${learnableLectures.length} 讲`}
        </div>
        <h1 className="mt-4 text-[28px] font-bold leading-snug tracking-tight text-ink">{outline.title}</h1>
        <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">{outline.audience}</p>

        {!completed && nextLecture && (
          <button
            onClick={() => openLecture(nextLecture)}
            className="mt-5 flex w-full items-center justify-between rounded-2xl bg-accent px-5 py-4 text-left text-white shadow-[0_8px_28px_rgb(var(--accent-rgb)/0.35)] transition-transform hover:-translate-y-0.5"
          >
            <span>
              <span className="block text-[11px] opacity-85">{visitedCount > 0 ? "继续学习 · 下一讲" : "开始学习 · 第 1 讲"}</span>
              <span className="block text-[14.5px] font-semibold leading-snug">{nextLecture.title}</span>
            </span>
            <span className="text-[20px] leading-none">▶</span>
          </button>
        )}

        <div className="mt-6 rounded-2xl border border-[#eadfc8] bg-white p-5 shadow-[0_4px_20px_rgba(120,80,20,0.06)]">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-accent">🎯 结课作品 · 学完你将亲手做出</div>
          <div className="mt-1.5 text-[16px] font-semibold text-ink">{outline.capstone?.name}</div>
          {outline.capstone?.description && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{outline.capstone.description}</p>
          )}
        </div>

        <div className="mt-6 space-y-4">
          {outline.units.map((unit, ui) => {
            const open = openUnits.has(unit.id);
            const unitVisited = unit.lectures.filter((l) => visited.has(l.id)).length;
            return (
              <div key={unit.id} className="rounded-2xl border border-[#eadfc8] bg-white p-4 shadow-[0_4px_20px_rgba(120,80,20,0.05)]">
                <button onClick={() => toggleUnit(unit.id)} className="flex w-full items-center gap-3 text-left">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-[12px] font-bold text-accent">{ui + 1}</span>
                  <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{unit.title}</span>
                  <span className="shrink-0 text-[11px] text-ink-faint">{unitVisited}/{unit.lectures.length}</span>
                  <span className={`shrink-0 text-[11px] text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                </button>
                {open && (
                  <div className="mt-2 space-y-0.5 border-t border-[#f7edda] pt-2">
                    {unit.lectures.map((lec) => {
                      const done = visited.has(lec.id);
                      const isNext = nextLecture?.id === lec.id;
                      return (
                        <div
                          key={lec.id}
                          onClick={() => openLecture(lec)}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors ${isNext ? "bg-accent-soft" : "hover:bg-[#faf4ea]"}`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? "bg-accent text-white" : "border-[1.5px] border-[#e0d6c2] text-transparent"}`}>{done ? "✓" : "·"}</span>
                          <span className={`min-w-0 flex-1 truncate text-[13px] ${done ? "text-ink-faint" : "text-ink"}`}>{lec.title}</span>
                          <span className="shrink-0 text-[11px] text-ink-faint">{lec.duration_min} 分钟</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
  /* 方案 C：学习仪表盘（进度环 + 统计 + 单元卡） */
  const pct = Math.round((visitedCount / Math.max(learnableLectures.length, 1)) * 100);
  const Ring = () => (
    <svg viewBox="0 0 84 84" className="h-[84px] w-[84px]">
      <circle cx="42" cy="42" r="34" fill="none" stroke="#e4e4e7" strokeWidth="8" />
      <circle
        cx="42" cy="42" r="34" fill="none" stroke="rgb(var(--accent-rgb))" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${(213.6 * pct) / 100} 999`} transform="rotate(-90 42 42)"
      />
      <text x="42" y="41" textAnchor="middle" className="fill-[#18181b] text-[17px] font-bold">{pct}%</text>
      <text x="42" y="57" textAnchor="middle" className="fill-[#a1a1aa] text-[9px]">完成</text>
    </svg>
  );
  const VariantC = () => (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[840px] pt-10 px-6 pb-24">
        <h1 className="text-[24px] font-bold leading-snug tracking-tight">{outline.title}</h1>
        <p className="mt-1.5 text-[13px] text-ink-soft">{outline.audience}</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-[#e4e4e7] bg-white p-4 flex items-center gap-3">
            <Ring />
            <div className="text-[12px] text-ink-faint leading-relaxed">课程进度<br /><span className="text-[13px] text-ink font-medium">已学 {visitedCount}/{learnableLectures.length} 讲</span></div>
          </div>
          <div className="rounded-2xl border border-[#e4e4e7] bg-white p-4">
            <div className="text-[11px] text-ink-faint">课程体量</div>
            <div className="mt-1.5 text-[20px] font-bold text-ink">{totalLectures} <span className="text-[12px] font-normal text-ink-faint">课节</span></div>
            <div className="mt-1 text-[11.5px] text-ink-faint">{outline.units.length} 个单元{totalMin > 0 ? ` · ${fmtDuration(totalMin)}` : ""}</div>
          </div>
          <div className="rounded-2xl border border-[#e4e4e7] bg-white p-4">
            <div className="text-[11px] text-ink-faint">结课作品</div>
            <div className="mt-1.5 text-[13.5px] font-semibold leading-snug text-ink">{outline.capstone?.name || "—"}</div>
            {projectLecture && !capstonePassed && (
              <button onClick={() => openLecture(projectLecture)} className="mt-1 text-[11.5px] text-accent hover:underline">去结课工坊 →</button>
            )}
          </div>
        </div>

        {!completed && nextLecture && (
          <div className="mt-4 flex items-center gap-4 rounded-2xl bg-[#18181b] p-5 text-white">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] opacity-70">{visitedCount > 0 ? "继续学习 · 下一讲" : "开始学习 · 第 1 讲"}</div>
              <div className="truncate text-[15px] font-semibold">{nextLecture.title}</div>
            </div>
            <button onClick={() => openLecture(nextLecture)} className="shrink-0 rounded-full bg-white px-4 py-2 text-[12.5px] font-semibold text-[#18181b] hover:opacity-90">
              ▶ 开始本讲
            </button>
          </div>
        )}

        <div className="mt-6 space-y-3">
          {outline.units.map((unit, ui) => {
            const open = openUnits.has(unit.id);
            const unitLearnable = unit.lectures.filter(isLearnable);
            const unitVisited = unitLearnable.filter((l) => visited.has(l.id)).length;
            const unitPct = Math.round((unitVisited / Math.max(unitLearnable.length, 1)) * 100);
            return (
              <div key={unit.id} className="rounded-2xl border border-[#e4e4e7] bg-white p-4">
                <button onClick={() => toggleUnit(unit.id)} className="flex w-full items-center gap-3 text-left">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#f4f4f5] text-[12px] font-bold text-ink">{ui + 1}</span>
                  <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{unit.title}</span>
                  <span className="shrink-0 text-[11px] text-ink-faint">{unitPct}%</span>
                  <span className={`shrink-0 text-[11px] text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                </button>
                <div className="mt-2 h-1 rounded-full bg-[#f4f4f5] overflow-hidden">
                  <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${unitPct}%` }} />
                </div>
                {open && (
                  <div className="mt-2 space-y-0.5 border-t border-[#f4f4f5] pt-2">
                    {unit.lectures.map((lec) => {
                      const done = visited.has(lec.id);
                      const isNext = nextLecture?.id === lec.id;
                      return (
                        <div key={lec.id} onClick={() => openLecture(lec)} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors ${isNext ? "bg-accent-soft/60" : "hover:bg-[#fafafa]"}`}>
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? "bg-accent text-white" : "border-[1.5px] border-[#d4d4d8] text-transparent"}`}>{done ? "✓" : "·"}</span>
                          <span className={`min-w-0 flex-1 truncate text-[13px] ${done ? "text-ink-faint" : "text-ink"}`}>{lec.title}</span>
                          <span className="shrink-0 text-[11px] text-ink-faint">{lec.duration_min} 分钟</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {variant === "a" && <VariantA />}
      {variant === "b" && <VariantB />}
      {variant === "c" && <VariantC />}

      {/* 方案切换器：用户选定后删除 */}
      <div className="fixed bottom-4 right-4 z-[200] flex items-center gap-1 rounded-full bg-[#18181b] p-1 shadow-xl">
        <span className="px-2 text-[10.5px] text-white/60">课程页方案</span>
        {(["a", "b", "c"] as const).map((v) => (
          <button
            key={v}
            onClick={() => pickVariant(v)}
            className={`h-7 min-w-7 rounded-full px-2.5 text-[11px] font-bold transition-colors ${variant === v ? "bg-white text-[#18181b]" : "text-white/70 hover:text-white"}`}
          >
            {v.toUpperCase()}
          </button>
        ))}
      </div>
    </>
  );
}
