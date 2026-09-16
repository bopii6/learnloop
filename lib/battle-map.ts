// 战况图（征途计分牌）：把"结课作品 + 为它贡献的每一块"画成一条竖向征途。
// 白板的更高角色——不再是老师的地方，而是学员的目标被啃掉了多少：
// 作品是终点旗，课程单元是路上的每一块，讲完一块就点亮一块、盖一枚章。
// 纯确定性排版（无 LLM、无素材），与 board-writer 的 append 骨架格式一致。
import { boardColors } from "@/lib/board-themes";

export type BattleBlockState = "todo" | "doing" | "today" | "done";

export interface BattleMapLecture {
  id: string;
  title: string;
  done: boolean;
}

export interface BattleMapBlock {
  index: number; // 1-based，与课程单元顺序一致
  title: string; // 单元标题
  contribution: string; // 这个单元为作品贡献哪一块（单元 summary）
  state: BattleBlockState;
  lectures: BattleMapLecture[];
}

export interface BattleMapData {
  goal: string; // 结课作品名（一个名词）
  goalDesc?: string; // 学员结课时手里具体有什么
  blocks: BattleMapBlock[];
  criteria?: string[]; // 做成标准：结课那天逐条验收
}

export interface BattleMapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Skeleton = Record<string, unknown>;
const CLEAN = { roughness: 0 };

const W = 660;
const CARD_X = 52; // 卡片左边距（给竖向主干线让位）
const CARD_PAD = 18;
const MARKER_R = 15;

function rect(x: number, y: number, w: number, h: number, o: { stroke?: string; fill?: string; width?: number; dash?: boolean } = {}): Skeleton {
  return {
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    strokeColor: o.stroke ?? "transparent",
    backgroundColor: o.fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: o.width ?? 1.4,
    ...(o.dash ? { strokeStyle: "dashed" } : {}),
    // 直角：墨纸主题不做圆角卡
    roundness: null,
    ...CLEAN,
  };
}

function line(x: number, y: number, x2: number, y2: number, o: { stroke?: string; width?: number; dash?: boolean } = {}): Skeleton {
  return {
    type: "line",
    x,
    y,
    points: [
      [0, 0],
      [x2 - x, y2 - y],
    ],
    strokeColor: o.stroke ?? "#c9c9c9",
    strokeWidth: o.width ?? 1.4,
    ...(o.dash ? { strokeStyle: "dashed" } : {}),
    ...CLEAN,
  };
}

function ellipse(x: number, y: number, w: number, h: number, o: { stroke?: string; fill?: string; width?: number } = {}): Skeleton {
  return {
    type: "ellipse",
    x,
    y,
    width: w,
    height: h,
    strokeColor: o.stroke ?? "transparent",
    backgroundColor: o.fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: o.width ?? 0,
    ...CLEAN,
  };
}

function txt(x: number, y: number, text: string, fontSize: number, stroke: string, fontFamily = 5): Skeleton {
  return { type: "text", x, y, text, fontSize, fontFamily, strokeColor: stroke, ...CLEAN };
}

/** 中文逐字换行（长词组也能排），最多 maxLines 行，末行加省略号 */
function wrap(text: string, per: number, maxLines = 99): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (cur.length >= per) {
      out.push(cur);
      cur = "";
      if (out.length >= maxLines) break;
    }
    cur += ch;
  }
  if (cur && out.length < maxLines) out.push(cur);
  return out.length ? out : [""];
}

interface BlockStyle {
  cardFill: string;
  cardStroke: string;
  cardDash: boolean;
  markerFill: string;
  markerStroke: string;
  markerText: string;
  markerTextColor: string;
  titleColor: string;
  chipFill: string;
  chipStroke: string;
  chipText: string;
}

// 墨纸语言：卡片一律白底 + 细边框（直角），状态只用"节点圆徽 + 标签"表达，不用彩色底块
const HAIRLINE = "#e6e8eb";
const HAIRLINE_STRONG = "#d8dbdf";

