"use client";

import type { CourseOutline } from "@/types";
import { useRef, useState } from "react";
import { CourseSession } from "./CourseSession";
import { uploadTextbookPdf } from "@/lib/textbook-client";

interface CourseOutlineViewProps {
  outline: CourseOutline;
  courseId: string;
}

export function CourseOutlineView({ outline, courseId }: CourseOutlineViewProps) {
  const [selectedLecture, setSelectedLecture] = useState<{
    unitId: string;
    lectureId: string;
    title: string;
  } | null>(null);
  // 上架到课程集市：好课标个价放进集市，别人点开就能学
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketPrice, setMarketPrice] = useState("");
  const [marketNote, setMarketNote] = useState("");
  const [marketState, setMarketState] = useState<"idle" | "saving" | "done" | "error">("idle");
  // 课程内追加材料（原版同款「上传材料，扩展这门课程」）：先收文件，融入课程的后端在下一迭代
  const [materialName, setMaterialName] = useState<string | null>(null);
  const [materialState, setMaterialState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const materialRef = useRef<HTMLInputElement | null>(null);

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

  const totalLectures = outline.units.reduce((sum, u) => sum + u.lectures.length, 0);
  // 时长只累计当前可学（白板课堂）课节：把测验/项目算进"总时长"是对用户的虚假承诺
  const learnableLectures = outline.units.reduce(
    (s, u) => s + u.lectures.filter((l) => (l as any).content_type === "whiteboard" || !(l as any).content_type).length,
    0
  );
  const totalMin = outline.units.reduce(
    (s, u) =>
      s +
      u.lectures
        .filter((l) => (l as any).content_type === "whiteboard" || !(l as any).content_type)
        .reduce((t, l) => t + (l.duration_min || 0), 0),
    0
  );
  const totalHours = totalMin > 0 ? (totalMin / 60).toFixed(1).replace(/\.0$/, "") : null;

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

  if (selectedLecture) {
    return (
      <CourseSession
        courseId={courseId}
        outline={outline}
        unitId={selectedLecture.unitId}
        lectureId={selectedLecture.lectureId}
        lectureTitle={selectedLecture.title}
        onExit={() => setSelectedLecture(null)}
      />
    );
  }

  // 进入课节（原版同款：点"学习"开白板课堂）
  const openLecture = (unitId: string, lec: { id: string; title: string }) => {
    setSelectedLecture({ unitId, lectureId: lec.id, title: lec.title });
  };

  const scrollToUnit = (unitId: string) => {
    document.getElementById(`unit-${unitId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="max-w-6xl mx-auto pt-8 px-6 pb-16 flex gap-6 items-start">
      {/* 左栏：课程卡 + 单元导航（面板） */}
      <aside className="w-72 shrink-0 sticky top-6 space-y-4">
        <div className="rounded-2xl border border-[#e7e5dc] bg-white p-5">
          <div className="text-[16px] font-bold leading-snug mb-2">{outline.title}</div>
          <div className="text-[12px] text-ink-soft leading-relaxed mb-3">{outline.audience}</div>
          <div className="flex gap-1.5 flex-wrap">
            {outline.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="rounded-full bg-[#f1efe8] px-2 py-0.5 text-[10.5px] text-ink-soft">
                #{tag}
              </span>
            ))}
          </div>
          <div className="text-[11.5px] text-ink-faint mt-3 pt-3 border-t border-[#e7e5dc]">
            共 {outline.units.length} 个单元 · {totalLectures} 个课节
            {learnableLectures < totalLectures && (
              <span className="text-ink-faint">（含 {totalLectures - learnableLectures} 个测验/项目环节）</span>
            )}
            {totalHours && (
              <div className="mt-1.5 text-accent font-medium text-[12px]">
                ⏱ 总时长约 {totalHours} 小时
              </div>
            )}
          </div>
          {/* 上架到课程集市 */}
          <div className="mt-3">
            {!marketOpen ? (
              <button
                onClick={() => {
                  setMarketOpen(true);
                  setMarketState("idle");
                }}
                className="w-full rounded-lg border border-[#d3d1c7] px-3 py-2 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
              >
                🛍 上架到课程集市
              </button>
            ) : marketState === "done" ? (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-[12px] text-emerald-700">
                ✓ 已上架，去侧栏「课程集市」看看
              </div>
            ) : (
              <div className="rounded-xl border border-[#e7e5dc] bg-[#faf9f6] p-3 space-y-2">
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
                  <button
                    onClick={() => setMarketOpen(false)}
                    className="shrink-0 text-[11.5px] text-ink-faint hover:text-ink"
                  >
                    取消
                  </button>
                </div>
                {marketState === "error" && (
                  <div className="text-[11px] text-red-600">上架失败，稍后再试</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-[#e7e5dc] bg-white p-4">
          <div className="text-[11px] text-ink-faint uppercase tracking-wider mb-2">面板 · 单元</div>
          <div className="space-y-1">
            {outline.units.map((unit, ui) => (
              <button
                key={unit.id}
                onClick={() => scrollToUnit(unit.id)}
                className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-[#faf9f6] transition-colors flex gap-2 items-start"
              >
                <span className="shrink-0 w-5 h-5 rounded-md bg-[#f1efe8] text-ink-soft text-[10.5px] flex items-center justify-center font-medium mt-0.5">
                  {ui + 1}
                </span>
                <span className="text-[12px] text-ink leading-snug">{unit.title}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 右栏：追加材料入口 + 单元 → 课节列表（原版的单元卡片流） */}
      <main className="flex-1 min-w-0 space-y-5">
        {/* 上传材料，扩展这门课程（原版同款） */}
        <div className="rounded-2xl border border-[#e7e5dc] bg-white px-5 py-4 flex items-center gap-4">
          <div className="flex -space-x-2 shrink-0">
            <span className="w-8 h-8 rounded-lg bg-[#e8f0fe] border border-white flex items-center justify-center text-[13px]">📄</span>
            <span className="w-8 h-8 rounded-lg bg-[#e6f4ea] border border-white flex items-center justify-center text-[13px]">🧾</span>
            <span className="w-8 h-8 rounded-lg bg-[#fde8e8] border border-white flex items-center justify-center text-[13px]">📝</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-medium text-ink">上传材料，扩展这门课程</div>
            <div className="text-[12px] text-ink-soft mt-0.5">
              上传新的 PDF 给讲师备课参考（自动融入课节讲解的能力开发中）
            </div>
            {materialState === "done" && (
              <div className="text-[11.5px] text-emerald-700 mt-1">
                ✓ 已解析入库《{materialName}》（纳入讲解的能力开发中，先帮你存好了）
              </div>
            )}
            {materialState === "uploading" && (
              <div className="text-[11.5px] text-ink-faint mt-1">正在解析《{materialName}》…</div>
            )}
            {materialState === "error" && (
              <div className="text-[11.5px] text-red-600 mt-1">《{materialName}》解析失败，换个文件试试</div>
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
          <button
            onClick={() => materialRef.current?.click()}
            disabled={materialState === "uploading"}
            className="shrink-0 rounded-full border border-accent/40 text-accent px-4 py-1.5 text-[12px] font-medium hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            ＋ 上传
          </button>
        </div>

        {outline.units.map((unit, ui) => (
          <section
            key={unit.id}
            id={`unit-${unit.id}`}
            className="rounded-2xl border border-[#e7e5dc] bg-white overflow-hidden scroll-mt-6"
          >
            <div className="px-5 py-4 border-b border-[#e7e5dc] bg-[#faf9f6]">
              <div className="flex items-center gap-2 mb-1">
                <span className="rounded-full border border-accent/40 text-accent px-2 py-0.5 text-[10.5px] font-medium">
                  第 {ui + 1} 单元，共 {outline.units.length} 单元
                </span>
              </div>
              <div className="text-[15px] font-semibold">{unit.title}</div>
              <div className="text-[12px] text-ink-soft mt-1 leading-relaxed">{unit.summary}</div>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {unit.key_concepts.map((c) => (
                  <span key={c} className="rounded bg-[#f1efe8] px-2 py-0.5 text-[10.5px] text-ink-soft">
                    {c}
                  </span>
                ))}
              </div>
            </div>

            <div className="divide-y divide-[#e7e5dc]">
              {unit.lectures.map((lec, li) => (
                <div key={lec.id} className="px-5 py-3.5 flex items-center gap-3 hover:bg-[#faf9f6] transition-colors group">
                  <span className="text-[11px] text-ink-faint w-12 shrink-0">讲次 {String(li + 1).padStart(2, "0")}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] text-ink truncate">{lec.title}</div>
                    <div className="flex gap-1.5 mt-1 flex-wrap items-center">
                      {lec.depth_tags.map((tag) => (
                        <span key={tag} className="rounded bg-[#f1efe8] px-1.5 py-0.5 text-[10px] text-ink-soft">
                          {tag}
                        </span>
                      ))}
                      {/* 文档建课：讲次引用的上传文档（原版同款「参考文件」行） */}
                      {(lec.ref_files ?? []).length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-[#e7e5dc] bg-white px-1.5 py-0.5 text-[10px] text-ink-soft">
                          <span className="w-3.5 h-3.5 rounded-sm bg-red-500 text-white flex items-center justify-center text-[7px] font-bold">
                            PDF
                          </span>
                          参考文件：{(lec.ref_files ?? []).join("、")}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-[11px] text-ink-faint shrink-0">
                    {lec.content_type === "whiteboard" || !lec.content_type ? `${lec.duration_min} 分钟` : ""}
                  </span>
                  {lec.content_type === "whiteboard" ? (
                    <button
                      onClick={() => openLecture(unit.id, lec)}
                      className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12px] text-white font-medium hover:opacity-90 transition-opacity flex items-center gap-1"
                    >
                      <span className="text-[10px]">▶</span> 学习
                    </button>
                  ) : lec.content_type === "quiz" ? (
                    <span
                      title="测验环节：随堂小练已内嵌在白板课堂里，本条为课后练习入口（即将开放）"
                      className="shrink-0 rounded-full border border-[#d3d1c7] px-4 py-1.5 text-[12px] text-ink-faint cursor-not-allowed"
                    >
                      📝 课后练习
                    </span>
                  ) : (
                    <span
                      title="项目实践环节（即将开放），不影响本课程主线学习"
                      className="shrink-0 rounded-full border border-[#d3d1c7] px-4 py-1.5 text-[12px] text-ink-faint cursor-not-allowed"
                    >
                      🧩 项目实践
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
