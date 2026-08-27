/**
 * 注册后后台备工作副本(issue #184)。
 *
 * 三条缝各就各位:面板 API 走真实 HTTP,clone 落在临时缓存目录里的 git fixture 上,
 * 仓库注册表在临时 SQLite。「注册不等 clone」这一条靠拦住 Forge 的读仓库来证:后台
 * 那一步还卡着,注册响应已经回来了。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Forge, RepoRef, Repository } from "../src/forge/forge.ts";
import {
  GITEA_REPO,
  HARNESS_PR as PR,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** 工作副本的位置:缓存根下的 `<owner>/<repo>`。 */
const worktreePath = (h: PanelHarness): string => join(h.cacheDir, PR.owner, PR.repo);

type RepoRow = {
  repoId: number;
  worktree: { state: string; failure: string | null; checkedAt: string | null };
};

async function worktreeOf(h: PanelHarness): Promise<RepoRow["worktree"]> {
  const rows = (await (await h.api("GET", "/repos")).json()) as RepoRow[];
  const row = rows.find((candidate) => candidate.repoId === GITEA_REPO.id);
  assert.notEqual(row, undefined, "仓库不在注册表里");
  return row!.worktree;
}

/** 拦住 Forge 的读仓库,后台准备因此停在第一步,直到测试放行。 */
function gatedForge(forge: Forge): { forge: Forge; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    forge: {
      ...forge,
      getRepository: async (ref: RepoRef): Promise<Repository> => {
        await gate;
        return forge.getRepository(ref);
      },
    },
    release,
  };
}

test("注册立刻返回,工作副本在后台备好,状态从准备中走到就绪", async () => {
  let gate: { release: () => void } | undefined;
  const h = await startReadyPanelHarness(cleanups, {
    wrapForge: (forge) => {
      const gated = gatedForge(forge);
      gate = gated;
      return gated.forge;
    },
  });

  const register = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });
  assert.equal(register.status, 201);

  // 后台那一步还卡在读仓库上,注册响应已经回来了:注册不等 clone。
  assert.deepEqual(await worktreeOf(h), {
    state: "preparing",
    failure: null,
    checkedAt: null,
  });
  assert.equal(existsSync(worktreePath(h)), false);

  gate!.release();
  await h.worktreesPreparedAtLeast(1);
  assert.deepEqual(h.worktrees, [{ repoId: GITEA_REPO.id }]);

  const status = await worktreeOf(h);
  assert.equal(status.state, "ready");
  assert.equal(status.failure, null);
  assert.notEqual(status.checkedAt, null);
  assert.equal(existsSync(join(worktreePath(h), ".git")), true);
});

test("副本已就绪之后,一次审查与一次分支列表都不再 clone", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  await h.worktreesPreparedAtLeast(1);
  assert.equal((await worktreeOf(h)).state, "ready");

  // 在副本里留个记号。再 clone 一次只有两种下场:要么 clone 进非空目录当场失败,
  // 要么先删后建把记号一起抹掉——记号还在且两条链路都跑通,就是只 fetch 没 clone。
  const marker = join(worktreePath(h), ".git", "multireviewer-worktree-marker");
  writeFileSync(marker, "kept");
  const clonedAt = execFileSync(
    "git",
    ["-C", worktreePath(h), "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).trim();

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const branches = await h.api(
    "GET",
    `/repo-branches?owner=${PR.owner}&repo=${PR.repo}`,
  );
  assert.equal(branches.status, 200);
  assert.deepEqual(
    ((await branches.json()) as { branches: { name: string }[] }).branches.map(
      (branch) => branch.name,
    ),
    ["main", "feature"],
  );

  assert.equal(existsSync(marker), true, "两条链路都该复用已有副本,不再 clone");
  assert.equal(
    execFileSync("git", ["-C", worktreePath(h), "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).trim(),
    clonedAt,
  );
  // 后台只备过那一次:审查与分支列表都没有再触发准备。
  assert.equal(h.worktrees.length, 1);
});

test("备副本失败时记下原因与时刻,重试能把它备好", async () => {
  let failing = true;
  const h = await startReadyPanelHarness(cleanups, {
    wrapForge: (forge) => ({
      ...forge,
      getRepository: async (ref: RepoRef): Promise<Repository> => {
        if (failing) throw new Error("Gitea 读不到仓库");
        return forge.getRepository(ref);
      },
    }),
  });

  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  await h.worktreesPreparedAtLeast(1);

  const failed = await worktreeOf(h);
  assert.equal(failed.state, "failed");
  assert.match(failed.failure ?? "", /Gitea 读不到仓库/);
  assert.notEqual(failed.checkedAt, null);
  assert.equal(existsSync(worktreePath(h)), false);

  failing = false;
  const retry = await h.api("POST", `/repos/${GITEA_REPO.id}/worktree`);
  assert.equal(retry.status, 202);
  await h.worktreesPreparedAtLeast(2);

  const ready = await worktreeOf(h);
  assert.equal(ready.state, "ready");
  assert.equal(ready.failure, null);
  assert.equal(existsSync(join(worktreePath(h), ".git")), true);

  // 没注册的仓库没有副本可备。
  assert.equal((await h.api("POST", "/repos/999/worktree")).status, 404);
});

test("移除仓库时工作副本一并删掉", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  await h.worktreesPreparedAtLeast(1);
  assert.equal(existsSync(worktreePath(h)), true);

  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}`)).status, 204);
  assert.equal(existsSync(worktreePath(h)), false);
});
