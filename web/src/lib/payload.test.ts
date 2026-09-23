/*
 * `reason()` 的单测(issue #443):审查轨迹与知识轨迹好几处「未记录原因」的回落此前只判
 * `str()` 挡不住的空串,漏了只有空白的那一种——两条真实写入路径都带固定前缀,构造不出这种
 * 输入,只能靠这条单测钉住判据本身。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { reason } from "./payload.ts";

test("有内容的原因原样返回", () => {
  assert.equal(reason({ reason: "Gitea 回了 500" }, "reason"), "Gitea 回了 500");
});

test("缺字段、空串与只有空白都回落成「未记录原因」", () => {
  assert.equal(reason({}, "reason"), "未记录原因");
  assert.equal(reason({ reason: "" }, "reason"), "未记录原因");
  assert.equal(reason({ reason: "   " }, "reason"), "未记录原因");
  assert.equal(reason({ reason: "\n\t " }, "reason"), "未记录原因");
});

test("前后空白被去掉", () => {
  assert.equal(reason({ reason: "  超时  " }, "reason"), "超时");
});
