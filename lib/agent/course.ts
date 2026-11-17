// 课程生成管线：搜索 → 分轮澄清 → 结构蓝图 → 课程大纲
// 教材模式：上传 PDF 后跳过搜索，蓝图镜像教材目录，教学按课节取相关页
import type {
  CourseEvent,
  CourseOutline,
  CourseBlueprint,
  BlueprintCapstone,
  ClarifyQuestion,
  SourceItem,
  TextbookPage,
} from "@/types";
import { generateJson, streamAnswer } from "./llm";
import { webSearch } from "./search";
import { readUrl } from "./read";
import { constraintsBlock, langMatchesExpectation } from "./lang";
type Emit = (e: CourseEvent) => Promise<void> | void;

interface HistoryMsg {
  role: "user" | "assistant";
  content: string;
}

const COURSE_CLARIFY_SYSTEM = `你是课程设计师。用户想系统学习某个主题，但关键信息缺失。请生成 1 个选择题来澄清需求，只输出 JSON，不要输出任何其他内容。

铁律：问题必须针对用户本次想学的主题（见用户消息末尾的「用户想学习」）。画像和历史对话只用来校准基础水平与措辞，绝不能把问题、选项或理由引向画像/历史里的其他目标、项目或工具链——用户问"如何学习AI"，就不能问"你的 Coze 工作流卡在哪"。

维度（每轮选一个，优先问没覆盖过的）：
1. 前置经验 2. 关注的实现语境/方向 3. 学完的目标水平 4. 课程体量 5. 结课作品

去重铁律：出题前先逐条核对用户消息里的「已收集信息」——凡已问过的问题，禁止再出同维度或换措辞的重复题（例：已问过"内容按什么逻辑组织"，就禁止再问任何关于组织方式/排序/结构的问题），也禁止把用户已选的答案改成新选项再端出来。已覆盖的维度宁可问浅偏好（节奏/口径/案例风格），也绝不重复。

【结课作品一问：必须有，且整轮澄清只问一次】
以终为始：学员必须带着一个亲手做出的东西离开，而不是带走一堆"懂了"。所以这 4 轮里必须恰有一轮问结课作品，规则如下：
- 优先放在第 4 轮（最后一轮）问；前 3 轮从维度 1-4 里挑。
- 如果「已收集信息」里已经有结课作品的问答（不管它是第几轮问的），后续轮次禁止再问结课作品，改问其他没覆盖过的维度。
- 如果用户在输入里已明确说了要做出什么具体东西，可以完全不问这一题。
- 问题句式：「学完这门课，你想亲手做出哪个东西？（它是你的结课作品，整门课会围绕它倒推设计）」可按语境润色。
- multi 必须是 false。
- 选项是 3 个候选结课作品，每个都必须是**名词**——一个具体的、做出来能拿给别人看的东西；从资料主题和前面回答里长出来，难度贴合学员水平（零基础/青少年就别出"生产级系统"这种选项）。
- 每个选项 desc 一句话（≤ 22 字）：这东西做出来长什么样。
- 反面示例："一个 AI 项目"（太空泛）、"掌握提示词工程"（是状态不是东西）、"提升数据思维"（是形容词不是作品）。
- 正面示例（青少年 AI 课）：label「我的 AI 小助手」，desc「按自己性格调教的对话助手 + 提示词库」。
- 用户跳过或自己写一个都行（前端有自定义输入和跳过按钮），你只管把候选出好。

【字数纪律：用户一眼扫完才答得快】question ≤ 22 字；option.label ≤ 10 字（短名词/短语）；option.desc ≤ 20 字、只写一件可自查的具体事；3 个选项。

题干纪律：question 是一句短提问（≤ 22 字），只负责点出要澄清的分叉；禁止把路线细节、工具/命令名、各选项的展开复述进题干——细节只写在选项 desc 里，题干复述就是和选项重复。对比式问题压成短句（如"资料里有 A 和 B 两条路线，你想先走哪条？"）。

让选项"可对号入座"是最高优先级——每个选项的 desc 必须是可自查的具体行为或具体事物，而不是形容词：
- 好："手写过带 tools 参数的 Prompt"
- 坏："有一定基础，了解相关概念"
- 好选项示例：Basic: 基础 API 调用 / Intermediate: 函数调用经验 / Advanced: 复杂框架开发
- 如果给了资料要点，选项要贴合资料里的真实技术、工具、场景（如资料里反复出现 MCP，就把它做成一个选项方向）。

reason 字段（1 句话，≤24 字）说明"我为什么问这个"（如"资料里有 ReAct 和 MCP 两条路线"）。

输出格式：
{"question":"...","reason":"...","options":[{"label":"...","desc":"..."},{"label":"...","desc":"..."},{"label":"...","desc":"..."}]}`;

/** 教研质量闸门：蓝图 = 课程的体系设计，体系歪了后面全白搭。
 *  四条检查（顺序/覆盖/水分/标题），不合格带意见重写一次；审稿人挂了就放行（不阻塞交付）。 */
