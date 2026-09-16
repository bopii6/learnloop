// BoardWriter：白板增量书写器 —— 播放器的"手"。
// 视觉纪律：卡片冷调（定稿，见 lib/board-themes.ts）——扁平粉彩卡片语系：近白纸面 + 圆角粉彩卡
//   （roughness 0 直线）+ 编号圆徽 + 胶囊锚点 + 直线页眉；简笔小人保持手绘笔触（手作温度）。
// 布局逻辑（模块板 + 导演式镜头）：
//   一个教学片段 = 一页"模块板"：小字页码 + 藏蓝标题 + 强调色直线页眉；
//   板内单列流式排版——要点带编号圆徽直排纸面，注释缩进为灰色副行，判断行粉彩底色卡，
//   结构图元（小节标题/流程图/表格/趋势图/对比/分支树/金句）独占整行；
//   片段讲完 → 板间画衔接箭头，镜头右移到下一页。整节课的板书连成一条学习路径。
//   镜头跟随书写进度：页首推近标题区，整页装得下时随内容平滑后拉；
//   装不下后不再拉远，保持可读缩放、底边跟随书写位——手写在哪、镜头看哪，字不再变小。
//   turbo 模式（回放重建用）：跳过动画与延时，瞬间把板书写到位。
import type { BoardItem } from "@/types";
import {
  classicRecolorMaps,
  getBoardTheme,
  type BoardColors,
} from "@/lib/board-themes";
import { buildBattleMapSkeleton, type BattleMapData, type BattleMapBox } from "@/lib/battle-map";

/** 白板原住民角色：stick 简笔小人（定稿，站页眉线上）/ none 不画 */
export type BoardCharacter = "stick" | "none";

/** 角色姿势：normal 平常 / ask 出题举手 / celebrate 庆祝 / fail 翻车emo / happy 开心 */
type CharacterPose = "normal" | "ask" | "celebrate" | "fail" | "happy";

