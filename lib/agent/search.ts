// 网页搜索：DeepSeek Search（与 LLM 共用 DeepSeek key）。
// 结果统一做权威度评分 + 相关性闸门 + 同域去重，保证"信息源头"质量。
import type { SourceItem } from "@/types";
import { deepseekSearch } from "./deepseek-tools";

interface RawResult {
  title: string;
  url: string;
  snippet: string;
  rerank: number;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code: string) => {
      const n = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    })
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

// ---- 域名权威度评分：源头质量的第一道闸 ----
// 高权重：官方文档/标准组织/学术/一线工程社区
const AUTHORITATIVE_SUFFIXES = [
  ".edu", ".edu.cn", ".gov", ".gov.cn", ".ac.cn", ".ac.uk",
];
const AUTHORITATIVE_DOMAINS = new Set([
  "arxiv.org", "wikipedia.org", "github.com", "stackoverflow.com",
  "developer.mozilla.org", "mdn.mozilla.org",
  "microsoft.com", "learn.microsoft.com", "msdn.microsoft.com", "github.io",
  "google.com", "cloud.google.com", "developers.google.com", "research.google",
  "aws.amazon.com", "amazon.com",
  "openai.com", "anthropic.com", "ai.meta.com", "deepmind.google", "huggingface.co",
  "python.org", "nodejs.org", "rust-lang.org", "go.dev", "golang.org", "kernel.org",
  "react.dev", "vuejs.org", "angular.dev", "nextjs.org", "tailwindcss.com",
  "pytorch.org", "tensorflow.org", "keras.io", "scikit-learn.org", "numpy.org", "pandas.pydata.org",
  "langchain.com", "llamaindex.ai", "modelcontextprotocol.io",
  "ieee.org", "acm.org", "nature.com", "science.org", "sciencedirect.com", "springer.com",
  "ietf.org", "w3.org", "rfc-editor.org",
  "semanticscholar.org", "papers.nips.cc", "openreview.net",
]);

// 低质内容农场/拼凑站：直接降权（不全面禁，避免误伤）
const LOW_QUALITY = new Set([
  "baijiahao.baidu.com", "mbd.baidu.com", "baike.baidu.com", "wenku.baidu.com", "baike.so.com", "sogou.com",
  "sohu.com", "163.com",
  "w3cschool.cn", "runoob.com",
  "cnblogs.com", "51cto.com", "oschina.net",
  "hujiang.com",
  "csdn.net", "blog.csdn.net",
  "jianshu.com", "juejin.cn",
  "php.cn", "json.cn",
  "docin.com", "doc88.com", "book118.com",
  "geeksforgeeks.org", "tutorialspoint.com", "w3schools.com",
  "medium.com",
]);

function authorityScore(url: string): number {
  const d = domainOf(url);
  let score = 0;
  // 后缀匹配：zhuanlan.zhihu.com 命中 zhihu.com，learn.microsoft.com 命中 microsoft.com
  const hitDomain = (set: Set<string>) => {
    for (const base of set) {
      if (d === base || d.endsWith("." + base)) return true;
    }
    return false;
  };
  if (hitDomain(AUTHORITATIVE_DOMAINS) || AUTHORITATIVE_SUFFIXES.some((s) => d.endsWith(s))) {
    score += 4;
  } else if (d.endsWith(".github.io") || /^(docs|developer|developers|learn|research)\./.test(d)) {
    score += 3;
  }
  if (hitDomain(LOW_QUALITY)) score -= 5;
  return score;
}

// ---- 相关性闸门 + 垃圾模式：搜索引擎对数据中心 IP 的排序质量很差 ----
// 实测（2026-09-08，Bing 抓取兜底）：「large language models tutorial」混回 6 条日本
// iPhone 维修店目录页；「artificial intelligence tutorial」混回词典释义、(2026) 电影、
// IMDb。这类垃圾权威度分不高但量大，会挤掉真正相关的结果，必须在出口拦掉。
const LATIN_STOP = new Set([
  "how", "what", "why", "when", "the", "and", "for", "with", "from", "into",
  "learn", "learning", "study", "teach",
  "tutorial", "tutorials", "guide", "course", "courses", "introduction", "intro",
  "explained", "explain", "beginner", "beginners", "basics", "best", "complete",
  "practical", "example", "examples", "getting", "started", "step", "concept", "concepts",
]);

