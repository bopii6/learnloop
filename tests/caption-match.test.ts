import { test } from "node:test";
import assert from "node:assert/strict";
import { captionMatchMask } from "../lib/board/caption-match";

const marked = (caption: string, board: string) => {
  const mask = captionMatchMask(caption, board);
  let out = "";
  let open = false;
  for (let i = 0; i < caption.length; i++) {
    if (mask[i] && !open) (out += "["), (open = true);
    if (!mask[i] && open) (out += "]"), (open = false);
    out += caption[i];
  }
  return open ? out + "]" : out;
};

test("字幕对板书：白板上的词在字幕里被标出", () => {
  assert.equal(
    marked("VLOOKUP 找不到值，就会返回 #N/A，这是最常见的坑", "**VLOOKUP** 找不到 → #N/A"),
    "[VLOOKUP 找不到]值，就会返回 [#N/A]，这是最常见的坑"
  );
});

test("字幕对板书：单个字、两个字母不算", () => {
  const mask = captionMatchMask("把 A 列拖进来", "- A 列：日期");
  assert.equal(mask.some(Boolean), false);
});

test("字幕对板书：没有板书就全不标", () => {
  assert.deepEqual(captionMatchMask("你好", undefined), [false, false]);
});

test("字幕对板书：markdown 符号不影响匹配", () => {
  assert.equal(marked("行数从 3 变成 6", "| 行数 | 3 → **6** |\n| --- | --- |"), "[行数]从 3 变成 6");
});
