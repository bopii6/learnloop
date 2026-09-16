"use client";

// 连环画课堂（原型）：一节课 → 有声连环画。竖屏一格一格往下看，
// 气泡是真文字（AI 画中文必乱，所以图内禁文字、气泡全部 DOM 叠加），
// 配音复用云端 TTS；配图逐格懒生成（滚到哪画到哪），同提示词命中本地缓存秒回。
import { useCallback, useEffect, useRef, useState } from "react";
import { createTtsPlayer, fetchTtsSegments } from "@/lib/tts-client";
import { splitSpeechLines } from "@/lib/speech-lines";
import type { ComicPanel, ComicStoryboard } from "@/lib/agent/comic";

interface PanelState {
  url?: string;
  loading: boolean;
  error?: string;
}

const POS_CLASS: Record<string, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "left-3 bottom-3",
  br: "right-3 bottom-3",
};

export function ComicClassroom({ courseId, unitId, lectureId }: { courseId: string; unitId: string; lectureId: string }) {
  const [storyboard, setStoryboard] = useState<ComicStoryboard | null>(null);
  const [meta, setMeta] = useState<{ lectureTitle: string } | null>(null);
  const [bootError, setBootError] = useState("");
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [playing, setPlaying] = useState(false);
  const [nowSpeaking, setNowSpeaking] = useState<string>("");
  const stopSpeakRef = useRef<(() => void) | null>(null);
  const speakSessionRef = useRef(0);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const requestedRef = useRef<Set<number>>(new Set());

  // ---- 分镜 ----
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/comic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "storyboard", courseId, unitId, lectureId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "分镜生成失败");
        setMeta(data.meta);
        setStoryboard(data.storyboard);
        setPanels((data.storyboard.panels as ComicPanel[]).map(() => ({ loading: false })));
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [courseId, unitId, lectureId]);

  // ---- 逐格懒出图：滚进视口才请求 ----
  const requestPanel = useCallback(
    async (index: number, scene: string) => {
      if (requestedRef.current.has(index)) return;
      requestedRef.current.add(index);
      setPanels((prev) => prev.map((p, i) => (i === index ? { ...p, loading: true, error: undefined } : p)));
      try {
        const res = await fetch("/api/comic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "panel_image", courseId, unitId, lectureId, index, scene }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "出图失败");
        setPanels((prev) => prev.map((p, i) => (i === index ? { ...p, url: data.url, loading: false } : p)));
      } catch (e) {
        requestedRef.current.delete(index); // 失败允许重试
        setPanels((prev) => prev.map((p, i) => (i === index ? { ...p, loading: false, error: e instanceof Error ? e.message : String(e) } : p)));
      }
    },
    [courseId, unitId, lectureId]
  );

  useEffect(() => {
    if (!storyboard) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (!Number.isFinite(index)) continue;
          void requestPanel(index, storyboard.panels[index].scene);
        }
      },
      { rootMargin: "600px 0px" }
    );
    for (const el of panelRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [storyboard, requestPanel]);

  // ---- 语音：一格的旁白 + 台词按顺序读 ----
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
            globalThis.setTimeout(resolve, Math.max(800, text.length * 140));
          }
        } catch {
          resolve();
        }
      })();
    });
  }, []);

  const speakPanel = useCallback(
    async (panel: ComicPanel) => {
      const session = ++speakSessionRef.current;
      const parts: { who: string; text: string }[] = [];
      if (panel.caption) parts.push({ who: "旁白", text: panel.caption });
      for (const b of panel.bubbles) parts.push({ who: b.who === "teacher" ? "老师" : "小测", text: b.text });
      for (const part of parts) {
        if (session !== speakSessionRef.current) return;
        setNowSpeaking(`${part.who}：${part.text}`);
        for (const line of splitSpeechLines(part.text)) {
          if (session !== speakSessionRef.current) return;
          await speakOne(line);
        }
      }
      if (session === speakSessionRef.current) setNowSpeaking("");
    },
    [speakOne]
  );

  // ---- 有声漫画自动播放：逐格滚动 + 朗读 ----
  const autoPlay = useCallback(async () => {
    if (!storyboard || playing) return;
    setPlaying(true);
    const session = ++speakSessionRef.current;
    for (let i = 0; i < storyboard.panels.length; i++) {
      if (session !== speakSessionRef.current) break;
      panelRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
      void requestPanel(i, storyboard.panels[i].scene);
      await new Promise((r) => globalThis.setTimeout(r, 700));
      if (session !== speakSessionRef.current) break;
      await speakPanel(storyboard.panels[i]);
      await new Promise((r) => globalThis.setTimeout(r, 350));
    }
    if (session === speakSessionRef.current) setPlaying(false);
  }, [storyboard, playing, requestPanel, speakPanel]);

  const stopPlaying = useCallback(() => {
    speakSessionRef.current++;
    stopSpeakRef.current?.();
    setNowSpeaking("");
    setPlaying(false);
  }, []);

  const loadedCount = panels.filter((p) => p.url).length;

  return (
    <div className="min-h-screen bg-neutral-100">
      {/* 顶栏 */}
      <div className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[560px] items-center justify-between px-4 py-2.5">
          <div className="text-xs text-neutral-500">
            有声连环画 · {meta?.lectureTitle || "分镜生成中…"} · 图 {loadedCount}/{panels.length || "?"}
          </div>
          {storyboard &&
            (playing ? (
              <button onClick={stopPlaying} className="rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs text-white">
                ■ 停止朗读
              </button>
            ) : (
              <button onClick={() => void autoPlay()} className="rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs text-white">
                ▶ 有声播放
              </button>
            ))}
        </div>
      </div>

      <div className="mx-auto max-w-[560px] px-3 pb-24 pt-6">
        {bootError && <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-600">{bootError}</div>}
        {!storyboard && !bootError && (
          <div className="animate-pulse space-y-3">
            <div className="h-10 w-4/5 rounded bg-neutral-200" />
            <div className="h-5 w-3/5 rounded bg-neutral-200" />
            <div className="h-64 rounded-xl bg-neutral-200" />
            <div className="h-64 rounded-xl bg-neutral-200" />
          </div>
        )}

        {storyboard && (
          <>
            {/* 标题页 */}
            <div className="mb-5 px-1">
              <h1 className="text-3xl font-black leading-tight tracking-tight">{storyboard.title}</h1>
              {storyboard.subtitle && <p className="mt-1.5 text-sm text-neutral-500">{storyboard.subtitle}</p>}
            </div>

            {/* 格子流 */}
            <div className="space-y-5">
              {storyboard.panels.map((panel, i) => {
                const st = panels[i] || { loading: false };
                return (
                  <div
                    key={i}
                    data-index={i}
                    ref={(el) => {
                      panelRefs.current[i] = el;
                    }}
                    className="overflow-hidden rounded-2xl border-2 border-neutral-900 bg-white shadow-[4px_4px_0_0_rgba(23,23,23,0.9)]"
                  >
                    <div className="relative">
                      {/* 画面 */}
                      {st.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={st.url}
                          alt={`第 ${i + 1} 格`}
                          className="block w-full"
                          // 免费模型右下角有"AI生成"水印：裁掉画面底部 8%（课堂展示用不到那条边）
                          style={{ clipPath: "inset(0 0 8% 0)" }}
                        />
                      ) : (
                        <div className="flex h-56 w-full items-center justify-center bg-neutral-100 text-xs text-neutral-400">
                          {st.loading ? "老师正在画这一格…" : st.error || "滚到这里开始画"}
                        </div>
                      )}
                      {st.error && (
                        <button
                          onClick={() => {
                            requestedRef.current.delete(i);
                            void requestPanel(i, panel.scene);
                          }}
                          className="absolute inset-0 bg-black/40 text-sm text-white"
                        >
                          画格翻车了，点我重画
                        </button>
                      )}
                      {/* 气泡（真文字） */}
                      {panel.bubbles.map((b, bi) => (
                        <div
                          key={bi}
                          className={`absolute max-w-[62%] rounded-2xl border-2 border-neutral-900 bg-white px-3 py-2 text-[13px] font-medium leading-snug shadow-sm ${POS_CLASS[b.pos] || POS_CLASS.tl}`}
                        >
                          <span className="mr-1 rounded bg-neutral-900 px-1 text-[10px] text-white align-middle">
                            {b.who === "teacher" ? "师" : "测"}
                          </span>
                          {b.text}
                        </div>
                      ))}
                      {/* 拟声词贴纸 */}
                      {panel.sfx && (
                        <div className="absolute bottom-2 right-3 rotate-[-8deg] text-3xl font-black text-amber-400 drop-shadow-[2px_2px_0_rgba(23,23,23,0.9)]">
                          {panel.sfx}
                        </div>
                      )}
                    </div>
                    {/* 旁白条 */}
                    {panel.caption && (
                      <div className="border-t-2 border-neutral-900 bg-amber-100 px-3 py-2 text-[13px] leading-snug text-neutral-800">
                        {panel.caption}
                      </div>
                    )}
                    {/* 单格朗读 */}
                    <button
                      onClick={() => {
                        stopPlaying();
                        void speakPanel(panel);
                      }}
                      className="w-full border-t border-neutral-200 py-1.5 text-[11px] text-neutral-400 hover:bg-neutral-50 hover:text-neutral-700"
                    >
                      🔊 读这一格
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 尾页 */}
            <div className="mt-8 text-center">
              <div className="text-lg font-black">— 全剧终 —</div>
              <a href={`/learn/${courseId}`} className="mt-3 inline-block rounded-full bg-neutral-900 px-4 py-2 text-xs text-white">
                回到课程
              </a>
            </div>
          </>
        )}
      </div>

      {/* 正在朗读的字幕条 */}
      {nowSpeaking && (
        <div className="fixed bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-center text-xs text-white">
          {nowSpeaking}
        </div>
      )}
    </div>
  );
}
