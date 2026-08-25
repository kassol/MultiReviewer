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

/**
 * 每一轮 Review Run 在本地 clone 里留下的两条 ref(issue #161)。
 *
 * 范围审查完成后容器 PR 的两条分支被删,推进过的历次比较项在远端再无任何 ref 指向,
 * 本地副本里只剩悬空对象;git 的自动 gc 一跑,历史轮次的 diff 就再也打不开。ref 让
 * 这些 commit 保持可达。
 *
 * 命名空间自成一段:`fetch --prune` 只删 `FETCH_REFSPECS` 目标下的
 * `refs/remotes/origin/*`,碰不到 `refs/multireviewer/*`。
 */
const RUN_REF_PREFIX = "refs/multireviewer/runs";

/** 把一轮 Review Run 的两端钉在本地 clone 上。两端各一条:base 也可能悬空。 */
export async function pinRunCommits(
  worktreePath: string,
  runId: number,
  commits: { baseSha: string; headSha: string },
): Promise<void> {
  await git(worktreePath, ["update-ref", `${RUN_REF_PREFIX}/${runId}/base`, commits.baseSha]);
  await git(worktreePath, ["update-ref", `${RUN_REF_PREFIX}/${runId}/head`, commits.headSha]);
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

export type RepoReadOptions = {
  cacheDir: string;
  ref: RepoRef;
  cloneUrl: string;
  credentials: CloneCredentials;
};

/**
 * 仓库的分支名(issue #178)。commit 选择器读的就是这一份,与 Reviewer 用的是同一个
 * 本地 clone。
 *
 * 每次都先 fetch:人打开选择器是为了选刚推上去的那个 commit,拿一份旧副本给他等于
 * 选不到。fetch 前的 clone 若还不存在,`ensureClone` 一并建出来。
 *
 * `refs/remotes/origin/` 下面除了分支还有两样东西:`FETCH_REFSPECS` 取回的 pull ref
 * (`pull/<index>`)与 clone 留下的 `HEAD` 符号引用,两者都不是分支,滤掉。
 */
export async function listBranches(options: RepoReadOptions): Promise<string[]> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  await ensureClone(path, options.cloneUrl, auth);

  const output = await git(path, [
    "for-each-ref",
    "--format=%(refname:strip=3)",
    "refs/remotes/origin/",
  ]);
  return output
    .split("\n")
    .filter((name) => name !== "" && name !== "HEAD" && !name.startsWith("pull/"));
}

/** commit 选择器里的一行。短 sha 取前 7 位,与容器 PR 标题、面板各处的写法一致。 */
export type RepoCommit = {
  sha: string;
  shortSha: string;
  /** 提交信息首行。`%s` 已经把折行的主题并成一行。 */
  subject: string;
  author: string;
  authoredAt: string;
  /** 是不是 base 的后代。只在调用方给了 base 时出现(issue #179)。 */
  descendsFromBase?: boolean;
};

export type RepoCommitsOptions = RepoReadOptions & {
  branch: string;
  offset: number;
  limit: number;
  /** 推进比较项那一档给的阶段基准(issue #179);给了就为每条标出后代关系。 */
  base?: string;
};

/** 列提交的结果。两种失败都是人给的东西查不到,不是服务出错,调用方各回一句话。 */
export type BranchCommits =
  | { ok: true; commits: RepoCommit[] }
  | { ok: false; reason: "branch-unknown" | "base-unknown" };

/** 字段分隔用 unit separator,记录分隔用 `-z` 的 NUL:两者都不可能出现在提交信息里。 */
const COMMIT_FORMAT = "--format=%H%x1f%an%x1f%aI%x1f%s";

/**
 * 一条分支上的提交,新的在前,按 offset / limit 分页(issue #178)。
 *
 * 分支不存在时回 `branch-unknown`:人手上那份分支列表可能已经过时,那是常规局面,不是
 * 服务出错。这里不 fetch——选择器打开时列分支那一步刚取过,翻页再各来一次网络往返只是
 * 白等。
 *
 * 给了 `base` 就为这一页的每条标出它是不是 base 的后代(issue #179),推进比较项据此
 * 置灰。口径与推进接口的校验一致(`resolveRange`):base 自己不算后代,那个范围是空的。
 * 一条 `rev-list --ancestry-path` 一次算出整条分支上的后代集合,再逐条对照——逐条
 * `merge-base --is-ancestor` 要为一页拉起几十个 git 进程。`--ancestry-path` 是必需的:
 * `base..分支` 还会带上从 base 之前分出去、并进这条分支的旁支,那些不是 base 的后代。
 */
export async function listBranchCommits(
  options: RepoCommitsOptions,
): Promise<BranchCommits> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  // 分支名整段接在固定前缀后面,因此不会被 git 当成选项;副本还没建出来时先建。
  const ref = `refs/remotes/origin/${options.branch}`;
  if ((await resolveCommit(path, ref)) === undefined) {
    await ensureClone(path, options.cloneUrl, auth);
    if ((await resolveCommit(path, ref)) === undefined) {
      return { ok: false, reason: "branch-unknown" };
    }
  }

  let descendants: Set<string> | undefined;
  if (options.base !== undefined) {
    const baseSha = await resolveCommit(path, options.base);
    if (baseSha === undefined) return { ok: false, reason: "base-unknown" };
    const reachable = await git(path, [
      "rev-list",
      "--ancestry-path",
      `${baseSha}..${ref}`,
    ]);
    descendants = new Set(reachable.split("\n").filter((line) => line !== ""));
  }

  const output = await git(path, [
    "log",
    "-z",
    COMMIT_FORMAT,
    `--skip=${options.offset}`,
    `--max-count=${options.limit}`,
    ref,
  ]);
  const commits = splitNul(output).map((record) => {
    const [sha, author, authoredAt, subject] = record.split("\x1f");
    return {
      sha: sha!,
      shortSha: sha!.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      authoredAt: authoredAt ?? "",
      ...(descendants === undefined ? {} : { descendsFromBase: descendants.has(sha!) }),
    };
  });
  return { ok: true, commits };
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

