import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

import pg from "pg";

import {
  closeStorePool,
  migrateStore,
  openStore,
  type FindingRecord,
  type OutcomeRecord,
  type RunMeta,
  type Store,
  type VerdictRecord,
} from "../../src/review/store/index.ts";
import { requireTestDatabaseUrl } from "./require-database.ts";

/**
 * 本测试文件共用的清理队列。每个测试文件是一个独立进程,所以这份模块级的队列就是
 * 「本文件」的队列;`after` 钩子在模块加载时接好,整份队列在文件跑完时一次清完。
 *
 * 钩子必须挂在模块顶层:`after` 在某个用例体内调用会挂到那个用例上,清理就提前到
 * 单个用例结束时执行,而后台任务(工作副本准备等)还在写缓存目录与临时库。
 */
const fileCleanups: (() => void | Promise<void>)[] = [];

/**
 * 跑完整份收尾队列。**一条抛了也要把剩下的跑完**:队列后半截放的是关服务、关假 Gitea
 * 这些放句柄的收尾,跳过它们,监听中的 server 就留在事件循环里,用例全过而测试进程再也
 * 退不出去(0% CPU 挂住)。失败攒起来一起抛,收尾钩子照样红。
 */
export async function runCleanups(
  queue: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  // 逐个等:收尾里有异步的那几下(会话子进程退出、工作树释放与会话根删除,issue #335),
  // 不等的话进程在它们跑完之前就结束,临时目录留在 `tmpdir` 里。
  for (const cleanup of queue) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "测试收尾有失败");
}

after(() => runCleanups(fileCleanups));

/**
 * 删一个临时目录。**要重试**:后台任务(工作副本准备的 `git clone`)
 * 可能正往里写,`rmSync` 走到一半目录又多出文件就抛 ENOTEMPTY。
 */
function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * 取本测试文件共用的清理队列——调用方只管往返回的数组里 `push` 清理函数,不用各自
 * 重复声明数组与收尾循环。多次调用拿到的是同一份队列。
 */
export function testCleanups(): (() => void | Promise<void>)[] {
  return fileCleanups;
}

/**
 * 播种一轮 Review Run 的落库骨架:开跑定死「一批、一个文件、一行改动」的规模,
 * 收尾定死耗时与未失败。findings/outcomes/verdicts 已经是落库形状,拼装它们是
 * 各测试自己的事——这里只收拢 `startRun` 加 `finishRun` 那道手续。
 */
export async function seedRun(
  store: Store,
  meta: Omit<RunMeta, "changedFiles" | "changedLines" | "batchCount" | "reviewerPins">,
  findings: readonly FindingRecord[],
  outcomes: readonly OutcomeRecord[] = [],
  verdicts: readonly VerdictRecord[] = [],
): Promise<number> {
  const runId = await store.startRun({
    ...meta,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  await store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes,
    findings,
    verdicts,
  });
  return runId;
}

/** 一次提交要写的文件。值为 `null` 是删掉这个文件:重命名就是旧路径 `null` 加新路径的内容。 */
export type FileTree = Record<string, string | null>;

export type RepoFixtureOptions = {
  /** base 分支的初始提交。 */
  base: FileTree;
  /** head 分支上的提交,即 pull request 要合入的改动。 */
  head: FileTree;
  /**
   * head 分支拉出之后,base 分支上的后续提交。
   * 用于制造 base 分支尖端与 merge-base 不同的局面。
   */
  baseAdvance?: FileTree;
};

export type FixtureCommitOptions = {
  message?: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt?: string;
};

export type RepoFixture = {
  /** 仓库路径,可直接作为 clone 源。 */
  dir: string;
  /** base 分支的尖端。有 baseAdvance 时它与 mergeBaseSha 不同。 */
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  /** 在 head 分支上追加一个提交,模拟 PR 作者推送新 commit。返回新的 head sha。 */
  pushToHead(tree: FileTree): string;
  /**
   * 从指定 commit 拉出一条分支并提交一次,返回新 commit 的 sha。
   *
   * 用来制造「是 base 的后代、不是上一个比较项的后代」那种旁支,即作者 rebase 之后的
   * 比较项。必须落在一条分支上:工作副本按 `refs/heads/*` 取回,游离的 commit 取不到。
   */
  branchFrom(branch: string, startSha: string, tree: FileTree): string;
  /** 在已有分支上追加一条可定制提交信息、作者和作者时间的 commit。 */
  commitToBranch(branch: string, tree: FileTree, options?: FixtureCommitOptions): string;
  /** 把 source 分支以 merge commit 合进 target，返回 merge commit。 */
  mergeInto(target: string, source: string, message?: string): string;
  /** 这条分支指向的 commit;分支不存在时返回 undefined。 */
  branchSha(branch: string): string | undefined;
  /** 建一条分支或把它移到指定 commit。 */
  setBranch(branch: string, sha: string): void;
  /** 删一条分支。不存在即当作已经删掉——两者是同一个终态。 */
  deleteBranch(branch: string): void;
  /** 建一条轻量 Tag，已存在时移动到新的 commit。 */
  setLightweightTag(name: string, sha: string): void;
  /** 建一条附注 Tag，已存在时移动到新的 commit。 */
  setAnnotatedTag(name: string, sha: string, message?: string): void;
  /** 删除 Tag。不存在即当作已经删掉。 */
  deleteTag(name: string): void;
  cleanup(): void;
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    // stderr 也收进来:读一条不存在的分支是常规问句,它的报错不该刷在测试输出里。
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      // 关掉 commit 之后那个脱离父进程的自动维护(issue #401):它在 `.git/objects` 里放一个
      // 转眼就删的文件,负载高时 `makeRepo` 复制模板正好读到它,`cpSync` 报 ENOENT。
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
    },
  }).trim();
}

