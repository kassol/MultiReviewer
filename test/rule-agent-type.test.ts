import assert from "node:assert/strict";
import test from "node:test";

import { readProposalType } from "../src/reviewer/rule-agent.ts";

const existing = [
  { id: 1, type: "fact" as const, scope: "", statement: "雪花 id 全库唯一" },
  { id: 2, type: "rule" as const, scope: "", statement: "Controller 必须标注 @SaCheckLogin" },
];

test("认得的取值照收", () => {
  assert.equal(readProposalType("fact", [2], existing), "fact");
  assert.equal(readProposalType("rule", [1], existing), "rule");
});

test("认不得的取值指向单目标时取目标的型:一个写错的 type 不该变成一次改型", () => {
  assert.equal(readProposalType("facts", [1], existing), "fact");
  assert.equal(readProposalType("", [2], existing), "rule");
});

test("认不得的取值没有目标、目标不止一条或目标认不出时当规则收", () => {
  assert.equal(readProposalType("facts", undefined, existing), "rule");
  assert.equal(readProposalType("facts", [1, 2], existing), "rule");
  assert.equal(readProposalType("facts", [9], existing), "rule");
});
