// POST /api/textbook —— 上传教材 PDF：抽逐页文本 + 启发式提取目录标题
// 有文字层的 PDF 直接抽取；扫描版（无文字层）自动走 OCR（lib/ocr，较慢）。
// 教材是后续建课与教学的 grounding 来源：课程蓝图镜像它的目录，讲解标注它的页码。
// 教材文档经存储抽象层持久化（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）。
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { extractTocCandidates, loadTextbook, type TextbookDoc } from "@/lib/textbook";
import { ocrPdf } from "@/lib/ocr";
import { userFromCookieHeader } from "@/lib/auth";
import { writeJson, storageMode } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600; // 扫描版 OCR 可能要几分钟

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing file" }, { status: 400 });
    }
    if (!/\.pdf$/i.test(file.name)) {
      return NextResponse.json({ error: "只支持 PDF 文件" }, { status: 400 });
    }
    // 一本教材最多几十 MB；再大先拒掉（多半也是扫描版的图片堆）
    if (file.size > 80 * 1024 * 1024) {
      return NextResponse.json({ error: "文件太大（>80MB）" }, { status: 400 });
    }

    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: false });
    const pageTexts: string[] = Array.isArray(text) ? text : [String(text ?? "")];

    // 清理：压缩空白；丢掉几乎没有文字的页（封面/整页图片）
    let pages = pageTexts
      .map((t, i) => ({
        page: i + 1,
        text: String(t || "")
          .replace(/[ \t\u00a0]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      }))
      .filter((p) => p.text.length >= 20);

    // ---- 扫描版检测：有效文字页占比过低 → 走 OCR ----
    let ocrInfo: { used: boolean; lang?: string; truncated?: boolean } = { used: false };
    const textRatio = pages.length / Math.max(1, pageTexts.length);
    if (textRatio < 0.6 && process.env.RUNTIME === "workers") {
      // Workers 上没有本地位图渲染（原生 canvas），OCR 暂不可用；方案是把 OCR 移到浏览器端
      return NextResponse.json(
        { error: "检测到扫描版 PDF（无文字层）。云端部署暂不支持 OCR 识别，请使用文字版 PDF，或在本地版本上传。" },
        { status: 422 }
      );
    }
    if (textRatio < 0.6) {
      // 注意传已解析的 pdf 文档：buffer 经 pdf.js transfer 后已 detach，不能二次解析
      const ocr = await ocrPdf(pdf, {
        onProgress: (done, total) => {
          // 进度写日志；HTTP 语义下不向前端推流，前端以"识别中"状态呈现
          if (done % 10 === 0 || done === total) console.log(`[textbook-ocr] ${done}/${total}`);
        },
      });
      if (ocr.pages.length === 0) {
        return NextResponse.json(
          { error: "这本 PDF 既没有文字层，OCR 也没认出内容。请确认不是加密/损坏文件，或先转成图片清晰的版本再试。" },
          { status: 422 }
        );
      }
      pages = ocr.pages;
      ocrInfo = { used: true, lang: ocr.lang, truncated: ocr.truncated };
    }

    if (pages.length === 0) {
      return NextResponse.json(
        { error: "这本 PDF 没有可提取的文字层（可能是扫描版）。请换文字版 PDF，或先把关键章节拍照转文字。" },
        { status: 422 }
      );
    }

    const title = file.name.replace(/\.pdf$/i, "").slice(0, 60) || "教材";
    const me = await userFromCookieHeader(req.headers.get("cookie"));
    const doc: TextbookDoc = {
      id: `tb-${randomUUID().slice(0, 10)}`,
      title,
      pageCount: pageTexts.length,
      pages,
      toc: extractTocCandidates(pages),
      owner: me?.id,
      uploadedAt: Date.now(),
    };

    await writeJson(`textbooks/${doc.id}.json`, doc);

    return NextResponse.json({
      id: doc.id,
      title: doc.title,
      pageCount: doc.pageCount,
      textPages: pages.length,
      tocCount: doc.toc.length,
      toc: doc.toc.slice(0, 40),
      ocr: ocrInfo.used,
      ocrLang: ocrInfo.lang,
      truncated: ocrInfo.truncated === true,
      notice: ocrInfo.used
        ? `扫描版已通过 OCR 识别（共 ${pages.length} 页有效内容）${ocrInfo.truncated ? "，超过页数上限只识别了前一部分" : ""}。识别质量取决于扫描清晰度，建议抽查课程内容。`
        : undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "PDF 解析失败：" + (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const doc = await loadTextbook(id);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    id: doc.id,
    title: doc.title,
    pageCount: doc.pageCount,
    toc: doc.toc,
  });
}
