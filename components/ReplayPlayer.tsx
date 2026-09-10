"use client";

// 只读回放播放器：一个链接，完整重演一节白板课——
// 板书按 beat 重建（镜头跟随）、字幕同步、逐句语音（浏览器 TTS）。
// 与课堂播放器（CourseSession）刻意分离：回放没有打断/练习/WS，只保留"看"的体验。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayReel } from "@/types";
import { Whiteboard } from "./Whiteboard";
import { createBoardWriter, type BoardWriter } from "./board-writer";
import { createTtsPlayer, fetchTtsSegments, prefetchTts, ttsUnavailable } from "@/lib/tts-client";
import { splitSpeechLines } from "@/lib/speech-lines";
import { boardCssVars, CHROME_VARS } from "@/lib/board-themes";

let cachedZhVoice: SpeechSynthesisVoice | null = null;
function pickZhVoice(): SpeechSynthesisVoice | null {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (cachedZhVoice && voices.includes(cachedZhVoice)) return cachedZhVoice;
  const zh = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("zh"));
  const preferred =
    zh.find((v) => /natural|neural|online/i.test(v.name)) ||
    zh.find((v) => /xiaoxiao|xiaoyi|yunxi|yunyang|yaoyao|huihui/i.test(v.name)) ||
    zh[0] ||
    null;
  cachedZhVoice = preferred;
  return preferred;
}

type Status = "loading" | "ready" | "playing" | "paused" | "done" | "error";

/** 片段进度表：segmentTitle 首次出现的顺序即模块序号，总数为去重个数（模块板徽章用） */
function segmentProgress(beats: { segmentTitle?: string }[]) {
  const order: string[] = [];
  for (const b of beats) {
    const t = b.segmentTitle || "";
    if (!order.includes(t)) order.push(t);
  }
  return (title: string) => ({
    index: Math.max(0, order.indexOf(title || "")) + 1,
    total: order.length,
  });
}

