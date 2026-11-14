import { test } from "node:test";
import assert from "node:assert/strict";
import { blueprintSchema, boardScriptSchema, clarifyQuestionSchema, quizSchema, capstoneReviewSchema } from "../lib/agent/schemas";

test("澄清题：至少 2 个选项，字符串或带 label 的对象都行", () => {
  assert.ok(clarifyQuestionSchema.safeParse({ question: "你的基础到哪一档？", options: ["零基础", { label: "会一点" }] }).success);
  assert.ok(!clarifyQuestionSchema.safeParse({ question: "你的基础到哪一档？", options: ["只有一个"] }).success);
  assert.ok(!clarifyQuestionSchema.safeParse({ question: "你的基础到哪一档？" }).success);
});

test("蓝图：至少 3 个单元、每单元至少 1 节，多余字段保留", () => {
  const unit = (t: string) => ({ title: t, lectures: [{ title: `${t} 第一节` }] });
  const ok = blueprintSchema.safeParse({ title: "课程", units: [unit("单元一"), unit("单元二"), unit("单元三")], tags: ["x"] });
  assert.ok(ok.success);
  assert.deepEqual((ok.data as unknown as { tags: string[] }).tags, ["x"]);
  assert.ok(!blueprintSchema.safeParse({ title: "课程", units: [unit("单元一"), unit("单元二")] }).success);
});

test("板书脚本：每张卡要有卡面和口播", () => {
  assert.ok(boardScriptSchema.safeParse({ cards: [{ content: "卡面", speak: "口播" }] }).success);
  assert.ok(!boardScriptSchema.safeParse({ cards: [{ content: "卡面" }] }).success);
  assert.ok(!boardScriptSchema.safeParse({ cards: [] }).success);
});

test("测验：至少 3 题且每题有答案下标", () => {
  const q = { question: "哪个对？", options: ["A", "B"], answerIndexes: [0] };
  assert.ok(quizSchema.safeParse({ quiz: [q, q, q] }).success);
  assert.ok(!quizSchema.safeParse({ quiz: [q, q, { ...q, answerIndexes: [] }] }).success);
});

test("作品验收：逐条带 met 判定", () => {
  assert.ok(capstoneReviewSchema.safeParse({ criteria: [{ text: "x", met: true }] }).success);
  assert.ok(!capstoneReviewSchema.safeParse({ criteria: [{ text: "x" }] }).success);
});
