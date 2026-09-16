"use client";

// 知识地图长图（Harness Map 版式）：奶油方格纸 + 编号卡片（烦恼/办法 对照 + 吉祥物）+
// 「下一站」印章串路径 + 分节标题 + 结尾度量与总结表。有声播放按卡片顺序讲解。
// 素材：角色姿势用 AI 素材库（public/comic-assets/），小图示方框/箭头用 CSS。
import { useCallback, useEffect, useRef, useState } from "react";
import { createTtsPlayer, fetchTtsSegments } from "@/lib/tts-client";
import { splitSpeechLines } from "@/lib/speech-lines";
import type { ComicScenePanel, ComicSceneStoryboard, SceneProp } from "@/lib/agent/comic";

// ---- 保留旧引擎的类型与素材图标（兼容 ?engine=img / scene） ----
const PROP_H: Record<string, number> = {
  padlock: 96, tablet: 110, lightning: 120, sandTimer: 116,
  robot: 104, monitor: 110, gear: 96, starBurst: 104, book: 84, crack: 130,
};

// ---- 知识地图数据结构 ----
interface KNode { kind: "box" | "check" | "cross"; text: string }
interface KCard {
  num: string; title: string; tags: string; explain: string;
  trouble: { line: string; mascot: { who: "teacher" | "student"; pose: string }; nodes: KNode[] };
  fix: { line: string; mascot: { who: "teacher" | "student"; pose: string }; nodes: KNode[] };
  solved: string; cost: string;
}
interface KnowledgeStoryboard {
  kicker: string; title: string; subtitle: string;
  overview: { label: string; steps: string[]; loop: string };
  sections: { name: string; range: string }[];
  cards: KCard[];
  metrics: { label: string; value: string; note: string }[];
  outro: { line: string; table: { step: string; help: string; cost: string }[] };
}

function mascotSrc(who: string, pose: string) {
  return `/comic-assets/${who}-${pose}.png`;
}

function NodeChip({ node }: { node: KNode }) {
  if (node.kind === "check") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-700 bg-[#D9EDDC] px-1.5 py-0.5 text-[10px] leading-tight whitespace-nowrap">
        <span className="font-bold text-[#2F7D46]">✓</span>{node.text}
      </span>
    );
  }
  if (node.kind === "cross") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-[#C0392B] bg-white px-1.5 py-0.5 text-[10px] leading-tight whitespace-nowrap text-[#C0392B]">
        <span className="font-bold">✗</span>{node.text}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-neutral-600 bg-white px-1.5 py-0.5 text-[10px] leading-tight whitespace-nowrap">
      {node.text}
    </span>
  );
}

function FlowRow({ mascot, nodes }: { mascot: { who: string; pose: string }; nodes: KNode[] }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={mascotSrc(mascot.who, mascot.pose)} alt="" draggable={false} style={{ height: 54 }} />
      {nodes.map((n, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span className="text-neutral-500 text-[10px]">→</span>}
          <NodeChip node={n} />
        </span>
      ))}
    </div>
  );
}

