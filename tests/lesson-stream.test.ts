import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LESSON_CLOSING_SYSTEM,
  LESSON_NEXT_SYSTEM,
  LESSON_START_SYSTEM,
  STREAM_CLOSING_FORMAT,
  STREAM_SEGMENT_FORMAT,
  STREAM_START_FORMAT,
  createSegmentBuilder,
  segmentToActions,
  toStream,
} from "../lib/board/lesson-engine";

test("三种讲课提示词都能换成逐行（JSON Lines）输出格式，讲课规则保留", () => {
  for (const [sys, fmt] of [
    [LESSON_START_SYSTEM, STREAM_START_FORMAT],
    [LESSON_NEXT_SYSTEM, STREAM_SEGMENT_FORMAT],
    [LESSON_CLOSING_SYSTEM, STREAM_CLOSING_FORMAT],
  ] as const) {
    const s = toStream(sys, fmt);
    assert.ok(!s.includes("只输出 JSON"), "旧格式说明应被替换");
    assert.ok(s.includes("JSON Lines"));
    assert.ok(s.includes("【怎么讲（最重要）】"), "讲课规则要保留");
  }
});

test("增量构建与整段构建产出完全一致的动作序列", () => {
  const seg = {
    beats: [
      { say: "先看课题卡。", board: "本节主题\n\n- 主键\n- 外键", circle: "主键" },
      { say: "注意这里。" },
    ],
    check: { kind: "choice" as const, question: "选哪个？", options: ["A", "B"], correct_index: 0 },
  };
  const opts = { index: 1, pageId: "p1", segmentTitle: "第二段", total: 4 };
  const whole = segmentToActions(seg, opts).actions;
  const b = createSegmentBuilder(opts);
  const inc = [...b.begin(), ...seg.beats.flatMap((x) => b.beat(x).actions), ...b.end(seg.check)];
  assert.deepEqual(inc, whole);
  assert.equal(whole[0].type, "segment_start");
  assert.equal(whole[whole.length - 1].type, "ask");
});

test("漏了检查题的段末尾自动接下一段；收尾段以 done 结束", () => {
  const noCheck = segmentToActions({ beats: [{ say: "a" }] }, { index: 2, pageId: "p" }).actions;
  assert.equal(noCheck[noCheck.length - 1].type, "segment_end");
  const closing = segmentToActions({ beats: [{ say: "a" }] }, { index: 4, pageId: "p", final: true, reward: { title: "徽章", description: "很好" } }).actions;
  assert.deepEqual(closing.slice(-2).map((a) => a.type), ["reward_user", "done"]);
});
