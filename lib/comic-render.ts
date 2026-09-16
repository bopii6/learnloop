// 连环画渲染器（整洁卡通风）：结构化场景图 → Excalidraw 元素骨架。
// 风格契约：roughness=0（工整线条，不要潦草感）、统一 2px 线宽、平涂色块、大头萌脸角色、
// 文字用系统无衬线（fontFamily 2）保证清晰。确定性绘制：零图费、零等待、跨格 100% 一致。
import type { ComicScenePanel, SceneActor, SceneProp } from "@/lib/agent/comic";

export const PANEL_W = 980;
export const PANEL_H = 620;
export const PANEL_GAP = 80;

const INK = "#27272A";
const TEAL = "#4FB3B3";
const YELLOW = "#F5C242";
const RED = "#E2574C";
const GRAY = "#DCDCDC";
const DARK = "#2F3640";
const NIGHT = "#E7ECF4";
const ROOM = "#F7F2E7";
const FACTORY = "#EAF0E6";
const SKIN = "#FFE3C9";
const BG_COLOR: Record<ComicScenePanel["bg"], string> = { plain: "#FFFFFF", night: "#E7ECF4", room: "#F7F2E7", factory: "#EAF0E6" };
const CLEAN = { roughness: 0 };

type Skeleton = Record<string, unknown>;

