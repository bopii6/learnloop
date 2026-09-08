// 教材（PDF）的加载、切块与检索：课程蓝图镜像教材目录，教学按课节取相关页
// 教材文档经存储抽象层持久化（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）
import type { TextbookPage, SourceItem } from "@/types";
import { readJson } from "@/lib/storage";

export interface TextbookDoc {
  id: string;
  title: string;
  pageCount: number;
  pages: TextbookPage[];
  toc: string[]; // 启发式提取的目录标题（第X章/单元/节、N.N 标题行）
  owner?: string; // 上传者（登录后记录）
  uploadedAt: number;
}

/** 课程状态里存的最小教材信息（不含 pageCount/uploadedAt） */
export interface TextbookLike {
  id?: string;
  title: string;
  toc: string[];
  pages: TextbookPage[];
}

export async function loadTextbook(id: string): Promise<TextbookDoc | null> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return readJson<TextbookDoc | null>(`textbooks/${safe}.json`, null);
}

/** 从逐页文本里捞目录式标题行：中文教材（第一章/第一单元/1.1）与英文（Chapter/Unit） */
export function extractTocCandidates(pages: TextbookPage[]): string[] {
  const lineRe =
    /^\s*(第\s*[0-9０-９一二三四五六七八九十百]+\s*[章讲单元部分][^\n，。；：！？]{0,28}|[0-9０-９]{1,2}\.[0-9０-９]{1,2}\s*[^\n，。；：！？]{0,26}|Chapter\s+\d{1,2}[^\n，。;:!?]{0,40}|Unit\s+\d{1,2}[^\n，。;:!?]{0,40})\s*$/i;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pages) {
    for (const rawLine of p.text.split("\n")) {
      const line = rawLine.trim();
      if (line.length < 2 || line.length > 40) continue;
      if (!lineRe.test(line)) continue;
      const key = line.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= 80) return out;
    }
  }
  return out;
}

export interface TextbookChunk {
  index: number;
  label: string; // 《教材》P12-14
  text: string;
  startPage: number;
  endPage: number;
}

/** 把逐页文本合并成 ~2200 字的连续块；块标题带页码范围，可当"来源"展示 */
export function chunkTextbook(tb: TextbookLike, maxChars = 2200, maxChunks = 40): TextbookChunk[] {
  const chunks: TextbookChunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let startPage = 0;
  let endPage = 0;

  const flush = () => {
    if (buf.length === 0 || chunks.length >= maxChunks) return;
    chunks.push({
      index: chunks.length + 1,
      label: `《${tb.title}》P${startPage}${endPage > startPage ? `-P${endPage}` : ""}`,
      text: buf.join("\n"),
      startPage,
      endPage,
    });
    buf = [];
    bufLen = 0;
  };

  for (const p of tb.pages) {
    if (bufLen === 0) {
      startPage = p.page;
      endPage = p.page;
    } else {
      endPage = p.page;
    }
    buf.push(p.text);
    bufLen += p.text.length;
    if (bufLen >= maxChunks) {
      flush();
      if (chunks.length >= maxChunks) break;
    }
  }
  flush();
  return chunks;
}

/** 文档体量评估：内容太薄的文档撑不起一门系统课，建课链路要相应收敛规模 */
export function assessTextbook(tb: TextbookLike): { totalChars: number; thin: boolean } {
  const totalChars = tb.pages.reduce((s, p) => s + p.text.trim().length, 0);
  // 阈值：800 字约等于 1 页有效讲义；低于它按"笔记/便签"处理
  return { totalChars, thin: totalChars < 800 };
}

/** 教材块 → 伪来源（建课链路把教材当"搜索结果"用，蓝图/澄清共用一套 excerpt 管线） */
export function textbookToSources(tb: TextbookLike): {
  sources: SourceItem[];
  pageContents: Record<number, string>;
} {
  const chunks = chunkTextbook(tb);
  const sources: SourceItem[] = chunks.map((c) => ({
    index: c.index,
    title: c.label,
    url: "",
    domain: "教材",
    snippet: c.text.slice(0, 120),
  }));
  const pageContents: Record<number, string> = {};
  for (const c of chunks) pageContents[c.index] = c.text;
  return { sources, pageContents };
}

/**
 * 给蓝图/澄清用的教材要点：目录全文 + 均匀抽样的块内容。
 * 全书太长灌不进 prompt，均匀抽样保证首尾章节都被看到。
 */
export function buildTextbookExcerpt(tb: TextbookLike, budgetChars = 7000): string {
  const lines: string[] = [];
  if (tb.toc.length > 0) {
    lines.push(`教材目录（提取到的章节标题）：\n${tb.toc.join("\n")}`);
  }
  const chunks = chunkTextbook(tb);
  const take = Math.max(2, Math.min(chunks.length, 4));
  const step = chunks.length / take;
  for (let i = 0; i < take; i++) {
    const c = chunks[Math.min(chunks.length - 1, Math.floor(i * step))];
    lines.push(`${c.label}：${c.text.slice(0, Math.floor(budgetChars / take))}`);
  }
  // 薄文档规模收敛：2 句话的笔记不该被撑成 6 单元 24 课节的"系统课"（实测踩过的坑）
  const totalChars = tb.pages.reduce((s, p) => s + p.text.trim().length, 0);
  if (totalChars < 800) {
    lines.push(
      `（注意：这份文档全文仅约 ${totalChars} 字，是笔记级体量。课程规模必须与内容量匹配：3-5 个单元、每单元 3-4 课节，宁少勿凑；超出原文的内容只能来自联网补充资料，课节设计要能区分"原文精讲"和"补充资料"。）`
    );
  }
  return lines.join("\n\n").slice(0, budgetChars + 1200);
}

/** 从课节标题/概念里取检索词（≥2 字的片段） */
function extractTerms(parts: (string | undefined)[]): string[] {
  const terms: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const seg of part.split(/[：:，,。;；、（）()\[\]【】\s—\-·]+/)) {
      if (seg.length >= 2 && seg.length <= 20) terms.push(seg);
    }
  }
  return terms;
}

/**
 * 为一节课挑最相关的教材页：先按词命中打分，没有命中就按"全书均摊"取位置
 * （整本书被课程大纲均分成 N 段，每节课认领自己那段——保证讲完整本书）。
 */
export function pagesForLecture(
  tb: TextbookLike,
  lectureTitle: string,
  extraTerms: string[],
  lectureIndex: number,
  totalLectures: number,
  take = 3
): TextbookPage[] {
  if (tb.pages.length === 0) return [];
  const terms = extractTerms([lectureTitle, ...extraTerms]);
  const scored = tb.pages.map((p) => {
    let score = 0;
    for (const t of terms) {
      let pos = 0;
      let count = 0;
      while (count < 20) {
        const hit = p.text.indexOf(t, pos);
        if (hit === -1) break;
        count += 1;
        pos = hit + t.length;
      }
      score += count * Math.min(t.length, 6);
    }
    return { page: p, score };
  });
  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, take)
    .map((s) => s.page);
  if (hits.length > 0) return hits;

  // 兜底：全书均摊。第 i 节课认领 [i*P/N, (i+1)*P/N) 的中段页
  const n = Math.max(1, totalLectures);
  const i = Math.max(0, Math.min(n - 1, lectureIndex));
  const span = tb.pages.length / n;
  const center = Math.floor(i * span + span / 2);
  const half = Math.max(1, Math.floor(take / 2));
  return tb.pages.slice(Math.max(0, center - half), Math.max(0, center - half) + take);
}
