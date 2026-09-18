/*
 * 代码差异侧滑画哪一轮的单测(issue #368)。一条 Finding 的行号属于算出它的那个 head:
 * 位置停在更早那一轮时侧滑要画那一轮的 diff 并标「已过期」,跟到最新一轮的照旧不标。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { findingDiffSource, isAnchorable } from "./finding-position.ts";

const TIMELINE = [
  { runId: 11, headSha: "1111111111111111111111111111111111111111" },
  { runId: 12, headSha: "2222222222222222222222222222222222222222" },
];

test("位置停在第一轮:画第一轮的 diff,并标出它是第几轮与那一轮的 head", () => {
  assert.deepEqual(findingDiffSource(11, TIMELINE), {
    runId: 11,
    stale: { round: 1, headSha: "1111111111111111111111111111111111111111" },
  });
});

test("位置跟到最新一轮:画最新那一轮的 diff,不标已过期", () => {
  assert.deepEqual(findingDiffSource(12, TIMELINE), { runId: 12, stale: null });
});

test("一轮都还没跑过、或这条已经不在阶段汇总里:给不出来源", () => {
  assert.equal(findingDiffSource(12, []), null);
  assert.equal(findingDiffSource(99, TIMELINE), null);
});

const RENDERED = new Set([10, 20]);

test("位置属于这一轮、行号在渲染范围内:锚定", () => {
  assert.equal(isAnchorable({ line: 10, placedRunId: 12 }, 12, RENDERED), true);
});

test("位置属于别的轮次、行号凑巧在渲染范围内:不锚定", () => {
  assert.equal(isAnchorable({ line: 10, placedRunId: 11 }, 12, RENDERED), false);
});

test("没有 placedRunId(轮次页自己的 Finding):只看行号", () => {
  assert.equal(isAnchorable({ line: 10 }, 12, RENDERED), true);
  assert.equal(isAnchorable({ line: 99 }, 12, RENDERED), false);
});
