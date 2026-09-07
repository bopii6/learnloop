// 课程生成管线：搜索 → 分轮澄清 → 结构蓝图 → 课程大纲
// 教材模式：上传 PDF 后跳过搜索，蓝图镜像教材目录，教学按课节取相关页
import type {
  CourseEvent,
  CourseOutline,
  CourseBlueprint,
  ClarifyQuestion,
  SourceItem,
  TextbookPage,
} from "@/types";
import { generateJson, streamAnswer } from "./llm";
import { webSearch } from "./search";
import { readUrl } from "./read";
type Emit = (e: CourseEvent) => Promise<void> | void;

interface HistoryMsg {
  role: "user" | "assistant";
  content: string;
}

const COURSE_CLARIFY_SYSTEM = `你是课程设计师。用户想系统学习某个主题，但关键信息缺失。请生成 1 个选择题来澄清需求，只输出 JSON，不要输出任何其他内容。

维度（每轮选一个，优先问没覆盖过的）：
1. 前置经验 2. 关注的实现语境/方向 3. 学完的目标水平 4. 课程体量

让选项"可对号入座"是最高优先级——每个选项的 desc 必须是可自查的具体行为或具体事物，而不是形容词：
- 好："实际编写过包含 tools 参数的 Prompt，并手动解析过 LLM 返回的 JSON 结果"
- 坏："有一定基础，了解相关概念"
- 好选项示例：Basic: 基础 API 调用 / Intermediate: 函数调用经验 / Advanced: 复杂框架开发
- 如果给了资料要点，选项要贴合资料里的真实技术、工具、场景（如资料里反复出现 MCP，就把它做成一个选项方向）。

reason 字段（1 句话，≤40 字）说明"我为什么问这个"——要引用资料或用户目标（如"资料里反复出现 ReAct 和 MCP 两条路线，需要知道你的起点"），让用户看到你在推理。

输出格式：
{"question":"...","reason":"...","options":[{"label":"...","desc":"..."},{"label":"...","desc":"..."},{"label":"...","desc":"..."}]}`;

const COURSE_BLUEPRINT_SYSTEM = `你是资深课程架构师。根据用户想学的主题和背景信息，生成完整的课程结构蓝图。
只输出 JSON，不要输出任何其他内容。

JSON 格式（必须严格遵守）：
{
  "title": "课程标题",
  "audience": "目标受众描述（一句话，结合用户背景）",
  "tags": ["标签1", "标签2", "标签3"],
  "units": [
    {
      "id": "unit-1",
      "title": "单元标题",
      "summary": "单元简介（一句话）",
      "key_concepts": ["概念1", "概念2"],
      "lectures": [
        {"id": "lec-1-1", "title": "课节标题", "depth_tags": ["建立直觉"]}
      ]
    }
  ]
}

要求：
- 课程标题格式为「主标题：副标题」，体现主题、深度和受众。禁止把用户输入拼上"系统课程"。
  正面示例："LLM Agent 深度工程：从 ReAct 理论到生产级 Tool Use 实现"
- tags 是领域标签（如 "AI Engineering"、"ReAct Pattern"），禁止把用户原话当标签。
- 4-8 个单元，每个单元 3-5 个课节。
- 单元标题要具体，体现该单元覆盖的知识范围，禁止"基础概念与入门"这种万能套话。
- 课节标题必须具体到知识点，格式推荐「具体概念：要解决的问题或角度」。
  反面示例："核心概念"、"基本术语"。正面示例："Function Calling 机制：原生支持与技术差异"。
- 每个课节标注 1-2 个深度标签：建立直觉 / 正式定义 / 公式推导 / 进阶理论 / 应用实操。
- 课节 id 格式 lec-{单元号}-{序号}。`;

