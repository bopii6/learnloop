// LLM 结构化输出的最低合格线（zod）。
// 只校验"下游离了它就没法用"的骨架字段，其余字段 passthrough 交给各自的归一化逻辑——
// 校验过严会把本来可用的输出拒掉，反而增加失败率。不合格时 generateJson 会把错误喂回模型重试一次。
import { z } from "zod";

const text = (min = 1) => z.string().trim().min(min);

/** 澄清题：一问 + 至少 2 个选项（选项可以是字符串或带 label 的对象） */
export const clarifyQuestionSchema = z
  .object({
    question: text(4),
    options: z
      .array(z.union([text(), z.object({ label: text() }).passthrough()]))
      .min(2, "至少 2 个选项"),
  })
  .passthrough();

/** 课程蓝图：至少 3 个单元，每单元至少 1 个课节 */
export const blueprintSchema = z
  .object({
    title: text(2),
    units: z
      .array(
        z
          .object({
            title: text(2),
            lectures: z.array(z.object({ title: text(2) }).passthrough()).min(1, "每个单元至少 1 个课节"),
          })
          .passthrough()
      )
      .min(3, "至少 3 个单元"),
  })
  .passthrough();

/** 蓝图自审 */
export const reviewVerdictSchema = z
  .object({ pass: z.boolean(), issues: z.array(z.string()).optional() })
  .passthrough();

/** 单元课节细节 */
export const lectureDetailsSchema = z
  .object({
    lectures: z.array(z.object({ id: text(), summary: text(4) }).passthrough()).min(1),
  })
  .passthrough();

/** 课节片段规划 */
export const lecturePlanSchema = z
  .object({ segments: z.array(z.object({ title: text(2) }).passthrough()).min(2, "至少 2 个片段") })
  .passthrough();

/** v1 讲稿：至少 3 拍，每拍有口播 */
export const beatScriptSchema = z
  .object({ beats: z.array(z.object({ say: text(2) }).passthrough()).min(3, "至少 3 拍") })
  .passthrough();

/** v2 板书脚本：至少 1 张卡，每张有卡面与口播 */
export const boardScriptSchema = z
  .object({
    cards: z.array(z.object({ content: text(2), speak: text(2) }).passthrough()).min(1, "至少 1 张卡"),
  })
  .passthrough();

const choiceQuestion = z
  .object({ question: text(4), options: z.array(text()).min(2, "至少 2 个选项") })
  .passthrough();

/** 课堂即时练习（单题） */
export const checkpointSchema = choiceQuestion;

/** 课后 / 单元测验：至少 3 题，每题带答案下标 */
export const quizSchema = z
  .object({
    quiz: z
      .array(choiceQuestion.extend({ answerIndexes: z.array(z.number().int().min(0)).min(1, "缺答案") }))
      .min(3, "至少 3 题"),
  })
  .passthrough();

/** 结课任务书：至少 3 步 */
export const capstoneBriefSchema = z
  .object({ steps: z.array(z.object({ title: text(2) }).passthrough()).min(3, "至少 3 步") })
  .passthrough();

/** 作品验收：逐条判定 */
export const capstoneReviewSchema = z
  .object({
    criteria: z.array(z.object({ met: z.boolean() }).passthrough()).min(1, "必须逐条判定"),
  })
  .passthrough();
