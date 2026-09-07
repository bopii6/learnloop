// BoardWriter：白板增量书写器 —— 播放器的"手"。
// 布局逻辑（真实黑板）：
//   一块"黑板"= 固定视口区域，划分为 2×2 四个象限；
//   模块（section）按 左上 → 右上 → 左下 → 右下 依次写入象限；
//   四个象限写满 → 翻到下一块黑板（镜头随新黑板移动，黑板内不移动）。
//   这样内容永远在可视黑板内，不会被字幕遮挡，也不会"从中间冒出来"。
import type { BoardItem } from "@/types";

const PALETTE = ["#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626"];
const START_X = 40;
const START_Y = 30;
// 黑板尺寸：严格按可视区计算（1440 视口 - 对话栏 320 - 边距；高度避开顶栏和底部字幕区）
const BOARD_W = 1020;
const BOARD_H = 500;
const QUAD_W = 480; // 象限宽（BOARD_W/2 - 间隙）
const QUAD_H = 225; // 象限高（BOARD_H/2 - 间隙）
const BOARD_GAP = 80; // 两块黑板之间的间距
const ITEM_DELAY_MS = 320; // 每条板书出现间隔，模拟手写节奏
const ANCHOR_ID = "camera-anchor";

export interface BoardWriter {
  /** 新片段：在当前象限写一个片段标题胶囊（不推进象限） */
  beginSegment(title: string): Promise<void>;
  /** 写一条 beat 的板书（section 变化时推进到下一象限），逐条出现 */
  write(section: string | undefined, items: BoardItem[]): Promise<void>;
  /** 已写下的分区名（注入学员提问上下文） */
  outline(): string[];
  /** 移除铅笔指示（片段讲完时调用） */
  removePencil(): void;
  /** 序列化布局游标（课堂状态恢复用） */
  snapshot(): Record<string, unknown>;
  /** 恢复布局游标 */
  restore(state: Record<string, any>): void;
}

