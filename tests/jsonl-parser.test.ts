import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonLinesParser } from "../lib/agent/llm";

async function run(chunks: string[]) {
  const got: Record<string, unknown>[] = [];
  const p = createJsonLinesParser((o) => {
    got.push(o);
  });
  for (const c of chunks) await p.push(c);
  await p.end();
  return { got, bad: p.stats.badLines };
}

test("一行一个对象：逐行交出，跨块切断的行也能拼回来", async () => {
  const { got, bad } = await run(['{"say":"一"}\n{"sa', 'y":"二","board":"卡\\n二"}\n', '{"check":{"question":"q"}}']);
  assert.deepEqual(got.map((o) => o.say ?? "check"), ["一", "二", "check"]);
  assert.equal(got[1].board, "卡\n二");
  assert.equal(bad, 0);
});

test("模型把对象美化成多行：括号配平后整块交出", async () => {
  const pretty = '{\n  "plan": {\n    "title": "T",\n    "segments": [{"title": "a"}, {"title": "b"}]\n  },\n  "beats": [{"say": "x"}]\n}\n{"say":"y"}\n';
  const { got, bad } = await run([pretty]);
  assert.equal(got.length, 2);
  assert.equal((got[0].plan as { title: string }).title, "T");
  assert.equal(got[1].say, "y");
  assert.equal(bad, 0);
});

test("字符串里的花括号不干扰配平；围栏行被忽略", async () => {
  const { got } = await run(['```json\n', '{"board":"代码 { x } 和 [1]"}\n', "```\n"]);
  assert.equal(got.length, 1);
  assert.equal(got[0].board, "代码 { x } 和 [1]");
});

test("中文里夹英文引号的坏行被修好；流在半截结束也尽力修", async () => {
  const { got } = await run(['{"say":"这叫"主键"。"}\n', '{"say":"写到一半']);
  assert.equal(got[0].say, "这叫「主键」。");
  assert.equal(got.length, 2);
});