const COURSE_SKELETON_SYSTEM = `你是资深课程设计师。根据用户想学的主题、背景信息和课程蓝图，设计课程骨架（不含具体课节）。
只输出 JSON，不要输出任何其他内容。

JSON 格式（必须严格遵守）：
{
  "title": "课程标题",
  "audience": "目标受众描述（一句话，结合用户背景）",
  "tags": ["标签1", "标签2", "标签3"],
  "units": [
    {
      "id": "unit-1",
      "title": "单元标题",
      "summary": "单元简介（一句话说明本单元解决什么问题）",
      "key_concepts": ["概念1", "概念2", "概念3"]
    }
  ]
}

要求：
- 课程标题必须拟一个真正的课程名，格式为「主标题：副标题」，体现主题、深度和受众。
  反面示例："机器学习 系统课程"（禁止直接把用户输入拼上"系统课程"）。
  正面示例："LLM Agent 深度工程：从 ReAct 理论到生产级 Tool Use 实现"。
- tags 是领域标签（如 "AI Engineering"、"ReAct Pattern"），禁止把用户原话当标签。
- 单元数量与蓝图的主分支一致（蓝图有几个主分支就生成几个单元，通常 4-8 个）。
- 单元标题要具体，体现该单元覆盖的知识范围，禁止"基础概念与入门"这种万能套话。
- 单元 id 格式 unit-N。`;

const COURSE_UNIT_LECTURES_SYSTEM = `你是资深课程设计师。为课程的某一个单元设计课节（lecture）列表。
只输出 JSON，不要输出任何其他内容。

JSON 格式（必须严格遵守）：
{
  "lectures": [
    {
      "id": "lec-1-1",
      "title": "课节标题",
      "summary": "课节简介（一句话，说明学完能掌握什么）",
      "duration_min": 20,
      "depth_tags": ["建立直觉"],
      "content_type": "whiteboard"
    }
  ]
}

要求：
- 每个单元 3-5 个课节。
- 课节标题必须具体到知识点，格式推荐「具体概念：要解决的问题或角度」。
  反面示例："核心概念"、"基本术语"（禁止万能套话）。
  正面示例："Function Calling 机制：原生支持与技术差异"、"梯度下降：损失曲面直觉与更新规则"。
- 每个课节标注 1-2 个深度标签，只能从这些里选：建立直觉 / 正式定义 / 公式推导 / 进阶理论 / 应用实操。
- content_type 只能是 "whiteboard" | "project" | "quiz"；绝大多数为 "whiteboard"，每个单元最多 1 个 "project" 或 "quiz"。
- 课节时长 15-30 分钟。
- 课节 id 格式 lec-{单元号}-{序号}。`;

// ---- 状态持久化（经存储抽象层：本地 data/ 或 Cloudflare R2，见 lib/storage.ts） ----
// 注意：Next.js 每个 route 有独立模块实例，纯内存 Map 在 /api/course 和 /api/teach 之间不共享，
// 必须落盘。

import { readJson, writeJson } from "@/lib/storage";

interface CourseGenState {
  step: "search" | "clarify" | "blueprint" | "outline" | "done";
  query: string;
  ownerId?: string; // 创建者（登录后记录；历史数据无主，所有人可见）
  history: HistoryMsg[];
  sources: SourceItem[];
  pageContents?: Record<string, string>; // 已读网页正文（source index → text）
  textbook?: { // 教材模式：全书页文本留在本地，教学时按课节取相关页
    id: string;
    title: string;
    toc: string[];
    pages: TextbookPage[];
  };
  courseSource?: string; // 自学 / 学校同步（原版同款）
  clarifyAnswers: { question: string; answer: string }[];
  clarifyRound: number;
  currentQuestion?: string;
  blueprint?: CourseBlueprint;
  outline?: CourseOutline;
  title?: string;
}

