// 白板教学：AI 讲师产出 beat 脚本（逐句讲解 + 绑定板书动作），播放同步交给前端播放器
import type { TeachBeat, BoardItem, CourseOutline, WhiteboardEvent, SegmentCheckpoint, LectureQuizItem } from "@/types";
import { generateJson, streamAnswer } from "./llm";
import { constraintsBlock, langMatchesExpectation } from "./lang";
import { beatScriptSchema, checkpointSchema, lecturePlanSchema, quizSchema } from "./schemas";

type Emit = (e: WhiteboardEvent) => Promise<void> | void;

/** 口头禅黑名单：扫描每段讲稿，注入下一段"这些说法用过了"，逼讲师换表达 */
const TIC_MARKS = ["换句话说", "说白了", "大部分人以为", "就这句"];

/** 白板教学的一个片段上下文 */
export interface LectureContext {
  courseTitle: string;
  unitTitle: string;
  lectureTitle: string;
  lectureSummary: string;
  depthTags: string[];
  audience: string;
  profileHint?: string; // 学习者画像摘要（跨课程持久化，可选注入）
  studentName?: string; // 学员称呼：开场点名用
  keyConcepts?: string[]; // 本单元关键概念：编剧的提纲依据
  referenceMaterial?: string; // 建课时搜到的资料正文摘编：讲解的事实来源（grounding）
  outputLanguage?: string; // 建课时用户要求的输出语言：讲解/板书/题目全部使用
  constraints?: string[]; // 用户的其他硬性要求（原话关键词），讲课与出题都要遵守
  capstoneGoal?: string; // 学员的结课作品（澄清轮选的 + 蓝图定的）：例子尽量落在这个作品场景里，"冲着我讲"
  previousLectures?: { title: string; summary: string }[]; // 同单元里学员已听完的前几讲：连续剧前情，开场接住、不重讲
  unitProgress?: { index: number; total: number }; // 本讲在单元内的位置（第 index/total 讲）
}

const TEACH_STYLE = `讲解风格要求：
- 零基础假设（最高优先级，压过课程定位与受众描述）：默认学员是从没接触过这个领域的小白，所有概念都是第一次听。不许假设任何前置知识——讲到任何机制前，先用一两句交代"它是什么、解决什么问题"；用到的前置概念当场补齐。课程受众（audience）与学员画像只用来选例子、调节奏，不用来提高讲解起点——宁可显得基础，不许跳步。
- 说人话：你是在给一个活人上课，不是念论文。任何一句话，只要学员需要停下来想一下才能懂，就是你写多了——拆成两句。判断标准只有一个：学员听一遍就懂，因为课堂不能回看。
- 执教的决心：你是那种"这个学生听不懂就是我的失职"的老师。重点处放慢加重，学员容易踩坑的地方你会着急，讲透一个机制你会替学员高兴。轻飘飘的、事不关己的旁白感是最大的失败。
- 目标先行，钩子开场：每段开头一句让学员知道这段解决什么问题；鼓励用一个具体场景/事故/反例开场（一句话说清情境，最好带数字），学员想知道答案才听得进去——但钩子必须在本段或本课兑现，兑现不了的空悬念是骗局。
- 板书课的推进骨架：现象（为什么需要它）→ 机制（怎么运作）→ 大白话复述（用学员的场景再说一遍）→ 例子（套进真实场景走一遍）→ 小结（就一句，记住……）。一次讲透一个机制，例子跟着机制走，不讲故事会。
- 对话感：像老师站在白板前对一个人说话，会用"你"；讲到板书时明确指引（"你看这张对比表"、"注意左边这两个词"）。
- 术语三件套：术语第一次出现时，必须当场给出"一句大白话解释 + 一个具体例子"，不许只丢一个定义就走。人名、模型名、缩写（如 ANN、XOR、Minsky）也要一句话说清它是什么，学员不会因为它是专有名词就自动知道。
- 机制层面具体：讲清"它是怎么运作的"，给真实的数据流、公式、例子，不要生活化比喻堆砌。
- 例子真实可信：优先用参考资料里的案例；自拟例子要贴近学员的真实使用场景，有具体条件和后果，但不编造统计数据。
- 收尾落在实处：小结本段最核心的一句，并自然衔接下一节讲什么（"下一节我们来看XX"），不卖关子、不吓唬人。
- 禁止低幼化类比，禁止堆术语不解释，禁止客套话，禁止表演腔（渲染情绪的语气词、"翻车""炸裂"式的夸张）。`;

