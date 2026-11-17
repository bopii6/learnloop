// 字幕 ↔ 板书对应：找出字幕里哪些字在这一拍的白板卡上原样出现，
// 字幕里给它们画上和白板同款的黄色记号，学员一眼就能把"听到的"和"看到的"对上。

/** 白板卡是 markdown：去掉符号，只留看得见的字 */
export function boardPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, ""))
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/-{3,}/g, "")
    .toLowerCase();
}

// 一段算"词"：至少 2 个汉字，或至少 3 个可见字符（如 #N/A、SUM；避免单个字、单个字母乱亮）
const MIN_CJK = 2;
const MIN_LATIN = 3;
const isCjk = (ch: string) => /[㐀-鿿]/.test(ch);
const isMark = (ch: string) => /[\s，。、；：！？,.;:!?「」“”"'（）()【】\[\]—…·]/.test(ch);

/**
 * 返回与字幕等长的布尔数组：true = 这个字落在一段"白板上也有"的连续片段里。
 * 贪心取最长匹配；片段两端不含标点空白。
 */
export function captionMatchMask(caption: string, board: string | undefined): boolean[] {
  const mask = new Array<boolean>(caption.length).fill(false);
  if (!board) return mask;
  const hay = boardPlainText(board);
  if (!hay) return mask;
  const lower = caption.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    if (isMark(lower[i])) {
      i++;
      continue;
    }
    // 从 i 起向后延伸，找白板里能找到的最长片段
    let best = 0;
    for (let len = 1; i + len <= lower.length; len++) {
      if (!hay.includes(lower.slice(i, i + len))) break;
      best = len;
    }
    // 片段末尾不留标点 / 空白
    while (best > 0 && isMark(lower[i + best - 1])) best--;
    const piece = lower.slice(i, i + best);
    const chars = [...piece];
    const cjk = chars.filter(isCjk).length;
    const visible = chars.filter((c) => !isMark(c)).length;
    if (best > 0 && (cjk >= MIN_CJK || visible >= MIN_LATIN)) {
      for (let k = i; k < i + best; k++) mask[k] = true;
      i += best;
    } else {
      i++;
    }
  }
  return mask;
}