function rect(x: number, y: number, w: number, h: number, o: { stroke?: string; fill?: string; width?: number; round?: boolean } = {}): Skeleton {
  return {
    type: "rectangle", x, y, width: w, height: h,
    strokeColor: o.stroke ?? INK, backgroundColor: o.fill ?? "transparent", fillStyle: "solid",
    strokeWidth: o.width ?? 2, roundness: o.round === false ? null : { type: 3 }, ...CLEAN,
  };
}
function ellipse(x: number, y: number, w: number, h: number, o: { stroke?: string; fill?: string; width?: number } = {}): Skeleton {
  return {
    type: "ellipse", x, y, width: w, height: h,
    strokeColor: o.stroke ?? INK, backgroundColor: o.fill ?? "transparent", fillStyle: "solid",
    strokeWidth: o.width ?? 2, ...CLEAN,
  };
}
function line(points: number[][], o: { stroke?: string; width?: number } = {}): Skeleton {
  return {
    type: "line", x: points[0][0], y: points[0][1],
    points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]]),
    strokeColor: o.stroke ?? INK, strokeWidth: o.width ?? 2, strokeLinecap: "round", strokeLinejoin: "round", ...CLEAN,
  };
}
function arrow(points: number[][], o: { stroke?: string; width?: number } = {}): Skeleton {
  return {
    type: "arrow", x: points[0][0], y: points[0][1],
    points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]]),
    strokeColor: o.stroke ?? INK, strokeWidth: o.width ?? 2, strokeLinecap: "round", strokeLinejoin: "round", ...CLEAN,
  };
}
function txt(x: number, y: number, text: string, fontSize: number, o: { stroke?: string; angle?: number; centerW?: number } = {}): Skeleton {
  return {
    type: "text", x, y, text, fontSize, strokeColor: o.stroke ?? INK,
    angle: o.angle ?? 0, fontFamily: 2, ...CLEAN,
  };
}
function wrap(text: string, per: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if (cur.length >= per) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- 角色（大头萌脸：头占一半身高，色块平涂，工整无草稿线） ----------
function drawFigure(who: "teacher" | "student", pose: SceneActor["pose"], emotion: SceneActor["emotion"], cx: number, cy: number): Skeleton[] {
  // cy = 脚底。身高 ≈ 205：头 96 + 身体 72 + 腿 32（学生整体 0.74 倍）
  const s = who === "teacher" ? 1 : 0.74;
  const els: Skeleton[] = [];
  const headD = 96 * s;
  const headY = cy - 196 * s; // 头顶
  const bodyTop = cy - 100 * s;
  const shirt = who === "teacher" ? DARK : "#FFFFFF";
  // 腿
  els.push(rect(cx - 24 * s, cy - 34 * s, 16 * s, 34 * s, { fill: "#3B4351", width: 2 }));
  els.push(rect(cx + 8 * s, cy - 34 * s, 16 * s, 34 * s, { fill: "#3B4351", width: 2 }));
  els.push(rect(cx - 28 * s, cy - 8 * s, 24 * s, 10 * s, { fill: INK, stroke: INK })); // 鞋
  els.push(rect(cx + 4 * s, cy - 8 * s, 24 * s, 10 * s, { fill: INK, stroke: INK }));
  // 手臂（圆角长条，pose 转角度）
  const armW = 13 * s, armH = 54 * s, shoulderY = bodyTop + 8 * s;
  const armL = rect(cx - 40 * s, shoulderY, armW, armH, { fill: shirt, width: 2 });
  const armR = rect(cx + 28 * s, shoulderY, armW, armH, { fill: shirt, width: 2 });
  if (pose === "point") { (armR as any).angle = -1.0; (armR as any).y = shoulderY - 18 * s; }
  if (pose === "cheer") { (armL as any).angle = 0.7; (armL as any).y = shoulderY - 26 * s; (armR as any).angle = -0.7; (armR as any).y = shoulderY - 26 * s; }
  if (pose === "shock") { (armL as any).angle = 0.35; (armR as any).angle = -0.35; }
  if (pose === "think") { (armR as any).angle = -1.5; (armR as any).x = cx + 20 * s; (armR as any).y = bodyTop - 6 * s; }
  // 身体
  els.push(rect(cx - 38 * s, bodyTop, 76 * s, 68 * s, { fill: shirt, width: 2 }));
  els.push(armL, armR);
  // 学生书包（背在侧后，先画不被身体盖住）
  if (who === "student") {
    els.push(rect(cx + 26 * s, bodyTop + 6 * s, 30 * s, 44 * s, { fill: "#F09A3E", width: 2 }));
  }
  // 头（大头：先头发后脸，形成发际线）
  const faceY = headY + 12 * s;
  els.push(ellipse(cx - headD / 2 - 2 * s, headY, headD + 4 * s, headD * 0.72, { fill: who === "teacher" ? "#2B2B2B" : "#4A3626", stroke: who === "teacher" ? "#2B2B2B" : "#4A3626" }));
  els.push(ellipse(cx - headD / 2, faceY, headD, headD * 0.94, { fill: SKIN, width: 2 }));
  // 眼睛（kawaii 大眼 + 高光）
  const eyeY = faceY + headD * 0.34;
  const eyeD = 22 * s;
  if (emotion === "excited" || emotion === "smile") {
    els.push(line([[cx - 26 * s, eyeY + 4 * s], [cx - 18 * s, eyeY - 6 * s], [cx - 10 * s, eyeY + 4 * s]], { width: 3 }));
    els.push(line([[cx + 10 * s, eyeY + 4 * s], [cx + 18 * s, eyeY - 6 * s], [cx + 26 * s, eyeY + 4 * s]], { width: 3 }));
  } else {
    els.push(ellipse(cx - 26 * s, eyeY, eyeD, eyeD * 1.25, { fill: "#FFFFFF" }));
    els.push(ellipse(cx + 4 * s, eyeY, eyeD, eyeD * 1.25, { fill: "#FFFFFF" }));
    els.push(ellipse(cx - 21 * s, eyeY + 5 * s, 11 * s, 11 * s, { fill: INK, stroke: INK }));
    els.push(ellipse(cx + 9 * s, eyeY + 5 * s, 11 * s, 11 * s, { fill: INK, stroke: INK }));
    els.push(ellipse(cx - 19 * s, eyeY + 6 * s, 4 * s, 4 * s, { fill: "#FFFFFF", stroke: "#FFFFFF" }));
    els.push(ellipse(cx + 11 * s, eyeY + 6 * s, 4 * s, 4 * s, { fill: "#FFFFFF", stroke: "#FFFFFF" }));
  }
  // 老师圆框眼镜
  if (who === "teacher") {
    els.push(ellipse(cx - 30 * s, eyeY - 4 * s, 30 * s, 26 * s, { stroke: INK, width: 2 }));
    els.push(ellipse(cx + 0 * s, eyeY - 4 * s, 30 * s, 26 * s, { stroke: INK, width: 2 }));
    els.push(line([[cx + 0 * s, eyeY + 8 * s], [cx + 0 * s, eyeY + 8 * s]], { width: 2 }));
  }
  // 腮红
  if (emotion !== "shocked") {
    els.push(ellipse(cx - 34 * s, eyeY + 24 * s, 16 * s, 9 * s, { fill: "#F5A9A0", stroke: "#F5A9A0" }));
    els.push(ellipse(cx + 18 * s, eyeY + 24 * s, 16 * s, 9 * s, { fill: "#F5A9A0", stroke: "#F5A9A0" }));
  }
  // 嘴
  const mouthY = faceY + headD * 0.72;
  if (emotion === "excited" || emotion === "shocked") {
    els.push(ellipse(cx - 11 * s, mouthY - 8 * s, 22 * s, 18 * s, { fill: RED, stroke: INK }));
  } else if (emotion === "worried") {
    els.push(line([[cx - 11 * s, mouthY + 4 * s], [cx + 11 * s, mouthY - 2 * s]], { width: 2 }));
  } else {
    els.push(line([[cx - 12 * s, mouthY], [cx - 4 * s, mouthY + 7 * s], [cx + 4 * s, mouthY + 7 * s], [cx + 12 * s, mouthY]], { width: 2 }));
  }
  // 教鞭（point 姿势专属）
  if (who === "teacher" && pose === "point") {
    els.push(rect(cx + 64 * s, bodyTop - 34 * s, 58 * s, 7 * s, { fill: "#8B5E3C", stroke: "#8B5E3C" }));
  }
  return els;
}

// ---------- 道具 ----------
function drawProp(prop: SceneProp, cx: number, cy: number): Skeleton[] {
  const els: Skeleton[] = [];
  const s = prop.scale ?? 1;
  switch (prop.type) {
    case "padlock": {
      els.push(line([[cx - 22 * s, cy - 14 * s], [cx - 22 * s, cy - 40 * s], [cx - 8 * s, cy - 40 * s]], { width: 4 }));
      els.push(line([[cx + 22 * s, cy - 14 * s], [cx + 22 * s, cy - 40 * s], [cx + 8 * s, cy - 40 * s]], { width: 4 }));
      els.push(rect(cx - 32 * s, cy - 16 * s, 64 * s, 56 * s, { fill: YELLOW, width: 3 }));
      els.push(ellipse(cx - 7 * s, cy + 2 * s, 14 * s, 14 * s, { fill: DARK, stroke: DARK }));
      els.push(rect(cx - 3 * s, cy + 12 * s, 6 * s, 14 * s, { fill: DARK, stroke: DARK }));
      break;
    }
    case "tablet": {
      els.push(rect(cx - 52 * s, cy - 38 * s, 104 * s, 76 * s, { fill: GRAY, width: 3 }));
      els.push(line([[cx - 34 * s, cy - 14 * s], [cx + 34 * s, cy - 14 * s]], { width: 2 }));
      els.push(line([[cx - 34 * s, cy + 2 * s], [cx + 20 * s, cy + 2 * s]], { width: 2 }));
      els.push(line([[cx - 34 * s, cy + 18 * s], [cx + 8 * s, cy + 18 * s]], { width: 2 }));
      break;
    }
    case "lightning": {
      const w = 30 * s, h = 84 * s;
      els.push(line([[cx, cy - h / 2], [cx - w / 2, cy - h * 0.05], [cx + w * 0.1, cy - h * 0.05], [cx - w * 0.3, cy + h / 2], [cx + w * 0.5, cy - h * 0.12], [cx - w * 0.05, cy - h * 0.12], [cx, cy - h / 2]], { stroke: YELLOW, width: 4 }));
      break;
    }
    case "crack": {
      els.push(line([[cx, cy - 90 * s], [cx - 14 * s, cy - 40 * s], [cx + 12 * s, cy - 6 * s], [cx - 10 * s, cy + 40 * s], [cx + 6 * s, cy + 90 * s]], { stroke: RED, width: 4 }));
      break;
    }
    case "sandTimer": {
      els.push(rect(cx - 30 * s, cy - 60 * s, 60 * s, 10 * s, { fill: "#8B5E3C", width: 2 }));
      els.push(rect(cx - 30 * s, cy + 50 * s, 60 * s, 10 * s, { fill: "#8B5E3C", width: 2 }));
      els.push(line([[cx - 26 * s, cy - 50 * s], [cx + 26 * s, cy - 50 * s], [cx - 2 * s, cy], [cx + 2 * s, cy], [cx + 26 * s, cy - 50 * s]], { width: 2 }));
      els.push(line([[cx - 26 * s, cy + 50 * s], [cx + 26 * s, cy + 50 * s], [cx - 2 * s, cy + 4 * s], [cx + 2 * s, cy + 4 * s], [cx - 26 * s, cy + 50 * s]], { width: 2 }));
      els.push(ellipse(cx - 8 * s, cy + 24 * s, 14 * s, 10 * s, { fill: YELLOW, stroke: YELLOW }));
      break;
    }
    case "robot": {
      els.push(rect(cx - 26 * s, cy - 30 * s, 52 * s, 40 * s, { fill: "#E9EEF2", width: 3 }));
      els.push(ellipse(cx - 14 * s, cy - 16 * s, 12 * s, 12 * s, { fill: TEAL, stroke: INK }));
      els.push(ellipse(cx + 2 * s, cy - 16 * s, 12 * s, 12 * s, { fill: TEAL, stroke: INK }));
      els.push(line([[cx, cy - 30 * s], [cx, cy - 48 * s]], { width: 3 }));
      els.push(ellipse(cx - 3 * s, cy - 54 * s, 7 * s, 7 * s, { fill: RED, stroke: RED }));
      els.push(rect(cx - 20 * s, cy + 12 * s, 40 * s, 44 * s, { fill: "#C9D4DB", width: 3 }));
      els.push(line([[cx - 20 * s, cy + 24 * s], [cx - 40 * s, cy + 40 * s]], { width: 3 }));
      els.push(line([[cx + 20 * s, cy + 24 * s], [cx + 40 * s, cy + 40 * s]], { width: 3 }));
      break;
    }
    case "monitor": {
      els.push(rect(cx - 62 * s, cy - 44 * s, 124 * s, 84 * s, { fill: "#22303F", width: 3 }));
      els.push(line([[cx - 46 * s, cy + 2 * s], [cx - 24 * s, cy - 16 * s], [cx - 2 * s, cy + 6 * s], [cx + 22 * s, cy - 18 * s], [cx + 44 * s, cy]], { stroke: RED, width: 3 }));
      els.push(rect(cx - 10 * s, cy + 40 * s, 20 * s, 16 * s, { fill: "#9AA5AE", width: 2 }));
      els.push(rect(cx - 40 * s, cy + 56 * s, 80 * s, 8 * s, { fill: "#9AA5AE", width: 2 }));
      break;
    }
    case "gear": {
      const r = 44 * s;
      els.push(ellipse(cx - r, cy - r, r * 2, r * 2, { fill: "#C9D4DB", width: 3 }));
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        els.push(line([[cx + Math.cos(ang) * r * 0.9, cy + Math.sin(ang) * r * 0.9], [cx + Math.cos(ang) * r * 1.25, cy + Math.sin(ang) * r * 1.25]], { width: 5 }));
      }
      els.push(ellipse(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s, { fill: "#FFFFFF" }));
      break;
    }
    case "starBurst": {
      const spikes: number[][] = [];
      for (let a = 0; a < 10; a++) {
        const ang = (a * Math.PI) / 5 - Math.PI / 2;
        const r = (a % 2 === 0 ? 62 : 28) * s;
        spikes.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
      }
      spikes.push(spikes[0]);
      els.push(line(spikes, { stroke: RED, width: 3 }));
      break;
    }
    case "arrow": {
      els.push(arrow([[cx - 70 * s, cy], [cx + 70 * s, cy]], { width: 3 }));
      break;
    }
    case "question": {
      els.push(txt(cx - 14 * s, cy - 34 * s, "?", 56 * s, { stroke: TEAL }));
      break;
    }
    case "book": {
      els.push(rect(cx - 46 * s, cy - 32 * s, 92 * s, 64 * s, { fill: TEAL, width: 3 }));
      els.push(line([[cx, cy - 32 * s], [cx, cy + 32 * s]], { width: 3 }));
      els.push(line([[cx - 36 * s, cy - 14 * s], [cx - 10 * s, cy - 14 * s]], { width: 2 }));
      els.push(line([[cx + 10 * s, cy - 14 * s], [cx + 36 * s, cy - 14 * s]], { width: 2 }));
      break;
    }
    case "desk": {
      els.push(rect(cx - 100 * s, cy - 8 * s, 200 * s, 14 * s, { fill: "#C89B6C", width: 2 }));
      els.push(line([[cx - 80 * s, cy + 6 * s], [cx - 80 * s, cy + 60 * s]], { width: 3 }));
      els.push(line([[cx + 80 * s, cy + 6 * s], [cx + 80 * s, cy + 60 * s]], { width: 3 }));
      break;
    }
    case "cloud": {
      els.push(ellipse(cx - 40 * s, cy - 14 * s, 56 * s, 34 * s, { fill: "#FFFFFF" }));
      els.push(ellipse(cx + 2 * s, cy - 26 * s, 64 * s, 40 * s, { fill: "#FFFFFF" }));
      els.push(ellipse(cx - 6 * s, cy, 48 * s, 26 * s, { fill: "#FFFFFF" }));
      break;
    }
  }
  return els;
}

