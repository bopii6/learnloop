// POST /api/course —— 课程生成 SSE 流式接口
// 流程：start(搜索+第1轮澄清) → answer(后续澄清轮) → 蓝图 → generate(确认后生成大纲)
import { NextRequest } from "next/server";
import { generateJson, streamAnswer } from "@/lib/agent/llm";
import { randomUUID } from "crypto";
import {
  runSearchStep,
  runClarifyStep,
  runBlueprintStep,
  runOutlineStep,
  getCourseState,
  setCourseState,
} from "@/lib/agent/course";
import { getProfile, captureCourseProfile, profileText, profileHintForClarify } from "@/lib/profile";
import { constraintsBlock } from "@/lib/agent/lang";
import { loadTextbook, textbookToSources, buildTextbookExcerpt } from "@/lib/textbook";
import { userFromCookieHeader } from "@/lib/auth";
import { COST_COURSE_GENERATE, getBalance, refundCredits, trySpend } from "@/lib/credits";
import { storageMode } from "@/lib/storage";
import { drainToUsage, ipSubject, logOpsError } from "@/lib/ops";
import type { CourseEvent, SourceItem, TextbookPage } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 把已读网页压缩成给 LLM 的资料摘要（top 4 页 × 1800 字符，控 token 预算） */
function buildPageExcerpts(
  sources: { index: number; title: string; domain: string }[],
  pageContents: Record<string, string>
): string {
  const blocks: string[] = [];
  for (const s of sources) {
    const text = pageContents[String(s.index)];
    if (!text) continue;
    blocks.push(`《${s.title}》（${s.domain}）：${text.slice(0, 1800)}`);
    if (blocks.length >= 4) break;
  }
  return blocks.join("\n\n");
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    courseId?: string;
    query?: string;
    answer?: string;
    feedback?: string;
    courseSource?: string;
    textbookId?: string; // 教材模式：对着上传的课本建课
    blueprint?: any; // 前端编辑后的蓝图
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const action = body.action || "start";
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (e: CourseEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // 客户端已断开
        }
      };

      // 组装用户输入 + 课程来源（自学/学校同步）作为澄清语境
      const withSource = (q: string, source?: string) =>
        source === "学校同步" ? `${q}（课程来源：学校同步，需要贴合学校课程进度与考试要求）` : q;

      // 登录用户 = 课程归属者（未登录本地自用，无主数据所有人可见）；所有 action 分支共用
      const me = await userFromCookieHeader(req.headers.get("cookie"));

      try {
        if (action === "start") {
          // 教材模式：上传了课本就对着课本建课；query 可以为空
          const tb = body.textbookId ? await loadTextbook(body.textbookId) : null;
          if (body.textbookId && !tb) {
            await send({ type: "error", message: "textbook not found" });
            controller.close();
            return;
          }
          let query = (body.query || "").trim();
          if (!query && tb) query = `系统学习《${tb.title}》教材`;
          if (!query) {
            await send({ type: "error", message: "empty query" });
            controller.close();
            return;
          }

          // 积分预检：在大括其前先告诉用户"分不够"，而不是让他做完搜索+澄清+蓝图编辑
          // （约 2 分钟投入）后才在扣费点撞墙。查询免费，扣费点仍在最贵的大纲步骤不变。
          if (me && (await getBalance(me.id)) < COST_COURSE_GENERATE) {
            await send({
              type: "credits_block",
              balance: await getBalance(me.id),
              need: COST_COURSE_GENERATE,
              reason: "生成课程大纲",
            });
            controller.close();
            return;
          }

          const courseId = `course-${randomUUID().slice(0, 8)}`;

          // 学习者画像：注入澄清提问（避免重复问已覆盖的维度）；按登录用户隔离
          const profile = await getProfile(me?.id);

          // 需求抽取：用户在输入框里说的要求（输出语言、水平、风格……）原样贯穿整条管线。
          // 教材模式没有意图门卫，单独跑一次轻量抽取（实测教训：英文 PDF + "弄成中文"
          // 曾被当成搜索关键词去搜"AI 课程 中文"——约束必须是管线的一等参数，不能靠路由捎带）。
          let outputLanguage = "中文";
          let constraints: string[] = [];
          let constraintsText = "";
          if (tb) {
            const extract = await generateJson<{ outputLanguage?: string; constraints?: string[] }>(
              `你是建课需求抽取器。用户上传了一份文档来生成课程，并附了一句话。认真对待这句话：他说的是对课程产出的要求，不是搜索词。
- outputLanguage：希望课程用什么语言输出，没提就默认"中文"；他怎么说都照记（"弄成中文""要西班牙语的""英文吧"都算）。
- constraints：其他明确要求逐条提取，保留原话关键词，每条 ≤ 60 字。没提的不要编；不要把文档主题本身当要求。
只输出 JSON：{"outputLanguage":"中文","constraints":[]}`,
              `用户上传文档：《${tb.title}》\n用户附言：${query}`,
              300
            );
            outputLanguage = String(extract?.outputLanguage || "中文").trim() || "中文";
            constraints = (Array.isArray(extract?.constraints) ? extract!.constraints : [])
              .map((c) => String(c).slice(0, 60))
              .filter(Boolean)
              .slice(0, 6);
            constraintsText = constraintsBlock(outputLanguage, constraints);
          }

          let sources: SourceItem[];
          let pageContents: Record<number, string>;
          let excerpts: string;
          let textbookState: { id: string; title: string; toc: string[]; pages: TextbookPage[] } | undefined;

          if (tb) {
            // 文档建课模式（1:1 Hyperknow）：第 1 步「正在查看你的文档」显式成阶段，
            // 之后照常联网搜索补充资料（第 2 步），管线共 5 步。
            await send({
              type: "stage",
              name: "reading_doc",
              label: "正在查看你的文档",
              status: "start",
              detail: `第 1 步，共 5 步`,
            });
            const conv = textbookToSources(tb);
            sources = conv.sources;
            pageContents = conv.pageContents;
            excerpts = buildTextbookExcerpt(tb);
            await send({ type: "sources", items: sources });
            await send({
              type: "stage",
              name: "reading_doc",
              label: "正在查看你的文档",
              status: "end",
              detail: `读完《${tb.title}》· ${tb.pageCount} 页`,
            });
            textbookState = { id: tb.id, title: tb.title, toc: tb.toc, pages: tb.pages };

            // 第 2 步：围绕文档主题联网补充（文档是主料，网络来源限 4 条）
            const web = await runSearchStep({
              query,
              history: [],
              emit: send,
              stepNo: 2,
              stepTotal: 5,
              docContext: excerpts,
              existingSources: sources,
              existingPages: pageContents,
              readLimit: 3,
              constraintsText,
            });
            sources = web.sources;
            pageContents = web.pageContents;
            excerpts = [
              excerpts,
              buildPageExcerpts(
                web.sources.filter((s) => s.domain !== "教材"),
                web.pageContents
              ),
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            // 意图门卫（三向 + 需求抽取）：建课 / 真问题（带引用回答，不建课）/ 纯闲聊。
            // 用户只有一个输入框，误触"你好"或随手一个疑问都不该硬造一门课；
            // 用户在输入框里说的一切要求（输出语言、水平、风格……）都被当作正经需求
            // 原样提取并贯穿整条建课管线，而不是被路由碾平（实测教训：英文 PDF + "弄成
            // 中文"被当成搜索关键词去搜"AI 课程 中文"）。
            const intent = await generateJson<{ mode: "course" | "answer" | "chat"; reply?: string; outputLanguage?: string; constraints?: string[] }>(
              `你是学习助手 Superlearn 的入口分流器。产品定位：用户输入一个主题，我们生成一门系统课程。用户只有一个输入框，输入可能是：
- "course"：想系统学习某个主题/技能/概念（哪怕只写了主题词，如"机器学习"、"雅思备考"、"高中函数"）
- "answer"：一个具体的知识性疑问，期望直接得到回答而非一门课（如"1+1为什么等于2"、"RAG和微调有什么区别"、"什么是MCP协议"）
- "chat"：问候、闲聊、与学习无关的求助（如"你好"、"你是谁"、"帮我写周报"）
判断规则：能成为一个课程主题的选 course；只是一个问题、答案几句话就能说清的选 answer；既不是学习也不是知识疑问的选 chat。
chat 时用 reply 字段给一句 60 字内的自然回复，友好地把话题引回"想系统学点什么"，可顺带回答闲聊本身。

mode 为 course 或 answer 时，额外做需求抽取（认真对待用户说的每一句话，他说的是需求，不是搜索词）：
- outputLanguage：用户希望课程/回答用什么语言输出。他没提就用"中文"。他怎么说都照记（"弄成中文""我想要西班牙语的""英文吧"都算）。
- constraints：除语言外的其他明确要求，逐条提取，保留用户原话关键词（如"我是零基础""多举游戏行业的例子""不要数学公式""讲深一点"）。用户没提的要求不要编。
只输出 JSON：{"mode":"course","outputLanguage":"中文","constraints":[]} 或 {"mode":"answer",...} 或 {"mode":"chat","reply":"..."}`,
              `用户输入：${query}`,
              400
            );
            if (intent?.mode === "chat") {
              await send({
                type: "chitchat_reply",
                reply:
                  (intent.reply || "这句更像闲聊～想系统学点什么？").trim() +
                  "\n（输入一个想学习的主题，我就帮你打造课程）",
              });
              controller.close();
              return;
            }
            if (intent?.mode === "answer") {
              // 问答回路：搜资料 → 带引用直接回答。不发 course 侧的 stage 事件，
              // 避免首页输入框被切进建课流程页。
              await send({ type: "qa_status", text: "这个问题不用开一门课，我直接去查资料回答你" });
              const stageMuted = async (e: CourseEvent) => {
                if (e.type === "stage") return; // 首页不渲染阶段轨
                await send(e);
              };
              const qa = await runSearchStep({ query, history: [], emit: stageMuted });
              const qaExcerpts = buildPageExcerpts(qa.sources, qa.pageContents);
              await send({ type: "qa_status", text: `读完 ${Object.keys(qa.pageContents).length} 份资料，正在组织回答…` });
              const topSources: SourceItem[] = qa.sources.slice(0, 4);
              const srcList = topSources
                .map((s) => `[${s.index}] 《${s.title}》（${s.domain}）：${(qa.pageContents[s.index] || s.snippet || "").slice(0, 1500)}`)
                .join("\n\n");
              let answer = "";
              try {
                answer = await streamAnswer(
                  `你是学习助手。用户随口问了一个具体问题（不是要一门课）。请直接回答：
- 200-400 字，先给结论再展开，机制层面讲清楚，不要客套
- 关键事实/数字/说法若来自资料，在句尾标 [n] 引用角标（n 对应资料编号）
- 资料不足以回答的部分用你的知识补齐，但不标注引用
- 结尾不加"希望对你有帮助"式的套话；可以自然地补一句"想系统学可以输入这个主题"
只输出回答正文（Markdown）。`,
                  `用户的问题：${query}\n\n参考资料：\n${srcList || "（未搜到可用资料，凭你的知识直接回答，不标引用）"}`,
                  () => {}
                );
              } catch {
                // 搜索/生成失败也要给个交代，不能静默无响应
              }
              await send({
                type: "qa_reply",
                reply:
                  answer.trim() ||
                  "这次没查到足够的资料，没敢随便答。你可以换个说法再问，或者直接输入想学的主题，我给你打造一门课。",
                sources: topSources,
              });
              controller.close();
              return;
            }

            // 门卫放行（course）：把意图门卫顺带抽取的需求装进管线公共变量
            outputLanguage = String(intent?.outputLanguage || "中文").trim() || "中文";
            constraints = (Array.isArray(intent?.constraints) ? intent!.constraints : [])
              .map((c) => String(c).slice(0, 60))
              .filter(Boolean)
              .slice(0, 6);
            constraintsText = constraintsBlock(outputLanguage, constraints);

            // 阶段 1：搜索 + 读取网页正文
            const r = await runSearchStep({ query, history: [], emit: send, constraintsText });
            sources = r.sources;
            pageContents = r.pageContents;
            excerpts = buildPageExcerpts(sources, pageContents);
          }

          // 阶段 3（文档模式）/ 2（纯文字）：第一轮澄清
          const { question, done } = await runClarifyStep({
            query: withSource(query, body.courseSource),
            history: [],
            sources,
            clarifyAnswers: [],
            round: 1,
            courseId,
            profileHint: profileHintForClarify(profile),
            pageExcerpts: excerpts,
            stepNo: tb ? 3 : 2,
            stepTotal: tb ? 5 : 4,
            constraintsText,
            emit: send,
          });

          await setCourseState(courseId, {
            step: done ? "blueprint" : "clarify",
            query,
            ownerId: me?.id,
            history: [],
            sources,
            pageContents,
            textbook: textbookState,
            docMode: Boolean(tb),
            docName: tb ? `${tb.title}.pdf` : undefined,
            courseSource: body.courseSource,
            outputLanguage,
            constraints,
            clarifyAnswers: [],
            clarifyRound: 1,
            currentQuestion: question?.question,
          });

          if (done) {
            // 不需要澄清，直接出蓝图（仍等用户确认后再生成大纲）
            const { blueprint } = await runBlueprintStep({
              query,
              clarifyAnswers: [],
              profileText: profileText(profile),
              pageExcerpts: excerpts,
              textbookHint: tb ? excerpts : undefined,
              outputLanguage,
              constraints,
              stepNo: tb ? 4 : 3,
              stepTotal: tb ? 5 : 4,
              emit: send,
            });
            const state = (await getCourseState(courseId))!;
            state.step = "blueprint";
            state.blueprint = blueprint;
            await setCourseState(courseId, state);
          }
        } else if (action === "answer") {
          const courseId = body.courseId || "";
          const answer = (body.answer || "").trim();
          const state = await getCourseState(courseId);

          if (!state) {
            await send({ type: "error", message: "course not found" });
            controller.close();
            return;
          }

          // 记录答案（带真实问题文本）
          state.clarifyAnswers.push({
            question: state.currentQuestion || `问题 ${state.clarifyRound}`,
            answer,
          });
          state.clarifyRound += 1;

          if (state.clarifyRound > 4) {
            // 澄清完成 → 出蓝图，停下等确认
            const { blueprint } = await runBlueprintStep({
              query: state.query,
              clarifyAnswers: state.clarifyAnswers,
              profileText: profileText(await getProfile(me?.id)),
              pageExcerpts: buildPageExcerpts(state.sources, state.pageContents || {}),
              textbookHint: state.textbook ? buildTextbookExcerpt(state.textbook) : undefined,
              outputLanguage: state.outputLanguage,
              constraints: state.constraints,
              stepNo: state.docMode ? 4 : 3,
              stepTotal: state.docMode ? 5 : 4,
              emit: send,
            });
            state.step = "blueprint";
            state.blueprint = blueprint;
            await setCourseState(courseId, state);
          } else {
            // 继续下一轮澄清（画像与资料摘要同样注入：不补的话第 2 轮起会重复问已覆盖的维度）
            const { question, done } = await runClarifyStep({
              query: withSource(state.query, state.courseSource),
              history: state.history,
              sources: state.sources,
              clarifyAnswers: state.clarifyAnswers,
              round: state.clarifyRound,
              courseId,
              profileHint: profileHintForClarify(await getProfile(me?.id)),
              pageExcerpts: buildPageExcerpts(state.sources, state.pageContents || {}),
              stepNo: state.docMode ? 3 : 2,
              stepTotal: state.docMode ? 5 : 4,
              emit: send,
            });
            state.currentQuestion = question?.question;

            if (done) {
              const { blueprint } = await runBlueprintStep({
                query: state.query,
                clarifyAnswers: state.clarifyAnswers,
                profileText: profileText(await getProfile(me?.id)),
                pageExcerpts: buildPageExcerpts(state.sources, state.pageContents || {}),
                textbookHint: state.textbook ? buildTextbookExcerpt(state.textbook) : undefined,
                stepNo: state.docMode ? 4 : 3,
                stepTotal: state.docMode ? 5 : 4,
                emit: send,
              });
              state.step = "blueprint";
              state.blueprint = blueprint;
            }
            await setCourseState(courseId, state);
          }
        } else if (action === "blueprint_feedback") {
          // 用户想修改蓝图：带反馈重新生成
          const courseId = body.courseId || "";
          const feedback = (body.feedback || "").trim();
          const state = await getCourseState(courseId);

          if (!state || state.step !== "blueprint") {
            await send({ type: "error", message: "course not found or wrong step" });
            controller.close();
            return;
          }

          const { blueprint } = await runBlueprintStep({
            query: state.query,
            clarifyAnswers: state.clarifyAnswers,
            feedback,
            previousBlueprint: state.blueprint,
            profileText: profileText(await getProfile(me?.id)),
            pageExcerpts: buildPageExcerpts(state.sources, state.pageContents || {}),
            textbookHint: state.textbook ? buildTextbookExcerpt(state.textbook) : undefined,
            outputLanguage: state.outputLanguage,
            constraints: state.constraints,
            stepNo: state.docMode ? 4 : 3,
            stepTotal: state.docMode ? 5 : 4,
            emit: send,
          });
          state.blueprint = blueprint;
          await setCourseState(courseId, state);
        } else if (action === "generate") {
          // 用户确认蓝图（可能已编辑）→ 逐单元填充课节细节
          const courseId = body.courseId || "";
          const state = await getCourseState(courseId);

          if (!state || !state.blueprint) {
            await send({ type: "error", message: "course not found or blueprint missing" });
            controller.close();
            return;
          }

          // 如果前端传了编辑后的蓝图，用编辑后的版本
          const finalBlueprint = body.blueprint || state.blueprint;

          // 积分门卫：大纲生成是全管线最贵的一步，课程资产此刻才真正落袋。
          // 未登录：本地自用放行（无公开暴露面）；公网部署（R2 模式）必须登录，否则积分形同虚设。
          if (!me && storageMode === "r2") {
            await send({ type: "error", message: "请先登录后再生成课程（课程消耗积分，与账号绑定）" });
            controller.close();
            return;
          }
          let creditsSpent = false;
          if (me) {
            const spend = await trySpend(me.id, COST_COURSE_GENERATE, `生成课程大纲：${(state.query || "").slice(0, 24)}`);
            if (!spend.ok) {
              await send({ type: "credits_block", balance: spend.balance, need: COST_COURSE_GENERATE, reason: "生成课程大纲" });
              controller.close();
              return;
            }
            creditsSpent = true;
          }

          try {
            const { outline, title } = await runOutlineStep({
              query: state.query,
              clarifyAnswers: state.clarifyAnswers,
              blueprint: finalBlueprint,
              profileText: profileText(await getProfile(me?.id)),
              refFileName: state.docName,
              outputLanguage: state.outputLanguage,
              constraints: state.constraints,
              stepNo: state.docMode ? 5 : 4,
              stepTotal: state.docMode ? 5 : 4,
              emit: send,
            });
            state.step = "done";
            state.outline = outline;
            state.title = title;
            // 最后一次存档失败不能吞掉整门课：大纲已经推给前端了，标记 saveFailed 让用户可补存
            // （存储层内部已带 3 次重试 + 本地影子兜底，走到这里还失败就是真挂了）
            let saveFailed = false;
            try {
              await setCourseState(courseId, state);
            } catch {
              saveFailed = true;
            }

            // 课程沉淀进学习者画像（澄清问答 + 课程标题），蒸馏失败不阻塞
            try {
              await captureCourseProfile({ courseTitle: title, clarifyAnswers: state.clarifyAnswers }, me?.id);
            } catch {
              // 画像写入失败不影响课程交付
            }

            await send({ type: "done", courseId, title, saveFailed });
          } catch (e) {
            // 生成失败退回积分：用户只为成功交付的资产付费
            if (creditsSpent && me) await refundCredits(me.id, COST_COURSE_GENERATE, "课程生成失败退回");
            throw e;
          }
        } else if (action === "save_course") {
          // 存档失败后的手动补存：状态在生成过程中已多次落盘，重写一次完整状态
          const courseId = body.courseId || "";
          const state = await getCourseState(courseId);
          if (!state?.outline) {
            await send({ type: "error", message: "course not found" });
            controller.close();
            return;
          }
          try {
            await setCourseState(courseId, state);
            await send({ type: "save_ok" });
          } catch (e) {
            await send({ type: "error", message: `补存仍失败：${e instanceof Error ? e.message : String(e)}` });
          }
        } else {
          await send({ type: "error", message: `unknown action: ${action}` });
        }
      } catch (e) {
        await logOpsError({
          kind: "course_generate",
          userId: me?.id,
          detail: `action=${action} ${e instanceof Error ? e.message : String(e)}`,
        }).catch(() => {});
        await send({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        await drainToUsage(me?.id || ipSubject(req)).catch(() => {});
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