function writeTree(dir: string, tree: FileTree): void {
  for (const [path, content] of Object.entries(tree)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function commit(
  dir: string,
  tree: FileTree,
  message: string,
  options: FixtureCommitOptions = {},
): string {
  writeTree(dir, tree);
  git(dir, "add", "-A");
  git(
    dir,
    "commit",
    "-m",
    options.message ?? message,
    ...(options.authorName === undefined && options.authorEmail === undefined
      ? []
      : [
          "--author",
          `${options.authorName ?? "fixture"} <${options.authorEmail ?? "fixture@example.invalid"}>`,
        ]),
    ...(options.authoredAt === undefined ? [] : ["--date", options.authoredAt]),
  );
  return git(dir, "rev-parse", "HEAD");
}

/** 已经建好的仓库模板,按选项一份。`dir` 只用来复制,不交给调用方。 */
type RepoTemplate = { dir: string; baseSha: string; headSha: string; mergeBaseSha: string };

/**
 * 本文件建过的仓库模板(issue #400)。
 *
 * 建一个夹具仓库要十来个 git 子进程、约 195 毫秒,而一个测试文件里每条用例都建一个,
 * 选项还常常一字不差。同一份选项只建一次,之后每次调用从模板复制一份目录(约 8 毫秒)。
 */
const repoTemplates = new Map<string, RepoTemplate>();

/** 建一份模板仓库。它不返回给调用方,因此不会被任何用例写到。 */
function buildRepoTemplate(options: RepoFixtureOptions): RepoTemplate {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-repo-template-"));
  fileCleanups.push(() => removeTempDir(dir));
  git(dir, "init", "--initial-branch=main", "--quiet");

  const mergeBaseSha = commit(dir, options.base, "base");

  git(dir, "checkout", "--quiet", "-b", "feature");
  const headSha = commit(dir, options.head, "head");

  git(dir, "checkout", "--quiet", "main");
  const baseSha = options.baseAdvance
    ? commit(dir, options.baseAdvance, "advance base")
    : mergeBaseSha;

  // 留在 base 分支上,使 clone 的默认分支与 head 不同,迫使实现显式 checkout。
  return { dir, baseSha, headSha, mergeBaseSha };
}

/**
 * 在临时目录中建一个真实仓库,形态与一个待审 pull request 一致。
 *
 * 每次调用拿到的都是一个独立的目录:模板只是省下那十来个 git 子进程,一条用例往自己
 * 这份仓库里提交、建分支、删分支,别的用例看不见。同一份选项建出来的 commit sha 因此
 * 也在整个文件里稳定不变。
 */
export function makeRepo(options: RepoFixtureOptions): RepoFixture {
  const key = JSON.stringify(options);
  let template = repoTemplates.get(key);
  if (template === undefined) {
    template = buildRepoTemplate(options);
    repoTemplates.set(key, template);
  }
  const { baseSha, headSha, mergeBaseSha } = template;
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-repo-"));
  cpSync(template.dir, dir, { recursive: true, preserveTimestamps: true });

  return {
    dir,
    baseSha,
    headSha,
    mergeBaseSha,
    pushToHead(tree: FileTree): string {
      git(dir, "checkout", "--quiet", "feature");
      const sha = commit(dir, tree, "another head commit");
      git(dir, "checkout", "--quiet", "main");
      return sha;
    },
    branchFrom(branch: string, startSha: string, tree: FileTree): string {
      git(dir, "checkout", "--quiet", "-b", branch, startSha);
      const sha = commit(dir, tree, `commit on ${branch}`);
      git(dir, "checkout", "--quiet", "main");
      return sha;
    },
    commitToBranch(branch: string, tree: FileTree, options: FixtureCommitOptions = {}): string {
      git(dir, "checkout", "--quiet", branch);
      const sha = commit(dir, tree, `commit on ${branch}`, options);
      git(dir, "checkout", "--quiet", "main");
      return sha;
    },
    mergeInto(target: string, source: string, message = `merge ${source}`): string {
      git(dir, "checkout", "--quiet", target);
      git(dir, "merge", "--quiet", "--no-ff", source, "--message", message);
      const sha = git(dir, "rev-parse", "HEAD");
      git(dir, "checkout", "--quiet", "main");
      return sha;
    },
    branchSha(branch: string): string | undefined {
      try {
        return git(dir, "rev-parse", "--verify", `refs/heads/${branch}`);
      } catch {
        return undefined;
      }
    },
    setBranch(branch: string, sha: string): void {
      git(dir, "branch", "--force", branch, sha);
    },
    deleteBranch(branch: string): void {
      try {
        git(dir, "branch", "-D", branch);
      } catch {
        // 已经不在了。
      }
    },
    setLightweightTag(name: string, sha: string): void {
      git(dir, "tag", "--force", name, sha);
    },
    setAnnotatedTag(name: string, sha: string, message = `tag ${name}`): void {
      git(dir, "tag", "--force", "--annotate", name, sha, "--message", message);
    },
    deleteTag(name: string): void {
      try {
        git(dir, "tag", "--delete", name);
      } catch {
        // 已经不在了。
      }
    },
    cleanup: () => removeTempDir(dir),
  };
}

/**
 * 把一个仓库克隆成 bare 仓库,当作可推送的远端。
 *
 * 非 bare 仓库拒收推向它当前检出分支的推送(`denyCurrentBranch`),验证推分支要一个
 * 真正的远端。
 */
export function makeBareRemote(source: string): {
  dir: string;
  /** 远端上这条分支指向的 commit;分支不存在时返回 undefined。 */
  branchSha(branch: string): string | undefined;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-remote-"));
  execFileSync("git", ["clone", "--bare", "--quiet", source, dir]);
  return {
    dir,
    branchSha(branch: string): string | undefined {
      try {
        return git(dir, "rev-parse", "--verify", `refs/heads/${branch}`);
      } catch {
        return undefined;
      }
    },
    cleanup: () => removeTempDir(dir),
  };
}

/** 建一个空的缓存根目录,供工作副本使用。 */
export function makeCacheDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-cache-"));
  return { dir, cleanup: () => removeTempDir(dir) };
}

/**
 * 给这一次测试建一个真的 PostgreSQL 库(ADR 0036):在 `MULTIREVIEWER_TEST_DATABASE_URL`
 * 指的实例上 `CREATE DATABASE`、跑一遍迁移,收尾时关掉连接池再 `DROP DATABASE`。
 *
 * 一个库一次调用,不共用:测试之间的数据隔离靠库本身,而不是靠每个用例自己清表。
 * `dataDir` 是会话图片附件的落点(issue #336),库不再是文件之后它另占一个临时目录。
 */
// 一个测试文件会建好几个库、好几个池,几路并发跑起来就会把 PostgreSQL 的 `max_connections`
// 占满。每个测试库上同时在跑的查询本来也只有几条,把池收到 3 条连接。
process.env["MULTIREVIEWER_DB_POOL_MAX"] ??= "3";

export async function makeTestDatabase(): Promise<{
  url: string;
  dataDir: string;
  cleanup(): Promise<void>;
}> {
  const admin = requireTestDatabaseUrl();
  const name = `mr_test_${randomUUID().replaceAll("-", "")}`;
  await onAdminConnection(admin, async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
  });
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const databaseUrl = url.href;
  await migrateStore(databaseUrl);
  const dataDir = mkdtempSync(join(tmpdir(), "multireviewer-data-"));
  return {
    url: databaseUrl,
    dataDir,
    cleanup: async () => {
      // 先关连接池:还连着的库 DROP 不掉。
      await closeStorePool(databaseUrl);
      removeTempDir(dataDir);
      await onAdminConnection(admin, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      });
    },
  };
}

