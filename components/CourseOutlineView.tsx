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
  // 上架到精品课程：好课标个价放进精品课，别人点开就能学
  const [marketOpen, setMarketOpen] = useState(false);
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

  // 体系门面（学习路径条）的跳转：没展开先展开，再滚到对应单元卡
  const jumpToUnit = (unitId: string) => {
    if (!openUnits.has(unitId)) toggleUnit(unitId);
    window.setTimeout(() => {
      document.getElementById(`unit-${unitId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  const publishToMarket = async () => {
    setMarketState("saving");
    try {
      const res = await fetch("/api/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
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
    router.push(`/classroom/${courseId}/${lec.id}`);
  };

  /* 方案 C：学习仪表盘（进度环 + 统计 + 单元卡） */
  const pct = Math.round((visitedCount / Math.max(learnableLectures.length, 1)) * 100);
  const Ring = () => (
    <svg viewBox="0 0 84 84" className="h-[84px] w-[84px]">
      <circle cx="42" cy="42" r="34" fill="none" stroke="#e4e4e7" strokeWidth="8" />
      <circle
        cx="42" cy="42" r="34" fill="none" stroke="rgb(var(--accent-rgb))" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${(213.6 * pct) / 100} 999`} transform="rotate(-90 42 42)"
      />
      <text x="42" y="41" textAnchor="middle" className="fill-ink text-[17px] font-bold">{pct}%</text>
      <text x="42" y="57" textAnchor="middle" className="fill-[#a1a1aa] text-[10px]">完成</text>
    </svg>
  );
  const VariantC = () => (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[840px] pt-10 px-6 pb-24">
        <h1 className="text-[24px] font-bold leading-snug tracking-tight">{outline.title}</h1>
        <p className="mt-1.5 text-[14px] text-ink-soft">{outline.audience}</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-line bg-white p-4 flex items-center gap-3">
            <Ring />
            <div className="text-[13px] text-ink-faint leading-relaxed">课程进度<br /><span className="text-[14px] text-ink font-medium">已学 {visitedCount}/{learnableLectures.length} 讲</span></div>
          </div>
          <div className="rounded-2xl border border-line bg-white p-4">
            <div className="text-[12px] text-ink-faint">课程体量</div>
            <div className="mt-1.5 text-[20px] font-bold text-ink">{totalLectures} <span className="text-[13px] font-normal text-ink-faint">课节</span></div>
            <div className="mt-1 text-[12.5px] text-ink-faint">{outline.units.length} 个单元{totalMin > 0 ? ` · ${fmtDuration(totalMin)}` : ""}</div>
          </div>
          <div className="rounded-2xl border border-line bg-white p-4">
            <div className="text-[12px] text-ink-faint">结课作品</div>
            <div className="mt-1.5 text-[14.5px] font-semibold leading-snug text-ink">{outline.capstone?.name || "—"}</div>
            {projectLecture && !capstonePassed && (
              <button onClick={() => openLecture(projectLecture)} className="mt-1 text-[12.5px] text-accent hover:underline">去结课工坊 →</button>
            )}
          </div>
        </div>

        {/* 体系门面：这门课不是一堆视频，是一条设计好的路——从哪起步、分几步、走到哪个作品 */}
        <div className="mt-4 rounded-2xl border border-line bg-white p-4">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[12px] font-medium text-ink-faint">学习路径</div>
            <div className="text-[11.5px] text-ink-faint/80">共 {outline.units.length} 个单元 · 按顺序学完即达结课作品</div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-y-2">
            {outline.units.map((unit, ui) => (
              <span key={unit.id} className="flex items-center">
                {ui > 0 && <span className="mx-1 text-[12px] text-line-strong">→</span>}
                <button
                  onClick={() => jumpToUnit(unit.id)}
                  title={unit.title}
                  className="max-w-[230px] truncate rounded-full border border-line bg-sunken px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:border-accent hover:text-accent"
                >
                  <span className="mr-1 font-bold text-accent">{ui + 1}</span>
                  {unit.title}
                </button>
              </span>
            ))}
            {outline.capstone?.name && (
              <span className="flex items-center">
                <span className="mx-1 text-[12px] text-line-strong">→</span>
                <span className="max-w-[220px] truncate rounded-full bg-accent-soft/70 px-3 py-1.5 text-[13px] font-medium text-ink">
                  🏆 结课作品 · {outline.capstone.name}
                </span>
              </span>
            )}
          </div>
        </div>

        {!completed && nextLecture && (
          <div className="mt-4 flex items-center gap-4 rounded-2xl bg-ink p-5 text-white">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] opacity-70">{visitedCount > 0 ? "继续学习 · 下一讲" : "开始学习 · 第 1 讲"}</div>
              <div className="truncate text-[15px] font-semibold">{nextLecture.title}</div>
            </div>
            <button onClick={() => openLecture(nextLecture)} className="shrink-0 rounded-full bg-white px-4 py-2 text-[13.5px] font-semibold text-ink hover:opacity-90">
              ▶ 开始本讲
            </button>
          </div>
        )}

        <div className="mt-4 flex items-center gap-4 text-[13px] text-ink-faint">
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
          <span className="text-[11.5px] text-ink-faint/80">内容由 AI 生成，请以权威来源为准</span>
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
          <div className="mt-3 text-[12.5px]">
            {materialState === "done" && <div className="text-pass">✓ 已解析入库《{materialName}》（纳入讲解的能力开发中，先帮你存好了）</div>}
            {materialState === "uploading" && <div className="text-ink-faint">正在解析《{materialName}》…</div>}
            {materialState === "error" && <div className="text-red-600">《{materialName}》解析失败，换个文件试试</div>}
            {marketState === "done" && <div className="text-pass">✓ 已上架精品课程，所有访客都能看到</div>}
          </div>
        )}
        {marketOpen && marketState !== "done" && (
          <div className="mt-3 rounded-xl border border-line bg-sunken p-3 space-y-2">
            <input
              value={marketNote}
              onChange={(e) => setMarketNote(e.target.value)}
              placeholder="一句话推荐语（可选）"
              className="w-full rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-accent bg-white"
            />
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-[12.5px] text-ink-faint">上架后所有访客可免费浏览，学员第一次上某节课扣 1 积分。</span>
              <button
                onClick={() => void publishToMarket()}
                disabled={marketState === "saving"}
                className="shrink-0 rounded-lg bg-ink px-3.5 py-1.5 text-[13px] text-white font-medium hover:bg-ink/85 disabled:opacity-40"
              >
                {marketState === "saving" ? "上架中…" : "确认上架"}
              </button>
              <button onClick={() => setMarketOpen(false)} className="shrink-0 text-[12.5px] text-ink-faint hover:text-ink">
                取消
              </button>
            </div>
            {marketState === "error" && <div className="text-[12px] text-red-600">上架失败，稍后再试</div>}
          </div>
        )}

        <div className="mt-6 space-y-3">
          {outline.units.map((unit, ui) => {
            const open = openUnits.has(unit.id);
            const unitLearnable = unit.lectures.filter(isLearnable);
            const unitVisited = unitLearnable.filter((l) => visited.has(l.id)).length;
            const unitPct = Math.round((unitVisited / Math.max(unitLearnable.length, 1)) * 100);
            return (
              <div key={unit.id} id={`unit-${unit.id}`} className="scroll-mt-6 rounded-2xl border border-line bg-white p-4">
                <button onClick={() => toggleUnit(unit.id)} className="flex w-full items-center gap-3 text-left">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sunken text-[13px] font-bold text-ink">{ui + 1}</span>
                  <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{unit.title}</span>
                  <span className="shrink-0 text-[12px] text-ink-faint">{unitPct}%</span>
                  <span className={`shrink-0 text-[12px] text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                </button>
                <div className="mt-2 h-1 rounded-full bg-sunken overflow-hidden">
                  <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${unitPct}%` }} />
                </div>
                {open && (
                  <div className="mt-2 space-y-0.5 border-t border-sunken pt-2">
                    {unit.lectures.map((lec) => {
                      const done = visited.has(lec.id);
                      const isNext = nextLecture?.id === lec.id;
                      return (
                        <div key={lec.id} onClick={() => openLecture(lec)} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors ${isNext ? "bg-accent-soft/60" : "hover:bg-sunken"}`}>
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${done ? "bg-accent text-white" : "border-[1.5px] border-line-strong text-transparent"}`}>{done ? "✓" : "·"}</span>
                          <span className={`min-w-0 flex-1 truncate text-[14px] ${done ? "text-ink-faint" : "text-ink"}`}>{lec.title}</span>
                          {lec.content_type === "quiz" ? (
                            <span className={`shrink-0 text-[12px] ${quizPassed.get(lec.id) ? "text-pass" : "text-ink-faint"}`}>
                              {quizPassed.get(lec.id) ? "✓ 测验通过" : "📝 单元测验"}
                            </span>
                          ) : lec.content_type === "project" ? (
                            <span className={`shrink-0 text-[12px] ${capstonePassed ? "text-pass" : "text-ink-faint"}`}>
                              {capstonePassed ? "✓ 已结课" : "🏆 结课作品"}
                            </span>
                          ) : (
                            <span className="shrink-0 text-[12px] text-ink-faint">{lec.duration_min} 分钟</span>
                          )}
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

  return <VariantC />;
}
