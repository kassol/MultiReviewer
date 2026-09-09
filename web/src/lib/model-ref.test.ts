/*
 * 模型引用比较规则的单测。审查策略页与仓库配置弹窗共用它判脏状态,所以「同一份值判成
 * 两份」会直接变成一颗点不动的保存按钮或一次误报的离开确认。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sameModelRef, sameModelRefs } from "./model-ref.ts";

test("一处引用:标识与档位都相同才算同一份", () => {
  assert.equal(sameModelRef({ identity: "test:a" }, { identity: "test:a" }), true);
  assert.equal(
    sameModelRef({ identity: "test:a", thinkingLevel: "high" }, {
      identity: "test:a",
      thinkingLevel: "high",
    }),
    true,
  );
  assert.equal(sameModelRef({ identity: "test:a" }, { identity: "test:b" }), false);
  assert.equal(
    sameModelRef({ identity: "test:a" }, { identity: "test:a", thinkingLevel: "high" }),
    false,
  );
  assert.equal(
    sameModelRef({ identity: "test:a", thinkingLevel: "low" }, {
      identity: "test:a",
      thinkingLevel: "high",
    }),
    false,
  );
});

test("null 是没设 / 跟随全局,只与 null 相等", () => {
  assert.equal(sameModelRef(null, null), true);
  assert.equal(sameModelRef(null, { identity: "test:a" }), false);
  assert.equal(sameModelRefs(null, null), true);
  assert.equal(sameModelRefs(null, []), false);
  assert.equal(sameModelRefs([], null), false);
});

test("模型组合:长度、次序与每一处的档位都算数", () => {
  const combination = [
    { identity: "test:a", thinkingLevel: "high" as const },
    { identity: "test:b" },
  ];
  assert.equal(sameModelRefs(combination, [...combination]), true);
  assert.equal(sameModelRefs([], []), true);
  assert.equal(sameModelRefs(combination, [combination[1]!, combination[0]!]), false);
  assert.equal(sameModelRefs(combination, [combination[0]!]), false);
  assert.equal(
    sameModelRefs(combination, [{ identity: "test:a" }, combination[1]!]),
    false,
  );
});