function courseKey(id: string): string {
  return `courses/${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
}

export async function getCourseState(id: string): Promise<CourseGenState | undefined> {
  return (await readJson<CourseGenState | null>(courseKey(id), null)) ?? undefined;
}

export async function setCourseState(id: string, state: CourseGenState): Promise<void> {
  await writeJson(courseKey(id), state);
}

// ---- 分步执行 ----

const SEARCH_PLAN_SYSTEM = `你是搜索专家。用户想系统学习一个明确主题，请生成 3 个搜索引擎查询词，用于搜集该主题的高质量学习资料。
只输出 JSON：{"queries":["查询1","查询2","查询3"]}

语言策略（决定信息源头质量，必须遵守）：
- 只要主题涉及编程、AI、大模型、Agent、算法、数据、软件工具、数学、自然科学（判断依据：输入里出现 LLM/模型/Agent/API/算法/Python/代码/数据 等词，或主题是技术概念），3 个查询必须全部用英文——英文互联网的一手资料质量远高于中文。
- 人文 / 历史 / 语言考试 / 中国本土生活话题：用中文查询。
- 示例判断："LLM Agent 的 Tool Use" 是纯技术主题 → 全英文；"雅思托福备考" → 全中文；"上海本帮菜烹饪" → 全中文。

硬性要求（搜索引擎对长查询会返回垃圾结果，必须遵守）：
- 每个查询最多 4 个单词（英文）或 2 个词（中文）：「核心主题词 + 一个角度词」。
- 3 个查询的角度轮换：tutorial / patterns / architecture 或 教程 / 详解 / 实战。
- 禁止造句。

示例：
用户输入"我想系统学习机器学习" → {"queries":["machine learning tutorial","machine learning explained","机器学习 实战"]}
用户输入"系统讲解 LLM Agent 的 Tool Use 设计模式" → {"queries":["LLM agent tool use design patterns","function calling workflows","agent design patterns"]}
用户输入"雅思托福怎么选" → {"queries":["雅思 托福 区别","雅思 备考 教程","托福 备考 实战"]}`;

function normalizeLearningTopic(input: string): string {
  const known = [
    "大模型", "LLM", "生成式 AI", "人工智能", "机器学习", "深度学习", "Transformer",
    "LLM Agent", "AI Agent", "RAG", "Python", "数据分析", "自然语言处理",
  ];
  const hit = known.find((term) => input.toLowerCase().includes(term.toLowerCase()));
  if (hit) return hit;
  const cleaned = input
    .replace(/我的目标是|我想|我要|怎么|如何|系统地?|系统讲解|学习|掌握|了解|课程|教程/g, " ")
    .replace(/[，。！？：:、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").filter(Boolean).slice(0, 3).join(" ") || input.trim().slice(0, 16);
}

function fallbackQueries(topic: string): string[] {
  return [`${topic} 原理`, `${topic} 学习路线`, `${topic} 实战`];
}

function isRelevantQuery(query: string, topic: string): boolean {
  // 英文查询不做主题词过滤（规划提示已保证语言匹配，中文 token 对不上英文查询）
  if (!/[\u4e00-\u9fff]/.test(query)) return true;
  const topicTokens = topic.toLowerCase().split(/\s+/).filter((x) => x.length > 1);
  const q = query.toLowerCase();
  return topicTokens.some((token) => q.includes(token));
}

function isLikelyOffTopic(item: SourceItem, topic: string): boolean {
  const text = `${item.title} ${item.snippet || ""}`.toLowerCase();
  const dictionaryDomain = /(^|\.)zdic\.net$|(^|\.)hanyuguoxue\.com$|(^|\.)hanzipi\.com$/i.test(item.domain);
  if (dictionaryDomain || (topic === "大模型" && /(汉字|汉语文字|汉典|词典|笔画|大字)/.test(text))) return true;
  return false;
}

export async function runSearchStep(opts: {
  query: string;
  history: HistoryMsg[];
  emit: Emit;
}): Promise<{ sources: SourceItem[]; pageContents: Record<number, string> }> {
  const { query, emit } = opts;
  const sources: SourceItem[] = [];
  const topic = normalizeLearningTopic(query);

  await emit({ type: "stage", name: "search", label: "正在搜索网络资料", status: "start", detail: "第 1 步，共 4 步" });

  // 先用 LLM 把口语化输入提炼成高质量搜索词（Hyperknow 的 query 标签就是这步的产物）
  let searchQueries: string[] = [];
  const plan = await generateJson<{ queries: string[] }>(
    SEARCH_PLAN_SYSTEM,
    `用户原始目标：${query}\n已提炼主题（必须围绕它搜索）：${topic}`,
    400
  );
  if (plan?.queries && Array.isArray(plan.queries) && plan.queries.length > 0) {
    searchQueries = plan.queries
      .map(String)
      .map((q) => q.replace(/[，。！？：:、]/g, " ").replace(/\s+/g, " ").trim())
      .filter((q) => isRelevantQuery(q, topic))
      .slice(0, 3);
  }
  // 语言策略的代码级兜底：技术主题但 LLM 给的全是中文查询 → 用任务里的英文词干造英文查询
  const TECH_SIGNALS = ["LLM", "大模型", "Agent", "AI", "模型", "API", "算法", "编程", "Python", "Java", "代码", "Transformer", "RAG", "深度学习", "机器学习", "数据结构", "微调", "Prompt"];
  const isTechTopic = TECH_SIGNALS.some((s) => query.toLowerCase().includes(s.toLowerCase()));
  if (isTechTopic && !searchQueries.some((q) => !/[\u4e00-\u9fff]/.test(q))) {
    const englishBase = (query.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) || [])
      .filter((w) => !["的", "系统"].includes(w) && w.length > 1)
      .slice(0, 3)
      .join(" ");
    if (englishBase) {
      searchQueries = [`${englishBase} design patterns`, `${englishBase} tutorial`, `${englishBase} architecture`];
    }
  }
  if (searchQueries.length < 2) searchQueries = fallbackQueries(topic);
  await emit({ type: "search_queries", queries: searchQueries });
  await emit({ type: "stage", name: "search", label: "正在搜索网络资料", status: "start", detail: searchQueries.join(" · ") });

  const settled = await Promise.allSettled(searchQueries.map((q) => webSearch(q, 6)));
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const item of s.value) {
      if (seen.has(item.url) || isLikelyOffTopic(item, topic)) continue;
      seen.add(item.url);
      sources.push({ ...item, index: sources.length + 1 });
      if (sources.length >= 12) break;
    }
    if (sources.length >= 12) break;
  }
  await emit({ type: "sources", items: sources });
  await emit({ type: "stage", name: "search", label: "正在搜索网络资料", status: "end", detail: `找到 ${sources.length} 个来源` });

  // 阅读权威度最高的前几页：蓝图/澄清的选项质量直接来自这些正文（Hyperknow 同款打法）
  const pageContents: Record<number, string> = {};
  const toRead = sources.slice(0, 6);
  if (toRead.length > 0) {
    await emit({ type: "stage", name: "read", label: "正在阅读网页内容", status: "start", detail: `0/${toRead.length}` });
    let done = 0;
    await Promise.all(
      toRead.map(async (s) => {
        const text = await readUrl(s.url);
        if (text.length > 300) pageContents[s.index] = text;
        done += 1;
        await emit({ type: "stage", name: "read", label: "正在阅读网页内容", status: "start", detail: `${done}/${toRead.length} · ${s.domain}` });
      })
    );
    await emit({ type: "stage", name: "read", label: "正在阅读网页内容", status: "end", detail: `读完 ${Object.keys(pageContents).length}/${toRead.length} 个页面` });
  }

  return { sources, pageContents };
}

export async function runClarifyStep(opts: {
  query: string;
  history: HistoryMsg[];
  sources: SourceItem[];
  clarifyAnswers: { question: string; answer: string }[];
  round: number;
  courseId: string;
  profileHint?: string; // 已有画像，避免重复提问已覆盖的维度
  pageExcerpts?: string; // 搜索到的资料摘要，让澄清选项更贴近真实语境
  emit: Emit;
}): Promise<{ question?: ClarifyQuestion; done: boolean }> {
  const { query, history, sources, clarifyAnswers, round, courseId, profileHint, pageExcerpts, emit } = opts;

  await emit({ type: "stage", name: "clarify_round", label: "构思初步思路", status: "start", detail: `第 2 步，共 4 步（第 ${round}/4 轮）` });

  const histText = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 300)}`)
    .join("\n\n");
  const context = histText ? `最近对话：\n${histText}\n\n` : "";
  const prevAnswers = clarifyAnswers.length > 0
    ? `已收集信息：\n${clarifyAnswers.map((a) => `${a.question} → ${a.answer}`).join("\n")}\n\n`
    : "";
  const sourceContext = sources.length > 0
    ? `已搜索到的资料主题：${sources.slice(0, 3).map((s) => s.title).join("、")}\n\n`
    : "";
  const excerptsContext = pageExcerpts
    ? `资料要点（选项要贴合这些真实语境，如提到具体技术/工具/场景）：\n${pageExcerpts}\n\n`
    : "";
  const profileContext = profileHint
    ? `${profileHint}\n\n`
    : "";

  const question = await generateJson<ClarifyQuestion>(
    COURSE_CLARIFY_SYSTEM,
    `${context}${prevAnswers}${sourceContext}${excerptsContext}${profileContext}用户想学习：${query}\n\n请生成第 ${round} 个澄清问题。`
  );

  if (!question || !question.question || !question.options || question.options.length < 2) {
    await emit({ type: "stage", name: "clarify_round", label: "构思初步思路", status: "end", detail: "澄清完成" });
    return { done: true };
  }

  const normalized: ClarifyQuestion = {
    id: `q${round}`,
    question: String(question.question),
    reason: typeof question.reason === "string" ? String(question.reason).slice(0, 60) : undefined,
    multi: Boolean(question.multi),
    skippable: question.skippable !== false,
    options: question.options.slice(0, 4).map((o) => ({
      label: String(o.label || ""),
      desc: o.desc ? String(o.desc) : undefined,
    })),
  };

  await emit({
    type: "clarify_round",
    round,
    total_rounds: 4,
    question: normalized,
    courseId,
  });

  return { question: normalized, done: false };
}