/**
 * Review Range 里的一个文件。二进制文件在 git 的 numstat 里是两个 `-`,增删行数按 0
 * 记并单独标出——面板要显示的是「这个文件没有可读的行改动」,不是「零处改动」。
 */
export type RangeDiffFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
};

export type RangeDiffOptions = {
  cacheDir: string;
  ref: RepoRef;
  cloneUrl: string;
  credentials: CloneCredentials;
  /** Review Range 的起点。范围审查取阶段基准,PR 取那个 pull request 的 base。 */
  baseSha: string;
  headSha: string;
};

/**
 * 取 diff 之前的失败按原因分档。两端解析不出来是常规局面——分支删了、仓库被强推过,
 * 那个 commit 就是不在了,调用方据此回一句人看得懂的话,而不是把它当成服务出错。
 */
export type RangeDiffRejection = { ok: false; reason: "base-missing" | "head-missing" | "no-merge-base" };

/**
 * 解析好的 Review Range:本地副本的位置与范围的两端。一轮 Review Run 的两端是定的,
 * 文件列表与逐文件 patch 因此都从同一份它上面取,解析只做一次。
 */
export type PreparedRange = { ok: true; path: string; mergeBaseSha: string; headSha: string };

/**
 * 重命名检测一律关掉。文件列表与逐文件 patch 是两次 git 调用,而带上重命名检测之后,
 * 按单个路径取 patch 时 git 只看得到那一侧,同一个文件在列表里是「重命名」、展开却是
 * 整份新增,两处对不上。关掉之后重命名在两处都是一删一增,说的是同一件事。
 */
const NO_RENAMES = ["--no-renames"];

/**
 * 解析两端,必要时才 fetch,并算出 Review Range 的基准。
 *
 * 单独拿出来给调用方持有:一次准备要两到三个 git 子进程,而面板打开一轮详情会并发取
 * 几十个文件的 patch,每个文件重做一遍等于把同一段活干几十遍。
 */
export async function prepareRangeDiff(
  options: RangeDiffOptions,
): Promise<PreparedRange | RangeDiffRejection> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  // 先拿现有副本解析。diff 是读操作,面板按文件逐个展开会反复调它,每次都 fetch 一遍
  // 等于把每一次展开都变成一次网络往返;缺哪一端才去取。
  let base = await resolveCommit(path, options.baseSha);
  let head = await resolveCommit(path, options.headSha);
  if (base === undefined || head === undefined) {
    await ensureClone(path, options.cloneUrl, auth);
    base = await resolveCommit(path, options.baseSha);
    head = await resolveCommit(path, options.headSha);
  }
  if (base === undefined) return { ok: false, reason: "base-missing" };
  if (head === undefined) return { ok: false, reason: "head-missing" };

  try {
    const mergeBaseSha = (await git(path, ["merge-base", base, head])).trim();
    return { ok: true, path, mergeBaseSha, headSha: head };
  } catch {
    // 两端没有共同祖先:仓库被重建过,或者 head 来自一段无关历史。
    return { ok: false, reason: "no-merge-base" };
  }
}

/** `-z` 的输出用 NUL 分段,路径因此不带引号也不转义。末段的空串是收尾的那个 NUL。 */
function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** 每个文件的增删行数。二进制文件的两列是 `-`。 */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const entry of splitNul(output)) {
    const [additions, deletions, path] = entry.split("\t");
    if (additions === undefined || deletions === undefined || path === undefined) continue;
    const binary = additions === "-" || deletions === "-";
    counts.set(path, {
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }
  return counts;
}

/**
 * 一个 Review Range 改动了哪些文件。顺序就是 git 给的顺序。
 *
 * 状态与增删行数来自两次调用:`--name-status` 分得出新增与修改,`--numstat` 才有行数。
 */
export async function readRangeDiffFiles(prepared: PreparedRange): Promise<RangeDiffFile[]> {
  const range = `${prepared.mergeBaseSha}..${prepared.headSha}`;
  const [nameStatus, numstat] = await Promise.all([
    git(prepared.path, ["diff", "--name-status", ...NO_RENAMES, "-z", range]),
    git(prepared.path, ["diff", "--numstat", ...NO_RENAMES, "-z", range]),
  ]);

  const counts = parseNumstat(numstat);
  const tokens = splitNul(nameStatus);
  const files: RangeDiffFile[] = [];
  // `--name-status -z` 的每个文件占两段:状态码一段,路径一段。
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const code = tokens[index]![0];
    const path = tokens[index + 1]!;
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      ...count,
    });
  }
  return files;
}

/**
 * 一个文件在 Review Range 内的 unified diff。路径经 `--` 交给 git,以 `-` 开头的路径
 * 因此不会被当成选项;不在这个范围里的路径回空串,由调用方判断。
 */
export async function readRangeFileDiff(
  prepared: PreparedRange,
  path: string,
): Promise<string> {
  return git(prepared.path, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=3",
    "--no-color",
    ...NO_RENAMES,
    `${prepared.mergeBaseSha}..${prepared.headSha}`,
    "--",
    path,
  ]);
}
