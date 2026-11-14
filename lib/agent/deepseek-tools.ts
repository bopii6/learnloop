// DeepSeek 独立工具接口（2026-11-13 开放）：Search / Fetch / OCR。
// 搜索 / 网页正文 / 扫描版教材 OCR 的唯一通道（旧的 Tavily/博查/DDG/Bing、本地抓取、tesseract 已移除）。
// 与 LLM 共用一把 key：DEEPSEEK_API_KEY 优先；未配置且 LLM_BASE_URL 指向 DeepSeek 时复用 LLM_API_KEY。
// 计费（官方文档）：Search / Fetch 各 $0.75/千次（失败/空结果不计费），OCR $0.225/千页。
// 文档：https://api-docs.deepseek.com/guides/search 、/guides/ocr

const BASE = (process.env.DEEPSEEK_TOOLS_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");

function toolsKey(): string {
  const own = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (own) return own;
  const llmBase = process.env.LLM_BASE_URL || "https://api.deepseek.com";
  const llmKey = (process.env.LLM_API_KEY || "").trim();
  // .env.example 里的占位符（含中文）不算有效 key
  if (/deepseek\.com/i.test(llmBase) && /^[\x21-\x7e]{16,}$/.test(llmKey)) return llmKey;
  return "";
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const msg = JSON.parse(body)?.error?.message;
    if (msg) return `${res.status} ${msg}`;
  } catch {
    // 非 JSON 错误体
  }
  return `${res.status} ${body.slice(0, 200)}`;
}

// ---- 搜索结果正文缓存：Search 带 need_content 时顺手拿到正文，readUrl 先查这里，省一次 Fetch ----
const CONTENT_CACHE_MAX = 200;
const contentCache = new Map<string, string>();

function rememberContent(url: string, content: string) {
  if (!content || content.length < 300) return;
  if (contentCache.size >= CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value;
    if (oldest !== undefined) contentCache.delete(oldest);
  }
  contentCache.set(url, content.slice(0, 20000));
}

export function recallSearchContent(url: string): string {
  return contentCache.get(url) || "";
}

// ---- Search ----
export interface DeepseekSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** DeepSeek 对"结果与问题相关"的打分，0-3 */
  rerank: number;
  /** DeepSeek 的站点权威度，0-4（-1 = 未知） */
  authority: number;
}

/** oriQuestion：用户的原始学习目标。搜索词只是关键词，带上原始目标能让 DeepSeek 的重排更贴近真实需求 */
export async function deepseekSearch(
  query: string,
  count = 8,
  opts: { oriQuestion?: string } = {}
): Promise<DeepseekSearchResult[]> {
  const key = toolsKey();
  if (!key) throw new Error("DeepSeek tools key not configured");
  const res = await fetch(`${BASE}/v1/tools/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: query.slice(0, 128),
      count: Math.max(1, Math.min(50, count)),
      need_content: true,
      ...(opts.oriQuestion ? { ori_question: opts.oriQuestion.slice(0, 500) } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`DeepSeek search ${await readError(res)}`);
  const data = await res.json();
  if (data?.error) throw new Error(`DeepSeek search ${data.error.message || "error"}`);
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => typeof r?.url === "string" && r.url.startsWith("http"))
    .map((r) => {
      // 实测结果 URL 会带 "#1" 这类序号片段：去掉，否则跨引擎去重失效、引用链接也不干净
      const url = String(r.url).replace(/#\d+$/, "");
      rememberContent(url, String(r.content || ""));
      return {
        title: String(r.title || url),
        url,
        // summary 是给模型看的长摘要，比 snippet 信息量大；截断以免撑爆提示词
        snippet: String(r.summary || r.snippet || "").slice(0, 400),
        rerank: Number(r.rerank_score) || 0,
        authority: Number.isFinite(Number(r.authority)) ? Number(r.authority) : -1,
      };
    });
}

// ---- Fetch ----
/** 抓取单页为 Markdown 正文；失败返回空串（调用方自行降级到本地抓取） */
export async function deepseekFetch(url: string): Promise<string> {
  const key = toolsKey();
  if (!key) return "";
  try {
    const res = await fetch(`${BASE}/v1/tools/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url: url.slice(0, 8192) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.log(`[deepseek-fetch] ${url} → ${await readError(res)}`);
      return "";
    }
    const data = await res.json();
    if (data?.error) return "";
    return String(data?.content || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片标记对讲解没用，只占 token
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (e) {
    console.log(`[deepseek-fetch] ${url} → ${String(e)}`);
    return "";
  }
}

// ---- OCR ----
export interface DeepseekOcrResult {
  pages: { page: number; text: string }[]; // page 为 1 起
  pageCount: number;
  cutOff: number; // finish_reason=length（输出被截断）的页数
}

/** 整本文件交给 DeepSeek OCR（同步接口，单次 ≤180 秒、≤1000 页、≤100MiB）。失败 throw。 */
export async function deepseekOcr(file: Blob, filename: string): Promise<DeepseekOcrResult> {
  const key = toolsKey();
  if (!key) throw new Error("DeepSeek tools key not configured");
  const form = new FormData();
  form.append("purpose", "text_recognition");
  form.append("file", file, filename);
  const res = await fetch(`${BASE}/v1/tools/ocr`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(200000),
  });
  if (!res.ok) throw new Error(`DeepSeek OCR ${await readError(res)}`);
  // 服务端先发换行保活再发 JSON；识别开始后的失败以 200 + error 对象返回
  const data = JSON.parse((await res.text()).trim());
  if (data?.error) throw new Error(`DeepSeek OCR ${data.error.message || "error"}`);
  const raw: any[] = Array.isArray(data?.pages) ? data.pages : [];
  const pages = raw
    .map((p) => ({
      page: Number(p?.index ?? 0) + 1,
      text: String(p?.text || "")
        // 输出是 Markdown：去掉行首 "# " 标题标记，否则目录启发式（/^第X章/）认不出章节行
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
        .replace(/[ \t ]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    }))
    .sort((a, b) => a.page - b.page);
  return {
    pages,
    pageCount: Number(data?.page_count) || raw.length,
    cutOff: raw.filter((p) => p?.finish_reason === "length").length,
  };
}
