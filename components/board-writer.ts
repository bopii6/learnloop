// BoardWriter：白板增量书写器 —— 播放器的"手"。
// 布局逻辑（模块板 + 导演式镜头）：
//   一个教学片段 = 一块"模块板"：指数徽章（第几块/共几块）+ 大标题 + 主题色底卡与下划线；
//   板内走双列流式排版——短条目（要点卡/注释/判断行）成对并排铺满一行，
//   结构图元（小节标题/流程图/表格/趋势图/对比栏/分支树/金句）独占整行；
//   片段讲完 → 板间画衔接箭头，镜头右移到下一块模块板。整节课的板书连成一条学习路径。
//   镜头跟随书写进度：模块开始先推近标题区，随内容增多平滑后拉——手写在哪、镜头看哪。
//   turbo 模式（回放重建用）：跳过动画与延时，瞬间把板书写到位。
import type { BoardItem } from "@/types";

const PALETTE = ["#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626"];
const START_X = 60;
const START_Y = 60;
const MODULE_W = 780; // 模块板总宽
const CONTENT_W = 756; // 板内内容宽
const COL_W = 366; // 半行宽（短条目成对并排）
const COL_GAP = 24;
const HEADER_H = 92; // 标题区高（徽章 + 大标题 + 主题色下划线）
const ROW_GAP = 14;
const MODULE_X_GAP = 230; // 两块模块板的间距
const ITEM_DELAY_MS = 280; // 每条板书出现间隔，模拟手写节奏
const WRITE_MAX_ZOOM = 1.45; // 书写镜头最大推近（字别放得过大）
const CAM_PAD = { x: 70, top: 64, bottom: 56 };
const ANCHOR_ID = "camera-anchor";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardWriter {
  /** 新片段：把镜头带到新模块板，画指数徽章 + 大标题（progress 可选，缺失则只显示序号） */
  beginSegment(title: string, progress?: { index: number; total: number }): Promise<void>;
  /** 写一条 beat 的板书（section 是模块内的小节标题，可选），逐条出现 */
  write(section: string | undefined, items: BoardItem[]): Promise<void>;
  /** 已写下的模块名/小节名（注入学员提问上下文） */
  outline(): string[];
  /** 移除铅笔指示（片段讲完时调用） */
  removePencil(): void;
  /** 镜头对准当前模块板（断线恢复还原画面后调用） */
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
  // 模块板游标
  let mx = START_X; // 当前模块板左上角
  let my = START_Y;
  let rowY = my + HEADER_H; // 当前书写行顶部
  let contentBottom = my + HEADER_H; // 已写内容的最低点（镜头取景/底卡撑高用）
  let moduleIndex = 0; // 已开始的模块数（徽章从 1 起）
  let moduleUsed = false; // 当前模块是否写过内容
  let pairPending: Box | null = null; // 半行卡已占左列、等右侧配对
  let currentSection: string | null = null;
  let colorIndex = 0;
  let lastItemBox: Box | null = null;
  let backdropId: string | null = null; // 当前模块底卡元素 id（finalize 时按内容撑高）
  const sections: string[] = [];
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
   * 导演镜头：把画布上的一个矩形区域平滑推进视口中央（仅模块切换/书写推进时调用）。
   * 自己按视口尺寸计算 scroll/zoom 并用 rAF 补间——Excalidraw 的 scrollToContent
   * 在 viewMode + 高频 updateScene 下会静默失效，不能依赖。
   */
  let camAnim = 0;
  async function focusRegion(
    x: number,
    y: number,
    w: number,
    h: number,
    zoomFactor = 0.94,
    maxZoom = 2.2
  ) {
    const api = await waitForApi();
    if (!api) return;
    const st = api.getAppState();
    const vpW = st.width || 1100;
    const vpH = st.height || 620;
    const zoom = Math.max(0.35, Math.min(maxZoom, Math.min(vpW / w, vpH / h) * zoomFactor));
    const scrollX = -(x + w / 2) + vpW / (2 * zoom);
    const scrollY = -(y + h / 2) + vpH / (2 * zoom);

    if (turbo) {
      api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoom } } });
      return;
    }
    const from = { sx: st.scrollX, sy: st.scrollY, z: st.zoom?.value || 1 };
    cancelAnimationFrame(camAnim);
    const t0 = performance.now();
    const dur = 620;
    const ease = (p: number) => 1 - Math.pow(1 - p, 3);
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / dur);
      const e = ease(p);
      try {
        api.updateScene({
          appState: {
            scrollX: from.sx + (scrollX - from.sx) * e,
            scrollY: from.sy + (scrollY - from.sy) * e,
            zoom: { value: from.z + (zoom - from.z) * e },
          },
        });
      } catch {
        // 场景卸载时停止
        return;
      }
      if (p < 1) camAnim = requestAnimationFrame(step);
    };
    camAnim = requestAnimationFrame(step);
  }

  /** 当前书写内容的最低点（含未配对的半行卡） */
  function writingBottom(): number {
    return Math.max(contentBottom, pairPending ? pairPending.y + pairPending.h : 0);
  }

  /** 书写镜头：框住本模块从标题到当前书写行，随内容增多自然后拉 */
  async function focusWriting() {
    const w = MODULE_W + CAM_PAD.x * 2;
    const h = writingBottom() - my + CAM_PAD.top + CAM_PAD.bottom;
    await focusRegion(mx - CAM_PAD.x, my - CAM_PAD.top, w, h, 0.97, WRITE_MAX_ZOOM);
  }

  /** 模块收尾：把底卡撑到实际内容高度（底卡元素在 beginSegment 时以固定 id 画入） */
  function finalizeModule() {
    if (!backdropId) return;
    const api = getApi();
    if (!api) return;
    const h = Math.max(220, writingBottom() - my + 34);
    try {
      const els = api
        .getSceneElements()
        .map((el: any) => (el.id === backdropId ? { ...el, height: h } : el));
      api.updateScene({ elements: els });
    } catch {
      // 场景未就绪时忽略
    }
  }

  /** 板间衔接箭头：整节课的板书串成一条路径 */
  async function drawConnector() {
    await append([
      {
        type: "arrow",
        x: mx + MODULE_W + 46,
        y: my + 140,
        points: [[0, 0], [MODULE_X_GAP - 92, 0]],
        strokeColor: "#b4b2a9",
        strokeWidth: 2,
        roughness: 1,
      },
    ]);
  }

  /** 模块板头部：指数徽章 + 大标题 + 主题色手绘下划线 */
  async function drawModuleHeader(title: string, progress?: { index: number; total: number }) {
    const color = PALETTE[(colorIndex - 1) % PALETTE.length];
    const shown = title.slice(0, 14);
    const badgeText = progress?.total ? `${moduleIndex}/${progress.total}` : `${moduleIndex}`;
    await append([
      {
        type: "rectangle",
        x: mx + 8,
        y: my + 6,
        width: 62,
        height: 30,
        backgroundColor: color + "1f",
        strokeColor: color,
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
      {
        type: "text",
        x: mx + 8 + Math.max(10, (62 - badgeText.length * 9) / 2),
        y: my + 12,
        text: badgeText,
        fontSize: 14,
        fontFamily: 2,
        strokeColor: color,
      },
      {
        type: "text",
        x: mx + 86,
        y: my + 3,
        text: shown,
        fontSize: 25,
        fontFamily: 2,
        strokeColor: "#1e1e1e",
      },
      {
        type: "line",
        x: mx + 12,
        y: my + 56,
        points: [
          [0, 0],
          [Math.min(shown.length * 27 + 34, MODULE_W - 24), 0],
        ],
        strokeColor: color,
        strokeWidth: 4,
        roughness: 1,
      },
    ]);
  }

  /** 在当前行画一个小节标题（模块内换主题时）：色条 + 加粗文字，独占整行 */
  async function drawSectionHeading(name: string) {
    const color = PALETTE[(colorIndex - 1) % PALETTE.length];
    const text = name.slice(0, 12);
    await append([
      {
        type: "rectangle",
        x: mx + 4,
        y: rowY + 5,
        width: 5,
        height: 26,
        backgroundColor: color,
        strokeColor: "transparent",
        strokeWidth: 0,
        roughness: 0,
      },
      {
        type: "text",
        x: mx + 22,
        y: rowY + 6,
        text,
        fontSize: 20,
        fontFamily: 2,
        strokeColor: "#1e1e1e",
      },
    ]);
    lastItemBox = { x: mx, y: rowY, w: CONTENT_W, h: 40 };
    rowY += 40 + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
  }

  /** 结掉未配对的半行卡：把书写游标推过它（独占整行的图元画之前必须调用） */
  function flushPendingPair() {
    if (!pairPending) return;
    rowY = pairPending.y + pairPending.h + ROW_GAP;
    contentBottom = Math.max(contentBottom, pairPending.y + pairPending.h);
    pairPending = null;
  }

  /** 左列占位（等右侧配对）：要点卡/注释/判断行走这里 */
  async function placeShort(render: (ox: number) => { skeleton: any[]; h: number }) {
    if (!pairPending) {
      const { skeleton, h } = render(mx);
      if (skeleton.length === 0) return;
      await append(skeleton);
      const box: Box = { x: mx, y: rowY, w: COL_W, h };
      pairPending = box;
      lastItemBox = box;
    } else {
      const first = pairPending;
      const ox2 = mx + COL_W + COL_GAP;
      const { skeleton, h } = render(ox2);
      if (skeleton.length === 0) return;
      await append(skeleton);
      lastItemBox = { x: ox2, y: rowY, w: COL_W, h };
      rowY += Math.max(first.h, h) + ROW_GAP;
      contentBottom = Math.max(contentBottom, Math.max(first.y + first.h, rowY - ROW_GAP));
      pairPending = null;
      await focusWriting();
    }
  }

  /** 独占整行的图元：先结掉未配对的半行，再画整行并推进书写游标 */
  async function placeFull(render: () => { skeleton: any[]; h: number }) {
    flushPendingPair();
    const { skeleton, h } = render();
    if (skeleton.length === 0) return;
    await append(skeleton);
    lastItemBox = { x: mx, y: rowY, w: CONTENT_W, h };
    rowY += h + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
    await focusWriting();
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
          width: Math.min(b.w + 28, CONTENT_W + 20),
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
          points: [[0, 0], [Math.min(b.w - 4, CONTENT_W - 8), 0]],
          strokeColor: "#d97706",
          strokeWidth: 2,
          roughness: 1,
        },
      ];
    }
    // burst：内容上方放射短线（强调"这个点很关键"）
    const cx = b.x + Math.min(b.w / 2, 300);
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
    async beginSegment(title: string, progress?: { index: number; total: number }) {
      // 上一块模块收尾：底卡撑高 → 板间箭头 → 右移开新板
      if (moduleUsed) {
        finalizeModule();
        await drawConnector();
        mx += MODULE_W + MODULE_X_GAP;
      }
      moduleIndex += 1;
      colorIndex += 1;
      currentSection = null;
      pairPending = null;
      lastItemBox = null;
      rowY = my + HEADER_H;
      contentBottom = my + HEADER_H;
      moduleUsed = true;

      // 模块底卡：先画（z 序在最底），收尾时按内容撑高
      const color = PALETTE[(colorIndex - 1) % PALETTE.length];
      backdropId = `mod-backdrop-${moduleIndex}`;
      await append([
        {
          id: backdropId,
          type: "rectangle",
          x: mx - 18,
          y: my - 24,
          width: MODULE_W + 36,
          height: 220,
          backgroundColor: color + "08",
          strokeColor: color + "30",
          strokeWidth: 1,
          roughness: 0,
          roundness: { type: 3 },
        },
      ]);
      await drawModuleHeader(title, progress);
      // 镜头先行：推近新模块标题区，板书随后写进画面
      await focusWriting();
    },

    async write(section, items) {
      const list = (items || []).filter((it) => it && it.kind).slice(0, 4);
      const newSection = (section || "").trim();

      // 模块内换小主题 → 画小节标题（独占整行）
      if (newSection && newSection !== currentSection && list.length > 0) {
        currentSection = newSection;
        sections.push(newSection);
        flushPendingPair();
        await drawSectionHeading(newSection);
      }

      // 逐条写内容，边讲边写
      for (const item of list) {
        if (item.kind === "circle" || item.kind === "underline" || item.kind === "burst") {
          await append(emphasizeSkeleton(item.kind));
          await delay(ITEM_DELAY_MS * 0.5);
          continue;
        }

        const color = PALETTE[(colorIndex - 1) % PALETTE.length];

        if (item.kind === "bullet" && item.text) {
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 20);
          if (!text) continue;
          await placeShort((ox) => ({
            skeleton: [
              {
                type: "rectangle",
                x: ox,
                y: rowY,
                width: COL_W,
                height: 46,
                backgroundColor: color + "0d",
                strokeColor: color + "55",
                strokeWidth: 1,
                roughness: 0,
                roundness: { type: 3 },
              },
              {
                type: "text",
                x: ox + 18,
                y: rowY + 13,
                text,
                fontSize: 16,
                fontFamily: 1,
                strokeColor: "#1e1e1e",
              },
            ],
            h: 46,
          }));
        } else if (item.kind === "note" && item.text) {
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 14);
          if (!text) continue;
          await placeShort((ox) => ({
            skeleton: [
              {
                type: "text",
                x: ox + 8,
                y: rowY + 5,
                text: `— ${text}`,
                fontSize: 14,
                fontFamily: 1,
                strokeColor: "#846358",
              },
            ],
            h: 36,
          }));
        } else if (item.kind === "judge" && item.text) {
          // ✓/✗ 判断行：推荐做法绿勾、常见错误红叉
          const good = item.verdict !== "bad";
          const jc = good ? "#059669" : "#dc2626";
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 19);
          if (!text) continue;
          await placeShort((ox) => ({
            skeleton: [
              {
                type: "rectangle",
                x: ox,
                y: rowY,
                width: COL_W,
                height: 46,
                backgroundColor: jc + "0f",
                strokeColor: jc + "44",
                strokeWidth: 1,
                roughness: 0,
                roundness: { type: 3 },
              },
              {
                type: "text",
                x: ox + 18,
                y: rowY + 13,
                text: `${good ? "✓" : "✗"} ${text}`,
                fontSize: 16,
                fontFamily: 2,
                strokeColor: good ? "#047857" : "#b91c1c",
              },
            ],
            h: 46,
          }));
        } else if (item.kind === "subtitle" && item.text) {
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 12);
          if (!text) continue;
          await placeFull(() => ({
            skeleton: [
              {
                type: "text",
                x: mx + 22,
                y: rowY + 2,
                text,
                fontSize: 22,
                fontFamily: 2,
                strokeColor: "#1e1e1e",
              },
              {
                type: "line",
                x: mx + 4,
                y: rowY + 18,
                points: [
                  [0, 0],
                  [Math.min(text.length * 24 + 40, CONTENT_W - 12), 0],
                ],
                strokeColor: color + "88",
                strokeWidth: 2,
                roughness: 1,
              },
            ],
            h: 46,
          }));
        } else if (item.kind === "diagram" && item.nodes && item.nodes.length >= 2) {
          // 横向流程图：2-4 个节点盒子 + 衔接箭头（讲流程/数据流/架构）
          const nodes = item.nodes.slice(0, 4).map((n) => (n || "").trim().slice(0, 6)).filter(Boolean);
          if (nodes.length < 2) continue;
          await placeFull(() => {
            const n = nodes.length;
            const gap = 38;
            const boxW = Math.floor((CONTENT_W - (n - 1) * gap) / n);
            const boxH = 58;
            const sk: any[] = [];
            for (let ni = 0; ni < n; ni++) {
              const nx = mx + ni * (boxW + gap);
              sk.push({
                type: "rectangle",
                x: nx,
                y: rowY + 6,
                width: boxW,
                height: boxH,
                backgroundColor: color + "12",
                strokeColor: color,
                strokeWidth: 1.2,
                roughness: 0,
                roundness: { type: 3 },
              });
              sk.push({
                type: "text",
                x: nx + Math.max(4, (boxW - nodes[ni].length * 15) / 2),
                y: rowY + 6 + 20,
                text: nodes[ni],
                fontSize: 15,
                fontFamily: 2,
                strokeColor: "#1e1e1e",
              });
              if (ni < n - 1) {
                sk.push({
                  type: "arrow",
                  x: nx + boxW + 5,
                  y: rowY + 6 + boxH / 2,
                  points: [[0, 0], [gap - 10, 0]],
                  strokeColor: "#5f5e5a",
                  strokeWidth: 2,
                });
              }
            }
            return { skeleton: sk, h: boxH + 12 };
          });
        } else if (item.kind === "table" && item.headers && item.rows) {
          const cols = Math.max(2, Math.min(3, item.headers.length));
          const rows = item.rows.slice(0, 4);
          await placeFull(() => {
            const cellW = Math.floor(CONTENT_W / cols);
            const headH = 42;
            const rowH = 38;
            const sk: any[] = [];
            for (let ci = 0; ci < cols; ci++) {
              sk.push({
                type: "rectangle",
                x: mx + ci * cellW,
                y: rowY,
                width: cellW,
                height: headH,
                backgroundColor: color + "14",
                strokeColor: "#d3d1c7",
                strokeWidth: 1,
                roughness: 0,
              });
              sk.push({
                type: "text",
                x: mx + ci * cellW + 10,
                y: rowY + 11,
                text: (item.headers?.[ci] || "").slice(0, 8),
                fontSize: 15,
                fontFamily: 2,
                strokeColor: "#1e1e1e",
              });
            }
            let ty = rowY + headH;
            for (const row of rows) {
              for (let ci = 0; ci < cols; ci++) {
                sk.push({
                  type: "rectangle",
                  x: mx + ci * cellW,
                  y: ty,
                  width: cellW,
                  height: rowH,
                  backgroundColor: "transparent",
                  strokeColor: "#e7e5dc",
                  strokeWidth: 1,
                  roughness: 0,
                });
                sk.push({
                  type: "text",
                  x: mx + ci * cellW + 10,
                  y: ty + 10,
                  text: (row?.[ci] || "").slice(0, 8),
                  fontSize: 13,
                  fontFamily: 1,
                  strokeColor: "#1e1e1e",
                });
              }
              ty += rowH;
            }
            return { skeleton: sk, h: headH + rows.length * rowH + 6 };
          });
        } else if (item.kind === "chart" && item.values && item.values.length >= 2) {
          // 手绘趋势折线：坐标轴 + 折线 + 数据点 + 数值标注（讲增长/下降/波动）
          await placeFull(() => {
            const vals = item.values!.slice(0, 5).map((v) => Math.max(0, Number(v) || 0));
            const cw = Math.min(CONTENT_W - 60, 480);
            const chh = 118;
            const maxV = Math.max(...vals) || 1;
            const minV = Math.min(...vals, 0);
            const baseY = rowY + chh;
            const sk: any[] = [
              { type: "line", x: mx, y: baseY, points: [[0, 0], [0, -chh]], strokeColor: "#8a8880", strokeWidth: 1.2 },
              { type: "line", x: mx, y: baseY, points: [[0, 0], [cw + 12, 0]], strokeColor: "#8a8880", strokeWidth: 1.2 },
            ];
            const pts: number[][] = vals.map((v, i) => [
              Math.round((cw / (vals.length - 1)) * i),
              Math.round(-10 - ((v - minV) / (maxV - minV || 1)) * (chh - 26)),
            ]);
            sk.push({ type: "line", x: mx, y: baseY, points: pts, strokeColor: color, strokeWidth: 2.4, roughness: 1 });
            for (let pi = 0; pi < pts.length; pi++) {
              sk.push({
                type: "ellipse",
                x: mx + pts[pi][0] - 4,
                y: baseY + pts[pi][1] - 4,
                width: 8,
                height: 8,
                backgroundColor: color,
                strokeColor: color,
                strokeWidth: 1,
              });
              sk.push({
                type: "text",
                x: mx + pts[pi][0] - 8,
                y: baseY + pts[pi][1] - 26,
                text: String(vals[pi]),
                fontSize: 12,
                fontFamily: 2,
                strokeColor: "#57534e",
              });
            }
            return { skeleton: sk, h: chh + 14 };
          });
        } else if (item.kind === "vs" && (item.text || "").includes("|")) {
          // 左右对比栏：两块半行卡 + 中央 vs 圆徽
          const [l, r] = (item.text || "").split("|").map((s) => s.trim().slice(0, 10));
          if (!l && !r) continue;
          await placeFull(() => {
            const halfW = Math.floor((CONTENT_W - 76) / 2);
            const boxH = 56;
            const sk: any[] = [
              {
                type: "rectangle",
                x: mx,
                y: rowY,
                width: halfW,
                height: boxH,
                backgroundColor: "#84635810",
                strokeColor: "#84635844",
                strokeWidth: 1,
                roughness: 0,
                roundness: { type: 3 },
              },
              {
                type: "text",
                x: mx + (halfW - (l || "A").length * 17) / 2,
                y: rowY + 16,
                text: l || "A",
                fontSize: 17,
                fontFamily: 2,
                strokeColor: "#846358",
              },
              {
                type: "rectangle",
                x: mx + halfW + 76,
                y: rowY,
                width: halfW,
                height: boxH,
                backgroundColor: color + "12",
                strokeColor: color + "55",
                strokeWidth: 1,
                roughness: 0,
                roundness: { type: 3 },
              },
              {
                type: "text",
                x: mx + halfW + 76 + (halfW - (r || "B").length * 17) / 2,
                y: rowY + 16,
                text: r || "B",
                fontSize: 17,
                fontFamily: 2,
                strokeColor: "#1e1e1e",
              },
              {
                type: "ellipse",
                x: mx + halfW + 20,
                y: rowY + 11,
                width: 36,
                height: 36,
                backgroundColor: "#1e1e1e08",
                strokeColor: "#a3a19a",
                strokeWidth: 1,
              },
              {
                type: "text",
                x: mx + halfW + 26,
                y: rowY + 21,
                text: "vs",
                fontSize: 13,
                fontFamily: 2,
                strokeColor: "#a3a19a",
              },
            ];
            return { skeleton: sk, h: boxH + 8 };
          });
        } else if (item.kind === "tree" && item.nodes && item.nodes.length >= 2) {
          // 一层分支树：父概念在上，2-3 个子概念在下（讲分类/组成/派生）
          const nodes = item.nodes.slice(0, 3).map((n) => (n || "").trim().slice(0, 7)).filter(Boolean);
          if (nodes.length < 2) continue;
          await placeFull(() => {
            const parentW = Math.max(96, nodes[0].length * 17 + 28);
            const parentX = mx + Math.floor((CONTENT_W - parentW) / 2);
            const parentH = 40;
            const childY = rowY + parentH + 26;
            const n = nodes.length - 1;
            const gap = 22;
            const childW = Math.floor((CONTENT_W - (n - 1) * gap) / n);
            const sk: any[] = [
              {
                type: "rectangle",
                x: parentX,
                y: rowY,
                width: parentW,
                height: parentH,
                backgroundColor: color + "16",
                strokeColor: color,
                strokeWidth: 1.2,
                roughness: 0,
                roundness: { type: 3 },
              },
              {
                type: "text",
                x: parentX + Math.max(4, (parentW - nodes[0].length * 16) / 2),
                y: rowY + 9,
                text: nodes[0],
                fontSize: 16,
                fontFamily: 2,
                strokeColor: "#1e1e1e",
              },
            ];
            for (let ci = 1; ci < nodes.length; ci++) {
              const cx = mx + (ci - 1) * (childW + gap);
              sk.push({
                type: "line",
                x: parentX + parentW / 2,
                y: rowY + parentH,
                points: [[0, 0], [cx + childW / 2 - (parentX + parentW / 2), 26]],
                strokeColor: "#b4b2a9",
                strokeWidth: 1.2,
                roughness: 1,
              });
              sk.push({
                type: "rectangle",
                x: cx,
                y: childY,
                width: childW,
                height: 42,
                backgroundColor: color + "09",
                strokeColor: color + "77",
                strokeWidth: 1,
                roughness: 0,
                roundness: { type: 3 },
              });
              sk.push({
                type: "text",
                x: cx + Math.max(3, (childW - nodes[ci].length * 15) / 2),
                y: childY + 11,
                text: nodes[ci],
                fontSize: 15,
                fontFamily: 2,
                strokeColor: "#1e1e1e",
              });
            }
            return { skeleton: sk, h: parentH + 26 + 42 + 6 };
          });
        } else if (item.kind === "mark") {
          // 简笔标记：星标/感叹号/问号，画在上一条板书右上角（不占行）
          if (lastItemBox) {
            const b = lastItemBox;
            const mxp = b.x + Math.min(b.w, CONTENT_W - 40) + 8;
            const myp = b.y - 4;
            if (item.style === "alert") {
              await append([
                { type: "line", x: mxp, y: myp - 22, points: [[0, 0], [0, 14]], strokeColor: "#dc2626", strokeWidth: 2.4, roughness: 1 },
                { type: "line", x: mxp, y: myp - 2, points: [[0, 0], [0, 2.5]], strokeColor: "#dc2626", strokeWidth: 2.8, roughness: 1 },
              ]);
            } else if (item.style === "question") {
              await append([{ type: "text", x: mxp, y: myp - 30, text: "?", fontSize: 24, fontFamily: 2, strokeColor: "#7c3aed" }]);
            } else {
              // star：四芒星（两长两短交叉线）
              await append([
                { type: "line", x: mxp + 8, y: myp - 26, points: [[-8, 8], [8, -8]], strokeColor: "#d97706", strokeWidth: 1.8, roughness: 1 },
                { type: "line", x: mxp + 8, y: myp - 26, points: [[-8, -8], [8, 8]], strokeColor: "#d97706", strokeWidth: 1.8, roughness: 1 },
                { type: "line", x: mxp + 8, y: myp - 26, points: [[-13, 0], [13, 0]], strokeColor: "#d97706", strokeWidth: 1.4, roughness: 1 },
                { type: "line", x: mxp + 8, y: myp - 26, points: [[0, -13], [0, 13]], strokeColor: "#d97706", strokeWidth: 1.4, roughness: 1 },
              ]);
            }
            await delay(ITEM_DELAY_MS * 0.5);
          }
        } else if (item.kind === "quote" && item.text) {
          // 金句：手绘椭圆圈住一句话，字略大（片段收尾用）
          const q = item.text.replace(/\s+/g, " ").trim().slice(0, 18);
          if (!q) continue;
          await placeFull(() => {
            const qw = Math.min(CONTENT_W, q.length * 20 + 84);
            return {
              skeleton: [
                {
                  type: "ellipse",
                  x: mx + Math.floor((CONTENT_W - qw) / 2),
                  y: rowY - 2,
                  width: qw,
                  height: 60,
                  backgroundColor: "#fbbf2416",
                  strokeColor: "#d97706",
                  strokeWidth: 1.6,
                  roughness: 1,
                },
                {
                  type: "text",
                  x: mx + Math.floor((CONTENT_W - q.length * 20) / 2),
                  y: rowY + 17,
                  text: q,
                  fontSize: 19,
                  fontFamily: 1,
                  strokeColor: "#92400e",
                },
              ],
              h: 66,
            };
          });
        }

        await delay(ITEM_DELAY_MS);
      }
    },

    outline() {
      return [...sections];
    },

    removePencil,

    focusCurrent() {
      const bottom = Math.max(writingBottom() + 40, my + 220);
      void focusRegion(
        mx - CAM_PAD.x,
        my - CAM_PAD.top,
        MODULE_W + CAM_PAD.x * 2,
        bottom - my + CAM_PAD.top + CAM_PAD.bottom,
        0.9
      );
    },

    setTurbo(on: boolean) {
      turbo = on;
    },

    snapshot() {
      return {
        mx,
        my,
        rowY,
        contentBottom,
        moduleIndex,
        moduleUsed,
        pairPending,
        currentSection,
        colorIndex,
        sections: [...sections],
        lastItemBox,
        backdropId,
      };
    },

    restore(s: Record<string, any>) {
      if (!s) return;
      mx = typeof s.mx === "number" ? s.mx : START_X;
      my = typeof s.my === "number" ? s.my : START_Y;
      rowY = typeof s.rowY === "number" ? s.rowY : my + HEADER_H;
      contentBottom = typeof s.contentBottom === "number" ? s.contentBottom : my + HEADER_H;
      moduleIndex = typeof s.moduleIndex === "number" ? s.moduleIndex : 0;
      moduleUsed = s.moduleUsed ?? true;
      pairPending = s.pairPending || null;
      currentSection = s.currentSection ?? null;
      colorIndex = typeof s.colorIndex === "number" ? s.colorIndex : 0;
      sections.length = 0;
      if (Array.isArray(s.sections)) sections.push(...s.sections);
      lastItemBox = s.lastItemBox || null;
      backdropId = typeof s.backdropId === "string" ? s.backdropId : null;
    },
  };
}
