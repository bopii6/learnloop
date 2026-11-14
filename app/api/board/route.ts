// POST /api/board —— 白板课（对标 Hyperknow）服务端：
// action=start  → 生成本节"板卡脚本"（new_page + N×(board+speak) + circle + ask + reward），
//                 以 SSE 按 Hyperknow 帧格式下发（group/board/speak/new_page/circle/ask/reward_user/done）；
// action=answer → 有 ask：学员作答后的"讲师点评"；无 ask：课堂追问 / "没听懂"，讲师现场接住。
// 讲稿按（用户 × 课节）缓存：复习回放零成本。
// 计费与 /api/teach 同口径：首次开讲扣 COST_TEACHING_SESSION（生成失败退回），复习免费；
// 课堂追问不扣分，但每节课有 CHAT_LIMIT_PER_LECTURE 条上限；公网（R2 模式）必须登录。
import { NextRequest } from "next/server";
import { getCourseState } from "@/lib/agent/course";
import { buildLectureContext } from "@/lib/agent/lecture-context";
import { generateJson } from "@/lib/agent/llm";
import { getProfile } from "@/lib/profile";
import { userFromCookieHeader } from "@/lib/auth";
import { normalizeText } from "@/lib/board/snippet";
import { newPageId } from "@/lib/board/layout";
import { generateBoardImage, imageGenerationAvailable } from "@/lib/board/images";
import { CHAT_LIMIT_PER_LECTURE, COST_TEACHING_SESSION, refundCredits, trySpend } from "@/lib/credits";
import { bumpChatCount } from "@/lib/chat-limit";
import { storageMode } from "@/lib/storage";
import { BOARD_SYSTEM, ANSWER_SYSTEM, FOLLOWUP_SYSTEM, type BoardScript } from "@/lib/board/prompts";
import { logStruggle } from "@/lib/ops";
import { pagesForLecture } from "@/lib/textbook";
import { applyMedia, decideMedia } from "@/lib/board/media-plan";
import { generateBoardAnimation } from "@/lib/board/animation";
import type { BoardAction, BoardEvent } from "@/types/board";
import { boardScriptSchema } from "@/lib/agent/schemas";
import { groupActions } from "@/lib/board/actions";
import { loadBoardScript, saveBoardScript, type MediaTask } from "@/lib/board/script-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 归一化后的片段 → 卡面里的原句锚点（保留原文以便客户端匹配；匹配端各自归一化） */
function anchorFromCard(content: string, snippet?: string): string | undefined {
  if (!snippet) return undefined;
  const target = normalizeText(snippet);
  if (!target) return undefined;
  // 在原文里找到覆盖该归一化内容的原文片段（简单滑窗：按归一化长度截取）
  const flat = content.replace(/\s+/g, " ").trim();
  for (let len = Math.min(flat.length, target.length + 8); len >= Math.min(4, target.length); len--) {
    for (let i = 0; i + len <= flat.length; i++) {
      const piece = flat.slice(i, i + len);
      if (normalizeText(piece) === target) return piece;
    }
  }
  return undefined;
}

