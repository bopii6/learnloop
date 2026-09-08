// 白板教学：AI 讲师产出 beat 脚本（逐句讲解 + 绑定板书动作），播放同步交给前端播放器
import type { TeachBeat, BoardItem, CourseOutline, WhiteboardEvent, SegmentCheckpoint, LectureQuizItem } from "@/types";
import { generateJson, streamAnswer } from "./llm";

type Emit = (e: WhiteboardEvent) => Promise<void> | void;

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
}

const TEACH_STYLE = `讲解风格要求：
- 抓人：每段用钩子开头（一个反直觉的事实、一个两难问题、或一个真实翻车案例），不要"下面我们来讲XX"式平铺直叙。
- 对话感：像老师站在白板前对一个人说话，会用"你"；讲到板书时明确指引（"你看这张对比表"、"注意左边这两个词"）。
- 机制层面具体：讲清"它是怎么运作的"，给真实的数据流、公式、例子，不要生活化比喻堆砌。
- 术语直接用，但首次出现给一句中文解释或具体例子。适当用数字说话。
- 禁止低幼化类比，禁止堆术语不解释，禁止客套话。`;

const BEAT_SCRIPT_SYSTEM = `你是白板课程讲师兼板书设计师。为一个教学片段生成「逐句讲解 + 板书动作」脚本，只输出 JSON：
{"beats":[{"say":"...","section":"...","items":[...]}]}

字数与节奏（一节课 8-10 个片段，每片段是一小节）：
- 本片段所有 say 加起来总共 420-520 字（这是硬约束）。信息密度优先：每句都要有事实、数字、机制、公式或具体案例，禁止用两句话重复同一个意思。
- 6-8 个 beat；say 每句 55-80 字，口语化、有对话感。
- 第一个 beat 必须是钩子（反直觉事实 / 两难问题 / 真实翻车案例），不要"下面我们来讲"。
- 最后一个 beat 用来收束本片段并引出下一片段。
- 【最硬的规则】每个 beat 都必须带 1-3 条 items——讲师每说一句话，白板就必须同步出现对应内容；讲师说完话白板没动静 = 事故。
- 至少 1 个 beat 的 say 里明确指引板书（如"你看这张对比表"、"注意左边这行字"）。

内容纪律（有参考资料时）：
- 讲解里的事实、数字、公式、术语定义、案例必须优先取自给你的参考资料，禁止编造具体数据或引文。
- 参考资料若带【教材…第 N 页】标注，讲到对应内容时自然提一句页码（如"翻开教材第 42 页"），让学员能回到课本对照。
- 参考资料只是素材：要重组、对比、简化成教学语言，不要整段照抄。
- 没给参考资料时按你的知识讲，但不发明具体统计数字。

讲解风格：
- 抓人：钩子开头，不平铺直叙。
- 对话感：像老师对一个人说话，会用"你"；讲机制要具体（数据流、公式、例子、数字），术语首次出现给一句解释。
- 禁止低幼化类比，禁止堆术语不解释，禁止客套话。

板书规则（items 是随这句话写上白板的内容——白板每句话同步长出一块内容，整段讲完 = 一张信息完整的知识卡片）：
- 每个 beat 的 items 1-3 条，说到什么写什么，写什么说什么；整段累计 8-14 条 items，把这一块的板写满，绝不允许一整段只落下三五行孤零零的字。
- 精炼但有信息量：bullet ≤ 18 个字（一个完整短语，带关键数字/术语，不要残缺词组）、note ≤ 12 个字、subtitle ≤ 10 个字、表格单元格 ≤ 8 个字、diagram/tree 节点 ≤ 6 个字、vs 两侧各 ≤ 8 字、quote ≤ 16 个字。
- 整段最多 1 个表格（2-3 列 × 2-4 行）；纯文字类（bullet/note）在整段 items 里占比不得超过一半。
- section 是模块内的小节标题（≤ 6 字）：片段标题已经是板书大标题，section 通常省略；只有片段内部明显换了一个小主题时才写一次新 section。
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

/** 课后练习：整节课讲完后 3-5 道单选/多选，替代独立的测验模块 */
const LECTURE_QUIZ_SYSTEM = `你是白板课程讲师。一节课刚讲完，出一份课后练习检验学员是否真的听懂了，只输出 JSON：
{"quiz":[{"question":"...","multi":false,"options":["A","B","C"],"answerIndexes":[0],"explain":"..."}]}

