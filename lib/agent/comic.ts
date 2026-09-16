// 连环画课堂：把一节课编成「有声漫画」——分镜脚本（LLM）+ 逐格配图（万相文生图）。
// 气泡台词是 DOM 真文字（图内禁文字，模型画中文必乱）；配音复用 tts-client。
import type { LectureContext } from "./teach";
import { generateJson } from "./llm";
import { constraintsBlock } from "./lang";

/** 一格分镜：画面（英文出图提示）+ 旁白 + 气泡台词 */
export interface ComicPanel {
  scene: string; // 英文场景描述（拼在风格头后面出图）
  caption: string; // 旁白/字幕条（≤30 字，可空）
  bubbles: { who: "teacher" | "student"; text: string; pos: "tl" | "tr" | "bl" | "br" }[]; // 0-2 个
  sfx: string; // 拟声词贴纸（≤4 字，可空）
}

export interface ComicStoryboard {
  title: string; // 吸睛大标题（知识博主线：具体、反差、口语）
  subtitle: string; // 副题（≤24 字）
  panels: ComicPanel[];
}

/** 风格与角色锁：每一格的出图提示都以这段开头——跨格一致性全靠它 */
export const COMIC_STYLE_HEAD =
  "Hand-drawn comic panel, cute chibi doodle style, clean black ink lineart on white paper background, flat soft colors with teal-blue and warm-yellow accents, whiteboard-marker aesthetic. " +
  "Cast: TEACHER - a chibi man with a big round head, short black hair, round glasses, dark long-sleeve shirt, holding a thin wooden pointer, very expressive face. STUDENT - a small chibi kid with a round head, spiky hair, orange backpack. " +
  "NO text, NO letters, NO numbers, NO speech bubbles, NO captions, NO watermark in the image. ";

function contextLine(ctx: LectureContext): string {
  return `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}${ctx.keyConcepts?.length ? `\n本单元关键概念：${ctx.keyConcepts.join("、")}` : ""}${
    ctx.previousLectures?.length ? `\n前情（学员已听完）：${ctx.previousLectures.map((l) => `「${l.title}」`).join("、")}` : ""
  }${ctx.capstoneGoal ? `\n学员的结课作品：${ctx.capstoneGoal}` : ""}${
    ctx.referenceMaterial ? `\n参考资料（事实、数字、案例、页码以此为准）：\n${ctx.referenceMaterial.slice(0, 4000)}` : ""
  }${constraintsBlock(ctx.outputLanguage, ctx.constraints) ? `\n${constraintsBlock(ctx.outputLanguage, ctx.constraints)}` : ""}`;
}

/** 漫画编剧：一节课 → 有声连环画。剧情纪律沿用白板编剧（钩子/因果链/不复述/能力收尾），
 *  再加漫画独有三条：画面必须"演"得出、图内禁文字、一格最多两句台词。 */
const COMIC_STORYBOARD_SYSTEM = `你是知识漫画编剧。把一节课编成一部 10 到 14 格的「有声连环画」，只输出 JSON：
{"title":"大标题","subtitle":"副题","panels":[{"scene":"英文画面描述","caption":"旁白","bubbles":[{"who":"teacher","text":"台词","pos":"tl"}],"sfx":"拟声词"}]}

【输出体积铁律】scene 不超过 35 个英文单词；全部 panels 加起来必须一次输出完——宁可少一格，不许写到一半被截断。

【大标题】知识博主式钩子：具体、有反差、口语（正面示例"我用AI搓了个Demo，直接传上了GitHub"、"两条命令之间，藏着一个事故"）。禁止"XX详解/XX入门"。

【剧情纪律】
- 第一格必须是具体场景/事故现场（优先取参考资料里的真实案例），不是概念开场。
- 用因果链推进（因为A所以B，但B有个致命例外）——禁止 1234 罗列式分格。
- 前一格建立的东西下一格直接用，禁止换格复述；每格只推进一步。
- 关键机制讲两遍：机制语言一遍（老师说），学员场景一遍（学生/旁白说）。
- 术语第一次出现：台词里当场给一句人话（"SETNX——占坑用的"）。
- 学员是零基础，台词一句 ≤ 40 字，一格最多 2 句。
- 最后一格：能力宣告画面（学员亲手做成某事），旁白落在"现在你可以……"。

【画面纪律（scene 用英文写）】
- 画面必须"演得出"：用具体动作、表情、道具表达机制（两把锁争一个订单、命令石碑之间裂开一道缝、机器人崩溃冒烟、看门狗齿轮转动）。把抽象概念画成实物：锁=挂锁、竞态=两头奔跑的机器人、崩溃=冒烟倒地、过期时间=沙漏/炸弹倒计时。
- 景别有节奏：全景（场景）/中景（对话）/特写（关键道具或表情）交替，关键格用特写。
- 人物表情夸张（惊恐/得意/恍然大悟），这是连环画的灵魂。
- 每格 scene 里写清：谁、在哪、做什么、道具、景别、情绪。

【气泡台词（bubbles）】
- who 只有 "teacher"（老师）/"student"（学员小测）；pos 是气泡在格子里的角落（tl/tr/bl/br），同一格两个气泡错开角落。
- 台词是要被朗读出来的：口语、有情绪、短句。

【旁白（caption）】讲故事的人，补台词装不下的时间/背景/转折（"深夜，压测第 3 小时"），没有就留空。

【拟声词（sfx）】中文拟声（咔嚓/轰/叮/哗啦），强化格子的"响"，没有留空。`;

