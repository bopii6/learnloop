// OCR 链路探针：造测试 PDF → pdf.js 渲染成位图 → tesseract 识别。
// 用途：验证本机渲染 + OCR 可用、语言包可下载。跑法：node scripts/ocr-probe.mjs [chi_sim|eng]
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- 1. 造两页测试 PDF（Helvetica 只能编拉丁字，中文 OCR 用位图单独验证） ----
function textObj(lines) {
  const esc = lines.map((l) => l.replace(/([()\\])/g, "\\$1"));
  return esc.map((s, i) => `BT /F1 12 Tf 72 ${700 - i * 20} Td (${s}) Tj ET`).join("\n");
}
function mkPdf(dest) {
  const p1 = textObj([
    "Chapter 1 Algebra",
    "1.1 Real Numbers",
    "A linear function has the form f(x) = kx + b.",
    "The set of real numbers is infinite.",
  ]);
  const p2 = textObj([
    "Chapter 2 Functions",
    "2.1 Linear Functions",
    "Its graph is a straight line with slope k.",
    "Domain and range determine the function.",
  ]);
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>`;
  objs[4] = { stream: p1 };
  objs[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>`;
  objs[6] = { stream: p2 };
  objs[7] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    const o = objs[i];
    if (typeof o === "object" && o.stream) {
      out += `${i} 0 obj\n<< /Length ${Buffer.byteLength(o.stream, "latin1")} >>\nstream\n${o.stream}\nendstream\nendobj\n`;
    } else {
      out += `${i} 0 obj\n${o}\nendobj\n`;
    }
  }
  const xrefPos = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  writeFileSync(dest, Buffer.from(out, "latin1"));
  return dest;
}

const lang = process.argv[2] || "eng";
const pdfPath = mkPdf(join(tmpdir(), "ocr-probe.pdf"));
console.log("[1] pdf:", pdfPath);

// ---- 2. 渲染第 1 页为位图 ----
const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
const buf = new Uint8Array(await import("node:fs").then((fs) => fs.readFileSync(pdfPath)));
const t0 = Date.now();
const pdf = await getDocumentProxy(buf);
const png = await renderPageAsImage(pdf, 1, {
  canvasImport: async () => await import("@napi-rs/canvas"),
  scale: 1.8,
});
console.log(`[2] rendered page 1: ${png.byteLength} bytes in ${Date.now() - t0}ms`);
writeFileSync(join(tmpdir(), "ocr-probe.png"), Buffer.from(png));

// ---- 3. tesseract OCR ----
const { createWorker } = await import("tesseract.js");
const t1 = Date.now();
const cachePath = join(process.cwd(), "data", "ocr-cache");
const worker = await createWorker(lang, 1, { cachePath });
console.log(`[3] worker ready (${lang}) in ${Date.now() - t1}ms, cache: ${existsSync(cachePath)}`);
const t2 = Date.now();
const { data } = await worker.recognize(join(tmpdir(), "ocr-probe.png"));
console.log(`[4] OCR done in ${Date.now() - t2}ms`);
console.log("---- recognized ----");
console.log(data.text.trim());
console.log("--------------------");
await worker.terminate();
console.log("PROBE_OK");
