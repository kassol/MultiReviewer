/*
 * 阶段轮次筛选的单测(issue #369)。每天看一次阶段汇总的人问的是「今天新出了什么」,
 * 答案由「首次报出在第几轮」决定:轮次编号、选项文案与那条判据错一处,筛出来的就是
 * 另一批 Finding,而人不会察觉。
 *
 * 时间戳一律写本地时刻(不带 `Z`):这样断言里的日期在任何时区上都是同一个。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { firstReportedFrom, roundFilterOptions, roundNumbers } from "./stage-rounds.ts";

const TIMELINE = [
  { runId: 41, startedAt: "2026-09-16T09:00:00", reported: 7 },
  { runId: 52, startedAt: "2026-09-17T09:30:00", reported: 0 },
  { runId: 63, startedAt: "2026-09-18T10:00:00", reported: 2 },
];

test("轮次编号按这个阶段自己数,与 Finding 卡上的「第 N 轮首次报出」同一份", () => {
  assert.deepEqual([...roundNumbers(TIMELINE)], [
    [41, 1],
    [52, 2],
    [63, 3],
  ]);
});

test("轮次选项新到旧,逐项写「第 N 轮 · 日期 · 新增 M」,本轮没新报的那一轮照样列出来", () => {
  assert.deepEqual(roundFilterOptions(TIMELINE), [
    { value: "3", label: "第 3 轮 · 2026-09-18 · 新增 2" },
    { value: "2", label: "第 2 轮 · 2026-09-17 · 新增 0" },
    { value: "1", label: "第 1 轮 · 2026-09-16 · 新增 7" },
  ]);
});

test("默认「全部轮次」一条不筛,时间线上没有的那一轮也留着", () => {
  const rounds = roundNumbers(TIMELINE);
  assert.equal(firstReportedFrom("all", 41, rounds), true);
  assert.equal(firstReportedFrom("all", 999, rounds), true);
});

test("选第 N 轮只留首次报出在第 N 轮或之后的", () => {
  const rounds = roundNumbers(TIMELINE);
  assert.deepEqual(
    [41, 52, 63].map((runId) => firstReportedFrom("2", runId, rounds)),
    [false, true, true],
  );
});

test("第 1 轮首次报出、第 3 轮又被折叠重报的那条,选第 3 轮时不出现", () => {
  const rounds = roundNumbers(TIMELINE);
  // 判据取首次报出那一轮(`firstRunId`),最近一次报出(`lastRunId`)不参与:重报的是
  // 已经看过的那条,把它算成「新出的」就等于每天重看一遍昨天。
  const folded = { firstRunId: 41, lastRunId: 63 };
  assert.equal(firstReportedFrom("3", folded.firstRunId, rounds), false);
});

test("第 1 轮报出、第 3 轮延续到新位置的那条,首次报出仍是第 1 轮,选第 3 轮时不出现", () => {
  const rounds = roundNumbers(TIMELINE);
  // 延续只换落点,`firstRunId` 由服务端的阶段汇总投影保持在最初那一轮
  // (`test/panel-stage-summary.test.ts` 钉住这一点)。
  const continued = { firstRunId: 41, lastRunId: 63 };
  assert.equal(firstReportedFrom("3", continued.firstRunId, rounds), false);
  assert.equal(firstReportedFrom("1", continued.firstRunId, rounds), true);
});

test("时间线上没有的那一轮在选定轮次下一律筛掉", () => {
  assert.equal(firstReportedFrom("1", 999, roundNumbers(TIMELINE)), false);
});
