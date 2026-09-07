// BoardWriter：白板增量书写器 —— 播放器的"手"。
// 布局逻辑（真实黑板 + 导演式镜头）：
//   一块"黑板"= 固定区域，划分为 2×2 四个分区（quad）；
//   模块（section）按 左上 → 右上 → 左下 → 右下 依次写入分区；
//   四个分区写满 → 翻到下一块黑板。
//   镜头（camera）以"分区"为单位跟随：每切入新分区，镜头平滑推近该分区——
//   板书始终铺满画面，字号在屏上被放大，这是"面向观看的画面密度"的来源。
//   turbo 模式（回放重建用）：跳过动画与延时，瞬间把板书写到位。
import type { BoardItem } from "@/types";

const PALETTE = ["#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626"];
const START_X = 40;
const START_Y = 30;
// 黑板尺寸：严格按可视区计算（1440 视口 - 对话栏 320 - 边距；高度避开顶栏和底部字幕区）
const BOARD_W = 1020;
const BOARD_H = 500;
const QUAD_W = 480; // 分区宽（BOARD_W/2 - 间隙）
const QUAD_H = 225; // 分区高（BOARD_H/2 - 间隙）
const BOARD_GAP = 80; // 两块黑板之间的间距
const ITEM_DELAY_MS = 320; // 每条板书出现间隔，模拟手写节奏
const ANCHOR_ID = "camera-anchor";
// 镜头取景：给分区四周留出呼吸位（画布坐标的扩边量）
const CAM_PAD_X = 26;
const CAM_PAD_TOP = 88; // 分区上方留出片段胶囊/分区标题的空间
const CAM_PAD_BOTTOM = 34;
const CAM_ZOOM_FACTOR = 0.94; // fitToContent 后再缩一点，避免内容顶边

export interface BoardWriter {
  /** 新片段：在当前分区写一个片段标题胶囊（不推进分区） */
  beginSegment(title: string): Promise<void>;
  /** 写一条 beat 的板书（section 变化时推进到下一分区），逐条出现 */
  write(section: string | undefined, items: BoardItem[]): Promise<void>;
  /** 已写下的分区名（注入学员提问上下文） */
  outline(): string[];
  /** 移除铅笔指示（片段讲完时调用） */
  removePencil(): void;
  /** 镜头对准当前黑板（断线恢复还原画面后调用） */
  focusCurrent(): void;
  /** turbo 模式：跳过手写动画与延时（回放重建瞬间到位） */
  setTurbo(on: boolean): void;
  /** 序列化布局游标（课堂状态恢复用） */
  snapshot(): Record<string, unknown>;
  /** 恢复布局游标 */
  restore(state: Record<string, any>): void;
}

