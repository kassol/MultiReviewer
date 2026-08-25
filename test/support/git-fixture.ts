import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

export type RepoFixture = {
  /** 仓库路径,可直接作为 clone 源。 */
  dir: string;
  /** base 分支的尖端。有 baseAdvance 时它与 mergeBaseSha 不同。 */
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  /** 在 head 分支上追加一个提交,模拟 PR 作者推送新 commit。返回新的 head sha。 */
  pushToHead(tree: FileTree): string;
  cleanup(): void;
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
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

function commit(dir: string, tree: FileTree, message: string): string {
  writeTree(dir, tree);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message);
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