export function ReplayPlayer({ replayId }: { replayId: string }) {
  const [reel, setReel] = useState<ReplayReel | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [idx, setIdx] = useState(-1); // 当前播到第几拍
  const [subtitle, setSubtitle] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [copied, setCopied] = useState(false);

  const apiRef = useRef<any>(null);
  const writerRef = useRef<BoardWriter | null>(null);
  const cancelRef = useRef(0); // 播放循环代次：seek/暂停时自增，旧循环自行退出
  const stopSpeechRef = useRef<(() => void) | null>(null);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;
  const statusRef = useRef<Status>("loading");
  statusRef.current = status;

  useEffect(() => {
    let alive = true;
    fetch(`/api/replay?id=${encodeURIComponent(replayId)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setStatus("error");
          setError(r.status === 404 ? "回放不存在或已被清理" : "回放加载失败");
          return;
        }
        setReel(d.reel);
        setStatus("ready");
      })
      .catch(() => {
        if (alive) {
          setStatus("error");
          setError("回放加载失败");
        }
      });
    return () => {
      alive = false;
      stopSpeechRef.current?.(); // 云端音频走 <audio>，必须显式停
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [replayId]);

  const beats = reel?.beats || [];

  /** 逐句朗读：云端 TTS 优先（音色自然），静音/未配置/失败回退浏览器系统音色或阅读节奏计时 */
  const speak = useCallback((text: string) => {
    const spd = 1;
    return new Promise<void>((resolve) => {
      const minMs = 1800 / spd;
      if (!voiceRef.current || !("speechSynthesis" in window)) {
        window.setTimeout(resolve, Math.max(minMs, (text.length * 170 + 400) / spd));
        return;
      }
      let settled = false;
      let cancelled = false; // 云端合成等待期间被暂停/seek
      const finish = () => {
        if (!settled) {
          settled = true;
          stopSpeechRef.current = null;
          resolve();
        }
      };
      stopSpeechRef.current = () => {
        cancelled = true;
        finish();
      };
      void (async () => {
        const segs = await fetchTtsSegments(text);
        if (cancelled || settled) return;
        if (segs) {
          const player = createTtsPlayer(segs, spd);
          stopSpeechRef.current = () => player.stop();
          await player.promise;
          finish();
          return;
        }
        if (!ttsUnavailable()) {
          // 云端已配置但这句暂时失败：按阅读节奏安静推进，不回退生硬的浏览器音色
          window.setTimeout(finish, Math.max(minMs, (text.length * 170 + 400) / spd));
          return;
        }
        const synth = window.speechSynthesis;
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "zh-CN";
        const zh = pickZhVoice();
        if (zh) u.voice = zh;
        let started = false;
        u.onstart = () => (started = true);
        u.onend = finish;
        u.onerror = finish;
        stopSpeechRef.current = () => {
          try {
            synth.cancel();
          } catch {
            // ignore
          }
          finish();
        };
        synth.speak(u);
        window.setTimeout(() => {
          if (!started) finish();
        }, 1800);
        window.setTimeout(finish, (text.length * 320 + 6000) / spd);
      })();
    });
  }, []);

  /** 从第 start 拍开始播（含 turbo 跳uild：先把 0..start-1 拍瞬间写上白板） */
  const playFrom = useCallback(
    async (start: number, gen: number) => {
      const writer = writerRef.current;
      if (!writer) return;
      const prog = segmentProgress(beats);
      // 快进重建：已播过的拍瞬间铺到位
      if (start > 0) {
        writer.setTurbo(true);
        let curSeg: string | null = null;
        for (let i = 0; i < start; i++) {
          const b = beats[i];
          if (b.segmentTitle !== curSeg) {
            curSeg = b.segmentTitle;
            await writer.beginSegment(b.segmentTitle, prog(b.segmentTitle));
          }
          await writer.write(b.section, b.items || []);
        }
        writer.setTurbo(false);
        writer.focusCurrent();
        await new Promise<void>((r) => window.setTimeout(r, 350));
      }
      // 正常速度播放 start..end
      let curSeg: string | null = start > 0 ? beats[start - 1]?.segmentTitle ?? null : null;
      for (let i = start; i < beats.length; i++) {
        if (cancelRef.current !== gen) return; // 被 seek/重播取代
        const b = beats[i];
        setIdx(i);
        // 电视字幕式：beat 按句切成字幕行，字幕一次只显示一行、语音逐句跟读
        const speechLines = splitSpeechLines(b.say);
        if (speechLines[0]) setSubtitle(speechLines[0]);
        if (b.segmentTitle !== curSeg) {
          curSeg = b.segmentTitle;
          await writer.beginSegment(b.segmentTitle, prog(b.segmentTitle));
        }
        await writer.write(b.section, b.items || []);
        const nextLines = beats[i + 1] ? splitSpeechLines(beats[i + 1].say) : [];
        for (let li = 0; li < speechLines.length; li++) {
          if (cancelRef.current !== gen) return;
          setSubtitle(speechLines[li]);
          prefetchTts(speechLines[li + 1] ?? nextLines[0]); // 播放本行期间预取下一行云端音频
          await speak(speechLines[li]);
          if (cancelRef.current !== gen) return;
        }
      }
      setStatus((s) => (s === "playing" ? "done" : s));
    },
    [beats, speak]
  );

  const startPlay = useCallback(
    (from: number) => {
      if (!beats.length) return;
      cancelRef.current += 1;
      const gen = cancelRef.current;
      setStatus("playing");
      void playFrom(from, gen);
    },
    [beats.length, playFrom]
  );

  const pause = useCallback(() => {
    cancelRef.current += 1;
    stopSpeechRef.current?.();
    setStatus((s) => (s === "playing" ? "paused" : s));
  }, []);

  /** 进度条点按：跳到第 i 拍（重建画面后暂停，等用户继续） */
  const seek = useCallback(
    (i: number) => {
      if (!beats.length) return;
      cancelRef.current += 1;
      stopSpeechRef.current?.();
      const target = Math.max(0, Math.min(beats.length - 1, i));
      const gen = cancelRef.current;
      const writer = writerRef.current;
      if (!writer) return;
      (async () => {
        writer.setTurbo(true);
        const prog = segmentProgress(beats);
        let curSeg: string | null = null;
        for (let k = 0; k <= target; k++) {
          const b = beats[k];
          if (b.segmentTitle !== curSeg) {
            curSeg = b.segmentTitle;
            await writer.beginSegment(b.segmentTitle, prog(b.segmentTitle));
          }
          await writer.write(b.section, b.items || []);
        }
        writer.setTurbo(false);
        writer.focusCurrent();
        setIdx(target);
        // 停在落点的第一行字幕上（与播放时的逐行字幕一致）
        const targetLines = splitSpeechLines(beats[target].say);
        setSubtitle(targetLines[0] || beats[target].say);
        setStatus("paused");
        if (cancelRef.current === gen) {
          // 落位后再播下一拍
        }
      })();
    },
    [beats]
  );

  const resume = useCallback(() => {
    const next = idx + 1;
    if (idx >= beats.length - 1) {
      // 播完了 → 重播
      startPlay(0);
      return;
    }
    startPlay(next);
  }, [idx, beats.length, startPlay]);

  const toggleVoice = () => {
    setVoiceOn((on) => {
      const next = !on;
      if (!next) stopSpeechRef.current?.();
      return next;
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  if (status === "error") {
    return (
      <div className="min-h-screen home-bg flex items-center justify-center">
        <div className="text-center">
          <div className="text-[17px] font-semibold mb-2">无法打开回放</div>
          <div className="text-[13px] text-ink-soft">{error}</div>
          <a href="/" className="inline-block mt-5 rounded-lg bg-accent px-5 py-2 text-[13px] text-white hover:opacity-90">
            去 Superlearn 上自己的课 →
          </a>
        </div>
      </div>
    );
  }

  const progress = beats.length ? ((idx + 1) / beats.length) * 100 : 0;

  return (
    <div
      className="classroom-sunny fixed inset-0 bg-[#fffcf4] flex flex-col z-50"
      style={{ ...boardCssVars(), ...CHROME_VARS } as React.CSSProperties}
    >
      {/* 顶栏 */}
      <div className="h-14 border-b border-[#e7e5dc] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-accent text-white text-[13px] font-bold flex items-center justify-center shrink-0">S</span>
          <div className="min-w-0">
            <div className="text-[14px] font-medium truncate leading-tight">{reel?.lectureTitle || "课程回放"}</div>
            <div className="text-[11px] text-ink-faint truncate leading-tight">{reel?.courseTitle}</div>
          </div>
          <span className="rounded-full bg-[#fff3e0] px-2 py-px text-[10px] text-[#b45309] shrink-0">回放</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={toggleVoice}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${voiceOn ? "border-accent text-accent" : "border-[#e0d6c2] text-ink-soft"}`}
          >
            {voiceOn ? "◖ 语音" : "◌ 静音"}
          </button>
          <button onClick={copyLink} className="rounded-lg border border-[#e0d6c2] px-3 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent">
            {copied ? "✓ 已复制" : "🔗 复制链接"}
          </button>
          <a href="/" className="rounded-lg bg-accent px-3.5 py-1.5 text-[12px] text-white font-medium hover:opacity-90">
            我也要上课
          </a>
        </div>
      </div>

      {/* 白板 */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        <Whiteboard
          onReady={(api) => {
            apiRef.current = api;
            writerRef.current = createBoardWriter(() => apiRef.current);
          }}
        />
        {/* 开场遮罩 */}
        {(status === "ready" || status === "loading") && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/70 backdrop-blur-[2px]">
            <div className="w-[400px] max-w-[88%] rounded-3xl border border-[#e7e5dc] bg-white shadow-xl p-8 text-center fade-up">
              <div className="text-[11px] text-ink-faint uppercase tracking-[.12em] mb-2">Superlearn 白板课回放</div>
              <div className="text-[20px] font-bold leading-snug mb-2">{reel?.lectureTitle || "加载中…"}</div>
              <div className="text-[13px] text-ink-soft leading-relaxed mb-1">{reel?.courseTitle}</div>
              <div className="text-[12px] text-ink-faint mb-6">
                共 {beats.length} 拍 · AI 讲师边讲边画 · {reel ? new Date(reel.createdAt).toLocaleDateString("zh-CN") : ""}
              </div>
              <button
                onClick={() => startPlay(0)}
                disabled={status === "loading"}
                className="w-full rounded-xl bg-accent py-3 text-[14px] font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                ▶ 播放回放
              </button>
            </div>
          </div>
        )}
        {/* 字幕条 */}
        {subtitle && (status === "playing" || status === "paused" || status === "done") && (
          <div className="board-subtitle" aria-live="polite">
            <span className="board-subtitle-label">讲师</span>
            <span>{subtitle}</span>
          </div>
        )}
      </div>

      {/* 底部：进度条 + 控制 */}
      <div className="h-14 border-t border-[#e7e5dc] flex items-center gap-4 px-4 shrink-0">
        <button
          onClick={() => (status === "playing" ? pause() : status === "paused" || status === "done" ? resume() : startPlay(0))}
          disabled={!beats.length}
          className="w-9 h-9 rounded-full bg-accent text-white text-[13px] flex items-center justify-center hover:opacity-90 disabled:opacity-40 shrink-0"
          aria-label={status === "playing" ? "暂停" : "播放"}
        >
          {status === "playing" ? "❚❚" : "▶"}
        </button>
        <div
          className="flex-1 h-2.5 rounded-full bg-[#efede5] relative cursor-pointer group"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            seek(Math.round(ratio * beats.length - 0.5));
          }}
        >
          <div className="h-full rounded-full bg-accent/80 transition-[width] duration-300" style={{ width: `${progress}%` }} />
          {beats.map((_, i) => (
            <span
              key={i}
              className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full ${i <= idx ? "bg-white" : "bg-[#e0d6c2]"}`}
              style={{ left: `calc(${((i + 0.5) / beats.length) * 100}% - 3px)` }}
            />
          ))}
        </div>
        <span className="text-[12px] text-ink-soft tabular-nums shrink-0">
          {idx + 1 < 0 ? 0 : idx + 1}/{beats.length} 拍
        </span>
      </div>
    </div>
  );
}