const BEAT_SCRIPT_SYSTEM = `你是白板课程讲师兼板书设计师。为一个教学片段生成「逐句讲解 + 板书动作」脚本，只输出 JSON：
{"beats":[{"say":"...","section":"...","items":[...]}]}

字数与节奏（一节课 5-6 个片段，每片段是一小节，整节课 7-10 分钟讲完——超时是事故）：
- 本片段所有 say 加起来总共 260-330 字。信息不缩水，但必须切成小口喂——内容量不变，只是句子更短、拍子更多。
- 8-12 个 beat；每个 beat 的 say 只讲一件事，18-38 字（硬上限 45 字）。say 里出现第二个句号 = 你写多了，拆成两个 beat。
- 口语化、停顿多、有对话感。短句不是啰嗦，是让学员跟得上；一个 100 字的长句学员听到第 60 字就丢了前半句。

理解预算（优先级高于信息密度——学员只能听一遍，不能回看）：
- 一拍一件事：一拍之内不出现两个新术语、两层意思。学员在新概念上没跟住，后面全塌。
- 核心机制讲两遍（只在它所属的这一个片段内）：核心机制先用机制语言讲清（1-2 拍），紧接着用学员自己的场景复述一遍（1-2 拍）。第二遍必须换说法、换视角，让学员产生"啊，原来是这样"；复述拍不写新板书（用 circle 圈住刚写的那条即可）。
- 【最高纪律：不复述】剧情至今里出现过的机制、术语、例子一律算已讲过——直接引用，禁止再解释、禁止再讲一遍。学员刚听完又听一遍，比听不懂更赶人。本片段只讲"本片段目标"里的新东西。
- 口头禅额度："换句话说 / 说白了 / 大部分人以为 / 就这句，记住"每个片段合计最多出现 1 种；导演给了"前面已用过的说法"就换新的。
- 术语首现三件套：术语第一次出现时（仅限剧情至今里没出现过的），必须当场给出"一句大白话解释 + 一个具体例子"，缺一个都不合格。人名/缩写/模型名同样要一句话说清它是什么。
- "记住这句"要短：核心一句控制在 20 字以内，学员能原样复述出来。
- 第一个 beat 抛钩子：用具体问题/场景/事故开场（一句话说清情境，最好带数字），让学员想知道答案；有"本集问题"时照它开场。钩子必须很快开始兑现，不放空炮。
- 最后一个 beat 收束本片段，并用一句具体的"扣子"交棒：用"但是/所以"引出下一段要解决的问题（如"但崩溃如果发生在两行命令中间呢？"），不许"下一节我们来看XX"的公文腔。
- 揭晓段（导演标注"本段是揭晓"时）：这是全课的峰。开头先兑现学员刚做的预测题（直接给答案，该翻案就翻案），让学员看到事故/反例走错的那条路，再给正确机制，最后"就这句，记住：……"。揭晓要干脆，不给模棱两可。
- 称呼：同一讲内的前一个片段叫「上一段」，上一讲才叫「上一讲」；不许把同讲内的片段说成"上节课"。
- 例子走一遍：讲到例子时给出具体条件、数字和后果，让学员能跟着推演一遍；必须是机制推演出的合理场景，不是编造的统计数字。

重点的重量（每个片段必须有，这是和"念PPT"的本质区别）：
- 每个片段有且只有一个"核心一句"——学员忘了别的、只要记住这句就值了。写到它时放慢加重：先给错误理解（"大部分人以为……"）再给正确机制，最后明确说"就这句，记住：……"。
- 信息用因果链串（因为A所以B，但B有个致命例外——所以才需要C），禁止 1234 式并列罗列。罗列 = 轻飘飘 = 失败。
- 写完自检：假如删掉这个 beat，学员会损失什么？答不出具体损失，这个 beat 就是废话，重写。
- 【最硬的规则】白板不能长时间没动静：连续 2 拍以上没有任何板书动作 = 事故。每个 beat 要么写新条目（1-2 条），要么用 circle/underline/mark 指向已有条目。
- 至少 1 个 beat 的 say 里明确指引板书（如"你看这张对比表"、"注意左边这行字"）。

内容纪律（有参考资料时）：
- 讲解里的事实、数字、公式、术语定义、案例必须优先取自给你的参考资料，禁止编造具体数据或引文。
- 参考资料若带【教材…第 N 页】标注，讲到对应内容时自然提一句页码（如"翻开教材第 42 页"），让学员能回到课本对照。
- 参考资料只是素材：要重组、对比、简化成教学语言，不要整段照抄。
- 没给参考资料时按你的知识讲，但不发明具体统计数字。

费曼纪律（反"正确的废话"，每句都要过这道检查）：
- 每句话都要让学员获得"不讲这句他就不会"的东西：一个具体机制、一个数字、一个案例细节、一个可操作的判断标准。
- 禁止同主题通识介绍都能说出口的话："X 越来越重要""X 正在改变世界""学好 X 很有必要""随着技术的发展""在当今社会"——这类句子一句都不许出现。
- 开场片段要回答三问：这个技术是为了解决什么问题而出现的？原来卡在哪？它是怎么解决的？
- 学员听完要能复述出至少一句具体的话，而不是"感觉挺有道理"。

${TEACH_STYLE}

板书规则（白板是提纲不是讲义——写在板上的字越少，学员看得越清）：
- 整段累计 6-9 条 items（硬上限 9 条）。不是每拍都写：每 2-3 拍写 1-2 条；复述拍只圈不写。
- 条目写的是"学员要记住的结论"，不是你说的每句话的摘要。宁可少写一条，也不许把白板填成讲义（满板 90 条字 = 学员一条都记不住）。
- 精炼但有信息量：bullet ≤ 18 个字（一个完整短语，带关键数字/术语，不要残缺词组）、note ≤ 12 个字、subtitle ≤ 10 个字、表格单元格 ≤ 8 个字、diagram/tree 节点 ≤ 6 个字、vs 两侧各 ≤ 8 字、quote ≤ 16 个字。
- 不输出 cast 类型板书（小人出演已下架）。
- 整段最多 1 个表格（2-3 列 × 2-4 行）；纯文字类（bullet/note）在整段 items 里占比不得超过一半。
- section 是模块内的小节标题（≤ 6 字）：片段标题已经是板书大标题，section 通常省略；只有片段内部明显换了一个小主题时才写一次新 section。
- 【禁重复】section 与片段标题（板书大标题/锚点词）不得同文或同义；相邻 beat 的 section 若意思相近，沿用同一个词，不许换着措辞连写两条近义标题；items 条目严禁复述 section 或片段标题的原文（标题已经写过，条目要写新信息）。
- 【形式丰富是硬规则】真老师的板书是"图文并茂的手绘"：箭头流程、对比表、趋势线、对勾打叉、圈划重点、大括号归纳……绝不允许一整段全是文字条目。每个片段至少用 3 种不同类型。
- 类型（像老师的手绘，按内容选形式）：
  - {"kind":"subtitle","text":"..."} — 小标题（比大标题低一级的板块题）
  - {"kind":"bullet","text":"..."} — 要点卡（完整短语，不是句子）
  - {"kind":"note","text":"..."} — 补充注释（数据出处、限定条件）
  - {"kind":"table","headers":["列1","列2"],"rows":[["a","b"]]} — 对比表格：讲两个事物多维度对比时用
  - {"kind":"diagram","nodes":["输入","处理","输出"]} — 流程图：2-4 个节点横向排列（节点 ≤6 字），讲流程/数据流/架构/调用链用它
  - {"kind":"tree","nodes":["父概念","子概念1","子概念2","子概念3"]} — 分支树：父概念在上、2-3 个子概念在下，讲分类/组成/派生用它
  - {"kind":"chart","values":[3,7,4,9]} — 手绘趋势折线（2-5 个纵值，白板会自动标注数值），讲增长/下降/波动/性能对比用它
  - {"kind":"vs","text":"传统做法|装饰器做法"} — 左右对比栏（用 | 分隔两个标签，各 ≤8 字），讲新旧/优劣对立时用
  - {"kind":"judge","verdict":"good","text":"..."} — 判断行：verdict="good" 绿勾（推荐做法）、"bad" 红叉（常见错误），讲误区/最佳实践时用
  - {"kind":"mark","style":"star"} — 在上一条内容旁画星标（"alert"=感叹号、"question"=问号），强调警示/存疑时用
  - {"kind":"quote","text":"..."} — 金句：手绘椭圆圈住一句话（≤16 字，提炼本段最核心的洞察），每个片段最多 1 次，放收尾 beat
  - {"kind":"circle"} — 把白板上一条内容圈起来强调（无参数），配合 say 里的"注意看/圈重点"
  - {"kind":"underline"} — 在上一条内容下划一条重点线（无参数），配合 say 里的"划重点/记住这句"
  - {"kind":"burst"} — 在上一条内容上方画放射强调线（无参数），配合 say 里的"最关键的一点来了"`;

