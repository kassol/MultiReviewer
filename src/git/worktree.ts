import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { CloneCredentials, RepoRef } from "../forge/forge.ts";

const execFileAsync = promisify(execFile);

/** git 输出可能很大(整份 diff),放宽默认的 1MB 上限。 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 来自 fork 的 pull request,其 head commit 不在 base 仓库的任何分支上,
 * 只能经 pull ref 取得。Gitea 与 GitHub 都把它放在 `refs/pull/{index}/head`。
 */
const FETCH_REFSPECS = [
  "+refs/heads/*:refs/remotes/origin/*",
  "+refs/pull/*/head:refs/remotes/origin/pull/*",
];

async function git(cwd: string | undefined, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/**
 * 凭据以 per-invocation 的 `http.extraHeader` 传入,不写进 remote URL。
 * 写进 URL 会把令牌明文留在缓存目录的 `.git/config` 里,并且在令牌轮换后失效。
 *
 * 代价是令牌出现在 git 进程的命令行上,同主机的其他进程可见。Reviewer 与编排层
 * 都在服务自己的容器内,该暴露面等价于服务本身被攻陷。
 */
function authArgs(cloneUrl: string, credentials: CloneCredentials): string[] {
  if (!cloneUrl.startsWith("http://") && !cloneUrl.startsWith("https://")) {
    return [];
  }
  const basic = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

function repoCachePath(cacheDir: string, ref: RepoRef): string {
  // 分两级目录。owner 与 repo 都可以含下划线,用分隔符拼成单段会让
  // `a_b/c` 与 `a/b_c` 撞进同一个缓存。
  return join(cacheDir, ref.owner, ref.repo);
}

export type PrepareWorktreeOptions = {
  cacheDir: string;
  ref: RepoRef;
  cloneUrl: string;
  credentials: CloneCredentials;
  headSha: string;
  baseSha: string;
};

export type Worktree = {
  path: string;
  /** Review Range 的基准:base 与 head 的 merge-base。 */
  mergeBaseSha: string;
};

/** 首次 clone,之后增量 fetch。缓存目录里因此总有一份能解析到目标 commit 的副本。 */
async function ensureClone(
  path: string,
  cloneUrl: string,
  auth: readonly string[],
): Promise<void> {
  if (!existsSync(join(path, ".git"))) {
    await mkdir(dirname(path), { recursive: true });
    await git(undefined, [...auth, "clone", "--quiet", cloneUrl, path]);
  }

  // clone 不会带上 pull ref,首次也要 fetch 一次。
  await git(path, [...auth, "fetch", "--prune", "--quiet", "origin", ...FETCH_REFSPECS]);
}

/**
 * 按仓库缓存工作副本:首次 clone,之后增量 fetch,再 checkout 到 head commit。
 */
export async function prepareWorktree(
  options: PrepareWorktreeOptions,
): Promise<Worktree> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  await ensureClone(path, options.cloneUrl, auth);

  // 分离头指针:工作副本没有本地分支要维护,checkout 目标始终是一个 commit。
  await git(path, ["checkout", "--quiet", "--force", "--detach", options.headSha]);
  await git(path, ["clean", "-qfdx"]);

  const mergeBaseSha = (
    await git(path, ["merge-base", options.baseSha, options.headSha])
  ).trim();

  return { path, mergeBaseSha };
}

export type PushBranchOptions = {
  cacheDir: string;
  ref: RepoRef;
  cloneUrl: string;
  credentials: CloneCredentials;
  /** 要推的分支名,不带 `refs/heads/` 前缀。 */
  branch: string;
  /** 分支推完之后指向的 commit。 */
  sha: string;
};

/**
 * 把一条分支推到指定的 commit。
 *
 * Gitea 没有「把分支指到某个 sha」的 API,`git push` 是正规途径(ADR 0012)。用的是
 * 与 Reviewer 同一份缓存工作副本,因此不额外 clone 一次。
 *
 * `--force`:比较项只要求是 base 的后代,不要求是上一个比较项的后代,作者 rebase 之后
 * 新的比较项对旧的就是非快进,不带它这一推会被拒。
 */
export async function pushBranch(options: PushBranchOptions): Promise<void> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  await ensureClone(path, options.cloneUrl, auth);
  await git(path, [
    ...auth,
    "push",
    "--force",
    "--quiet",
    "origin",
    `${options.sha}:refs/heads/${options.branch}`,
  ]);
}

export type ResolveRangeOptions = {
  cacheDir: string;
  ref: RepoRef;
  cloneUrl: string;
  credentials: CloneCredentials;
  /** 阶段基准的 revision,由人在面板填。 */
  base: string;
  /** 比较项的 revision,由人在面板填。 */
  comparison: string;
};

/**
 * 范围审查两端的解析结果。失败按原因分档,调用方据此告诉人是哪一个填错了。
 */
export type ResolvedRange =
  | { ok: true; baseSha: string; comparisonSha: string }
  | { ok: false; reason: "base-unknown" | "comparison-unknown" | "not-descendant" };

/** `git rev-parse` 解析不出来的 revision 不是异常,是人填错了,回 undefined。 */
async function resolveCommit(path: string, revision: string): Promise<string | undefined> {
  try {
    // `^{commit}` 让标签与树对象都归到 commit 上;`--quiet` 让失败只体现在退出码上。
    return (
      await git(path, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])
    ).trim();
  } catch {
    return undefined;
  }
}

/**
 * 在本地 clone 上解析范围审查的两端,并判断比较项是不是 base 的后代(ADR 0012)。
 *
 * Gitea 的 compare 端点只给 commit 列表,判不了任意两个 commit 的祖先关系;本地
 * clone 是 Reviewer 已经在用的那一份,`git merge-base --is-ancestor` 是正规途径。
 *
 * 两端相同也判不通过:那个范围是空的,而 Gitea 的建 PR 端点本来就拒收 head 与 base
 * 指向同一个 commit 的请求,让人在面板上当场知道比事后收到一句 Forge 报错好。
 */
export async function resolveRange(options: ResolveRangeOptions): Promise<ResolvedRange> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  await ensureClone(path, options.cloneUrl, auth);

  const baseSha = await resolveCommit(path, options.base);
  if (baseSha === undefined) return { ok: false, reason: "base-unknown" };
  const comparisonSha = await resolveCommit(path, options.comparison);
  if (comparisonSha === undefined) return { ok: false, reason: "comparison-unknown" };
  if (baseSha === comparisonSha) return { ok: false, reason: "not-descendant" };

  try {
    // 不是祖先时退出码为 1,promisify 过的 execFile 因此抛。
    await git(path, ["merge-base", "--is-ancestor", baseSha, comparisonSha]);
  } catch {
    return { ok: false, reason: "not-descendant" };
  }
  return { ok: true, baseSha, comparisonSha };
}

/** 取 Review Range 的合并 diff。基准是 merge-base,与两个平台 PR 页面显示的一致。 */
export async function readRangeDiff(
  worktreePath: string,
  mergeBaseSha: string,
  headSha: string,
): Promise<string> {
  return git(worktreePath, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=3",
    "--no-color",
    `${mergeBaseSha}..${headSha}`,
  ]);
}
