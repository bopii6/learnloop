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

  return (
    <div className="max-w-3xl mx-auto pt-8 px-6 pb-16 space-y-4">
      {/* Hero：这是什么课 + 学到哪了 + 下一讲去哪 */}
      <section className="rounded-2xl border border-[#e7e5dc] bg-white p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-accent-border to-accent-soft" />
        <h1 className="text-[22px] font-bold leading-snug">{outline.title}</h1>
        <p className="text-[13px] text-ink-soft leading-relaxed mt-1.5">{outline.audience}</p>
        <div className="flex gap-1.5 flex-wrap mt-2.5">
          {outline.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded-full bg-[#f1efe8] px-2 py-0.5 text-[10.5px] text-ink-soft">
              #{tag}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2.5 flex-wrap mt-4 text-[12.5px] text-ink-soft">
          <span>{outline.units.length} 个单元</span>
          <span className="text-[#d9d6ca]">·</span>
          <span>
            {totalLectures} 个课节
            {/* 口径统一：可学的白板讲次之外还有测验/结课环节，写清楚免得"32 节 vs 29 讲"让人犯嘀咕 */}
            {totalLectures !== learnableLectures.length &&
              `（含 ${totalLectures - learnableLectures.length} 节测验/结课）`}
          </span>
          {totalMin > 0 && (
            <>
              <span className="text-[#d9d6ca]">·</span>
              <span>{fmtDuration(totalMin)}</span>
            </>
          )}
          <span className="text-[#d9d6ca]">·</span>
          <span className={visitedCount > 0 ? "text-accent font-medium" : ""}>已学 {visitedCount} / {learnableLectures.length} 讲</span>
        </div>
        {visitedCount > 0 && (
          <div className="mt-2.5 h-1.5 rounded-full bg-[#f1efe8] overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500"
              style={{ width: `${Math.max((visitedCount / Math.max(learnableLectures.length, 1)) * 100, 3)}%` }}
            />
          </div>
        )}

        {/* 主 CTA：永远回答"我现在点哪里"。课程名放副行独立截断——
            此前挤在一行里被 CSS 拦腰截断，出现「…如何衡量模型对语言的」这种半个词加悬空引号 */}
        <div className="mt-5 flex items-center gap-3 flex-wrap">
          {completed ? (
            <button
              onClick={() => nextLecture && openLecture(nextLecture)}
              className="rounded-full border border-accent/40 bg-white text-accent px-6 py-2 text-[13px] font-medium hover:bg-accent/5 transition-colors"
            >
              已学完 · 随意复习 →
            </button>
          ) : (
            <button
              onClick={() => nextLecture && openLecture(nextLecture)}
              className="rounded-full bg-accent px-6 py-2 text-left text-white shadow-lg shadow-accent/25 hover:opacity-90 transition-opacity max-w-full"
            >
              <span className="block text-[13.5px] font-medium leading-tight">
                {visitedCount > 0 ? "继续学习" : "开始学习"}
              </span>
              <span className="block text-[11px] leading-tight opacity-85 max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap">
                {visitedCount > 0 ? "下一讲：" : "第 1 讲："}
                {nextLecture?.title || ""}
              </span>
            </button>
          )}
          <button
            onClick={() => materialRef.current?.click()}
            disabled={materialState === "uploading"}
            className="flex items-center gap-1.5 rounded-full border border-[#e7e5dc] bg-white px-3.5 py-2 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
          >
            <Icon name="paperclip" className="h-[13px] w-[13px]" />
            上传材料
          </button>
          {!marketOpen && (
            <button
              onClick={() => {
                setMarketOpen(true);
                setMarketState("idle");
              }}
              className="flex items-center gap-1.5 rounded-full border border-[#e7e5dc] bg-white px-3.5 py-2 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
            >
              <Icon name="link" className="h-[13px] w-[13px]" />
              上架到精品课程
            </button>
          )}
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
            {materialState === "done" && <div className="text-emerald-700">✓ 已解析入库《{materialName}》（纳入讲解的能力开发中，先帮你存好了）</div>}
            {materialState === "uploading" && <div className="text-ink-faint">正在解析《{materialName}》…</div>}
            {materialState === "error" && <div className="text-red-600">《{materialName}》解析失败，换个文件试试</div>}
            {marketState === "done" && <div className="text-emerald-700">✓ 已上架精品课程，所有访客都能看到</div>}
          </div>
        )}
        {marketOpen && marketState !== "done" && (
          <div className="mt-3 rounded-xl border border-[#e7e5dc] bg-[#faf9f6] p-3 space-y-2">
            <input
              value={marketNote}
              onChange={(e) => setMarketNote(e.target.value)}
              placeholder="一句话推荐语（可选）"
              className="w-full rounded-lg border border-[#e7e5dc] px-2.5 py-1.5 text-[12px] outline-none focus:border-accent bg-white"
            />
            <div className="flex items-center gap-2">
              <input
                value={marketPrice}
                onChange={(e) => setMarketPrice(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="标价，留空 = 免费"
                className="flex-1 min-w-0 rounded-lg border border-[#e7e5dc] px-2.5 py-1.5 text-[12px] outline-none focus:border-accent bg-white"
              />
              <button
                onClick={() => void publishToMarket()}
                disabled={marketState === "saving"}
                className="shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-[12px] text-white font-medium hover:opacity-90 disabled:opacity-40"
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
        <div className="mt-4 pt-3 border-t border-[#f1efe8] text-[11px] text-ink-faint">
          内容由 AI 生成，可能存在错误，请以权威来源为准
        </div>
      </section>

      {/* 结课作品横幅：这门课的终点承诺——学完你将亲手做出的东西 */}
      {outline.capstone?.name && (
        <div className="rounded-2xl border border-accent/30 bg-accent/5 px-5 py-4 fade-up">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-[11.5px] text-accent font-semibold tracking-wide mb-1">
                结课作品 · 学完你将亲手做出
              </div>
              <div className="text-[15.5px] font-semibold text-ink">{outline.capstone.name}</div>
              {outline.capstone.description && (
                <div className="text-[12.5px] text-ink-soft mt-1 leading-relaxed">{outline.capstone.description}</div>
              )}
            </div>
            {projectLecture && (
              <button
                onClick={() => openLecture(projectLecture)}
                className={`shrink-0 self-center rounded-full px-4 py-2 text-[12px] font-medium transition-opacity flex items-center gap-1.5 ${
                  capstonePassed ? "border border-accent/40 bg-white text-accent hover:bg-accent/5" : "bg-accent text-white hover:opacity-90"
                }`}
              >
                {capstonePassed ? "已结课 · 再看看" : "进入结课工坊 →"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 单元手风琴：默认只展开下一讲所在单元，行内只留讲次/标题/时长/按钮 */}
      {outline.units.map((unit, ui) => {
        const unitLearnable = unit.lectures.filter(isLearnable);
        const unitVisited = unitLearnable.filter((l) => visited.has(l.id)).length;
        const open = openUnits.has(unit.id);
        const isCurrent = Boolean(nextLecture && unit.lectures.some((l) => l.id === nextLecture.id));
        return (
          <section key={unit.id} className="rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden">
            <button
              onClick={() => toggleUnit(unit.id)}
              className={`w-full text-left px-5 py-3.5 flex items-center gap-3 transition-colors ${
                open ? "bg-[#faf9f6]" : "hover:bg-[#faf9f6]"
              }`}
            >
              <span
                className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-[12px] font-semibold ${
                  isCurrent ? "bg-accent text-white" : "bg-[#f1efe8] text-ink-soft"
                }`}
              >
                {ui + 1}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold text-ink leading-snug">{unit.title}</span>
                {!open && (
                  <span className="block text-[11.5px] text-ink-faint mt-0.5">
                    {unit.lectures.length} 个课节
                    {unitVisited > 0 ? ` · 已学 ${unitVisited} 讲` : ""}
                  </span>
                )}
              </span>
              {unitVisited > 0 && !open && (
                <span className="shrink-0 text-[11px] text-accent font-medium">{unitVisited}/{unitLearnable.length}</span>
              )}
              <span className={`shrink-0 text-ink-faint text-[11px] transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
            </button>

            {open && (
              <div>
                <div className="px-5 pb-3 -mt-1">
                  <div className="text-[12.5px] text-ink-soft leading-relaxed">{unit.summary}</div>
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {unit.key_concepts.map((c) => (
                      <span key={c} className="rounded bg-[#f1efe8] px-2 py-0.5 text-[10.5px] text-ink-soft">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="divide-y divide-[#f1efe8] border-t border-[#f1efe8]">
                  {unit.lectures.map((lec, li) => {
                    const done = visited.has(lec.id);
                    const isNext = nextLecture?.id === lec.id;
                    return (
                      <div key={lec.id} className="px-5 py-3 flex items-center gap-3 hover:bg-[#faf9f6] transition-colors">
                        <span
                          className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10.5px] font-medium ${
                            done
                              ? "bg-accent-soft text-accent"
                              : isNext
                                ? "text-accent bg-white"
                                : "bg-[#f1efe8] text-ink-faint"
                          }`}
                          style={isNext ? { boxShadow: "0 0 0 1.5px #0F6E56" } : undefined}
                        >
                          {done ? "✓" : li + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className={`text-[13.5px] truncate ${done ? "text-ink-faint" : "text-ink"}`}>{lec.title}</div>
                          {(lec.ref_files ?? []).length > 0 && (
                            <div className="text-[10.5px] text-ink-faint mt-0.5">{(lec.ref_files ?? []).join("、")}</div>
                          )}
                        </div>
                        <span className="text-[11px] text-ink-faint shrink-0">
                          {isLearnable(lec) ? `${lec.duration_min} 分钟` : ""}
                        </span>
                        {lec.content_type === "whiteboard" ? (
                          <button
                            onClick={() => openLecture(lec)}
                            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors flex items-center gap-1 ${
                              isNext
                                ? "bg-accent text-white hover:opacity-90"
                                : done
                                  ? "border border-[#e0ded3] text-ink-soft hover:border-accent hover:text-accent"
                                  : "border border-accent/40 text-accent hover:bg-accent/5"
                            }`}
                          >
                            {done ? "复习" : isNext ? "▶ 继续学" : "▶ 学习"}
                          </button>
                        ) : lec.content_type === "quiz" ? (
                          <button
                            onClick={() => openLecture(lec)}
                            title="单元测验：5 道场景题检验这个单元是否真的掌握，60% 过关，重考免费"
                            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors flex items-center gap-1 ${
                              quizPassed.get(lec.id)
                                ? "border border-accent/40 text-accent"
                                : "bg-accent text-white hover:opacity-90"
                            }`}
                          >
                            {quizPassed.get(lec.id) ? "✓ 已通过" : "测验"}
                          </button>
                        ) : (
                          <button
                            onClick={() => openLecture(lec)}
                            title="结课作品工坊：领任务书 → 动手做 → 导师对照做成标准验收，通过即结课"
                            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors flex items-center gap-1 ${
                              capstonePassed ? "border border-accent/40 text-accent" : "bg-accent text-white hover:opacity-90"
                            }`}
                          >
                            {capstonePassed ? "已结课" : "结课作品"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
