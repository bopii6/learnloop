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
