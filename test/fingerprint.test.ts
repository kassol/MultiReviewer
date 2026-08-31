import assert from "node:assert/strict";
import { test } from "node:test";

import { fingerprintAnchor, parseFingerprintAnchors } from "../src/review/fingerprint.ts";

test("body 不是字符串时返回空数组,不抛", () => {
  // listReviewBodies 直接把平台读回的 review.body push 进来,理论上可能是 null。
  // 单点在这里挡住:任一条正文异常不该把整轮 Review Run 带崩。
  assert.deepEqual(parseFingerprintAnchors(null as unknown as string), []);
  assert.deepEqual(parseFingerprintAnchors(undefined as unknown as string), []);
});

test("空正文与无锚点正文都返回空数组", () => {
  assert.deepEqual(parseFingerprintAnchors(""), []);
  assert.deepEqual(parseFingerprintAnchors("这个 PR 我看过了,没问题"), []);
});

const A = "a".repeat(64);
const B = "b".repeat(64);

test("行级评论的锚点只有指纹,不带文件路径", () => {
  assert.deepEqual(parseFingerprintAnchors(`说明\n\n${fingerprintAnchor(A)}`), [
    { fingerprint: A, file: undefined },
  ]);
});

test("锚定收敛之前发出去的正文锚点另带文件路径,仍要认得出", () => {
  // 这一形态不再新增(issue #224),存量 PR 的正文里还挂着,跨轮匹配靠它。
  const body = [
    "以下 Finding 的行号落在本次 Review Range 的 diff 之外:",
    `<!-- multireviewer:${A}:src/calc.js -->`,
    `<!-- multireviewer:${B}:src/other.js -->`,
  ].join("\n\n");

  // 取全部而不是第一个:只认第一个会让其余的 Finding 每轮重发。
  assert.deepEqual(parseFingerprintAnchors(body), [
    { fingerprint: A, file: "src/calc.js" },
    { fingerprint: B, file: "src/other.js" },
  ]);
});