export async function runBlueprintStep(opts: {
  query: string;
  clarifyAnswers: { question: string; answer: string }[];
  feedback?: string;
  previousBlueprint?: CourseBlueprint;
  profileText?: string; // 学习者画像（跨课程持久化）
  pageExcerpts?: string; // 已读网页要点：让蓝图 grounded 在真实资料上
  textbookHint?: string; // 教材模式：目录+要点，蓝图必须镜像教材结构
  emit: Emit;
}): Promise<{ blueprint: CourseBlueprint }> {
  const { query, clarifyAnswers, feedback, previousBlueprint, profileText, pageExcerpts, textbookHint, emit } = opts;

  await emit({ type: "stage", name: "blueprint", label: "打造课程", status: "start", detail: "第 3 步，共 4 步" });

  const answerContext = clarifyAnswers.length > 0
    ? `用户背景：\n${clarifyAnswers.map((a) => `${a.question}：${a.answer}`).join("\n")}\n\n`
    : "";
  const profileContext = profileText
    ? `学习者画像（跨课程沉淀，结合它量身定制深度与取舍）：\n${profileText}\n\n`
    : "";
  const excerptsContext = pageExcerpts
    ? `网络资料要点（单元和课节设计要覆盖这些真实内容中的关键概念，标题要具体到知识点）：\n${pageExcerpts}\n\n`
    : "";
  const textbookContext = textbookHint
    ? `教材内容（课程结构必须镜像这本教材：单元对应教材的章/单元，课节对应教材的节，标题优先用教材官方术语，按教材顺序排列，不要自由发挥）：\n${textbookHint}\n\n`
    : "";

  // 先产出"设计思路"给用户看：推理外显，而不是黑盒蹦出一张蓝图
  const thinking = await generateJson<{ notes: string[] }>(
    `你是课程架构师。基于用户目标、澄清回答和资料要点，用 2-3 句话说明你打算怎么设计这门课、为什么，只输出 JSON：{"notes":["...","..."]}
要求：每句 ≤ 45 字；必须引用澄清回答里的具体选择和资料里的具体概念（如"你选了生产级，所以第 4 单元直接进错误重试实战"）；不要客套。`,
    `${answerContext}${excerptsContext}用户想学习：${query}`,
    500
  );
  if (Array.isArray(thinking?.notes) && thinking.notes.length > 0) {
    await emit({ type: "design_notes", notes: thinking.notes.slice(0, 4).map((n) => String(n).slice(0, 60)) });
  }
  const feedbackContext = feedback
    ? `上一版蓝图：\n${JSON.stringify(previousBlueprint || {}, null, 2)}\n\n用户对上一版蓝图的修改意见：${feedback}\n请根据修改意见重新生成完整蓝图（保持 JSON 格式不变）。\n\n`
    : "";

  const raw = await generateJson<CourseBlueprint>(
    COURSE_BLUEPRINT_SYSTEM,
    `${answerContext}${profileContext}${textbookContext}${excerptsContext}${feedbackContext}用户想学习：${query}\n\n请生成课程结构蓝图。`,
    4000
  );

  // 兜底：LLM 失败时返回一个最小骨架
  const blueprint: CourseBlueprint = {
    title: raw?.title || `${query}：系统精讲`,
    audience: raw?.audience || "希望系统学习该主题的学习者",
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
    units: Array.isArray(raw?.units) && raw.units.length > 0
      ? raw.units.map((u, i) => ({
          id: u.id || `unit-${i + 1}`,
          title: String(u.title || `单元 ${i + 1}`),
          summary: String(u.summary || ""),
          key_concepts: Array.isArray(u.key_concepts) ? u.key_concepts.map(String) : [],
          lectures: Array.isArray(u.lectures)
            ? u.lectures.map((l, j) => ({
                id: l.id || `lec-${i + 1}-${j + 1}`,
                title: String(l.title || `课节 ${j + 1}`),
                depth_tags: Array.isArray(l.depth_tags) ? l.depth_tags.map(String) : ["建立直觉"],
              }))
            : [],
        }))
      : [{
          id: "unit-1",
          title: query,
          summary: `围绕「${query}」的系统讲解`,
          key_concepts: [query],
          lectures: [{ id: "lec-1-1", title: query, depth_tags: ["建立直觉"] }],
        }],
  };

  await emit({ type: "blueprint", data: blueprint });
  await emit({ type: "stage", name: "blueprint", label: "打造课程", status: "end", detail: "课程结构预览已生成" });

  return { blueprint };
}