/** 输出语言硬约束行：建课时用户指定了语言，讲解/板书/题目全部照办（拼在相关 system 提示词后） */
function langLineFor(ctx: LectureContext): string {
  if (!ctx.outputLanguage) return "";
  return `\n\n【输出语言（硬约束）】你的全部输出——讲解（say）、板书文字、练习题、选项、点评——必须使用「${ctx.outputLanguage}」。专有名词/术语可保留英文原词。`;
}

/** 用户其他硬性要求块（空则返回空串） */
function teachConstraintsBlock(ctx: LectureContext): string {
  return constraintsBlock(undefined, ctx.constraints);
}

/** 课后练习：整节课讲完后 3-5 道单选/多选，替代独立的测验模块 */
const LECTURE_QUIZ_SYSTEM = `你是白板课程讲师。一节课刚讲完，出一份课后练习检验学员是否真的听懂了，只输出 JSON：
{"quiz":[{"question":"...","multi":false,"options":["A","B","C"],"answerIndexes":[0],"explain":"..."}]}

规则：
- 3-5 道题，覆盖本节课的不同片段（机制、例子、误区各至少 1 题），不要都考同一个点。
- 大部分是单选（multi=false），最多 1 道多选（multi=true）。禁止判断题腔（"下列哪项正确"），题目要场景化、逼学员用刚学的判断。
- options 3-4 个，每个 ≤ 20 字；干扰项要像真实误区（学员真会选的那种），不要 obviously wrong 的凑数项。
- answerIndexes 是正确选项的下标数组（单选 1 个，多选可多个）。
- explain ≤ 60 字：为什么对、错在哪，一句话讲透。`;

/** 课堂练习出题：2-3 个具体可选的选项，逼学员调用刚讲的判断 */
const CHECKPOINT_SYSTEM = `你是白板课程讲师。根据刚讲完的教学片段出一道课堂练习题，检验学员的真实直觉，只输出 JSON：
{"question":"...","options":["选项A","选项B"]}

规则：
- question 场景化（"如果你让 LLM 帮你管日程，哪个环节最容易出幻觉？"），不要"下列哪项正确"这种考试腔。
- options 恰好 2-3 个，每个 ≤ 16 字，是具体做法/具体事物，其中一个明显更有讨论价值。
- 不输出正确答案，学员答完由讲师点评。`;

/** 预测式弹题（揭晓前）：学员还没听下一片段，先让他赌一把直觉——猜完下一片段开场翻案，
 *  这是"看比赛"变"打球"的核心机关，也是全课唯一"冲着学员、等他回应"的高频时刻。 */
const PREDICTIVE_CHECKPOINT_SYSTEM = `你是白板课程讲师。学员刚听完一个片段，**还没听**下一片段。请出一道预测题，让学员在揭晓前先赌一把直觉，只输出 JSON：
{"question":"...","options":["选项A","选项B"]}

规则：
- 考直觉和判断，不考记忆：这方案行不行？接下来会出什么事？这里该填什么？谁先谁后？
- options 恰好 2-3 个，是**具体的预测**（具体做法/具体后果），其中一个是学员最可能掉的直觉误区——猜它的人最多，翻案才最爽。
- question ≤ 40 字，场景化，不要"下列哪项正确"考试腔。
- 不输出正确答案：讲师在下一片段开头揭晓，先猜后讲学员才听得进去。`;

/** 课程导演：拆片段 = 编短剧。本集一问、按内容定段数、揭晓前放预测题、每段只讲新东西。 */
const DIRECTOR_PLAN_SYSTEM = `你是课程导演兼编剧。把一节课编排成一部"学员一听就想知道答案"的短剧，只输出 JSON：
{"opening_question":"...","points":["..."],"segments":[{"id":"intro","title":"...","focus":"...","anchor":"...","checkpoint":"...","reveal":true}]}

【本集问题 opening_question】开场就抛给学员的一个具体问题——他此刻答不出来、下课时能答出来。必须具体到场景/代码/数字（如"两条命令之间崩了一台机器，这把锁会怎样？"），禁止"为什么XX很重要"式空问。

【片段数量按内容定】拆 3 到 6 个片段。内容只有三段的量就出三段；硬性禁止把同一批东西拆成两段各讲一遍（同一行命令的原理和参数拆解是同一段的事）。每段只解决一个新问题，title ≤12 字，focus ≤40 字且写清"学员在本段得到的新东西"。

【剧本骨架（按内容选一种，段序跟着走）】
- 事故型：朴素做法 → 出事故 → 揭晓原因 → 修复 → 实战与边界
- 对比型：方案A → 方案B → 关键差异 → 怎么选
- 操作型：目标 → 步骤1 → 步骤2 → 跑通验证 → 常见坑
- 原理型：直觉问题 → 直觉图像 → 正式机制 → 用图像回看 → 边界

【揭晓峰 + 预测题】本集问题的答案要在一个明确的片段里揭晓（先让学员看到事故/反例，再给真相），该片段加 "reveal":true。揭晓段的前一个片段必须带 checkpoint——一道预测题（≤30 字，如"这版代码敢不敢直接上线？"），让学员先猜，下一片段开场翻案。一节课 1-2 个 checkpoint，就放在这里。带 checkpoint 的片段结尾不许剧透下一片段的答案；本集问题的直接答案只在 reveal 段出现。focus 彼此不许重叠——两个片段若讲的是同一件事，合并成一个。

【每段只讲新东西】整节课内容切干净：一个知识点只在一个片段出现。后面片段用到前面的概念直接用、不解释（讲师拿得到剧情至今）。不许任何片段复述前面片段的内容。

【连续剧】这不是孤立一节课：学员按顺序听到本单元的这一讲。第一段用 1-2 句接住前情（不重讲），最后一段的 focus 里写清"现在你可以做什么"，并给下一讲留一个具体的扣子。

【其他】
- points：整节课 3-4 个大步骤名（如["提出问题","核心机制","实战演练","小结检验"]），供步骤轨显示进度。
- anchor：每段一个 2-4 字锚点词（本段最核心的术语），大字写在白板正中。
- 片段总字数预算约 300-400 字/个，整节课 7-10 分钟——总时长是硬约束，宁少勿多。
- 默认学员零基础：用到的前置概念要么前情已讲过、要么在本片段 focus 里注明先补一句。
- 吃透参考资料：资料里反复出现的概念/对比/案例各占一个片段，事故和例子优先从资料里取；不许空泛的"通用模板"片段。
- 格式：{"opening_question":"...","points":["..."],"segments":[{"id":"intro","title":"...","focus":"...","anchor":"..."},{"id":"mechanism","title":"...","focus":"...","anchor":"...","checkpoint":"..."},{"id":"reveal","title":"...","focus":"...","anchor":"...","reveal":true}]}`;