function scriptToActions(
  script: BoardScript,
  pageId: string,
  pageTitle: string,
  opts?: { append?: boolean; uidStart?: number }
): { actions: BoardAction[]; media: MediaTask[] } {
  const actions: BoardAction[] = [];
  const media: MediaTask[] = [];
  let step = 0;
  let uid = opts?.uidStart ?? 0;
  if (!opts?.append) {
    actions.push({ type: "new_page", step_id: step++, page_id: pageId, title: pageTitle });
  }
  let imageCount = 0;
  let animCount = 0;
  for (const card of script.cards || []) {
    const content = String(card.content || "").trim();
    const speak = String(card.speak || "").trim();
    if (!content) continue;
    const boardStep = step++;
    actions.push({
      type: "board",
      step_id: boardStep,
      board_uid: uid++,
      page_id: pageId,
      board_content: content,
    });
    if (speak) actions.push({ type: "speak", step_id: step++, spoken_text: speak });
    const anchor = anchorFromCard(content, card.circle);
    if (anchor) {
      actions.push({
        type: "circle",
        step_id: step++,
        target_board_id: uid - 1,
        page_id: pageId,
        snippet: anchor,
      });
    }
    // 配图（整段最多 2 张）
    const imgPrompt = card.image?.prompt ? String(card.image.prompt).slice(0, 600) : "";
    if (imgPrompt && imageCount < 2) {
      imageCount += 1;
      const pendingStep = step++;
      const placementStep = step++;
      const caption = card.image?.caption ? String(card.image.caption).slice(0, 16) : undefined;
      actions.push({
        type: "image_gen_pending",
        step_id: pendingStep,
        placement_step_id: placementStep,
        page_id: pageId,
        caption,
        prompt_preview: imgPrompt.slice(0, 120),
      });
      media.push({ kind: "image", caption, prompt: imgPrompt, genStep: pendingStep, placementStep, pageId });
    }
    // 互动动画（整段最多 1 个）
    const animTask = card.animation?.task ? String(card.animation.task).slice(0, 400) : "";
    if (animTask && animCount < 1) {
      animCount += 1;
      const pendingStep = step++;
      const placementStep = step++;
      actions.push({
        type: "animation_pending",
        step_id: pendingStep,
        placement_step_id: placementStep,
        page_id: pageId,
        task_preview: animTask.slice(0, 120),
      });
      media.push({ kind: "animation", task: animTask, genStep: pendingStep, placementStep, pageId });
    }
  }
  if (script.ask?.question && Array.isArray(script.ask.options) && script.ask.options.length >= 2) {
    actions.push({
      type: "ask",
      step_id: step++,
      mode: "choice",
      question: String(script.ask.question).slice(0, 60),
      // 选项留足长度：模型常写代码式选项，切到 18 字会把差异截没（实测踩过）
      options: script.ask.options.slice(0, 4).map((o) => String(o).replace(/`/g, "").trim().slice(0, 30)),
      correct_index: typeof script.ask.correct_index === "number" ? script.ask.correct_index : undefined,
      explanation: script.ask.explanation ? String(script.ask.explanation).slice(0, 80) : undefined,
    });
  }
  if (script.reward?.title) {
    actions.push({
      type: "reward_user",
      step_id: step++,
      master_concept_title: String(script.reward.title).slice(0, 12),
      master_concept_description: String(script.reward.description || "").slice(0, 40),
    });
  }
  actions.push({ type: "done", step_id: step++ });
  return { actions, media };
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    courseId?: string;
    unitId?: string;
    lectureId?: string;
    message?: string;
    /** 作答点评要追加到的页（客户端当前页）；缺省则新开一页 */
    pageId?: string;
    ask?: { question: string; options: string[]; correct_index?: number };
    /** 学员按了"没听懂"：讲师换角度重讲，并记入卡点埋点 */
    simpler?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (e: BoardEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // 客户端断开
        }
      };
      try {
        const state = await getCourseState(body.courseId || "");
        if (!state?.outline) {
          await send({ type: "error", message: "course not found" });
          controller.close();
          return;
        }
        const ctx = buildLectureContext(state.outline, body.unitId || "", body.lectureId || "");
        if (!ctx) {
          await send({ type: "error", message: "lecture not found" });
          controller.close();
          return;
        }
        const me = await userFromCookieHeader(req.headers.get("cookie"));
        if (!me && storageMode === "r2") {
          await send({ type: "auth_required", message: "登录后就能开始上课（课堂进度与积分跟着账号走）" });
          controller.close();
          return;
        }
        const profile = await getProfile(me?.id);

        // 事实来源：教材页优先，其次建课时读到的网页正文。
        // 教材模式按本节课挑最相关的页（词命中优先，全书均摊兜底——保证整本书都会被讲到），摘录带页码。
        let referenceMaterial = "";
        let lectureIndex = 0;
        let totalLectures = 0;
        for (const u of state.outline.units) {
          const j = u.lectures.findIndex((l) => l.id === (body.lectureId || ""));
          if (j >= 0) lectureIndex = totalLectures + j;
          totalLectures += u.lectures.length;
        }
        const textbookPages = state.textbook?.pages?.length
          ? pagesForLecture(state.textbook, ctx.lectureTitle, [...(ctx.keyConcepts || []), ctx.lectureSummary], lectureIndex, totalLectures, 3)
          : [];
        if (textbookPages.length > 0) {
          referenceMaterial = textbookPages
            .map((p) => `【教材《${state.textbook!.title}》第 ${p.page} 页】\n${p.text.slice(0, 1200)}`)
            .join("\n\n");
        } else if (state.sources?.length && state.pageContents) {
          const blocks: string[] = [];
          for (const s of state.sources) {
            const t = state.pageContents[String(s.index)];
            if (!t) continue;
            blocks.push(`《${s.title}》（${s.domain}）：${t.slice(0, 1200)}`);
            if (blocks.length >= 3) break;
          }
          referenceMaterial = blocks.join("\n\n");
        }

        const capstone = (state.outline as { capstone?: { name?: string; description?: string } }).capstone;
        const capstoneLine = capstone?.name ? `学员的结课作品：${capstone.name}${capstone.description ? `（${capstone.description}）` : ""}。例子尽量落在他的作品场景里。` : "";
        const profileLine = profile.summary ? `学员画像：${profile.summary}` : "";
        const nameLine = profile.name ? `称呼学员「${profile.name}」。` : "";
        // 连续剧前情：同单元前面已讲过的内容，开场接住、不重讲
        const prevLine = ctx.previousLectures?.length
          ? `本单元前面已讲过：${ctx.previousLectures.map((l) => `《${l.title}》`).join("、")}。开场一句话接住上一讲，不要重讲。`
          : "";

        // 作答点评追加到客户端当前页；开讲则新开一页
        const pageId =
          body.action === "answer" && typeof body.pageId === "string" && body.pageId
            ? body.pageId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)
            : newPageId();
        const appendToPage = body.action === "answer" && pageId === body.pageId;

        if (body.action === "answer") {
          const guard = await bumpChatCount(me?.id, body.courseId || "", body.unitId || "", body.lectureId || "", CHAT_LIMIT_PER_LECTURE);
          if (!guard.ok) {
            await send({ type: "error", message: `本节课的提问已达上限（${CHAT_LIMIT_PER_LECTURE} 条）。换个课节继续，或明天再来复习巩固。` });
            controller.close();
            return;
          }
          const message = (body.message || "").slice(0, 300);
          if (body.simpler) {
            await logStruggle({ userId: me?.id, courseId: body.courseId || "", unitId: body.unitId, lectureId: body.lectureId || "" });
          }
          const lessonLine = `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）\n课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}`;
          const script = body.ask
            ? await generateJson<BoardScript>(
                ANSWER_SYSTEM,
                `${lessonLine}\n课堂题：${body.ask.question}\n选项：${(body.ask.options || []).join(" / ")}\n学员的回答：${message}\n${profileLine}\n请生成点评。`,
                { task: "script", maxTokens: 1200, schema: boardScriptSchema }
              )
            : await generateJson<BoardScript>(
                FOLLOWUP_SYSTEM,
                `${lessonLine}\n${profileLine}\n学员说：${message}\n请接住他。`,
                { task: "script", maxTokens: 1400, schema: boardScriptSchema }
              );
          if (!script?.cards?.length) {
            await send({ type: "error", message: "讲师这次没接住，再问一次试试。" });
            controller.close();
            return;
          }
          // 徽章只在本节剧本结尾发一次；点评 / 追问不另发
          delete script.reward;
          const { actions } = scriptToActions(script || { cards: [] }, pageId, ctx.lectureTitle, { append: appendToPage });
          for (const g of groupActions(actions)) await send({ type: "group", actions: g });
          await send({ type: "response_complete", is_complete: true, status: "completed" });
          controller.close();
          return;
        }

        // ---- start：讲稿缓存命中 = 复习回放（不生成、不计费） ----
        const cached = await loadBoardScript(body.courseId || "", body.unitId || "", body.lectureId || "", me?.id);
        let actions: BoardAction[];
        let media: MediaTask[] = [];
        let usedPageId: string;
        if (cached?.actions?.length) {
          actions = cached.actions;
          media = cached.media || [];
          usedPageId = cached.pageId;
        } else {
          // 首次开讲：先扣分再生成，生成失败退回（只为成功交付的课付费）
          let spent = false;
          if (me) {
            const spend = await trySpend(me.id, COST_TEACHING_SESSION, `白板课堂：${(ctx.lectureTitle || "").slice(0, 24)}`);
            if (!spend.ok) {
              await send({ type: "credits_block", balance: spend.balance, need: COST_TEACHING_SESSION });
              controller.close();
              return;
            }
            spent = true;
          }
          const script = await generateJson<BoardScript>(
            BOARD_SYSTEM,
            `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}
本单元：${ctx.unitTitle}${ctx.keyConcepts?.length ? `（关键概念：${ctx.keyConcepts.join("、")}）` : ""}
${nameLine}${profileLine}${capstoneLine}${prevLine}
${referenceMaterial ? `参考资料（事实、数字、案例优先取自这里）：\n${referenceMaterial.slice(0, 4000)}` : "没有参考资料：按你的知识讲，不发明统计数字。"}

请生成这个教学段的白板脚本（6-9 张卡 + 课堂题 + 徽章）。`, { task: "script", maxTokens: 2600, schema: boardScriptSchema }
          );
          if (!script?.cards?.length) {
            if (spent && me) await refundCredits(me.id, COST_TEACHING_SESSION, "课堂生成失败退回");
            await send({ type: "error", message: "讲师备课失败了，积分已退回。请稍后重试。" });
            controller.close();
            return;
          }
          // 媒体导演：独立一次调用，决定动画/配图（失败则纯文字课，不阻塞）
          const cleanScript: BoardScript = script;
          try {
            const decision = await decideMedia(cleanScript.cards || []);
            applyMedia(cleanScript.cards || [], decision);
          } catch {
            // 媒体决策失败不阻塞
          }
          if (!imageGenerationAvailable()) {
            for (const c of cleanScript.cards || []) delete c.image;
          }
          const built = scriptToActions(cleanScript, pageId, ctx.lectureTitle);
          actions = built.actions;
          media = built.media;
          usedPageId = pageId;
          try {
            await saveBoardScript(body.courseId || "", body.unitId || "", body.lectureId || "", me?.id, {
              actions,
              media,
              pageId,
              generatedAt: Date.now(),
            });
          } catch {
            // 缓存失败不影响本次开讲
          }
        }

        await send({
          type: "session_ready",
          session_id: `${body.courseId}__${body.lectureId}`,
          session_title: ctx.lectureTitle,
          status: "active",
        });
        for (const g of groupActions(actions)) await send({ type: "group", actions: g });

        // ---- 富媒体：占位已在剧本里，这里并行生成并回填（图片按 prompt 哈希缓存，复习零成本） ----
        if (media.length > 0) {
          await Promise.allSettled(
            media.map(async (m) => {
              try {
                if (m.kind === "image" && m.prompt) {
                  const asset = await generateBoardImage(m.prompt);
                  await send({
                    type: "generated_image",
                    step_id: m.genStep,
                    placement_step_id: m.placementStep,
                    page_id: m.pageId,
                    image_url: asset.url,
                    width: asset.width,
                    height: asset.height,
                    caption: m.caption,
                  });
                } else if (m.kind === "animation" && m.task) {
                  const html = await generateBoardAnimation(m.task);
                  await send({
                    type: "generated_animation",
                    step_id: m.genStep,
                    placement_step_id: m.placementStep,
                    page_id: m.pageId,
                    html,
                    task: m.task,
                  });
                }
              } catch (e) {
                // 媒体失败不阻塞课程：通知客户端撤掉占位卡
                console.error("[board] media failed:", e instanceof Error ? e.message : e);
                await send({ type: "media_failed", step_id: m.genStep, placement_step_id: m.placementStep, kind: m.kind });
              }
            })
          );
        }

        await send({ type: "response_complete", is_complete: true, status: "completed" });
        void usedPageId;
      } catch (e) {
        await send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
