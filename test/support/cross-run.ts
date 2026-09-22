/**
 * 跨轮次那两个测试文件的公用夹具(issue #7、#399):三个函数的真实仓库、内存 Forge、临时库,
 * 加上「把上一轮发布出去的评论当成既有评论喂回下一轮」与几样落库读回。
 *
 * 一条用例跑两到三轮 Review Run,每一轮都是真的 clone、fetch、工作树与 diff,因此每条都按
 * 秒计;拆成 `cross-run`(跨轮匹配、折叠与历史注入)与 `cross-run-disposition`(复核裁决、
 * 自动处置与延续)两个文件之后它们并行跑,壁钟由长的那一个说。断言一格未动。
 */
import type { ExistingReviewComment } from "../../src/forge/forge.ts";
import { openStore } from "../../src/review/store/index.ts";
import { testCleanups } from "./git-fixture.ts";
import { query, setup as setupRepo } from "./batch-run.ts";
import { scriptedReviewer, type MemoryForge } from "./memory-forge.ts";

export const BASE = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}

export function mul(a, b) {
  return a * b;
}
`;

export const HEAD = BASE.replace("return a - b;", "return a - b - 1;");

// Finding 指向第 6 行,指纹窗口覆盖 3..9 行。改 mul 落在窗口之外,指纹不变。
export const UNRELATED_CHANGE = HEAD.replace("return a * b;", "return a * b * 2;");
// 改的正是 Finding 指向的那一行,指纹必变。
export const SAME_LINE_CHANGE = HEAD.replace("return a - b - 1;", "return a - b - 2;");
// 改 add。第 11 行既不会被卷进 diff,它的指纹窗口(8..14 行)也不变。
export const DISTANT_CHANGE = HEAD.replace("return a + b;", "return a + b + 0;");

/** mul 的收尾行。-U3 的 hunk 只覆盖 3..9 行,它落在 diff 之外,退化进 review 正文。 */
export const OUT_OF_DIFF_LINE = 11;

export const EVENT = { owner: "acme", repo: "widgets", number: 7 };

export const FINDING = {
  file: "src/calc.js",
  line: 6,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub 多减了 1",
};

export const ANCHOR = /<!-- multireviewer:([0-9a-f]{64}) -->/;

export function setup() {
  const { repo, cache, db, forge } = setupRepo(testCleanups(), {
    tree: { base: { "src/calc.js": BASE }, head: { "src/calc.js": HEAD } },
    changedFiles: [{ path: "src/calc.js", status: "modified" }],
  });

  const deps = {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  return { repo, db, forge, deps };
}

/** 人在面板上处置的时刻。 */
export const DISPOSED_AT = "2026-08-25T00:00:00.000Z";

/**
 * 把上一轮真的发布出去的行级评论,连 Forge 给的评论 id 一起当成既有评论喂给下一轮。
 *
 * 评论 id 是 Finding Identity 的键(`store.identityKey`,ADR 0030):处置、折叠与回填
 * 都落在它上面,喂回去的必须是落库的那一个。真实 Forge 读回的也正是它。
 */
export function asPublished(forge: MemoryForge, resolved: boolean): ExistingReviewComment[] {
  return forge.publishedComments.map((comment) => ({ ...comment, resolved }));
}

/** 落库的处置人与处置时刻,按落库顺序。 */
export function dispositionMarks(dbPath: string): { by: unknown; at: unknown }[] {
  return query(dbPath, "SELECT disposed_by, disposed_at FROM finding ORDER BY id").map(
    (row) => ({ by: row["disposed_by"], at: row["disposed_at"] }),
  );
}

/** 人在面板上处置一条 Finding:落库这一步与面板 API 走同一段代码。 */
export async function disposeInPanel(
  dbPath: string,
  commentId: string,
  disposition: "resolved" | "unresolved",
  note?: string,
): Promise<void> {
  const store = openStore(dbPath);
  try {
    await store.recordDisposition({
      owner: EVENT.owner,
      repo: EVENT.repo,
      commentId,
      disposition,
      disposedBy: "kassol",
      disposedAt: DISPOSED_AT,
      ...(note === undefined ? {} : { note }),
    });
  } finally {
    await store.close();
  }
}

/** 本轮落库的 disposition。第二次 Review Run 的记录 id 更大。 */
export function latestDispositions(dbPath: string): string[] {
  return query(dbPath, "SELECT disposition FROM finding ORDER BY id").map(
    (row) => String(row["disposition"]),
  );
}

/** 本轮什么都不报、也不给复核结论的 Reviewer。 */
export const SILENT = [scriptedReviewer("model-a", [])];
