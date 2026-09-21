/*
 * 阶段标识与阶段片的互推(issue #439)。路由一匹配就按标识推出汇总要取哪一片,不等阶段
 * 详情返回;推错的话预取的是另一个阶段的汇总,组件挂载后还得再发一次,预取白做。
 * 判据与服务端 `stageRowById` 逐条对齐:两边认得出的标识必须是同一批。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { scopeFromStageId, scopePath, stageIdOf, stageSummaryKey } from "./stage-queries.ts";

test("两种来源的阶段标识各推出自己那一片", () => {
  assert.deepEqual(scopeFromStageId("range:21"), { kind: "range-review", rangeReviewId: 21 });
  assert.deepEqual(scopeFromStageId("pr:acme/widgets/7"), {
    kind: "pull-request",
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
  });
  // 仓库名里的连字符与点号照常:切分只认斜杠,这两种字符不参与。
  assert.deepEqual(scopeFromStageId("pr:my-org/my.repo.js/3"), {
    kind: "pull-request",
    owner: "my-org",
    repo: "my.repo.js",
    pullNumber: 3,
  });
});

test("推出来的片拼回去仍是原来那个标识", () => {
  for (const stageId of ["range:1", "range:21", "pr:acme/widgets/7", "pr:a-b/c.d/999"]) {
    assert.equal(stageIdOf(scopeFromStageId(stageId)!), stageId, stageId);
  }
});

test("认不出的标识回 null,那一次不预取", () => {
  for (const stageId of [
    "", // 空
    "acme/widgets/7", // 没有前缀
    "stage:1", // 别的前缀
    "range:", // 没有 id
    "range:0", // 阶段 id 从 1 起
    "range:-1",
    "range:abc",
    "range:1.5",
    "range:1e3", // Number 认得出,但拼回去不是原样
    "pr:acme/widgets", // 少一段
    "pr:acme/widgets/7/extra", // 多一段
    "pr:acme/widgets/0",
    "pr:acme/widgets/x",
    // 服务端同一条规则:`007` 解析出的是 7 号,那是另一个标识,按查不到处理。
    "pr:acme/widgets/007",
  ]) {
    assert.equal(scopeFromStageId(stageId), null, stageId);
  }
});

test("两种来源的汇总各有自己的查询键与地址", () => {
  const range = { kind: "range-review", rangeReviewId: 21 } as const;
  assert.deepEqual(stageSummaryKey(range), ["stage-summary", "range-review", 21]);
  assert.equal(scopePath(range), "/stage-summary?rangeReviewId=21");

  // 仓库名进查询串要编码:`my.repo` 这种不需要,带空格或斜杠的仓库名需要。
  const pull = { kind: "pull-request", owner: "acme", repo: "my widgets", pullNumber: 7 } as const;
  assert.deepEqual(stageSummaryKey(pull), ["stage-summary", "pull-request", "acme", "my widgets", 7]);
  assert.equal(scopePath(pull), "/stage-summary?owner=acme&repo=my%20widgets&pullNumber=7");
});
