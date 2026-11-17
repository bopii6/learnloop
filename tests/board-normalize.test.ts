import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBoardMarkdown } from "../lib/board/lesson-engine";

test("单换行分开的文字行各自成段", () => {
  const md = "**本节课题**\n主题：主键与外键\n学完能做：补全客户信息";
  assert.equal(normalizeBoardMarkdown(md), "**本节课题**\n\n主题：主键与外键\n\n学完能做：补全客户信息");
});

test("表格补上表头分隔行，并和标题隔开", () => {
  const md = "**订单表**\n| id | amount |\n| 1 | 120 |\n| 2 | 80 |";
  assert.equal(normalizeBoardMarkdown(md), "**订单表**\n\n| id | amount |\n| --- | --- |\n| 1 | 120 |\n| 2 | 80 |");
});

test("已有分隔行的表格不重复补", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |";
  assert.equal(normalizeBoardMarkdown(md), md);
});

test("被压成一行的「标题 / - 甲 / - 乙」拆回多行", () => {
  const md = "一对多定方向 / - orders：多 / - customers：一";
  assert.equal(normalizeBoardMarkdown(md), "一对多定方向\n\n- orders：多\n- customers：一");
});

test("列表保持连续，代码块原样", () => {
  const md = "**口诀**\n- 外键指向主键\n- 从多出发\n```sql\nSELECT *\nFROM t\n```\n左：外键";
  assert.equal(normalizeBoardMarkdown(md), "**口诀**\n\n- 外键指向主键\n- 从多出发\n\n```sql\nSELECT *\nFROM t\n```\n\n左：外键");
});
