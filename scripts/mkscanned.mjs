// 造一个"扫描版"PDF（纯图片页，无文字层）：canvas 直接画出教材页 → JPEG → 拼成图片 PDF。
// 用于验证上传路由的扫描版 OCR 分支（DeepSeek OCR）。跑法：node scripts/mkscanned.mjs
// 产物：<系统临时目录>/scanned-textbook.pdf（2 页，含"第X章 / X.X 小节"标题，可顺带验证目录提取）
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const PAGES = [
  ["第一章 函数与极限", "1.1 函数的概念", "设 D 是一个非空数集，若对 D 中每个 x，", "按照某种对应法则 f 都有唯一确定的 y 与之对应，", "则称 f 是定义在 D 上的函数。"],
  ["第二章 导数与微分", "2.1 导数的定义", "函数在某点的导数描述了函数在该点附近的变化率，", "几何意义是曲线在该点切线的斜率。", "Derivative: the limit of the difference quotient."],
];
const IW = 1102;
const IH = 1426;
const W = 612; // PDF 页面尺寸（pt）
const H = 792;

const jpegs = [];
for (const lines of PAGES) {
  const c = createCanvas(IW, IH);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, IW, IH);
  g.fillStyle = "#111";
  lines.forEach((line, i) => {
    g.font = i === 0 ? "bold 44px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif" : i === 1 ? "bold 34px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif" : "30px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
    g.fillText(line, 90, 140 + i * 70);
  });
  jpegs.push(await c.encode("jpeg", 85));
}

// ---- 图片 PDF 拼装：1 Catalog, 2 Pages, 之后每页 3 个对象（Page / Contents / Image） ----
const n = jpegs.length;
const pageObj = (k) => 3 + k * 3;
const chunks = [];
const offsets = [0];
let pos = 0;
const push = (b) => {
  const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
  chunks.push(buf);
  pos += buf.length;
};
const objAt = (i) => {
  offsets[i] = pos;
  push(`${i} 0 obj\n`);
};

push("%PDF-1.4\n");
objAt(1); push(`<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
objAt(2); push(`<< /Type /Pages /Kids [${jpegs.map((_, k) => `${pageObj(k)} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);
jpegs.forEach((jpeg, k) => {
  const p = pageObj(k);
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  objAt(p); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${p + 1} 0 R /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> >>\nendobj\n`);
  objAt(p + 1); push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\nendobj\n`);
  objAt(p + 2); push(`<< /Type /XObject /Subtype /Image /Width ${IW} /Height ${IH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
});
const nObjs = 3 + n * 3;
const xrefPos = pos;
push(`xref\n0 ${nObjs}\n0000000000 65535 f \n`);
for (let i = 1; i < nObjs; i++) push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
push(`trailer\n<< /Size ${nObjs} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

const dest = join(tmpdir(), "scanned-textbook.pdf");
writeFileSync(dest, Buffer.concat(chunks));
console.log("scanned-style pdf written:", dest, pos, "bytes,", n, "pages");