export function createBoardWriter(getApi: () => any): BoardWriter {
  let convert: ((skeleton: any[]) => any[]) | null = null;
  // 黑板/分区游标
  let boardOrigin = { x: START_X, y: START_Y };
  let quadIndex = 0; // 0=左上 1=右上 2=左下 3=右下
  let qx = START_X; // 当前分区左上角（画布坐标）
  let qy = START_Y;
  let writeY = START_Y; // 分区内的书写游标
  let currentSection: string | null = null;
  let quadUsed = false; // 当前分区是否已写入内容
  let pendingTitle: string | null = null; // 待绘制的片段标题（随片段第一个模块落位）
  let colorIndex = 0;
  const sections: string[] = [];
  let lastItemBox: { x: number; y: number; w: number; h: number } | null = null;
  let firstBoardFocused = false;
  let turbo = false;

  const delay = (ms: number) =>
    turbo ? Promise.resolve() : new Promise<void>((r) => window.setTimeout(r, ms));

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

  async function append(skeleton: any[]): Promise<any[]> {
    const api = await waitForApi();
    if (!api || skeleton.length === 0) return [];
    await ensureConvert();
    const keep = api.getSceneElements().filter((el: any) => !el.isDeleted);
    const els = convert!(skeleton);
    if (turbo) {
      // 回放重建：一步到位，不做打字机与浮入
      api.updateScene({ elements: [...keep, ...els] });
      return els;
    }
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
        const cur = api.getSceneElements().filter((el: any) => !el.isDeleted);
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
            const cur = api.getSceneElements().filter((el: any) => !el.isDeleted);
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
   * 导演镜头：把画布上的一个矩形区域推进视口中央（仅模块切换/恢复时调用）。
   * 做法：放一个透明锚点矩形 → 延迟一拍 scrollToContent（紧贴 updateScene 会静默失效）。
   * 锚点留在场景里（透明、不碍事），下一次取景会把它挪到新位置。
   */
  async function focusRegion(
    x: number,
    y: number,
    w: number,
    h: number,
    zoomFactor = CAM_ZOOM_FACTOR
  ) {
    const api = await waitForApi();
    if (!api) return;
    await ensureConvert();
    const existing = api.getSceneElements().filter((el: any) => !el.isDeleted && el.id !== ANCHOR_ID);
    const els = convert!([
      {
        type: "rectangle",
        id: ANCHOR_ID,
        x,
        y,
        width: w,
        height: h,
        backgroundColor: "transparent",
        strokeColor: "transparent",
        strokeWidth: 0,
        opacity: 0,
      },
    ]);
    els.forEach((el: any) => (el.id = ANCHOR_ID));
    const anchor = els[0];
    api.updateScene({ elements: [...existing, anchor] });
    if (turbo) {
      try {
        api.scrollToContent([anchor], { fitToContent: true, animate: false, viewportZoomFactor: zoomFactor });
      } catch {
        // 忽略
      }
      return;
    }
    window.setTimeout(() => {
      try {
        api.scrollToContent([anchor], { fitToContent: true, animate: true, duration: 620, viewportZoomFactor: zoomFactor });
      } catch {
        // 忽略
      }
    }, 110);
  }

  /** 当前分区的取景框（含上方标题空间） */
  function quadCamBox(x = qx, y = qy) {
    return {
      x: x - CAM_PAD_X,
      y: y - CAM_PAD_TOP,
      w: QUAD_W + CAM_PAD_X * 2,
      h: QUAD_H + CAM_PAD_TOP + CAM_PAD_BOTTOM,
    };
  }

  /** 象限左上角坐标 */
  function quadPos(index: number, origin = boardOrigin) {
    return {
      x: origin.x + (index % 2) * (QUAD_W + 60),
      y: origin.y + Math.floor(index / 2) * (QUAD_H + 30),
    };
  }

  /** 在当前分区画分区标题胶囊 */
  async function drawSectionHeader(name: string, reuseColor = false) {
    const color = reuseColor ? PALETTE[(colorIndex - 1) % PALETTE.length] : PALETTE[colorIndex % PALETTE.length];
    if (!reuseColor) colorIndex += 1;
    await append([
      {
        type: "rectangle",
        x: qx,
        y: writeY,
        width: 164,
        height: 34,
        backgroundColor: color + "18",
        strokeColor: color,
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
      {
        type: "text",
        x: qx + 12,
        y: writeY + 6,
        text: name.slice(0, 10),
        fontSize: 17,
        fontFamily: 2,
        strokeColor: color,
      },
    ]);
    writeY += 50;
  }

  /** 在当前分区顶部画片段标题胶囊 */
  async function drawSegmentChip(title: string) {
    const chipWidth = Math.min(320, Math.max(96, title.length * 18 + 30));
    await append([
      {
        type: "rectangle",
        x: qx,
        y: writeY,
        width: chipWidth,
        height: 36,
        backgroundColor: "#1e1e1e10",
        strokeColor: "#b4b2a9",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
      {
        type: "text",
        x: qx + 14,
        y: writeY + 7,
        text: title.slice(0, 16),
        fontSize: 17,
        fontFamily: 2,
        strokeColor: "#5f5e5a",
      },
    ]);
    writeY += 54;
  }

  /** 推进到下一分区；本块黑板写满则翻新黑板。镜头随分区切换平滑推近。 */
  async function nextQuad(repeatSection = false) {
    quadIndex += 1;
    if (quadIndex > 3) {
      boardOrigin = { x: START_X, y: boardOrigin.y + BOARD_H + BOARD_GAP };
      quadIndex = 0;
    }
    const pos = quadPos(quadIndex);
    qx = pos.x;
    qy = pos.y;
    writeY = qy;
    quadUsed = false;
    // 镜头先行：推近新分区，板书随后写进画面
    const cam = quadCamBox();
    await focusRegion(cam.x, cam.y, cam.w, cam.h);
    // 分区还没讲完就换分区了（内容溢出）→ 在新分区把分区标题补上，保持上下文连续
    if (repeatSection && currentSection) {
      await drawSectionHeader(currentSection, true);
    } else {
      currentSection = null; // 新分区重置分区状态
    }
  }

  /** 在上一条板书上做强调（圈重点 / 划重点线 / 爆星强调） */
  function emphasizeSkeleton(kind: "circle" | "underline" | "burst"): any[] {
    if (!lastItemBox) return [];
    const b = lastItemBox;
    if (kind === "circle") {
      return [
        {
          type: "ellipse",
          x: b.x - 14,
          y: b.y - 8,
          width: Math.min(b.w + 28, 480 + 20),
          height: b.h + 14,
          backgroundColor: "#dc262610",
          strokeColor: "#dc2626",
          strokeWidth: 1.5,
          roughness: 1,
        },
      ];
    }
    if (kind === "underline") {
      return [
        {
          type: "line",
          x: b.x + 2,
          y: b.y + b.h + 5,
          points: [[0, 0], [Math.min(b.w - 4, 470), 0]],
          strokeColor: "#d97706",
          strokeWidth: 2,
          roughness: 1,
        },
      ];
    }
    // burst：内容上方放射短线（强调"这个点很关键"）
    const cx = b.x + Math.min(b.w / 2, 240);
    const cy = b.y - 12;
    const rays: any[] = [];
    const angles = [-150, -110, -70, -30, 10, 50];
    for (const deg of angles) {
      const rad = (deg * Math.PI) / 180;
      const r1 = 18;
      const r2 = 34;
      rays.push({
        type: "line",
        x: cx + Math.cos(rad) * r1,
        y: cy + Math.sin(rad) * r1,
        points: [[0, 0], [Math.cos(rad) * (r2 - r1), Math.sin(rad) * (r2 - r1)]],
        strokeColor: "#dc2626",
        strokeWidth: 1.5,
        roughness: 1,
      });
    }
    return rays;
  }

  return {
    async beginSegment(title: string) {
      // 开课首次对焦：镜头推近第一块黑板的第一分区（否则 Excalidraw 默认把原点放屏幕中央）
      if (!firstBoardFocused) {
        firstBoardFocused = true;
        const cam = quadCamBox(quadPos(0).x, quadPos(0).y);
        await focusRegion(cam.x, cam.y, cam.w, cam.h);
      }
      // 片段标题暂存：等本片段第一个模块写入时一起画（避免胶囊和内容分离）
      pendingTitle = title;
    },

    async write(section, items) {
      const list = (items || []).filter((it) => it && it.kind).slice(0, 3);
      const newSection = (section || "").trim() || (currentSection === null && list.length > 0 ? "板书" : null);

      // 分区变化 → 推进分区写新模块（当前分区已占用才推进；新片段标题胶囊随行）
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

      // 逐条写内容，边讲边写；分区写不下就换下一分区（分区标题跟着补上）
      for (const item of list) {
        if (writeY > qy + QUAD_H - 44) {
          await nextQuad(true);
        }
        quadUsed = true;
        const skeleton: any[] = [];
        let advance = 34;
        let box: { x: number; y: number; w: number; h: number } | null = null;
        const itemX = qx + 4;
        const maxW = Math.min(QUAD_W - 24, 460);

        if (item.kind === "circle" || item.kind === "underline" || item.kind === "burst") {
          skeleton.push(...emphasizeSkeleton(item.kind));
          advance = 18; // 强调动作基本不占行高
        } else if (item.kind === "diagram" && item.nodes && item.nodes.length >= 2) {
          const nodes = item.nodes.slice(0, 4).map((n) => (n || "").slice(0, 5));
          const n = nodes.length;
          const gap = 22;
          const boxW = Math.floor((maxW - (n - 1) * gap) / n);
          const boxH = 46;
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
              x: nx + Math.max(3, Math.floor((boxW - nodes[ni].length * 13) / 2)),
              y: writeY + 15,
              text: nodes[ni],
              fontSize: 13,
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
          advance = boxH + 14;
          box = { x: itemX, y: writeY, w: maxW, h: boxH };
        } else if (item.kind === "subtitle") {
          skeleton.push({
            type: "text",
            x: itemX,
            y: writeY,
            text: (item.text || "").slice(0, 24),
            fontSize: 20,
            fontFamily: 2,
            strokeColor: "#1e1e1e",
          });
          advance = 44;
          box = { x: itemX, y: writeY, w: Math.min((item.text || "").length * 20 + 8, maxW), h: 32 };
        } else if (item.kind === "bullet") {
          skeleton.push({
            type: "text",
            x: itemX + 6,
            y: writeY,
            text: `· ${(item.text || "").slice(0, 36)}`,
            fontSize: 16,
            fontFamily: 1,
            strokeColor: "#1e1e1e",
          });
          advance = 36;
          box = { x: itemX, y: writeY, w: Math.min(((item.text || "").length + 2) * 16 + 10, maxW), h: 30 };
        } else if (item.kind === "note") {
          skeleton.push({
            type: "text",
            x: itemX + 6,
            y: writeY,
            text: (item.text || "").slice(0, 30),
            fontSize: 14,
            fontFamily: 1,
            strokeColor: "#846358",
          });
          advance = 30;
          box = { x: itemX, y: writeY, w: Math.min((item.text || "").length * 14 + 10, maxW), h: 26 };
        } else if (item.kind === "table" && item.headers && item.rows) {
          const cols = Math.max(2, Math.min(3, item.headers.length));
          const cellW = Math.floor((maxW - 8) / cols);
          const cellH = 34;
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
              x: itemX + ci * cellW + 6,
              y: writeY + 8,
              text: (item.headers[ci] || "").slice(0, 12),
              fontSize: 13,
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
                x: itemX + ci * cellW + 6,
                y: tableY + 8,
                text: (row[ci] || "").slice(0, 12),
                fontSize: 12,
                fontFamily: 1,
                strokeColor: "#1e1e1e",
              });
            }
            tableY += cellH;
          }
          advance = cellH * (item.rows.slice(0, 4).length + 1) + 12;
          box = { x: itemX, y: writeY, w: maxW, h: advance - 12 };
        }

        if (skeleton.length > 0) {
          await append(skeleton);
          if (box) lastItemBox = box;
          else if (item.kind === "circle" || item.kind === "underline" || item.kind === "burst") {
            // 强调动作不推进板书游标
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

    focusCurrent() {
      const cam = {
        x: boardOrigin.x - CAM_PAD_X,
        y: boardOrigin.y - CAM_PAD_TOP,
        w: BOARD_W + CAM_PAD_X * 2,
        h: BOARD_H + CAM_PAD_TOP + CAM_PAD_BOTTOM,
      };
      void focusRegion(cam.x, cam.y, cam.w, cam.h, 0.9);
    },

    setTurbo(on: boolean) {
      turbo = on;
    },

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
