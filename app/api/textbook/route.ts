// POST /api/textbook —— 上传教材：抽逐页文本 + 启发式提取目录标题，存存储抽象层（本地 data/ 或 R2）
// 两种入参：
// - application/json { filename, pageTexts[] }：浏览器端已抽取的逐页文字（首选路径。
//   Workers 免费版 10ms CPU/128MB 内存扛不动服务端 pdf.js 解析，解析必须在客户端完成）
// - multipart/form-data { file }：原始 PDF（扫描版回退路径，本地走 lib/ocr；云端无位图渲染会明确 422）
// 教材是后续建课与教学的 grounding 来源：课程蓝图镜像它的目录，讲解标注它的页码。
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { extractTocCandidates, loadTextbook, assessTextbook, type TextbookDoc } from "@/lib/textbook";
import { ocrPdf } from "@/lib/ocr";
import { userFromCookieHeader } from "@/lib/auth";
import { writeJson, storageMode } from "@/lib/storage";

const MAX_JSON_BYTES = 20 * 1024 * 1024; // 逐页文字的 JSON 体积上限
const MAX_PAGES = 1500;
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MIN_TEXT_RATIO = 0.6; // 有效文字页占比低于此 → 判定为扫描版

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600; // 扫描版 OCR 可能要几分钟

export async function POST(req: NextRequest) {
  try {
    const ctype = req.headers.get("content-type") || "";
    const isJson = ctype.includes("application/json");
    let filename = "教材";
    let pageTexts: string[];
    let parsedPdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;

    if (isJson) {
      const raw = await req.text();
      if (raw.length > MAX_JSON_BYTES) {
        return NextResponse.json({ error: "解析结果太大（>20MB），请拆分文档后重试" }, { status: 413 });
      }
      let body: { filename?: unknown; pageTexts?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
      }
      if (!Array.isArray(body.pageTexts) || body.pageTexts.length === 0) {
        return NextResponse.json({ error: "缺少 pageTexts" }, { status: 400 });
      }
      if (body.pageTexts.length > MAX_PAGES) {
        return NextResponse.json({ error: `页数超过上限（${MAX_PAGES} 页），请拆分文档` }, { status: 400 });
      }
      filename =
        String(body.filename ?? "")
          .replace(/\.pdf$/i, "")
          .slice(0, 60) || "教材";
      pageTexts = body.pageTexts.map((t) => String(t ?? ""));
    } else {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "missing file" }, { status: 400 });
      }
      if (!/\.pdf$/i.test(file.name)) {
        return NextResponse.json({ error: "只支持 PDF 文件" }, { status: 400 });
      }
      // 一本教材最多几十 MB；再大先拒掉（多半也是扫描版的图片堆）
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: "文件太大（>80MB）" }, { status: 400 });
      }
      filename = file.name.replace(/\.pdf$/i, "").slice(0, 60) || "教材";
      const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
      const { text } = await extractText(pdf, { mergePages: false });
      pageTexts = Array.isArray(text) ? text : [String(text ?? "")];
      parsedPdf = pdf;
    }

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
    if (textRatio < MIN_TEXT_RATIO && isJson) {
      // JSON 路径没有原文件，无从 OCR
      return NextResponse.json(
        { error: "检测到扫描版 PDF（无文字层）。请使用文字版 PDF。" },
        { status: 422 }
      );
    }
    if (textRatio < MIN_TEXT_RATIO && process.env.RUNTIME === "workers") {
      // Workers 上没有本地位图渲染（原生 canvas），OCR 暂不可用；方案是把 OCR 移到浏览器端
      return NextResponse.json(
        { error: "检测到扫描版 PDF（无文字层）。云端部署暂不支持 OCR 识别，请使用文字版 PDF，或在本地版本上传。" },
        { status: 422 }
      );
    }
    if (textRatio < MIN_TEXT_RATIO) {
      // 注意传已解析的 pdf 文档：buffer 经 pdf.js transfer 后已 detach，不能二次解析
      const ocr = await ocrPdf(parsedPdf!, {
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

    const me = await userFromCookieHeader(req.headers.get("cookie"));
    const doc: TextbookDoc = {
      id: `tb-${randomUUID().slice(0, 10)}`,
      title: filename,
      pageCount: pageTexts.length,
      pages,
      toc: extractTocCandidates(pages),
      owner: me?.id,
      uploadedAt: Date.now(),
    };

    await writeJson(`textbooks/${doc.id}.json`, doc);

    // 文档体量评估：太薄的文档撑不起系统课，提前告知用户（不阻断，由用户决定）
    const assessment = assessTextbook(doc);
    const thinNotice = assessment.thin
      ? `这份文档只有约 ${assessment.totalChars} 字，内容量撑不起一门长课。可以继续生成——课程会以它为纲、用联网资料扩充，但"原文精讲"的部分会比较短。`
      : undefined;

    return NextResponse.json({
      id: doc.id,
      title: doc.title,
      pageCount: doc.pageCount,
      textPages: pages.length,
      totalChars: assessment.totalChars,
      thin: assessment.thin,
      tocCount: doc.toc.length,
      toc: doc.toc.slice(0, 40),
      ocr: ocrInfo.used,
      ocrLang: ocrInfo.lang,
      truncated: ocrInfo.truncated === true,
      notice: [thinNotice, ocrInfo.used ? `扫描版已通过 OCR 识别（共 ${pages.length} 页有效内容）${ocrInfo.truncated ? "，超过页数上限只识别了前一部分" : ""}。识别质量取决于扫描清晰度，建议抽查课程内容。` : undefined]
        .filter(Boolean)
        .join(" "),
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