function clampStr(v: unknown, n: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

export async function runComicStoryboard(ctx: LectureContext): Promise<ComicStoryboard> {
  const normalize = (raw: ComicStoryboard | null): ComicPanel[] => {
    const panels = (Array.isArray(raw?.panels) ? raw.panels : [])
      .filter((p: any) => p && p.scene)
      .slice(0, 16)
      .map((p: any) => ({
        scene: String(p.scene).slice(0, 400),
        caption: clampStr(p.caption, 34),
        bubbles: (Array.isArray(p.bubbles) ? p.bubbles : [])
          .filter((b: any) => b && b.text)
          .slice(0, 2)
          .map((b: any) => ({
            who: b.who === "student" ? ("student" as const) : ("teacher" as const),
            text: clampStr(b.text, 46),
            pos: ["tl", "tr", "bl", "br"].includes(String(b.pos)) ? b.pos : "tl",
          })),
        sfx: clampStr(p.sfx, 4),
      }));
    return panels;
  };

  const userMsg = `${contextLine(ctx)}\n\n请把这一节课编成有声连环画。`;
  // 分镜是长 JSON，实测会被 maxTokens 截断成解析失败——这里格数不足就带意见重试一次，仍不足就报错不装没事
  let raw = await generateJson<ComicStoryboard>(COMIC_STORYBOARD_SYSTEM, userMsg, 7000);
  let panels = normalize(raw);
  if (panels.length < 8) {
    raw = await generateJson<ComicStoryboard>(
      COMIC_STORYBOARD_SYSTEM,
      `${userMsg}\n\n⚠ 上一次输出不合格（解析出的格数：${panels.length}）。多半是写到一半被截断。压缩每个 scene 的长度（≤30 个英文单词），确保 10-14 格完整输出并以 JSON 闭合结尾。`,
      7000
    );
    panels = normalize(raw);
  }
  if (panels.length < 6) throw new Error(`分镜生成失败（只解析出 ${panels.length} 格），请重试`);

  return {
    title: clampStr(raw?.title, 24) || ctx.lectureTitle.slice(0, 24),
    subtitle: clampStr(raw?.subtitle, 30),
    panels,
  };
}

/** 针对免费 cogview-3-flash 调校的风格头：短句、强 2D 声明、显式禁 3D/照片（默认风格头它听不懂） */
const HEAD_ZHIPU_FREE =
  "2D flat cartoon drawing, hand-drawn children's book doodle style, clean black ink outlines on white paper, " +
  "simple flat colors: teal blue and warm yellow only. Cute chibi boy teacher with a big round head, short black hair, round glasses, dark shirt, holding a wooden pointer. " +
  "Strictly flat 2D drawing, NOT 3D, no realistic rendering, no photograph, no gradient shading. " +
  "No text, no letters, no watermark. ";

/** 出图通道清单：COMIC_PROVIDER 显式锁定单通道（tuzi/zhipu/momoai/wanx），未设置则按性价比优先自动降级。
 *  锁定单通道后失败不静默降级——防止说好免费用着用着悄悄烧钱。 */
function effectiveChannels(): string[] {
  const provider = process.env.COMIC_PROVIDER?.trim();
  if (provider === "tuzi" || provider === "zhipu" || provider === "momoai" || provider === "wanx") return [provider];
  return ["tuzi", "momoai", "zhipu", "wanx"];
}

/** 缓存键的通道部分：换通道=换画风，缓存必须随之隔离（route 与重画脚本共用） */
export function comicChannelKey(): string {
  const first = effectiveChannels()[0];
  const model =
    first === "zhipu"
      ? process.env.ZHIPU_IMAGE_MODEL || "glm-image"
      : first === "momoai"
        ? process.env.MOMOAI_IMAGE_MODEL || "gpt-image-2"
        : first === "tuzi"
          ? process.env.TUZI_IMAGE_MODEL || "gpt-image-2.5"
          : "wanx2.1-t2i-turbo";
  return `${first}:${model}`;
}

function styleHeadFor(channel: string): string {
  if (channel === "zhipu" && (process.env.ZHIPU_IMAGE_MODEL || "glm-image").includes("cogview-3")) return HEAD_ZHIPU_FREE;
  return COMIC_STYLE_HEAD;
}

/** 出一格图。返回 { url } 或 { b64 }，附 channel（写进缓存键：换通道=换画风，缓存随之隔离）。 */
export async function generatePanelImage(prompt: string): Promise<{ url?: string; b64?: string; channel: string }> {
  const channels = effectiveChannels();
  const errors: string[] = [];

  for (const channel of channels) {
    const fullPrompt = styleHeadFor(channel) + prompt;
    try {
      if (channel === "tuzi") {
        const tuziKey = process.env.TUZI_API_KEY;
        if (!tuziKey) throw new Error("TUZI_API_KEY 未配置");
        const base = (process.env.TUZI_BASE_URL || "https://api.tu-zi.com").replace(/\/+$/, "");
        const model = process.env.TUZI_IMAGE_MODEL || "gpt-image-2.5";
        const res = await fetch(`${base}/v1/images/generations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tuziKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: fullPrompt, size: "1536x1024", n: 1 }),
          signal: AbortSignal.timeout(200_000),
        });
        const json: any = await res.json();
        const item = json?.data?.[0];
        if (item?.b64_json) return { b64: item.b64_json, channel };
        if (item?.url) return { url: item.url, channel };
        throw new Error(JSON.stringify(json?.error || json).slice(0, 120));
      }
      if (channel === "momoai") {
        const momoKey = process.env.MOMOAI_API_KEY;
        if (!momoKey) throw new Error("MOMOAI_API_KEY 未配置");
        const base = (process.env.MOMOAI_BASE_URL || "https://momoai.asia").replace(/\/+$/, "");
        const model = process.env.MOMOAI_IMAGE_MODEL || "gpt-image-2";
        const res = await fetch(`${base}/v1/images/generations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${momoKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: fullPrompt, size: "1536x1024", n: 1 }),
          signal: AbortSignal.timeout(180_000),
        });
        const json: any = await res.json();
        const item = json?.data?.[0];
        if (item?.b64_json) return { b64: item.b64_json, channel };
        if (item?.url) return { url: item.url, channel };
        throw new Error(JSON.stringify(json?.error || json).slice(0, 120));
      }
      if (channel === "zhipu") {
        const zhipuKey = process.env.ZHIPU_API_KEY;
        if (!zhipuKey) throw new Error("ZHIPU_API_KEY 未配置");
        const model = process.env.ZHIPU_IMAGE_MODEL || "glm-image";
        const res = await fetch("https://open.bigmodel.cn/api/paas/v4/images/generations", {
          method: "POST",
          headers: { Authorization: `Bearer ${zhipuKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: fullPrompt }),
          signal: AbortSignal.timeout(120_000),
        });
        const json: any = await res.json();
        const url = json?.data?.[0]?.url;
        if (url) return { url, channel };
        throw new Error(JSON.stringify(json?.error || json).slice(0, 120));
      }
      // wanx
      return { ...(await generatePanelImageWanx(fullPrompt)), channel: "wanx" };
    } catch (e) {
      errors.push(`${channel}: ${e instanceof Error ? e.message : String(e)}`);
      if (channels.length === 1) break;
    }
  }
  throw new Error(`全部出图通道失败：${errors.join(" | ")}`);
}

async function generatePanelImageWanx(prompt: string): Promise<{ url: string }> {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error("MOMOAI_API_KEY 与 DASHSCOPE_API_KEY 均未配置");
  const submit = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify({
      model: "wanx2.1-t2i-turbo",
      input: { prompt }, // 链路传入的已是完整提示词（含风格头），不再重复拼接
      parameters: { size: "1024*768", n: 1 },
    }),
  });
  const submitJson: any = await submit.json();
  const taskId = submitJson?.output?.task_id;
  if (!taskId) throw new Error(`出图任务提交失败：${JSON.stringify(submitJson).slice(0, 200)}`);
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const pollJson: any = await poll.json();
    const status = pollJson?.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = pollJson?.output?.results?.[0]?.url;
      if (!url) throw new Error("出图成功但没有 URL");
      return { url };
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(`出图失败：${status}`);
    }
  }
  throw new Error("出图超时（50s）");
}

// ================= 连环画 v2：Excalidraw 手绘引擎（零图费） =================
// 分镜师不再产出英文生图提示，而是产出「结构化场景图」：从固定道具目录里挑组件、
// 摆位置，渲染器（lib/comic-render.ts）把它们画成手绘漫画格。
// 好处：¥0 边际成本、风格 100% 统一、秒出、可逐格动画。

export interface SceneActor {
  who: "teacher" | "student";
  pose: "stand" | "point" | "cheer" | "shock" | "think";
  x: number; // 5-95（面板内百分比）
  y: number;
  emotion?: "smile" | "excited" | "worried" | "shocked";
}

export interface SceneProp {
  type:
    | "padlock" // 挂锁（锁/互斥）
    | "tablet" // 命令石碑（命令/规则）
    | "lightning" // 闪电（冲突/崩溃）
    | "crack" // 裂缝（时间窗口/事故点）
    | "sandTimer" // 沙漏（过期时间）
    | "robot" // 机器人（实例/客户端）
    | "monitor" // 告警屏
    | "gear" // 齿轮（看门狗/自动机制）
    | "starBurst" // 爆炸星（事故爆发）
    | "arrow" // 流程箭头
    | "question" // 问号（困惑）
    | "book" // 教材/资料
    | "desk" // 桌子/工位
    | "cloud"; // 想法云
  x: number;
  y: number;
  scale?: number; // 默认 1，0.6-1.6
}

export interface SceneBubble {
  who: "teacher" | "student";
  text: string;
  pos: "tl" | "tr" | "bl" | "br";
}

export interface ComicScenePanel {
  bg: "plain" | "night" | "room" | "factory";
  caption: string; // 旁白（≤30 字，可空）
  actors: SceneActor[];
  props: SceneProp[];
  bubbles: SceneBubble[];
  sfx: string;
}

export interface ComicSceneStoryboard {
  title: string;
  subtitle: string;
  panels: ComicScenePanel[];
}

const PROP_TYPES = "padlock|tablet|lightning|crack|sandTimer|robot|monitor|gear|starBurst|arrow|question|book|desk|cloud";

/** 漫画编剧 v2：结构化场景图版。剧情纪律与 v1 相同，画面改为「道具目录摆位」。 */
const COMIC_SCENE_STORYBOARD_SYSTEM = `你是知识漫画编剧。把一节课编成一部 10 到 14 格的手绘连环画。你**不描述画面**，而是像导演摆道具一样，从一个固定道具目录里挑组件、指定位置。只输出 JSON：
{"title":"大标题","subtitle":"副题","panels":[{"bg":"plain","caption":"旁白","actors":[{"who":"teacher","pose":"point","x":30,"y":55,"emotion":"worried"}],"props":[{"type":"padlock","x":70,"y":40}],"bubbles":[{"who":"teacher","text":"台词","pos":"tl"}],"sfx":"拟声词"}]}

【道具目录（type 只能从这里选）】
- padlock 挂锁=锁/互斥；tablet 石碑=命令/规则；lightning 闪电=冲突/崩溃瞬间；crack 裂缝=时间窗口/事故点
- sandTimer 沙漏=过期时间/倒计时；robot 机器人=实例/客户端（画两个就是两台机器在抢）；monitor 告警屏=线上事故
- gear 齿轮=看门狗/自动机制；starBurst 爆炸星=事故爆发；arrow 箭头=流程方向；question 问号=困惑；book 教材=资料；desk 桌子=工位；cloud 想法云=思考

【人物（actors）】who: teacher（老师）/ student（学员小测）；pose: stand 站立 / point 指着讲 / cheer 欢呼 / shock 惊呆 / think 思考；emotion: smile / excited / worried / shocked。x、y 是面板内的百分比位置（5-95）。

【摆格纪律】
- 每格 1-3 个演员 + 3-6 个道具；关键道具可以 scale 放大（1.3-1.6）。
- 用道具讲故事：两台机器人抢一把挂锁=竞态；石碑中间画裂缝=非原子的事故点；沙漏+挂锁=过期兜底；齿轮+挂锁=看门狗续期。
- 第一格必须是事故现场（bg 用 night + monitor + starBurst）；用因果链推进；前面格建立的道具后面直接复用；最后一格=学员 cheer + 成品道具（能力宣告）。
- 台词/旁白纪律：一句 ≤ 40 字、口语、术语首现给一句人话；一格最多 2 句台词；caption 是旁白不是台词。
- 大标题是知识博主线钩子；第一格 bg 用 night，工位格用 room，机制格用 plain，工厂格用 factory。

【其他】subtitle ≤24 字；sfx 是中文拟声（≤4 字，可空）；pos 是气泡角落（tl/tr/bl/br）。`;

function clampScenePanel(p: any): ComicScenePanel | null {
  if (!p || typeof p !== "object") return null;
  const pct = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(3, Math.min(97, n)) : d;
  };
  const BGS = ["plain", "night", "room", "factory"];
  const POSES = ["stand", "point", "cheer", "shock", "think"];
  const EMO = ["smile", "excited", "worried", "shocked"];
  const types = PROP_TYPES.split("|");
  const clampStr = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return {
    bg: (BGS.includes(String(p.bg)) ? p.bg : "plain") as ComicScenePanel["bg"],
    caption: clampStr(p.caption, 34),
    actors: (Array.isArray(p.actors) ? p.actors : [])
      .filter((a: any) => a && (a.who === "teacher" || a.who === "student"))
      .slice(0, 3)
      .map((a: any) => ({
        who: a.who,
        pose: (POSES.includes(String(a.pose)) ? a.pose : "stand") as SceneActor["pose"],
        x: pct(a.x, 30),
        y: pct(a.y, 60),
        emotion: (EMO.includes(String(a.emotion)) ? a.emotion : "smile") as SceneActor["emotion"],
      })),
    props: (Array.isArray(p.props) ? p.props : [])
      .filter((pr: any) => pr && types.includes(String(pr.type)))
      .slice(0, 7)
      .map((pr: any) => ({ type: pr.type, x: pct(pr.x, 50), y: pct(pr.y, 45), scale: Math.max(0.6, Math.min(1.6, Number(pr.scale) || 1)) })),
    bubbles: (Array.isArray(p.bubbles) ? p.bubbles : [])
      .filter((b: any) => b && b.text)
      .slice(0, 2)
      .map((b: any) => ({
        who: b.who === "student" ? ("student" as const) : ("teacher" as const),
        text: clampStr(b.text, 46),
        pos: (["tl", "tr", "bl", "br"].includes(String(b.pos)) ? b.pos : "tl") as SceneBubble["pos"],
      })),
    sfx: clampStr(p.sfx, 4),
  };
}

export async function runComicSceneStoryboard(ctx: LectureContext): Promise<ComicSceneStoryboard> {
  const normalize = (raw: ComicSceneStoryboard | null): ComicScenePanel[] =>
    (Array.isArray(raw?.panels) ? raw.panels : [])
      .map(clampScenePanel)
      .filter((p): p is ComicScenePanel => p !== null)
      .slice(0, 16);

  const userMsg = `${contextLine(ctx)}\n\n请用道具目录把这一节课编成手绘连环画。`;
  let raw = await generateJson<ComicSceneStoryboard>(COMIC_SCENE_STORYBOARD_SYSTEM, userMsg, 6000);
  let panels = normalize(raw);
  if (panels.length < 8) {
    raw = await generateJson<ComicSceneStoryboard>(
      COMIC_SCENE_STORYBOARD_SYSTEM,
      `${userMsg}\n\n⚠ 上一次输出不合格（解析出的格数：${panels.length}），多半写到一半被截断。压缩每格的 actors/props 数量，确保 10-14 格完整输出并以 JSON 闭合结尾。`,
      6000
    );
    panels = normalize(raw);
  }
  if (panels.length < 6) throw new Error(`分镜生成失败（只解析出 ${panels.length} 格），请重试`);
  return {
    title: clampStr(raw?.title, 24) || ctx.lectureTitle.slice(0, 24),
    subtitle: clampStr(raw?.subtitle, 30),
    panels,
  };
}

// ================= 连环画 v3：知识地图长图（参考 Harness Map 版式） =================
// 版式契约：奶油方格纸底 + 编号卡片（烦恼/办法 双格对照 + 吉祥物小图 + 解决了什么/代价）+
// 「下一站」印章串学习路径 + 分节标题 + 结尾度量卡与总结表。角色用素材库姿势图。

export interface KNode { kind: "box" | "check" | "cross" | "text"; text: string }
export interface KCard {
  num: string; // "01"
  title: string; // "接住两步写法"
  tags: string; // "SETNX · EXPIRE"
  explain: string; // 一句话（≤40 字）
  trouble: { line: string; mascot: { who: "teacher" | "student"; pose: string }; nodes: KNode[] };
  fix: { line: string; mascot: { who: "teacher" | "student"; pose: string }; nodes: KNode[] };
  solved: string; // 解决了什么（≤26 字）
  cost: string; // 代价是什么（≤26 字）
}
export interface KnowledgeStoryboard {
  kicker: string; // 栏目名 "AI 工程实战 / 分布式锁地图"
  title: string; // "想用一条命令加锁？先把窗口焊死。"
  subtitle: string; // 一句定义（≤50 字）
  overview: { label: string; steps: string[]; loop: string }; // steps ≤4，"①②踩中窗口"式
  sections: { name: string; range: string }[]; // ≤3
  cards: KCard[]; // 8-12
  metrics: { label: string; value: string; note: string }[]; // ≤3
  outro: { line: string; table: { step: string; help: string; cost: string }[] }; // table ≤6 行
}

const KN_SYSTEM = `你是知识漫画编剧。把一节课编成一张「知识地图长图」：给自学的人当学习路径图。只输出 JSON：
{"kicker":"...","title":"...","subtitle":"...","overview":{"label":"...","steps":["..."],"loop":"..."},"sections":[{"name":"...","range":"01-02"}],"cards":[{"num":"01","title":"...","tags":"...","explain":"...","trouble":{"line":"...","mascot":{"who":"teacher","pose":"shock"},"nodes":[{"kind":"box","text":"..."}]},"fix":{"line":"...","mascot":{"who":"teacher","pose":"point"},"nodes":[{"kind":"check","text":"..."}]},"solved":"...","cost":"..."}],"metrics":[{"label":"...","value":"...","note":"..."}],"outro":{"line":"...","table":[{"step":"...","help":"...","cost":"..."}]}}

【整体结构（照此顺序）】kicker 栏目名 → title 大标题（钩子句）→ subtitle 一句定义 → overview 总览流程（本课主线的 3-4 个阶段+没做完的回路）→ 8-12 张编号卡片（分 ≤3 个 section）→ metrics 量一量（≤3 个指标卡）→ outro 总结表（每张卡片一行：办法/帮哪里/代价）。

【卡片 = 一个知识点，格式雷打不动】
- num 两位编号（01、02…），title 是能力式短标题（≤10 字），tags 是涉及术语（英文/代码词，逗号分隔），explain 一句话说这格讲什么（≤40 字）。
- trouble = 「烦恼」：错误做法/踩的坑；fix = 「办法」：正确做法。两者都是：line 一句话（≤24 字）+ mascot（老师或学员的姿势）+ nodes 步骤小方框（1-3 个）。
- nodes 每个格式 {kind:"box"|"check"|"cross","text":"≤10 字"}：box 中性步骤、check 绿勾好做法、cross 红叉坏做法。trouble 里至少一个 cross，fix 里至少一个 check。
- mascot 姿势从这些里选：stand/point/cheer/shock/think（who: teacher 老师 / student 学员小测）。
- solved 一句话「解决了什么」（≤26 字），cost 一句话「代价是什么」（≤26 字）——要具体，不许空话。

【剧情纪律】沿用：第一张卡片从最朴素的做法/事故切入；卡片按因果链排序不复述；术语 tags 里出现就不再解释；最后一两张卡要落到学员的结课作品场景。

【体积铁律】所有文案字段都短：explain ≤40 字、line ≤24 字、solved/cost ≤26 字、table 每格 ≤18 字。宁可少一张卡，不许输出被截断。`;

function clampKN(v: unknown, n: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}
function clampNodes(arr: any): KNode[] {
  return (Array.isArray(arr) ? arr : [])
    .filter((n: any) => n && typeof n.text === "string")
    .slice(0, 3)
    .map((n: any) => ({ kind: n.kind === "check" ? "check" : n.kind === "cross" ? "cross" : "text", text: clampStr(n.text, 12) }));
}
export async function runComicKnowledgeStoryboard(ctx: LectureContext): Promise<KnowledgeStoryboard> {
  const userMsg = `${contextLine(ctx)}\n\n请把这一节课编成知识地图长图。`;
  let raw = await generateJson<KnowledgeStoryboard>(KN_SYSTEM, userMsg, 7000);
  let cards = (Array.isArray(raw?.cards) ? raw.cards : []).slice(0, 14);
  if (cards.length < 6) {
    raw = await generateJson<KnowledgeStoryboard>(
      KN_SYSTEM,
      `${userMsg}\n\n⚠ 上一次输出不合格（只解析出 ${cards.length} 张卡片），多半被截断。压缩每张卡的文案长度，确保 8-12 张卡完整输出并以 JSON 闭合结尾。`,
      7000
    );
    cards = (Array.isArray(raw?.cards) ? raw.cards : []).slice(0, 14);
  }
  if (cards.length < 6) throw new Error(`知识卡片生成失败（只解析出 ${cards.length} 张），请重试`);
  const normCard = (c: any, i: number): KCard => ({
    num: clampStr(c.num, 3) || String(i + 1).padStart(2, "0"),
    title: clampStr(c.title, 14),
    tags: clampStr(c.tags, 30),
    explain: clampStr(c.explain, 44),
    trouble: {
      line: clampStr(c.trouble?.line, 26),
      mascot: { who: c.trouble?.mascot?.who === "student" ? "student" : "teacher", pose: clampStr(c.trouble?.mascot?.pose, 8) || "shock" },
      nodes: clampNodes(c.trouble?.nodes),
    },
    fix: {
      line: clampStr(c.fix?.line, 26),
      mascot: { who: c.fix?.mascot?.who === "student" ? "student" : "teacher", pose: clampStr(c.fix?.mascot?.pose, 8) || "point" },
      nodes: clampNodes(c.fix?.nodes),
    },
    solved: clampStr(c.solved, 30),
    cost: clampStr(c.cost, 30),
  });
  const valid = cards.filter((c: any) => c && c.title);
  return {
    kicker: clampStr(raw?.kicker, 30) || "AI 工程实战 / 分布式锁地图",
    title: clampStr(raw?.title, 30) || ctx.lectureTitle.slice(0, 30),
    subtitle: clampStr(raw?.subtitle, 60),
    overview: {
      label: clampStr(raw?.overview?.label, 40),
      steps: (Array.isArray(raw?.overview?.steps) ? raw.overview.steps : []).slice(0, 4).map((s: unknown) => clampStr(s, 16)),
      loop: clampStr(raw?.overview?.loop, 30),
    },
    sections: (Array.isArray(raw?.sections) ? raw.sections : []).slice(0, 3).map((sc: any) => ({ name: clampStr(sc?.name, 16), range: clampStr(sc?.range, 12) })),
    cards: valid.map(normCard),
    metrics: (Array.isArray(raw?.metrics) ? raw.metrics : []).slice(0, 3).map((m: any) => ({ label: clampStr(m?.label, 14), value: clampStr(m?.value, 14), note: clampStr(m?.note, 16) })),
    outro: {
      line: clampStr(raw?.outro?.line, 40),
      table: (Array.isArray(raw?.outro?.table) ? raw.outro.table : []).slice(0, 6).map((r: any) => ({ step: clampStr(r?.step, 14), help: clampStr(r?.help, 22), cost: clampStr(r?.cost, 22) })),
    },
  };
}
