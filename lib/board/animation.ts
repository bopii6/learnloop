// 互动动画：让 LLM 生成一个自包含的 HTML 演示（对应白板上的一个机制）。
// 约束与 Hyperknow 对齐：单文件、内联 CSS/JS、无外部资源（CSP 只放 inline），可直接 iframe srcdoc 渲染。
import crypto from "node:crypto";
import { generateText } from "ai";
import { getModel } from "@/lib/agent/llm";
import { readBinary, writeBinary } from "@/lib/storage";

const ANIM_SYSTEM = `你是教学互动动画工程师。为白板课生成一个"自包含单文件 HTML"的互动演示，讲解一个机制。

硬性要求（缺一不可）：
1. 只输出 HTML（从 <!DOCTYPE html> 到 </html>），不要解释、不要 Markdown 代码围栏。
2. 完全自包含：内联 <style> 与 <script>；禁止外部 URL、CDN、字体文件、图片文件；图形用 Canvas / SVG / DOM 画。
3. 禁止任何网络请求（fetch/XHR/WebSocket/外部资源一律不许）。
4. 页面自适应：铺满视口（html,body 高 100%，无滚动条），字体用系统字体栈（含中文回退）。
5. 视觉与白板一致：浅色底（#fafafa 或 #ffffff）、深蓝主色 #1f3a5f、少量暖黄强调 #f59e0b；线条干净、留白充足、不要阴影堆叠。
6. 自动播放：页面加载后无需交互即开始演示（可以有播放/暂停/重置按钮，但不能依赖点击才能看到内容）。
7. 中文标签，字号足够大（正文 ≥ 16px），标注要少而准。
8. 总大小 ≤ 20KB。

内容要求：
- 演示要"看得见的机制"：参数变化 → 视觉结果变化（如向量夹角、概率分布、token 流动、栈帧进出）。
- 可用滑杆/输入让学员操作（可选），但默认姿态也要一目了然。
- 不要写大段文字说明，用图形 + 短标签。`;

export async function generateBoardAnimation(task: string): Promise<string> {
  const clean = task.replace(/\s+/g, " ").trim().slice(0, 500);
  const hash = crypto.createHash("sha1").update(clean).digest("hex").slice(0, 20);
  const cacheKey = `board-anim/${hash}.html`;
  const hit = await readBinary(cacheKey);
  if (hit) return hit.toString("utf8");

  const { text } = await generateText({
    model: getModel(),
    system: ANIM_SYSTEM,
    prompt: `要演示的任务：${task.slice(0, 600)}\n\n请输出完整的单文件 HTML。`,
    temperature: 0.35,
    maxTokens: 6000,
    abortSignal: AbortSignal.timeout(180_000),
  });
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let html = (fence ? fence[1] : text).trim();
  const start = html.search(/<!DOCTYPE|<!doctype|<html/i);
  if (start > 0) html = html.slice(start);
  if (!/<\/html>/i.test(html)) {
    html += "\n</body></html>";
  }
  // 保险：剥掉可能残留的外部资源引用，避免被 CSP 拦成空白
  html = html.replace(/<(script|link)[^>]+(src|href)=["']https?:[^"']*["'][^>]*>\s*<\/script>/gi, "");
  try {
    await writeBinary(cacheKey, Buffer.from(html, "utf8"));
  } catch {
    // 缓存失败不影响本次
  }
  return html;
}
