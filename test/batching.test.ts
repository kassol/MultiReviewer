import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { Finding, ReviewRange, Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import type { FileTree } from "./support/git-fixture.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const EVENT = { owner: "acme", repo: "widgets", number: 7 };

const STUB = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

/** base 侧是三行的桩,head 侧在末尾追加 n 行,故该文件的改动行数恰为 n。 */
function trees(sizes: Record<string, number>): { base: FileTree; head: FileTree } {
  const base: FileTree = {};
  const head: FileTree = {};
  for (const [path, n] of Object.entries(sizes)) {
    base[path] = STUB;
    head[path] =
      STUB + Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
  }
  return { base, head };
}

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function setup(sizes: Record<string, number>) {
  const { base, head } = trees(sizes);
  const repo = makeRepo({ base, head });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: Object.keys(sizes).map((path) => ({ path, status: "modified" as const })),
  });

  return { repo, cache, db, forge, head };
}

function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

type BatchScript = { findings?: readonly Omit<Finding, "model">[]; failure?: string };

/** 按批次给出不同结果的 Reviewer 桩:第 n 次调用取 script[n]。 */
function batchedReviewer(
  model: string,
  script: readonly BatchScript[],
): Reviewer & { calls: { range: ReviewRange; worktreePath: string }[] } {
  const calls: { range: ReviewRange; worktreePath: string }[] = [];
  return {
    model,
    calls,
    review: async (range, worktreePath) => {
      const step = script[calls.length] ?? {};
      calls.push({ range, worktreePath });
      return {
        model,
        findings: (step.findings ?? []).map((f) => ({ ...f, model })),
        anomalies: [],
        rejectedToolCalls: 0,
        ...(step.failure === undefined ? {} : { failure: step.failure }),
      };
    },
  };
}

/** 追加行落在 diff 内,第 4 行是每个文件的首个新增行。 */
function findingAt(file: string, description: string): Omit<Finding, "model"> {
  return { file, line: 4, severity: "high", category: "bug", description };
}

test("规模在阈值内时不分批,Reviewer 只被调用一次", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 10, "src/b.ts": 10 });
  const reviewer = scriptedReviewer("model-a", []);

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(reviewer.calls.length, 1);
  assert.deepEqual(reviewer.calls[0]!.range.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(query(db.path, "SELECT batch_count FROM review_run")[0]!["batch_count"], 1);
});

test("规模超阈值时按文件分批,每个 Reviewer 每批各跑一次,批次互不相交且合起来是全部变更文件", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/b.ts": 30, "src/c.ts": 60 });
  const first = scriptedReviewer("model-a", []);
  const second = scriptedReviewer("model-b", []);

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [first, second],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  for (const reviewer of [first, second]) {
    // a(60)+b(30) 装进第一批,c 会撑破阈值,另起一批。
    assert.equal(reviewer.calls.length, 2, `${reviewer.model} 的批数不对`);
    const batches = reviewer.calls.map((c) => c.range.files);
    assert.deepEqual(batches, [["src/a.ts", "src/b.ts"], ["src/c.ts"]]);

    const all = batches.flat();
    assert.equal(new Set(all).size, all.length, "同一文件出现在多个批次里");
    assert.deepEqual([...all].sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  }

  assert.equal(query(db.path, "SELECT batch_count FROM review_run")[0]!["batch_count"], 2);
});

test("单个文件的改动行数就超过阈值时它自成一批,不被拒审也不被截断", async () => {
  const { cache, db, forge } = setup({ "src/big.ts": 300, "src/small.ts": 5 });
  const reviewer = scriptedReviewer("model-a", []);

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(result.failed, false);
  assert.deepEqual(
    reviewer.calls.map((c) => c.range.files),
    [["src/big.ts"], ["src/small.ts"]],
  );
  assert.equal(query(db.path, "SELECT batch_count FROM review_run")[0]!["batch_count"], 2);
});

test("每一批拿到的都是同一个完整的 head commit 工作副本", async () => {
  const { cache, db, forge, head } = setup({ "src/a.ts": 60, "src/c.ts": 60 });
  const reviewer = scriptedReviewer("model-a", []);

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(reviewer.calls.length, 2);
  const paths = new Set(reviewer.calls.map((c) => c.worktreePath));
  assert.equal(paths.size, 1, "各批次的工作副本不是同一份");

  // 第一批只审 src/a.ts,但 src/c.ts 在工作副本里仍是 head 版本:分批不该让
  // Reviewer 读到旧代码,否则会报出「这个新函数没有调用者」这类误报。
  const worktree = reviewer.calls[0]!.worktreePath;
  assert.equal(readFileSync(join(worktree, "src/c.ts"), "utf8"), head["src/c.ts"]);
});

