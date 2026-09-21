/*
 * 逐段渲染的渲染范围的单测(issue #434)。扩不够那一项就画不出来,而画不出来在页面上的样子
 * 是「点了带 `?rootCause=` 的链接进来什么都没发生」——没有报错,也没有空列表。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderedCovering } from "./paged-list.ts";

test("目标已经在已渲染范围内时范围不动", () => {
  assert.equal(renderedCovering(50, 0, 50), 50);
  assert.equal(renderedCovering(50, 49, 50), 50);
  assert.equal(renderedCovering(150, 120, 50), 150);
});

test("目标刚好落在范围之外时扩出一整段", () => {
  assert.equal(renderedCovering(50, 50, 50), 100);
  assert.equal(renderedCovering(50, 99, 50), 100);
});

test("目标在很后面时一次扩到装得下它的那一段", () => {
  assert.equal(renderedCovering(50, 300, 50), 350);
  assert.equal(renderedCovering(50, 349, 50), 350);
  assert.equal(renderedCovering(50, 350, 50), 400);
});

test("没有目标(下标 -1)时范围不动", () => {
  assert.equal(renderedCovering(50, -1, 50), 50);
  assert.equal(renderedCovering(200, -1, 50), 200);
});

test("范围只增不减:已经滚出来的那几段不因为一次定位缩回去", () => {
  for (const target of [-1, 0, 7, 199, 200, 201, 999]) {
    assert.ok(renderedCovering(200, target, 50) >= 200, `目标 ${target} 把范围缩小了`);
  }
});

test("扩出来的范围总是整段的倍数", () => {
  for (const target of [0, 1, 49, 50, 51, 123, 383]) {
    const next = renderedCovering(50, target, 50);
    assert.equal(next % 50, 0, `目标 ${target} 扩出了半段`);
    assert.ok(next > target, `目标 ${target} 没被装进范围里`);
  }
});
