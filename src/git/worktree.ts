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

/**
 * 按仓库缓存工作副本:首次 clone,之后增量 fetch,再 checkout 到 head commit。
 */
export async function prepareWorktree(
  options: PrepareWorktreeOptions,
): Promise<Worktree> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  if (!existsSync(join(path, ".git"))) {
    await mkdir(dirname(path), { recursive: true });
    await git(undefined, [...auth, "clone", "--quiet", options.cloneUrl, path]);
  }

  // clone 不会带上 pull ref,首次也要 fetch 一次。
  await git(path, [...auth, "fetch", "--prune", "--quiet", "origin", ...FETCH_REFSPECS]);

  // 分离头指针:工作副本没有本地分支要维护,checkout 目标始终是一个 commit。
  await git(path, ["checkout", "--quiet", "--force", "--detach", options.headSha]);
  await git(path, ["clean", "-qfdx"]);

  const mergeBaseSha = (
    await git(path, ["merge-base", options.baseSha, options.headSha])
  ).trim();

  return { path, mergeBaseSha };
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
