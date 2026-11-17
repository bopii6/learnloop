// 分步学习课（样板）：学员自己掌握节奏的"讲一点 → 看例子 → 动手 → 反馈"循环。
// 与白板课（types/board.ts）并存，验证"学得进去"后再决定是否替换。

/** 学科形态：决定练习用什么形式、怎么判对错 */
export type LessonSubject = "programming" | "math" | "exam" | "concept";

export interface LessonPractice {
  /** code = 浏览器里写 Python 并运行；choice = 单选；fill = 填空；explain = 用自己的话说（讲师评） */
  kind: "code" | "choice" | "fill" | "explain";
  /** 题面（Markdown） */
  prompt: string;
  // ---- code ----
  /** 隐藏的准备代码（造数据），在学员代码之前运行 */
  setup?: string;
  /** 编辑器里的初始代码（留空让学员补） */
  starter?: string;
  /** 参考答案：判题时运行它，把输出与学员的输出比对 */
  solution?: string;
  // ---- choice ----
  options?: string[];
  answerIndex?: number;
  // ---- fill ----
  /** 可接受答案，多个用 | 分隔 */
  answer?: string;
  // ---- explain ----
  /** 讲师评判要点 */
  rubric?: string[];
  /** 卡住时的提示（不直接给答案） */
  hint?: string;
  /** 作答后展示：为什么是这样 */
  explanation: string;
}

export interface LessonStep {
  title: string;
  /** 讲解正文（Markdown，可含代码块 / 公式） */
  explain: string;
  /** 完整走一遍的例子（Markdown；编程类含代码与输出） */
  example?: string;
  practice?: LessonPractice;
}

export interface StepLesson {
  version: 1;
  subject: LessonSubject;
  title: string;
  /** 学完能做到什么（一句话） */
  goal: string;
  /** 开场：为什么要学这个（具体场景） */
  hook: string;
  steps: LessonStep[];
  recap: {
    points: string[];
    /** 隔几天再回来做的复习题（问 + 答） */
    review: { q: string; a: string }[];
  };
  generatedAt: number;
}