export const BLUEPRINT_REVIEW_SYSTEM = `你是课程教研审稿人。审查一份课程蓝图（课程的结构设计），只输出 JSON：{"pass":true|false,"issues":["具体问题1","问题2"]}

课程蓝图要经得起这五条检查（命中任何一条即 pass=false，并在 issues 里指名道姓：哪个单元/哪节课、什么问题）：
1. 顺序不成立：单元顺序违背学习规律——后面的单元用到了前面没讲过的概念；学员按顺序学到某一步会发现缺前置。
2. 覆盖有缺口：对照结课作品的要求和课程标题，明显缺了"要做出来就必须会"的**整个环节**（例：结课作品是一份数据分析报告，但全课没有一节教图表或结果呈现）。注意：课节数量少不是问题——一节课能讲清的就不许拆成三节；只有"完全缺失某个必需环节"才算缺口。
3. 有凑数单元/课节：某个单元或课节删掉，学员毫无损失（纯"介绍""展望""总结"而不指向具体能力产出的是水分；一节课末尾的小结不算）。
4. 标题空泛：课节标题是状态词空话（"深入了解XX""XX概述"），而不是具体的能力承诺（学员看完标题就知道这节学完能做什么）。
5. 受众倒挂：受众是零基础、要的是动手能力（做饭/摄影/工具上手等），但前两个单元仍是原理/理论，学员要学很久才第一次动手做出东西。
拿不准就算过（pass=true）：只打回真正不合格的蓝图，不要吹毛求疵——尤其不许因为"课节数量偏少""深度可以更高"这类理由打回。issues 每条 ≤ 40 字。`;

const COURSE_BLUEPRINT_SYSTEM = `你是资深课程架构师。根据用户想学的主题和背景信息，生成完整的课程结构蓝图。
只输出 JSON，不要输出任何其他内容。
JSON 格式（必须严格遵守）：
{
  "title": "课程标题",
  "audience": "目标受众描述（一句话，结合用户背景）",
  "tags": ["标签1", "标签2", "标签3"],
  "capstone": {
    "name": "结课作品名（一个名词，学员亲手做出的东西）",
    "description": "学员结课时手里具体有什么，1-2 句",
    "criteria": ["做成判断标准1（外人能对照检查）", "做成判断标准2", "做成判断标准3"]
  },
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
- 课程主题只能是「用户想学习」的主题本身；画像与澄清回答用于定深度、定受众，不得改变主题方向（用户问"如何学习AI"，课程就是 AI 通用学习路径，不能变成 Agent 工程课）。
- 以终为始：capstone（结课作品）是整门课的倒推起点。澄清回答里用户已选了结课作品 → 必须原样采用（名字可润色，不得偷换成别的作品）；用户跳过/没答 → 你根据资料和受众定一个最合适的，同样必须是名词、可展示、能带着学员自己的信息（全班做出来一模一样的不是作品）。
- 每个单元的 summary 先说"这个单元给结课作品贡献哪一块"，再说学完能做到什么；禁止"了解 XX""熟悉 XX"这类状态动词堆砌。
- 最后一个单元的最后一个课节必须是结课实操课，标题格式「结课实操：<完成并展示作品的具体动作>」，如「结课实操：调通你的 AI 小助手并讲给家人用」。
- 教材模式（给了教材内容）例外：单元/课节结构仍必须镜像教材目录，结课作品要在教材内容能支撑的范围内选，结课实操课对齐教材最后一章，不得新增教材外的课节。
- 有资料（网络资料要点/教材内容）时，单元和课节必须优先长在资料特有的主张、案例、数据、结构上——教材模式镜像教材目录，资料模式吃透资料要点；禁止对着主题凭空铺一张通用知识图谱，通识部分只做必要铺垫。资料偏理论、而学员要的是动手能力时，资料只当讲解素材，不得决定单元顺序。
- 先做后讲（零基础 / 手艺与操作类目标：做饭、摄影、软件与工具上手、写作、运动等）：第 1 单元第 1 节就让学员做出一个看得见的小成品；原理不单独成单元，只在某个具体动作需要时穿插讲（"为什么热锅冷油"放进"炒一盘青菜"那节）。单元按"学员能做出的东西"由易到难递进，而不是按学科知识体系递进；课节标题写成动作或成品（「番茄炒蛋：火候与下锅顺序」），不写学科概念（「热传导原理」）。
- 课程标题格式为「主标题：副标题」，体现主题、深度和受众。禁止把用户输入拼上"系统课程"。
  正面示例："LLM Agent 深度工程：从 ReAct 理论到生产级 Tool Use 实现"
- tags 是领域标签（如 "AI Engineering"、"ReAct Pattern"），禁止把用户原话当标签；标签语言跟随课程正文（中文课不给英文标签）。
- audience 必须回应用户在澄清中的具体选择：把用户选的起点/方向/目标水平浓缩成一句受众画像，
  如用户选了"能用 Redis 键值读写"+"了解分布式基本概念"，就写
  "具备 Redis 基础（KV 读写）及分布式系统基本概念，希望掌握生产级并发控制方案的开发者"。
- 篇幅跟受众走：零基础、年长、每天时间很少的学员 4-5 个单元、每单元 3 节，宁短勿长（学不完的长课等于没学）；有基础、目标是求职/考试/深造的 5-8 个单元、每单元 3-5 节。只剩 1 个课节的碎单元要并进相邻单元（独立的结课实操单元除外）。
- 单元标题必须两两不同：禁止同一标题加"（续）""（二）"复制粘贴充数；同一主题拆多个单元时，标题要写出各自覆盖的具体子领域。
- 单元标题要具体，体现该单元覆盖的知识范围，禁止"基础概念与入门"这种万能套话。
- 课节标题必须具体到知识点，格式推荐「具体概念：要解决的问题或角度」。
  反面示例："核心概念"、"基本术语"。正面示例："Function Calling 机制：原生支持与技术差异"。
- 每个课节标注 1-2 个深度标签：建立直觉 / 正式定义 / 公式推导 / 进阶理论 / 应用实操。
- 课节 id 格式 lec-{单元号}-{序号}。
- 【输出语言】全部内容（标题/受众/单元/课节/标签）必须使用「用户对这门课的要求」中指定的语言。`;

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
- tags 是领域标签（如 "AI Engineering"、"ReAct Pattern"），禁止把用户原话当标签；标签语言跟随课程正文（中文课不给英文标签）。
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
import { blueprintSchema, clarifyQuestionSchema, lectureDetailsSchema, reviewVerdictSchema } from "./schemas";

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
  docMode?: boolean; // 文档建课：管线为 5 步（查看文档→搜索补充→构思澄清→蓝图→大纲），步骤编号与纯文字不同
  docName?: string; // 上传文档的展示名（讲次参考文件回链用）
  courseSource?: string; // 自学 / 学校同步（原版同款）
  outputLanguage?: string; // 建课时从用户输入提取的输出语言（自由文本：中文/西班牙语/…，没提默认中文）
  constraints?: string[]; // 用户的其他硬性要求（原话关键词），注入管线每一步
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

