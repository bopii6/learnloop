// 电视字幕式逐行播放：把一个 beat 的讲稿切成字幕行。
// 句末标点切句；超长句再按子句标点补刀，保证每行短到能一眼读完。
// 手写扫描而不是正则 lookbehind：Safari 16.4 之前不支持 lookbehind，播放器要在它上面跑。

const SENTENCE_ENDERS = "。！？；!?;…";
const CLAUSE_ENDERS = "，、：,:";
const MAX_LINE_LEN = 42;

function splitBy(text: string, enders: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (enders.includes(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 讲稿 → 字幕行（一次只显示一行）。同一段文本切法确定，供 TTS 缓存 key 与预取共用 */
export function splitSpeechLines(text: string | undefined | null): string[] {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = splitBy(clean, SENTENCE_ENDERS);
  const lines: string[] = [];
  for (const s of sentences) {
    if (s.length <= MAX_LINE_LEN) {
      lines.push(s);
      continue;
    }
    const clauses = splitBy(s, CLAUSE_ENDERS);
    let buf = "";
    for (const c of clauses) {
      if (buf && buf.length + c.length > MAX_LINE_LEN) {
        lines.push(buf);
        buf = c;
      } else {
        buf += c;
      }
    }
    if (buf) lines.push(buf);
  }
  return lines.length > 0 ? lines : [clean];
}

/** 把 itemCount 条板书分配到 lineCount 句话上：返回第 k 条应在第几句开讲时落笔（0 起，一句带一个动作） */
export function planItemLines(lineCount: number, itemCount: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < itemCount; k++) {
    out.push(lineCount === 0 ? 0 : Math.min(lineCount - 1, Math.round((k * lineCount) / itemCount)));
  }
  return out;
}
