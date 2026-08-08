/**
 * snippet 锚定:行号以模型抄的代码原文为准核对与校正。
 * PR #3 实测模型在 55 行的文件上报偏 4 行,评论挂错函数,这层是兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { anchorFinding } from "../src/reviewer/anchor.ts";

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
