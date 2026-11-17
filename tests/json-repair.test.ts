import { test } from "node:test";
import assert from "node:assert/strict";
import { repairCjkQuotes } from "../lib/agent/llm";

test("中文句子里夹的英文双引号被换成「」，JSON 能解析", () => {
  const cases = [
    String.raw`{"title":"谁是"一"谁是"多"","x":"好"}`,
    String.raw`{"say":"这一列叫"主键"。","b":"x"}`,
  ];
  for (const bad of cases) {
    assert.throws(() => JSON.parse(bad));
    const fixed = repairCjkQuotes(bad);
    assert.doesNotThrow(() => JSON.parse(fixed), fixed);
  }
  const parsed = JSON.parse(repairCjkQuotes(cases[0]));
  assert.equal(parsed.title, "谁是「一」谁是「多」");
});

test("结构畸形（数组没闭合就收大括号）也能修回来", async () => {
  const { jsonrepair } = await import("jsonrepair");
  const bad = String.raw`{"segment":{"beats":[{"say":"a"},{"say":"b"}}}`;
  assert.throws(() => JSON.parse(bad));
  const fixed = JSON.parse(jsonrepair(bad));
  assert.equal(fixed.segment.beats.length, 2);
});

test("正常 JSON 不被改动", () => {
  const ok = String.raw`{"a":"正常","b":["也正常","好"],"c":{"d":"中文"}}`;
  assert.equal(repairCjkQuotes(ok), ok);
});