// ---------- 气泡 ----------
function drawBubble(who: "teacher" | "student", text: string, pos: string, box: { x: number; y: number; w: number; h: number }): Skeleton[] {
  const per = 15;
  const lines = wrap(text, per);
  const w = Math.min(360, 60 + per * 17);
  const h = 34 + lines.length * 24;
  const m = 26;
  const bx = pos.includes("l") ? box.x + m : box.x + box.w - m - w;
  const by = pos.includes("t") ? box.y + m : box.y + box.h - m - h;
  const els: Skeleton[] = [];
  els.push(rect(bx, by, w, h, { fill: who === "teacher" ? "#FFFFFF" : "#FFF6DC", width: 2 }));
  const tailX = pos.includes("l") ? bx + 34 : bx + w - 34;
  const tailY = pos.includes("t") ? by + h : by;
  const dir = pos.includes("t") ? 1 : -1;
  els.push(line([[tailX - 12, tailY], [tailX, tailY + 14 * dir], [tailX + 12, tailY]], { width: 2 }));
  els.push(rect(bx + 10, by + 8, 26, 20, { fill: who === "teacher" ? DARK : "#F09A3E", stroke: who === "teacher" ? DARK : "#F09A3E" }));
  els.push(txt(bx + 15, by + 9, who === "teacher" ? "师" : "测", 14, { stroke: "#FFFFFF" }));
  lines.forEach((ln, i) => els.push(txt(bx + 12, by + 32 + i * 24, ln, 18)));
  return els;
}