/** 讲稿审稿人：两把尺子同时量——「有没有干货」是下限，「听一遍能不能懂」是上限。
 *  只打回真正空的那版 / 真正听不明白的那版，拿不准都算过。 */
const REVIEW_SYSTEM = `你是教学审稿人，用两把尺子审一段白板课讲稿，只输出 JSON：
{"specific":true|false,"understandable":true|false,"increments":["学员获得的具体增量1","增量2"],"feedback":"不合格时给一句整改方向（指明是哪把尺子没过）"}

尺子一「有没有干货」（specific）：学员听完能说出或做出什么他原来不会的东西？
判「不具体」（false）的标准：
- 你列出的增量和任何同主题通识介绍能给的东西区分不开——没有具体机制、具体数字、具体案例细节、具体判断标准；
- 形容词多、实指少；学员听完能点头，但复述不出任何一句具体的话。

尺子二「听一遍能不能懂」（understandable）：假设学员是零基础小白（比课程声称的受众更基础——课程默认按小白讲），而且只能听一遍（课堂不能回看，也不能停下来想）。
判「听不懂」（false）的标准（命中任意一条即 false）：
- 有任何一句超过 45 字，或一句里塞了两层意思；
- 出现术语/缩写/人名/模型名，但当场没有给出大白话解释或具体例子，学员得去查才知道是什么；
- 关键机制只讲了一遍、没有用学员的场景复述一遍；
- 一段之内连续出现两个以上未经铺垫的新概念，学员在这里会掉队。

两把尺子都拿不准就算过（true）：只打回真正空的那版、真正听不明白的那版，不要吹毛求疵。`;

/** 审一个片段的讲稿：干货下限 + 可理解上限；审稿人本身挂了就放行（不阻塞交付） */
async function reviewSegment(
  ctx: LectureContext,
  segmentTitle: string,
  segmentFocus: string,
  beats: TeachBeat[]
): Promise<{ specific: boolean; understandable: boolean; feedback: string }> {
  const pass = { specific: true, understandable: true, feedback: "" };
  try {
    const res = await generateJson<{ specific?: boolean; understandable?: boolean; feedback?: string }>(
      REVIEW_SYSTEM,
      `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
片段：${segmentTitle}（目标：${segmentFocus}）
讲稿（逐句）：
${beats.map((b) => b.say).join("\n").slice(0, 1600)}${
        ctx.referenceMaterial ? "\n（本片段有参考资料，讲稿应优先吃透其中的具体机制/数字/案例）" : "\n（本片段无参考资料，讲稿至少要落到真实案例、具体步骤或可操作的判断上）"
      }`, { task: "judge", maxTokens: 500 }
    );
    if (!res || typeof res.specific !== "boolean") return pass;
    return {
      specific: res.specific,
      understandable: typeof res.understandable === "boolean" ? res.understandable : true,
      feedback: String(res.feedback || "").slice(0, 160),
    };
  } catch {
    return pass;
  }
}

/** 服务端兜底：beat 脚本生成失败时退化为一段纯讲解（无板书动作） */
async function fallbackBeats(ctx: LectureContext, segmentTitle: string, segmentFocus: string): Promise<TeachBeat[]> {
  const text = await streamAnswer(
    `你是一位白板课程讲师，请讲解一个教学片段（250-400 字，信息密度优先，每句都要有干货）。${TEACH_STYLE}${langLineFor(ctx)}
不要标题、不要列表标记、不要客套话。`,
    `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}
本片段标题：${segmentTitle}
本片段目标：${segmentFocus}${ctx.referenceMaterial ? `\n参考资料（事实与数字以此为准）：\n${ctx.referenceMaterial.slice(0, 2500)}` : ""}`,
    () => {}
  );
  return text ? [{ say: text.replace(/\s+/g, " ").trim() }] : [];
}

function clampSay(s: string): string {
  // 目标 18-38 字/拍，这里只是保险丝：模型偶发写出长句时按句末标点截到 75 字以内，
  // 避免一拍 100 字连续朗读（学员听到后半句已经忘了前半句）。
  if (s.length <= 75) return s;
  const cut = s.slice(0, 68);
  const m = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("；"));
  return m > 24 ? cut.slice(0, m + 1) : cut;
}

// 课时兜底天花板（目标 7-10 分钟，绝不超 15）：换成"小口多拍"后，单拍更短但拍数更多，
// 这里防止模型把段落写爆（实测模型普遍超写）。保留首尾拍（开场与收束），中段按序保留到预算用尽。
// 420 字/段 × 6 段 ≈ 10 分钟语音 ≈ 最坏 13 分钟。
const SAY_BUDGET = 420;

// 板书预算：提示词要求每段 6-9 条，但模型实测会写到 12-22 条。满板字 = 一条都记不住，
// 超出时从末尾的纯文字条目开始删（表格/流程图/金句/判断这些结构化板式保留）。
const BOARD_ITEMS_PER_SEGMENT = 9;
function enforceBoardBudget(beats: TeachBeat[], max: number): TeachBeat[] {
  const total = beats.reduce((s, b) => s + (b.items?.length ?? 0), 0);
  if (total <= max) return beats;
  let over = total - max;
  for (let i = beats.length - 1; i >= 0 && over > 0; i--) {
    const items = beats[i].items;
    if (!items || items.length === 0) continue;
    const kept = [...items];
    for (let j = kept.length - 1; j >= 0 && over > 0; j--) {
      const k = kept[j].kind;
      if (k === "bullet" || k === "note") {
        kept.splice(j, 1);
        over--;
      }
    }
    beats[i] = { ...beats[i], items: kept };
  }
  return beats;
}
function enforceSayBudget(beats: TeachBeat[]): TeachBeat[] {
  if (beats.length <= 2) return beats;
  const total = beats.reduce((s, b) => s + b.say.length, 0);
  if (total <= SAY_BUDGET) return beats;
  const head = beats[0];
  const tail = beats[beats.length - 1];
  let remain = SAY_BUDGET - head.say.length - tail.say.length;
  const mid: TeachBeat[] = [];
  for (const b of beats.slice(1, -1)) {
    if (remain - b.say.length >= -40) {
      mid.push(b);
      remain -= b.say.length;
    }
  }
  return [head, ...mid, tail];
}