规则：
- 3-5 道题，覆盖本节课的不同片段（开场钩子后面的机制、例子、误区各至少 1 题），不要都考同一个点。
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

/** 服务端兜底：beat 脚本生成失败时退化为一段纯讲解（无板书动作） */
async function fallbackBeats(ctx: LectureContext, segmentTitle: string, segmentFocus: string): Promise<TeachBeat[]> {
  const text = await streamAnswer(
    `你是一位白板课程讲师，请讲解一个教学片段（250-400 字，信息密度优先，每句都要有干货）。${TEACH_STYLE}
不要标题、不要列表标记、不要客套话。`,
    `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}
本片段标题：${segmentTitle}
本片段目标：${segmentFocus}${ctx.referenceMaterial ? `\n参考资料（事实与数字以此为准）：\n${ctx.referenceMaterial.slice(0, 2500)}` : ""}`,
    () => {}
  );
  return text ? [{ say: text.replace(/\s+/g, " ").trim() }] : [];
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
          .slice(0, 4)
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
      say: beat.say.trim(),
      section: clamp(beat.section, 6),
      items,
    });
  }
  // 课堂硬规则：讲师说的每一句都要有板书动作——个别 beat 没带 items 时并入前一句
  const merged: TeachBeat[] = [];
  for (const b of beats) {
    const hasItems = (b.items?.length ?? 0) > 0;
    if (!hasItems && merged.length > 0 && b.say.length < 60) {
      merged[merged.length - 1].say += b.say;
    } else {
      merged.push(b);
    }
  }
  return merged;
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
    segments: { id?: string; title?: string; focus?: string; checkpoint?: string }[];
    points?: string[];
  }>(
    `你是课程导演。把一节课拆成 8 到 10 个连续的微型教学片段，并给出整节课的课堂步骤（points），只输出 JSON。
每个片段包含 id、title、focus；每 2-3 个片段安排一个 checkpoint（一个让学员回答的短问题），一节课共 3-4 个 checkpoint，让学员保持被提问的紧张感。
points 是整节课的 3-4 个大步骤名（如["提出问题","核心机制","实战演练","小结检验"]），供右侧步骤轨显示"讲到哪一步了"。
片段总字数预算约 450 字/个，整节课 12-15 分钟讲完；片段顺序覆盖：开场动机 → 术语 → 核心机制 → 分步拆解 → 例子 → 常见误区 → 小结与检验。
拆片段时优先吃透参考资料里的具体内容：资料里反复出现的概念、对比、案例要各占一个片段，不要空泛的"通用模板"片段。
每个片段只解决一个小问题，title 不超过 12 字，focus 不超过 35 字。
格式：{"points":["...","..."],"segments":[{"id":"intro","title":"课程开场","focus":"..."},{"id":"mechanism","title":"核心机制","focus":"...","checkpoint":"..."}]}`,
    `课程：${ctx.courseTitle}\n单元：${ctx.unitTitle}\n课节：${ctx.lectureTitle}\n摘要：${ctx.lectureSummary}${
      ctx.keyConcepts?.length ? `\n本单元关键概念：${ctx.keyConcepts.join("、")}` : ""
    }${ctx.referenceMaterial ? `\n参考资料（片段划分要覆盖其中的关键内容）：\n${ctx.referenceMaterial.slice(0, 5000)}` : ""}`,
    1100
  );
  const points = (Array.isArray(plan?.points) ? plan!.points : [])
    .map((p) => String(p).slice(0, 10))
    .filter(Boolean)
    .slice(0, 4);
  const segments = (plan?.segments || []).filter((s) => s && s.title && s.focus).slice(0, 10);
  const fallbackFocus = [
    "为什么这个主题值得学习，以及它解决什么问题", "本节课的核心术语和边界", "先建立整体流程地图", "拆解第一步发生了什么", "拆解第二步如何接上前一步", "关键数据如何流动", "一个最小可运行的例子", "常见误区与错误做法", "什么时候不该用、如何判断结果可靠", "回顾本节课的主线并自测",
  ];
  const lessonSegments = segments.length >= 6 ? segments : fallbackFocus.map((focus, i) => ({
    id: `segment-${i + 1}`,
    title: ["课程开场", "关键术语", "全局地图", "第一步", "第二步", "数据流", "最小例子", "常见误区", "适用边界", "本节小结"][i],
    focus,
    checkpoint: [3, 6, 8].includes(i) ? "用一句话复述刚才这个小片段的关键点。" : undefined,
  }));

  const profileLine = ctx.profileHint ? `\n学员画像（讲解时贴合其水平与目标）：${ctx.profileHint}` : "";

  for (let i = 0; i < lessonSegments.length; i++) {
    const segment = lessonSegments[i];
    const segmentId = String(segment.id || `segment-${i + 1}`);
    await emit({ type: "stage", name: "teach", label: String(segment.title), status: "start", detail: `${i + 1}/${lessonSegments.length}` });

    // 开场片段：讲师称呼学员名字（有名字才注入这条指令）
    const greetingLine =
      i === 0 && ctx.studentName
        ? `\n本片段是全场开场：第一句 say 必须「${ctx.studentName}，你好！」式的点名问好开场，再接钩子。`
        : "";

    const script = await generateJson<{ beats: TeachBeat[] }>(
      BEAT_SCRIPT_SYSTEM,
      `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）${profileLine}
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}${ctx.keyConcepts?.length ? `\n本单元关键概念：${ctx.keyConcepts.join("、")}` : ""}
本片段（第 ${i + 1}/${lessonSegments.length} 个）标题：${segment.title}
本片段目标：${segment.focus}${greetingLine}${
        ctx.referenceMaterial
          ? `\n参考资料（讲解的事实、数字、案例优先取自这里）：\n${ctx.referenceMaterial.slice(0, 3000)}`
          : ""
      }
请生成本片段的教学脚本。`,
      2600
    );

    let beats = normalizeBeats(script?.beats);
    if (beats.length === 0) beats = await fallbackBeats(ctx, String(segment.title), String(segment.focus));
    if (beats.length === 0) continue;

    // 片段带练习提示 → 出一道场景化选择题（学员答完由讲师点评）
    let checkpoint: SegmentCheckpoint | undefined;
    if (segment.checkpoint) {
      const mcq = await generateJson<SegmentCheckpoint>(
        CHECKPOINT_SYSTEM,
        `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle}
片段标题：${segment.title}
片段讲解内容：\n${beats.map((b) => b.say).join("\n").slice(0, 1500)}\n\n请出一道课堂练习题。`
      );
      if (mcq?.question && Array.isArray(mcq.options) && mcq.options.length >= 2) {
        checkpoint = {
          question: String(mcq.question).slice(0, 60),
          options: mcq.options.slice(0, 3).map((o) => String(o).slice(0, 16)),
        };
      }
    }

    await emit({
      type: "beats",
      segmentId,
      index: i,
      total: lessonSegments.length,
      title: String(segment.title),
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
      LECTURE_QUIZ_SYSTEM,
      `课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
课节：${ctx.lectureTitle} —— ${ctx.lectureSummary}
本节课的完整讲解内容（出题依据）：
${lessonSegments
  .map((s) => `【${s.title}】${s.focus}`)
  .join("\n")}
${ctx.referenceMaterial ? `\n参考资料（题目事实以此为准）：\n${ctx.referenceMaterial.slice(0, 2500)}` : ""}

请出课后练习。`,
      2000
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

export async function runTeachChat(opts: {
  ctx: LectureContext;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  context?: {
    segmentTitle?: string;
    boardOutline?: string;
    checkpointQuestion?: string; // 学员正在回答课堂练习
    checkpointOptions?: string[];
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
  const checkpointLine =
    context?.checkpointQuestion && context.checkpointOptions
      ? `\n学员正在回答你出的课堂练习：「${context.checkpointQuestion}」选项：${context.checkpointOptions.join(" / ")}。学员选了「${message}」。
先点评这个选择（对不对、为什么，一两句，直接给判断不要和稀泥），再用一句话把结论接回课上的主线。`
      : "";

  await streamAnswer(
    `你是一位白板课程讲师，正在讲一节课，学员可以随时打断提问。
课程：《${ctx.courseTitle}》（面向：${ctx.audience}）
单元：${ctx.unitTitle}
本节课：${ctx.lectureTitle} —— ${ctx.lectureSummary}${progressLine}${boardLine}${profileLine}${checkpointLine}

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
但如果学员的选择明显错了且没有自救，title 用"勇气可嘉"风格。`,
      `练习：${context.checkpointQuestion}\n学员选择：${message}`,
      250
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
  const lecture = unit?.lectures.find((l) => l.id === lectureId);
  if (!unit || !lecture) return null;
  return {
    courseTitle: outline.title,
    unitTitle: unit.title,
    lectureTitle: lecture.title,
    lectureSummary: lecture.summary,
    depthTags: lecture.depth_tags,
    audience: outline.audience,
  };
}
