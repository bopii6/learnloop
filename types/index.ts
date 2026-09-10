// 全项目共享类型

export type Role = "user" | "assistant";

export interface SourceItem {
  index: number;
  title: string;
  url: string;
  domain: string;
  snippet?: string;
}

export interface StageRecord {
  name: string;
  label: string;
  detail?: string;
}

export interface StoredMessage {
  id: string;
  role: Role;
  content: string;
  sources?: SourceItem[];
  stages?: StageRecord[];
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  ownerId?: string; // 创建者（登录后记录；无主 = 历史数据/未登录创建）
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  ownerId?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ---- SSE 事件协议（前端只认这些类型） ----

export type StageName =
  | "classify"
  | "plan"
  | "reading_doc"
  | "search"
  | "read"
  | "verify"
  | "write"
  | "clarify_round"
  | "blueprint"
  | "outline";

export interface ClarifyOption {
  label: string;
  desc?: string;
}

export interface ClarifyQuestion {
  id: string;
  question: string;
  reason?: string; // 为什么问这个：让用户看到 AI 的推理
  multi: boolean;
  options: ClarifyOption[];
  skippable: boolean;
}

export type AgentEvent =
  | { type: "stage"; name: StageName; label: string; status: "start" | "end"; detail?: string }
  | { type: "clarify"; questions: ClarifyQuestion[] }
  | { type: "sources"; items: SourceItem[] }
  | { type: "token"; text: string }
  | { type: "done"; conversationId: string; title?: string }
  | { type: "error"; message: string };

// ---- 课程生成（Deep Learn）类型 ----

export interface CourseUnit {
  id: string;
  title: string;
  summary: string;
  key_concepts: string[];
  lectures: CourseLecture[];
}

export interface CourseLecture {
  id: string;
  title: string;
  summary: string;
  duration_min: number;
  depth_tags: string[]; // 建立直觉 / 正式定义 / 公式推导 / 进阶理论 / 应用实操
  content_type: "whiteboard" | "project" | "quiz";
  ref_files?: string[]; // 文档建课模式：本讲次引用的上传文档（如《xxx.pdf》），讲次卡回链展示
}

export interface CourseOutline {
  title: string;
  audience: string;
  tags: string[];
  capstone?: BlueprintCapstone; // 结课作品（澄清阶段由用户选定，蓝图/大纲贯穿使用）
  units: CourseUnit[];
  outputLanguage?: string; // 建课时从用户输入提取的输出语言（自由文本，如"中文""西班牙语"）
  constraints?: string[]; // 用户的其他硬性要求（原话关键词，如"零基础""多举游戏行业的例子"）
}

export interface CourseSession {
  id: string;
  courseId: string;
  unitId: string;
  lectureId: string;
  title: string;
  status: "not_started" | "in_progress" | "completed";
  whiteboardState?: any; // Excalidraw elements
  createdAt: number;
  updatedAt: number;
}

// ---- 结构化蓝图（可交互编辑） ----

export interface BlueprintLecture {
  id: string;
  title: string;
  depth_tags: string[];
}

export interface BlueprintUnit {
  id: string;
  title: string;
  summary: string;
  key_concepts: string[];
  lectures: BlueprintLecture[];
}

/** 结课作品：学员学完必须亲手做出的那个东西（名词、可展示、带着学员自己的信息），
 *  整门课的单元按"为它贡献哪一块"倒推组织。 */
export interface BlueprintCapstone {
  name: string; // 作品名（一个名词，如"我自己的 AI 小助手"）
  description: string; // 学员结课时手里具体有什么，1-2 句
  criteria: string[]; // 做成判断标准：外人能对照检查的 2-4 条
}

export interface CourseBlueprint {
  title: string;
  audience: string;
  tags: string[];
  capstone?: BlueprintCapstone;
  units: BlueprintUnit[];
}

export interface Course {
  id: string;
  title: string;
  query: string;
  audience: string;
  tags: string[];
  outline: CourseOutline;
  sources: SourceItem[];
  status: "generating" | "ready" | "failed";
  createdAt: number;
  updatedAt: number;
}

// ---- 课程生成 SSE 事件协议 ----

export type CourseEvent =
  | { type: "stage"; name: StageName; label: string; status: "start" | "end"; detail?: string }
  | { type: "design_notes"; notes: string[] } // AI 的课程设计思路（推理感）
  | { type: "chitchat_reply"; reply: string } // 输入不是学习意图：闲聊回复，不生成课程
  | { type: "qa_status"; text: string } // 入口问答回路：正在查资料的进度提示
  | { type: "qa_reply"; reply: string; sources: SourceItem[] } // 入口问答回路：带引用的直接回答（不建课）
  | { type: "search_queries"; queries: string[] } // 检索词 chips
  | { type: "clarify_round"; round: number; total_rounds: number; question: ClarifyQuestion; courseId: string }
  | { type: "course_created"; courseId: string } // 建课一开始就广播 id：取消/刷新找回都不用等到澄清轮
  | { type: "sources"; items: SourceItem[] }
  | { type: "blueprint"; data: CourseBlueprint }
  | { type: "outline_progress"; current: number; total: number; unitTitle: string; optimized?: number } // optimized = 已填充完细节的课节累计数（"已优化 N 个课节"）
  | { type: "outline"; outline: CourseOutline }
  | { type: "done"; courseId: string; title: string; saveFailed?: boolean } // saveFailed = 最终存档重试耗尽；大纲已在前端，可"重试保存"补写
  | { type: "save_ok" } // save_course 动作：补存成功
  | { type: "credits_block"; balance: number; need: number; reason: string } // 积分不足拦截
  | { type: "error"; message: string };

// ---- 白板教学：beat 脚本（生成与播放分离） ----

/** 板书的一个条目，随某一句讲解写上白板 */
export interface BoardItem {
  kind:
    | "subtitle"
    | "bullet"
    | "note"
    | "table"
    | "diagram"
    | "circle"
    | "underline"
    | "burst"
    | "chart" // 手绘趋势折线
    | "vs" // 左右对比栏
    | "judge" // ✓/✗ 判断行
    | "mark" // 星标/感叹号/问号简笔标记（标在上一条旁）
    | "tree" // 一层分支树
    | "quote" // 金句：椭圆手绘圈住一句话
    | "cast"; // 角色出演：把白板角色画进场景当当事人（场景锚定的关键瞬间）
  text?: string; // cast 用：角色标注（如"凌晨2点的你"，≤10字）
  values?: number[]; // chart 用：2-5 个纵值
  verdict?: "good" | "bad"; // judge 用
  style?: "star" | "alert" | "question"; // mark 用
  action?: "alert" | "think" | "happy" | "fail" | "point" | "run"; // cast 用：角色动作
  headers?: string[]; // table 用
  rows?: string[][]; // table 用
  nodes?: string[]; // diagram/tree 用
}

/** 一个教学拍：say 是本句讲解词（逐句朗读），items 是随这句话写上白板的内容 */
export interface TeachBeat {
  say: string;
  section?: string; // 板书分区名；省略 = 沿用上一个分区
  items?: BoardItem[];
}

export interface WhiteboardMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  kind?: "lecture" | "board" | "highlight" | "user";
  segmentId?: string;
  label?: string; // 消息顶部的分段标签（如 "3 · 核心机制"）
}

