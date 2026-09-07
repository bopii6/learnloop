// 造一个"扫描版"PDF（图片型，无文字层）：先把文字版渲染成 JPEG，再把 JPEG 包成图片 PDF。
// 用于验证上传路由的扫描版检测 + OCR 分支。跑法：node scripts/mkscanned.mjs
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage, createCanvas } from "@napi-rs/canvas";

const srcPath = join(tmpdir(), "ocr-probe.pdf"); // ocr-probe.mjs 生成的文字版
let srcBuf;
try {
  srcBuf = new Uint8Array(readFileSync(srcPath));
} catch {
  console.error("先跑 node scripts/ocr-probe.mjs eng 生成", srcPath);
  process.exit(1);
}

const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
const pdf = await getDocumentProxy(srcBuf);

const W = 612;
const H = 792;
const jpegs = [];
for (let p = 1; p <= pdf.numPages; p++) {
  const png = await renderPageAsImage(pdf, p, {
    canvasImport: async () => await import("@napi-rs/canvas"),
    scale: 1.8,
  });
  const img = createCanvas(1102, 1426);
  const ctx = img.getContext("2d");
  ctx.drawImage(await loadImage(Buffer.from(png)), 0, 0, img.width, img.height);
  jpegs.push(await img.encode("jpeg", 85));
}
console.log("jpeg pages:", jpegs.map((b) => b.length).join(", "), "bytes");

// ---- 图片 PDF 拼装（对象号固定：1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Image） ----
const jpeg = jpegs[0];
const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
const nObjs = 6; // obj0 占位 + 1..5

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
objAt(2); push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
objAt(3); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n`);
objAt(4); push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\nendobj\n`);
objAt(5); push(`<< /Type /XObject /Subtype /Image /Width 1102 /Height 1426 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
push(jpeg);
push("\nendstream\nendobj\n");

const xrefPos = pos;
push(`xref\n0 ${nObjs}\n0000000000 65535 f \n`);
for (let i = 1; i < nObjs; i++) push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
push(`trailer\n<< /Size ${nObjs} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

const dest = join(tmpdir(), "scanned-textbook.pdf");
writeFileSync(dest, Buffer.concat(chunks));
console.log("scanned-style pdf written:", dest, pos, "bytes");
