// BoardWriter：白板增量书写器 —— 播放器的"手"。
// 视觉纪律：Excalidraw 原生手绘语系 —— 手绘线（roughness 1）+ 排线填充（hachure）+ 手写字体，
//   白纸面板 + 墨色正文 + 单一强调色（墨绿）；每页正中大字锚点词圈出本片段核心概念（RSA 式视觉锚点）。
// 布局逻辑（模块板 + 导演式镜头）：
//   一个教学片段 = 一页"模块板"：小字页码 + 墨色标题 + 强调色短线页眉；
//   板内单列流式排版——要点带编号直排纸面，注释缩进为灰色副行，判断行贴内容细墨框，
//   结构图元（小节标题/流程图/表格/趋势图/对比/分支树/金句）独占整行；
//   片段讲完 → 板间画衔接箭头，镜头右移到下一页。整节课的板书连成一条学习路径。
//   镜头跟随书写进度：页首推近标题区，整页装得下时随内容平滑后拉；
//   装不下后不再拉远，保持可读缩放、底边跟随书写位——手写在哪、镜头看哪，字不再变小。
//   turbo 模式（回放重建用）：跳过动画与延时，瞬间把板书写到位。
import type { BoardItem } from "@/types";

// 主题取色：paper = v2.1 草稿纸上线版原值，逐像素不许动
const T = {
  boardBg: "#faf9f6",
  boardDot: "#d3d1c7",
  ink: "#1e1e1e",
  accent: "#0f6e56",
  mute: "#8a8880",
  faint: "#b4b2a9",
  semGood: "#047857",
  semBad: "#b91c1c",
  fillNeutral: "#e6e2d4",
  diagramStroke: "#57534e",
  chartAxis: "#8a8880",
  backdropBg: "#ffffff",
  backdropStroke: "#1e1e1e1f",
  judgeStroke: "#1e1e1e2b",
  tableHeadBg: "#f1efe8",
  tableHeadStroke: "#d3d1c7",
  tableRowStroke: "#e7e5dc",
  quoteBg: "#0f6e560f",
  vsBadgeBg: "#1e1e1e08",
  vsBadgeStroke: "#a3a19a",
  vsBadgeText: "#a3a19a",
};
const START_X = 60;
const START_Y = 60;
const MODULE_W = 660; // 模块板总宽（收窄让内容占满版面，密度优先）
const CONTENT_W = 636; // 板内内容宽
const HEADER_H = 92; // 标题区高（页码 + 标题 + 强调线）
const ROW_GAP = 14;
const MODULE_X_GAP = 230; // 两块模块板的间距
const ITEM_DELAY_MS = 280; // 每条板书出现间隔，模拟手写节奏
const WRITE_MAX_ZOOM = 1.45; // 书写镜头最大推近（字别放得过大）
const WRITE_MIN_ZOOM = 0.8; // 书写镜头最远：再远板书就看不清，改为平移跟拍、不再拉远
const FOLLOW_BOTTOM_PAD = 100; // 跟拍时画面底边到最新板书的留白（避开暂停条浮层）
const CAM_PAD = { x: 70, top: 64, bottom: 56 };
const ANCHOR_ID = "camera-anchor";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardWriter {
  /** 新片段：把镜头带到新模块板，画指数徽章 + 大标题（progress 可选；anchor 为本片段锚点词，画在正中圈出） */
  beginSegment(
    title: string,
    progress?: { index: number; total: number },
    anchor?: string,
    segmentKey?: string
  ): Promise<void>;
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
  let moduleIndex = 0; // 已开始的模块数（页码从 1 起）
  let moduleUsed = false; // 当前模块是否写过内容
  let bulletNo = 0; // 当前模块内的要点编号（换模块归零）
  let currentSection: string | null = null;
  let lastItemBox: Box | null = null;
  let backdropId: string | null = null; // 当前模块底卡元素 id（finalize 时按内容撑高）
  let lastSegmentKey: string | null = null; // 当前模块页归属的片段 id（断线恢复时判断快照是否已含该片段的页）
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

  /** 当前书写内容的最低点 */
  function writingBottom(): number {
    return contentBottom;
  }

  /** 书写镜头：可读度优先——整页装得下就整页入画（随内容平滑后拉）；
   *  装不下后固定在可读缩放，底边跟随书写位（新写的行永远在画面里），页眉自然滚出画面上方 */
  async function focusWriting() {
    const w = MODULE_W + CAM_PAD.x * 2;
    const contentH = writingBottom() - my;
    const frameH = contentH + CAM_PAD.top + CAM_PAD.bottom;
    const api = await waitForApi();
    if (!api) return;
    const st = api.getAppState();
    const vpW = st.width || 1100;
    const vpH = st.height || 620;
    if (Math.min(vpW / w, vpH / frameH) * 0.97 >= WRITE_MIN_ZOOM) {
      await focusRegion(mx - CAM_PAD.x, my - CAM_PAD.top, w, frameH, 0.97, WRITE_MAX_ZOOM);
      return;
    }
    // 页面已长高：不再拉远，取景窗底边贴最新板书
    const winH = vpH / WRITE_MIN_ZOOM;
    const top = Math.max(my - CAM_PAD.top, my + contentH + FOLLOW_BOTTOM_PAD - winH);
    await focusRegion(mx - CAM_PAD.x, top, w, winH, 1);
  }

  /** 纸随写随撑：每写一行就把底卡撑到当前内容高度（不等翻页收尾，避免内容溢出纸外） */
  function growBackdrop() {
    if (!backdropId) return;
    const api = getApi();
    if (!api) return;
    const h = Math.max(220, writingBottom() - my + 34);
    try {
      const els = api
        .getSceneElements()
        .map((el: any) =>
          el.id === backdropId && Math.abs((el.height || 0) - h) > 1 ? { ...el, height: h } : el
        );
      api.updateScene({ elements: els });
    } catch {
      // 场景未就绪时忽略
    }
  }

  /** 模块收尾：把底卡撑到实际内容高度（底卡真实 id 在 beginSegment 时从 append 返回值记下） */
  function finalizeModule() {
    growBackdrop();
  }

  /** 板间衔接箭头：整节课的板书串成一条路径（中点微微上挑，手绘弧线） */
  async function drawConnector() {
    const g = MODULE_X_GAP - 92;
    await append([
      {
        type: "arrow",
        x: mx + MODULE_W + 46,
        y: my + 140,
        points: [
          [0, 0],
          [Math.round(g * 0.5), -12],
          [g, 0],
        ],
        strokeColor: T.faint,
        strokeWidth: 2,
        roughness: 1,
      },
    ]);
  }

  /** 模块板头部：小字页码（右侧）+ 墨色标题 + 单强调色手绘短线（讲义页眉） */
  async function drawModuleHeader(title: string, progress?: { index: number; total: number }) {
    const shown = title.slice(0, 14);
    const badgeText = progress?.total ? `${moduleIndex}/${progress.total}` : `${moduleIndex}`;
    await append([
      {
        type: "text",
        x: mx + MODULE_W - 64,
        y: my + 8,
        text: badgeText,
        fontSize: 15,
        fontFamily: 5,
        strokeColor: T.mute,
      },
      {
        type: "text",
        x: mx + 12,
        y: my + 3,
        text: shown,
        fontSize: 25,
        fontFamily: 5,
        strokeColor: T.ink,
      },
      {
        type: "line",
        x: mx + 12,
        y: my + 56,
        points: [
          [0, 0],
          [Math.min(shown.length * 27 + 34, MODULE_W - 24), 0],
        ],
        strokeColor: T.accent,
        strokeWidth: 2,
        roughness: 1,
      },
    ]);
  }

  /** 在当前行画一个小节标题（模块内换主题时）：短强调引线 + 墨色文字，独占整行 */
  async function drawSectionHeading(name: string) {
    const text = name.slice(0, 14);
    await append([
      {
        type: "line",
        x: mx + 10,
        y: rowY + 18,
        points: [
          [0, 0],
          [18, 0],
        ],
        strokeColor: T.accent,
        strokeWidth: 2.5,
        roughness: 1,
      },
      {
        type: "text",
        x: mx + 40,
        y: rowY + 6,
        text,
        fontSize: 20,
        fontFamily: 5,
        strokeColor: T.ink,
      },
    ]);
    lastItemBox = { x: mx, y: rowY, w: CONTENT_W, h: 40 };
    rowY += 40 + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
    growBackdrop();
  }

  /** 独占整行的图元：画整行并推进书写游标（emBox 可指定强调圈画的贴合范围） */
  async function placeFull(render: () => { skeleton: any[]; h: number; emBox?: Box }) {
    const { skeleton, h, emBox } = render();
    if (skeleton.length === 0) return;
    await append(skeleton);
    lastItemBox = emBox || { x: mx, y: rowY, w: CONTENT_W, h };
    rowY += h + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
    growBackdrop();
    await focusWriting();
  }

  /** 在上一条板书上做强调（圈重点 / 划重点线 / 爆星强调）：一律墨绿单色 */
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
          backgroundColor: "transparent",
          strokeColor: T.accent,
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
          strokeColor: T.accent,
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
        strokeColor: T.accent,
        strokeWidth: 1.5,
        roughness: 1,
      });
    }
    return rays;
  }

  return {
    async beginSegment(title: string, progress?: { index: number; total: number }, anchor?: string, segmentKey?: string) {
      // 上一块模块收尾：底卡撑高 → 板间箭头 → 右移开新板
      if (moduleUsed) {
        finalizeModule();
        await drawConnector();
        mx += MODULE_W + MODULE_X_GAP;
      }
      moduleIndex += 1;
      bulletNo = 0;
      currentSection = null;
      lastItemBox = null;
      lastSegmentKey = segmentKey || null;
      const anchorWord = (anchor || "").trim().slice(0, 6);
      const anchorBand = anchorWord ? 66 : 0; // 标题线下方为锚点带让出的高度
      rowY = my + HEADER_H + anchorBand;
      contentBottom = rowY;
      moduleUsed = true;

      // 模块底卡 = 一页纸：白底 + 手绘淡墨线框，先画（z 序在最底），收尾时按内容撑高。
      // id 不能自己指定——convertToExcalidrawElements 不保留自定义 id，真实 id 以 append 返回为准
      const created = await append([
        {
          type: "rectangle",
          x: mx - 18,
          y: my - 24,
          width: MODULE_W + 36,
          height: 220,
          backgroundColor: T.backdropBg,
          strokeColor: T.backdropStroke,
          strokeWidth: 1,
          roughness: 1,
          roundness: { type: 3 },
        },
      ]);
      backdropId = created[0]?.id || null;
      await drawModuleHeader(title, progress);
      // 锚点词：本片段最核心的概念，大字写在正中、墨绿手绘椭圆圈出（视觉锚点）
      if (anchorWord) {
        const w = anchorWord.length * 40 + 58;
        await append([
          {
            type: "ellipse",
            x: mx + Math.floor((MODULE_W - w) / 2),
            y: my + 64,
            width: w,
            height: 66,
            backgroundColor: "transparent",
            strokeColor: T.accent,
            strokeWidth: 2,
            roughness: 1,
          },
          {
            type: "text",
            x: mx + Math.floor((MODULE_W - anchorWord.length * 40) / 2),
            y: my + 76,
            text: anchorWord,
            fontSize: 40,
            fontFamily: 5,
            strokeColor: T.ink,
          },
        ]);
      }
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
        await drawSectionHeading(newSection);
      }

      // 逐条写内容，边讲边写
      for (const item of list) {
        if (item.kind === "circle" || item.kind === "underline" || item.kind === "burst") {
          await append(emphasizeSkeleton(item.kind));
          await delay(ITEM_DELAY_MS * 0.5);
          continue;
        }

        if (item.kind === "bullet" && item.text) {
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 30);
          if (!text) continue;
          bulletNo += 1;
          const no = bulletNo;
          await placeFull(() => ({
            skeleton: [
              {
                type: "text",
                x: mx + 10,
                y: rowY + 2,
                text: `${no}.`,
                fontSize: 15,
                fontFamily: 5,
                strokeColor: T.mute,
              },
              {
                type: "text",
                x: mx + 42,
                y: rowY,
                text,
                fontSize: 17,
                fontFamily: 5,
                strokeColor: T.ink,
              },
            ],
            h: 34,
            emBox: {
              x: mx + 36,
              y: rowY - 2,
              w: Math.min(text.length * 18 + 24, CONTENT_W - 44),
              h: 36,
            },
          }));
        } else if (item.kind === "note" && item.text) {
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 24);
          if (!text) continue;
          await placeFull(() => ({
            skeleton: [
              {
                type: "text",
                x: mx + 42,
                y: rowY + 3,
                text: `— ${text}`,
                fontSize: 14,
                fontFamily: 5,
                strokeColor: T.mute,
              },
            ],
            h: 28,
            emBox: {
              x: mx + 42,
              y: rowY,
              w: Math.min(text.length * 15 + 30, CONTENT_W - 50),
              h: 28,
            },
          }));
        } else if (item.kind === "judge" && item.text) {
          // ✓/✗ 判断行：语义色只出现在勾/叉上，正文墨色，细墨框贴着内容宽
          const good = item.verdict !== "bad";
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 24);
          if (!text) continue;
          await placeFull(() => {
            const boxW = Math.min(CONTENT_W, 66 + Math.round(text.length * 15.5));
            return {
              skeleton: [
                {
                  type: "rectangle",
                  x: mx,
                  y: rowY,
                  width: boxW,
                  height: 42,
                  backgroundColor: "transparent",
                  strokeColor: T.judgeStroke,
                  strokeWidth: 1,
                  roughness: 1,
                },
                {
                  type: "text",
                  x: mx + 16,
                  y: rowY + 11,
                  text: good ? "✓" : "✗",
                  fontSize: 16,
                  fontFamily: 2,
                  strokeColor: good ? T.semGood : T.semBad,
                },
                {
                  type: "text",
                  x: mx + 46,
                  y: rowY + 11,
                  text,
                  fontSize: 15,
                  fontFamily: 5,
                  strokeColor: T.ink,
                },
              ],
              h: 42,
              emBox: { x: mx, y: rowY, w: boxW, h: 42 },
            };
          });
        } else if (item.kind === "subtitle" && item.text) {
          const text = item.text.replace(/\s+/g, " ").trim().slice(0, 14);
          if (!text) continue;
          await drawSectionHeading(text);
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
                backgroundColor: T.fillNeutral,
                fillStyle: "hachure",
                strokeColor: T.diagramStroke,
                strokeWidth: 1.2,
                roughness: 1,
              });
              sk.push({
                type: "text",
                x: nx + Math.max(4, (boxW - nodes[ni].length * 15) / 2),
                y: rowY + 6 + 20,
                text: nodes[ni],
                fontSize: 15,
                fontFamily: 5,
                strokeColor: T.ink,
              });
              if (ni < n - 1) {
                sk.push({
                  type: "arrow",
                  x: nx + boxW + 5,
                  y: rowY + 6 + boxH / 2,
                  points: [
                    [0, 0],
                    [Math.round((gap - 10) / 2), -6],
                    [gap - 10, 0],
                  ],
                  strokeColor: T.mute,
                  strokeWidth: 1.5,
                  roughness: 1,
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
                backgroundColor: T.tableHeadBg,
                strokeColor: T.tableHeadStroke,
                strokeWidth: 1,
                roughness: 1,
              });
              sk.push({
                type: "text",
                x: mx + ci * cellW + 10,
                y: rowY + 11,
                text: (item.headers?.[ci] || "").slice(0, 8),
                fontSize: 15,
                fontFamily: 5,
                strokeColor: T.ink,
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
                  strokeColor: T.tableRowStroke,
                  strokeWidth: 1,
                  roughness: 1,
                });
                sk.push({
                  type: "text",
                  x: mx + ci * cellW + 10,
                  y: ty + 10,
                  text: (row?.[ci] || "").slice(0, 8),
                  fontSize: 13,
                  fontFamily: 5,
                  strokeColor: T.ink,
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
              { type: "line", x: mx, y: baseY, points: [[0, 0], [0, -chh]], strokeColor: T.chartAxis, strokeWidth: 1.2 },
              { type: "line", x: mx, y: baseY, points: [[0, 0], [cw + 12, 0]], strokeColor: T.chartAxis, strokeWidth: 1.2 },
            ];
            const pts: number[][] = vals.map((v, i) => [
              Math.round((cw / (vals.length - 1)) * i),
              Math.round(-10 - ((v - minV) / (maxV - minV || 1)) * (chh - 26)),
            ]);
            sk.push({ type: "line", x: mx, y: baseY, points: pts, strokeColor: T.accent, strokeWidth: 2, roughness: 1 });
            for (let pi = 0; pi < pts.length; pi++) {
              sk.push({
                type: "ellipse",
                x: mx + pts[pi][0] - 4,
                y: baseY + pts[pi][1] - 4,
                width: 8,
                height: 8,
                backgroundColor: T.accent,
                strokeColor: T.accent,
                strokeWidth: 1,
              });
              sk.push({
                type: "text",
                x: mx + pts[pi][0] - 8,
                y: baseY + pts[pi][1] - 26,
                text: String(vals[pi]),
                fontSize: 12,
                fontFamily: 5,
                strokeColor: T.diagramStroke,
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
                backgroundColor: "transparent",
                strokeColor: T.faint,
                strokeWidth: 1,
                roughness: 1,
              },
              {
                type: "text",
                x: mx + (halfW - (l || "A").length * 17) / 2,
                y: rowY + 16,
                text: l || "A",
                fontSize: 17,
                fontFamily: 5,
                strokeColor: T.ink,
              },
              {
                type: "rectangle",
                x: mx + halfW + 76,
                y: rowY,
                width: halfW,
                height: boxH,
                backgroundColor: "transparent",
                strokeColor: T.faint,
                strokeWidth: 1,
                roughness: 1,
              },
              {
                type: "text",
                x: mx + halfW + 76 + (halfW - (r || "B").length * 17) / 2,
                y: rowY + 16,
                text: r || "B",
                fontSize: 17,
                fontFamily: 5,
                strokeColor: T.ink,
              },
              {
                type: "ellipse",
                x: mx + halfW + 20,
                y: rowY + 11,
                width: 36,
                height: 36,
                backgroundColor: T.vsBadgeBg,
                strokeColor: T.vsBadgeStroke,
                strokeWidth: 1,
                roughness: 1,
              },
              {
                type: "text",
                x: mx + halfW + 26,
                y: rowY + 21,
                text: "vs",
                fontSize: 13,
                fontFamily: 5,
                strokeColor: T.vsBadgeText,
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
                backgroundColor: T.fillNeutral,
                fillStyle: "hachure",
                strokeColor: T.diagramStroke,
                strokeWidth: 1.2,
                roughness: 1,
              },
              {
                type: "text",
                x: parentX + Math.max(4, (parentW - nodes[0].length * 16) / 2),
                y: rowY + 9,
                text: nodes[0],
                fontSize: 16,
                fontFamily: 5,
                strokeColor: T.ink,
              },
            ];
            for (let ci = 1; ci < nodes.length; ci++) {
              const cx = mx + (ci - 1) * (childW + gap);
              sk.push({
                type: "line",
                x: parentX + parentW / 2,
                y: rowY + parentH,
                points: [[0, 0], [cx + childW / 2 - (parentX + parentW / 2), 26]],
                strokeColor: T.faint,
                strokeWidth: 1.2,
                roughness: 1,
              });
              sk.push({
                type: "rectangle",
                x: cx,
                y: childY,
                width: childW,
                height: 42,
                backgroundColor: "transparent",
                strokeColor: T.mute,
                strokeWidth: 1.2,
                roughness: 1,
              });
              sk.push({
                type: "text",
                x: cx + Math.max(3, (childW - nodes[ci].length * 15) / 2),
                y: childY + 11,
                text: nodes[ci],
                fontSize: 15,
                fontFamily: 5,
                strokeColor: T.ink,
              });
            }
            return { skeleton: sk, h: parentH + 26 + 42 + 6 };
          });
        } else if (item.kind === "mark") {
          // 简笔标记：星标/感叹号/问号。上一行是窄行 → 贴行尾作页边批注；
          // 上一行是整行宽内容（表格/流程/对比）或行尾放不下 → 在内容下方另起小行写，不压在内容上
          if (lastItemBox) {
            const b = lastItemBox;
            const fitsInRow = b.x + b.w + 14 <= mx + CONTENT_W - 24;
            const wide = b.w > CONTENT_W * 0.7 || !fitsInRow;
            const mxp = wide ? mx + 42 : Math.min(b.x + b.w + 14, mx + CONTENT_W - 24);
            const myp = wide ? b.y + b.h + 12 : b.y + Math.max(4, (b.h - 26) / 2);
            if (item.style === "alert") {
              await append([
                { type: "line", x: mxp, y: myp, points: [[0, 0], [0, 15]], strokeColor: T.semBad, strokeWidth: 2.4, roughness: 1 },
                { type: "line", x: mxp, y: myp + 21, points: [[0, 0], [0, 2.5]], strokeColor: T.semBad, strokeWidth: 2.8, roughness: 1 },
              ]);
            } else if (item.style === "question") {
              await append([{ type: "text", x: mxp, y: myp - 5, text: "?", fontSize: 22, fontFamily: 5, strokeColor: T.accent }]);
            } else {
              // star：四芒星（两长两短交叉线）
              const cx = mxp + 9;
              const cy = myp + 13;
              await append([
                { type: "line", x: cx, y: cy, points: [[-8, 8], [8, -8]], strokeColor: T.accent, strokeWidth: 1.8, roughness: 1 },
                { type: "line", x: cx, y: cy, points: [[-8, -8], [8, 8]], strokeColor: T.accent, strokeWidth: 1.8, roughness: 1 },
                { type: "line", x: cx, y: cy, points: [[-13, 0], [13, 0]], strokeColor: T.accent, strokeWidth: 1.4, roughness: 1 },
                { type: "line", x: cx, y: cy, points: [[0, -13], [0, 13]], strokeColor: T.accent, strokeWidth: 1.4, roughness: 1 },
              ]);
            }
            if (wide) {
              rowY = Math.max(rowY, myp + 34 + ROW_GAP);
              contentBottom = Math.max(contentBottom, myp + 34);
              growBackdrop();
            }
            await delay(ITEM_DELAY_MS * 0.5);
          }
        } else if (item.kind === "quote" && item.text) {
          // 金句：强调色手绘椭圆圈住一句话（片段收尾用）
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
                  backgroundColor: T.quoteBg,
                  strokeColor: T.accent,
                  strokeWidth: 1.6,
                  roughness: 1,
                },
                {
                  type: "text",
                  x: mx + Math.floor((CONTENT_W - q.length * 20) / 2),
                  y: rowY + 17,
                  text: q,
                  fontSize: 19,
                  fontFamily: 5,
                  strokeColor: T.ink,
                },
              ],
              h: 66,
              emBox: { x: mx + Math.floor((CONTENT_W - qw) / 2), y: rowY - 2, w: qw, h: 64 },
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
      void focusWriting();
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
        bulletNo,
        currentSection,
        sections: [...sections],
        lastItemBox,
        backdropId,
        lastSegmentKey,
      };
    },

    restore(s: Record<string, any>) {
      if (!s) return;
      mx = typeof s.mx === "number" ? s.mx : START_X;
      my = typeof s.my === "number" ? s.my : START_Y;
      rowY = typeof s.rowY === "number" ? s.rowY : my + HEADER_H;
      contentBottom = typeof s.contentBottom === "number" ? s.contentBottom : my + HEADER_H;
      moduleIndex = typeof s.moduleIndex === "number" ? s.moduleIndex : 0;
      // 快照缺字段 = 布局未知（如空恢复）：按"没有起过页"处理，首个 beginSegment 从头画第一页，
      // 不能默认 true——否则会对着不存在的上一页做收尾并右移出一块空白页
      moduleUsed = typeof s.moduleUsed === "boolean" ? s.moduleUsed : false;
      bulletNo = typeof s.bulletNo === "number" ? s.bulletNo : 0;
      currentSection = s.currentSection ?? null;
      sections.length = 0;
      if (Array.isArray(s.sections)) sections.push(...s.sections);
      lastItemBox = s.lastItemBox || null;
      backdropId = typeof s.backdropId === "string" ? s.backdropId : null;
      lastSegmentKey = typeof s.lastSegmentKey === "string" ? s.lastSegmentKey : null;
    },
  };
}