function queryTokens(query: string): string[] {
  const latin = (query.toLowerCase().match(/[a-z][a-z0-9.+#-]{1,}/g) || []).filter((w) => !LATIN_STOP.has(w));
  const cjk = query.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...latin, ...cjk])];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** title+snippet 里命中的查询词个数：英文按整词（避免 "ai" 命中 "said"），中文按子串 */
/** title+snippet 里命中的查询词个数：英文按整词（避免 "ai" 命中 "said"），中文按子串或二字片段。
 *  中文长查询词（"播客入门指南"）几乎不会原样出现在结果标题里——逐字要求会把正经结果
 *  全部拦掉（实测 6 条 Tavily 结果全灭、来源只剩 2 条），长词命中任一二字片段即算命中 */
function cjkTokenHit(text: string, tok: string): boolean {
  if (text.includes(tok)) return true;
  if (tok.length <= 3) return false;
  for (let i = 0; i + 2 <= tok.length; i++) {
    if (text.includes(tok.slice(i, i + 2))) return true;
  }
  return false;
}

function relevanceHits(text: string, tokens: string[]): number {
  const t = text.toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (/[\u4e00-\u9fff]/.test(tok)) {
      if (cjkTokenHit(t, tok)) hits += 1;
    } else if (new RegExp(`\\b${escapeRe(tok)}\\b`).test(t)) {
      hits += 1;
    }
  }
  return hits;
}

// 括号年份条目 = 影视/虚构作品（"Artificial (2026)"、"xxx (2026 film)"）；
// Definition & Meaning / English meaning = 词典释义页——都不可能成为课程资料
const JUNK_TITLE_RE = /\(\d{4}(?:\s*(?:film|movie))?\)|definition\s*(&|&amp;)\s*meaning|english meaning|disambiguation/i;
// 词典 / 影视 / 电商与书店商品页 / 专利库：都不是可以拿来讲课的资料
const JUNK_DOMAINS = new Set([
  "imdb.com", "merriam-webster.com", "dictionary.cambridge.org", "dictionary.com", "vocabulary.com",
  "momoshop.com.tw", "readmoo.com", "hyread.com.tw", "books.com.tw", "tenlong.com.tw", "eslite.com",
  "jd.com", "taobao.com", "tmall.com", "dangdang.com", "patents.google.com", "patents.justia.com",
]);

// DeepSeek 重排分 ≥ 此值视为"高度相关"：即便标题摘要没逐字命中查询词也放行（同义改写、跨语言）
const RERANK_TRUST = 1.6;

function isJunkResult(domain: string, title: string): boolean {
  if (JUNK_DOMAINS.has(domain) || [...JUNK_DOMAINS].some((d) => domain.endsWith("." + d))) return true;
  return JUNK_TITLE_RE.test(title);
}

/** goal：用户的原始学习目标（不是搜索词），交给 DeepSeek 重排用 */
export async function webSearch(query: string, max = 8, opts: { goal?: string } = {}): Promise<SourceItem[]> {
  const tokens = queryTokens(query);
  const minHits = Math.min(2, tokens.length);
  const passesGate = (r: RawResult) =>
    !isJunkResult(domainOf(r.url), r.title) &&
    (r.rerank >= RERANK_TRUST || relevanceHits(`${r.title} ${r.snippet || ""}`, tokens) >= minHits);

  // 多要一些候选：闸门会拦掉一部分，留足余量
  let fetched: RawResult[] = [];
  try {
    fetched = await deepseekSearch(query, Math.min(50, max * 2), { oriQuestion: opts.goal });
  } catch (e) {
    console.error(`[search] "${query}" failed:`, String(e));
    return [];
  }
  const seenUrl = new Set<string>();
  const raw: RawResult[] = [];
  for (const r of fetched) {
    if (seenUrl.has(r.url)) continue;
    seenUrl.add(r.url);
    if (passesGate(r)) raw.push(r);
  }
  if (raw.length < max) {
    console.log(`[search] "${query}" → ${raw.length}/${max}（${fetched.length} 条原始结果，其余未过相关性闸门）`);
  }

  // 权威度排序 + 同域最多 2 条（信息源多样性）；结果已在各引擎出口过闸
  const scored = raw
    // 我方权威度（官方文档/学术/社区加分，内容农场减分）+ DeepSeek 相关性，两者相加排序
    .map((r) => ({ ...r, score: authorityScore(r.url) + r.rerank }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const perDomain = new Map<string, number>();
  const out: SourceItem[] = [];
  for (const r of scored) {
    const d = domainOf(r.url);
    if (seen.has(r.url)) continue;
    if ((perDomain.get(d) || 0) >= 2) continue;
    seen.add(r.url);
    perDomain.set(d, (perDomain.get(d) || 0) + 1);
    out.push({
      index: out.length + 1,
      title: decodeHtmlEntities(r.title),
      url: r.url,
      domain: d,
      snippet: r.snippet ? decodeHtmlEntities(r.snippet) : r.snippet,
    });
    if (out.length >= max) break;
  }
  return out;
}
