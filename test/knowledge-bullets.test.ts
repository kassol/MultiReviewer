/**
 * 知识条目进 prompt 的单行化(oneLine):录入侧是多行输入框,注入是一行一条的列表,
 * 换行不压掉会把一条陈述拆成几条残句。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { factBullet, oneLine, ruleBullet } from "../src/reviewer/worker-tools.ts";

test("多行陈述在注入的列表行里压成单行", () => {
  assert.equal(oneLine("第一句\n  第二句\n\n第三句"), "第一句 第二句 第三句");
  assert.equal(
    ruleBullet({ id: 3, scope: "src/**", statement: "边界要校验,\n包括空数组" }),
    "- [3] (src/**) 边界要校验, 包括空数组",
  );
  assert.equal(
    factBullet({ id: 7, scope: "", statement: "演示仓库\n无生产流量" }),
    "- (whole repository) 演示仓库 无生产流量",
  );
});