test("跨批次的 Finding 汇总后统一去重,只发一次 review", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/c.ts": 60 });

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      batchedReviewer("model-a", [
        { findings: [findingAt("src/a.ts", "a 的问题")] },
        { findings: [findingAt("src/c.ts", "c 的问题")] },
      ]),
      batchedReviewer("model-b", [
        { findings: [findingAt("src/a.ts", "a 的另一种表述")] },
        { findings: [] },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(forge.createdReviews.length, 1, "分批后 review 被发了不止一次");
  // 两个模型在第一批对 src/a.ts 同一处的 Finding 合并为一条,第二批的 src/c.ts 另算一条。
  assert.equal(result.findings.length, 2);
  const review = forge.createdReviews[0]!;
  assert.deepEqual(
    review.comments.map((c) => ({ path: c.path, line: c.line })).sort((x, y) => x.path.localeCompare(y.path)),
    [
      { path: "src/a.ts", line: 4 },
      { path: "src/c.ts", line: 4 },
    ],
  );
  const onA = review.comments.find((c) => c.path === "src/a.ts")!;
  assert.match(onA.body, /model-a/);
  assert.match(onA.body, /model-b/);
});

test("某模型部分批次失败时成功批次的 Finding 照常发布,正文标注覆盖不全并写出第几批失败", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/c.ts": 60 });

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      batchedReviewer("model-a", [
        { findings: [findingAt("src/a.ts", "a 的问题")] },
        { failure: "context length exceeded" },
      ]),
      batchedReviewer("model-b", [{}, {}]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(result.failed, false);
  assert.equal(forge.createdReviews.length, 1);

  const review = forge.createdReviews[0]!;
  // 成功批次的结果自身是完整的,不因另一批失败而丢弃。
  assert.deepEqual(
    review.comments.map((c) => ({ path: c.path, line: c.line })),
    [{ path: "src/a.ts", line: 4 }],
  );
  assert.match(review.body, /model-a/);
  assert.match(review.body, /覆盖不全/);
  assert.match(review.body, /第 2 批/);
  assert.match(review.body, /context length exceeded/);
  // 覆盖不全与缺席是两回事:model-a 没有整体失败。
  assert.doesNotMatch(review.body, /缺席/);

  const outcome = result.outcomes.find((o) => o.model === "model-a")!;
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.incompleteCoverage?.batchCount, 2);
  assert.deepEqual(outcome.incompleteCoverage?.failures, [
    { batchIndex: 2, failure: "context length exceeded" },
  ]);

  const rows = query(db.path, "SELECT * FROM reviewer_outcome WHERE model = 'model-a'");
  assert.equal(rows.length, 1, "分批后每个模型仍应只落一行 outcome");
  assert.equal(rows[0]!["failure"], null);
  assert.equal(rows[0]!["finding_count"], 1);
});

test("某模型全部批次失败时按缺席处理,其 Finding 丢弃", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/c.ts": 60 });

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      batchedReviewer("model-a", [
        { findings: [findingAt("src/a.ts", "失败批次里报出的 Finding")], failure: "timeout" },
        { failure: "timeout" },
      ]),
      batchedReviewer("model-b", [{ findings: [findingAt("src/c.ts", "c 的问题")] }, {}]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(result.failed, false);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]!.models, ["model-b"]);

  const outcome = result.outcomes.find((o) => o.model === "model-a")!;
  assert.match(outcome.failure!, /timeout/);
  assert.equal(outcome.incompleteCoverage, undefined);

  const review = forge.createdReviews[0]!;
  assert.match(review.body, /缺席/);
  assert.doesNotMatch(review.body, /失败批次里报出的 Finding/);

  const rows = query(db.path, "SELECT * FROM reviewer_outcome WHERE model = 'model-a'");
  assert.equal(rows.length, 1);
  assert.match(String(rows[0]!["failure"]), /timeout/);
  assert.equal(rows[0]!["finding_count"], 0);
});

test("Review Run 开始时记录预估规模:变更文件数、改动行数与批数", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/b.ts": 30, "src/c.ts": 60 });

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [])],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  const run = query(db.path, "SELECT * FROM review_run")[0]!;
  assert.equal(run["changed_files"], 3);
  assert.equal(run["changed_lines"], 150);
  assert.equal(run["batch_count"], 2);
});

test("新增行以 `++ ` 起头时不被读成文件头,该文件的规模照常计入分批", async () => {
  // diff 里删掉的 SQL 注释长成 `--- `,新增的 `++ ` 行长成 `+++ `。把这两种正文读成
  // 文件头,会让此后整个文件的改动都记到一个不存在的路径上,该文件因此按零行参与
  // 分批,一个真正的巨型文件会被塞进任意一批。
  const bulk = Array.from({ length: 59 }, (_, i) => `- 第 ${i} 条`).join("\n");
  const repo = makeRepo({
    base: { "docs/tricky.md": STUB, "docs/other.md": STUB },
    head: {
      "docs/tricky.md": `${STUB}++ 这一行不是文件头\n${bulk}\n`,
      "docs/other.md": `${STUB}${bulk}\n- 第 59 条\n`,
    },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [
      { path: "docs/tricky.md", status: "modified" },
      { path: "docs/other.md", status: "modified" },
    ],
  });
  const reviewer = scriptedReviewer("model-a", []);

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  // 两个文件各改 60 行,合起来撑破阈值,必须是两批。
  assert.deepEqual(
    reviewer.calls.map((c) => c.range.files),
    [["docs/tricky.md"], ["docs/other.md"]],
  );
  const run = query(db.path, "SELECT * FROM review_run")[0]!;
  assert.equal(run["changed_lines"], 120);
  assert.equal(run["batch_count"], 2);
});