function KCardView({ card, active }: { card: KCard; active: boolean }) {
  return (
    <div
      className="rounded-xl bg-white p-3"
      style={{
        border: active ? "2px solid #4FB3B3" : "1.5px solid #27272A",
        boxShadow: "2px 2px 0 rgba(39,39,39,0.15)",
        transition: "border-color 0.2s",
      }}
    >
      <div className="flex items-start justify-between">
        <div className="text-[15px] font-bold leading-tight">
          <span className="mr-1.5">{card.num}</span>
          {card.title}
        </div>
        <span className="shrink-0 -rotate-6 rounded-md border-[1.5px] border-[#C0392B] px-1.5 py-0.5 text-[10px] font-bold text-[#C0392B]">
          下一站
        </span>
      </div>
      {card.tags && <div className="mt-0.5 text-[10.5px] tracking-wide text-neutral-400">{card.tags}</div>}
      <p className="mt-1 text-[12px] leading-snug text-neutral-700">{card.explain}</p>
      {/* 烦恼 / 办法 双格 */}
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {[
          { label: "烦恼", tone: "bg-white", data: card.trouble },
          { label: "办法", tone: "bg-white", data: card.fix },
        ].map((side) => (
          <div key={side.label} className={`rounded-lg border border-neutral-500 p-1.5 ${side.tone}`}>
            <div className="text-[10px] font-bold text-neutral-600">{side.label}</div>
            <div className="mt-0.5 text-[11px] leading-snug">{side.data.line}</div>
            <div className="mt-1.5 overflow-hidden">
              <FlowRow mascot={side.data.mascot} nodes={side.data.nodes} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 space-y-0.5 text-[11px] leading-snug">
        <div><span className="font-bold">解决了什么</span><span className="mx-1 text-neutral-400">·</span>{card.solved}</div>
        <div><span className="font-bold">代价是什么</span><span className="mx-1 text-neutral-400">·</span>{card.cost}</div>
      </div>
    </div>
  );
}

export function ComicBoard({ courseId, unitId, lectureId }: { courseId: string; unitId: string; lectureId: string }) {
  const [kb, setKb] = useState<KnowledgeStoryboard | null>(null);
  const [meta, setMeta] = useState<{ lectureTitle: string } | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [subtitle, setSubtitle] = useState("");
  const stopSpeakRef = useRef<(() => void) | null>(null);
  const speakSessionRef = useRef(0);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/comic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "storyboard_knowledge", courseId, unitId, lectureId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "知识地图生成失败");
        setMeta(data.meta);
        setKb(data.storyboard);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [courseId, unitId, lectureId]);

  const speakOne = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      let cancelled = false;
      stopSpeakRef.current = () => {
        cancelled = true;
        window.speechSynthesis?.cancel();
        resolve();
      };
      void (async () => {
        try {
          const segs = await fetchTtsSegments(text);
          if (cancelled) return;
          if (segs) {
            const player = createTtsPlayer(segs, 1);
            stopSpeakRef.current = () => {
              cancelled = true;
              player.stop();
              resolve();
            };
            await player.promise;
            resolve();
          } else if ("speechSynthesis" in window) {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = "zh-CN";
            u.onend = () => resolve();
            u.onerror = () => resolve();
            window.speechSynthesis.speak(u);
          } else {
            globalThis.setTimeout(resolve, Math.max(700, text.length * 120));
          }
        } catch {
          resolve();
        }
      })();
    });
  }, []);

  const speakCard = useCallback(
    async (index: number) => {
      const card = kb?.cards[index];
      if (!card) return;
      const session = ++speakSessionRef.current;
      const parts = [`${card.num}，${card.title}。`, card.explain, `烦恼：${card.trouble.line}。`, `办法：${card.fix.line}。`];
      for (const part of parts) {
        if (session !== speakSessionRef.current) return;
        setSubtitle(part);
        for (const line of splitSpeechLines(part)) {
          if (session !== speakSessionRef.current) return;
          await speakOne(line);
        }
      }
      if (session === speakSessionRef.current) setSubtitle("");
    },
    [kb, speakOne]
  );

  const autoPlay = useCallback(async () => {
    if (!kb || playing) return;
    setPlaying(true);
    const session = ++speakSessionRef.current;
    for (let i = 0; i < kb.cards.length; i++) {
      if (session !== speakSessionRef.current) break;
      cardRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
      setCurrent(i);
      await new Promise((r) => globalThis.setTimeout(r, 500));
      if (session !== speakSessionRef.current) break;
      await speakCard(i);
      await new Promise((r) => globalThis.setTimeout(r, 250));
    }
    if (session === speakSessionRef.current) setPlaying(false);
  }, [kb, playing, speakCard]);

  const stopPlaying = useCallback(() => {
    speakSessionRef.current++;
    stopSpeakRef.current?.();
    setSubtitle("");
    setPlaying(false);
  }, []);

  // 当前卡片落在哪个 section（用于高亮分组标题）
  const sectionOf = useCallback(
    (cardIndex: number) => {
      if (!kb) return -1;
      let sec = 0;
      kb.sections.forEach((s, si) => {
        const m = s.range.match(/(\d+)/);
        if (m && Number(m[1]) <= cardIndex + 1) sec = si;
      });
      return sec;
    },
    [kb]
  );

  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: "#F7F4EC",
        backgroundImage:
          "repeating-linear-gradient(0deg, rgba(39,39,39,0.035) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(39,39,39,0.035) 0 1px, transparent 1px 24px)",
        fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        color: "#27272A",
      }}
    >
      {/* 顶栏 */}
      <div className="sticky top-0 z-20 border-b border-[#27272A]/20 bg-[#F7F4EC]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[820px] items-center justify-between px-4 py-2">
          <span className="text-[11px] text-neutral-500">
            知识地图 · {meta?.lectureTitle || "生成中…"}
            {kb ? ` · ${kb.cards.length} 张卡片` : ""}
          </span>
          {kb &&
            (playing ? (
              <button onClick={stopPlaying} className="rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs text-white">
                ■ 停止
              </button>
            ) : (
              <button onClick={() => void autoPlay()} className="rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs text-white">
                ▶ 逐卡讲解
              </button>
            ))}
        </div>
      </div>

      <div className="mx-auto max-w-[820px] px-4 pb-16 pt-6">
        {error && <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}
        {!kb && !error && (
          <div className="animate-pulse space-y-3">
            <div className="h-10 w-4/5 rounded bg-neutral-200" />
            <div className="h-40 rounded-xl bg-neutral-200" />
            <div className="h-56 rounded-xl bg-neutral-200" />
            <div className="h-56 rounded-xl bg-neutral-200" />
          </div>
        )}

        {kb && (
          <>
            {/* 头部 */}
            <div className="text-[11px] tracking-[0.18em] text-neutral-400">{kb.kicker}</div>
            <h1 className="mt-1.5 text-[32px] font-black leading-tight">{kb.title}</h1>
            {kb.subtitle && <p className="mt-1.5 text-[13.5px] font-semibold text-neutral-700">{kb.subtitle}</p>}

            {/* 总览流程 */}
            {kb.overview.steps.length > 0 && (
              <div className="mt-4 rounded-xl border-[1.5px] border-[#27272A] bg-white/85 p-3">
                {kb.overview.label && <div className="text-[12.5px] font-bold">{kb.overview.label}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/comic-assets/teacher-point.png" alt="老师" style={{ height: 58 }} draggable={false} />
                  {kb.overview.steps.map((s, i) => (
                    <span key={i} className="flex items-center gap-2">
                      {i > 0 && <span className="text-neutral-500">→</span>}
                      <span
                        className="rounded-lg border-[1.5px] border-[#27272A] px-2.5 py-1.5 text-[12px] font-bold"
                        style={{ background: ["#D6E6F5", "#D9EDDC", "#F5E9C9", "#F5D9D4"][i % 4] }}
                      >
                        {s}
                      </span>
                    </span>
                  ))}
                  <span className="text-[#2F7D46]">✓</span>
                </div>
                {kb.overview.loop && (
                  <div className="mt-2 border-t border-dashed border-neutral-400 pt-1.5 text-[11.5px] text-neutral-600">
                    ↩ {kb.overview.loop}
                  </div>
                )}
              </div>
            )}

            {/* 分节 + 卡片网格 */}
            {kb.sections.map((sec, si) => {
              const nums = sec.range.match(/(\d+)\D+(\d+)/);
              const from = nums ? Number(nums[1]) : 0;
              const to = nums ? Number(nums[2]) : 99;
              const secCards = kb.cards
                .map((c, i) => ({ c, i }))
                .filter(({ c }) => {
                  const n = Number(c.num);
                  return n >= from && n <= to;
                });
              if (secCards.length === 0) return null;
              return (
                <div key={si} className="mt-7">
                  <div className="flex items-baseline gap-2">
                    <h2 className={`text-[21px] font-black ${sectionOf(current) === si && playing ? "text-[#2F7D46]" : ""}`}>{sec.name}</h2>
                    <span className="text-[11px] text-neutral-400">{sec.range}</span>
                  </div>
                  <div className="mt-1 mb-3 h-px bg-[#27272A]/40" />
                  <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    {secCards.map(({ c, i }) => (
                      <div
                        key={i}
                        ref={(el) => {
                          cardRefs.current[i] = el;
                        }}
                      >
                        <KCardView card={c} active={current === i && playing} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {/* 未分组卡片兜底 */}
            {kb.sections.length === 0 && (
              <div className="mt-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {kb.cards.map((c, i) => (
                  <div
                    key={i}
                    ref={(el) => {
                      cardRefs.current[i] = el;
                    }}
                  >
                    <KCardView card={c} active={current === i && playing} />
                  </div>
                ))}
              </div>
            )}

            {/* 度量 */}
            {kb.metrics.length > 0 && (
              <div className="mt-8">
                <h2 className="text-[20px] font-black">最后拿这把尺子，量一量。</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {kb.metrics.map((m, i) => (
                    <div key={i} className="rounded-xl border-[1.5px] border-[#27272A] bg-white p-3 text-center">
                      <div className="text-[11px] font-bold text-neutral-600">{m.label}</div>
                      <div className="mt-1 text-[26px] font-black leading-none">{m.value}</div>
                      <div className="mt-1 text-[10.5px] text-neutral-500">{m.note}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 总结表 */}
            {kb.outro.table.length > 0 && (
              <div className="mt-7">
                {kb.outro.line && <div className="text-[14px] font-bold">{kb.outro.line}</div>}
                <table className="mt-2 w-full border-collapse text-[11.5px]">
                  <thead>
                    <tr className="border-b-[1.5px] border-[#27272A] text-left">
                      <th className="py-1.5 pr-2 font-bold">办法</th>
                      <th className="py-1.5 pr-2 font-bold">通常帮助哪里</th>
                      <th className="py-1.5 font-bold">要付出的代价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kb.outro.table.map((r, i) => (
                      <tr key={i} className="border-b border-[#27272A]/25">
                        <td className="py-1.5 pr-2 align-top font-semibold">{r.step}</td>
                        <td className="py-1.5 pr-2 align-top text-neutral-700">{r.help}</td>
                        <td className="py-1.5 align-top text-neutral-700">{r.cost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-8 flex items-center justify-between text-[10.5px] text-neutral-400">
              <span>Superlearn · 知识地图 · {meta?.lectureTitle}</span>
              <span>先看得懂，再记得住。/2026.09</span>
            </div>
          </>
        )}
      </div>

      {subtitle && (
        <div className="fixed bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2 rounded-full bg-black/80 px-5 py-2.5 text-center text-xs text-white">
          {subtitle}
        </div>
      )}
    </div>
  );
}

// 兼容旧引用：场景图版本（?engine=scene 可用）
export type { ComicScenePanel, ComicSceneStoryboard, SceneProp };