// ---- 轻量索引（course-meta/）：列表页只要标题/规模/归属，不必拉整份课程文档 ----
// 课程全文档里躺着全部澄清对话、抓取的网页正文、教材全文，几百 KB 到几 MB；
// 列表页逐份读它，R2 模式下串行 24 门课要 7-9 秒。meta 只有几百字节。

export interface CourseMeta {
  title: string;
  ownerId?: string;
  audience: string;
  tags: string[];
  units: number;
  lectures: number;
  totalMin: number;
  source: string; // 教材 PDF / 文档 / AI 生成（卡片"来源"行用）
  // 可学课节的有序清单（id+标题，测验/项目不在内）：课程记录页据此算学习进度和"下一讲"。
  // 旧索引无此字段，列表接口会回读全文档一次性补建。
  lecs?: { id: string; t: string }[];
  createdAt?: number; // 首次生成时间（卡片"添加日期"用；补建索引时用课程文件的修改时间近似）
  updatedAt: number;
}

export function metaKey(id: string): string {
  return `course-meta/${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
}

/** 大纲未出的在制课程不进列表（返回 null），与列表接口的口径一致 */
export function courseMetaFromState(state: {
  ownerId?: string;
  title?: string;
  textbook?: { id: string } | null;
  docMode?: boolean;
  outline?: {
    title?: string;
    audience?: string;
    tags?: string[];
    units?: { lectures?: { id?: string; title?: string; duration_min?: number; content_type?: string }[] }[] | null;
  } | null;
}): CourseMeta | null {
  const outline = state.outline;
  if (!outline) return null;
  const units = Array.isArray(outline.units) ? outline.units : [];
  const lectures = units.reduce((s, u) => s + (u.lectures?.length || 0), 0);
  // 时长只统计可学的白板课节（测验/项目环节不算进可学时长）
  const totalMin = units.reduce(
    (s, u) =>
      s +
      (u.lectures || [])
        .filter((l) => l.content_type === "whiteboard" || !l.content_type)
        .reduce((t, l) => t + (l.duration_min || 0), 0),
    0
  );
  // 可学课节的有序清单：进度条与"接下来学什么"都按这个顺序推
  const lecs = units.flatMap((u) =>
    (u.lectures || [])
      .filter((l) => l.content_type === "whiteboard" || !l.content_type)
      .filter((l) => l.id)
      .map((l) => ({ id: l.id!, t: l.title || "" }))
  );
  return {
    title: state.title || outline.title || "未命名课程",
    ownerId: state.ownerId,
    audience: outline.audience || "",
    tags: Array.isArray(outline.tags) ? outline.tags.slice(0, 3) : [],
    units: units.length,
    lectures,
    totalMin,
    source: state.textbook ? "教材 PDF" : state.docMode ? "文档" : "AI 生成",
    lecs,
    updatedAt: Date.now(),
  };
}

export async function setCourseState(id: string, state: CourseGenState): Promise<void> {
  await writeJson(courseKey(id), state);
  // 顺手刷新小索引；索引写失败不拖累生成主流程（大头已经落盘）。
  // createdAt 从旧索引继承（首次生成时间），没有就取现在。
  const meta = courseMetaFromState(state);
  if (meta) {
    const prev = await readJson<CourseMeta | null>(metaKey(id), null).catch(() => null);
    meta.createdAt = prev?.createdAt || Date.now();
    await writeJson(metaKey(id), meta).catch(() => {});
  }
}

// ---- 分步执行 ----

const SEARCH_PLAN_SYSTEM = `你是搜索专家。用户想系统学习一个明确主题，请生成 3 个搜索引擎查询词，用于搜集该主题的高质量学习资料。
只输出 JSON：{"queries":["查询1","查询2","查询3"]}

语言策略（决定信息源头质量，必须遵守）：
- 只要主题涉及编程、AI、大模型、Agent、算法、数据、软件工具、数学、自然科学（判断依据：输入里出现 LLM/模型/Agent/API/算法/Python/代码/数据 等词，或主题是技术概念），3 个查询必须全部用英文——英文互联网的一手资料质量远高于中文。
- 人文 / 历史 / 语言考试 / 中国本土生活话题：用中文查询。
- 示例判断："LLM Agent 的 Tool Use" 是纯技术主题 → 全英文；"雅思托福备考" → 全中文；"上海本帮菜烹饪" → 全中文。

查询词与用户要求的边界（必须遵守）：
- 查询词只装主题内容词。用户对课程产出的要求——输出语言、水平、风格、格式（如"用中文讲""零基础""弄成西班牙语"）——不是资料的语言，禁止进入查询词：他要西班牙语的课，主题是机器学习，照样用英文查机器学习。

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
    .replace(/我的目标是|我想|我要|怎么|如何|系统地?|系统讲解|学习|掌握|了解|课程|教程|教材|《|》|围绕|生成|一份|文档/g, " ")
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

/** 内容农场/SEO 垃圾识别（实测：猫咪主题搜回来"猫咪TV/xx社区入口"这类站，污染澄清与蓝图） */
const SPAMMY_TLDS = /\.(top|xyz|site|online|club|icu|cyou|buzz|shop|vip|website|space|link|fun|store)$/i;

function looksLikeContentFarm(item: SourceItem): boolean {
  const d = item.domain.toLowerCase();
  if (SPAMMY_TLDS.test(d)) return true;
  if ((d.match(/-/g) || []).length >= 3) return true; // 连字符堆砌的精确匹配域名
  const text = `${item.title} ${item.snippet || ""}`;
  const farmWords = /(高清|大全|每日更新|免费观看|在线观看|免费下载|独家资源|网址导航|最新地址|社区入口)/;
  const knowledgeWords = /(教程|文档|笔记|课程|指南|原理|实战|源码|论文|官方|github|docs?)/i;
  return farmWords.test(text) && !knowledgeWords.test(text);
}

export async function runSearchStep(opts: {
  query: string;
  history: HistoryMsg[];
  emit: Emit;
  stepNo?: number; // 文档建课模式：搜索是第 2 步（共 5 步）；纯文字模式是第 1 步（共 4 步）
  stepTotal?: number;
  docContext?: string; // 文档建课模式：已读文档要点，搜索词围绕文档主题补充
  existingSources?: SourceItem[]; // 文档内容块（已占用的编号），网络来源接着编号
  existingPages?: Record<number, string>;
  readLimit?: number; // 要读全文的网页数（文档模式读少一点，文档本身才是主料）
  constraintsText?: string; // 用户对课程的要求块（提醒规划器别把语言/风格要求当查询词）
}): Promise<{ sources: SourceItem[]; pageContents: Record<number, string> }> {
  const { query, emit } = opts;
  const stepNo = opts.stepNo ?? 1;
  const stepTotal = opts.stepTotal ?? 4;
  const docContext = opts.docContext;
  const sources: SourceItem[] = [...(opts.existingSources ?? [])];
  const pageContents: Record<number, string> = { ...(opts.existingPages ?? {}) };
  const topic = normalizeLearningTopic(query);

  await emit({ type: "stage", name: "search", label: "正在搜索网络资料", status: "start", detail: `第 ${stepNo} 步，共 ${stepTotal} 步` });

  // 先用 LLM 把口语化输入提炼成高质量搜索词（Hyperknow 的 query 标签就是这步的产物）
  let searchQueries: string[] = [];
  const plan = await generateJson<{ queries: string[] }>(
    SEARCH_PLAN_SYSTEM,
    `${opts.constraintsText ?? ""}${docContext ? `用户已上传一份文档，主题如下（查询词必须围绕文档主题做补充，不要偏航）：\n${docContext.slice(0, 800)}\n\n` : ""}用户原始目标：${query}\n已提炼主题（必须围绕它搜索）：${topic}`, { task: "fast", maxTokens: 400 }
  );
  if (plan?.queries && Array.isArray(plan.queries) && plan.queries.length > 0) {
    searchQueries = plan.queries
      .map(String)
      .map((q) => q.replace(/[，。！？：:、]/g, " ").replace(/\s+/g, " ").trim())
      .filter((q) => q.length > 0)
      // 文档模式：文档标题 token 和中文查询对不上，主题词过滤会误杀 LLM 规划的好查询，
      // 只留空串检查；纯文字模式保留主题词过滤
      .filter((q) => (docContext ? true : isRelevantQuery(q, topic)))
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

  const existingCount = opts.existingSources?.length ?? 0;
  const webCap = opts.docContext ? 4 : 12; // 文档模式：网络只是补充资料，主料是文档本身
  const settled = await Promise.allSettled(searchQueries.map((q) => webSearch(q, 6, { goal: query })));
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const item of s.value) {
      if (seen.has(item.url) || isLikelyOffTopic(item, topic) || looksLikeContentFarm(item)) continue;
      seen.add(item.url);
      sources.push({ ...item, index: sources.length + 1 });
      if (sources.length - existingCount >= webCap) break;
    }
    if (sources.length - existingCount >= webCap) break;
  }
  await emit({ type: "sources", items: sources });
  await emit({ type: "stage", name: "search", label: "正在搜索网络资料", status: "end", detail: `找到 ${sources.length} 个来源` });

  // 阅读权威度最高的前几页：蓝图/澄清的选项质量直接来自这些正文（Hyperknow 同款打法）
  // 文档模式下跳过已有正文的内容块（文档本身就是已读资料），只补读网络来源
  const toRead = sources.filter((s) => !pageContents[s.index]).slice(0, opts.readLimit ?? 6);
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

// ---- 澄清问题去重兜底 ----
// 四轮澄清各自独立生成，低温度下模型偶尔把同一维度换个措辞再问一遍（实测：手册建课
// 的 Q2/Q3 都在问"内容怎么组织"）。提示词铁律之外，这里对新问题与每个已问问题做字符
// 2-gram 相似度（对中文短句够用，不上向量）；超阈值就带着"重复"的意见重生成一次，
// 仍重复也放行——兜底不能卡死主流程。
function questionBigrams(s: string): Set<string> {
  const t = s.replace(/[，。？！、：；\s？!.,'"（）()「」《》-]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function questionSimilarity(a: string, b: string): number {
  const A = questionBigrams(a);
  const B = questionBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

// 阈值 0.45：实测"同题换措辞"在 0.5 上下（"内容怎么组织"vs"术语按什么方式组织排列"），
// 完全不同维度接近 0；误触发只多一次带意见重试，代价便宜，宁紧勿松。
const DUPLICATE_THRESHOLD = 0.45;

export async function runClarifyStep(opts: {
  query: string;
  history: HistoryMsg[];
  sources: SourceItem[];
  clarifyAnswers: { question: string; answer: string }[];
  round: number;
  courseId: string;
  profileHint?: string; // 已有画像，避免重复提问已覆盖的维度
  pageExcerpts?: string; // 搜索到的资料摘要，让澄清选项更贴近真实语境
  stepNo?: number; // 文档建课模式：澄清在第 3 步（共 5 步）
  stepTotal?: number;
  constraintsText?: string; // 用户已提出的要求：澄清题要遵守其语言，且不重复问已覆盖的事
  emit: Emit;
}): Promise<{ question?: ClarifyQuestion; done: boolean }> {
  const { query, history, sources, clarifyAnswers, round, courseId, profileHint, pageExcerpts, emit } = opts;
  const stepNo = opts.stepNo ?? 2;
  const stepTotal = opts.stepTotal ?? 4;

  await emit({ type: "stage", name: "clarify_round", label: "构思初步思路", status: "start", detail: `第 ${stepNo} 步，共 ${stepTotal} 步（第 ${round}/4 轮）` });

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
    ? `学员历史画像（只用于判断基础水平、避免重复提问；问题本身必须围绕下面的「用户想学习」，禁止偏向画像里的其他目标/项目）：\n${profileHint}\n\n`
    : "";
  const constraintsContext = opts.constraintsText
    ? `${opts.constraintsText}（其中输出语言等要求同样适用于你出的澄清题；用户已明确表达的要求不要再问）\n\n`
    : "";

  const userMsg = `${constraintsContext}${context}${prevAnswers}${sourceContext}${excerptsContext}${profileContext}用户想学习：${query}\n\n请生成第 ${round} 个澄清问题。`;

  const isValidQuestion = (q: ClarifyQuestion | null | undefined): q is ClarifyQuestion =>
    Boolean(q && q.question && Array.isArray(q.options) && q.options.length >= 2);

  let question = await generateJson<ClarifyQuestion>(COURSE_CLARIFY_SYSTEM, userMsg, { task: "design", schema: clarifyQuestionSchema });

  // 澄清卡是产品对用户的核心承诺：模型偶发吐出坏 JSON/空对象时，重问一次而不是静默跳过
  if (!isValidQuestion(question)) {
    console.error(`[clarify] round ${round} 输出不合格，重试一次：`, JSON.stringify(question)?.slice(0, 300));
    question = await generateJson<ClarifyQuestion>(
      COURSE_CLARIFY_SYSTEM,
      `${userMsg}

⚠ 你上一次的输出不是合法的题目 JSON。重新输出：只输出一个 JSON 对象，格式为 {"question":"一句中文提问","reason":"≤40字理由","options":[{"label":"…","desc":"…"},{"label":"…","desc":"…"},{"label":"…","desc":"…"}]}，options 至少 3 个。`, { task: "design", schema: clarifyQuestionSchema }
    );
  }
  if (!isValidQuestion(question)) {
    // 第 1 轮绝不跳过：用户输入往往很短（如"学习AI"），澄清卡没了用户会觉得被无视。
    // 模型连续两次输出不合格时，用保底的前置经验题兜底。
    console.error(`[clarify] round ${round} 重试仍不合格，改用保底题`);
    if (round === 1) {
      const fallback: ClarifyQuestion = {
        id: "q1",
        question: `在这个主题上，你目前的起点更接近哪一种？`,
        reason: "先确认起点，避免课程讲得太浅或太深",
        multi: false,
        skippable: true,
        options: [
          { label: "完全零基础", desc: "没系统接触过，想从最核心的概念开始，别一上来就堆术语" },
          { label: "有一些了解", desc: "零散看过一些内容，想系统梳理清楚，并补上动手实操" },
          { label: "比较熟练", desc: "有实际使用/动手经验，想直奔进阶主题和实战方法" },
        ],
      };
      await emit({ type: "clarify_round", round, total_rounds: 4, question: fallback, courseId });
      return { question: fallback, done: false };
    }
    await emit({ type: "stage", name: "clarify_round", label: "构思初步思路", status: "end", detail: "澄清完成" });
    return { done: true };
  }

  let normalized: ClarifyQuestion = {
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

  // 去重兜底：与已问过的问题撞车就带着意见重生成一次（仍重复则放行，不卡流程）
  const dupHit = clarifyAnswers
    .map((a) => a.question)
    .find((q) => questionSimilarity(q, normalized.question) >= DUPLICATE_THRESHOLD);
  if (dupHit) {
    const retry = await generateJson<ClarifyQuestion>(
      COURSE_CLARIFY_SYSTEM,
      `${userMsg}\n\n⚠ 你刚才出的问题「${normalized.question}」与已收集信息里的问题「${dupHit}」是同一个维度，属于重复出题。请换一个完全不同的、尚未覆盖的维度重新出题，禁止与任何已问问题同义。`, { task: "design", schema: clarifyQuestionSchema }
    );
    if (retry?.question && retry.options?.length >= 2) {
      normalized = {
        id: `q${round}`,
        question: String(retry.question),
        reason: typeof retry.reason === "string" ? String(retry.reason).slice(0, 60) : undefined,
        multi: Boolean(retry.multi),
        skippable: retry.skippable !== false,
        options: retry.options.slice(0, 4).map((o) => ({
          label: String(o.label || ""),
          desc: o.desc ? String(o.desc) : undefined,
        })),
      };
    }
  }

  await emit({
    type: "clarify_round",
    round,
    total_rounds: 4,
    question: normalized,
    courseId,
  });

  return { question: normalized, done: false };
}

/** 从澄清回答里捞用户选的结课作品（蓝图 LLM 弄丢字段时的兜底；跳过/未答返回 undefined） */
function capstoneFromAnswers(
  answers: { question: string; answer: string }[]
): BlueprintCapstone | undefined {
  const hit = answers.find((a) => /结课作品|亲手做出|做出哪个|做出什么/.test(a.question));
  const name = hit?.answer?.trim();
  if (!name || name === "跳过" || name === "未作答") return undefined;
  return {
    name: name.slice(0, 60),
    description: "学员结课时亲手完成的作品（澄清阶段自选或自填）",
    criteria: [],
  };
}

export async function runBlueprintStep(opts: {
  query: string;
  clarifyAnswers: { question: string; answer: string }[];
  feedback?: string;
  previousBlueprint?: CourseBlueprint;
  profileText?: string; // 学习者画像（跨课程持久化）
  pageExcerpts?: string; // 已读网页要点：让蓝图 grounded 在真实资料上
  textbookHint?: string; // 教材模式：目录+要点，蓝图必须镜像教材结构
  outputLanguage?: string; // 用户要求的输出语言（自由文本），蓝图全文必须使用
  constraints?: string[]; // 用户的其他硬性要求
  stepNo?: number; // 文档建课模式：蓝图在第 4 步（共 5 步）
  stepTotal?: number;
  emit: Emit;
}): Promise<{ blueprint: CourseBlueprint }> {
  const { query, clarifyAnswers, feedback, previousBlueprint, profileText, pageExcerpts, textbookHint, emit } = opts;
  const stepNo = opts.stepNo ?? 3;
  const stepTotal = opts.stepTotal ?? 4;

  await emit({ type: "stage", name: "blueprint", label: "打造课程", status: "start", detail: `第 ${stepNo} 步，共 ${stepTotal} 步` });

  const answerContext = clarifyAnswers.length > 0
    ? `用户背景：\n${clarifyAnswers.map((a) => `${a.question}：${a.answer}`).join("\n")}\n\n`
    : "";
  const profileContext = profileText
    ? `学习者画像（跨课程沉淀，只用于量身定制深度与取舍；课程主题只能是本次「用户想学习」的主题，禁止把单元/课节带向画像里的其他目标或项目）：\n${profileText}\n\n`
    : "";
  const excerptsContext = pageExcerpts
    ? `网络资料要点（单元和课节设计要覆盖这些真实内容中的关键概念，标题要具体到知识点）：\n${pageExcerpts}\n\n`
    : "";
  const textbookContext = textbookHint
    ? `教材内容（课程结构必须镜像这本教材：单元对应教材的章/单元，课节对应教材的节，标题优先用教材官方术语，按教材顺序排列，不要自由发挥）：\n${textbookHint}\n\n`
    : "";
  const constraintsContext = constraintsBlock(opts.outputLanguage, opts.constraints);

  // 先产出"设计思路"给用户看：推理外显，而不是黑盒蹦出一张蓝图
  const thinking = await generateJson<{ notes: string[] }>(
    `你是课程架构师。基于用户目标、澄清回答和资料要点，用 2-3 句话说明你打算怎么设计这门课、为什么，只输出 JSON：{"notes":["...","..."]}
要求：每句 ≤ 45 字；必须引用澄清回答里的具体选择和资料里的具体概念（如"你选了生产级，所以第 4 单元直接进错误重试实战"）；不要客套；使用「用户对这门课的要求」中指定的输出语言。`,
    `${constraintsContext}${answerContext}${excerptsContext}用户想学习：${query}`, { task: "design", maxTokens: 500 }
  );
  if (Array.isArray(thinking?.notes) && thinking.notes.length > 0) {
    await emit({ type: "design_notes", notes: thinking.notes.slice(0, 4).map((n) => String(n).slice(0, 60)) });
  }
  const feedbackContext = feedback
    ? `上一版蓝图：\n${JSON.stringify(previousBlueprint || {}, null, 2)}\n\n用户对上一版蓝图的修改意见：${feedback}\n请根据修改意见重新生成完整蓝图（保持 JSON 格式不变）。\n\n`
    : "";

  const blueprintUserMsg = `${constraintsContext}${answerContext}${profileContext}${textbookContext}${excerptsContext}${feedbackContext}用户想学习：${query}\n\n请生成课程结构蓝图。`;
  let raw = await generateJson<CourseBlueprint>(COURSE_BLUEPRINT_SYSTEM, blueprintUserMsg, { task: "design", maxTokens: 4000, schema: blueprintSchema });

  // 教研质量闸门（设在语言守卫之前：重写后仍要过语言关）。
  // 大纲步骤只是给蓝图填细节——体系的顺序/覆盖/水分/标题在蓝图就定了，闸门必须设在这。
  if (raw?.units?.length) {
    try {
      await emit({ type: "stage", name: "blueprint", label: "教研审核", status: "start", detail: "顺序·覆盖·水分·标题" });
      const review = await generateJson<{ pass?: boolean; issues?: string[] }>(
        BLUEPRINT_REVIEW_SYSTEM,
        `课程题目：${query}
结课作品：${
          raw.capstone?.name
            ? `${raw.capstone.name}——${raw.capstone.description}（验收标准：${(raw.capstone.criteria || []).join("；")}）`
            : "未定义"
        }
课程蓝图（单元与课节结构）：
${(raw.units || [])
  .map(
    (u, i) =>
      `单元${i + 1}【${u.title}】${u.summary || ""}\n${(u.lectures || [])
        .map((l) => `  - ${l.title}`)
        .join("\n")}`,
  )
  .join("\n")}

请审查这份课程蓝图。`, { task: "judge", maxTokens: 800, schema: reviewVerdictSchema }
      );
      if (review && review.pass === false && Array.isArray(review.issues) && review.issues.length > 0) {
        const retry = await generateJson<CourseBlueprint>(
          COURSE_BLUEPRINT_SYSTEM,
          `${blueprintUserMsg}\n\n【教研审稿意见】上一版蓝图未通过审核：\n${review.issues
            .map((s) => `- ${String(s).slice(0, 60)}`)
            .join("\n")}\n请逐条修正（调整单元顺序 / 补齐覆盖缺口 / 删掉凑数单元 / 把空泛标题改成具体能力承诺），重新生成完整蓝图（保持 JSON 格式不变）。`, { task: "design", maxTokens: 4000, schema: blueprintSchema }
        );
        if (retry?.units?.length) raw = retry;
      }
      await emit({
        type: "stage",
        name: "blueprint",
        label: "教研审核",
        status: "end",
        detail: review?.pass === false ? "已按审稿意见重写" : "通过",
      });
    } catch {
      // 审稿失败不阻塞交付
    }
  }

  // 输出语言守卫：蓝图整段跑偏（要求西班牙语却产出中文）时带硬约束重试一次。
  // 守卫判不了的语言（null）不拦，重试仍失败也不拦——管线不因守卫卡死。
  const langCheckText = raw
    ? [
        raw.title,
        raw.audience,
        raw.capstone ? [raw.capstone.name, raw.capstone.description, ...(raw.capstone.criteria || [])].join(" ") : "",
        ...(raw.units || []).flatMap((u) => [u.title, u.summary, ...(u.lectures || []).map((l) => l.title)]),
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  if (raw && langMatchesExpectation(opts.outputLanguage, langCheckText) === false) {
    const retry = await generateJson<CourseBlueprint>(
      COURSE_BLUEPRINT_SYSTEM,
      `${blueprintUserMsg}\n\n【语言硬约束】上一版的语言不符合要求：整份蓝图必须使用「${opts.outputLanguage}」输出，逐字检查后再交。`, { task: "design", maxTokens: 4000, schema: blueprintSchema }
    );
    if (retry?.units?.length) raw = retry;
  }

  // 兜底：LLM 失败时返回一个最小骨架
  const capstone: BlueprintCapstone | undefined = raw?.capstone?.name
    ? {
        name: String(raw.capstone.name).slice(0, 60),
        description: String(raw.capstone.description || "").slice(0, 200),
        criteria: Array.isArray(raw.capstone.criteria)
          ? raw.capstone.criteria.map(String).map((c) => c.slice(0, 80)).filter(Boolean).slice(0, 4)
          : [],
      }
    : // LLM 没给 capstone 时从澄清回答里捞：用户明明选了作品，蓝图却弄丢是不可接受的
      capstoneFromAnswers(clarifyAnswers);

  const blueprint: CourseBlueprint = {
    title: raw?.title || `${query}：系统精讲`,
    audience: raw?.audience || "希望系统学习该主题的学习者",
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
    ...(capstone ? { capstone } : {}),
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
  refFileName?: string; // 文档建课模式：讲次卡回链的上传文档名
  outputLanguage?: string; // 用户要求的输出语言：大纲全文（含课节简介）必须使用
  constraints?: string[]; // 用户的其他硬性要求，写进大纲带到课堂
  stepNo?: number; // 文档建课模式：大纲在第 5 步（共 5 步）
  stepTotal?: number;
  emit: Emit;
}): Promise<{ outline: CourseOutline; title: string }> {
  const { query, clarifyAnswers, blueprint, profileText, refFileName, emit } = opts;
  const stepNo = opts.stepNo ?? 4;
  const stepTotal = opts.stepTotal ?? 4;

  await emit({ type: "stage", name: "outline", label: "完善课程", status: "start", detail: `第 ${stepNo} 步，共 ${stepTotal} 步` });

  const answerContext = clarifyAnswers.length > 0
    ? `用户背景：\n${clarifyAnswers.map((a) => `${a.question}：${a.answer}`).join("\n")}\n\n`
    : "";
  const profileContext = profileText
    ? `学习者画像：\n${profileText}\n\n`
    : "";
  const capstoneContext = blueprint.capstone
    ? `课程结课作品：《${blueprint.capstone.name}》——${blueprint.capstone.description}（学员学完必须亲手完成它，这是全课的终点）。\n\n`
    : "";

  // 蓝图已经包含完整的课程结构（单元+课节标题+深度标签），
  // 大纲步骤只需逐单元填充课节细节（简介、时长、内容类型）
  let optimizedLectures = 0;
  const fullUnits = [];
  for (let i = 0; i < blueprint.units.length; i++) {
    const unit = blueprint.units[i];
    const isLastUnit = i === blueprint.units.length - 1;
    await emit({
      type: "outline_progress",
      current: i + 1,
      total: blueprint.units.length,
      unitTitle: unit.title,
    });

    const detailJson = await generateJson<{ lectures: { id: string; summary: string; duration_min: number; content_type: string }[] }>(
      `你是课程设计师。为课程的某一个单元的课节列表填充细节。
只输出 JSON：{"lectures":[{"id":"...","summary":"...","duration_min":20,"content_type":"whiteboard"}]}

规则：
- summary 用「能做成什么」句式：学完本节能独立完成 / 能解释为什么 / 能判断什么具体的事，一句话 ≤ 30 字。禁止"了解 XX""熟悉 XX"这类状态动词空话。
- 输出语言：summary 必须使用「用户对这门课的要求」中指定的语言。
- content_type 只能是 "whiteboard" | "project" | "quiz"；绝大多数为 "whiteboard"，每个单元最多 1 个 "project" 或 "quiz"。${isLastUnit ? '\n- 本单元是课程的最后一个单元：最后一个课节的 content_type 必须是 "project"（结课实操课，学员在这节课完成并展示结课作品），summary 写清学员在这里把作品做成什么样。' : ""}
- 课节时长 15-30 分钟。
- 不要修改课节 id 和标题，只填充细节。`,
      `${constraintsBlock(opts.outputLanguage, opts.constraints)}${capstoneContext}${profileContext}${answerContext}课程：《${blueprint.title}》\n当前单元：${unit.title}\n课节列表：${unit.lectures.map((l) => `${l.id}: ${l.title} (${l.depth_tags.join("/")})`).join("\n")}`, { task: "design", maxTokens: 2000, schema: lectureDetailsSchema }
    );

    const detailMap = new Map<string, { summary: string; duration_min: number; content_type: string }>();
    if (Array.isArray(detailJson?.lectures)) {
      for (const d of detailJson.lectures) {
        if (d.id) detailMap.set(d.id, d);
      }
    }

    const lectures = unit.lectures.map((l, j) => {
      const detail = detailMap.get(l.id);
      optimizedLectures += 1;
      // 结课实操保底：末单元的最后一课固定为 project（单课节的兜底课程除外，否则整门课不可学）
      const isCapstoneLecture = isLastUnit && j === unit.lectures.length - 1 && unit.lectures.length > 1;
      const detailType = (["whiteboard", "project", "quiz"] as const).includes(detail?.content_type as any)
        ? (detail!.content_type as "whiteboard" | "project" | "quiz")
        : ("whiteboard" as const);
      return {
        id: l.id,
        title: l.title,
        summary: detail?.summary || `深入讲解「${l.title}」`,
        duration_min: typeof detail?.duration_min === "number" ? detail.duration_min : 20,
        depth_tags: l.depth_tags,
        content_type: isCapstoneLecture ? ("project" as const) : detailType,
        ...(refFileName ? { ref_files: [refFileName] } : {}),
      };
    });

    fullUnits.push({ ...unit, lectures });

    await emit({
      type: "outline_progress",
      current: i + 1,
      total: blueprint.units.length,
      unitTitle: unit.title,
      optimized: optimizedLectures,
    });
  }

  const outline: CourseOutline = {
    title: blueprint.title,
    audience: blueprint.audience,
    tags: blueprint.tags,
    ...(blueprint.capstone ? { capstone: blueprint.capstone } : {}),
    units: fullUnits,
    outputLanguage: opts.outputLanguage,
    constraints: opts.constraints,
  };

  await emit({ type: "outline", outline });
  await emit({ type: "stage", name: "outline", label: "完善课程", status: "end", detail: `生成 ${outline.units.length} 个单元` });

  return { outline, title: outline.title };
}
