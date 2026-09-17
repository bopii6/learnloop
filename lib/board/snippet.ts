// 锚点匹配：把服务端下发的归一化 snippet 映射回卡片 DOM 的文字范围。
// 对标 Hyperknow 的做法：
//   1) 归一化：只保留 [字母/数字/汉字]（小写），其余字符折叠成一个空格；
//   2) KaTeX 公式取 <annotation encoding="application/x-tex"> 里的 TeX 源码，
//      `\命令` → 命令名（如 \mid → mid），使公式也可被 snippet 锚定；
//   3) 在归一化文本里找 snippet，得到 DOM 引用范围 → 计算包围盒。

export interface AnchorRefText {
  type: "text";
  node: Text;
  offset: number;
}
export interface AnchorRefEl {
  type: "el";
  el: Element;
}
export type AnchorRef = AnchorRefText | AnchorRefEl;

interface NormChar {
  ch: string;
  ref: AnchorRef;
}

const isAlnum = (ch: string) => /[0-9a-z\u4e00-\u9fff]/i.test(ch);
const isCJK = (ch: string) => /[\u4e00-\u9fff]/.test(ch);

/** 归一化任意文本（与匹配用的规则一致） */
export function normalizeText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** TeX 源码 → 可匹配的字面量：`\mid`→mid，`_`/`^`/括号交由归一化折叠 */
function texToLiteral(tex: string): string {
  return (
    tex
      .replace(/\\([a-zA-Z]+)/g, " $1 ")
      .replace(/[{}]/g, " ")
      // eslint-disable-next-line no-useless-escape
      .replace(/[\\]/g, " ")
  );
}

const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "SVG", "PATH", "IMG", "CANVAS"]);

/** 遍历卡片 DOM，构造归一化字符串 + 字符到 DOM 的映射 */
export function buildNormIndex(root: HTMLElement): NormChar[] {
  const out: NormChar[] = [];
  const push = (text: string, refOf: (i: number) => AnchorRef, opts?: { tex?: boolean }) => {
    const src = opts?.tex ? texToLiteral(text) : text;
    let prevWasSpace = true;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (isAlnum(ch)) {
        out.push({ ch: ch.toLowerCase(), ref: refOf(i) });
        prevWasSpace = false;
      } else if (!prevWasSpace) {
        out.push({ ch: " ", ref: refOf(i) });
        prevWasSpace = true;
      }
    }
  };

  // 手动遍历：文本节点 + katex 元素（按文档顺序）
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const parent = t.parentElement;
      if (!parent) return;
      for (let p: Element | null = parent; p; p = p.parentElement) {
        if (SKIP_TAGS.has(p.tagName)) return;
        if (p === root) break;
      }
      push(t.data, (i) => ({ type: "text", node: t, offset: i }));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.classList.contains("katex")) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      const tex = ann?.textContent || el.textContent || "";
      push(tex, () => ({ type: "el", el }), { tex: true });
      return;
    }
    if (el.classList.contains("tw-chrome")) return; // 装饰性 chrome 不参与匹配
    for (const child of Array.from(el.childNodes)) visit(child);
  };
  for (const child of Array.from(root.childNodes)) visit(child);
  // 去掉首尾空白
  while (out.length && out[0].ch === " ") out.shift();
  while (out.length && out[out.length - 1].ch === " ") out.pop();
  return out;
}

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 在归一化索引中找 snippet；命中返回 DOM 引用范围（含首尾） */
export function findSnippet(
  index: NormChar[],
  snippet: string
): AnchorRef[] | null {
  const target = normalizeText(snippet).trim();
  if (!target) return null;
  const hay = index.map((c) => c.ch).join("");
  const at = hay.indexOf(target);
  if (at < 0) return null;
  const refs: AnchorRef[] = [];
  let lastKey = "";
  for (let i = at; i < at + target.length; i++) {
    const ref = index[i]?.ref;
    if (!ref) continue;
    const key =
      ref.type === "text" ? `t:${ref.node.data.length}:${ref.node.data.slice(0, 8)}` : `e:${(ref.el as HTMLElement).className}`;
    if (key !== lastKey) {
      refs.push(ref);
      lastKey = key;
    }
  }
  return refs.length ? refs : null;
}

/** 计算锚点范围的包围盒（相对 root 的坐标系） */
export function anchorRects(refs: AnchorRef[], root: HTMLElement): AnchorRect | null {
  const rootRect = root.getBoundingClientRect();
  let box: AnchorRect | null = null;
  const add = (r: DOMRect) => {
    const a = {
      left: r.left - rootRect.left,
      top: r.top - rootRect.top,
      right: r.right - rootRect.left,
      bottom: r.bottom - rootRect.top,
    };
    if (!box) box = a;
    else {
      box.left = Math.min(box.left, a.left);
      box.top = Math.min(box.top, a.top);
      box.right = Math.max(box.right, a.right);
      box.bottom = Math.max(box.bottom, a.bottom);
    }
  };
  for (const ref of refs) {
    const rect =
      ref.type === "text"
        ? (() => {
            const r = document.createRange();
            r.setStart(ref.node, Math.min(ref.offset, ref.node.data.length));
            r.setEnd(ref.node, Math.min(ref.offset + 1, ref.node.data.length));
            return r.getBoundingClientRect();
          })()
        : ref.el.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) add(rect);
  }
  return box;
}
