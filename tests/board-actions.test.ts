import { test } from "node:test";
import assert from "node:assert/strict";
import { beatsToActions, groupActions } from "../lib/board/actions";
import type { BoardAction } from "../types/board";

test("groupActions：board/new_page 与紧随的 speak 同组，其余单独成组", () => {
  const a: BoardAction[] = [
    { type: "new_page", step_id: 0, page_id: "p", title: "t" },
    { type: "board", step_id: 1, board_uid: 0, page_id: "p", board_content: "卡" },
    { type: "speak", step_id: 2, spoken_text: "讲" },
    { type: "ask", step_id: 3, mode: "choice", question: "题", options: ["a", "b"] },
    { type: "done", step_id: 4 },
  ];
  assert.deepEqual(
    groupActions(a).map((g) => g.map((x) => x.type)),
    [["new_page"], ["board", "speak"], ["ask"], ["done"]]
  );
});

test("beatsToActions：旧版回放转成卡片 + 口播，首尾是 new_page / done", () => {
  const actions = beatsToActions(
    [
      { say: "第一句", section: "列表", items: [{ kind: "bullet", text: "只有值" }], segmentTitle: "引入" },
      { say: "第二句", items: [{ kind: "diagram", nodes: ["索引", "值"] }], segmentTitle: "引入" },
      { say: "", items: [], segmentTitle: "空" },
    ],
    "旧课"
  );
  assert.equal(actions[0].type, "new_page");
  assert.equal(actions[actions.length - 1].type, "done");
  const boards = actions.filter((x) => x.type === "board") as Extract<BoardAction, { type: "board" }>[];
  assert.equal(boards.length, 2);
  assert.match(boards[0].board_content, /\*\*列表\*\*/);
  assert.match(boards[1].board_content, /索引 → 值/);
  assert.equal(actions.filter((x) => x.type === "speak").length, 2);
});
