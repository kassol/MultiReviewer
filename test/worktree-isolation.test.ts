/**
 * 同一个仓库上并发的四类参与者各读各的那一份代码(issue #212)。
 *
 * 验的是外部看得见的东西:各自目录里的文件内容、目录在不在、以及 git 自己给出的答案。
 * 缓存 clone 只留对象与 refs,一次性工作树从它派生、用完即删。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  pinRunCommits,
  prepareWorktree,
  removeWorktree,
  repoCachePath,
  type Worktree,
} from "../src/git/worktree.ts";
import { makeCacheDir, makeRepo } from "./support/git-fixture.ts";

const REF = { owner: "acme", repo: "widgets" };
const BASE_CALC = "export const answer = 1;\n";
const HEAD_CALC = "export const answer = 2;\n";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function setup() {
  const repo = makeRepo({ base: { "src/calc.ts": BASE_CALC }, head: { "src/calc.ts": HEAD_CALC } });
  const cache = makeCacheDir();
  cleanups.push(repo.cleanup, cache.cleanup);
  return { repo, cache };
}

function prepare(cacheDir: string, cloneUrl: string, sha: string): Promise<Worktree> {
  return prepareWorktree({
    cacheDir,
    ref: REF,
    cloneUrl,
    credentials: { username: "bot", password: "unused-for-local-clone" },
    headSha: sha,
    baseSha: sha,
  });
}

function readCalc(worktree: Worktree): string {
  return readFileSync(join(worktree.path, "src/calc.ts"), "utf8");
}

test("并发的两次准备各拿到自己那个 commit 的文件,互不干扰", async () => {
  const { repo, cache } = setup();

  const [older, newer] = await Promise.all([
    prepare(cache.dir, repo.dir, repo.mergeBaseSha),
    prepare(cache.dir, repo.dir, repo.headSha),
  ]);

  assert.notEqual(older.path, newer.path, "两次准备落在同一个目录上");
  // 两份都在磁盘上时再读:后一次准备没有把前一次正在读的文件换掉。
  assert.equal(readCalc(older), BASE_CALC);
  assert.equal(readCalc(newer), HEAD_CALC);

  await older.release();
  // 一次释放不影响另一份还在读的。
  assert.equal(existsSync(older.path), false);
  assert.equal(readCalc(newer), HEAD_CALC);

  await newer.release();
  assert.equal(existsSync(newer.path), false);
});

test("释放之后缓存 clone 还在,下一次准备照样派生得出来", async () => {
  const { repo, cache } = setup();

  const first = await prepare(cache.dir, repo.dir, repo.headSha);
  await first.release();

  assert.equal(existsSync(join(repoCachePath(cache.dir, REF), ".git")), true);

  const second = await prepare(cache.dir, repo.dir, repo.mergeBaseSha);
  assert.equal(readCalc(second), BASE_CALC);
  await second.release();
});

test("一次性工作树上写的轮次 ref,别的工作树与缓存 clone 都读得到", async () => {
  const { repo, cache } = setup();
  const clone = repoCachePath(cache.dir, REF);

  const first = await prepare(cache.dir, repo.dir, repo.headSha);
  await pinRunCommits(first.path, 7, { baseSha: repo.mergeBaseSha, headSha: repo.headSha });
  await first.release();

  const revParse = (cwd: string, revision: string): string =>
    execFileSync("git", ["-C", cwd, "rev-parse", revision], { encoding: "utf8" }).trim();

  assert.equal(revParse(clone, "refs/multireviewer/runs/7/head"), repo.headSha);
  assert.equal(revParse(clone, "refs/multireviewer/runs/7/base"), repo.mergeBaseSha);

  const second = await prepare(cache.dir, repo.dir, repo.mergeBaseSha);
  assert.equal(revParse(second.path, "refs/multireviewer/runs/7/head"), repo.headSha);
  await second.release();
});

test("进程被杀留下的一次性工作树,由下一次准备清掉", async () => {
  const { repo, cache } = setup();
  const clone = repoCachePath(cache.dir, REF);

  const first = await prepare(cache.dir, repo.dir, repo.headSha);
  const checkouts = dirname(first.path);
  await first.release();

  // 上一次进程被杀留下的样子:目录还在,git 里的登记也还在。
  const stale = join(checkouts, "stale");
  execFileSync("git", ["-C", clone, "worktree", "add", "--quiet", "--detach", stale, repo.headSha]);
  assert.equal(existsSync(stale), true);

  const next = await prepare(cache.dir, repo.dir, repo.headSha);

  assert.equal(existsSync(stale), false);
  assert.equal(
    execFileSync("git", ["-C", clone, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .includes(stale),
    false,
    "git 里还留着指向它的登记",
  );
  assert.equal(readCalc(next), HEAD_CALC);
  await next.release();
});

test("这个仓库上还有工作树在用时不清扫,并发那一次的登记因此保得住", async () => {
  const { repo, cache } = setup();
  const clone = repoCachePath(cache.dir, REF);

  const live = await prepare(cache.dir, repo.dir, repo.headSha);
  // 上一次进程留下的样子。它在这里只作探针:清扫跑没跑,看它还在不在。
  const stale = join(dirname(live.path), "stale");
  execFileSync("git", ["-C", clone, "worktree", "add", "--quiet", "--detach", stale, repo.headSha]);

  // 还有一份在用时的那一次准备:残留原样留着,`worktree prune` 一次也没跑——跑了就会
  // 把另一次 add 刚登记、目录还没建出来的那一份一起丢掉。
  const concurrent = await prepare(cache.dir, repo.dir, repo.mergeBaseSha);
  assert.equal(existsSync(stale), true, "还有工作树在用时就清扫了");
  assert.equal(readCalc(concurrent), BASE_CALC);
  assert.equal(readCalc(live), HEAD_CALC);

  await live.release();
  await concurrent.release();

  // 安静下来之后的那一次照旧清掉它。
  const next = await prepare(cache.dir, repo.dir, repo.headSha);
  assert.equal(existsSync(stale), false);
  await next.release();
});

test("移除仓库时缓存 clone 与派生出去的工作树一起删掉", async () => {
  const { repo, cache } = setup();

  const worktree = await prepare(cache.dir, repo.dir, repo.headSha);
  const checkouts = dirname(worktree.path);

  await removeWorktree(cache.dir, REF);

  assert.equal(existsSync(repoCachePath(cache.dir, REF)), false);
  assert.equal(existsSync(checkouts), false);
});
