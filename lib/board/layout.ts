// 白板版面引擎：页 → 列 → 卡片的流式排版（对标 Hyperknow 实测参数）。
// 关键常数来自实机测量：
//   1440 视口 → usableW 1380 / tileW 452 / 列宽 441 / 列起点 54,513,972 / gridTop 130
//   1280 视口 → usableW 1194 / tileW 390 / 列宽 380 / 列起点 54,452
// 推导：usableW = vpW - 60；tileW = floor((usableW - (n-1)*gapX) / n)；列宽 = tileW - 10；
//       列起点 = gridLeft + 24；列步进 = 列宽 + 18；行距 = 2；一页固定 3 列。
import type { BoardItem, BoardLayoutParams, ColumnLayout } from "@/types/board";

export const ROW_GAP = 2; // 卡片纵向间距（实测）
export const COL_STEP_GAP = 18; // 列与列之间的水平间距（实测 x 差值 - 列宽）
export const COL_INNER_DX = 24; // 首列相对 gridLeft 的偏移（实测 54 - 30）

export function computeLayoutParams(vpW: number, vpH: number): BoardLayoutParams {
  const colCount = 3;
  const tileGapX = 12;
  const usableW = Math.max(600, Math.round(vpW - 60));
  const usableH = Math.max(320, Math.round(vpH - 175));
  const tileW = Math.max(200, Math.floor((usableW - (colCount - 1) * tileGapX) / colCount));
  const colW = tileW - 10;
  return {
    colCount,
    tileW,
    tileGapX,
    tileGapY: 12,
    gridLeft: 30,
    gridTop: 130,
    usableW,
    usableH,
    exportPixelW: Math.round(colW * 2 + 22),
  };
}

export function colWidth(lp: BoardLayoutParams): number {
  return lp.tileW - 10;
}

export function colX(lp: BoardLayoutParams, index: number): number {
  return lp.gridLeft + COL_INNER_DX + index * (colWidth(lp) + COL_STEP_GAP);
}

export function createPageLayout(lp: BoardLayoutParams): ColumnLayout {
  return {
    lp,
    columns: [{ x: colX(lp, 0), w: colWidth(lp), nextY: lp.gridTop }],
    activeIndex: 0,
  };
}

/** 新列：在末尾追加一列并把 activeIndex 指向它（对标 new_column 语义） */
export function addColumn(layout: ColumnLayout): ColumnLayout {
  const last = layout.columns[layout.columns.length - 1];
  const next: ColumnLayout = {
    ...layout,
    columns: [
      ...layout.columns,
      {
        x: last ? last.x + last.w + COL_STEP_GAP : colX(layout.lp, 0),
        w: colWidth(layout.lp),
        nextY: layout.lp.gridTop,
      },
    ],
    activeIndex: layout.columns.length,
  };
  return next;
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  columnIndex: number;
}

/** 给新卡片计算落点（当前列的 nextY）；高度测出后再 commitHeight */
export function placeItem(layout: ColumnLayout, width?: number): Placement {
  const idx = layout.activeIndex;
  const col = layout.columns[idx] ?? layout.columns[0];
  const w = width ?? col.w;
  return { x: col.x, y: col.nextY, w, columnIndex: idx };
}

/** 卡片高度确定后推进列的 nextY */
export function commitHeight(layout: ColumnLayout, columnIndex: number, y: number, h: number): void {
  const col = layout.columns[columnIndex];
  if (!col) return;
  col.nextY = Math.max(col.nextY, y + h + ROW_GAP);
}

/** 列内回流：某张卡高度变化时，重排该列后续卡片（对标实测 Ue） */
export function reflowColumn(
  layout: ColumnLayout,
  items: BoardItem[],
  columnIndex: number
): BoardItem[] {
  const col = layout.columns[columnIndex];
  if (!col) return items;
  const inCol = items
    .filter((it) => it.columnIndex === columnIndex)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.id.localeCompare(b.id)));
  if (inCol.length === 0) return items;
  const map = new Map<string, number>();
  // 起点：该列第一张卡的 y（保持原样），其余按高度顺流
  let y = inCol[0].y;
  for (const it of inCol) {
    map.set(it.id, y);
    y += Math.max(40, it.h) + ROW_GAP;
  }
  const last = inCol[inCol.length - 1];
  col.nextY = (map.get(last.id) ?? last.y) + Math.max(40, last.h) + ROW_GAP;
  const changed = inCol.some((it) => map.get(it.id) !== it.y);
  if (!changed) return items;
  return items.map((it) => (map.has(it.id) ? { ...it, y: map.get(it.id)! } : it));
}

let pageSeq = 0;
export function newPageId(): string {
  pageSeq += 1;
  return `page-${Date.now().toString(36)}${pageSeq.toString(36)}`;
}

export function newCardId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
