// 扫描版 PDF 的 OCR：pdf.js 渲染位图 → tesseract 识别（默认 chi_sim+eng）。
// 仅当 PDF 没有文字层时走这条路；语言包首次使用时自动下载并缓存到 data/ocr-cache。
import { promises as fs } from "fs";
import path from "path";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

type PdfDoc = Awaited<ReturnType<typeof getDocumentProxy>>;

const OCR_CACHE_DIR = path.join(process.cwd(), "data", "ocr-cache");

export interface OcrPage {
  page: number;
  text: string;
}

export interface OcrResult {
  pages: OcrPage[];
  lang: string;
  truncated: boolean; // 超过页数上限，只识别了前 N 页
}

/** 渲染 + 识别整本（带并发与页数上限）。约 1-2 秒/页，100 页的书 2-4 分钟。 */
export async function ocrPdf(
  /** 已经 getDocumentProxy 过的 PDF 文档（buffer 只能解析一次） */
  pdf: PdfDoc,
  opts: {
    maxPages?: number;
    scale?: number;
    concurrency?: number;
    lang?: string;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<OcrResult> {
  const maxPages = opts.maxPages ?? Number(process.env.TEXTBOOK_OCR_MAX_PAGES || 100);
  const scale = opts.scale ?? 1.8; // ≈130 DPI：文字可读、内存可控
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  const lang = opts.lang || process.env.TEXTBOOK_OCR_LANG || "chi_sim+eng";

  const total = Math.min(pdf.numPages, maxPages);
  const results: OcrPage[] = new Array(total);

  await fs.mkdir(OCR_CACHE_DIR, { recursive: true });

  // 变量形式的动态导入：打包器无法静态解析，原生模块不进部署产物。
  // 注意必须用 join 拼接而不是单一 const 字符串——esbuild 会做字面量传播，
  // const canvasModule = "@napi-rs/canvas" 这种写法照样会被静态解析（实测踩坑）。
  // 这两个包只支持本地 Node（Workers 上 OCR 分支已被路由层守卫拦下，不会执行到这里）。
  const tessModule = ["tesseract", "js"].join(".");
  const canvasModule = ["@napi-rs", "canvas"].join("/");

  // tesseract 的 worker 单线程，起 N 个并行吃页
  const { createWorker } = await import(/* webpackIgnore: true */ tessModule);
  const workers = await Promise.all(
    Array.from({ length: concurrency }, () => createWorker(lang, 1, { cachePath: OCR_CACHE_DIR }))
  );

  let next = 1;
  let done = 0;
  const runOne = async (workerIdx: number) => {
    for (;;) {
      const i = next;
      next += 1;
      if (i > total) return;
      try {
        const png = await renderPageAsImage(pdf, i, {
          canvasImport: async () => await import(/* webpackIgnore: true */ canvasModule),
          scale,
        });
        const { data } = await workers[workerIdx].recognize(Buffer.from(png));
        const clean = String(data?.text || "")
          .replace(/[ \t\u00a0]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        results[i - 1] = { page: i, text: clean };
      } catch {
        // 单页失败留空，不拖垮整本
        results[i - 1] = { page: i, text: "" };
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all(workers.map((_, i) => runOne(i)));
  await Promise.all(workers.map((w) => w.terminate()));

  return {
    pages: results.filter((r) => r && r.text.length >= 8),
    lang,
    truncated: pdf.numPages > total,
  };
}