export type WhiteboardEvent =
  | { type: "stage"; name: string; label: string; status: "start" | "end"; detail?: string }
  | { type: "doc_pages"; docTitle: string; pages: { page: number; text: string }[] } // 文档建课：本节课引用的原文页，白板页"对照原文"面板用
  | {
      type: "beats";
      segmentId: string;
      index: number;
      total: number;
      title: string;
      anchor?: string; // 本片段锚点词（白板正中大字圈画；旧缓存脚本无此字段则跳过）
      beats: TeachBeat[];
      checkpoint?: SegmentCheckpoint;
      points?: string[]; // 课堂步骤（右侧轨），随首个 beats 事件下发
      pointIndex?: number; // 当前片段对应到第几个步骤
    }
  | { type: "token"; text: string } // 学员提问的流式回答
  | { type: "achievement"; title: string; desc: string } // 答对课堂练习的成就徽章（原版同款）
  | { type: "lecture_quiz"; quiz: LectureQuizItem[] } // 课后练习：整节课讲完后下发 3-5 道题
  | { type: "done"; sessionId: string }
  | { type: "credits_block"; balance: number; need: number; reason: string } // 积分不足拦截
  | { type: "error"; message: string };

/** 课堂练习：内嵌在字幕区的选择题（原版 Hyperknow 的 checkpoint 打法） */
export interface SegmentCheckpoint {
  question: string;
  options: string[]; // 2-3 个具体选项
}