/** 渲染一格：场景图 → 整洁卡通风元素骨架。 */
export function renderComicScenePanel(panel: ComicScenePanel, index: number, opts: { x: number; y: number }): { elements: Skeleton[]; box: { x: number; y: number; w: number; h: number } } {
  const { x: x0, y: y0 } = opts;
  const els: Skeleton[] = [];
  els.push(rect(x0, y0, PANEL_W, PANEL_H, { fill: BG_COLOR[panel.bg] ?? "#FFFFFF", width: 2 }));
  els.push(ellipse(x0 + 20, y0 + 20, 44, 44, { fill: YELLOW, width: 2 }));
  els.push(txt(x0 + 33, y0 + 29, String(index + 1), 24, { centerW: 24 }));
  const captionH = panel.caption ? 62 : 0;
  const sceneX = x0 + 24;
  const sceneY = y0 + 78;
  const sceneW = PANEL_W - 48;
  const sceneH = PANEL_H - 78 - captionH - 14;
  const X = (pct: number) => sceneX + (sceneW * pct) / 100;
  const Y = (pct: number) => sceneY + (sceneH * pct) / 100;
  for (const a of panel.actors) els.push(...drawFigure(a.who, a.pose, a.emotion ?? "smile", X(a.x), Y(a.y)));
  for (const p of panel.props) els.push(...drawProp(p, X(p.x), Y(p.y)));
  if (panel.sfx) els.push(txt(x0 + PANEL_W - 210, y0 + 64, panel.sfx + "!", 46, { stroke: RED, angle: -0.15 }));
  const box = { x: x0, y: y0, w: PANEL_W, h: PANEL_H - captionH };
  for (const b of panel.bubbles) els.push(...drawBubble(b.who, b.text, b.pos, box));
  if (panel.caption) {
    els.push(rect(x0, y0 + PANEL_H - captionH, PANEL_W, captionH, { fill: "#FFF3C9", width: 2, round: false }));
    els.push(txt(x0 + 20, y0 + PANEL_H - captionH + 18, panel.caption, 19));
  }
  return { elements: els, box: { x: x0, y: y0, w: PANEL_W, h: PANEL_H } };
}

/** 第 index 格的面板原点 */
export function panelOrigin(index: number): { x: number; y: number } {
  return { x: 60, y: 60 + index * (PANEL_H + PANEL_GAP) };
}

/** 一部漫画的整体画布建议尺寸 */
export function storyboardCanvasSize(panelCount: number): { w: number; h: number } {
  return { w: PANEL_W + 120, h: 60 + panelCount * (PANEL_H + PANEL_GAP) };
}