/** 一条直连测试库的 SQL 通道。参数用 `$1`、`$2`(PostgreSQL 的占位符),返回行数组。 */
export type TestSql = (text: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * 绕过 Store 直接读写测试库:造一份「升级前落下的」数据、或者核对某一列真的写进去了。
 * 用完即关,不进连接池——连着的库 DROP 不掉。
 */
export async function withTestDb<T>(
  databaseUrl: string,
  run: (sql: TestSql) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await run(async (text, ...params) => (await client.query(text, params)).rows);
  } finally {
    await client.end();
  }
}

async function onAdminConnection(
  admin: string,
  run: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

/**
 * 把仓库确认成空知识集:门禁分代(issue #206)之后新注册的仓库没有知识集版本,不做知识
 * 确认就不跑 Review Run;要审查行为的测试用它把这一步做掉。
 *
 * 走产品自己的知识确认(issue #200:空知识集是合法状态,空草案确认得了),不直写版本表
 * ——绕过产品路径播种的状态,产品路径变了测试也发现不了。仓库不在注册表里时什么都不写。
 */
export async function confirmEmptyRuleSet(databaseUrl: string, repoId: number): Promise<void> {
  const store = openStore(databaseUrl);
  try {
    await store.confirmRuleDraft(repoId);
  } finally {
    await store.close();
  }
}
