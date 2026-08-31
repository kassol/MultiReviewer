/**
 * snippet 锚定:行号以模型抄的代码原文为准核对与校正。
 * PR #3 实测模型在 55 行的文件上报偏 4 行,评论挂错函数,这层是兜底。
 *
 * 锚定还兼判 hunk 成员资格(issue #224):对得上文件却落在本轮 diff 之外的位置一样打回。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiffRanges } from "../src/review/position.ts";
import { anchorFinding, anchorReport, anchorVerdict } from "../src/reviewer/anchor.ts";

const LINES = [
  "import { x } from './x.js';",
  "",
  "export function evaluate(expr) {",
  "  return new Function(`return (${expr})`)();",
  "}",
  "",
  "export function recent(count) {",
  "  return history.slice(-count);",
  "}",
];

test("行号与 snippet 对得上时原样放行", () => {
  const result = anchorFinding(LINES, 4, "return new Function(`return (${expr})`)();");
  assert.deepEqual(result, { ok: true, line: 4, corrected: false });
});

test("首尾空白差异不影响匹配", () => {
  const result = anchorFinding(LINES, 4, "  return new Function(`return (${expr})`)();  ");
  assert.deepEqual(result, { ok: true, line: 4, corrected: false });
});

test("行号报偏时按 snippet 校正到真实行", () => {
  // PR #3 的实况:RCE 在第 4 行,模型报了第 7 行。
  const result = anchorFinding(LINES, 7, "return new Function(`return (${expr})`)();");
  assert.deepEqual(result, { ok: true, line: 4, corrected: true });
});

test("snippet 多处出现时取离报告行最近的一处", () => {
  const lines = ["}", "a();", "b();", "}", "c();"];
  const result = anchorFinding(lines, 3, "}");
  assert.deepEqual(result, { ok: true, line: 4, corrected: true });
});

test("行号超出文件末尾但 snippet 找得到时照样校正", () => {
  const result = anchorFinding(LINES, 40, "return history.slice(-count);");
  assert.deepEqual(result, { ok: true, line: 8, corrected: true });
});

test("snippet 在文件里不存在时打回,理由里带该行实际内容", () => {
  const result = anchorFinding(LINES, 4, "return eval(expr);");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /return new Function/);
});

test("行号超界且 snippet 不存在时打回,理由里带文件行数", () => {
  const result = anchorFinding(LINES, 40, "nothing like this");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /9 行/);
});

test("空白 snippet 直接打回", () => {
  const result = anchorFinding(LINES, 2, "   ");
  assert.equal(result.ok, false);
});

const REPORTED = {
  file: "src/evaluate.ts",
  line: 4,
  snippet: "return new Function(`return (${expr})`)();",
};

/** 本轮 diff 只覆盖 evaluate 那几行,recent 整个函数落在变更之外。 */
const RANGES: DiffRanges = { "src/evaluate.ts": [{ start: 3, end: 5 }] };

test("文件读不出来时打回,措辞点名那个路径", () => {
  const result = anchorReport(undefined, RANGES, REPORTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /src\/evaluate\.ts/);
});

test("snippet 对不上时打回,措辞带上核对不过的理由", () => {
  const result = anchorReport(LINES, RANGES, { ...REPORTED, snippet: "return eval(expr);" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /return new Function/);
});

test("锚定得上时不打回,给出校正后的行号", () => {
  const result = anchorReport(LINES, RANGES, { ...REPORTED, line: 7 });
  assert.deepEqual(result, { ok: true, line: 4 });
});

test("锚定得上但落在本轮 diff 之外时打回,措辞给出报在变更侧的指引", () => {
  const result = anchorReport(LINES, RANGES, {
    file: "src/evaluate.ts",
    line: 8,
    snippet: "return history.slice(-count);",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /src\/evaluate\.ts:8/);
  assert.match(result.message, /outside the diff/);
  // 打回不是「换个行号再报一次」,而是「把问题报在变更侧因果末端」。
  assert.match(result.message, /causal chain/);
});

test("整个文件没有变更时,文件里锚得上的行同样落在 diff 之外", () => {
  const result = anchorReport(LINES, {}, REPORTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /outside the diff/);
});

test("校正之后才判 hunk 成员资格:模型报偏的行号不作数", () => {
  // 模型把行号报到了 diff 之外的第 8 行,snippet 指的却是 hunk 内的第 4 行。
  const result = anchorReport(LINES, RANGES, { ...REPORTED, line: 8 });
  assert.deepEqual(result, { ok: true, line: 4 });
});

test("复核延续的新位置同受 hunk 成员资格校验", () => {
  const outside = anchorVerdict(LINES, RANGES, {
    file: "src/evaluate.ts",
    line: 8,
    snippet: "return history.slice(-count);",
  });
  assert.equal(outside.ok, false);
  if (outside.ok) return;
  // 结论本身照收,打回丢掉的只是这个新位置。
  assert.match(outside.message, /verdict recorded/);
  assert.match(outside.message, /outside the diff/);

  const inside = anchorVerdict(LINES, RANGES, {
    file: "src/evaluate.ts",
    line: 4,
    snippet: "return new Function(`return (${expr})`)();",
  });
  assert.deepEqual(inside, { ok: true, line: 4 });
});
