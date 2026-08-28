import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openStore } from "../../src/review/store.ts";

export type FileTree = Record<string, string>;

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
    },
  }).trim();
}

function writeTree(dir: string, tree: FileTree): void {
  for (const [path, content] of Object.entries(tree)) {
    const full = join(dir, path);
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

/** 在临时目录中建一个真实仓库,形态与一个待审 pull request 一致。 */
export function makeRepo(options: RepoFixtureOptions): RepoFixture {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-repo-"));
  git(dir, "init", "--initial-branch=main", "--quiet");

  const mergeBaseSha = commit(dir, options.base, "base");

  git(dir, "checkout", "--quiet", "-b", "feature");
  const headSha = commit(dir, options.head, "head");

  git(dir, "checkout", "--quiet", "main");
  const baseSha = options.baseAdvance
    ? commit(dir, options.baseAdvance, "advance base")
    : mergeBaseSha;

  // 留在 base 分支上,使 clone 的默认分支与 head 不同,迫使实现显式 checkout。
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 建一个空的缓存根目录,供工作副本使用。 */
export function makeCacheDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-cache-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 在临时目录里指一个数据库文件的位置。文件由第一次打开时创建。 */
export function makeDbPath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-db-"));
  return {
    path: join(dir, "multireviewer.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 把仓库确认成空规则集:门禁分代(issue #206)之后新注册的仓库没有规则集版本,不做规则
 * 确认就不跑 Review Run;要审查行为的测试用它把这一步做掉。
 *
 * 走产品自己的规则确认(issue #200:空规则集是合法状态,空草案确认得了),不直写版本表
 * ——绕过产品路径播种的状态,产品路径变了测试也发现不了。仓库不在注册表里时什么都不写。
 */
export function confirmEmptyRuleSet(dbPath: string, repoId: number): void {
  const store = openStore(dbPath);
  try {
    store.confirmRuleDraft(repoId);
  } finally {
    store.close();
  }
}
