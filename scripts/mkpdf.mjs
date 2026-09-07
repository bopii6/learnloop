// 生成一个最小可解析的两页英文 PDF（含 Chapter/N.N 标题行）用于冒烟测试
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function textObj(lines) {
  const esc = lines.map((l) => l.replace(/([()\\])/g, "\\$1"));
  const body = esc.map((s, i) => `BT /F1 12 Tf 72 ${700 - i * 20} Td (${s}) Tj ET`).join("\n");
  return body;
}

const page1 = textObj([
  "Chapter 1 Algebra",
  "1.1 Real Numbers",
  "Algebra studies operations and relations among numbers.",
  "This chapter covers sets, mappings and functions.",
]);
const page2 = textObj([
  "Chapter 2 Functions",
  "2.1 Linear Functions",
  "A linear function has the form f(x) = kx + b.",
  "Its graph is a straight line with slope k.",
]);

const objs = [];
objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
objs[2] = `<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>`;
objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>`;
objs[4] = { stream: page1 };
objs[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>`;
objs[6] = { stream: page2 };
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
for (let i = 1; i < objs.length; i++) {
  out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
}
out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

const dest = join(tmpdir(), "test-textbook.pdf");
writeFileSync(dest, Buffer.from(out, "latin1"));
console.log("pdf written:", dest, Buffer.byteLength(out, "latin1"), "bytes");