/** 课后练习：一节课讲完后的 3-5 道单选/多选题（带答案与解析，即时判分） */
export interface LectureQuizItem {
  question: string;
  multi: boolean;
  options: string[];
  answerIndexes: number[]; // 正确选项下标
  explain: string; // 为什么：一句话解析
}

// ---- 课程回放（Manus Replay 式：一个链接回看整节课的板书+讲解） ----

/** 回放里的一拍：只保留播放所需的最小字段 */
export interface ReplayBeat {
  say: string;
  section?: string;
  items?: BoardItem[];
  segmentTitle: string; // 片段标题（板书胶囊）
}

export interface ReplayReel {
  id?: string;
  courseId: string;
  unitId: string;
  lectureId: string;
  courseTitle: string;
  lectureTitle: string;
  createdAt: number;
  beats: ReplayBeat[];
}

// ---- 结课作品工坊（Capstone Studio）：project 课节的真实体验 ----

/** 任务书：把"做出结课作品"拆成学员可执行的一步步 */
export interface CapstoneBrief {
  title: string; // 任务书标题（带学员的场景，因人而异）
  mission: string; // 一句话说清最终交出什么（名词性的东西）
  steps: { title: string; detail: string }[]; // 4-6 步，每步有明确产出
  references: string[]; // 建议回看的课节标题（从大纲里选）
  criteriaCheck: { text: string; hint: string }[]; // 做成标准的可执行化 + 自查方法
  pitfalls: string[]; // 常见翻车点（具体到动作）
  timeEstimate: string; // 预计投入
}

/** 验收结果：对照做成标准逐条判定，铁面无私 */
export interface CapstoneReview {
  passed: boolean;
  overall: string;
  criteria: { text: string; met: boolean; comment: string }[];
  strengths: string[];
  improvements: string[];
}

export interface CapstoneSubmission {
  at: number;
  text: string;
  link?: string;
  review: CapstoneReview;
}

export interface CapstoneRecord {
  courseId: string;
  userId: string;
  lectureId: string;
  capstoneName: string;
  brief?: CapstoneBrief;
  briefAt?: number;
  submissions: CapstoneSubmission[];
  passed: boolean;
  passedAt?: number;
  updatedAt: number;
}

// ---- 单元测验（quiz 课节的真实体验） ----

/** 单元测验题：结构与课堂课后练习一致，独立成课节使用 */
export interface UnitQuizItem {
  question: string;
  multi: boolean;
  options: string[];
  answerIndexes: number[]; // 正确选项下标（下发学员前会剥离）
  explain: string;
}

export interface QuizRecord {
  courseId: string;
  userId: string;
  lectureId: string;
  quiz?: UnitQuizItem[];
  attempts: { at: number; score: number; total: number }[];
  passed: boolean;
  bestScore?: number;
  updatedAt: number;
}

// ---- 教材（PDF 上传）----

export interface TextbookPage {
  page: number;
  text: string;
}

// ---- 课程集市 ----

export interface MarketEntry {
  courseId: string;
  title: string;
  author: string; // "official" = 官方精选
  price: number; // 0 = 免费（支付链路未接，先做标价展示）
  note?: string; // 上架时的一句话推荐语
  addedAt: number;
  // 公开发布：所有访客（含匿名）可见。旧数据无此字段时的兼容规则：
  // 无主条目 = 公开（历史行为），有主未标记 = 仅主人可见（维持原状，不被突然公开）
  isPublic?: boolean;
  // GET 响应附带的计算字段：当前登录用户能否下架此条目
  canDelete?: boolean;
  // GET 响应从 course-meta 索引带出的课程规模（列表卡徽标用）
  audience?: string;
  tags?: string[];
  units?: number;
  lectures?: number;
  totalMin?: number;
}
