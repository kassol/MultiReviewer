/*
 * 产品页那几个纯函数的单测(issue #331、#360)。归属候选判反了的后果是一列只会回 409 的
 * 候选,或者一个归不进任何产品的新仓库;术语分组漏一组的后果是那几条术语在产品页上不见了。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentProduct,
  groupedTerms,
  unassignedRepos,
  type ProductKnowledge,
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
