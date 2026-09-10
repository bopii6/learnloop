"use client";

// 课程封面插画：从种子字符串（课程 id）确定性生成——同门课永远同一张图，零外部依赖。
// 主题感知：传入 title 时按关键词选纹样（代码/语言/数据/摄影…）并限定相应色相带，
// 让"20 张封面摆在一起"各有含义，而不是一堆与主题无关的随机粉彩图形。
// 未传 title 时退回纯种子随机（兼容旧调用）。

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 主题关键词 → 纹样 + 色相带。全族统一在暖阳手账色域（陶土 8-14 / 橙 16-28 / 琥珀金 30-52）。主题差异靠纹样与明度，不靠色相打架 */
const THEME_RULES: { kw: RegExp; motif: Motif; hues: number[] }[] = [
  { kw: /python|java|代码|编程|源码|开发|工程|部署|调试|closure|装饰器/i, motif: "terminal", hues: [30, 40, 24] },
  { kw: /agent|tool|llm|大模型|transformer|rag|prompt|ai\b|机器学习|深度学习|神经网络/i, motif: "nodes", hues: [18, 26, 46] },
  { kw: /英语|雅思|托福|语言|沟通|口语|写作|翻译/i, motif: "chat", hues: [42, 50, 34] },
  { kw: /数据|分析|报表|统计|可视化|商业智能|bi\b/i, motif: "chart", hues: [22, 32, 12] },
  { kw: /摄影|相机|镜头|光线|构图|人像/i, motif: "aperture", hues: [16, 26, 8] },
  { kw: /redis|分布式|后端|系统|架构|网络|数据库|并发|锁/i, motif: "layers", hues: [10, 20, 32] },
  { kw: /雅思|留学|备考|考试/i, motif: "flag", hues: [38, 48, 28] },
];

type Motif = "orbit" | "nodes" | "layers" | "wave" | "grid" | "terminal" | "chat" | "chart" | "aperture" | "flag";
const FALLBACK_MOTIFS: Motif[] = ["orbit", "wave", "grid"];