function blockStyle(state: BattleBlockState, accent: string, good: string, ink: string, mute: string, faint: string): BlockStyle {
  switch (state) {
    case "done":
      return {
        cardFill: "#ffffff",
        cardStroke: HAIRLINE,
        cardDash: false,
        markerFill: good,
        markerStroke: good,
        markerText: "✓",
        markerTextColor: "#ffffff",
        titleColor: ink,
        chipFill: "#f3f4f6",
        chipStroke: HAIRLINE,
        chipText: good,
      };
    case "today":
      return {
        cardFill: "#ffffff",
        cardStroke: accent,
        cardDash: false,
        markerFill: accent,
        markerStroke: accent,
        markerText: "",
        markerTextColor: "#ffffff",
        titleColor: ink,
        chipFill: "#f3f4f6",
        chipStroke: HAIRLINE_STRONG,
        chipText: ink,
      };
    case "doing":
      return {
        cardFill: "#ffffff",
        cardStroke: HAIRLINE_STRONG,
        cardDash: false,
        markerFill: "#ffffff",
        markerStroke: accent,
        markerText: "",
        markerTextColor: ink,
        titleColor: ink,
        chipFill: "#f3f4f6",
        chipStroke: HAIRLINE,
        chipText: ink,
      };
    default:
      return {
        cardFill: "transparent",
        cardStroke: faint,
        cardDash: false,
        markerFill: "#ffffff",
        markerStroke: faint,
        markerText: "",
        markerTextColor: ink,
        titleColor: mute,
        chipFill: "transparent",
        chipStroke: faint,
        chipText: mute,
      };
  }
}

/** 一块里讲次小砖的高度（单行） */
const CHIP_H = 26;
const CHIP_GAP = 8;
const CHIP_PAD = 18;
/** 讲次标题最多显示几个字（超出截断） */
const CHIP_MAX = 18;

/** 讲次标题显示文本（截断） */
function chipText(title: string): string {
  return title.length > CHIP_MAX ? title.slice(0, CHIP_MAX) + "…" : title;
}

/** 按字宽估算小砖宽度：汉字 ≈ 13px、ASCII ≈ 7px（拉丁标题不至于被撑出一片空白） */
function chipWidth(shown: string): number {
  let w = CHIP_PAD;
  for (const ch of shown) w += ch.charCodeAt(0) < 256 ? 7 : 13;
  return w;
}

/** 计算一块里讲次小砖排成几行 */
function chipRows(lectures: BattleMapLecture[], maxW: number): number {
  if (lectures.length === 0) return 0;
  let x = 0;
  let rows = 1;
  for (const l of lectures) {
    const w = Math.min(chipWidth(chipText(l.title)), maxW);
    if (x > 0 && x + w > maxW) {
      rows += 1;
      x = 0;
    }
    x += w + CHIP_GAP;
  }
  return rows;
}

/**
 * 战况图整块排版：画在 (ox, oy) 起，宽 W。
 * 返回元素、总宽高、以及每一块的卡片盒（结课盖章时按盒覆盖）。
 */
