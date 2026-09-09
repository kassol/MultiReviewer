/*
 * 同根因组折叠投影的单测(issue #309)。阶段列表的先后是服务端定的口径,折叠把 N 条收进
 * 一张卡的同时不能改这个先后,否则「待处置在最前」这条规则在有组的阶段上就不成立了。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { foldByRootCause, type RootCauseRef } from "./root-cause.ts";

type Row = { id: number; rootCause: RootCauseRef | null };

function ref(id: number, memberCount: number, position: number): RootCauseRef {
  return { id, reason: `根因 ${id}`, memberCount, position };
}

test("组卡落在这一组排得最靠前的成员那个位置上,其余成员收进卡里", () => {
  const rows = foldByRootCause<Row>([
    { id: 1, rootCause: null },
    { id: 2, rootCause: ref(7, 3, 0) },
    { id: 3, rootCause: null },
    { id: 4, rootCause: ref(7, 3, 1) },
    { id: 5, rootCause: ref(7, 3, 2) },
  ]);
  assert.deepEqual(
    rows.map((row) => (row.kind === "group" ? `group:${row.id}` : `finding:${row.finding.id}`)),
    ["finding:1", "group:7", "finding:3"],
  );
  const card = rows[1]!;
  assert.equal(card.kind, "group");
  assert.equal(card.kind === "group" ? card.reason : "", "根因 7");
  assert.deepEqual(
    card.kind === "group" ? card.members.map((member) => member.id) : [],
    [2, 4, 5],
  );
});

test("两个组各成一张卡,顺序按各自头一个成员", () => {
  const rows = foldByRootCause<Row>([
    { id: 1, rootCause: ref(8, 2, 0) },
    { id: 2, rootCause: ref(7, 2, 0) },
    { id: 3, rootCause: ref(8, 2, 1) },
    { id: 4, rootCause: ref(7, 2, 1) },
  ]);
  assert.deepEqual(
    rows.map((row) => (row.kind === "group" ? row.id : -1)),
    [8, 7],
  );
});

test("筛掉一部分成员之后卡里只剩看得见的那几条,成员总数仍是组的总数", () => {
  const rows = foldByRootCause<Row>([{ id: 4, rootCause: ref(7, 3, 1) }]);
  assert.equal(rows.length, 1);
  const card = rows[0]!;
  assert.equal(card.kind === "group" ? card.members.length : -1, 1);
  assert.equal(card.kind === "group" ? card.memberCount : -1, 3);
});

test("一条都没入组时逐条列出,列表原样通过", () => {
  const rows = foldByRootCause<Row>([
    { id: 1, rootCause: null },
    { id: 2, rootCause: null },
  ]);
  assert.deepEqual(
    rows.map((row) => (row.kind === "finding" ? row.finding.id : -1)),
    [1, 2],
  );
});
