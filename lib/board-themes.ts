// 白板配色：墨纸（v3）。白纸黑字 + 单一深墨强调 + 大量留白，卡片靠细线与字重分层，不靠粉彩色块。
// 高级感的来源是"克制"：一颗强调色（深墨蓝）、中性灰阶、无彩色糖果、无大圆角。
// 差异三件事：模块强调色按页轮换（accents，这里只有一颗，恒定）、图元素色（nodeFills/表格头）、纸面底色。
// 已有旧课堂（经典墨绿配色）经 recolorMapsBetween(CLASSIC, 当前色) 的映射整体重着色。

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
  nodeFills: string[]; // 流程图/分支树节点色块，按序轮换（实心填充）
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
}

// 经典墨绿（v2.1 原值）：只作为旧板书重着色的映射来源
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
};

// 墨纸（v3）：白纸 + 近黑墨字 + 一颗深墨蓝强调色 + 中性灰阶图元
const INK_PAPER: BoardColors = {
  boardBg: "#fbfbfa",
  boardDot: "#e8e8e5",
  ink: "#17181a",
  mute: "#6b7076",
  faint: "#c4c7cc",
  // 只有一颗强调色：模块之间不换色。印刷品的高级感来自一致性，不是彩虹
  accents: ["#1f3a5f"],
  accent: "#1f3a5f",
  diagramStroke: "#4b5563",
  chartAxis: "#9ca3af",
  // 图元底色：近中性浅灰（同一色系里极轻的层次差），不再有粉蓝粉绿
  nodeFills: ["#f3f4f6", "#eef0f2", "#f5f4f1", "#eceff1"],
  tableHeadBg: "#f3f4f6",
  tableHeadStroke: "#d8dbdf",
  tableRowStroke: "#e6e8eb",
  quoteBg: "transparent",
  quoteStroke: "#1f3a5f",
  judgeStroke: "#dee1e5",
  judgeGoodBg: "transparent",
  judgeBadBg: "transparent",
  semGood: "#1b7a4b",
  semBad: "#a4342a",
  vsBadgeBg: "#ffffff",
  vsBadgeStroke: "#d8dbdf",
  vsText: "#9aa0a6",
  backdropBg: "#ffffff",
  backdropStroke: "#e6e8eb",
};

// 共享可写色板对象：writer 持有它的引用，模块强调色轮换（beginSegment）原地改写、所有闭包即时可见
export const boardColors: BoardColors = {
  ...INK_PAPER,
  accents: [...INK_PAPER.accents],
  nodeFills: [...INK_PAPER.nodeFills],
};

export function getBoardTheme(): { colors: BoardColors } {
  return { colors: boardColors };
}

/** 课堂 chrome 的主题色（Tailwind accent 经 --accent-rgb 系列变量引用，见 globals.css 的 .classroom-sunny）
 *  跟随墨纸主题：深墨蓝取代原来的暖橙，课堂外壳与白板同一套语言 */
export const CHROME_VARS: Record<string, string> = {
  "--accent-rgb": "31 58 95",
  "--accent-soft-rgb": "237 241 246",
  "--accent-border-rgb": "205 214 226",
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

/** 旧板书（经典墨绿）→ 卡片冷调 的重着色映射，writer 恢复路径时构建 */
export function classicRecolorMaps(): RecolorMaps {
  return recolorMapsBetween(CLASSIC, boardColors);
}

/** 纸面 CSS 变量值（CourseSession 根节点注入） */
export function boardCssVars(): Record<string, string> {
  return {
    "--board-bg": boardColors.boardBg,
    "--board-dot": boardColors.boardDot,
  };
}
