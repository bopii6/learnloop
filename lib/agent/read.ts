// 抓取网页正文：搜索时已带回的正文（缓存）→ DeepSeek Fetch（Markdown）。拿不到返回空串，调用方跳过该来源。
import { deepseekFetch, recallSearchContent } from "./deepseek-tools";

export async function readUrl(url: string, maxChars = 6000): Promise<string> {
  const cached = recallSearchContent(url);
  if (cached.length > 800) return cached.slice(0, maxChars);
  const md = await deepseekFetch(url);
  if (md.length > 300) return md.slice(0, maxChars);
  // Fetch 失败或页面太短：退而用搜索时带回的短正文（有总比没有好）
  return (md.length >= cached.length ? md : cached).slice(0, maxChars);
}
