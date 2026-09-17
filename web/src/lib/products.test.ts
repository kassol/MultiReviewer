/*
 * 产品页那几个纯函数的单测(issue #331、#360、#363)。归属候选判反了的后果是一列只会回 409
 * 的候选,或者一个归不进任何产品的新仓库;术语分组漏一组的后果是那几条术语在产品页上不见
 * 了;可开工判错的后果是有人去做一张还被挡着、或者已经有人认领的票。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentProduct,
  groupedTerms,
  pickableTickets,
  unassignedRepos,
  type ProductKnowledge,
  type TrackerSpec,
  type TrackerTicket,
} from "./products.ts";

test("候选只留没归入任何产品的仓库,哪个产品占着都算占着", () => {
  const repos = [{ repoId: 1 }, { repoId: 2 }, { repoId: 3 }];
  const products = [{ repos: [{ repoId: 2 }] }, { repos: [] }, { repos: [{ repoId: 3 }] }];

  assert.deepEqual(unassignedRepos(repos, products), [{ repoId: 1 }]);
  // 一个产品都没有时全是候选。
  assert.deepEqual(unassignedRepos(repos, []), repos);
});

test("当前产品取地址上那个,取不到就落到列表第一个", () => {
  const products = [{ id: 7 }, { id: 9 }];

  assert.deepEqual(currentProduct(products, 9), { id: 9 });
  // 地址没带产品(`/products`)。
  assert.deepEqual(currentProduct(products, undefined), { id: 7 });
  // 地址带的产品这个账号看不到,仍要有当前项,否则右栏整块空着。
  assert.deepEqual(currentProduct(products, 404), { id: 7 });
  assert.equal(currentProduct([], 7), undefined);
});

test("术语表按主题分组:主题按首次出现排,没分组的排在最后一组", () => {
  const term = (id: number, name: string, topic: string | null): ProductKnowledge => ({
    id,
    kind: "term",
    name,
    body: `${name}是什么`,
    topic,
    avoided: [],
    options: null,
    consequences: null,
    supersededBy: null,
    annotations: [],
    writtenAt: "2026-09-17T00:00:00.000Z",
  });
  const relationship: ProductKnowledge = { ...term(9, "", null), kind: "relationship" };

  assert.deepEqual(
    groupedTerms([
      term(1, "订单", "交易"),
      term(2, "口令", null),
      term(3, "退款", "交易"),
      relationship,
      term(4, "工单", "运营"),
    ]).map((group) => [group.topic, group.terms.map((row) => row.name)]),
    [
      ["交易", ["订单", "退款"]],
      ["运营", ["工单"]],
      [null, ["口令"]],
    ],
  );
  // 一条术语都没有时没有分组:关系与决策不进这一份。
  assert.deepEqual(groupedTerms([relationship]), []);
});

test("可开工的票:开着、无未关阻塞、无人认领", () => {
  const ticket = (id: number, over: Partial<TrackerTicket> = {}): TrackerTicket => ({
    id,
    title: `票 ${id}`,
    label: "needs-triage",
    state: "open",
    claimedBy: null,
    blockedBy: [],
    ...over,
  });
  const spec = (id: number, tickets: TrackerTicket[]): TrackerSpec => ({
    id,
    title: `spec ${id}`,
    state: "open",
    tickets,
  });

  const picked = pickableTickets([
    spec(1, [
      ticket(1),
      ticket(2, { state: "closed" }),
      ticket(3, { claimedBy: "wang" }),
      // 挡着它的那张还开着。
      ticket(4, { blockedBy: [1] }),
      // 挡着它的那张已经关了。
      ticket(5, { blockedBy: [2] }),
      // 两张挡着,只关了一张。
      ticket(6, { blockedBy: [1, 2] }),
    ]),
    // 挡着它的那张挂在另一条 spec 下:判定跨整份 tracker 做,不在单条 spec 里算。
    spec(2, [ticket(7, { blockedBy: [1] }), ticket(8, { blockedBy: [2] })]),
  ]);

  assert.deepEqual(
    [...picked].sort((a, b) => a - b),
    [1, 5, 8],
  );
  // 认不出的票号不挡着:一份还没读全的数据不该让整张票从可开工里消失。
  assert.deepEqual([...pickableTickets([spec(1, [ticket(1, { blockedBy: [99] })])])], [1]);
  assert.deepEqual([...pickableTickets([])], []);
});
