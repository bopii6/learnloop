// 知识海报导出：把白板终态渲染成一张竖版分享长图（标题 + 板书 + 品牌水印）。
// 纯客户端：Excalidraw exportToBlob 出板书位图 → 2D canvas 排版合成海报。
// 复用 @napi-rs/canvas 的服务端渲染没有必要——课堂场景里板书本来就在浏览器里。

const PAPER = "#fafaf7";
const INK = "#1a1a18";
const INK_SOFT = "#5f5e5a";
const INK_FAINT = "#a3a19a";
const ACCENT = "#0f6e56";
const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Segoe UI", sans-serif';

export interface PosterOptions {
  api: any; // Excalidraw API（getSceneElements）
  courseTitle: string;
  lectureTitle: string;
  studentName?: string;
}

/** 逐字换行：中文按字符断行，长词组也能排 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) {
        // 最后一行留省略号
        let last = lines[maxLines - 1];
        while (ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last + "…";
        return lines;
      }
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 收集白板上非镜头锚点的可见元素 */
export function getBoardElements(api: any): any[] {
  return (api?.getSceneElements?.() || []).filter(
    (el: any) => !el.isDeleted && el.id !== "camera-anchor" && el.id !== "pencil-cursor"
  );
}

/** 生成海报 PNG Blob。板书为空时抛错。 */
export async function exportBoardPoster(opts: PosterOptions): Promise<{ blob: Blob; width: number; height: number }> {
  const { api, courseTitle, lectureTitle, studentName } = opts;
  const elements = getBoardElements(api);
  if (elements.length === 0) {
    throw new Error("白板还没有内容，讲师写点东西再生成海报");
  }

  const { exportToBlob } = await import("@excalidraw/excalidraw");
  const BOARD_W = 1020;
  const boardBlob = await exportToBlob({
    elements,
    appState: {
      exportBackground: true,
      viewBackgroundColor: "#ffffff",
      exportWithDarkMode: false,
    },
    exportPadding: 24,
    mimeType: "image/png",
    getDimensions: (w: number, h: number) => ({
      width: BOARD_W,
      height: Math.max(200, Math.round((h * BOARD_W) / w)),
      scale: 1,
    }),
  });
  const board = await createImageBitmap(boardBlob);

  // ---- 海报排版 ----
  const W = 1080;
  const MARGIN = 44;
  const probe = document.createElement("canvas").getContext("2d")!;

  // 头部高度按标题实际行数算
  probe.font = `700 46px ${FONT_STACK}`;
  const titleLines = wrapText(probe, lectureTitle, W - MARGIN * 2 - 8, 2);
  probe.font = `400 23px ${FONT_STACK}`;
  const courseLines = wrapText(probe, courseTitle, W - MARGIN * 2 - 8, 1);
  const headerH = 96 + titleLines.length * 60 + courseLines.length * 34 + 8;
  const boardH = Math.round((board.height * (W - MARGIN * 2)) / board.width);
  const footerH = 132;
  const H = Math.min(8200, headerH + boardH + footerH);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // 纸面 + 点阵（与产品白板同款质感）
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(93, 202, 165, 0.22)";
  for (let y = 16; y < H; y += 24) {
    for (let x = 16; x < W; x += 24) {
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 顶部品牌行
  let y = 64;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(MARGIN, y - 22, 30, 30, 9);
  ctx.fill();
  ctx.font = `700 21px ${FONT_STACK}`;
  ctx.fillStyle = ACCENT;
  ctx.fillText("L", MARGIN + 9, y);
  ctx.font = `600 21px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  ctx.fillText("LearnLoop · 知识海报", MARGIN + 42, y);

  // 课程归属（小字）
  y += 12;
  ctx.font = `400 23px ${FONT_STACK}`;
  ctx.fillStyle = INK_SOFT;
  if (courseLines[0]) ctx.fillText(courseLines[0], MARGIN, y + 20);

  // 大标题
  y += 40;
  ctx.font = `700 46px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  for (const line of titleLines) {
    y += 60;
    ctx.fillText(line, MARGIN, y - 14);
  }

  // 板书画布（白底圆角卡 + 描边）
  y += 24;
  const bx = MARGIN;
  const bw = W - MARGIN * 2;
  const bh = Math.min(boardH, H - y - footerH);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, y, bw, bh, 20);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#e7e5dc";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.clip();
  // contain：板书太宽高时按高度缩放居中
  const scale = Math.min(bw / board.width, bh / board.height);
  const dw = board.width * scale;
  const dh = board.height * scale;
  ctx.drawImage(board, bx + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh);
  ctx.restore();

  // 底部信息
  const fy = H - footerH + 56;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(MARGIN, fy - 26, 6, 44, 3);
  ctx.fill();
  ctx.font = `600 24px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  const who = studentName ? `${studentName} 的 AI 白板课堂` : "AI 讲师边讲边画的一节课";
  ctx.fillText(who, MARGIN + 20, fy);
  ctx.font = `400 19px ${FONT_STACK}`;
  ctx.fillStyle = INK_FAINT;
  const date = new Date();
  ctx.fillText(
    `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 用 LearnLoop 生成`,
    MARGIN + 20,
    fy + 36
  );

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("海报渲染失败");
  return { blob, width: W, height: H };
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 复制图片到剪贴板（不支持时返回 false，调用方退回下载） */
export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (!("clipboard" in navigator) || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** 安全文件名 */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "learnloop";
}

// ---- 讲义式知识海报：从讲师剧本（片段+板书要点）排版，信息量优先于白板截图 ----

export interface PosterSegment {
  title: string;
  beats: { say: string; items?: BoardItemLike[] }[];
}

export interface BoardItemLike {
  kind?: string;
  text?: string;
  values?: number[];
  verdict?: "good" | "bad";
  style?: string;
  headers?: string[];
  rows?: string[][];
  nodes?: string[];
}

interface SegmentCard {
  title: string;
  color: string;
  points: string[];
  diagram: string[] | null;
  table: { headers: string[]; rows: string[][] } | null;
  quote: string | null;
}

/** 从剧本抽取每个片段的海报素材 */
function extractCards(segments: PosterSegment[]): SegmentCard[] {
  return segments.map((seg, i) => {
    const points: string[] = [];
    let diagram: string[] | null = null;
    let table: SegmentCard["table"] = null;
    for (const b of seg.beats) {
      for (const it of b.items || []) {
        if ((it.kind === "subtitle" || it.kind === "bullet") && it.text && points.length < 3) {
          points.push(it.text);
        } else if (it.kind === "diagram" && it.nodes?.length && !diagram) {
          diagram = it.nodes.slice(0, 4);
        } else if (it.kind === "tree" && it.nodes?.length && !diagram) {
          diagram = it.nodes.slice(0, 3);
        } else if (it.kind === "table" && it.headers && !table) {
          table = { headers: it.headers.slice(0, 3), rows: (it.rows || []).slice(0, 2).map((r) => r.slice(0, 3)) };
        } else if (it.kind === "quote" && it.text && points.length < 3) {
          points.push(it.text);
        }
      }
    }
    // 金句：本段最后一句讲解词，截短
    const lastSay = seg.beats[seg.beats.length - 1]?.say || "";
    const quote = lastSay ? lastSay.slice(0, 46) + (lastSay.length > 46 ? "…" : "") : null;
    return {
      title: seg.title.slice(0, 14),
      color: ACCENT,
      points,
      diagram,
      table,
      quote,
    };
  });
}

/** 讲义式知识海报：片段卡片（要点 + 迷你流程图/表格 + 讲师金句） */
export async function exportScriptPoster(opts: {
  segments: PosterSegment[];
  courseTitle: string;
  lectureTitle: string;
  studentName?: string;
}): Promise<{ blob: Blob; width: number; height: number }> {
  const { segments, courseTitle, lectureTitle, studentName } = opts;
  if (!segments.length) throw new Error("讲师还没开讲，讲义还是空的");
  const cards = extractCards(segments);

  const W = 1080;
  const M = 56;
  const CARD_INNER = 34;

  const measure = document.createElement("canvas").getContext("2d")!;
  const wrapLines = (text: string, font: string, maxWidth: number): number => {
    measure.font = font;
    let lines = 1;
    let line = "";
    for (const ch of text) {
      if (measure.measureText(line + ch).width > maxWidth && line) {
        lines += 1;
        line = ch;
      } else {
        line += ch;
      }
    }
    return lines;
  };

  // ---- 先量高度 ----
  const CARD_W = W - M * 2;
  const CONTENT_W = CARD_W - CARD_INNER * 2 - 20; // 左侧色条 20
  const TITLE_FONT = `700 46px ${FONT_STACK}`;
  const titleLines = wrapLines(lectureTitle, TITLE_FONT, W - M * 2);

  const headerH = 96; // 品牌行 + 课程名
  const titleH = 36 + titleLines * 58;
  const hookText = segments[0]?.beats?.[0]?.say?.slice(0, 44) || "";
  const hookH = hookText ? 66 : 0;

  const cardHeights = cards.map((c) => {
    let h = CARD_INNER + 40; // 段标题
    h += c.points.length * 38 + (c.points.length ? 8 : 0);
    if (c.diagram && c.diagram.length >= 2) h += 66 + 16;
    if (c.table) h += 44 * (c.table.rows.length + 1) + 24;
    if (c.quote) h += wrapLines(c.quote, `400 22px ${FONT_STACK}`, CONTENT_W - 36) * 32 + 46;
    h += CARD_INNER;
    return h;
  });  const GAP = 26;
  const cardsH = cardHeights.reduce((s, h) => s + h + GAP, 0);
  const footerH = 150;
  const H = Math.min(12000, Math.round(headerH + titleH + hookH + 24 + cardsH + footerH));

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // 纸面 + 点阵
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(93, 202, 165, 0.20)";
  for (let y = 16; y < H; y += 24) {
    for (let x = 16; x < W; x += 24) {
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- 头部 ----
  let y = 66;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(M, y - 22, 30, 30, 9);
  ctx.fill();
  ctx.font = `700 21px ${FONT_STACK}`;
  ctx.fillStyle = "#fff";
  ctx.fillText("L", M + 9, y);
  ctx.font = `600 21px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  ctx.fillText("LearnLoop · 知识海报", M + 42, y);

  // 课程名
  y += 40;
  ctx.font = `400 22px ${FONT_STACK}`;
  ctx.fillStyle = INK_SOFT;
  const courseLine = courseTitle.length > 40 ? courseTitle.slice(0, 40) + "…" : courseTitle;
  ctx.fillText(courseLine, M, y);

  // 大标题
  ctx.font = TITLE_FONT;
  ctx.fillStyle = INK;
  {
    // 按行绘制大标题（与量高时的行数一致）
    const lines: string[] = [];
    let line = "";
    for (const ch of lectureTitle) {
      if (ctx.measureText(line + ch).width > W - M * 2 && line) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      y += 58;
      ctx.fillText(lines[i], M, y - 8);
    }
  }

  // 开场钩子
  if (hookText) {
    y += 48;
    ctx.fillStyle = "rgba(15,110,86,.07)";
    ctx.beginPath();
    ctx.roundRect(M, y - 24, W - M * 2, 44, 12);
    ctx.fill();
    ctx.font = `400 21px ${FONT_STACK}`;
    ctx.fillStyle = ACCENT;
    ctx.fillText(`「${hookText}${segments[0].beats[0].say.length > 44 ? "…" : ""}」`, M + 16, y + 6);
    y += 20;
  }

  // ---- 片段卡片 ----
  y += 24;
  cards.forEach((c, ci) => {
    const ch = cardHeights[ci];
    // 卡片底
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(M, y, CARD_W, ch, 20);
    ctx.fill();
    ctx.strokeStyle = "#e7e5dc";
    ctx.lineWidth = 2;
    ctx.stroke();
    // 左色条
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.roundRect(M, y, 8, ch, 4);
    ctx.fill();

    let cy = y + CARD_INNER + 8;
    const tx = M + CARD_INNER + 20;

    // 段序号 + 标题
    ctx.font = `700 15px ${FONT_STACK}`;
    ctx.fillStyle = c.color;
    const noText = String(ci + 1).padStart(2, "0");
    ctx.fillText(noText, tx, cy);
    ctx.font = `700 27px ${FONT_STACK}`;
    ctx.fillStyle = INK;
    ctx.fillText(c.title, tx + 34, cy);
    cy += 40;

    // 要点
    ctx.font = `500 20px ${FONT_STACK}`;
    for (const p of c.points) {
      ctx.fillStyle = c.color;
      ctx.fillText("·", tx + 2, cy);
      ctx.fillStyle = "#2b2a27";
      const shown = p.length > 22 ? p.slice(0, 22) : p;
      ctx.fillText(shown, tx + 20, cy);
      cy += 38;
    }
    if (c.points.length) cy += 6;

    // 迷你流程图
    if (c.diagram && c.diagram.length >= 2) {
      const n = Math.min(4, c.diagram.length);
      const gap = 18;
      const bw = Math.floor((CONTENT_W - 30 - (n - 1) * gap) / n);
      const by = cy;
      for (let i = 0; i < n; i++) {
        const bx = tx + 4 + i * (bw + gap);
        ctx.fillStyle = c.color + "12";
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, 40, 9);
        ctx.fill();
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.font = `500 15px ${FONT_STACK}`;
        ctx.fillStyle = "#2b2a27";
        const label = c.diagram[i].slice(0, 5);
        const tw = ctx.measureText(label).width;
        ctx.fillText(label, bx + (bw - tw) / 2, by + 26);
        if (i < n - 1) {
          ctx.fillStyle = "#b4b2a9";
          const ax = bx + bw + 3;
          ctx.beginPath();
          ctx.moveTo(ax, by + 14);
          ctx.lineTo(ax + 10, by + 20);
          ctx.lineTo(ax, by + 26);
          ctx.closePath();
          ctx.fill();
        }
      }
      cy += 66 + 16;
    }

    // 迷你表格
    if (c.table) {
      const cols = c.table.headers.length;
      const cw2 = Math.floor((CONTENT_W - 30) / cols);
      let ty = cy;
      for (let ri = 0; ri <= c.table.rows.length; ri++) {
        for (let ci2 = 0; ci2 < cols; ci2++) {
          const cellX = tx + 4 + ci2 * cw2;
          const isHead = ri === 0;
          ctx.fillStyle = isHead ? c.color + "14" : "#fafaf7";
          ctx.beginPath();
          ctx.roundRect(cellX, ty, cw2 - 4, 38, 6);
          ctx.fill();
          ctx.font = `${isHead ? "700" : "400"} 15px ${FONT_STACK}`;
          ctx.fillStyle = isHead ? c.color : "#5f5e5a";
          const cellText = (isHead ? c.table.headers[ci2] : c.table.rows[ri - 1]?.[ci2] || "").slice(0, 6);
          ctx.fillText(cellText, cellX + 10, ty + 25);
        }
        ty += 44;
      }
      cy = ty + 8;
    }

    // 讲师金句
    if (c.quote) {
      const qLines = wrapLines(c.quote, `400 22px ${FONT_STACK}`, CONTENT_W - 36);
      const qh = qLines * 32 + 22;
      ctx.fillStyle = "#faf8f0";
      ctx.beginPath();
      ctx.roundRect(tx + 4, cy, CONTENT_W - 30, qh, 12);
      ctx.fill();
      ctx.strokeStyle = "#f0d98c";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.font = `400 22px ${FONT_STACK}`;
      ctx.fillStyle = "#8a6d1f";
      const lines2: string[] = [];
      let line = "";
      for (const chr of c.quote) {
        if (ctx.measureText(line + chr).width > CONTENT_W - 66 && line) {
          lines2.push(line);
          line = chr;
        } else {
          line += chr;
        }
      }
      if (line) lines2.push(line);
      lines2.forEach((l2, i2) => {
        const prefix = i2 === 0 ? "「" : "";
        const suffix = i2 === lines2.length - 1 ? "」" : "";
        ctx.fillText(`${prefix}${l2}${suffix}`, tx + 24, cy + 34 + i2 * 32);
      });
      cy += qh;
    }

    // 推进到下一张卡片的位置
    y += ch + GAP;
  });

  // ---- 底部 ----
  const fy = H - footerH + 62;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(M, fy - 26, 6, 44, 3);
  ctx.fill();
  ctx.font = `600 24px ${FONT_STACK}`;
  ctx.fillStyle = INK;
  const who = studentName ? `${studentName} 的 AI 白板课堂` : "AI 讲师边讲边画的一节课";
  ctx.fillText(who, M + 20, fy);
  ctx.font = `400 19px ${FONT_STACK}`;
  ctx.fillStyle = INK_FAINT;
  const d = new Date();
  ctx.fillText(
    `${cards.length} 个片段 · ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 用 LearnLoop 生成`,
    M + 20,
    fy + 36
  );

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("海报渲染失败");
  return { blob, width: W, height: H };
}
