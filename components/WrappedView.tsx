"use client";

// 学习战报（Wrapped 式）：把本地学习数据变成一张可晒的成就卡。
// 页内是逐张浮现的战报卡；「生成分享卡」在 canvas 上排一张 1080×1350 的海报可下载/复制。
import { useCallback, useEffect, useRef, useState } from "react";

interface Stats {
  name: string;
  facts: number;
  coursesCount: number;
  lecturesCount: number;
  lecturesTouched: number;
  totalMinutes: number;
  convCount: number;
  boardChars: number;
  spokenChars: number;
  streak: number;
  activeDays: number;
  recentDays: { date: string; active: boolean }[];
  topTags: { tag: string; count: number }[];
  topCourses: { title: string; lectures: number }[];
  generatedAt: number;
}

const PAPER = "#fafaf7";
const INK = "#1a1a18";
const INK_SOFT = "#5f5e5a";
const INK_FAINT = "#a3a19a";
const ACCENT = "#0f6e56";
const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Segoe UI", sans-serif';

function fmtMinutes(m: number): string {
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest > 0 ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
  }
  return `${m} 分钟`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) return lines;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 1080×1350 分享卡（Instagram/小红书 4:5 比例） */
async function renderShareCard(s: Stats): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const M = 72;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(93, 202, 165, 0.20)";
  for (let y = 18; y < H; y += 26) {
    for (let x = 18; x < W; x += 26) {
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 顶部绿色晕染
  const grad = ctx.createLinearGradient(0, 0, 0, 420);
  grad.addColorStop(0, "rgba(93,202,165,.16)");
  grad.addColorStop(1, "rgba(93,202,165,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 420);

  // 品牌行
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(M, 64, 40, 40, 12);
  ctx.fill();
  ctx.font = `700 24px ${FONT_STACK}`;
  ctx.fillStyle = "#fff";
  ctx.fillText("L", M + 13, 92);
  ctx.font = `700 24px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  ctx.fillText("LearnLoop · 学习战报", M + 54, 92);

  // 大标题
  ctx.font = `700 58px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  ctx.fillText(`${s.name || "我"}的 AI 白板课堂`, M, 208);
  ctx.font = `400 26px ${FONT_STACK}`;
  ctx.fillStyle = INK_SOFT;
  ctx.fillText(`${new Date().getFullYear()} 年学习战报`, M, 254);

  // 2×2 大数字
  const cells = [
    { v: String(s.coursesCount), u: "门课程", l: "AI 为你量身建课" },
    { v: fmtMinutes(s.totalMinutes).split(" ")[0], u: fmtMinutes(s.totalMinutes).replace(/^[^ ]+ ?/, ""), l: "白板课累计时长" },
    { v: String(s.boardChars), u: "个字", l: "讲师在白板为你写下" },
    { v: String(s.streak), u: "天连击", l: "最近连续学习" },
  ];
  const cw = (W - M * 2 - 28) / 2;
  let cy = 320;
  cells.forEach((c, i) => {
    const cx = M + (i % 2) * (cw + 28);
    if (i % 2 === 0 && i > 0) cy += 220;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(cx, cy, cw, 190, 24);
    ctx.fill();
    ctx.strokeStyle = "#e7e5dc";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `800 72px ${FONT_STACK}`;
    ctx.fillStyle = ACCENT;
    const vWidth = ctx.measureText(c.v).width;
    ctx.fillText(c.v, cx + 32, cy + 96);
    ctx.font = `600 27px ${FONT_STACK}`;
    ctx.fillStyle = INK;
    ctx.fillText(c.u, cx + 32 + vWidth + 14, cy + 96);
    ctx.font = `400 22px ${FONT_STACK}`;
    ctx.fillStyle = INK_FAINT;
    ctx.fillText(c.l, cx + 32, cy + 144);
  });
  cy += 220;

  // 标签云
  if (s.topTags.length > 0) {
    ctx.font = `400 23px ${FONT_STACK}`;
    ctx.fillStyle = INK_FAINT;
    ctx.fillText("你在学的", M, cy + 18);
    let px = M;
    const py = cy + 40;
    ctx.font = `500 24px ${FONT_STACK}`;
    for (const t of s.topTags.slice(0, 5)) {
      const label = `#${t.tag}`;
      const tw = ctx.measureText(label).width + 30;
      if (px + tw > W - M) break;
      ctx.fillStyle = "rgba(15,110,86,.08)";
      ctx.beginPath();
      ctx.roundRect(px, py, tw, 46, 23);
      ctx.fill();
      ctx.fillStyle = ACCENT;
      ctx.fillText(label, px + 15, py + 31);
      px += tw + 12;
    }
  }

  // 最近 14 天
  const ry = 950;
  ctx.font = `400 23px ${FONT_STACK}`;
  ctx.fillStyle = INK_FAINT;
  ctx.fillText("最近 14 天", M, ry - 24);
  const dw = (W - M * 2 - 13 * 14) / 14;
  s.recentDays.forEach((d, i) => {
    const dx = M + i * (dw + 14);
    ctx.fillStyle = d.active ? ACCENT : "#e7e5dc";
    ctx.beginPath();
    ctx.roundRect(dx, ry, dw, 34, 8);
    ctx.fill();
  });

  // 底部
  ctx.font = `500 24px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  ctx.fillText(`${s.lecturesCount} 个课节 · ${s.spokenChars} 字讲解 · ${s.activeDays} 个学习日`, M, 1120);
  ctx.font = `400 21px ${FONT_STACK}`;
  ctx.fillStyle = INK_FAINT;
  ctx.fillText("输入任何想搞懂的事，AI 讲师为你边讲边画 · LearnLoop", M, 1180);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("分享卡渲染失败");
  return blob;
}

export function WrappedView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [shareState, setShareState] = useState<"idle" | "rendering" | "done" | "copied" | "fail">("idle");
  const shareBlobRef = useRef<Blob | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => setStats(d))
      .catch(() => setError("战报数据加载失败"));
  }, []);

  const makeShare = useCallback(async () => {
    if (!stats) return;
    setShareState("rendering");
    try {
      const blob = await renderShareCard(stats);
      shareBlobRef.current = blob;
      setShareState("done");
      // 自动触发下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "learnloop_学习战报.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      setShareState("fail");
    }
  }, [stats]);

  const copyShare = useCallback(async () => {
    if (!shareBlobRef.current) {
      await makeShare();
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": shareBlobRef.current })]);
      setShareState("copied");
    } catch {
      setShareState("fail");
    }
  }, [makeShare]);

  if (error) {
    return <div className="max-w-3xl mx-auto px-6 py-16 text-[13px] text-red-600">{error}</div>;
  }
  if (!stats) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-[13px] text-ink-soft animate-pulse">正在翻你的学习记录…</div>
    );
  }
  if (stats.coursesCount === 0) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-20 text-center">
        <div className="text-[20px] font-bold mb-2">战报还是空的</div>
        <div className="text-[13px] text-ink-soft">去首页输入一个想搞懂的问题，生成你的第一节白板课，战报就开始累计了。</div>
      </div>
    );
  }

  const cards = [
    {
      icon: "📚",
      big: `${stats.coursesCount}`,
      unit: "门课程",
      desc: `${stats.lecturesCount} 个课节等你上，已上过 ${stats.lecturesTouched} 节`,
    },
    {
      icon: "⏱",
      big: fmtMinutes(stats.totalMinutes),
      unit: "",
      desc: "白板课累计时长，AI 讲师全程边讲边画",
    },
    {
      icon: "✍️",
      big: `${stats.boardChars}`,
      unit: "个字",
      desc: `讲师在白板上为你写下的板书，另有 ${stats.spokenChars} 字讲解词`,
    },
    {
      icon: "🔥",
      big: `${stats.streak}`,
      unit: "天连击",
      desc: `累计 ${stats.activeDays} 个学习日${stats.facts > 0 ? ` · 画像记住了你 ${stats.facts} 条偏好` : ""}`,
    },
  ];

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* 标题行 */}
      <div className="flex items-end justify-between mb-8 fade-up">
        <div>
          <div className="text-[12px] text-accent font-semibold tracking-[.12em] mb-1">WRAPPED · {new Date().getFullYear()}</div>
          <div className="text-[28px] font-bold leading-tight">
            {stats.name || "你"}的学习战报
          </div>
          <div className="text-[13px] text-ink-soft mt-1">这一年在 LearnLoop 白板课堂里留下的痕迹</div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => void makeShare()}
            disabled={shareState === "rendering"}
            className="rounded-lg bg-accent px-4 py-2 text-[12.5px] text-white font-medium hover:opacity-90 disabled:opacity-50"
          >
            {shareState === "rendering" ? "生成中…" : "🖼 生成分享卡"}
          </button>
          <button
            onClick={() => void copyShare()}
            className="rounded-lg border border-[#d3d1c7] px-4 py-2 text-[12.5px] text-ink-soft hover:border-accent hover:text-accent"
          >
            {shareState === "copied" ? "✓ 已复制" : "复制"}
          </button>
        </div>
      </div>
      {shareState === "done" && (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12.5px] text-emerald-700 fade-up">
          ✓ 分享卡已生成并开始下载（1080×1350），也可点「复制」直接粘贴到聊天/笔记里
        </div>
      )}

      {/* 战报卡 */}
      <div className="rounded-3xl border border-[#e7e5dc] bg-white shadow-sm overflow-hidden mb-5 fade-up" style={{ animationDelay: "60ms" }}>
        <div className="px-7 py-8" style={{ background: "linear-gradient(180deg, rgba(93,202,165,.14), rgba(255,255,255,0))" }}>
          <div className="text-[15px] font-bold mb-1">
            {stats.name || "你"} 在白板课堂上度过了 <span className="text-accent">{fmtMinutes(stats.totalMinutes)}</span>
          </div>
          <div className="text-[12.5px] text-ink-soft">从第一个问题开始，AI 讲师为你边讲边画</div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-[#e7e5dc]">
          {cards.map((c, i) => (
            <div key={i} className="px-7 py-6 fade-up" style={{ animationDelay: `${120 + i * 90}ms` }}>
              <div className="text-[22px] mb-1.5">{c.icon}</div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-[34px] font-extrabold text-accent leading-none tabular-nums">{c.big}</span>
                {c.unit && <span className="text-[15px] font-semibold">{c.unit}</span>}
              </div>
              <div className="text-[12px] text-ink-soft mt-2 leading-relaxed">{c.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 最近 14 天 + 标签 */}
      <div className="grid gap-5 md:grid-cols-2 mb-5">
        <div className="rounded-2xl border border-[#e7e5dc] bg-white p-6 fade-up" style={{ animationDelay: "480ms" }}>
          <div className="text-[12px] text-ink-faint uppercase tracking-wider mb-4">最近 14 天</div>
          <div className="flex gap-[7px]">
            {stats.recentDays.map((d, i) => (
              <div key={d.date} className="flex-1" title={d.date}>
                <div className={`h-9 rounded-lg ${d.active ? "bg-accent" : "bg-[#efede5]"}`} style={{ animationDelay: `${520 + i * 30}ms` }} />
                <div className="text-[9px] text-ink-faint text-center mt-1.5">{Number(d.date.slice(8))}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-[#e7e5dc] bg-white p-6 fade-up" style={{ animationDelay: "560ms" }}>
          <div className="text-[12px] text-ink-faint uppercase tracking-wider mb-4">你在学的</div>
          <div className="flex gap-2 flex-wrap">
            {stats.topTags.length > 0 ? (
              stats.topTags.map((t) => (
                <span key={t.tag} className="rounded-full border border-accent/25 bg-accent/5 text-accent px-3 py-1 text-[12px] font-medium">
                  #{t.tag}
                </span>
              ))
            ) : (
              <span className="text-[12px] text-ink-faint">还没有标签</span>
            )}
          </div>
          {stats.topCourses[0] && (
            <div className="text-[11.5px] text-ink-soft mt-4 pt-4 border-t border-[#e7e5dc] leading-relaxed">
              最近一门课：《{stats.topCourses[0].title}》（{stats.topCourses[0].lectures} 讲）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
