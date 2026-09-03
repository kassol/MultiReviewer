import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
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
  "+refs/tags/*:refs/tags/*",
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

/**
 * 一个仓库的缓存副本目录。按 revision 读历史(如补录行作者)时要它,而那些调用不
 * 备副本、只用已经在磁盘上的那一份,因此这里只拼路径、不保证目录存在。
 */
export function repoCachePath(cacheDir: string, ref: RepoRef): string {
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
  /** 读完就调,把这份一次性工作树删掉。删不掉不抛,由下一次准备的清扫兜住。 */
  release(): Promise<void>;
};

/**
 * 一次性工作树的存放处:`<缓存根>/.checkouts/<owner>/<repo>/<随机>`(issue #212)。
 *
 * 与缓存 clone 同在缓存根下,清缓存目录与移除仓库都一并带走它。单开一段 `.checkouts`
 * 而不是塞进 clone 里:owner 名不以点开头,这一段因此撞不上任何仓库的缓存路径,也不会
 * 在 clone 的工作区里留下未跟踪的目录。
 */
function checkoutsPath(cacheDir: string, ref: RepoRef): string {
  return join(cacheDir, ".checkouts", ref.owner, ref.repo);
}

/**
 * 本进程还在用的一次性工作树。
 *
 * 进程被杀时 `release` 跑不到,目录与 git 的登记都会留下来。留下的那些必然不在这个集合
 * 里——本进程从未开过它们,因此在这个仓库上没有并发参与者的那一次准备可以放心清掉。
 */
const liveCheckouts = new Set<string>();

/**
 * 清掉上一次进程留下的一次性工作树。
 *
 * 这个仓库上本进程还有工作树在用、或有一次 `worktree add` 正跑着时整段跳过。`worktree
 * prune` 只看目录在不在:另一次 add 已经登记、目录还没建出来的那半拍里跑 prune 会把它的
 * 登记丢掉,那份工作树随后就用不了了。路径先记进 `liveCheckouts` 再建目录,判据因此也覆
 * 盖得到正在建的那一份。残留留到这个仓库安静下来的下一次准备再清。
 */
async function sweepCheckouts(clonePath: string, root: string): Promise<void> {
  for (const dir of liveCheckouts) if (dirname(dir) === root) return;
  const leaked = await readdir(root).catch(() => [] as string[]);
  if (leaked.length === 0) return;
  for (const name of leaked) await rm(join(root, name), { recursive: true, force: true });
  // 目录先删,再让 git 把指向它们的登记一起丢掉。
  await git(clonePath, ["worktree", "prune"]);
}

/**
 * 每个副本目录上排在最后的那一次准备(issue #184)。
 *
 * 两次并发的准备打到同一个目录会互相踩:后一次的 clone 看到目录已被前一次占着,当场
 * 失败。注册后的后台准备与紧接着到来的一次投递正是这个局面,而两者都要的只是「这个
 * 目录里有一份能解析到目标 commit 的副本」。
 */
const preparingClones = new Map<string, Promise<void>>();

