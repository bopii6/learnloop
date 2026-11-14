import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../lib/agent/llm";

test("extractJson：纯 JSON / 带 json 围栏 / 前后有废话", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('好的：\n```json\n{"a":[1,2]}\n```\n以上'), { a: [1, 2] });
  assert.deepEqual(extractJson('结果是 {"q":"x"} 谢谢'), { q: "x" });
});

test("extractJson：正文里的代码围栏与花括号不干扰", () => {
  const obj = { content: "```python" + String.fromCharCode(10) + "print({1:2})" + String.fromCharCode(10) + "```", speak: "讲" };
  assert.deepEqual(extractJson(`先说一句 ${JSON.stringify(obj)} 结束`), obj);
});

test("extractJson：不是 JSON 返回 null", () => {
  assert.equal(extractJson("完全没有 JSON"), null);
  assert.equal(extractJson('{"a": '), null);
});
