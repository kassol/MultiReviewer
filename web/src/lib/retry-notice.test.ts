/*
 * 会话页「正在重试」那一行的文案与帧读取。读错一格的后果是那一行不消失(把 null 读成没说)
 * 或者白屏(把坏形状当对象用),两样都值得钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readRetry, retryNotice } from "./retry-notice.ts";

test("文案写出第几次、上限与约几秒,不足一秒按一秒说", () => {
  assert.equal(
    retryNotice({ attempt: 2, maxAttempts: 10, delayMs: 4000 }),
    "模型服务暂时出错，第 2/10 次重试，约 4 秒后再试",
  );
  assert.equal(
    retryNotice({ attempt: 1, maxAttempts: 10, delayMs: 300 }),
    "模型服务暂时出错，第 1/10 次重试，约 1 秒后再试",
  );
  assert.equal(
    retryNotice({ attempt: 3, maxAttempts: 10, delayMs: 8001 }),
    "模型服务暂时出错，第 3/10 次重试，约 9 秒后再试",
  );
});

test("帧里没有 retry 即没说,null 即落定,对象原样读出", () => {
  assert.equal(readRetry({ text: "x" }), undefined);
  assert.equal(readRetry(null), undefined);
  assert.equal(readRetry({ retry: null }), null);
  assert.deepEqual(
    readRetry({ retry: { attempt: 1, maxAttempts: 10, delayMs: 2000, errorMessage: "503" } }),
    { attempt: 1, maxAttempts: 10, delayMs: 2000, errorMessage: "503" },
  );
});

test("形状不对的 retry 按没说处理", () => {
  assert.equal(readRetry({ retry: "oops" }), undefined);
  assert.equal(readRetry({ retry: { attempt: "1", maxAttempts: 10, delayMs: 0, errorMessage: "" } }), undefined);
});