/** 首次 clone,之后增量 fetch。缓存目录里因此总有一份能解析到目标 commit 的副本。 */
async function cloneOrFetch(
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
 * 备好副本,同一个目录上一次只跑一个。排队而不是跟着前一次的结果走:前一次失败不代表
 * 这一次也会失败,而它成功之后这一次的 fetch 只是一次快的空转。
 */
async function ensureClone(
  path: string,
  cloneUrl: string,
  auth: readonly string[],
): Promise<void> {
  const previous = preparingClones.get(path) ?? Promise.resolve();
  const mine = previous.catch(() => {}).then(() => cloneOrFetch(path, cloneUrl, auth));
  preparingClones.set(path, mine);
  try {
    await mine;
  } finally {
    // 后面已经排上新的一次时留着它,那才是「最后一次」。
    if (preparingClones.get(path) === mine) preparingClones.delete(path);
  }
}

/**
 * 备好一份读得到 head commit 的工作副本:缓存 clone 首次 clone、之后增量 fetch,再从它
 * 派生一份只属于这次调用的工作树(issue #212)。
 *
 * 缓存 clone 自己不再被 checkout。同一个仓库上并发的参与者有四类——两条 Review Run、
 * 基点重探索与处置反哺,它们停在各自的 commit 上,共用一份 checkout 就会互相踩:正在读
 * 文件的 agent 读到另一次 checkout 的内容,Finding 的行号与 snippet 就锚错了地方。
 *
 * 对象库与 refs 仍是 clone 那一份:`refs/multireviewer/runs/*` 在哪个工作树上写、读都是
 * 同一条(issue #161)。
 */
export async function prepareWorktree(
  options: PrepareWorktreeOptions,
): Promise<Worktree> {
  const clonePath = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  await ensureClone(clonePath, options.cloneUrl, auth);

  const mergeBaseSha = (
    await git(clonePath, ["merge-base", options.baseSha, options.headSha])
  ).trim();

  const root = checkoutsPath(options.cacheDir, options.ref);
  await sweepCheckouts(clonePath, root);
  const path = join(root, randomUUID());
  // 先记再建:并发的那一次清扫据此认得出这份正在建的工作树。
  liveCheckouts.add(path);
  try {
    await mkdir(root, { recursive: true });
    // 分离头指针:一次性工作树没有本地分支要维护,目标始终是一个 commit。
    await git(clonePath, ["worktree", "add", "--quiet", "--detach", path, options.headSha]);
  } catch (error) {
    liveCheckouts.delete(path);
    await rm(path, { recursive: true, force: true });
    throw error;
  }

  return {
    path,
    mergeBaseSha,
    release: async () => {
      liveCheckouts.delete(path);
      // 删不掉不抛:调用方此刻已经读完了,残留由下一次准备的清扫兜住。
      await git(clonePath, ["worktree", "remove", "--force", path]).catch(() => {});
    },
  };
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

/** 一行代码的行作者(CONTEXT.md):最后改动它的那个 git author 与那次提交。 */
export type LineAuthor = {
  /** 那次提交的完整 sha。 */
  sha: string;
  /** git author 的姓名,原样。 */
  name: string;
  /** git author 的邮箱,原样。 */
  email: string;
  /** authored 时间,ISO 字符串。 */
  authoredAt: string;
};

/** porcelain 每组的头一行:`<40 位 sha> <原文件行号> <本次结果里的行号> [<行数>]`。 */
const BLAME_GROUP_HEADER = /^([0-9a-f]{40}) \d+ (\d+)/;

/**
 * 解析 `git blame --porcelain` 的输出。
 *
 * 同一个提交第二次出现时只有头一行,姓名、邮箱与时间不再重复,因此按 sha 记住已经
 * 读到的那份。每组以一行制表符开头的原文收尾,读到它就把这一行的结果定下来。
 */
function parseLineAuthors(output: string): Map<number, LineAuthor> {
  const authors = new Map<number, LineAuthor>();
  const commits = new Map<string, { name?: string; email?: string; time?: number }>();
  let sha: string | undefined;
  let line: number | undefined;
  for (const row of output.split("\n")) {
    const header = BLAME_GROUP_HEADER.exec(row);
    if (header !== null) {
      sha = header[1]!;
      line = Number(header[2]);
      continue;
    }
    if (sha === undefined || line === undefined) continue;
    const commit = commits.get(sha) ?? {};
    commits.set(sha, commit);
    if (row.startsWith("author ")) commit.name = row.slice("author ".length);
    else if (row.startsWith("author-mail ")) {
      commit.email = row.slice("author-mail ".length).replace(/^<|>$/g, "");
    } else if (row.startsWith("author-time ")) {
      commit.time = Number(row.slice("author-time ".length));
    } else if (row.startsWith("\t")) {
      if (commit.name !== undefined && commit.email !== undefined && commit.time !== undefined) {
        authors.set(line, {
          sha,
          name: commit.name,
          email: commit.email,
          authoredAt: new Date(commit.time * 1000).toISOString(),
        });
      }
    }
  }
  return authors;
}

/**
 * 判定一个文件里若干行在指定 revision 上的行作者,回「行号 → 行作者」。
 *
 * 一个文件一次调用,多条行号合成多段 `-L`:逐行起一个 git 进程的话,一轮几十条
 * Finding 就是几十次进程启动,而它们问的是同一个文件同一个 revision。
 *
 * 按 revision 判定,不依赖工作副本此刻 checkout 在哪个 commit:历史轮次的 head 由
 * `pinRunCommits` 钉住(issue #161),仍然可达。取的是 author 而非 committer——
 * cherry-pick 与 rebase 会把 committer 换成做这次操作的人,写下这一行的仍是 author。
 *
 * 行号越界、文件在该 revision 上不存在、revision 不可达都由 git 报错,调用方按需捕获。
 */
export async function readLineAuthors(
  worktreePath: string,
  revision: string,
  file: string,
  lines: readonly number[],
): Promise<Map<number, LineAuthor>> {
  const ranges = [...new Set(lines)].flatMap((line) => ["-L", `${line},${line}`]);
  const output = await git(worktreePath, [
    "blame",
    "--porcelain",
    ...ranges,
    revision,
    "--",
    file,
  ]);
  return parseLineAuthors(output);
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
export async function listBranches(
  options: RepoReadOptions,
  refresh = true,
): Promise<string[]> {
  const path = repoCachePath(options.cacheDir, options.ref);
  const auth = authArgs(options.cloneUrl, options.credentials);

  if (refresh || !existsSync(join(path, ".git"))) {
    await ensureClone(path, options.cloneUrl, auth);
  }

  const output = await git(path, [
    "for-each-ref",
    "--format=%(refname:strip=3)",
    "refs/remotes/origin/",
  ]);
  return output
    .split("\n")
    .filter((name) => name !== "" && name !== "HEAD" && !name.startsWith("pull/"));
}

/**
 * 备好仓库的工作副本:不在就 clone,已在只 fetch(issue #184)。
 *
 * 仓库注册之后由后台任务调它,之后的 Review Run、diff、分支列表与提交列表都落在这份
 * 已经存在的副本上,人不再为一次 clone 等待。
 */
export async function ensureWorktree(options: RepoReadOptions): Promise<void> {
  await ensureClone(
    repoCachePath(options.cacheDir, options.ref),
    options.cloneUrl,
    authArgs(options.cloneUrl, options.credentials),
  );
}

/**
 * 删掉仓库的工作副本(issue #184)。已经不在即当作已删:两者是同一个终态。
 *
 * 这个目录上还有准备在跑时先等它跑完——不论是注册后的后台准备还是一次投递触发的
 * clone,边删边 clone 会让删除撞上刚写出来的文件。等的是 `ensureClone` 那份排队,
 * 全部调用方都从那里过。
 */
export async function removeWorktree(cacheDir: string, ref: RepoRef): Promise<void> {
  const path = repoCachePath(cacheDir, ref);
  await preparingClones.get(path)?.catch(() => {});
  await rm(path, { recursive: true, force: true });
  // 派生出去的一次性工作树在另一段目录下,跟着一起删:它们的对象库刚被删掉,留着是空壳。
  await rm(checkoutsPath(cacheDir, ref), { recursive: true, force: true });
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
  /** 搜索只命中提交信息正文时，回显第一处命中附近的片段。 */
  messageMatchExcerpt?: string;
};

type PickerFilterOptions = {
  query?: string;
  authoredFrom?: number;
  authoredTo?: number;
  merge?: "all" | "only" | "non";
  legalOnly?: boolean;
};

export type RepoCommitsOptions = RepoReadOptions & {
  branch: string;
  offset: number;
  limit: number;
  /** 增量评审那一档给的阶段基准(issue #179);给了就为每条标出后代关系。 */
  base?: string;
  /**
   * 增量评审那一档给的当前比较项(issue #234)。给了就把 `legalOnly` 的口径从「base 的
   * 后代」换成「当前比较项之后」,当前比较项自己也在集合里,它是这段的边界。
   */
  after?: string;
} & PickerFilterOptions;

/** 列提交的结果。三种失败都是人给的东西查不到,不是服务出错,调用方各回一句话。 */
export type BranchCommits =
  | { ok: true; commits: RepoCommit[] }
  | { ok: false; reason: "branch-unknown" | "base-unknown" | "after-unknown" };

/**
 * 筛选用的内部提交形状。完整信息、邮箱与父提交只参与匹配，不直接放进面板响应。
 */
type CommitRecord = RepoCommit & {
  authorEmail: string;
  message: string;
  parentCount: number;
};

/** 字段用 NUL 分隔。Git 对象禁止 NUL，但允许其余控制字符。 */
const COMMIT_FORMAT = "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%B%x00";
const COMMIT_FIELD_COUNT = 7;

/**
 * pretty format 与 for-each-ref 会在每条格式化记录后补一个换行。字段数固定，因此按
 * NUL 切开后逐组读取；不能拿双 NUL 当记录边界，空 parents 等字段本身就会产生双 NUL。
 * 只去掉每组首字段前由 Git 补的换行，提交或 Tag 消息里的换行原样保留。
 */
function fixedNulRecords(output: string, fieldCount: number): string[][] {
  const fields = output.split("\0");
  const records: string[][] = [];
  for (let index = 0; index + fieldCount <= fields.length; index += fieldCount) {
    const record = fields.slice(index, index + fieldCount);
    record[0] = record[0]!.replace(/^\n/, "");
    if (record[0] === "") break;
    records.push(record);
  }
  return records;
}

function parseCommitRecord(record: readonly string[]): CommitRecord {
  const [sha, author, authorEmail, authoredAt, parents, subject, message] = record;
  return {
    sha: sha!,
    shortSha: sha!.slice(0, 7),
    subject: subject ?? "",
    author: author ?? "",
    authoredAt: authoredAt ?? "",
    authorEmail: authorEmail ?? "",
    message: message ?? "",
    parentCount: (parents ?? "").split(" ").filter((parent) => parent !== "").length,
  };
}

function pickerTerms(query: string | undefined): string[] {
  const trimmed = query?.trim() ?? "";
  return trimmed === "" ? [] : trimmed.toLocaleLowerCase().split(/\s+/);
}

function commitMatches(record: CommitRecord, terms: readonly string[]): boolean {
  const message = record.message.toLocaleLowerCase();
  const author = record.author.toLocaleLowerCase();
  const email = record.authorEmail.toLocaleLowerCase();
  const sha = record.sha.toLocaleLowerCase();
  return terms.every(
    (term) => sha.startsWith(term) || message.includes(term) || author.includes(term) || email.includes(term),
  );
}

/** 正文里第一处只能靠正文解释的命中，截成一段可读的附近文本。 */
function messageMatchExcerpt(record: CommitRecord, terms: readonly string[]): string | undefined {
  const hiddenTerms = terms.filter((term) =>
    !record.sha.toLocaleLowerCase().startsWith(term) &&
    !record.subject.toLocaleLowerCase().includes(term) &&
    !record.author.toLocaleLowerCase().includes(term) &&
    !record.authorEmail.toLocaleLowerCase().includes(term)
  );
  if (hiddenTerms.length === 0) return undefined;
  for (const raw of record.message.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (line === "") continue;
    const lower = line.toLocaleLowerCase();
    const at = hiddenTerms.reduce((first, term) => {
      const next = lower.indexOf(term);
      return next < 0 ? first : first < 0 ? next : Math.min(first, next);
    }, -1);
    if (at < 0) continue;
    if (line.length <= 180) return line;
    const start = Math.max(0, at - 60);
    const end = Math.min(line.length, start + 180);
    return `${start === 0 ? "" : "…"}${line.slice(start, end)}${end === line.length ? "" : "…"}`;
  }
  return undefined;
}

/**
 * 两个集合分工不同:`descendants` 只用来标 `descendsFromBase`,`selectable` 是
 * `legalOnly` 真正筛的那一个。没有 `after` 时它们是同一个集合;有 `after` 时筛选按
 * 「当前比较项之后」收窄,而后代标记仍按 base 算(issue #234)。
 */
function filteredCommitRows(
  records: readonly CommitRecord[],
  options: PickerFilterOptions & { offset: number; limit: number },
  descendants: ReadonlySet<string> | undefined,
  selectable: ReadonlySet<string> | undefined,
): RepoCommit[] {
  const terms = pickerTerms(options.query);
  return records
    .filter((record) => {
      if (!commitMatches(record, terms)) return false;
      const authored = Date.parse(record.authoredAt);
      if (options.authoredFrom !== undefined && authored < options.authoredFrom) return false;
      if (options.authoredTo !== undefined && authored > options.authoredTo) return false;
      if (options.merge === "only" && record.parentCount < 2) return false;
      if (options.merge === "non" && record.parentCount >= 2) return false;
      return options.legalOnly !== true || selectable?.has(record.sha) === true;
    })
    .slice(options.offset, options.offset + options.limit)
    .map((record) => {
      const excerpt = messageMatchExcerpt(record, terms);
      return {
        sha: record.sha,
        shortSha: record.shortSha,
        subject: record.subject,
        author: record.author,
        authoredAt: record.authoredAt,
        ...(descendants === undefined ? {} : { descendsFromBase: descendants.has(record.sha) }),
        ...(excerpt === undefined ? {} : { messageMatchExcerpt: excerpt }),
      };
    });
}

/**
 * 一条分支上的提交,新的在前,按 offset / limit 分页(issue #178)。
 *
 * 分支不存在时回 `branch-unknown`:人手上那份分支列表可能已经过时,那是常规局面,不是
 * 服务出错。这里不 fetch——选择器打开时列分支那一步刚取过,翻页再各来一次网络往返只是
 * 白等。
 *
 * 给了 `base` 就为这一页的每条标出它是不是 base 的后代(issue #179),增量评审据此
 * 置灰。口径与推进接口的校验一致(`resolveRange`):base 自己不算后代,那个范围是空的。
 * 一条 `rev-list --ancestry-path` 一次算出整条分支上的后代集合,再逐条对照——逐条
 * `merge-base --is-ancestor` 要为一页拉起几十个 git 进程。`--ancestry-path` 是必需的:
 * `base..分支` 还会带上从 base 之前分出去、并进这条分支的旁支,那些不是 base 的后代。
 *
 * 给了 `after` 就再算一条一样的集合(issue #234):增量评审默认只列当前比较项之后的
 * 提交,而 base 的后代里还有比当前比较项早的。当前比较项自己进这个集合,它在默认列表
 * 末端就是那条边界;它 rebase 到别处之后这条分支上一条都不剩,人取消勾选看全部。
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
  let selectable: Set<string> | undefined;
  if (options.base !== undefined) {
    const baseSha = await resolveCommit(path, options.base);
    if (baseSha === undefined) return { ok: false, reason: "base-unknown" };
    descendants = await branchDescendants(path, baseSha, ref);
    selectable = descendants;
    if (options.after !== undefined) {
      const afterSha = await resolveCommit(path, options.after);
      if (afterSha === undefined) return { ok: false, reason: "after-unknown" };
      selectable = new Set(await branchDescendants(path, afterSha, ref)).add(afterSha);
    }
  }

  // 搜索、日期、merge 与合法后代必须先组合再分页，所以一次读出这条分支的历史并按 Git
  // 原顺序筛选。没有相关性排序，翻页不会改变历史顺序。
  const output = await git(path, ["log", COMMIT_FORMAT, ref]);
  const commits = filteredCommitRows(
    fixedNulRecords(output, COMMIT_FIELD_COUNT).map(parseCommitRecord),
    options,
    descendants,
    selectable,
  );
  return { ok: true, commits };
}

/** 一条分支上 `from` 的后代。`from` 自己不在内,与 `resolveRange` 的后代口径一致。 */
async function branchDescendants(path: string, from: string, ref: string): Promise<Set<string>> {
  const reachable = await git(path, ["rev-list", "--ancestry-path", `${from}..${ref}`]);
  return new Set(reachable.split("\n").filter((line) => line !== ""));
}

/** Tag 选择器里的一行。Tag 只负责定位，`sha` 始终是递归 peel 后的 commit。 */
export type RepoTag = {
  name: string;
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  /** 只有附注 Tag 才有；轻量 Tag 的创建时间就是目标 commit 的作者时间。 */
  tagger?: string;
  taggedAt?: string;
  descendsFromBase?: boolean;
  messageMatchExcerpt?: string;
};

export type RepoTagsOptions = RepoReadOptions & {
  offset: number;
  limit: number;
  base?: string;
  /** 与 `RepoCommitsOptions.after` 同一格(issue #234)。 */
  after?: string;
} & PickerFilterOptions;

export type RepoTags =
  | { ok: true; tags: RepoTag[]; hasUsableTags: boolean }
  | { ok: false; reason: "base-unknown" | "after-unknown" };

/**
 * `for-each-ref` 的字段。常见的轻量与一层附注 Tag 一次读齐；附注 Tag 指向另一条 Tag
 * 时再单独递归 peel，那一档很少见，不为它让每条 Tag 多起一个 git 进程。
 */
const TAG_FIELDS = [
  "%(refname:strip=2)",
  "%(objecttype)",
  "%(objectname)",
  "%(*objecttype)",
  "%(*objectname)",
  "%(subject)",
  "%(*subject)",
  "%(authorname)",
  "%(*authorname)",
  "%(authoremail:trim)",
  "%(*authoremail:trim)",
  "%(authordate:iso-strict)",
  "%(*authordate:iso-strict)",
  "%(parent)",
  "%(*parent)",
  "%(contents)",
  "%(*contents)",
  "%(taggername)",
  "%(taggerdate:iso-strict)",
] as const;
const TAG_FORMAT = TAG_FIELDS.join("%00");

async function commitMetadata(path: string, revision: string): Promise<CommitRecord | undefined> {
  const sha = await resolveCommit(path, revision);
  if (sha === undefined) return undefined;
  const output = await git(path, ["show", "-s", COMMIT_FORMAT, sha]);
  const [record] = fixedNulRecords(output, COMMIT_FIELD_COUNT);
  return record === undefined ? undefined : parseCommitRecord(record);
}

/**
 * 一次取出所有 refs 下每个起点的后代，供 Tag 模式标记任意目标 commit。
 *
 * 起点收成一组走一遍(issue #234):base 与当前比较项各要一个集合,而全图那条
 * `rev-list --all --children` 跑两次就是把整个提交图读两遍。
 */
async function allDescendants(path: string, roots: readonly string[]): Promise<Set<string>[]> {
  const output = await git(path, ["rev-list", "--all", "--children"]);
  const children = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const [parent, ...next] = line.split(" ");
    if (parent !== "") children.set(parent!, next);
  }
  return roots.map((root) => {
    const descendants = new Set<string>();
    const pending = [...(children.get(root) ?? [])];
    while (pending.length > 0) {
      const sha = pending.pop()!;
      if (descendants.has(sha)) continue;
      descendants.add(sha);
      pending.push(...(children.get(sha) ?? []));
    }
    return descendants;
  });
}

/**
 * 本地 Tag 列表，按创建时间倒序。轻量 Tag 用目标 commit 的作者时间；附注 Tag 用 tagger
 * 时间。只有最终能递归 peel 成 commit 的 refs 才返回，tree/blob Tag 不出现在选择器里。
 *
 * 这里不主动 fetch：选择器打开或手动刷新时列分支那一步已同步 branches + tags；搜索、
 * 筛选和翻页只读本地 refs，不能把每次输入都变成一次网络请求。副本不存在时仍会创建。
 */
export async function listTags(options: RepoTagsOptions): Promise<RepoTags> {
  const path = repoCachePath(options.cacheDir, options.ref);
  if (!existsSync(join(path, ".git"))) {
    await ensureClone(path, options.cloneUrl, authArgs(options.cloneUrl, options.credentials));
  }

  let descendants: Set<string> | undefined;
  let selectable: Set<string> | undefined;
  if (options.base !== undefined) {
    const baseSha = await resolveCommit(path, options.base);
    if (baseSha === undefined) return { ok: false, reason: "base-unknown" };
    let afterSha: string | undefined;
    if (options.after !== undefined) {
      afterSha = await resolveCommit(path, options.after);
      if (afterSha === undefined) return { ok: false, reason: "after-unknown" };
    }
    const [ofBase, ofAfter] = await allDescendants(
      path,
      afterSha === undefined ? [baseSha] : [baseSha, afterSha],
    );
    descendants = ofBase!;
    // 当前比较项自己是这段的边界,与分支模式同一口径(issue #234)。
    selectable = ofAfter === undefined ? ofBase : new Set(ofAfter).add(afterSha!);
  }

  const output = await git(path, [
    "for-each-ref",
    "--sort=-refname",
    "--sort=-creatordate",
    `--format=${TAG_FORMAT}%00`,
    "refs/tags/",
  ]);
  const records = fixedNulRecords(output, TAG_FIELDS.length);
  const tags: Array<{ row: RepoTag; commit: CommitRecord; createdAt: string }> = [];
  for (const record of records) {
    const [
      name,
      objectType,
      objectSha,
      peeledType,
      peeledSha,
      subject,
      peeledSubject,
      author,
      peeledAuthor,
      authorEmail,
      peeledAuthorEmail,
      authoredAt,
      peeledAuthoredAt,
      parents,
      peeledParents,
      message,
      peeledMessage,
      tagger,
      taggedAt,
    ] = record;

    const annotated = objectType === "tag";
    let commit: CommitRecord | undefined;
    if (objectType === "commit") {
      commit = {
        sha: objectSha!,
        shortSha: objectSha!.slice(0, 7),
        subject: subject ?? "",
        author: author ?? "",
        authoredAt: authoredAt ?? "",
        authorEmail: authorEmail ?? "",
        message: message ?? "",
        parentCount: (parents ?? "").split(" ").filter((parent) => parent !== "").length,
      };
    } else if (peeledType === "commit") {
      commit = {
        sha: peeledSha!,
        shortSha: peeledSha!.slice(0, 7),
        subject: peeledSubject ?? "",
        author: peeledAuthor ?? "",
        authoredAt: peeledAuthoredAt ?? "",
        authorEmail: peeledAuthorEmail ?? "",
        message: peeledMessage ?? "",
        parentCount: (peeledParents ?? "").split(" ").filter((parent) => parent !== "").length,
      };
    } else if (peeledType === "tag") {
      commit = await commitMetadata(path, `refs/tags/${name}`);
    }
    if (commit === undefined) continue;
    tags.push({
      commit,
      createdAt: annotated ? taggedAt ?? "" : commit.authoredAt,
      row: {
        name: name!,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        author: commit.author,
        authoredAt: commit.authoredAt,
        ...(annotated ? { tagger: tagger ?? "", taggedAt: taggedAt ?? "" } : {}),
      },
    });
  }

  const terms = pickerTerms(options.query);
  const filtered = tags
    // `for-each-ref` 的 lightweight `creatordate` 实际取 committer date；产品口径明确取目标
    // commit 的 authored time，所以在解析后按真正要展示的两个来源重排。
    .sort((left, right) => {
      const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (byTime !== 0) return byTime;
      return left.row.name < right.row.name ? 1 : left.row.name > right.row.name ? -1 : 0;
    })
    .filter(({ row, commit }) => {
      const name = row.name.toLocaleLowerCase();
      if (!terms.every((term) => name.includes(term) || commitMatches(commit, [term]))) return false;
      const authored = Date.parse(commit.authoredAt);
      if (options.authoredFrom !== undefined && authored < options.authoredFrom) return false;
      if (options.authoredTo !== undefined && authored > options.authoredTo) return false;
      if (options.merge === "only" && commit.parentCount < 2) return false;
      if (options.merge === "non" && commit.parentCount >= 2) return false;
      return options.legalOnly !== true || selectable?.has(commit.sha) === true;
    })
    .slice(options.offset, options.offset + options.limit)
    .map(({ row, commit }) => {
      const excerpt = messageMatchExcerpt(commit, terms.filter((term) => !row.name.toLocaleLowerCase().includes(term)));
      return {
        ...row,
        ...(descendants === undefined ? {} : { descendsFromBase: descendants.has(commit.sha) }),
        ...(excerpt === undefined ? {} : { messageMatchExcerpt: excerpt }),
      };
    });
  return { ok: true, tags: filtered, hasUsableTags: tags.length > 0 };
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
 * Review Range 里每条 commit 的 message 全文,新的在前(issue #201)。
 *
 * 记录之间用 NUL 隔开:提交信息本身可以含空行与任何缩进,拿换行当分隔会把一条多行
 * 信息切成几条。基准与 `readRangeDiff` 同为 merge-base,两者说的是同一个范围。
 */
export async function readRangeCommits(
  worktreePath: string,
  mergeBaseSha: string,
  headSha: string,
): Promise<string[]> {
  const output = await git(worktreePath, [
    "log",
    "--format=%B%x00",
    `${mergeBaseSha}..${headSha}`,
  ]);
  return output
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
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
