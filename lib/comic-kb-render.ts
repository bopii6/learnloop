// 知识地图 → Excalidraw 长卷渲染：讲完一节课，把知识地图画在白板长卷的末尾。
// 白板课与漫画课共用同一份知识地图数据（data/comic-storyboards/kb_*.json），
// 这里只做确定性排版（roughness=0 工整卡通风），不含任何图片素材。
import type { KnowledgeStoryboard } from "@/lib/agent/comic";

const INK = "#27272A";

type Skeleton = Record<string, unknown>;
const CLEAN = { roughness: 0 };

function rect(x: number, y: number, w: number, h: number, o: { stroke?: string; fill?: string; width?: number } = {}): Skeleton {
  return {
    type: "rectangle", x, y, width: w, height: h,
    strokeColor: o.stroke ?? INK, backgroundColor: o.fill ?? "transparent", fillStyle: "solid",
    strokeWidth: o.width ?? 1.5, roundness: { type: 3 }, ...CLEAN,
  };
}
function line(points: number[][], o: { stroke?: string; width?: number; dash?: boolean } = {}): Skeleton {
  return {
    type: "line", x: points[0][0], y: points[0][1],
    points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]]),
    strokeColor: o.stroke ?? INK, strokeWidth: o.width ?? 1.5,
    ...(o.dash ? { strokeStyle: "dashed" } : {}), ...CLEAN,
  };
}
function arrow(points: number[][], o: { stroke?: string; width?: number } = {}): Skeleton {
  return {
    type: "arrow", x: points[0][0], y: points[0][1],
    points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]]),
    strokeColor: o.stroke ?? INK, strokeWidth: o.width ?? 1.5, ...CLEAN,
  };
}
function txt(x: number, y: number, text: string, fontSize: number, o: { stroke?: string; fill?: string; centerW?: number } = {}): Skeleton {
  return {
    type: "text", x, y, text, fontSize, strokeColor: o.stroke ?? INK,
    backgroundColor: o.fill, fontFamily: 2, ...CLEAN,
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

/** 知识地图整块：画在 (ox, oy) 起，宽 W。返回元素与总高。 */
export function renderKnowledgeMapSkeleton(kb: KnowledgeStoryboard, ox: number, oy: number, W = 980): { elements: Skeleton[]; height: number } {
  const els: Skeleton[] = [];
  let y = oy;

  // 标题
  els.push(txt(ox, y, `📌 知识地图｜${kb.title}`, 24, { fill: "#27272A" }));
  y += 36;
  if (kb.subtitle) { els.push(txt(ox, y, kb.subtitle, 14)); y += 26; }

  // 总览：主线步骤
  if (kb.overview.steps.length > 0) {
    els.push(rect(ox, y, W, 96, { fill: "#FFFFFF", width: 1.5 }));
    els.push(txt(ox + 14, y + 10, kb.overview.label, 14, { fill: "#27272A" }));
    let sx = ox + 14;
    const sy = y + 42;
    const fills = ["#D6E6F5", "#D9EDDC", "#F5E9C9", "#F5D9D4"];
    kb.overview.steps.forEach((s, i) => {
      const lines = wrap(s, 12);
      const w = Math.max(90, Math.min(240, 12 * Math.max(...lines.map((l) => l.length)) + 22));
      els.push(rect(sx, sy, w, 34, { fill: fills[i % fills.length], width: 1.5 }));
      lines.forEach((ln, li) => els.push(txt(sx + 12, sy + 6 + li * 15, ln, 12)));
      sx += w + 26;
      if (i < kb.overview.steps.length - 1) els.push(arrow([[sx - 20, sy + 17], [sx - 4, sy + 17]], { width: 1.5 }));
    });
    if (kb.overview.loop) {
      els.push(line([[ox + 14, y + 84], [ox + W - 14, y + 84]], { stroke: "#8A8A8A", dash: true }));
      els.push(txt(ox + 14, y + 70, `↩ ${kb.overview.loop}`, 11, { stroke: "#6B6B6B" }));
    }
    y += 112;
  }

  // 卡片（两列一行）
  const colW = (W - 20) / 2;
  const cardH = 236;
  const drawCard = (c: (typeof kb.cards)[number], x: number, yy: number) => {
    els.push(rect(x, yy, colW, cardH, { fill: "#FFFFFF", width: 1.5 }));
    els.push(txt(x + 12, yy + 8, `${c.num}  ${c.title}`, 16));
    if (c.tags) els.push(txt(x + 12, yy + 30, c.tags, 10, { stroke: "#8A8A8A" }));
    wrap(c.explain, 26).forEach((ln, i) => els.push(txt(x + 12, yy + 46 + i * 16, ln, 12)));
    // 烦恼 / 办法 双格
    const bx = [x + 10, x + 10 + colW / 2];
    const by = yy + 92;
    const bw = colW / 2 - 18;
    const sides = [
      { d: c.trouble, label: "烦恼", fill: "#F5F3EC", tone: INK },
      { d: c.fix, label: "办法", fill: "#F0F7F1", tone: "#2F7D46" },
    ];
    sides.forEach((side, si) => {
      els.push(rect(bx[si], by, bw, 118, { fill: side.fill, width: 1.2 }));
      els.push(txt(bx[si] + 8, by + 6, side.label, 11, { fill: side.tone }));
      wrap(side.d.line, 16).forEach((ln, i) => els.push(txt(bx[si] + 8, by + 22 + i * 14, ln, 11)));
      side.d.nodes.slice(0, 3).forEach((n, ni) => {
        const ny = by + 54 + ni * 20;
        const isCheck = n.kind === "check";
        const isCross = n.kind === "cross";
        els.push(rect(bx[si] + 8, ny, bw - 16, 18, {
          fill: isCheck ? "#D9EDDC" : "#FFFFFF",
          stroke: isCross ? "#C0392B" : INK,
          width: isCross ? 1.2 : 1,
        }));
        els.push(txt(bx[si] + 12, ny + 3, `${isCheck ? "✓ " : isCross ? "✗ " : ""}${n.text}`.slice(0, 18), 10, { stroke: isCross ? "#C0392B" : INK }));
      });
    });
    els.push(txt(x + 12, yy + cardH - 34, `解决了什么 · ${c.solved}`, 11));
    els.push(txt(x + 12, yy + cardH - 18, `代价是什么 · ${c.cost}`, 11, { stroke: "#6B6B6B" }));
  };

  // 分节（按 range 编号分组；漏分的卡片顺序铺在最后）
  let cursor = y + 16;
  if (kb.sections.length > 0) {
    const drawn = new Set<string>();
    kb.sections.forEach((sec) => {
      const m = sec.range.match(/(\d+)\D+(\d+)/);
      const from = m ? Number(m[1]) : -1;
      const to = m ? Number(m[2]) : -1;
      const cards = kb.cards.filter((c) => {
        const n = Number(c.num);
        return Number.isFinite(n) && n >= from && n <= to;
      });
      if (cards.length === 0) return;
      els.push(txt(ox, cursor, sec.name, 19));
      els.push(txt(ox + sec.name.length * 19 + 12, cursor + 5, sec.range, 11, { stroke: "#8A8A8A" }));
      els.push(line([[ox, cursor + 30], [ox + W, cursor + 30]], { width: 1.2 }));
      cursor += 44;
      for (let r = 0; r < cards.length; r += 2) {
        drawCard(cards[r], ox, cursor);
        if (cards[r + 1]) drawCard(cards[r + 1], ox + colW + 20, cursor);
        cursor += cardH + 18;
      }
      cards.forEach((c) => drawn.add(c.num));
    });
    const rest = kb.cards.filter((c) => !drawn.has(c.num));
    for (let r = 0; r < rest.length; r += 2) {
      drawCard(rest[r], ox, cursor);
      if (rest[r + 1]) drawCard(rest[r + 1], ox + colW + 20, cursor);
      cursor += cardH + 18;
    }
  } else {
    for (let r = 0; r < kb.cards.length; r += 2) {
      drawCard(kb.cards[r], ox, cursor);
      if (kb.cards[r + 1]) drawCard(kb.cards[r + 1], ox + colW + 20, cursor);
      cursor += cardH + 18;
    }
  }

  // 度量
  if (kb.metrics.length > 0) {
    els.push(txt(ox, cursor, "最后拿这把尺子，量一量。", 17));
    cursor += 32;
    kb.metrics.slice(0, 3).forEach((m, i) => {
      const mx = ox + i * ((W - 40) / 3 + 10);
      const mw = (W - 40) / 3;
      els.push(rect(mx, cursor, mw, 92, { fill: "#FFFFFF", width: 1.5 }));
      els.push(txt(mx + 12, cursor + 8, m.label, 12, { fill: "#6B6B6B" }));
      els.push(txt(mx + 12, cursor + 26, m.value, 24));
      els.push(txt(mx + 12, cursor + 62, m.note, 10.5, { stroke: "#8A8A8A" }));
    });
    cursor += 108;
  }

  // 总结表
  if (kb.outro.table.length > 0) {
    els.push(txt(ox, cursor, kb.outro.line, 14));
    cursor += 26;
    const cols = [ox, ox + 240, ox + 560];
    ["办法", "通常帮助哪里", "要付出的代价"].forEach((h, i) => els.push(txt(cols[i], cursor, h, 12)));
    els.push(line([[ox, cursor + 20], [ox + W, cursor + 20]], { width: 1.5 }));
    cursor += 28;
    kb.outro.table.forEach((r) => {
      els.push(txt(cols[0], cursor, wrap(r.step, 16)[0], 12));
      els.push(txt(cols[1], cursor, wrap(r.help, 26)[0], 12, { stroke: "#4A4A4A" }));
      els.push(txt(cols[2], cursor, wrap(r.cost, 26)[0], 12, { stroke: "#4A4A4A" }));
      els.push(line([[ox, cursor + 20], [ox + W, cursor + 20]], { stroke: "#C9C9C9", width: 1 }));
      cursor += 26;
    });
  }

  return { elements: els, height: cursor - oy + 20 };
}