function normalizeBeats(raw: unknown): TeachBeat[] {
  if (!Array.isArray(raw)) return [];
  const beats: TeachBeat[] = [];
  for (const b of raw.slice(0, 10)) {
    if (!b || typeof b !== "object") continue;
    const beat = b as TeachBeat;
    if (!beat.say || typeof beat.say !== "string") continue;
    // 板书长度硬约束（编剧偶发超长时兜底截断，保住"少字"体验）
    const clamp = (s: string | undefined, n: number) =>
      typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : undefined;
    const items: BoardItem[] = Array.isArray(beat.items)
      ? beat.items
          .filter((it) => it && typeof it === "object" && it.kind)
          .slice(0, 6)
          .map((it) => ({
            ...it,
            text: clamp(it.text, it.kind === "subtitle" ? 14 : it.kind === "note" ? 16 : 22),
            values: Array.isArray(it.values)
              ? it.values.slice(0, 5).map((v) => Math.max(0, Math.min(100, Number(v) || 0)))
              : undefined,
            verdict: it.verdict === "bad" ? "bad" : it.verdict === "good" ? "good" : undefined,
            style: ["star", "alert", "question"].includes(String(it.style)) ? (it.style as BoardItem["style"]) : undefined,
            headers: it.headers?.map((h) => clamp(h, 6) || ""),
            rows: it.rows?.map((row) => row.map((c) => clamp(c, 6) || "")),
          }))
      : [];
    beats.push({
      say: clampSay(beat.say.trim()),
      section: clamp(beat.section, 6),
      items,
    });
  }
  // 短拍是设计要求：复述拍可以不带新条目（只圈已有条目），不再把短拍并进前一句
  // ——并回去正好抵消"小口多拍"的改造。板书总量由预算兜底。
  return enforceSayBudget(enforceBoardBudget(beats, BOARD_ITEMS_PER_SEGMENT));
}

/** 学员结课作品上下文行（注入导演与讲稿提示词；空则返回空串） */
function capstoneLine(ctx: LectureContext): string {
  if (!ctx.capstoneGoal) return "";
  return `\n学员的结课作品（他的真实目标）：${ctx.capstoneGoal}
讲解要"冲着他的作品讲"：自拟例子优先落在这个作品会遇到的场景上，让学员每听完一节都能直接拿去推进自己的作品；不要举和它无关的虚构案例。`;
}

