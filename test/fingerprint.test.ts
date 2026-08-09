import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFingerprintAnchors } from "../src/review/fingerprint.ts";

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