// 配色：卡片冷调（见 lib/board-themes.ts）。accents 按模块轮换（T.accent = 当前模块强调色）；
// T 就是 board-themes 的共享可写色板对象（writer 闭包即时可见）；
// 旧课堂的经典墨绿板书经 classicRecolorMaps() 重着色（recolorExisting，恢复路径会调用）。
let T: BoardColors = getBoardTheme().colors;
// 原住民角色：每页 beginSegment 时在页眉右端"画"出来（和板书同笔触），切换角色时擦掉当前页重画
let character = "stick" as BoardCharacter;
let charIds: string[] = [];
// 角色出演（cast）：正在场景里当当事人时，页眉的"旁白位"下场，removePencil/翻页时归位
let castIds: string[] = [];
let castActive = false;
const START_X = 60;
const START_Y = 60;
const MODULE_W = 660; // 模块板总宽（收窄让内容占满版面，密度优先）
const CONTENT_W = 636; // 板内内容宽
const HEADER_H = 92; // 标题区高（页码 + 标题 + 强调线）
const ROW_GAP = 14;
const MODULE_X_GAP = 230; // 两块模块板的间距
const ITEM_DELAY_MS = 280; // 每条板书出现间隔，模拟手写节奏
/** 板书标题归一化：去掉空白/中英文标点后小写，只用于"是否同一条标题"的比对 */
function normSectionKey(s: string): string {
  return s.replace(/[\s，。：:、（）()\[\]【】·\-—_？！?!.,'"'""]+/g, "").toLowerCase();
}
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
  /** 写一条 beat 的板书（section 是模块内的小节标题，可选），整拍一次性写完（回放重建用） */
  write(section: string | undefined, items: BoardItem[]): Promise<void>;
  /** 新 beat 开场：画小节标题（如有）。同步节拍下由 pump 在开讲前调用 */
  beginBeat(section: string | undefined, itemCount: number): Promise<void>;
  /** 写一条板书（同步节拍：说到对应句子时调用），写完角色蹦一下 */
  writeItem(item: BoardItem): Promise<void>;
  /** 荧光笔跟随：在刚写完的那条板书下垫一道黄色高亮，念完这句后淡出——"讲到哪写到哪"变成看得见的节奏 */
  highlightLast(): void;
  /** 战况图：开课第一画，把学员的结课作品骨架画在长卷最左，教学模块从它右侧起纸 */
  drawBattleMap(map: BattleMapData): Promise<void>;
  /** 镜头回到战况图（开课全景 / 结课回收） */
  focusBattleMap(): void;
  /** 结课盖章：点亮第 index 块（0-based，对应课程单元顺序），并把镜头带到战况图 */
  crownBlock(index: number): Promise<void>;
  /** 角色进入"出题"姿势（举手 + 问号）；false 还原 */
  characterAsk(on: boolean): void;
  /** 角色庆祝姿势 + 撒花（结课时调用） */
  characterCelebrate(): void;
  /** 已写下的模块名/小节名（注入学员提问上下文） */
  outline(): string[];
  /** 白板可点：命中场景坐标所在板书条目的文字；没点中返回 null。恢复重建的旧板书不在册 */
  hitTest(x: number, y: number): string | null;
  /** 移除铅笔指示（片段讲完时调用） */
  removePencil(): void;
  /** 镜头对准当前模块板（断线恢复还原画面后调用） */
  focusCurrent(): void;
  /** turbo 模式：跳过手写动画与延时（回放重建瞬间到位） */
  setTurbo(on: boolean): void;
  /** 给已有板书按"经典 → 暖阳"映射重着色（断线恢复出的旧板书用） */
  recolor(): void;
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
  // 战况图（征途计分牌）：开课第一画，学员的目标骨架；结课时在对应块上盖章
  let battleMapBox: BattleMapBox | null = null;
  let battleBlockBoxes: BattleMapBox[] = [];
  let battleTodayIndex = -1; // "今日主攻"那一块的序号（巡游收尾停在它上面）
  let battleMapReady = false;

  // 荧光笔跟随：高亮元素的 id 前缀与停留时长（先减淡再擦除，不与下一道叠加）
  const HL_ID_PREFIX = "board-hl-";
  const HL_MS = 6500;

  // 白板可点：写过的每条板书的落点盒（场景坐标），点击命中后讲师就这条展开讲
  const hitBoxes: (Box & { text: string })[] = [];

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

  async function append(skeleton: any[], instant = false): Promise<any[]> {
    const api = await waitForApi();
    if (!api || skeleton.length === 0) return [];
    await ensureConvert();
    const keep = api.getSceneElements().filter((el: any) => !el.isDeleted);
    const els = convert!(skeleton);
    if (turbo || instant) {
      // 回放重建 / 战况图：一步到位，不做打字机与浮入（几十条文字的并发打字机只会糊成一团）
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
    // 角色已下架（墨纸主题不做吉祥物）：出演态直接复位，不再画小人
    if (castActive) {
      castActive = false;
      eraseCast();
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
    maxZoom = 2.2,
    zoomOverride?: number
  ) {
    const api = await waitForApi();
    if (!api) return;
    const st = api.getAppState();
    const vpW = st.width || 1100;
    const vpH = st.height || 620;
    const zoom = zoomOverride ?? Math.max(0.35, Math.min(maxZoom, Math.min(vpW / w, vpH / h) * zoomFactor));
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

  /** 战况图巡游：征途图比一屏高，缩到 35% 就看不清字了——改为定住可读缩放、镜头自上而下扫一遍 */
  async function tourBattleMap() {
    const b = battleMapBox;
    if (!b) return;
    const api = await waitForApi();
    if (!api) return;
    const st = api.getAppState();
    const vpW = st.width || 1100;
    const vpH = st.height || 620;
    // 可读缩放：以宽度为准，夹在 0.72~1.05 之间
    const zoom = Math.max(0.72, Math.min(1.05, (vpW / (b.w + 96)) * 0.96));
    const winH = vpH / zoom;
    const x = b.x - 48;
    const w = b.w + 96;
    const stops = [b.y - 40, b.y + Math.max(0, (b.h - winH) / 2), Math.max(b.y - 40, b.y + b.h + 40 - winH)];
    for (const sy of stops) {
      await focusRegion(x, sy, w, winH, 1, 2.2, zoom);
      await delay(520);
    }
    // 收尾停在"今日主攻"那一块：巡游的落点是"今天要啃的是这块"，不是地图底部
    if (battleTodayIndex >= 0) await focusBlock(battleTodayIndex);
  }

  /** 镜头对准某一块（可读缩放）：巡游落点 / 结课盖章都停在这 */
  async function focusBlock(index: number) {
    const box = battleBlockBoxes[index];
    if (!box) return;
    const api = await waitForApi();
    if (!api) return;
    const st = api.getAppState();
    const vpW = st.width || 1100;
    const vpH = st.height || 620;
    const zoom = Math.max(0.85, Math.min(1.15, (vpW / (box.w + 140)) * 0.96));
    await focusRegion(box.x - 70, box.y - 40, box.w + 140, vpH / zoom, 1, 2.2, zoom);
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
        roughness: 0,
      },
    ]);
  }

  /** 模块板头部：墨字标题 + 标题前一枚强调色小方块 + 一条细规线 + 右上角极淡页码 */
  async function drawModuleHeader(title: string, progress?: { index: number; total: number }) {
    const shown = title.slice(0, 18);
    const badgeText = progress?.total ? `${moduleIndex}/${progress.total}` : `${moduleIndex}`;
    await append([
      // 页码：极小极淡，放在右上角，像书页的页眉
      {
        type: "text",
        x: mx + MODULE_W - badgeText.length * 8 - 14,
        y: my + 8,
        text: badgeText,
        fontSize: 13,
        fontFamily: 2,
        strokeColor: T.faint,
      },
      // 标题前的小方块：唯一的"颜色锚点"，替代原来的粉彩胶囊
      {
        type: "rectangle",
        x: mx + 14,
        y: my + 17,
        width: 8,
        height: 8,
        backgroundColor: T.accent,
        fillStyle: "solid",
        strokeColor: "transparent",
        strokeWidth: 0,
        roughness: 0,
      },
      {
        type: "text",
        x: mx + 34,
        y: my + 2,
        text: shown,
        fontSize: 27,
        fontFamily: 2,
        strokeColor: T.ink,
      },
      {
        // 通栏细规线：像书页的页眉横线，把标题区与内容分开
        type: "line",
        x: mx + 14,
        y: my + 50,
        points: [[0, 0], [MODULE_W - 28, 0]],
        strokeColor: T.faint,
        strokeWidth: 1,
        roughness: 0,
      },
    ]);
  }

  /** 小节标题：小号强调色标签 + 通栏细线，替代原来的荧光笔底色条（去糖果化） */
  async function drawSectionHeading(name: string) {
    const text = name.slice(0, 18);
    await append([
      {
        type: "text",
        x: mx + 12,
        y: rowY + 2,
        text,
        fontSize: 15.5,
        fontFamily: 2,
        strokeColor: T.accent,
      },
      {
        type: "line",
        x: mx + 12 + text.length * 15.5 + 12,
        y: rowY + 13,
        points: [[0, 0], [Math.max(0, CONTENT_W - 24 - (text.length * 15.5 + 12)), 0]],
        strokeColor: T.faint,
        strokeWidth: 1,
        roughness: 0,
      },
    ]);
    lastItemBox = { x: mx, y: rowY, w: CONTENT_W, h: 32 };
    rowY += 32 + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
    growBackdrop();
  }

  /** 独占整行的图元：画整行并推进书写游标（emBox 可指定强调圈画的贴合范围） */
  async function placeFull(render: () => { skeleton: any[]; h: number; emBox?: Box }) {
    const { skeleton, h, emBox } = render();
    if (skeleton.length === 0) return;
    await append(skeleton);
    lastItemBox = emBox || { x: mx, y: rowY, w: CONTENT_W, h };
    // 记录可点击的板书条目（白板可点：点哪条讲哪条）。标签取骨架里的文字元素，
    // 对 bullet/表格/流程图/金句都通用；没有文字的骨架（纯图形）不记。
    const label = skeleton
      .filter((s: any) => s.type === "text" && s.text)
      .map((s: any) => String(s.text))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    if (label) hitBoxes.push({ ...lastItemBox, text: label });
    rowY += h + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
    growBackdrop();
    await focusWriting();
  }

  /** 在上一条板书上做强调（圈重点 / 划重点线 / 爆星强调）：干净圆角圈 / 直线 */
  function emphasizeSkeleton(kind: "circle" | "underline" | "burst"): any[] {
    if (!lastItemBox) return [];
    const b = lastItemBox;
    if (kind === "circle") {
      return [
        {
          type: "rectangle",
          x: b.x - 10,
          y: b.y - 6,
          width: Math.min(b.w + 20, CONTENT_W + 8),
          height: b.h + 12,
          backgroundColor: "transparent",
          strokeColor: T.accent,
          strokeWidth: 1.4,
          roughness: 0,
          roundness: null,
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
          strokeWidth: 2.5,
          roughness: 0,
        },
      ];
    }
    // burst 已下架（放射线是"卡通强调"）：退化为内容左侧一条强调色竖线，克制但仍有"看这里"的作用
    return [
      {
        type: "line",
        x: b.x - 14,
        y: b.y,
        points: [
          [0, 0],
          [0, b.h],
        ],
        strokeColor: T.accent,
        strokeWidth: 2.4,
        roughness: 0,
      },
    ];
  }

  /**
   * 角色已下架（墨纸主题）：简笔小人/小太阳是"低龄感"的主要来源，整块停用。
   * 保留函数壳与接口，避免牵动 snapshot/恢复与公开方法签名。
   */
  async function drawCharacter(pose: CharacterPose = "normal"): Promise<void> {
    // 角色已下架（墨纸主题不做吉祥物）：简笔小人/撒花/闪光都是"低龄感"的来源，整块停用。
    // 函数体保留在下方（永不执行），日后若要回收不必重写。
    return;
    // eslint-disable-next-line no-unreachable
    const cx = mx + MODULE_W - 100;
    const feetY = my + 56; // 页眉强调线：小人的脚、太阳的"地平线"
    const dot = (x: number, y: number, w: number, h: number, color = T.ink) => ({
      type: "ellipse",
      x,
      y,
      width: w,
      height: h,
      backgroundColor: color,
      fillStyle: "solid",
      strokeColor: color,
      strokeWidth: 0.5,
      roughness: 1,
    });
    const sk: any[] = [];
    {
      const wave = moduleIndex % 2 === 0 ? 1 : -1; // 挥手方向逐页换，页面之间像活的一样
      sk.push({
        type: "ellipse",
        x: cx - 14,
        y: feetY - 58,
        width: 28,
        height: 28,
        backgroundColor: "#ffffff",
        fillStyle: "solid",
        strokeColor: T.ink,
        strokeWidth: 1.6,
        roughness: 1,
      });
      sk.push(dot(cx - 7, feetY - 48, 3, 4));
      sk.push(dot(cx + 3, feetY - 48, 3, 4));
      if (pose === "ask") {
        sk.push({
          type: "ellipse",
          x: cx - 4,
          y: feetY - 42,
          width: 8,
          height: 9,
          backgroundColor: "transparent",
          strokeColor: T.ink,
          strokeWidth: 1.3,
          roughness: 1,
        });
      } else {
        const droop = pose === "fail" ? -3 : pose === "celebrate" ? 5 : 3;
        sk.push({
          type: "line",
          x: cx - 5,
          y: feetY - 40 + (pose === "fail" ? 3 : 0),
          points: [[0, 0], [5, droop], [10, 0]],
          strokeColor: T.ink,
          strokeWidth: 1.3,
          roughness: 1,
        });
      }
      sk.push({ type: "line", x: cx, y: feetY - 30, points: [[0, 0], [0, 20]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      if (pose === "ask" || pose === "celebrate") {
        // 提问/庆祝：双手举起来
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [-16, -14]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [16, -14]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      } else if (pose === "fail") {
        // 翻车emo：双手耷拉
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [-13, 4]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [13, 4]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      } else if (pose === "happy") {
        // 开心：单手比耶
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [15, -13]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [-13, 8]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      } else {
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [-15, 10]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
        sk.push({ type: "line", x: cx, y: feetY - 24, points: [[0, 0], [16 * wave, -15]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      }
      sk.push({ type: "line", x: cx, y: feetY - 10, points: [[0, 0], [-9, 10]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      sk.push({ type: "line", x: cx, y: feetY - 10, points: [[0, 0], [9, 10]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
    }
    if (pose === "ask") {
      // 头顶浮一个问号：出题了
      sk.push({
        type: "text",
        x: cx + 24,
        y: my - 4,
        text: "？",
        fontSize: 24,
        fontFamily: 2,
        strokeColor: T.accent,
      });
    }
    if (pose === "celebrate") {
      // 撒花：主题色小纸屑
      const confetti = [
        [cx - 46, my + 4, T.accents[0]],
        [cx + 42, my - 2, T.accents[1] || T.accent],
        [cx - 34, my - 16, T.accents[2] || T.accent],
        [cx + 30, my - 20, T.accents[3] || T.accent],
        [cx - 54, my + 28, T.nodeFills[1] ? T.ink : T.ink],
        [cx + 50, my + 22, T.ink],
      ] as const;
      for (const [fx, fy, fc] of confetti) {
        sk.push({ ...dot(fx, fy, 5, 7, fc), angle: (Math.random() - 0.5) * 0.9 });
      }
    }
    const created = await append(sk);
    charIds = created.map((el: any) => el?.id).filter(Boolean);
  }

  /** 切换角色姿势：擦掉当前页角色按新姿势重画（无页面/无角色时不动） */
  function setCharacterPose(pose: CharacterPose): void {
    if (!moduleUsed || castActive) return;
    eraseCharacter();
    void drawCharacter(pose);
  }

  /** 角色随板书节奏蹦一下：每写完一条内容原地小跳（离散帧，不跑连续动画——大板书逐帧改场景会卡） */
  function characterHop(): void {
    if (turbo || charIds.length === 0) return;
    const api = getApi();
    if (!api) return;
    try {
      const ids = new Set(charIds);
      const base = new Map<string, number>();
      api
        .getSceneElements()
        .filter((el: any) => !el.isDeleted && ids.has(el.id))
        .forEach((el: any) => base.set(el.id, el.y || 0));
      if (base.size === 0) return;
      const steps = [-8, 0, -5, 0];
      let step = 0;
      const tick = () => {
        try {
          const dy = steps[step];
          const cur = api.getSceneElements().filter((el: any) => !el.isDeleted);
          api.updateScene({
            elements: cur.map((el: any) => (base.has(el.id) ? { ...el, y: (base.get(el.id) as number) + dy } : el)),
          });
        } catch {
          // 场景重置时停止
          return;
        }
        step += 1;
        if (step < steps.length) window.setTimeout(tick, 90);
      };
      tick();
    } catch {
      // 场景未就绪时忽略
    }
  }

  /** 擦掉当前页的角色元素（切换角色时用；旧页保留原样，下一页起用新角色） */
  function eraseCharacter(): void {
    if (charIds.length === 0) return;
    const api = getApi();
    if (!api) return;
    const ids = new Set(charIds);
    try {
      api.updateScene({ elements: api.getSceneElements().filter((el: any) => !ids.has(el.id)) });
    } catch {
      // 场景未就绪时忽略
    }
    charIds = [];
  }

  function eraseCast(): void {
    if (castIds.length === 0) return;
    const api = getApi();
    if (!api) return;
    const ids = new Set(castIds);
    try {
      api.updateScene({ elements: api.getSceneElements().filter((el: any) => !ids.has(el.id)) });
    } catch {
      // 场景未就绪时忽略
    }
    castIds = [];
  }

  /**
   * 角色出演：把角色画进场景当当事人（独占一行：动作造型 + 情绪气泡 + 当事人标注）。
   * 出演期间页眉的旁白位下场，removePencil（片段收尾）或翻页时归位。
   */
  async function drawCastItem(item: BoardItem): Promise<void> {
    const action = (item.action || "alert") as NonNullable<BoardItem["action"]>;
    const bx = mx + 48;
    const footY = rowY + 62;
    const sk: any[] = [];
    // 头
    sk.push({
      type: "ellipse",
      x: bx - 12,
      y: footY - 50,
      width: 24,
      height: 24,
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      strokeColor: T.ink,
      strokeWidth: 1.6,
      roughness: 1,
    });
    // 眼睛：fail 眯成 ><，其余豆豆眼
    if (action === "fail") {
      sk.push({ type: "line", x: bx - 7, y: footY - 41, points: [[0, 0], [5, 3]], strokeColor: T.ink, strokeWidth: 1.2, roughness: 1 });
      sk.push({ type: "line", x: bx + 2, y: footY - 38, points: [[0, 0], [5, -3]], strokeColor: T.ink, strokeWidth: 1.2, roughness: 1 });
    } else {
      sk.push({ type: "ellipse", x: bx - 6, y: footY - 42, width: 3, height: 4, backgroundColor: T.ink, fillStyle: "solid", strokeColor: T.ink, strokeWidth: 0.5 });
      sk.push({ type: "ellipse", x: bx + 3, y: footY - 42, width: 3, height: 4, backgroundColor: T.ink, fillStyle: "solid", strokeColor: T.ink, strokeWidth: 0.5 });
    }
    // 嘴：happy 大笑 / fail·alert 惊呼圆嘴 / 其余平嘴
    if (action === "happy") {
      sk.push({ type: "line", x: bx - 5, y: footY - 35, points: [[0, 0], [5, 4], [10, 0]], strokeColor: T.ink, strokeWidth: 1.2, roughness: 1 });
    } else if (action === "fail" || action === "alert") {
      sk.push({ type: "ellipse", x: bx - 3, y: footY - 36, width: 6, height: 8, backgroundColor: "transparent", strokeColor: T.ink, strokeWidth: 1.1, roughness: 1 });
    } else {
      sk.push({ type: "line", x: bx - 4, y: footY - 34, points: [[0, 0], [8, 0]], strokeColor: T.ink, strokeWidth: 1.1, roughness: 1 });
    }
    // 身体
    sk.push({ type: "line", x: bx, y: footY - 26, points: [[0, 0], [0, 18]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
    // 手臂（按动作）
    const arm = (dx: number, dy: number) =>
      sk.push({ type: "line", x: bx, y: footY - 21, points: [[0, 0], [dx, dy]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
    if (action === "alert") {
      arm(-12, -13);
      arm(13, -11);
    } else if (action === "happy") {
      arm(-14, -14);
      arm(14, -14);
    } else if (action === "think") {
      arm(10, -13); // 托腮
      arm(-11, 3);
    } else if (action === "point") {
      arm(19, -4); // 指向板书
      arm(-11, 6);
    } else if (action === "run") {
      arm(-14, -5);
      arm(12, 7);
    } else {
      arm(-11, 5);
      arm(11, 5);
    }
    // 腿
    if (action === "run") {
      sk.push({ type: "line", x: bx, y: footY - 8, points: [[0, 0], [-12, 8]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      sk.push({ type: "line", x: bx, y: footY - 8, points: [[0, 0], [12, 4]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      // 速度线
      sk.push({ type: "line", x: bx - 22, y: footY - 18, points: [[0, 0], [-12, 0]], strokeColor: T.mute, strokeWidth: 1.2, roughness: 1 });
      sk.push({ type: "line", x: bx - 20, y: footY - 10, points: [[0, 0], [-9, 0]], strokeColor: T.mute, strokeWidth: 1.2, roughness: 1 });
    } else {
      sk.push({ type: "line", x: bx, y: footY - 8, points: [[0, 0], [-9, 8]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
      sk.push({ type: "line", x: bx, y: footY - 8, points: [[0, 0], [9, 8]], strokeColor: T.ink, strokeWidth: 1.6, roughness: 1 });
    }
    // 情绪气泡
    const bubble = action === "alert" ? "！" : action === "think" ? "？" : action === "happy" ? "✓" : action === "fail" ? "…" : "";
    if (bubble) {
      sk.push({
        type: "text",
        x: bx + 16,
        y: footY - 76,
        text: bubble,
        fontSize: 20,
        fontFamily: bubble === "✓" ? 2 : 5,
        strokeColor: action === "happy" ? T.semGood : action === "alert" || action === "fail" ? T.semBad : T.accent,
      });
    }
    // 汗滴（吓到/emo）
    if (action === "fail" || action === "alert") {
      sk.push({
        type: "ellipse",
        x: bx + 19,
        y: footY - 56,
        width: 6,
        height: 9,
        backgroundColor: "#7aa7d1",
        fillStyle: "solid",
        strokeColor: "#5b8dbb",
        strokeWidth: 1,
        angle: 0.4,
        roughness: 1,
      });
    }
    const created = await append(sk);
    castIds = created.map((el: any) => el?.id).filter(Boolean);
    castActive = true;
    // 当事人标注（角色旁的小字）
    const caption = (item.text || "").replace(/\s+/g, " ").trim().slice(0, 12);
    if (caption) {
      const cap = await append([
        { type: "text", x: bx + 34, y: footY - 46, text: caption, fontSize: 16, fontFamily: 2, strokeColor: T.ink },
      ]);
      castIds.push(...cap.map((el: any) => el?.id).filter(Boolean));
    }
    lastItemBox = { x: bx - 24, y: rowY, w: 130, h: 70 };
    rowY += 76 + ROW_GAP;
    contentBottom = Math.max(contentBottom, rowY - ROW_GAP);
    growBackdrop();
    await focusWriting();
  }

  function recolorExisting(): void {
    const api = getApi();
    if (!api) return;
    // 每次调用时按"当前风格色板"重建映射（风格可在开讲前被选择器改掉，模块级缓存会过期）
    const { stroke, bg, solidify } = classicRecolorMaps();
    try {
      const els = api
        .getSceneElements()
        .filter((el: any) => !el.isDeleted)
        .map((el: any) => {
          const s = stroke.get(el.strokeColor);
          const b = bg.get(el.backgroundColor);
          // 字体迁移：旧课堂的板书是手写体（family 5），恢复时一并改成无衬线
          const fontFix = el.type === "text" && el.fontFamily === 5 ? 2 : null;
          if (!s && !b && fontFix === null) return el;
          return {
            ...el,
            ...(s ? { strokeColor: s } : null),
            ...(b ? { backgroundColor: b } : null),
            ...(b && solidify.has(el.backgroundColor) ? { fillStyle: "solid" as const } : null),
            ...(fontFix !== null ? { fontFamily: fontFix } : null),
          };
        });
      api.updateScene({ elements: els });
    } catch {
      // 场景未就绪时忽略
    }
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
      // 模块强调色按页轮换（经典主题 accents 只有一颗，等于恒定墨绿）
      T.accent = T.accents[(moduleIndex - 1) % T.accents.length];
      bulletNo = 0;
      currentSection = null;
      lastItemBox = null;
      lastSegmentKey = segmentKey || null;
      castActive = false; // 新页：旁白位重新上场（上一页的出演画面留作那一页的板书）
      const anchorWord = (anchor || "").trim().slice(0, 6);
      const anchorBand = anchorWord ? 66 : 0; // 标题线下方为锚点带让出的高度
      rowY = my + HEADER_H + anchorBand;
      contentBottom = rowY;
      moduleUsed = true;

      // 模块底卡 = 一页白纸：净白 + 一条细边框（直角，去大圆角），先画（z 序在最底），收尾时按内容撑高。
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
          roughness: 0,
          roundness: null,
        },
      ]);
      backdropId = created[0]?.id || null;
      await drawModuleHeader(title, progress);
      // 锚点词：本片段最核心的概念。不做胶囊不做闪光——大号墨字 + 一条强调色短线，像报告里被拎出来的关键词
      if (anchorWord) {
        const capX = mx + Math.floor((MODULE_W - anchorWord.length * 34) / 2);
        await append([
          {
            type: "text",
            x: capX,
            y: my + 66,
            text: anchorWord,
            fontSize: 34,
            fontFamily: 2,
            strokeColor: T.ink,
          },
          {
            type: "line",
            x: capX,
            y: my + 112,
            points: [[0, 0], [anchorWord.length * 34, 0]],
            strokeColor: T.accent,
            strokeWidth: 2,
            roughness: 0,
          },
        ]);
      }
      // 镜头先行：推近新模块标题区，板书随后写进画面
      await focusWriting();
    },

    async drawBattleMap(map: BattleMapData) {
      if (battleMapReady) return; // 同一节课只画一次（恢复路径画面里已含）
      const { elements, width, height, blockBoxes } = buildBattleMapSkeleton(map, START_X, START_Y);
      await append(elements, true);
      battleMapBox = { x: START_X, y: START_Y, w: width, h: height };
      battleBlockBoxes = blockBoxes;
      battleTodayIndex = map.blocks.findIndex((bk) => bk.state === "today");
      battleMapReady = true;
      // 教学模块从战况图右侧起纸：长卷 = 征途计分牌 + 一路板书
      mx = START_X + width + MODULE_X_GAP;
      my = START_Y;
      rowY = my + HEADER_H;
      contentBottom = rowY;
      moduleUsed = false;
      backdropId = null;
      lastItemBox = null;
      currentSection = null;
      // 衔接箭头：征途图 → 第一节课
      await append(
        [
          {
            type: "arrow",
            x: START_X + width + 10,
            y: my + 140,
            points: [
              [0, 0],
              [MODULE_X_GAP - 62, 0],
            ],
            strokeColor: T.faint,
            strokeWidth: 2,
            roughness: 0,
          },
        ],
        true
      );
      await tourBattleMap();
    },

    async crownBlock(index: number) {
      const box = battleBlockBoxes[index];
      if (!box) return;
      const good = T.semGood;
      await append(
        [
          // 盖章：绿色极浅底 + 细边框（直角），不再用大圆徽章
          {
            type: "rectangle",
            x: box.x,
            y: box.y,
            width: box.w,
            height: box.h,
            backgroundColor: `${good}14`,
            fillStyle: "solid",
            strokeColor: good,
            strokeWidth: 1.4,
            roughness: 0,
            roundness: null,
          },
          {
            // 章盖在卡片外侧右方：卡内右上角已有"今日主攻"角标，写进去会叠字
            type: "text",
            x: box.x + box.w + 12,
            y: box.y + 20,
            text: "✓ 这块啃下来了",
            fontSize: 14,
            fontFamily: 2,
            strokeColor: good,
          },
        ],
        true
      );
      // 镜头停在这一块上（可读缩放），让"我又啃下一块"看得清
      await focusBlock(index);
    },

    async write(section, items) {
      const list = (items || []).filter((it) => it && it.kind).slice(0, 6);
      await this.beginBeat(section, list.length);
      for (const item of list) {
        await this.writeItem(item);
      }
    },

    /** 新 beat 开场：模块内换小主题 → 画小节标题（独占整行）。同步节拍下由 pump 在开讲前调用 */
    async beginBeat(section: string | undefined, itemCount: number) {
      const newSection = (section || "").trim();
      // 归一化后再比对：剧本里 "SQL 是什么" 和 "SQL是什么" 这类空格/标点抖动
      // 不该在白板上连写两条一模一样的标题（实测出现过的双写事故）
      if (newSection && normSectionKey(newSection) !== currentSection && itemCount > 0) {
        currentSection = normSectionKey(newSection);
        sections.push(newSection);
        await drawSectionHeading(newSection);
      }
    },

    /** 写一条板书（同步节拍：pump 在对应句子开讲的时刻调用——说到哪句、写哪条） */
    async writeItem(item: BoardItem) {
      if (item.kind === "cast") {
        // 角色出演已下架（墨纸主题不做吉祥物）：直接跳过，不再画小人
        return;
      }
      if (item.kind === "circle" || item.kind === "underline" || item.kind === "burst") {
      await append(emphasizeSkeleton(item.kind));
      await delay(ITEM_DELAY_MS * 0.5);
      characterHop();
      return;
      }

      if (item.kind === "bullet" && item.text) {
        const text = item.text.replace(/\s+/g, " ").trim().slice(0, 30);
        if (!text) return;
        bulletNo += 1;
        const no = bulletNo;
        // 编号列表（编辑体）：序号用强调色小字，正文墨字，行下一条细线——不做色块不做圆徽
        await placeFull(() => ({
          skeleton: [
            {
              type: "text",
              x: mx + 2,
              y: rowY + 4,
              text: String(no).padStart(2, "0"),
              fontSize: 13.5,
              fontFamily: 2,
              strokeColor: T.accent,
            },
            {
              type: "text",
              x: mx + 36,
              y: rowY,
              text,
              fontSize: 17.5,
              fontFamily: 2,
              strokeColor: T.ink,
            },
            {
              type: "line",
              x: mx + 2,
              y: rowY + 36,
              points: [[0, 0], [CONTENT_W - 4, 0]],
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
            },
          ],
          h: 40,
          emBox: { x: mx, y: rowY, w: CONTENT_W, h: 38 },
        }));
      } else if (item.kind === "note" && item.text) {
        const text = item.text.replace(/\s+/g, " ").trim().slice(0, 24);
        if (!text) return;
        await placeFull(() => ({
          skeleton: [
            {
              type: "text",
              x: mx + 42,
              y: rowY + 3,
              text: `— ${text}`,
              fontSize: 14,
              fontFamily: 2,
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
        // ✓/✗ 判断行：语义色只落在勾/叉那一个字符上，正文墨色，行下细线——不做底色、不做圆徽
        const good = item.verdict !== "bad";
        const text = item.text.replace(/\s+/g, " ").trim().slice(0, 24);
        if (!text) return;
        await placeFull(() => {
          const boxW = Math.min(CONTENT_W, 46 + Math.round(text.length * 16.5));
          return {
            skeleton: [
              {
                type: "text",
                x: mx + 2,
                y: rowY + 2,
                text: good ? "✓" : "✗",
                fontSize: 17,
                fontFamily: 2,
                strokeColor: good ? T.semGood : T.semBad,
              },
              {
                type: "text",
                x: mx + 30,
                y: rowY,
                text,
                fontSize: 16.5,
                fontFamily: 2,
                strokeColor: T.ink,
              },
              {
                type: "line",
                x: mx + 2,
                y: rowY + 36,
                points: [[0, 0], [boxW - 4, 0]],
                strokeColor: T.tableRowStroke,
                strokeWidth: 1,
                roughness: 0,
              },
            ],
            h: 40,
            emBox: { x: mx, y: rowY, w: boxW, h: 38 },
          };
        });
      } else if (item.kind === "subtitle" && item.text) {
        const text = item.text.replace(/\s+/g, " ").trim().slice(0, 14);
        if (!text) return;
        await drawSectionHeading(text);
      } else if (item.kind === "diagram" && item.nodes && item.nodes.length >= 2) {
        // 横向流程图：2-4 个节点盒子 + 衔接箭头（讲流程/数据流/架构）
        const nodes = item.nodes.slice(0, 4).map((n) => (n || "").trim().slice(0, 6)).filter(Boolean);
        if (nodes.length < 2) return;
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
              backgroundColor: T.nodeFills[ni % T.nodeFills.length],
              fillStyle: "solid",
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            });
            sk.push({
              type: "text",
              x: nx + Math.max(4, (boxW - nodes[ni].length * 15) / 2),
              y: rowY + 6 + 20,
              text: nodes[ni],
              fontSize: 15,
              fontFamily: 2,
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
                roughness: 0,
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
          // 淡色表头带 + 行/列细线 + 直角外框（编辑体表格），不画满格线
          const sk: any[] = [
            {
              type: "rectangle",
              x: mx,
              y: rowY,
              width: CONTENT_W,
              height: headH + rows.length * rowH,
              backgroundColor: "transparent",
              strokeColor: T.tableHeadStroke,
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            },
            {
              type: "rectangle",
              x: mx,
              y: rowY,
              width: CONTENT_W,
              height: headH,
              backgroundColor: T.tableHeadBg,
              fillStyle: "solid",
              strokeColor: "transparent",
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            },
          ];
          for (let ci = 0; ci < cols; ci++) {
            sk.push({
              type: "text",
              x: mx + ci * cellW + 12,
              y: rowY + 11,
              text: (item.headers?.[ci] || "").slice(0, 8),
              fontSize: 15,
              fontFamily: 2,
              strokeColor: T.ink,
            });
          }
          for (let r = 1; r < rows.length; r++) {
            sk.push({
              type: "line",
              x: mx + 1,
              y: rowY + headH + r * rowH,
              points: [[0, 0], [CONTENT_W - 2, 0]],
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
            });
          }
          for (let ci = 1; ci < cols; ci++) {
            sk.push({
              type: "line",
              x: mx + ci * cellW,
              y: rowY + headH + 2,
              points: [[0, 0], [0, rows.length * rowH - 4]],
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
            });
          }
          let ty = rowY + headH;
          for (const row of rows) {
            for (let ci = 0; ci < cols; ci++) {
              sk.push({
                type: "text",
                x: mx + ci * cellW + 12,
                y: ty + 10,
                text: (row?.[ci] || "").slice(0, 8),
                fontSize: 13,
                fontFamily: 2,
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
            { type: "line", x: mx, y: baseY, points: [[0, 0], [0, -chh]], strokeColor: T.chartAxis, strokeWidth: 1.2, roughness: 0 },
            { type: "line", x: mx, y: baseY, points: [[0, 0], [cw + 12, 0]], strokeColor: T.chartAxis, strokeWidth: 1.2, roughness: 0 },
          ];
          const pts: number[][] = vals.map((v, i) => [
            Math.round((cw / (vals.length - 1)) * i),
            Math.round(-10 - ((v - minV) / (maxV - minV || 1)) * (chh - 26)),
          ]);
          sk.push({ type: "line", x: mx, y: baseY, points: pts, strokeColor: T.accent, strokeWidth: 2.5, roughness: 0 });
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
              roughness: 0,
            });
            sk.push({
              type: "text",
              x: mx + pts[pi][0] - 8,
              y: baseY + pts[pi][1] - 26,
              text: String(vals[pi]),
              fontSize: 12,
              fontFamily: 2,
              strokeColor: T.diagramStroke,
            });
          }
          return { skeleton: sk, h: chh + 14 };
        });
      } else if (item.kind === "vs" && (item.text || "").includes("|")) {
        // 左右对比栏：两块半行卡 + 中央 vs 圆徽
        const [l, r] = (item.text || "").split("|").map((s) => s.trim().slice(0, 10));
        if (!l && !r) return;
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
              backgroundColor: T.nodeFills[0],
              fillStyle: "solid",
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            },
            {
              type: "text",
              x: mx + (halfW - (l || "A").length * 17) / 2,
              y: rowY + 16,
              text: l || "A",
              fontSize: 17,
              fontFamily: 2,
              strokeColor: T.ink,
            },
            {
              type: "rectangle",
              x: mx + halfW + 76,
              y: rowY,
              width: halfW,
              height: boxH,
              backgroundColor: T.nodeFills[1],
              fillStyle: "solid",
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            },
            {
              type: "text",
              x: mx + halfW + 76 + (halfW - (r || "B").length * 17) / 2,
              y: rowY + 16,
              text: r || "B",
              fontSize: 17,
              fontFamily: 2,
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
              roughness: 0,
            },
            {
              type: "text",
              x: mx + halfW + 26,
              y: rowY + 21,
              text: "vs",
              fontSize: 13,
              fontFamily: 2,
              strokeColor: T.vsText,
            },
          ];
          return { skeleton: sk, h: boxH + 8 };
        });
      } else if (item.kind === "tree" && item.nodes && item.nodes.length >= 2) {
        // 一层分支树：父概念在上，2-3 个子概念在下（讲分类/组成/派生）
        const nodes = item.nodes.slice(0, 3).map((n) => (n || "").trim().slice(0, 7)).filter(Boolean);
        if (nodes.length < 2) return;
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
              backgroundColor: T.nodeFills[0],
              fillStyle: "solid",
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            },
            {
              type: "text",
              x: parentX + Math.max(4, (parentW - nodes[0].length * 16) / 2),
              y: rowY + 9,
              text: nodes[0],
              fontSize: 16,
              fontFamily: 2,
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
              roughness: 0,
            });
            sk.push({
              type: "rectangle",
              x: cx,
              y: childY,
              width: childW,
              height: 42,
              backgroundColor: T.nodeFills[ci % T.nodeFills.length],
              fillStyle: "solid",
              strokeColor: T.tableRowStroke,
              strokeWidth: 1,
              roughness: 0,
              roundness: null,
            });
            sk.push({
              type: "text",
              x: cx + Math.max(3, (childW - nodes[ci].length * 15) / 2),
              y: childY + 11,
              text: nodes[ci],
              fontSize: 15,
              fontFamily: 2,
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
            // 警示：一个语义色叹号字符（不再是手绘竖线+圆点）
            await append([{ type: "text", x: mxp, y: myp - 4, text: "!", fontSize: 20, fontFamily: 2, strokeColor: T.semBad }]);
          } else if (item.style === "question") {
            await append([{ type: "text", x: mxp, y: myp - 4, text: "?", fontSize: 20, fontFamily: 2, strokeColor: T.mute }]);
          } else {
            // star 已下架（四芒星太卡通）：退化为行前一个小强调方块，保留"这条要留意"的信息
            await append([
              {
                type: "rectangle",
                x: mxp,
                y: myp + 6,
                width: 8,
                height: 8,
                backgroundColor: T.accent,
                fillStyle: "solid",
                strokeColor: "transparent",
                strokeWidth: 0,
                roughness: 0,
              },
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
        // 金句（片段收尾用）：粉彩圆角卡 + 左强调条
        const q = item.text.replace(/\s+/g, " ").trim().slice(0, 18);
        if (!q) return;
        await placeFull(() => {
          return {
            skeleton: [
              // 金句（编辑体 pull-quote）：一条强调色竖线 + 大号墨字，不做底色不做闪光
              {
                type: "rectangle",
                x: mx + 2,
                y: rowY + 6,
                width: 3,
                height: 46,
                backgroundColor: T.accent,
                fillStyle: "solid",
                strokeColor: "transparent",
                strokeWidth: 0,
                roughness: 0,
              },
              {
                type: "text",
                x: mx + 24,
                y: rowY + 10,
                text: q,
                fontSize: 20,
                fontFamily: 2,
                strokeColor: T.ink,
              },
            ],
            h: 62,
            emBox: { x: mx, y: rowY, w: CONTENT_W, h: 58 },
          };
        });
      }

      await delay(ITEM_DELAY_MS);
      characterHop();
    },

    outline() {
      return [...sections];
    },

    hitTest(x: number, y: number): string | null {
      // 命中 4px 容差；后写的优先（同域重叠时点到的多半是上面那条）
      const pad = 4;
      for (let i = hitBoxes.length - 1; i >= 0; i--) {
        const b = hitBoxes[i];
        if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) {
          return b.text;
        }
      }
      return null;
    },

    /** 当前行指示：刚写完的那条板书左侧立一条强调色细竖标（数组序=渲染序，插在文字下层），
     *  讲完这句先减淡再擦除。替代原来的黄色荧光笔——去掉手账感，保留"正在讲这条"的锚点。
     *  turbo（回放重建）不需要——瞬间到位的画面没有"正在讲"的此刻。 */
    highlightLast() {
      if (turbo || !lastItemBox) return;
      const api = getApi();
      if (!api) return;
      const b = lastItemBox;
      try {
        const el = {
          id: `${HL_ID_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
          type: "rectangle",
          x: b.x - 12,
          y: b.y,
          width: 3,
          height: b.h,
          angle: 0,
          strokeColor: "transparent",
          backgroundColor: T.accent,
          fillStyle: "solid",
          strokeWidth: 0,
          strokeStyle: "solid",
          roughness: 0,
          opacity: 90,
          groupIds: [],
          frameId: null,
          roundness: { type: 3 },
          seed: Math.floor(Math.random() * 1e6),
          version: 1,
          versionNonce: Math.floor(Math.random() * 1e6),
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
        };
        const cur = api
          .getSceneElements()
          .filter((e: any) => !e.isDeleted && !String(e.id).startsWith(HL_ID_PREFIX));
        const bi = backdropId ? cur.findIndex((e: any) => e.id === backdropId) : -1;
        const at = bi >= 0 ? bi + 1 : 0;
        api.updateScene({ elements: [...cur.slice(0, at), el, ...cur.slice(at)] });
        window.setTimeout(() => {
          try {
            const live = getApi();
            if (!live) return;
            live.updateScene({
              elements: live.getSceneElements().map((e: any) =>
                e.id === el.id ? { ...e, opacity: 14 } : e
              ),
            });
          } catch {
            // 场景重置时忽略
          }
        }, HL_MS - 1500);
        window.setTimeout(() => {
          try {
            const live = getApi();
            if (!live) return;
            live.updateScene({
              elements: live.getSceneElements().filter((e: any) => e.id !== el.id),
            });
          } catch {
            // 场景重置时忽略
          }
        }, HL_MS);
      } catch {
        // 白板未就绪时忽略
      }
    },

    removePencil,

    focusCurrent() {
      void focusWriting();
    },

    focusBattleMap() {
      void tourBattleMap();
    },

    setTurbo(on: boolean) {
      turbo = on;
    },

    recolor: recolorExisting,

    characterAsk(on: boolean) {
      setCharacterPose(on ? "ask" : "normal");
    },

    characterCelebrate() {
      setCharacterPose("celebrate");
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
        battleMapBox,
        battleBlockBoxes,
        battleMapReady,
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
      currentSection = s.currentSection ? normSectionKey(String(s.currentSection)) : null;
      sections.length = 0;
      if (Array.isArray(s.sections)) sections.push(...s.sections);
      lastItemBox = s.lastItemBox || null;
      backdropId = typeof s.backdropId === "string" ? s.backdropId : null;
      lastSegmentKey = typeof s.lastSegmentKey === "string" ? s.lastSegmentKey : null;
      battleMapBox = s.battleMapBox || null;
      battleBlockBoxes = Array.isArray(s.battleBlockBoxes) ? s.battleBlockBoxes : [];
      battleMapReady = Boolean(s.battleMapReady && battleMapBox);
    },
  };
}