export async function runStartTeaching(opts: {
  ctx: LectureContext;
  emit: Emit;
}): Promise<void> {
  const { ctx, emit } = opts;

  await emit({
    type: "stage",
    name: "teach",
    label: "AI 讲师",
    status: "start",
    detail: `正在准备「${ctx.lectureTitle}」的讲解`,
  });

  const plan = await generateJson<{
    opening_question?: string;
    segments: { id?: string; title?: string; focus?: string; checkpoint?: string; anchor?: string; reveal?: boolean }[];
    points?: string[];
  }>(
    DIRECTOR_PLAN_SYSTEM,
    `课程：${ctx.courseTitle}\n单元：${ctx.unitTitle}（这是本单元第 ${ctx.unitProgress?.index ?? 1} 讲，共 ${ctx.unitProgress?.total ?? 1} 讲）\n课节：${ctx.lectureTitle}\n摘要：${ctx.lectureSummary}${
      ctx.previousLectures?.length ? `\n前情（学员已按顺序听完）：${ctx.previousLectures.map((l, i) => `${i + 1}.「${l.title}」${l.summary}`).join("；")}` : ""
    }${ctx.keyConcepts?.length ? `\n本单元关键概念：${ctx.keyConcepts.join("、")}` : ""}${
      ctx.capstoneGoal ? `\n学员的结课作品：${ctx.capstoneGoal}（至少一个片段的例子直接为这个作品服务）` : ""
    }${teachConstraintsBlock(ctx)}${ctx.referenceMaterial ? `\n参考资料（片段划分要覆盖其中的关键内容，资料里反复出现的概念、对比、案例必须各占一个片段）：\n${ctx.referenceMaterial.slice(0, 5000)}` : ""}`, { task: "design", maxTokens: 1100, schema: lecturePlanSchema }
  );
  const openingQuestion = plan?.opening_question ? String(plan.opening_question).slice(0, 40) : "";
  const points = (Array.isArray(plan?.points) ? plan!.points : [])
    .map((p) => String(p).slice(0, 10))
    .filter(Boolean)
    .slice(0, 4);
  const segments = (plan?.segments || []).filter((s) => s && s.title && s.focus).slice(0, 6);
  const fallbackFocus = [
    "为什么这个主题值得学习，以及它解决什么问题", "本节课的核心机制是怎么运作的", "把机制拆成步骤，讲清每一步发生什么", "一个最小可运行的例子", "常见误区与错误做法", "回顾本节课的主线并自测",
  ];
  const lessonSegments = segments.length >= 3 ? segments : fallbackFocus.map((focus, i) => ({
    id: `segment-${i + 1}`,
    title: ["课程开场", "核心机制", "分步拆解", "最小例子", "常见误区", "本节小结"][i],
    focus,
    checkpoint: [2, 4].includes(i) ? "用一句话复述刚才这个小片段的关键点。" : undefined,
    anchor: undefined as string | undefined,
  }));

  // 剧情至今：已讲片段的标题+核心一句。生成下一段时注入，配合"只讲新东西"纪律消重复——
  // 0914 改造最大的杠杆：此前每段独立生成、互相看不见，同一批参数被逐句讲了 3-5 遍。
  const storySoFar: { title: string; core: string }[] = [];
  const usedTics: string[] = [];
  let pendingCheckpoint = ""; // 上一片段的预测题文本：本段开场要兑现（先猜后讲）

  const profileLine = ctx.profileHint ? `\n学员画像（讲解时贴合其水平与目标）：${ctx.profileHint}` : "";

  for (let i = 0; i < lessonSegments.length; i++) {
    const segment = lessonSegments[i];
    const segmentId = String(segment.id || `segment-${i + 1}`);
    await emit({ type: "stage", name: "teach", label: String(segment.title), status: "start", detail: `${i + 1}/${lessonSegments.length}` });

    // 开场片段：讲师称呼学员名字（有名字才注入这条指令）
    const greetingLine =
      i === 0 && ctx.studentName
        ? `\n本片段是全场开场：第一句 say 必须「${ctx.studentName}，你好！」式的点名问好开场，接着抛本集问题。`
        : "";
    // 本集问题：开场 30 秒勾住学员的那个具体问题（导演出的，全课兑现）
    const hookLine =
      i === 0 && openingQuestion ? `\n本集问题（第一拍就抛给学员，本课内必须兑现）：${openingQuestion}` : "";
    // 连续剧前情：接住上一讲，不重讲
    const prevLectureLine =
      i === 0 && ctx.previousLectures?.length
        ? `\n前情提要：学员按顺序刚听完——${ctx.previousLectures.map((l) => `「${l.title}」`).join("、")}。开场最多用一两句接住前情（点出他已经会什么），马上进本集问题；禁止重讲前情里的机制和事故。`
        : "";
    // 揭晓段：全课的峰——先兑现预测题，再反例，再真相
    const revealLine = (segment as { reveal?: boolean }).reveal
      ? `\n本段是全课的揭晓段（峰）：先兑现预测题，再让学员看到事故/反例走错的那条路，然后给正确机制，最后"就这句，记住：……"。`
      : "";
    // 兑现上一段结尾的预测题：学员猜完了，等着看答案
    const settleLine = pendingCheckpoint
      ? `\n上一片段结尾学员刚做完一道预测题：「${pendingCheckpoint}」。本段前 1-2 拍先兑现它：直接揭晓答案——猜对了确认并深化，猜错了翻案讲清为什么。`
      : "";
    // 防泄底保险丝（代码级，不依赖导演自觉）：本段结尾要弹预测题时，本段只把问题和事故摆出来，
    // 解法一个字不许给——否则学员还没赌，答案已经写在黑板上，先猜后讲的机制就废了。
    const spoilerGuardLine =
      segment.checkpoint && i < lessonSegments.length - 1
        ? `\n【防泄底】本段结尾会给学员出一道预测题（关于接下来要讲什么）。所以本段必须停在"问题摆出来了、学员忍不住想猜"的位置：只讲现状、事故、反例和提问，禁止给出解法、禁止出现解法相关的命令写法或参数——解法是下一片段的全部内容。`
        : "";
    // 剧情至今：前面片段讲过的一律算已讲过（消重复的锚）
    const storyLine =
      i > 0 && storySoFar.length > 0
        ? `\n剧情至今（学员刚听完，只能引用，禁止再讲）：\n${storySoFar
            .map((s, j) => `${j + 1}「${s.title}」${s.core}`)
            .join("\n")}\n【上面出现过的机制、术语、例子都算已讲过，直接用，禁止再解释或复述。】`
        : "";
    // 口头禅轮换：同一句话术不许段段用
    const ticLine = usedTics.length ? `\n前面片段已用过的说法：${usedTics.join("、")}——本片段换别的说法。` : "";
    // 收尾片段：以终为始——先落学员的可用能力，再给下一讲留具体的扣子
    const closingLine =
      i === lessonSegments.length - 1
        ? `\n本片段是整节课收尾：倒数第 2 拍落到「现在你可以……」——学员听完这节课能做出/说出的具体能力（具体到可直接上手）；最后一拍用一句话给下一讲留个具体的扣子（点出下一讲要解决的新问题，如"但 A 的锁过期后，B 抢到了，A 回来把谁的锁删了？"），禁止"下一节我们来看XX"的公文腔。`
        : "";

    const beatUserMsg = `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）${profileLine}${capstoneLine(ctx)}
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}${ctx.keyConcepts?.length ? `\n本单元关键概念：${ctx.keyConcepts.join("、")}` : ""}
本片段（第 ${i + 1}/${lessonSegments.length} 个）标题：${segment.title}
本片段目标：${segment.focus}${greetingLine}${hookLine}${prevLectureLine}${revealLine}${settleLine}${spoilerGuardLine}${storyLine}${ticLine}${closingLine}${
      ctx.referenceMaterial
        ? `\n参考资料（讲解的事实、数字、案例优先取自这里）：\n${ctx.referenceMaterial.slice(0, 3000)}`
        : ""
    }
请生成本片段的教学脚本。`;

    const script = await generateJson<{ beats: TeachBeat[] }>(
      BEAT_SCRIPT_SYSTEM + langLineFor(ctx),
      beatUserMsg, { task: "script", maxTokens: 2600, schema: beatScriptSchema }
    );

    let beats = normalizeBeats(script?.beats);
    if (beats.length === 0) beats = await fallbackBeats(ctx, String(segment.title), String(segment.focus));
    if (beats.length === 0) continue;

    // 输出语言守卫：讲稿整段跑偏（要求西班牙语却产出中文）时带硬约束重生成一次
    if (langMatchesExpectation(ctx.outputLanguage, beats.map((b) => b.say).join(" ")) === false) {
      const retry = await generateJson<{ beats: TeachBeat[] }>(
        BEAT_SCRIPT_SYSTEM + langLineFor(ctx),
        `${beatUserMsg}\n\n【语言硬约束】上一版讲稿语言不符：所有 say 与板书文字必须使用「${ctx.outputLanguage}」重写。`, { task: "script", maxTokens: 2600, schema: beatScriptSchema }
      );
      const retryBeats = normalizeBeats(retry?.beats);
      if (retryBeats.length > 0) beats = retryBeats;
    }

    // 双闸门审稿：干货下限（不能是"正确的废话"）+ 可理解上限（听一遍要能懂）。
    // 任一不合格就带审稿意见重写一次；重写后不再复审，避免无限循环与成本失控。
    const review = await reviewSegment(ctx, String(segment.title), String(segment.focus), beats);
    if (!review.specific || !review.understandable) {
      const reasons = [
        !review.specific
          ? '上一版被判为"正确的废话"：删掉所有同主题通识介绍也能说的话，每句话必须落到具体机制、具体数字、具体案例细节或可操作的判断上。'
          : "",
        !review.understandable
          ? '上一版被判为"听一遍听不懂"：把每个 beat 压到 18-38 字（超 45 字的一律拆成两拍）、一拍只讲一件事；术语/缩写/人名首次出现必须当场给一句大白话加一个具体例子；核心机制必须紧接着用学员的场景复述一遍。'
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const retry = await generateJson<{ beats: TeachBeat[] }>(
        BEAT_SCRIPT_SYSTEM + langLineFor(ctx),
        `${beatUserMsg}\n\n【审稿意见】${review.feedback}\n重写要求：\n${reasons}${
          ctx.referenceMaterial ? "\n逐句吃透参考资料，把资料里的细节讲出来。" : "\n用真实案例与具体步骤把内容做实，不发明统计数字。"
        }`, { task: "script", maxTokens: 2600, schema: beatScriptSchema }
      );
      const retryBeats = normalizeBeats(retry?.beats);
      if (retryBeats.length > 0) beats = retryBeats;
    }

    // 记入剧情：下一段生成时注入（核心一句优先取"记住"拍，取不到就取末拍）
    const coreBeat = beats.find((b) => b.say.includes("记住") && b.say.length <= 48) || beats[beats.length - 1];
    storySoFar.push({ title: String(segment.title), core: coreBeat.say.slice(0, 42) });
    for (const tic of TIC_MARKS) {
      if (beats.some((b) => b.say.includes(tic)) && !usedTics.includes(tic)) usedTics.push(tic);
    }

    // 片段带练习提示 → 出课堂练习题。有下一段 = 预测题（考学员对还没讲内容的直觉，
    // 下一段开场揭晓）；最后一段 = 复习题（考刚讲过的判断）。
    let checkpoint: SegmentCheckpoint | undefined;
    if (segment.checkpoint) {
      const next = lessonSegments[i + 1];
      const isPredictive = Boolean(next);
      const mcq = await generateJson<SegmentCheckpoint>(
        (isPredictive ? PREDICTIVE_CHECKPOINT_SYSTEM : CHECKPOINT_SYSTEM) + langLineFor(ctx),
        isPredictive
          ? `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle}
学员刚听完：「${segment.title}」——${segment.focus}
下一片段要讲：「${next!.title}」——${next!.focus}

请出一道预测题（学员还没听下一片段，让他先赌一把直觉）。`
          : `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle}
片段标题：${segment.title}
片段讲解内容：\n${beats.map((b) => b.say).join("\n").slice(0, 1500)}\n\n请出一道课堂练习题。`, { task: "script", schema: checkpointSchema }
      );
      if (mcq?.question && Array.isArray(mcq.options) && mcq.options.length >= 2) {
        checkpoint = {
          question: String(mcq.question).slice(0, 60),
          options: mcq.options.slice(0, 3).map((o) => String(o).slice(0, 16)),
        };
      }
    }
    pendingCheckpoint = checkpoint?.question || "";

    await emit({
      type: "beats",
      segmentId,
      index: i,
      total: lessonSegments.length,
      title: String(segment.title),
      anchor: segment.anchor ? String(segment.anchor).slice(0, 6) : undefined,
      beats,
      checkpoint,
      // 课堂步骤轨：片段映射到最近的步骤（points 均摊到片段序列上）
      points: points.length > 0 ? points : undefined,
      pointIndex:
        points.length > 1
          ? Math.min(points.length - 1, Math.round((i * (points.length - 1)) / (lessonSegments.length - 1)))
          : undefined,
    });
    await emit({ type: "stage", name: "teach", label: String(segment.title), status: "end" });
  }

  // 课后练习：整节课讲完，3-5 道单选/多选一次下发（不做独立测验模块，练习就在课尾）
  try {
    await emit({ type: "stage", name: "teach", label: "出课后练习", status: "start", detail: "3-5 道题" });
    const quizRaw = await generateJson<{ quiz: LectureQuizItem[] }>(
      LECTURE_QUIZ_SYSTEM + langLineFor(ctx),
      `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}
本节课的完整讲解内容（出题依据）：
${lessonSegments
  .map((s) => `【${s.title}】${s.focus}`)
  .join("\n")}
${ctx.referenceMaterial ? `\n参考资料（题目事实以此为准）：\n${ctx.referenceMaterial.slice(0, 2500)}` : ""}

请出课后练习。`, { task: "design", maxTokens: 2000, schema: quizSchema }
    );
    const quiz = (quizRaw?.quiz || [])
      .filter((q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length >= 3 && Array.isArray(q.answerIndexes) && q.answerIndexes.length > 0)
      .slice(0, 5)
      .map((q) => ({
        question: String(q.question).slice(0, 80),
        multi: Boolean(q.multi),
        options: q.options.slice(0, 4).map((o) => String(o).slice(0, 20)),
        answerIndexes: q.answerIndexes.filter((n) => typeof n === "number" && n >= 0 && n < q.options.length),
        explain: String(q.explain || "").slice(0, 80),
      }))
      .filter((q) => q.answerIndexes.length > 0);
    if (quiz.length > 0) {
      await emit({ type: "lecture_quiz", quiz });
    }
    await emit({ type: "stage", name: "teach", label: "出课后练习", status: "end", detail: `${quiz.length} 道题` });
  } catch {
    // 课后练习失败不阻塞课程交付
  }

  await emit({ type: "stage", name: "teach", label: "AI 讲师", status: "end", detail: "本节课脚本已生成" });
}

/** 「没跟上」：学员一键求通俗重讲——只把刚讲的那段换成大白话，不引入任何新内容 */
const SIMPLER_SYSTEM = `你是白板课程讲师。学员刚听完一段，举手说"没跟上"。请把这一段的核心内容用更好懂的方式重讲一遍，只输出讲解正文（不要标题、不要列表、不要客套）。

重讲纪律（全部是硬要求）：
- 每句 ≤ 20 字。短句、停顿多，像面对面说话，不像念稿。
- 顺序固定：先一句话给结论 → 再给一个最小例子（学员自己的场景，具体到数字或动作）→ 最后回到机制，解释为什么会这样。
- 只讲刚才那段的同一个点：绝对不引入新概念、不扩展新内容、不提前预告后面的内容。
- 不出现没有当场解释的术语；专业词可以保留，但紧跟一句"也就是……"的人话。
- 100-200 字，比原来那段更短，不是更长。学员是没跟上，不是要更多。
- 结尾用一句确认收住（"这样清楚一点了吗？"），不要客套堆砌。`;

/** 补课卡：把"讲简单点"的重讲提炼成 3-4 条人话结论，钉在白板上供随时回看 */
const ASIDE_CARD_SYSTEM = `你是板书设计师。学员刚举手说"没跟上"，讲师用大白话把这一段重讲了一遍。请为白板生成一张"补课卡"，只输出 JSON：
{"title":"...","items":[{"kind":"bullet","text":"..."}]}

规则：
- title ≤ 6 字（如"大白话版""再说一遍"）。
- 3-4 条，每条 ≤ 14 字，是从重讲里提炼的"人话结论"，脱离课堂也能独立看懂。
- kind 只允许 bullet（结论）/ note（补充）/ quote（最关键那一句）。
- 不许出现没有解释的术语，不要把讲稿整句搬上来当条目。`;

export async function runTeachChat(opts: {
  ctx: LectureContext;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  context?: {
    segmentTitle?: string;
    boardOutline?: string;
    checkpointQuestion?: string; // 学员正在回答课堂练习
    checkpointOptions?: string[];
    simpler?: boolean; // 「没跟上」：原地用大白话重讲刚讲完的那一段
  };
  emit: Emit;
}): Promise<void> {
  const { ctx, history, message, context, emit } = opts;

  await emit({ type: "stage", name: "teach", label: "AI 讲师", status: "start" });

  const histText = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "学员" : "讲师"}：${m.content.slice(0, 400)}`)
    .join("\n\n");

  const progressLine = context?.segmentTitle ? `\n学员刚听完「${context.segmentTitle}」这一段。` : "";
  const boardLine = context?.boardOutline ? `\n白板上已写的内容：${context.boardOutline}。回答时可以引用板书。` : "";
  const profileLine = ctx.profileHint ? `\n学员画像：${ctx.profileHint}` : "";

  // 「没跟上」：不是普通提问，而是"原地降维重讲"——先钉一张补课卡到白板，再流式重讲。
  // 学员按一次按钮就能求救，不用组织语言（听不懂的人往往也说不清哪里不懂）。
  if (context?.simpler) {
    try {
      const card = await generateJson<{ title?: string; items?: BoardItem[] }>(
        ASIDE_CARD_SYSTEM + langLineFor(ctx),
        `课程：《${ctx.courseTitle}》
课节：${ctx.lectureTitle}
刚讲完的片段：${context.segmentTitle || "本片段"}
白板已写的内容：${context.boardOutline || "（无）"}
学员的原话：${message}

请生成补课卡。`, { task: "script", maxTokens: 500 }
      );
      const items = (card?.items || [])
        .filter((it) => it && ["bullet", "note", "quote"].includes(String(it.kind)))
        .slice(0, 4)
        .map((it) => ({ kind: String(it.kind) as BoardItem["kind"], text: String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 16) }))
        .filter((it) => it.text);
      if (items.length > 0) {
        await emit({ type: "board_aside", title: String(card?.title || "大白话版").slice(0, 6), items });
      }
    } catch {
      // 补课卡生成失败不影响重讲本身
    }

    await streamAnswer(
      `${SIMPLER_SYSTEM}
课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
本节课：${ctx.lectureTitle} —— ${ctx.lectureSummary}${progressLine}${boardLine}${profileLine}${capstoneLine(ctx)}${langLineFor(ctx)}${teachConstraintsBlock(ctx) ? `\n${teachConstraintsBlock(ctx)}` : ""}`,
      `学员刚听完「${context.segmentTitle || "刚才这一段"}」，现在说：${message}
请用更简单的话把刚才那一段重讲一遍（同样的内容，更好懂，不添加新内容）。例子可以换成学员结课作品场景里的最小版本。`,
      async (t) => {
        await emit({ type: "token", text: t });
      }
    );
    await emit({ type: "stage", name: "teach", label: "AI 讲师", status: "end" });
    return;
  }

  const checkpointLine =
    context?.checkpointQuestion && context.checkpointOptions
      ? `\n学员正在回答你出的课堂练习：「${context.checkpointQuestion}」选项：${context.checkpointOptions.join(" / ")}。学员选了「${message}」。
先点评这个选择（对不对、为什么，一两句，直接给判断不要和稀泥），再用一句话把结论接回课上的主线。`
      : "";

  await streamAnswer(
    `你是一位白板课程讲师，正在讲一节课，学员可以随时打断提问。
课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
单元：${ctx.unitTitle}
本节课：${ctx.lectureTitle} —— ${ctx.lectureSummary}${progressLine}${boardLine}${profileLine}${capstoneLine(ctx)}${checkpointLine}${langLineFor(ctx)}${teachConstraintsBlock(ctx) ? `\n${teachConstraintsBlock(ctx)}` : ""}

${TEACH_STYLE}

回答学员问题（150-300 字）：
- 直接回答，机制层面讲清楚；
- 如果问题偏离本节课太远，先简短回答再引导回主题；
- 不要"同学们好"之类的客套。`,
    `${histText ? `最近的对话：\n${histText}\n\n` : ""}${
      context?.checkpointQuestion ? `学员对课堂练习的选择：${message}` : `学员提问：${message}`
    }`,
    async (t) => {
      await emit({ type: "token", text: t });
    }
  );

  // 课堂练习答完 → 颁发成就徽章（原版同款的激励闭环）
  if (context?.checkpointQuestion && context.checkpointOptions) {
    const ach = await generateJson<{ title: string; desc: string }>(
      `你是白板课堂的成就系统。学员刚回答了课堂练习并得到讲师点评。为学员颁发一个成就徽章，只输出 JSON：{"title":"...","desc":"..."}
规则：title ≤ 8 字，概念式命名（如"建立行动者意识""跳出概率陷阱"）；desc ≤ 30 字，把刚练的知识点写成一句肯定语。即使答错也发（desc 写"你已经注意到了这个陷阱，进步了"这类），
但如果学员的选择明显错了且没有自救，title 用"勇气可嘉"风格。${langLineFor(ctx)}`,
      `练习：${context.checkpointQuestion}\n学员选择：${message}`, { task: "fast", maxTokens: 250 }
    );
    if (ach?.title) {
      await emit({ type: "achievement", title: String(ach.title).slice(0, 12), desc: String(ach.desc || "").slice(0, 40) });
    }
  }

  await emit({ type: "stage", name: "teach", label: "AI 讲师", status: "end" });
}

/** 从课程大纲中提取课节上下文 */
export function buildLectureContext(
  outline: CourseOutline,
  unitId: string,
  lectureId: string
): LectureContext | null {
  const unit = outline.units.find((u) => u.id === unitId);
  const lectureIndex = unit?.lectures.findIndex((l) => l.id === lectureId) ?? -1;
  const lecture = lectureIndex >= 0 ? unit!.lectures[lectureIndex] : undefined;
  if (!unit || !lecture) return null;
  // 连续剧前情：本单元里排在前面、学员已听完的讲（ title+summary 即可，开场接住、不重讲）
  const previousLectures = unit.lectures
    .slice(0, lectureIndex)
    .filter((l) => l.content_type !== "quiz" && l.content_type !== "project")
    .map((l) => ({ title: l.title, summary: l.summary }));
  return {
    courseTitle: outline.title,
    unitTitle: unit.title,
    lectureTitle: lecture.title,
    lectureSummary: lecture.summary,
    depthTags: lecture.depth_tags,
    audience: outline.audience,
    outputLanguage: outline.outputLanguage,
    constraints: outline.constraints,
    ...(previousLectures.length > 0 ? { previousLectures } : {}),
    unitProgress: { index: lectureIndex + 1, total: unit.lectures.length },
  };
}
