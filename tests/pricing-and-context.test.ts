import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDIT_PACKS, CREDITS_PER_FULL_COURSE, NEW_USER_GRANT, COST_COURSE_GENERATE, pricePerCredit } from "../lib/pricing";
import { buildLectureContext } from "../lib/agent/lecture-context";
import { boardScriptKey, isBoardScriptOfCourse } from "../lib/board/script-store";
import type { CourseOutline } from "../types";

test("积分包：价格与积分为正，越大的包单价越低", () => {
  for (const p of CREDIT_PACKS) assert.ok(p.price > 0 && p.credits > 0);
  const unit = CREDIT_PACKS.map(pricePerCredit);
  for (let i = 1; i < unit.length; i++) assert.ok(unit[i] <= unit[i - 1], `第 ${i} 档单价不应高于上一档`);
});

test("注册赠送够生成一门课；最多人选的包够新开并学完一门", () => {
  assert.ok(NEW_USER_GRANT >= COST_COURSE_GENERATE);
  const popular = CREDIT_PACKS.find((p) => p.popular)!;
  assert.ok(popular.credits >= CREDITS_PER_FULL_COURSE);
});

test("buildLectureContext：带出单元关键概念与同单元前情（跳过测验/项目课节）", () => {
  const outline = {
    title: "课",
    audience: "人",
    units: [
      {
        id: "unit-1",
        title: "单元一",
        key_concepts: ["A"],
        lectures: [
          { id: "lec-1-1", title: "第一讲", summary: "s1", depth_tags: [], content_type: "whiteboard" },
          { id: "lec-1-2", title: "小测", summary: "q", depth_tags: [], content_type: "quiz" },
          { id: "lec-1-3", title: "第三讲", summary: "s3", depth_tags: [], content_type: "whiteboard" },
        ],
      },
    ],
  } as unknown as CourseOutline;
  const ctx = buildLectureContext(outline, "unit-1", "lec-1-3")!;
  assert.deepEqual(ctx.keyConcepts, ["A"]);
  assert.deepEqual(ctx.previousLectures?.map((l) => l.title), ["第一讲"]);
  assert.deepEqual(ctx.unitProgress, { index: 3, total: 3 });
  assert.equal(buildLectureContext(outline, "unit-1", "nope"), null);
});

test("讲稿缓存键：按用户隔离，删课时能按课程匹配", () => {
  const k = boardScriptKey("course-abc", "unit-1", "lec-1-1", "u-1");
  assert.equal(k, "board-scripts/v2_u-1_course-abc_unit-1_lec-1-1.json");
  assert.ok(isBoardScriptOfCourse(k, "course-abc"));
  assert.ok(!isBoardScriptOfCourse(k, "course-ab"));
});
