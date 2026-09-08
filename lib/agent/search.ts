// 网页搜索：Tavily（有 key 优先）→ 博查（国内）→ DuckDuckGo HTML → Bing HTML（免 key 兜底）
// 所有结果统一做权威度评分 + 相关性闸门 + 同域去重，保证"信息源头"质量。
// 闸门逐引擎生效：某引擎返回的结果全被拦掉（实测 Bing 对英文查询会整页跑题）就换下一个引擎。
import type { SourceItem } from "@/types";

interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
function relevanceHits(text: string, tokens: string[]): number {
  const t = text.toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (/[\u4e00-\u9fff]/.test(tok)) {
      if (t.includes(tok)) hits += 1;
    } else if (new RegExp(`\\b${escapeRe(tok)}\\b`).test(t)) {
      hits += 1;
    }
  }
  return hits;
}

// 括号年份条目 = 影视/虚构作品（"Artificial (2026)"、"xxx (2026 film)"）；
// Definition & Meaning / English meaning = 词典释义页——都不可能成为课程资料
const JUNK_TITLE_RE = /\(\d{4}(?:\s*(?:film|movie))?\)|definition\s*(&|&amp;)\s*meaning|english meaning|disambiguation/i;
const JUNK_DOMAINS = new Set(["imdb.com", "merriam-webster.com", "dictionary.cambridge.org", "dictionary.com", "vocabulary.com"]);

function isJunkResult(domain: string, title: string): boolean {
  if (JUNK_DOMAINS.has(domain) || [...JUNK_DOMAINS].some((d) => domain.endsWith("." + d))) return true;
  return JUNK_TITLE_RE.test(title);
}

async function searchTavily(query: string, max = 8): Promise<RawResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: max,
      search_depth: "advanced",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r: any) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.content || "",
  }));
}

async function searchBocha(query: string, max = 8): Promise<RawResult[]> {
  const res = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
    },
    body: JSON.stringify({ query, count: max, summary: true }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Bocha ${res.status}`);
  const data = await res.json();
  const pages = data?.data?.webPages?.value || [];
  return pages.map((r: any) => ({
    title: r.name || r.url,
    url: r.url,
    snippet: r.summary || r.snippet || "",
  }));
}

// 免 key 兜底 1：DuckDuckGo HTML 版（对中英文查询都稳定，反爬比 Bing 宽松）
async function searchDuckDuckGo(query: string, max = 8): Promise<RawResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query, kl: "cn-zh" }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DDG ${res.status}`);
  const html = await res.text();
  const results: RawResult[] = [];
  const blockRe = /<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  const blocks = html.match(blockRe) || [];
  for (const b of blocks) {
    if (results.length >= max) break;
    const link = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let href = link[1];
    // DDG 的跳转链接：//duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (!href.startsWith("http")) continue;
    const title = decodeHtmlEntities(link[2].replace(/<[^>]+>/g, "").trim());
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snip ? decodeHtmlEntities(snip[1].replace(/<[^>]+>/g, "").trim()) : "";
    if (title) results.push({ title, url: href, snippet: snippet.slice(0, 300) });
  }
  return results;
}

// 免 key 兜底：抓 Bing 结果页 HTML。
// 英文查询必须带 ensearch=1（强制国际版英文结果），否则国内出口只会拿到 zh 站群；
// ensearch 版结果的链接是 Bing 跳转链（u=a1<base64>），需要解码出真实 URL。
function decodeBingRedirect(href: string): string {
  if (!href.includes("bing.com/ck/a")) return href;
  const m = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (!m) return href;
  try {
    return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8") || href;
  } catch {
    return href;
  }
}

async function searchBing(query: string, max = 8): Promise<RawResult[]> {
  const isEn = !/[\u4e00-\u9fff]/.test(query);
  const params = new URLSearchParams({ q: query });
  if (isEn) {
    params.set("ensearch", "1");
    params.set("setlang", "en");
  } else {
    params.set("setlang", "zh-Hans");
  }
  const res = await fetch(`https://www.bing.com/search?${params.toString()}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const html = await res.text();
  const results: RawResult[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  const blocks = html.match(blockRe) || [];
  for (const b of blocks) {
    if (results.length >= max) break;
    const link = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const href = decodeBingRedirect(link[1].replace(/&amp;/g, "&"));
    if (!href.startsWith("http")) continue;
    const title = decodeHtmlEntities(link[2].replace(/<[^>]+>/g, "").trim());
    const snip = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snip ? decodeHtmlEntities(snip[1].replace(/<[^>]+>/g, "").trim()) : "";
    results.push({ title: title || href, url: href, snippet: snippet.slice(0, 300) });
  }
  return results;
}

export async function webSearch(query: string, max = 8): Promise<SourceItem[]> {
  const tokens = queryTokens(query);
  const minHits = Math.min(2, tokens.length);
  const passesGate = (r: RawResult) =>
    !isJunkResult(domainOf(r.url), r.title) && relevanceHits(`${r.title} ${r.snippet || ""}`, tokens) >= minHits;

  let raw: RawResult[] = [];
  const errors: string[] = [];
  const providers: [string, () => Promise<RawResult[]>][] = [
    ["tavily", () => searchTavily(query, max)],
    ["bocha", () => searchBocha(query, max)],
    ["ddg", () => searchDuckDuckGo(query, max)],
    ["bing", () => searchBing(query, max)],
  ];
  for (const [name, run] of providers) {
    if (name === "tavily" && !process.env.TAVILY_API_KEY) continue;
    if (name === "bocha" && !process.env.BOCHA_API_KEY) continue;
    try {
      const results = await run();
      const kept = results.filter(passesGate);
      if (kept.length > 0) {
        raw = kept;
        break;
      }
      errors.push(`${name}: ${results.length} raw → 0 passed relevance gate`);
    } catch (e) {
      errors.push(`${name}: ${String(e)}`);
    }
  }
  if (raw.length === 0) {
    console.error("all search providers failed:", errors);
  }

  // 权威度排序 + 同域最多 2 条（信息源多样性）；结果已在各引擎出口过闸
  const scored = raw
    .map((r) => ({ ...r, score: authorityScore(r.url) }))
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