export function createBoardWriter(getApi: () => any): BoardWriter {
  let convert: ((skeleton: any[]) => any[]) | null = null;
  // 黑板/象限游标
  let boardOrigin = { x: START_X, y: START_Y };
  let quadIndex = 0; // 0=左上 1=右上 2=左下 3=右下
  let qx = START_X; // 当前象限左上角（画布坐标）
  let qy = START_Y;
  let writeY = START_Y; // 象限内的书写游标
  let currentSection: string | null = null;
  let quadUsed = false; // 当前象限是否已写入内容
  let pendingTitle: string | null = null; // 待绘制的片段标题（随片段第一个模块落位）
  let colorIndex = 0;
  const sections: string[] = [];
  let lastItemBox: { x: number; y: number; w: number; h: number } | null = null;
  let firstBoardFocused = false;

  const delay = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  async function ensureConvert() {
    if (!convert) {
      const mod = await import("@excalidraw/excalidraw");
      convert = mod.convertToExcalidrawElements;
    }
  }

  async function waitForApi(): Promise<any> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const api = getApi();
      if (api) return api;
      if (Date.now() > deadline) return null;
      await delay(200);
    }
  }

  async function append(skeleton: any[], tempId?: string, follow = false): Promise<any[]> {
    const api = await waitForApi();
    if (!api || skeleton.length === 0) return [];
    await ensureConvert();
    const keep = api.getSceneElements().filter((el: any) => !el.isDeleted && el.id !== ANCHOR_ID);
    const els = convert!(skeleton);
    if (tempId) els.forEach((el: any) => (el.id = tempId));
    // 原版动效：文字元素走"逐字打字机"，非文字元素走"偏移浮现"
    const textEls = els.filter((el: any) => el.type === "text");
    const otherEls = els.filter((el: any) => el.type !== "text");
    api.updateScene({
      elements: [
        ...keep,
        ...otherEls.map((el: any) => ({ ...el, x: el.x + 6, opacity: 35 })),
        ...textEls.map((el: any) => ({ ...el, text: "", originalText: "" })),
      ],
    });
    // 非文字元素快速落位
    window.setTimeout(() => {
      try {
        const cur = api.getSceneElements().filter((el: any) => !el.isDeleted && el.id !== ANCHOR_ID);
        const byId = new Map(otherEls.map((el: any) => [el.id, el]));
        api.updateScene({ elements: cur.map((el: any) => byId.get(el.id) || el) });
      } catch {
        // 场景重置时忽略
      }
    }, 80);
    // 打字机：文字逐字生长（与铅笔书写位同步），Layout 已按全文预留
    (async () => {
      for (const te of textEls) {
        const full: string = te.text || "";
        if (!full) continue;
        const steps = Math.max(2, Math.min(6, Math.ceil(full.length / 5)));
        for (let s = 1; s <= steps; s++) {
          await delay(70);
          try {
            const partial = full.slice(0, Math.round((full.length * s) / steps));
            const cur = api.getSceneElements().filter((el: any) => !el.isDeleted && el.id !== ANCHOR_ID);
            api.updateScene({
              elements: cur.map((el: any) =>
                el.id === te.id ? { ...el, text: partial, originalText: partial } : el
              ),
            });
          } catch {
            // 忽略
          }
        }
      }
    })();
    return els;
  }

  function removePencil() {
    const api = getApi();
    if (!api) return;
    try {
      const els = api.getSceneElements().filter((el: any) => el.id !== ANCHOR_ID && el.id !== "pencil-cursor");
      api.updateScene({ elements: els });
    } catch {
      // 场景未就绪时忽略
    }
  }

  /**
   * 镜头：把一整块黑板放进视口（仅开课与翻黑板时调用）。
   * 注意：scrollToContent 必须在场景提交后再调用（紧贴 updateScene 调用会静默失效），故延迟一拍。
   */
  async function focusBoard(x: number, y: number) {
    const api = await waitForApi();
    if (!api) return;
    await ensureConvert();
    const existing = api.getSceneElements().filter((el: any) => !el.isDeleted && el.id !== ANCHOR_ID);
    const els = convert!([
      {
        type: "rectangle",
        id: ANCHOR_ID,
        x: x - 20,
        y: y - 110,
        width: BOARD_W + 40,
        height: BOARD_H + 200,
        backgroundColor: "transparent",
        strokeColor: "transparent",
        strokeWidth: 0,
        opacity: 0,
      },
    ]);
    els.forEach((el: any) => (el.id = ANCHOR_ID));
    api.updateScene({ elements: [...existing, ...els[0]] });
    window.setTimeout(() => {
      try {
        api.scrollToContent([els[0]], { fitToContent: true, animate: true, duration: 500 });
      } catch {
        // 忽略
      }
    }, 120);
  }

  /** 象限左上角坐标 */
  function quadPos(index: number, origin = boardOrigin) {
    return {
      x: origin.x + (index % 2) * (QUAD_W + 60),
      y: origin.y + Math.floor(index / 2) * (QUAD_H + 30),
    };
  }

  /** 在当前象限画分区标题胶囊 */
  async function drawSectionHeader(name: string, reuseColor = false) {
    const color = reuseColor ? PALETTE[(colorIndex - 1) % PALETTE.length] : PALETTE[colorIndex % PALETTE.length];
    if (!reuseColor) colorIndex += 1;
    await append([
      {
        type: "rectangle",
        x: qx,
        y: writeY,
        width: 150,
        height: 32,
        backgroundColor: color + "18",
        strokeColor: color,
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
      {
        type: "text",
        x: qx + 12,
        y: writeY + 5,
        text: name.slice(0, 10),
        fontSize: 15,
        fontFamily: 2,
        strokeColor: color,
      },
    ]);
    writeY += 46;
  }

  /** 在当前象限顶部画片段标题胶囊 */
  async function drawSegmentChip(title: string) {
    const chipWidth = Math.min(300, Math.max(90, title.length * 17 + 28));
    await append([
      {
        type: "rectangle",
        x: qx,
        y: writeY,
        width: chipWidth,
        height: 34,
        backgroundColor: "#1e1e1e10",
        strokeColor: "#b4b2a9",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
      {
        type: "text",
        x: qx + 14,
        y: writeY + 6,
        text: title.slice(0, 16),
        fontSize: 16,
        fontFamily: 2,
        strokeColor: "#5f5e5a",
      },
    ]);
    writeY += 52;
  }

  /** 推进到下一象限；本块黑板写满则翻新黑板（镜头平滑滑向新黑板） */
  async function nextQuad(repeatSection = false) {
    quadIndex += 1;
    if (quadIndex > 3) {
      boardOrigin = { x: START_X, y: boardOrigin.y + BOARD_H + BOARD_GAP };
      quadIndex = 0;
      // 整块黑板写满 → 翻页：镜头平滑滑到新黑板
      await focusBoard(boardOrigin.x, boardOrigin.y);
    }
    // 同一块黑板内的象限切换不动镜头（四象限都在可视黑板内）
    const pos = quadPos(quadIndex);
    qx = pos.x;
    qy = pos.y;
    writeY = qy;
    quadUsed = false;
    // 分区还没讲完就换象限了（内容溢出）→ 在新象限把分区标题补上，保持上下文连续
    if (repeatSection && currentSection) {
      await drawSectionHeader(currentSection, true);
    } else {
      currentSection = null; // 新象限重置分区状态
    }
  }

  return {
    async beginSegment(title: string) {
      // 开课首次对焦：把第一块黑板放进视口左上象限（否则 Excalidraw 默认把原点放屏幕中央）
      if (!firstBoardFocused) {
        firstBoardFocused = true;
        await focusBoard(boardOrigin.x, boardOrigin.y);
      }
      // 片段标题暂存：等本片段第一个模块写入时一起画（避免胶囊和内容分离）
      pendingTitle = title;
    },

    async write(section, items) {
      const list = (items || []).filter((it) => it && it.kind).slice(0, 3);
      const newSection = (section || "").trim() || (currentSection === null && list.length > 0 ? "板书" : null);

      // 分区变化 → 推进象限写新模块（当前象限已占用才推进；新片段标题胶囊随行）
      if (newSection && newSection !== currentSection) {
        if (quadUsed) {
          await nextQuad();
        }
        currentSection = newSection;
        sections.push(newSection);
        if (pendingTitle) {
          await drawSegmentChip(pendingTitle);
          pendingTitle = null;
        }
        await drawSectionHeader(newSection);
        quadUsed = true;
      }

      // 逐条写内容，边讲边写；象限写不下就换下一象限（分区标题跟着补上）
      for (const item of list) {
        if (writeY > qy + QUAD_H - 40) {
          await nextQuad(true);
        }
        quadUsed = true;
        const isLast = list.indexOf(item) === list.length - 1;
        const skeleton: any[] = [];
        let advance = 34;
        let box: { x: number; y: number; w: number; h: number } | null = null;
        const itemX = qx + 4;
        const maxW = Math.min(QUAD_W - 24, 460);

        if (item.kind === "circle") {
          if (lastItemBox) {
            skeleton.push({
              type: "ellipse",
              x: lastItemBox.x - 14,
              y: lastItemBox.y - 8,
              width: Math.min(lastItemBox.w + 28, maxW + 20),
              height: lastItemBox.h + 14,
              backgroundColor: "#dc262610",
              strokeColor: "#dc2626",
              strokeWidth: 1.5,
              roughness: 1,
            });
          }
        } else if (item.kind === "diagram" && item.nodes && item.nodes.length >= 2) {
          const nodes = item.nodes.slice(0, 4).map((n) => (n || "").slice(0, 5));
          const n = nodes.length;
          const gap = 22;
          const boxW = Math.floor((maxW - (n - 1) * gap) / n);
          const boxH = 42;
          for (let ni = 0; ni < n; ni++) {
            const nx = itemX + ni * (boxW + gap);
            skeleton.push({
              type: "rectangle",
              x: nx,
              y: writeY,
              width: boxW,
              height: boxH,
              backgroundColor: "#2563eb10",
              strokeColor: "#2563eb",
              strokeWidth: 1.2,
              roughness: 0,
              roundness: { type: 3 },
            });
            skeleton.push({
              type: "text",
              x: nx + Math.max(3, Math.floor((boxW - nodes[ni].length * 12) / 2)),
              y: writeY + 13,
              text: nodes[ni],
              fontSize: 12,
              fontFamily: 2,
              strokeColor: "#1e1e1e",
            });
            if (ni < n - 1) {
              skeleton.push({
                type: "arrow",
                x: nx + boxW + 3,
                y: writeY + boxH / 2,
                points: [[0, 0], [gap - 6, 0]],
                strokeColor: "#5f5e5a",
                strokeWidth: 1.5,
              });
            }
          }
          advance = boxH + 12;
          box = { x: itemX, y: writeY, w: maxW, h: boxH };
        } else if (item.kind === "subtitle") {
          skeleton.push({
            type: "text",
            x: itemX,
            y: writeY,
            text: (item.text || "").slice(0, 24),
            fontSize: 18,
            fontFamily: 2,
            strokeColor: "#1e1e1e",
          });
          advance = 38;
          box = { x: itemX, y: writeY, w: Math.min((item.text || "").length * 18 + 8, maxW), h: 30 };
        } else if (item.kind === "bullet") {
          skeleton.push({
            type: "text",
            x: itemX + 6,
            y: writeY,
            text: `· ${(item.text || "").slice(0, 36)}`,
            fontSize: 15,
            fontFamily: 1,
            strokeColor: "#1e1e1e",
          });
          advance = 33;
          box = { x: itemX, y: writeY, w: Math.min(((item.text || "").length + 2) * 15 + 10, maxW), h: 28 };
        } else if (item.kind === "note") {
          skeleton.push({
            type: "text",
            x: itemX + 6,
            y: writeY,
            text: (item.text || "").slice(0, 30),
            fontSize: 13,
            fontFamily: 1,
            strokeColor: "#846358",
          });
          advance = 27;
          box = { x: itemX, y: writeY, w: Math.min((item.text || "").length * 13 + 10, maxW), h: 24 };
        } else if (item.kind === "table" && item.headers && item.rows) {
          const cols = Math.max(2, Math.min(3, item.headers.length));
          const cellW = Math.floor((maxW - 8) / cols);
          const cellH = 30;
          for (let ci = 0; ci < cols; ci++) {
            skeleton.push({
              type: "rectangle",
              x: itemX + ci * cellW,
              y: writeY,
              width: cellW,
              height: cellH,
              backgroundColor: PALETTE[colorIndex % PALETTE.length] + "12",
              strokeColor: "#d3d1c7",
              strokeWidth: 1,
              roughness: 0,
            });
            skeleton.push({
              type: "text",
              x: itemX + ci * cellW + 5,
              y: writeY + 6,
              text: (item.headers[ci] || "").slice(0, 12),
              fontSize: 12,
              fontFamily: 2,
              strokeColor: "#1e1e1e",
            });
          }
          let tableY = writeY + cellH;
          for (const row of item.rows.slice(0, 4)) {
            for (let ci = 0; ci < cols; ci++) {
              skeleton.push({
                type: "rectangle",
                x: itemX + ci * cellW,
                y: tableY,
                width: cellW,
                height: cellH,
                backgroundColor: "transparent",
                strokeColor: "#e7e5dc",
                strokeWidth: 1,
                roughness: 0,
              });
              skeleton.push({
                type: "text",
                x: itemX + ci * cellW + 5,
                y: tableY + 6,
                text: (row[ci] || "").slice(0, 12),
                fontSize: 11,
                fontFamily: 1,
                strokeColor: "#1e1e1e",
              });
            }
            tableY += cellH;
          }
          advance = cellH * (item.rows.slice(0, 4).length + 1) + 10;
          box = { x: itemX, y: writeY, w: maxW, h: advance - 10 };
        }

        if (skeleton.length > 0) {
          await append(skeleton);
          if (box) lastItemBox = box;
          else if (item.kind === "circle") {
            // 圈重点不推进游标
          } else {
            lastItemBox = null;
          }
          writeY += advance;
          await delay(ITEM_DELAY_MS);
        }
      }
    },

    outline() {
      return [...sections];
    },

    removePencil,

    snapshot() {
      return {
        boardOrigin,
        quadIndex,
        qx,
        qy,
        writeY,
        currentSection,
        colorIndex,
        sections: [...sections],
        lastItemBox,
        firstBoardFocused,
        pendingTitle,
      };
    },

    restore(s: Record<string, any>) {
      if (!s) return;
      boardOrigin = s.boardOrigin || { x: START_X, y: START_Y };
      quadIndex = s.quadIndex ?? 0;
      qx = s.qx ?? START_X;
      qy = s.qy ?? START_Y;
      writeY = s.writeY ?? START_Y;
      currentSection = s.currentSection ?? null;
      colorIndex = s.colorIndex ?? 0;
      sections.length = 0;
      if (Array.isArray(s.sections)) sections.push(...s.sections);
      lastItemBox = s.lastItemBox || null;
      firstBoardFocused = s.firstBoardFocused ?? false;
      pendingTitle = s.pendingTitle ?? null;
      quadUsed = s.quadUsed ?? true;
    },
  };
}
