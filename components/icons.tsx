"use client";

// 全站共享线性图标（stroke = currentColor，跟随文字颜色）。
// 取代此前散落在课堂顶栏/首页的 emoji 图标：emoji 跨平台渲染成彩色卡通，
// 与侧栏的线性 SVG 不同体系，破坏整页质感。新增图标请保持同一笔画风格。
export function Icon({
  name,
  className = "h-[14px] w-[14px]",
}: {
  name:
    | "play"
    | "pause"
    | "voice"
    | "voice-off"
    | "mic"
    | "speed"
    | "fit"
    | "poster"
    | "clip"
    | "link"
    | "zoom-in"
    | "zoom-out"
    | "paperclip"
    | "note"
    | "medal"
    | "clock";
  className?: string;
}) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true as const,
  };
  switch (name) {
    case "play":
      return (
        <svg {...common}>
          <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common}>
          <path d="M8 4.5v15M16 4.5v15" fill="currentColor" />
        </svg>
      );
    case "voice":
      return (
        <svg {...common}>
          <path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="currentColor" stroke="none" />
          <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
          <path d="M17.8 7a7 7 0 0 1 0 10" />
        </svg>
      );
    case "voice-off":
      return (
        <svg {...common}>
          <path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="currentColor" stroke="none" />
          <path d="m16 9.5 5 5M21 9.5l-5 5" />
        </svg>
      );
    case "mic":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
        </svg>
      );
    case "speed":
      return (
        <svg {...common}>
          <path d="M4 17a8 8 0 1 1 16 0" />
          <path d="m12 13 4-4" />
          <path d="M4 17h2M18 17h2" />
        </svg>
      );
    case "fit":
      return (
        <svg {...common}>
          <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      );
    case "poster":
      return (
        <svg {...common}>
          <rect x="6" y="3" width="12" height="18" rx="2" />
          <path d="M9 7.5h6M9 11h6M9 14.5h3.5" />
        </svg>
      );
    case "clip":
      return (
        <svg {...common}>
          <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
          <path d="m10.5 9.5 4 2.5-4 2.5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          <path d="M10 14a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1 1" />
          <path d="M14 10a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1-1" />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      );
    case "paperclip":
      return (
        <svg {...common}>
          <path d="m21 12-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 4.4a3.7 3.7 0 0 1 5.2 5.2L10 17.8a1.8 1.8 0 0 1-2.6-2.6L15 7.6" />
        </svg>
      );
    case "note":
      return (
        <svg {...common}>
          <rect x="5" y="3.5" width="14" height="17" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h3.5" />
        </svg>
      );
    case "medal":
      return (
        <svg {...common} className="h-[46px] w-[46px]">
          <circle cx="12" cy="14.5" r="5.5" />
          <circle cx="12" cy="14.5" r="2.2" />
          <path d="m8.5 9.5-3-6h4l2.5 4.6L14.5 3.5h4l-3 6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
  }
}
