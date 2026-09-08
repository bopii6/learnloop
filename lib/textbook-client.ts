// 浏览器端教材上传：pdf.js 在用户浏览器里完成逐页文字抽取（Workers 免费版只有 10ms CPU/128MB
// 内存，服务端解析真教材必崩——实测 40 页即被运行时杀掉）。文字版 POST JSON，服务端只做存储；
// 扫描版（无文字层）回退原始文件上传，由服务端走 OCR（本地可用，云端会收到明确的不支持提示）。

const MAX_FILE_BYTES = 80 * 1024 * 1024; // 与服务端 /api/textbook 的上限一致
const MIN_TEXT_RATIO = 0.6; // 与服务端扫描版判定阈值一致
const MIN_PAGE_CHARS = 20;

export interface TextbookUploadResult {
  id: string;
  title: string;
  pageCount: number;
  textPages: number;
  totalChars: number;
  thin: boolean;
  tocCount: number;
  toc: string[];
  ocr: boolean;
  ocrLang?: string;
  truncated: boolean;
  notice: string;
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  pdfjsPromise ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    return pdfjs;
  });
  return pdfjsPromise;
}

/** 逐页抽取 PDF 文字层（保持页序，空页返回空串，保证 pageCount 与总页数一致） */
export async function extractPdfPages(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      let out = "";
      for (const item of items) {
        if ("str" in item) out += item.str + (item.hasEOL ? "\n" : "");
      }
      pages.push(out);
      onProgress?.(i, doc.numPages);
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

/** 教材 PDF 上传全流程：客户端抽取 → 文字版走 JSON / 扫描版回退文件。失败 throw 中文错误 */
export async function uploadTextbookPdf(
  file: File,
  onProgress?: (label: string) => void
): Promise<TextbookUploadResult> {
  if (!/\.pdf$/i.test(file.name)) throw new Error("只支持 PDF 文件");
  if (file.size > MAX_FILE_BYTES)
    throw new Error("文件太大（超过 80MB）。请压缩或拆分 PDF；扫描版图片 PDF 体积大，建议先转文字版再传。");

  onProgress?.("📄 文档解析中…");
  const pageTexts = await extractPdfPages(file, (done, total) =>
    onProgress?.(`📄 文档解析中… ${done}/${total} 页`)
  );
  const textPages = pageTexts.filter((t) => t.replace(/\s+/g, "").length >= MIN_PAGE_CHARS).length;

  let res: Response;
  if (textPages / Math.max(1, pageTexts.length) >= MIN_TEXT_RATIO) {
    onProgress?.("📄 上传解析结果…");
    res = await fetch("/api/textbook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, pageTexts }),
    });
  } else {
    // 扫描版：把原文件交给服务端（本地版 OCR；云端版会得到明确提示）
    onProgress?.("📄 上传文件中…（扫描版会自动 OCR，较慢）");
    const fd = new FormData();
    fd.append("file", file);
    res = await fetch("/api/textbook", { method: "POST", body: fd });
  }

  const d = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      d.error || (res.status === 413 ? "文件太大，超过上传上限。请压缩或拆分 PDF 后重试。" : `上传失败 (${res.status})`)
    );
  return d as TextbookUploadResult;
}
