import assert from "node:assert/strict";
import { test } from "node:test";

import { pageItems } from "./pagination.ts";

test("页码条:首末与当前页左右各一页,两页以上的空隙折成省略号", () => {
  assert.deepEqual(pageItems(0, 1), [0]);
  assert.deepEqual(pageItems(0, 9), [0, 1, "gap", 8]);
  assert.deepEqual(pageItems(4, 9), [0, "gap", 3, 4, 5, "gap", 8]);
  assert.deepEqual(pageItems(2, 9), [0, 1, 2, 3, "gap", 8]);
  assert.deepEqual(pageItems(8, 9), [0, "gap", 7, 8]);
  // 只隔一页时直接画那一页。
  assert.deepEqual(pageItems(3, 7), [0, 1, 2, 3, 4, 5, 6]);
});
