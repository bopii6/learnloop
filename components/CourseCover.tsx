"use client";

// 课程封面插画：从种子字符串（课程 id）确定性生成——同门课永远同一张图，零外部依赖。
// 粉彩底 + 抽象几何纹样（轨道/节点/层叠/波浪/格点），呼应"AI 课"的产品气质。
const MOTIFS = ["orbit", "nodes", "layers", "wave", "grid"] as const;

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function CourseCover({
  seed,
  className = "",
  rounded = "rounded-xl",
}: {
  seed: string;
  className?: string;
  rounded?: string;
}) {
  const h = hashSeed(seed);
  const hue = h % 360;
  const motif = MOTIFS[(h >>> 8) % MOTIFS.length];
  const bg = `hsl(${hue} 52% 91%)`;
  const deep = `hsl(${hue} 42% 62%)`;
  const soft = `hsl(${(hue + 40) % 360} 55% 78%)`;
  const ink = `hsl(${hue} 35% 38%)`;

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
      </svg>
    </div>
  );
}
