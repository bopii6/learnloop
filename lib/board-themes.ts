// 白板配色：暖阳手账（定稿）。只换色、不改排版与结构。
// 差异三件事：模块强调色按页轮换（accents）、图元上色块（nodeFills/表格头/金句底/判断行底）、纸面暖底。
// 已有旧课堂（经典墨绿配色）经 recolorMapsBetween(CLASSIC, SUNNY) 的映射整体重着色。

export type BoardPalette = "sunny";

export interface BoardColors {
  // 纸面（写入 CSS 变量 --board-bg / --board-dot）
  boardBg: string;
  boardDot: string;
  // 文字三阶
  ink: string;
  mute: string;
  faint: string;
  // 强调色：按模块轮换，accent 指向当前模块那颗
  accents: string[];
  accent: string; // 当前模块强调色（运行时被 beginSegment 改写，勿在主题里依赖具体值）
  // 图元
  diagramStroke: string;
  chartAxis: string;
  nodeFills: string[]; // 流程图/分支树节点色块，按序轮换（alpha hex，实心填充）
  tableHeadBg: string;
  tableHeadStroke: string;
  tableRowStroke: string;
  quoteBg: string;
  quoteStroke: string;
  judgeStroke: string;
  judgeGoodBg: string;
  judgeBadBg: string;
  semGood: string;
  semBad: string;
  vsBadgeBg: string;
  vsBadgeStroke: string;
  vsText: string;
  // 纸卡
  backdropBg: string;
  backdropStroke: string;
  // 锚点词圈底："auto" = 运行时取当前强调色 +1a 透明度
  anchorFill: string;
}

// 经典墨绿（v2.1 原值）：不再作为可选外观，只作为旧板书重着色的映射来源
const CLASSIC: BoardColors = {
  boardBg: "#faf9f6",
  boardDot: "#d3d1c7",
  ink: "#1e1e1e",
  mute: "#8a8880",
  faint: "#b4b2a9",
  accents: ["#0f6e56"],
  accent: "#0f6e56",
  diagramStroke: "#57534e",
  chartAxis: "#8a8880",
  nodeFills: ["#e6e2d4"],
  tableHeadBg: "#f1efe8",
  tableHeadStroke: "#d3d1c7",
  tableRowStroke: "#e7e5dc",
  quoteBg: "#0f6e560f",
  quoteStroke: "#0f6e56",
  judgeStroke: "#1e1e1e2b",
  judgeGoodBg: "transparent",
  judgeBadBg: "transparent",
  semGood: "#047857",
  semBad: "#b91c1c",
  vsBadgeBg: "#1e1e1e08",
  vsBadgeStroke: "#a3a19a",
  vsText: "#a3a19a",
  backdropBg: "#ffffff",
  backdropStroke: "#1e1e1e1f",
  anchorFill: "transparent",
};

// 暖阳手账：奶油纸 + 陶土/青/琥珀/莓红四色按页轮换，暖色块手账感
const SUNNY: BoardColors = {
  boardBg: "#f8efdd",
  boardDot: "#e0cfae",
  ink: "#43301f",
  mute: "#a3896b",
  faint: "#d6c5a5",
  accents: ["#e8590c", "#0c8a83", "#f08c00", "#c2255c"],
  accent: "#e8590c",
  diagramStroke: "#6b4f35",
  chartAxis: "#a3896b",
  nodeFills: ["#ffd8a838", "#96f2d733", "#ffec9938", "#fcc2d733"],
  tableHeadBg: "#fdebd4",
  tableHeadStroke: "#ecc794",
  tableRowStroke: "#f5e3c8",
  quoteBg: "#ffec9942",
  quoteStroke: "#e8590c",
  judgeStroke: "#43301f26",
  judgeGoodBg: "#2f9e4414",
  judgeBadBg: "#c92a2a14",
  semGood: "#2f9e44",
  semBad: "#c92a2a",
  vsBadgeBg: "#fdebd4",
  vsBadgeStroke: "#d6c5a5",
  vsText: "#a3896b",
  backdropBg: "#fffcf4",
  backdropStroke: "#43301f17",
  anchorFill: "auto",
};

export function getBoardTheme(id: BoardPalette): { colors: BoardColors } {
  return { colors: { ...SUNNY, accents: [...SUNNY.accents], nodeFills: [...SUNNY.nodeFills] } };
}

/** 课堂 chrome 的主题色（Tailwind accent 经 --accent-rgb 系列变量引用，见 globals.css 的 .classroom-sunny） */
export const CHROME_VARS: Record<string, string> = {
  "--accent-rgb": "232 89 12",
  "--accent-soft-rgb": "253 235 212",
  "--accent-border-rgb": "236 199 148",
};

const STROKE_KEYS: (keyof BoardColors)[] = [
  "ink",
  "mute",
  "faint",
  "semGood",
  "semBad",
  "diagramStroke",
  "chartAxis",
  "backdropStroke",
  "judgeStroke",
  "tableHeadStroke",
  "tableRowStroke",
  "quoteStroke",
  "vsBadgeStroke",
  "vsText",
];
const BG_KEYS: (keyof BoardColors)[] = [
  "backdropBg",
  "tableHeadBg",
  "quoteBg",
  "vsBadgeBg",
];

export interface RecolorMaps {
  stroke: Map<string, string>;
  bg: Map<string, string>;
  solidify: Set<string>; // 旧中性排线填充 → 新实心色块时需要一并改 fillStyle
}

/** 从旧主题到新主题的整板重着色映射（transparent 不参与，避免把所有描边元素染色） */
export function recolorMapsBetween(from: BoardColors, to: BoardColors): RecolorMaps {
  const stroke = new Map<string, string>();
  const bg = new Map<string, string>();
  const solidify = new Set<string>();
  for (const k of STROKE_KEYS) {
    const a = from[k] as string;
    const b = to[k] as string;
    if (a && b && a !== b && a !== "transparent") stroke.set(a, b);
  }
  for (const k of BG_KEYS) {
    const a = from[k] as string;
    const b = to[k] as string;
    if (a && b && a !== b && a !== "transparent") bg.set(a, b);
  }
  from.nodeFills.forEach((v, i) => {
    if (!v || v === "transparent") return;
    const nv = to.nodeFills[i % to.nodeFills.length];
    if (nv && nv !== v) {
      bg.set(v, nv);
      solidify.add(v);
    }
  });
  return { stroke, bg, solidify };
}

/** 旧板书（经典墨绿）→ 暖阳手账 的重着色映射，writer 初始化时构建一次 */
export function classicToSunnyMaps(): RecolorMaps {
  return recolorMapsBetween(CLASSIC, SUNNY);
}

/** 纸面 CSS 变量值（CourseSession 根节点注入） */
export function boardCssVars(): Record<string, string> {
  return {
    "--board-bg": SUNNY.boardBg,
    "--board-dot": SUNNY.boardDot,
  };
}