export function buildBattleMapSkeleton(
  map: BattleMapData,
  ox: number,
  oy: number
): { elements: Skeleton[]; width: number; height: number; blockBoxes: BattleMapBox[] } {
  const els: Skeleton[] = [];
  const ink = boardColors.ink;
  const mute = boardColors.mute;
  const faint = boardColors.faint;
  const accent = boardColors.accents[0];
  const good = boardColors.semGood;

  let y = oy;

  // ---- 标题：征途的名字就是学员的作品（去掉 emoji，用排版立威）----
  els.push(rect(ox, y + 8, 8, 8, { fill: accent }));
  els.push(txt(ox + 16, y, "我的征途", 26, ink));
  els.push(txt(ox + 16 + 4 * 26 + 12, y + 9, `· ${map.goal}`, 15, mute));
  y += 38;
  if (map.goalDesc) {
    for (const ln of wrap(map.goalDesc, 42, 2)) {
      els.push(txt(ox, y, ln, 13, mute));
      y += 18;
    }
  }
  y += 4;
  els.push(line(ox, y, ox + W, y, { stroke: faint, width: 1.2 }));
  y += 20;

  // ---- 每一块：单元 = 作品的一块 ----
  const spineX = ox + 26;
  const cardW = W - CARD_X;
  const blockBoxes: BattleMapBox[] = [];
  const markers: number[] = []; // 每块圆心 y

  map.blocks.forEach((b) => {
    const st = blockStyle(b.state, accent, good, ink, mute, faint);
    const contrib = b.contribution ? wrap(`为作品贡献 · ${b.contribution}`, 40, 2) : [];
    const rows = chipRows(b.lectures, cardW - CARD_PAD * 2);
    const bh = 12 + 24 + (contrib.length ? 6 + contrib.length * 17 : 0) + (rows ? 10 + rows * (CHIP_H + CHIP_GAP) - CHIP_GAP : 0) + 12;

    const cardY = y;
    els.push(rect(ox + CARD_X, cardY, cardW, bh, { stroke: st.cardStroke, fill: st.cardFill, width: b.state === "today" ? 1.9 : 1.4, dash: st.cardDash }));

    // 主干线 + 节点圆徽
    const cy = cardY + 25;
    markers.push(cy);
    els.push(ellipse(spineX - MARKER_R, cy - MARKER_R, MARKER_R * 2, MARKER_R * 2, { stroke: st.markerStroke, fill: st.markerFill, width: st.markerText ? 0 : 1.6 }));
    if (st.markerText) els.push(txt(spineX - (st.markerText.length * 8) / 2, cy - 9, st.markerText, 16, st.markerTextColor));

    // 块标题 + 状态徽章
    els.push(txt(ox + CARD_X + CARD_PAD, cardY + 10, b.title.slice(0, 24), 17, st.titleColor));
    const tag = b.state === "today" ? "今日主攻" : b.state === "done" ? "已啃下" : b.state === "doing" ? "进行中" : "";
    if (tag) els.push(txt(ox + CARD_X + cardW - CARD_PAD - tag.length * 13, cardY + 13, tag, 12.5, b.state === "done" ? good : accent));

    let cyy = cardY + 34;
    contrib.forEach((ln) => {
      els.push(txt(ox + CARD_X + CARD_PAD, cyy, ln, 12.5, mute));
      cyy += 17;
    });

    if (rows) {
      cyy += 10;
      let cx = ox + CARD_X + CARD_PAD;
      for (const l of b.lectures) {
        const shown = chipText(l.title);
        const cw = Math.min(chipWidth(shown), cardW - CARD_PAD * 2);
        if (cx > ox + CARD_X + CARD_PAD && cx + cw > ox + CARD_X + cardW - CARD_PAD) {
          cx = ox + CARD_X + CARD_PAD;
          cyy += CHIP_H + CHIP_GAP;
        }
        els.push(rect(cx, cyy, cw, CHIP_H, { stroke: l.done ? `${good}66` : st.chipStroke, fill: l.done ? `${good}1f` : st.chipFill }));
        els.push(txt(cx + 9, cyy + 6, `${l.done ? "✓ " : ""}${shown}`, 12.5, l.done ? good : st.chipText));
        cx += cw + CHIP_GAP;
      }
    }

    blockBoxes.push({ x: ox + CARD_X, y: cardY, w: cardW, h: bh });
    y = cardY + bh + 12;
  });

  // 主干线：从第一块圆心连到最后一块圆心
  if (markers.length > 1) {
    els.push(line(spineX, markers[0], spineX, markers[markers.length - 1], { stroke: faint, width: 1 }));
  }

  // ---- 终点：做成标准（结课那天逐条验收） ----
  if (map.criteria && map.criteria.length > 0) {
    y += 8;
    els.push(rect(spineX - MARKER_R + 4, y + 3, 8, 8, { fill: good }));
    els.push(txt(ox, y, "终点验收 · 做成标准", 16, ink));
    y += 26;
    map.criteria.forEach((c) => {
      const lines = wrap(c, 40, 2);
      els.push(rect(ox + 4, y + 2, 12, 12, { stroke: good, width: 1.4 }));
      lines.forEach((ln, i) => els.push(txt(ox + 26, y + i * 17, ln, 12.5, mute)));
      y += lines.length * 17 + 7;
    });
  }

  return { elements: els, width: W, height: y - oy + 8, blockBoxes };
}
