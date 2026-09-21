/*
 * 读请求重试判据的单测(issue #440)。判错一边的代价都是人看得见的:4xx 重试就是
 * 打开不存在的阶段先等约 7 秒骨架,5xx 不重试就是一次抖动直接变成错误页。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldRetryQuery } from "./query-retry.ts";

const withStatus = (status: number) => Object.assign(new Error("x"), { status });

test("4xx 一次都不重试", () => {
  for (const status of [400, 403, 404, 409, 499]) {
    assert.equal(shouldRetryQuery(0, withStatus(status)), false);
  }
});

test("5xx 与没有状态码的错误照常重试", () => {
  assert.equal(shouldRetryQuery(0, withStatus(500)), true);
  assert.equal(shouldRetryQuery(0, withStatus(503)), true);
  assert.equal(shouldRetryQuery(0, new TypeError("Failed to fetch")), true);
  assert.equal(shouldRetryQuery(0, null), true);
});

test("到三次为止,与 React Query 默认的 retry: 3 同一个上限", () => {
  assert.equal(shouldRetryQuery(2, withStatus(500)), true);
  assert.equal(shouldRetryQuery(3, withStatus(500)), false);
  assert.equal(shouldRetryQuery(3, new TypeError("Failed to fetch")), false);
});
