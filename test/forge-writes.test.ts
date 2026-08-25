/**
 * 容器 PR(ADR 0012)需要的两样写能力,各在自己的验收边界上验:
 * 把某分支推到指定 commit 走真实 git 与临时 bare 仓库,四个 Forge 写方法的调用
 * 由内存 Forge 记录。Gitea 那四个端点的请求形状在 `gitea-forge.test.ts` 里。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createGitHubForge } from "../src/forge/github.ts";
import { pushBranch } from "../src/git/worktree.ts";
import { makeBareRemote, makeCacheDir, makeRepo } from "./support/git-fixture.ts";
import { memoryForge } from "./support/memory-forge.ts";

const REF = { owner: "acme", repo: "widgets" };
const BRANCH = "multireviewer/1-head";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function setup() {
  const repo = makeRepo({
    base: { "src/calc.js": "export const a = 1;\n" },
    head: { "src/calc.js": "export const a = 2;\n" },
  });
  const remote = makeBareRemote(repo.dir);
  const cache = makeCacheDir();
  cleanups.push(repo.cleanup, remote.cleanup, cache.cleanup);
  return { repo, remote, cache };
}

function push(cacheDir: string, cloneUrl: string, sha: string): Promise<void> {
  return pushBranch({
    cacheDir,
    ref: REF,
    cloneUrl,
    credentials: { username: "bot", password: "unused-for-local-clone" },
    branch: BRANCH,
    sha,
  });
}

test("推分支:远端上的分支指向目标 commit", async () => {
  const { repo, remote, cache } = setup();

  await push(cache.dir, remote.dir, repo.headSha);

  assert.equal(remote.branchSha(BRANCH), repo.headSha);
});

test("推分支允许非快进:比较项 rebase 到不是后代的 commit 上照样推得动", async () => {
  const { repo, remote, cache } = setup();

  await push(cache.dir, remote.dir, repo.headSha);
  // 退回 base:新的比较项不是上一个比较项的后代,快进推不动它。
  await push(cache.dir, remote.dir, repo.mergeBaseSha);

  assert.equal(remote.branchSha(BRANCH), repo.mergeBaseSha);
});

test("内存 Forge 记下建分支、删分支、建 PR 与关 PR 四类调用", async () => {
  const { repo } = setup();
  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [],
  });

  await forge.forge.createBranch(REF, "multireviewer/1-base", repo.baseSha);
  await forge.forge.createBranch(REF, BRANCH, repo.headSha);
  const number = await forge.forge.createPullRequest(REF, {
    head: BRANCH,
    base: "multireviewer/1-base",
    title: "[MultiReviewer] 范围审查",
    body: "面板链接",
  });
  await forge.forge.closePullRequest({ ...REF, number });
  await forge.forge.deleteBranch(REF, BRANCH);

  assert.deepEqual(forge.createdBranches, [
    { branch: "multireviewer/1-base", fromSha: repo.baseSha },
    { branch: BRANCH, fromSha: repo.headSha },
  ]);
  assert.deepEqual(forge.createdPullRequests, [
    {
      number,
      head: BRANCH,
      base: "multireviewer/1-base",
      title: "[MultiReviewer] 范围审查",
      body: "面板链接",
    },
  ]);
  assert.deepEqual(forge.closedPullRequests, [number]);
  assert.deepEqual(forge.deletedBranches, [BRANCH]);
});

test("GitHub 实现对范围审查新增的方法抛未实现", async () => {
  const forge = createGitHubForge({ auth: { kind: "token", token: "unused" } });

  // 封存期间不为 GitHub 补新能力(ADR 0014):调到就当场报错,不静默什么都不做。
  await assert.rejects(() => forge.getRepository(REF), /未实现/);
  await assert.rejects(() => forge.createBranch(REF, BRANCH, "a".repeat(40)), /未实现/);
  await assert.rejects(() => forge.deleteBranch(REF, BRANCH), /未实现/);
  await assert.rejects(
    () => forge.createPullRequest(REF, { head: BRANCH, base: "main", title: "t", body: "b" }),
    /未实现/,
  );
  await assert.rejects(() => forge.closePullRequest({ ...REF, number: 7 }), /未实现/);
});
