/*
 * 归属弹窗候选的单测(issue #331)。判反了的后果是一列只会回 409 的候选,或者一个归不
 * 进任何产品的新仓库——两头都让人卡住,值得一条断言钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { unassignedRepos } from "./products.ts";

test("候选只留没归入任何产品的仓库,哪个产品占着都算占着", () => {
  const repos = [{ repoId: 1 }, { repoId: 2 }, { repoId: 3 }];
  const products = [{ repos: [{ repoId: 2 }] }, { repos: [] }, { repos: [{ repoId: 3 }] }];

  assert.deepEqual(unassignedRepos(repos, products), [{ repoId: 1 }]);
  // 一个产品都没有时全是候选。
  assert.deepEqual(unassignedRepos(repos, []), repos);
});
