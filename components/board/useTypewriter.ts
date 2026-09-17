"use client";

// 逐字落字（打字机）：对标 Hyperknow 的 useTypewriterReveal
//  - 文本逐字 span 溶解（opacity+blur），公式/图片整体淡入，布局始终稳定（不换行抖动）；
//  - 速度：单字间隔 clamp(2880/总单元数, 18, 50) ms → 整卡约 2.4-2.9s；
//  - "chrome 保护"：标题标记条/表格线绑到其所属的第一个/最后一个字，跟着一起出现；
//  - 闸门：全部落字完成且 gateOpen（配对讲解播完）才回调 onDone；另有 forceFinish 保险丝。
import { useCallback, useEffect, useRef } from "react";

export interface TypewriterApi {
  /** 配对语音讲完：允许收尾 */
  openGate: () => void;
  /** 保险丝：无条件立即完成 */
  forceFinish: () => void;
  /** 是否已完成 */
  isDone: () => boolean;
}

interface Unit {
  el: HTMLElement;
  chrome: HTMLElement[];
}

/** 元素相对祖先的偏移（offset 累加，场景坐标，不受 transform scale 影响） */
function offsetWithin(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== root) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
    if (!cur) break;
  }
  return { x, y };
}

const CHROME_SELECTOR = ".overlay-note-title-highlight, table, th, td";
const UNIT_SELECTOR = ".katex, img, .tw-unit";

export function useTypewriter(
  rootRef: React.RefObject<HTMLElement | null>,
  opts: { enabled: boolean; contentKey: string; onDone?: () => void; onPen?: (p: { x: number; y: number } | null) => void }
): TypewriterApi {
  const rafRef = useRef<number | null>(null);
  const gateRef = useRef(false);
  const doneRef = useRef(false);
  const revealedAllRef = useRef(false);
  const onDoneRef = useRef(opts.onDone);
  const onPenRef = useRef(opts.onPen);
  const finishRef = useRef<() => void>(() => {});
  onDoneRef.current = opts.onDone;
  onPenRef.current = opts.onPen;

  const cleanupFrames = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    doneRef.current = false;
    gateRef.current = false;
    revealedAllRef.current = false;
    const root = rootRef.current;
    if (!root || !opts.enabled) {
      // 关闭动效：内容直接可见，立刻视为完成（由闸门/保险丝照常收尾）
      onDoneRef.current?.();
      return cleanupFrames;
    }

    // ---- 1) 打点：文本逐字 span 化；公式/图片整元；chrome 元素收起来 ----
    const units: Unit[] = [];
    const pendingChrome: HTMLElement[] = [];
    const wrapText = (node: Text) => {
      const s = node.data;
      if (!s) return;
      const frag = document.createDocumentFragment();
      const spans: HTMLElement[] = [];
      for (const ch of s) {
        const sp = document.createElement("span");
        sp.className = "tw-char tw-hidden";
        sp.textContent = ch;
        frag.appendChild(sp);
        spans.push(sp);
      }
      node.parentNode?.replaceChild(frag, node);
      for (const sp of spans) units.push({ el: sp, chrome: [] });
    };
    const isInChrome = (el: Element) => el.closest(CHROME_SELECTOR) !== null && el.closest(CHROME_SELECTOR) !== el;

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node as Text;
        const parent = t.parentElement;
        if (!parent) return;
        const tag = parent.tagName;
        if (tag === "STYLE" || tag === "SCRIPT" || tag === "SVG") return;
        if (parent.closest(".tw-chrome") && !parent.closest(CHROME_SELECTOR)) return;
        wrapText(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === "STYLE" || el.tagName === "SCRIPT" || el.tagName === "SVG") return;
      if (el.matches(UNIT_SELECTOR)) {
        el.classList.add("tw-unit", "tw-hidden");
        if (el.tagName === "IMG") el.classList.remove("tw-hidden"); // 图片直接出现（避免布局抖动）
        units.push({ el, chrome: [] });
        return;
      }
      if (el.matches(CHROME_SELECTOR)) {
        el.classList.add("tw-chrome-off");
        pendingChrome.push(el);
        // chrome 内部若有文本，仍按普通文本处理（表格里的字也是字）
      }
      for (const child of Array.from(el.childNodes)) visit(child);
    };
    // 卡面根节点本身可能带 chrome 类
    if (root.matches(CHROME_SELECTOR)) {
      root.classList.add("tw-chrome-off");
      pendingChrome.push(root);
    }
    for (const child of Array.from(root.childNodes)) visit(child);

    // chrome → 绑定到其内部第一个/最后一个单元（标题条绑最后一个字，表格绑第一个字）
    for (const c of pendingChrome) {
      const inside = units.filter((u) => c.contains(u.el));
      if (inside.length === 0) {
        c.classList.remove("tw-chrome-off");
        continue;
      }
      const target = c.matches(".overlay-note-title-highlight") ? inside[inside.length - 1] : inside[0];
      target.chrome.push(c);
    }

    // ---- 2) 落字循环 ----
    const per = Math.max(18, Math.min(50, Math.round(2880 / Math.max(1, units.length))));
    let cursor = 0;
    let acc = 0;
    let last = performance.now();

    const revealUnit = (u: Unit) => {
      u.el.classList.remove("tw-hidden");
      u.el.classList.add("tw-shown");
      for (const c of u.chrome) {
        c.classList.remove("tw-chrome-off");
        c.classList.add("tw-chrome-in");
      }
      // 笔尖贴刚写完的字（offset 累加：不受外层 scale 影响，直接用场景坐标）
      try {
        const el = u.el.tagName === "IMG" ? u.el : (u.el as HTMLElement);
        const pos = offsetWithin(el, root);
        onPenRef.current?.({ x: pos.x + el.offsetWidth, y: pos.y + el.offsetHeight });
      } catch {
        onPenRef.current?.(null);
      }
    };

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onPenRef.current?.(null);
      // 解回普通文本：还原干净的 DOM（后续 React 重渲染不受影响）
      for (const u of units) {
        const el = u.el;
        if (el.classList.contains("tw-char")) {
          el.parentNode?.replaceChild(document.createTextNode(el.textContent || ""), el);
        } else if (el.classList.contains("tw-unit")) {
          el.classList.remove("tw-hidden", "tw-shown", "tw-unit");
        }
      }
      for (const c of pendingChrome) c.classList.remove("tw-chrome-in", "tw-chrome-off");
      for (const u of units) for (const c of u.chrome) c.classList.remove("tw-chrome-in", "tw-chrome-off");
      onDoneRef.current?.();
    };
    finishRef.current = () => {
      for (let i = cursor; i < units.length; i++) revealUnit(units[i]);
      cursor = units.length;
      finish();
    };

    const tick = (now: number) => {
      rafRef.current = null;
      const dt = now - last;
      last = now;
      acc += dt;

      let lastUnit: Unit | null = null;
      while (acc >= per && cursor < units.length) {
        lastUnit = units[cursor];
        revealUnit(lastUnit);
        cursor += 1;
        acc -= per;
      }
      if (cursor >= units.length) {
        // 实测语义：落字完成即完成（讲解可同时进行）；闸门仅作提前放行的加速器
        revealedAllRef.current = true;
        onPenRef.current?.(null);
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return cleanupFrames;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.contentKey, opts.enabled]);

  const openGate = useCallback(() => {
    gateRef.current = true;
    if (revealedAllRef.current && !doneRef.current) {
      finishRef.current();
    }
  }, []);

  const forceFinish = useCallback(() => {
    finishRef.current();
  }, []);

  return { openGate, forceFinish, isDone: () => doneRef.current };
}
