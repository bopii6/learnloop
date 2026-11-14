import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "../lib/board/markdown";

test("卡面公式用 KaTeX 渲染", () => {
  const html = renderMarkdownToHtml(String.raw`均值 $\bar{x}=\frac{1}{n}\sum x_i$，中位数不怕极端值`);
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /katex-error/);
});

test("卡面不放行原始 HTML（内容来自大模型，用 innerHTML 挂载，必须防 XSS）", () => {
  const html = renderMarkdownToHtml('正常文字 <script>alert(1)</script> <img src=x onerror="alert(2)">');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.match(html, /正常文字/);
});

test("标题包上高亮条，代码块保留", () => {
  const html = renderMarkdownToHtml("## 先别急着 dropna\n\n```python\ndf.fillna(0)\n```");
  assert.match(html, /overlay-note-title-highlight/);
  assert.match(html, /<code[^>]*>[\s\S]*fillna/);
});
