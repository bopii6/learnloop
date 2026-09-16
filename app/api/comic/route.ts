// POST /api/comic —— 连环画课堂（原型）
// action:
//   "storyboard"  一节课 → 分镜脚本（LLM）
//   "panel_image" 一格 → 万相出图，落盘 public/comics/<hash>.png，返回本地 URL（同提示词命中缓存秒回）
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import { runComicStoryboard, runComicSceneStoryboard, runComicKnowledgeStoryboard, generatePanelImage, comicChannelKey } from "@/lib/agent/comic";
import { buildFullLectureContext } from "@/lib/agent/lecture-ctx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMICS_DIR = path.join(process.cwd(), "public", "comics");

async function cachedPanelImage(prompt: string): Promise<string> {
  // 缓存键带通道：换出图通道=换画风，旧通道的缓存不能复用
  const hash = createHash("md5").update(`${comicChannelKey()}|${prompt}`).digest("hex").slice(0, 20);
  const file = path.join(COMICS_DIR, `${hash}.png`);
  try {
    await readFile(file); // 命中缓存
    return `/comics/${hash}.png`;
  } catch {
    // 未命中，继续生成
  }
  const gen = await generatePanelImage(prompt);
  let bytes: Buffer;
  if (gen.b64) {
    bytes = Buffer.from(gen.b64, "base64");
  } else {
    const res = await fetch(gen.url!);
    if (!res.ok) throw new Error(`图片下载失败：${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  await mkdir(COMICS_DIR, { recursive: true });
  await writeFile(file, bytes);
  return `/comics/${hash}.png`;
}

export async function POST(req: NextRequest) {
  let body: {
    action?: "storyboard" | "storyboard_scene" | "storyboard_knowledge" | "panel_image";
    courseId?: string;
    unitId?: string;
    lectureId?: string;
    index?: number;
    scene?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    if (body.action === "storyboard_knowledge") {
      // 知识地图长图版（Harness Map 版式）：烦恼/办法对照卡 + 总览流程 + 度量表
      const sbKey = `kb_${(body.courseId || "")}_${(body.unitId || "")}_${(body.lectureId || "")}`.replace(/[^a-zA-Z0-9_-]/g, "");
      const sbFile = path.join(process.cwd(), "data", "comic-storyboards", `${sbKey}.json`);
      try {
        const cached = JSON.parse(await readFile(sbFile, "utf8"));
        return Response.json(cached);
      } catch {
        // 未命中，正常生成
      }
      const ctx = await buildFullLectureContext(req, body);
      if (!ctx) return Response.json({ error: "course or lecture not found" }, { status: 404 });
      const storyboard = await runComicKnowledgeStoryboard(ctx);
      const payload = {
        meta: { courseTitle: ctx.courseTitle, lectureTitle: ctx.lectureTitle, studentName: ctx.studentName || "" },
        storyboard,
      };
      await mkdir(path.dirname(sbFile), { recursive: true });
      await writeFile(sbFile, JSON.stringify(payload));
      return Response.json(payload);
    }

    if (body.action === "storyboard_scene") {
      // 手绘引擎（Excalidraw）用的结构化分镜：道具目录摆位，无图费
      const sbKey = `scene_${(body.courseId || "")}_${(body.unitId || "")}_${(body.lectureId || "")}`.replace(/[^a-zA-Z0-9_-]/g, "");
      const sbFile = path.join(process.cwd(), "data", "comic-storyboards", `${sbKey}.json`);
      try {
        const cached = JSON.parse(await readFile(sbFile, "utf8"));
        return Response.json(cached);
      } catch {
        // 未命中，正常生成
      }
      const ctx = await buildFullLectureContext(req, body);
      if (!ctx) return Response.json({ error: "course or lecture not found" }, { status: 404 });
      const storyboard = await runComicSceneStoryboard(ctx);
      const payload = {
        meta: { courseTitle: ctx.courseTitle, lectureTitle: ctx.lectureTitle, studentName: ctx.studentName || "" },
        storyboard,
      };
      await mkdir(path.dirname(sbFile), { recursive: true });
      await writeFile(sbFile, JSON.stringify(payload));
      return Response.json(payload);
    }

    if (body.action === "storyboard") {
      // 分镜落盘缓存：同一讲复用同一版分镜——否则每次刷新重新分镜，图缓存全失效、14 格重画
      const sbKey = `${body.courseId || ""}_${body.unitId || ""}_${body.lectureId || ""}`.replace(/[^a-zA-Z0-9_-]/g, "");
      const sbFile = path.join(process.cwd(), "data", "comic-storyboards", `${sbKey}.json`);
      try {
        const cached = JSON.parse(await readFile(sbFile, "utf8"));
        return Response.json(cached);
      } catch {
        // 未命中，正常生成
      }
      const ctx = await buildFullLectureContext(req, body);
      if (!ctx) return Response.json({ error: "course or lecture not found" }, { status: 404 });
      const storyboard = await runComicStoryboard(ctx);
      const payload = {
        meta: { courseTitle: ctx.courseTitle, lectureTitle: ctx.lectureTitle, studentName: ctx.studentName || "" },
        storyboard,
      };
      await mkdir(path.dirname(sbFile), { recursive: true });
      await writeFile(sbFile, JSON.stringify(payload));
      return Response.json(payload);
    }

    if (body.action === "panel_image") {
      const scene = String(body.scene || "").trim();
      if (!scene) return Response.json({ error: "scene required" }, { status: 400 });
      const url = await cachedPanelImage(scene);
      return Response.json({ url, index: body.index });
    }

    return Response.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
