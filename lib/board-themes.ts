// 白板配色：卡片冷调（定稿，参考自扁平粉彩卡片信息图）。
// 近白灰纸面 + 藏蓝粗标题 + 粉蓝粉彩卡 + 编号圆徽 + 直线页眉；同一套交互（逐条书写/跟拍/角色）。
// 差异三件事：模块强调色按页轮换（accents）、图元上色块（nodeFills/表格头/金句底/判断行底）、纸面底色。
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

const CARD_COOL: BoardColors = {
  boardBg: "#f6f7f9",
  boardDot: "#e2e5eb",
  ink: "#1e3354",
  mute: "#7c8aa5",
  faint: "#c3cddc",
  accents: ["#5b87d4", "#7048e8", "#2f9e44", "#f08c00"],
  accent: "#5b87d4",
  diagramStroke: "#3b5175",
  chartAxis: "#a5b1c5",
  nodeFills: ["#dbe7fa", "#d3f9d8", "#fff3bf", "#fcc2d7"],
  tableHeadBg: "#dbe7fa",
  tableHeadStroke: "#e2e5eb",
  tableRowStroke: "#eceef3",
  quoteBg: "#5b87d41f",
  quoteStroke: "#5b87d4",
  judgeStroke: "#1e335414",
  judgeGoodBg: "#d3f9d8",
  judgeBadBg: "#ffe3e3",
  semGood: "#2f9e44",
  semBad: "#e03131",
  vsBadgeBg: "#ffffff",
  vsBadgeStroke: "#c3cddc",
  vsText: "#7c8aa5",
  backdropBg: "#ffffff",
  backdropStroke: "#1e335414",
};

// 共享可写色板对象：writer 持有它的引用，模块强调色轮换（beginSegment）原地改写、所有闭包即时可见
export const boardColors: BoardColors = {
  ...CARD_COOL,
  accents: [...CARD_COOL.accents],
  nodeFills: [...CARD_COOL.nodeFills],
};

export function getBoardTheme(): { colors: BoardColors } {
  return { colors: boardColors };
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