export async function runOutlineStep(opts: {
  query: string;
  clarifyAnswers: { question: string; answer: string }[];
  blueprint: CourseBlueprint;
  profileText?: string;
  emit: Emit;
}): Promise<{ outline: CourseOutline; title: string }> {
  const { query, clarifyAnswers, blueprint, profileText, emit } = opts;

  await emit({ type: "stage", name: "outline", label: "打造课程", status: "start", detail: "第 4 步，共 4 步" });

  const answerContext = clarifyAnswers.length > 0
    ? `用户背景：\n${clarifyAnswers.map((a) => `${a.question}：${a.answer}`).join("\n")}\n\n`
    : "";
  const profileContext = profileText
    ? `学习者画像：\n${profileText}\n\n`
    : "";

  // 蓝图已经包含完整的课程结构（单元+课节标题+深度标签），
  // 大纲步骤只需逐单元填充课节细节（简介、时长、内容类型）
  const fullUnits = [];
  for (let i = 0; i < blueprint.units.length; i++) {
    const unit = blueprint.units[i];
    await emit({
      type: "outline_progress",
      current: i + 1,
      total: blueprint.units.length,
      unitTitle: unit.title,
    });

    const detailJson = await generateJson<{ lectures: { id: string; summary: string; duration_min: number; content_type: string }[] }>(
      `你是课程设计师。为课程的某一个单元的课节列表填充细节。
只输出 JSON：{"lectures":[{"id":"...","summary":"一句话说明学完能掌握什么","duration_min":20,"content_type":"whiteboard"}]}

规则：
- content_type 只能是 "whiteboard" | "project" | "quiz"；绝大多数为 "whiteboard"，每个单元最多 1 个 "project" 或 "quiz"。
- 课节时长 15-30 分钟。
- 不要修改课节 id 和标题，只填充细节。`,
      `${profileContext}${answerContext}课程：《${blueprint.title}》\n当前单元：${unit.title}\n课节列表：${unit.lectures.map((l) => `${l.id}: ${l.title} (${l.depth_tags.join("/")})`).join("\n")}`,
      2000
    );

    const detailMap = new Map<string, { summary: string; duration_min: number; content_type: string }>();
    if (Array.isArray(detailJson?.lectures)) {
      for (const d of detailJson.lectures) {
        if (d.id) detailMap.set(d.id, d);
      }
    }

    const lectures = unit.lectures.map((l) => {
      const detail = detailMap.get(l.id);
      return {
        id: l.id,
        title: l.title,
        summary: detail?.summary || `深入讲解「${l.title}」`,
        duration_min: typeof detail?.duration_min === "number" ? detail.duration_min : 20,
        depth_tags: l.depth_tags,
        content_type: (["whiteboard", "project", "quiz"] as const).includes(detail?.content_type as any)
          ? (detail!.content_type as "whiteboard" | "project" | "quiz")
          : ("whiteboard" as const),
      };
    });

    fullUnits.push({ ...unit, lectures });
  }

  const outline: CourseOutline = {
    title: blueprint.title,
    audience: blueprint.audience,
    tags: blueprint.tags,
    units: fullUnits,
  };

  await emit({ type: "outline", outline });
  await emit({ type: "stage", name: "outline", label: "打造课程", status: "end", detail: `生成 ${outline.units.length} 个单元` });

  return { outline, title: outline.title };
}
