// 抓取网页正文：charset 识别 + 主内容区提取（article/main 优先，剥离导航/页脚样板）
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeBody(buf: ArrayBuffer, contentType: string): string {
  // 从 Content-Type 或 HTML meta 里探测编码（中文页面常见 GBK/GB2312）
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() || "";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 2048));
  if (!charset) {
    charset =
      /<meta[^>]+charset=['"]?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ||
      /<meta[^>]+content=['"][^'"]*charset=([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ||
      "utf-8";
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

function stripBoilerplate(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** 从整页 HTML 里取出正文片段：优先 article/main，退化取 body，再退化整页 */
function extractMain(html: string): string {
  const article =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    html.match(/<div[^>]+(?:id|class)="[^"]*(?:content|article|post|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ||
    html;
  return htmlToText(stripBoilerplate(article));
}

export async function readUrl(url: string, maxChars = 6000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*", "Accept-Language": "zh-CN,en;q=0.8" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) return "";
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return "";
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 500) return "";
    const raw = decodeBody(buf, contentType);
    if (contentType.includes("text/plain")) {
      return htmlToText(raw).slice(0, maxChars);
    }
    // HTML：先试主内容区（article/main/正文容器），太短再退化用整页
    const main = htmlToText(stripBoilerplate(extractMain(raw)));
    const full = htmlToText(stripBoilerplate(raw));
    return (main.length > 800 ? main : full).slice(0, maxChars);
  } catch {
    return "";
  }
}
