"use client";

// 60 秒竖屏速览：把一节课的 beat 提炼成 9:16 知识卡片视频（标题卡 → 关键板书卡逐张展开 → 收尾卡），
// 底部烧录讲师原话字幕。canvas 逐帧绘制 + MediaRecorder 录制，产出可直接发抖音/小红书/Reels 的 WebM。
// 说明：浏览器 speechSynthesis 的音频无法写进媒体流，录制时旁白只在本机朗读；文件内为无声视频+字幕。
import { useCallback, useEffect, useRef, useState } from "react";

export interface ClipBeat {
  keyText: string; // 卡片大字（板书关键词）
  sectionLabel: string; // 卡片顶部小标签
  say: string; // 底部字幕（讲师原话）
}

interface VerticalClipModalProps {
  open: boolean;
  onClose: () => void;
  courseTitle: string;
  lectureTitle: string;
  beats: ClipBeat[];
}

const W = 720;
const H = 1280;
const DURATION_MS = 60000;
const INTRO_MS = 4200;
const OUTRO_MS = 5200;
const PAPER = "#fffcf4";
const INK = "#43301f";
const ACCENT = "#e8590c";
const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Segoe UI", sans-serif';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) {
        let last = lines[maxLines - 1];
        while (ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last + "…";
        return lines;
      }
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawPaper(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(232, 89, 12, 0.14)";
  for (let y = 18; y < H; y += 26) {
    for (let x = 18; x < W; x += 26) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function VerticalClipModal({ open, onClose, courseTitle, lectureTitle, beats }: VerticalClipModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"idle" | "recording" | "done">("idle");
  const [videoUrl, setVideoUrl] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const recRef = useRef<MediaRecorder | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  const urlRef = useRef("");
  const containerMimeRef = useRef("video/webm");

  const slides = beats.slice(0, 8);
  const slideMs = slides.length > 0 ? (DURATION_MS - INTRO_MS - OUTRO_MS) / slides.length : 0;

  /** 任意时刻的画面 */
  const draw = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;
      drawPaper(ctx);
      const M = 56;

      // 顶部进度条（分段）
      const segs = slides.length + 2;
      const segW = (W - M * 2 - (segs - 1) * 10) / segs;
      for (let i = 0; i < segs; i++) {
        const segStart = i === 0 ? 0 : i === segs - 1 ? INTRO_MS + slides.length * slideMs : INTRO_MS + (i - 1) * slideMs;
        const segDur = i === 0 ? INTRO_MS : i === segs - 1 ? OUTRO_MS : slideMs;
        const fill = Math.max(0, Math.min(1, (t - segStart) / segDur));
        ctx.fillStyle = i === segs - 1 ? "rgba(232,89,12,.25)" : "#eadfc8";
        ctx.beginPath();
        ctx.roundRect(M + i * (segW + 10), 44, segW, 7, 4);
        ctx.fill();
        if (fill > 0) {
          ctx.fillStyle = ACCENT;
          ctx.beginPath();
          ctx.roundRect(M + i * (segW + 10), 44, Math.max(6, segW * fill), 7, 4);
          ctx.fill();
        }
      }

      // 品牌行
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.roundRect(M, 78, 40, 40, 12);
      ctx.fill();
      ctx.font = `700 24px ${FONT_STACK}`;
      ctx.fillStyle = "#fff";
      ctx.fillText("S", M + 13, 106);
      ctx.font = `700 24px ${FONT_STACK}`;
      ctx.fillStyle = INK;
      ctx.fillText("Superlearn · 60 秒速览", M + 54, 106);

      const ease = (p: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

      if (t < INTRO_MS) {
        // ---- 标题卡 ----
        const p = ease(t / 500);
        ctx.save();
        ctx.globalAlpha = p;
        ctx.translate(0, (1 - p) * 26);
        ctx.font = `400 30px ${FONT_STACK}`;
        ctx.fillStyle = "#8a8880";
        ctx.fillText("一节课讲了什么？", M, 300);
        ctx.font = `700 62px ${FONT_STACK}`;
        ctx.fillStyle = INK;
        const lines = wrap(ctx, lectureTitle, W - M * 2, 3);
        lines.forEach((l, i) => ctx.fillText(l, M, 400 + i * 84));
        ctx.font = `400 27px ${FONT_STACK}`;
        ctx.fillStyle = "#8a8880";
        ctx.fillText(courseTitle.slice(0, 24), M, 400 + lines.length * 84 + 40);
        ctx.restore();
      } else if (t < INTRO_MS + slides.length * slideMs) {
        // ---- 板书卡片 ----
        const i = Math.floor((t - INTRO_MS) / slideMs);
        const local = t - INTRO_MS - i * slideMs;
        const s = slides[i];
        // 卡片滑入
        const enter = ease(local / 420);
        ctx.save();
        ctx.translate((1 - enter) * 60, 0);
        ctx.globalAlpha = enter;
        // 分区标签
        ctx.font = `600 26px ${FONT_STACK}`;
        const label = `第 ${i + 1}/${slides.length} 拍 · ${s.sectionLabel}`;
        ctx.fillStyle = ACCENT;
        ctx.fillText(label.slice(0, 22), M, 300);
        // 大字（打字机）
        ctx.font = `700 58px ${FONT_STACK}`;
        ctx.fillStyle = INK;
        const wrapped = wrap(ctx, s.keyText, W - M * 2, 4);
        const shown = Math.round(wrapped.join("").length * ease(local / (slideMs * 0.45)));
        let consumed = 0;
        wrapped.forEach((l, li) => {
          const take = Math.max(0, Math.min(l.length, shown - consumed));
          consumed += l.length;
          if (take > 0) ctx.fillText(l.slice(0, take), M, 396 + li * 82);
        });
        // 下划强调线
        const lw = ease((local - slideMs * 0.4) / 400) * 180;
        if (lw > 0) {
          ctx.fillStyle = ACCENT;
          ctx.beginPath();
          ctx.roundRect(M, 396 + wrapped.length * 82 - 26, lw, 9, 5);
          ctx.fill();
        }
        ctx.restore();
      } else {
        // ---- 收尾卡 ----
        const local = t - INTRO_MS - slides.length * slideMs;
        const p = ease(local / 500);
        ctx.save();
        ctx.globalAlpha = p;
        ctx.translate(0, (1 - p) * 26);
        ctx.font = `700 52px ${FONT_STACK}`;
        ctx.fillStyle = INK;
        ctx.fillText("这节课的完整版", M, 400);
        ctx.font = `700 52px ${FONT_STACK}`;
        ctx.fillStyle = ACCENT;
        ctx.fillText("在 Superlearn 上", M, 492);
        ctx.font = `400 27px ${FONT_STACK}`;
        ctx.fillStyle = "#8a8880";
        ctx.fillText(`${lectureTitle.slice(0, 16)} · AI 讲师边讲边画`, M, 590);
        ctx.restore();
      }

      // ---- 底部字幕卡（讲师原话） ----
      let say = "";
      if (t < INTRO_MS) say = `本节白板课：${lectureTitle}`;
      else if (t < INTRO_MS + slides.length * slideMs) {
        const i = Math.floor((t - INTRO_MS) / slideMs);
        say = slides[i]?.say || "";
      } else say = "点击链接，上你自己的那一节";
      const cardH = 210;
      ctx.fillStyle = "rgba(255,255,255,.96)";
      ctx.beginPath();
      ctx.roundRect(M - 8, H - cardH - 88, W - (M - 8) * 2, cardH, 24);
      ctx.fill();
      ctx.strokeStyle = "#e7e5dc";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = `600 22px ${FONT_STACK}`;
      ctx.fillStyle = ACCENT;
      ctx.fillText("讲师", M + 18, H - cardH - 88 + 48);
      ctx.font = `400 27px ${FONT_STACK}`;
      ctx.fillStyle = INK;
      const subLines = wrap(ctx, say, W - (M - 8) * 2 - 40, 3);
      subLines.forEach((l, i) => ctx.fillText(l, M + 18, H - cardH - 88 + 94 + i * 40));
  }, [lectureTitle, courseTitle, slides, slideMs]);

  // 打开时先画第 0 帧预览
  useEffect(() => {
    if (open && phase === "idle" && canvasRef.current) {
      draw(200);
    }
  }, [open, phase, draw]);

  const stopEverything = useCallback(() => {
    // setInterval 驱动（rAF 在面板后台时会被节流到停帧，导致录出空视频）
    window.clearInterval(rafRef.current);
    window.clearTimeout(timerRef.current);
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!slides.length) return;
    setError("");
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const stream = canvas.captureStream(30);
      // 优先 MP4（H.264）：Windows/macOS 自带播放器双击可放；WebM 只有 Chrome/部分播放器认
      const mime = [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4;codecs=avc1",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
      const isMp4 = Boolean(mime?.startsWith("video/mp4"));
      containerMimeRef.current = isMp4 ? "video/mp4" : "video/webm";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: containerMimeRef.current });
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(blob);
        setVideoUrl(urlRef.current);
        setPhase("done");
      };
      recRef.current = rec;
      rec.start(500);
      setPhase("recording");
      setProgress(0);

      // 旁白：随卡片切换在本机朗读（浏览器 TTS 音频无法进媒体流，不写入文件）
      const t0 = performance.now();
      let spokenIdx = -1;
      const loop = () => {
        const t = performance.now() - t0;
        draw(Math.min(t, DURATION_MS));
        setProgress(Math.min(1, t / DURATION_MS));
        if (t >= INTRO_MS && t < INTRO_MS + slides.length * slideMs) {
          const i = Math.floor((t - INTRO_MS) / slideMs);
          if (i !== spokenIdx) {
            spokenIdx = i;
            try {
              window.speechSynthesis.cancel();
              const u = new SpeechSynthesisUtterance(slides[i].say);
              u.lang = "zh-CN";
              u.rate = 1.15;
              window.speechSynthesis.speak(u);
            } catch {
              // ignore
            }
          }
        }
        if (t >= DURATION_MS) {
          stopEverything();
          try {
            rec.stop();
          } catch {
            // ignore
          }
          return;
        }
      };
      // 33ms ≈ 30fps：setInterval 驱动，避免 rAF 后台节流录出空视频
      rafRef.current = window.setInterval(loop, 33);
      timerRef.current = window.setTimeout(() => {
        window.clearInterval(rafRef.current);
        draw(DURATION_MS);
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }, DURATION_MS + 300);
    } catch (e) {
      setError("录制启动失败：" + (e instanceof Error ? e.message : String(e)));
      setPhase("idle");
    }
  }, [slides, slideMs, draw, stopEverything]);

  const cancelRecording = useCallback(() => {
    stopEverything();
    try {
      recRef.current?.stop();
    } catch {
      // ignore
    }
    setPhase("idle");
    setProgress(0);
  }, [stopEverything]);

  // 关闭时清理
  useEffect(() => {
    if (!open) {
      stopEverything();
      if (recRef.current && recRef.current.state === "recording") {
        try {
          recRef.current.stop();
        } catch {
          // ignore
        }
      }
      setPhase("idle");
      setVideoUrl("");
      setProgress(0);
    }
  }, [open, stopEverything]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/45 backdrop-blur-[2px]" onClick={phase === "recording" ? undefined : onClose}>
      <div className="rounded-3xl border border-[#e7e5dc] bg-white shadow-2xl p-6 w-[880px] max-w-[94%] flex gap-6" onClick={(e) => e.stopPropagation()}>
        {/* 预览区：9:16 */}
        <div className="shrink-0">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className="rounded-2xl border border-[#e7e5dc] block bg-[#fafaf7]"
            style={{ width: 252, height: 448 }}
          />
          {phase === "recording" && (
            <div className="mt-2 h-1.5 rounded-full bg-[#efede5] overflow-hidden">
              <div className="h-full bg-red-500 transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
        {/* 说明与操作 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="text-[11px] text-accent font-semibold tracking-[.1em] mb-1">面向传播 · 竖屏速览</div>
          <div className="text-[19px] font-bold mb-2">60 秒看完这节课</div>
          <div className="text-[12.5px] text-ink-soft leading-relaxed mb-1">
            从本节课的板书里提炼 {Math.min(slides.length, 8)} 张知识卡片，生成 720×1280 竖屏视频，底部带讲师原话字幕，直接可发抖音 / 小红书 / Reels。
          </div>
          <div className="text-[11.5px] text-ink-faint leading-relaxed mb-4">
            录制时讲师旁白只在本机朗读（浏览器 TTS 无法写入文件）；视频自带字幕，无声也可直接发布。
          </div>

          {phase === "done" && videoUrl ? (
            <>
              <video src={videoUrl} controls className="hidden" />
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12.5px] text-emerald-700 mb-4">
                ✓ 录制完成，60 秒竖屏视频已生成（{containerMimeRef.current === "video/mp4" ? "MP4" : "WebM"}）
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const ext = containerMimeRef.current === "video/mp4" ? "mp4" : "webm";
                    const a = document.createElement("a");
                    a.href = videoUrl;
                    a.download = `learnloop_60s_${lectureTitle.slice(0, 12)}.${ext}`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}
                  className="rounded-lg bg-accent px-4 py-2.5 text-[13px] text-white font-medium hover:opacity-90"
                >
                  ⬇ 下载视频（{containerMimeRef.current === "video/mp4" ? "MP4" : "WebM"}）
                </button>
                <button
                  onClick={() => {
                    setPhase("idle");
                    setVideoUrl("");
                  }}
                  className="rounded-lg border border-[#d3d1c7] px-4 py-2.5 text-[13px] text-ink-soft hover:border-accent hover:text-accent"
                >
                  再录一条
                </button>
              </div>
            </>
          ) : phase === "recording" ? (
            <button
              onClick={cancelRecording}
              className="self-start rounded-lg border border-red-300 text-red-600 px-4 py-2.5 text-[13px] hover:bg-red-50"
            >
              ■ 停止录制（{Math.round(progress * 60)}s / 60s）
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => void startRecording()}
                disabled={!slides.length}
                className="rounded-lg bg-accent px-4 py-2.5 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40"
              >
                ● 开始录制（60 秒）
              </button>
              <button onClick={onClose} className="rounded-lg border border-[#d3d1c7] px-4 py-2.5 text-[13px] text-ink-soft hover:border-accent">
                关闭
              </button>
            </div>
          )}
          {error && <div className="mt-3 text-[12px] text-red-600">{error}</div>}
        </div>
      </div>
    </div>
  );
}