export function CourseCover({
  seed,
  title,
  className = "",
  rounded = "rounded-xl",
}: {
  seed: string;
  title?: string;
  className?: string;
  rounded?: string;
}) {
  const h = hashSeed(seed);
  let motif: Motif;
  let hue: number;
  const rule = title ? THEME_RULES.find((r) => r.kw.test(title)) : undefined;
  if (rule) {
    motif = rule.motif;
    hue = rule.hues[h % rule.hues.length];
  } else {
    motif = FALLBACK_MOTIFS[(h >>> 8) % FALLBACK_MOTIFS.length];
    hue = 8 + (h % 44); // 暖阳色域内取值，杜绝随机冷色
  }
  const bg = `hsl(${hue} 62% 92%)`;
  const deep = `hsl(${hue} 52% 58%)`;
  const soft = `hsl(${(hue + 12) % 60} 56% 80%)`;
  const ink = `hsl(${hue} 42% 34%)`;

  return (
    <div className={`relative overflow-hidden ${rounded} ${className}`} style={{ background: bg }}>
      <svg viewBox="0 0 160 160" className="absolute inset-0 h-full w-full" aria-hidden>
        {motif === "orbit" && (
          <g fill="none" stroke={ink} strokeWidth="2">
            <ellipse cx="80" cy="80" rx="58" ry="26" opacity="0.55" />
            <ellipse cx="80" cy="80" rx="58" ry="26" transform="rotate(60 80 80)" opacity="0.4" />
            <ellipse cx="80" cy="80" rx="58" ry="26" transform="rotate(-60 80 80)" opacity="0.4" />
            <circle cx="80" cy="80" r="13" fill={deep} stroke="none" />
            <circle cx="126" cy="66" r="6" fill={soft} stroke="none" />
          </g>
        )}
        {motif === "nodes" && (
          <g stroke={ink} strokeWidth="2" opacity="0.6">
            <line x1="40" y1="110" x2="80" y2="60" />
            <line x1="80" y1="60" x2="122" y2="96" />
            <line x1="80" y1="60" x2="96" y2="28" />
            <line x1="40" y1="110" x2="122" y2="96" />
          </g>
        )}
        {motif === "nodes" && (
          <g>
            <circle cx="80" cy="60" r="12" fill={deep} />
            <circle cx="40" cy="110" r="8" fill={soft} />
            <circle cx="122" cy="96" r="9" fill={ink} opacity="0.85" />
            <circle cx="96" cy="28" r="6" fill={soft} />
          </g>
        )}
        {motif === "layers" && (
          <g>
            <rect x="34" y="88" width="92" height="26" rx="9" fill={soft} />
            <rect x="34" y="62" width="92" height="26" rx="9" fill={deep} opacity="0.85" />
            <rect x="34" y="36" width="92" height="26" rx="9" fill={ink} opacity="0.8" />
          </g>
        )}
        {motif === "wave" && (
          <g fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round">
            <path d="M20 96 Q50 60 80 96 T140 96" opacity="0.75" />
            <path d="M20 116 Q50 80 80 116 T140 116" opacity="0.45" />
            <circle cx="112" cy="52" r="14" fill={deep} stroke="none" />
            <circle cx="40" cy="44" r="7" fill={soft} stroke="none" />
          </g>
        )}
        {motif === "grid" && (
          <g>
            {[0, 1, 2, 3].map((r) =>
              [0, 1, 2, 3].map((cIdx) => (
                <rect
                  key={`${r}-${cIdx}`}
                  x={36 + cIdx * 24}
                  y={36 + r * 24}
                  width="16"
                  height="16"
                  rx="4"
                  fill={(r + cIdx) % 3 === 0 ? deep : (r + cIdx) % 3 === 1 ? soft : "transparent"}
                  stroke={ink}
                  strokeWidth="1.5"
                  opacity={(r + cIdx) % 3 === 2 ? 0.35 : 0.9}
                />
              ))
            )}
          </g>
        )}
        {motif === "terminal" && (
          <g>
            <rect x="28" y="40" width="104" height="80" rx="10" fill="#fff" opacity="0.75" stroke={ink} strokeWidth="2" />
            <path d="M44 64l14 12-14 12" fill="none" stroke={deep} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M70 92h34" stroke={ink} strokeWidth="4" strokeLinecap="round" opacity="0.7" />
            <circle cx="40" cy="52" r="3" fill={deep} />
            <circle cx="50" cy="52" r="3" fill={soft} />
            <circle cx="60" cy="52" r="3" fill={soft} />
          </g>
        )}
        {motif === "chat" && (
          <g>
            <path d="M36 44h60a12 12 0 0 1 12 12v22a12 12 0 0 1-12 12H66l-16 14v-14h-14a12 12 0 0 1-12-12V56a12 12 0 0 1 12-12z" fill="#fff" opacity="0.8" stroke={ink} strokeWidth="2" />
            <path d="M62 62h32M62 74h20" stroke={deep} strokeWidth="4" strokeLinecap="round" />
            <path d="M112 78h14a10 10 0 0 1 10 10v14a10 10 0 0 1-10 10h-4v10l-12-10h-14a10 10 0 0 1-10-10v-4" fill={soft} stroke={ink} strokeWidth="2" opacity="0.9" />
          </g>
        )}
        {motif === "chart" && (
          <g>
            <rect x="36" y="92" width="18" height="36" rx="5" fill={soft} />
            <rect x="66" y="72" width="18" height="56" rx="5" fill={deep} />
            <rect x="96" y="50" width="18" height="78" rx="5" fill={ink} opacity="0.8" />
            <path d="M40 72 80 48l40-10" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
            <circle cx="120" cy="38" r="5" fill={deep} />
          </g>
        )}
        {motif === "aperture" && (
          <g fill="none" stroke={ink} strokeWidth="2.5">
            <circle cx="80" cy="80" r="44" opacity="0.8" />
            <circle cx="80" cy="80" r="16" fill={deep} stroke="none" />
            <path d="M80 36v20M80 104v20M36 80h20M104 80h20M49 49l14 14M97 97l14 14M111 49 97 63M63 97l-14 14" opacity="0.55" />
          </g>
        )}
        {motif === "flag" && (
          <g>
            <path d="M52 132V34" stroke={ink} strokeWidth="4" strokeLinecap="round" />
            <path d="M52 40c22-10 40 10 62 0v38c-22 10-40-10-62 0z" fill={soft} stroke={ink} strokeWidth="2.5" />
            <path d="m92 50 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill={deep} />
          </g>
        )}
      </svg>
    </div>
  );
}
