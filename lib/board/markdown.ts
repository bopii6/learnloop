// Markdown → HTML（服务端/客户端通用）：卡面一次性渲染成 HTML 字符串，
// 之后用 dangerouslySetInnerHTML 挂载——React 不再协调这棵子树，
// 打字机可以安全地把文本节点改写成逐字 span。
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeKatex, { throwOnError: false, strict: false })
  .use(rehypeStringify);

/** 标题标记条（chrome）：标题文字包一层高亮 span，落字时跟着最后一个字扫入 */
function chromeifyHeadings(html: string): string {
  return html.replace(/<(h1|h2)([^>]*)>([\s\S]*?)<\/\1>/gi, (_m, tag, attrs, inner) => {
    if (/overlay-note-title-highlight/.test(inner)) return `<${tag}${attrs}>${inner}</${tag}>`;
    return `<${tag}${attrs}><span class="overlay-note-title-highlight">${inner}</span></${tag}>`;
  });
}

export function renderMarkdownToHtml(md: string): string {
  try {
    return chromeifyHeadings(String(processor.processSync(md)));
  } catch {
    return `<p>${md.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)}</p>`;
  }
}
