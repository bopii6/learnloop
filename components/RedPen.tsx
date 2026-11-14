// 红笔：老师批改时的手绘圈 / 下划线 / 勾。整站唯一的"装饰"语言——只用在真正的重点上。
// SVG 用 currentColor（.redpen = 朱红），non-scaling-stroke 保证任意宽度下笔画粗细一致；首次出现描画一次。
import type { ReactNode } from "react";

export function RedCircle({ children, draw = true }: { children: ReactNode; draw?: boolean }) {
  return (
    <span className="relative inline-block px-[0.12em]">
      {children}
      <svg
        className={`redpen pointer-events-none absolute left-[-0.28em] top-[-0.18em] h-[calc(100%+0.36em)] w-[calc(100%+0.56em)] ${draw ? "redpen-draw" : ""}`}
        viewBox="0 0 200 64"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden
      >
        <path
          d="M14 36 C 8 14, 62 4, 118 6 S 198 16, 192 36 C 186 56, 116 62, 66 58 S 2 48, 20 22"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

export function RedUnderline({ children, draw = true }: { children: ReactNode; draw?: boolean }) {
  return (
    <span className="relative inline-block">
      {children}
      <svg
        className={`redpen pointer-events-none absolute -bottom-[0.16em] left-[-0.06em] h-[0.34em] w-[calc(100%+0.12em)] ${draw ? "redpen-draw" : ""}`}
        viewBox="0 0 200 16"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden
      >
        <path d="M3 11 C 48 3, 112 15, 197 5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

/** 红笔勾：清单项、过关、"真做到的事" */
export function RedCheck({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`redpen shrink-0 ${className}`} fill="none" aria-hidden>
      <path d="M4 13.2c2.1 1.4 3.7 3.2 5 5.3C11.6 12.6 15.4 8 20.4 4.6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
