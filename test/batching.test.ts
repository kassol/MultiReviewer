import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type {
  Finding,
  ReviewerInput,
  ReviewerOutcome,
  ReviewerUsage,
  ReviewRange,
  Reviewer,
} from "../src/review/finding.ts";
import {
  DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  mergeBatchOutcomes,
  splitIntoBatches,
} from "../src/review/batch.ts";
import { runReview } from "../src/review/run.ts";
import type { FileTree } from "./support/git-fixture.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, readingReviewer, scriptedReviewer } from "./support/memory-forge.ts";

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
      title: "示例 PR",
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

type BatchScript = {
  findings?: readonly Omit<Finding, "model">[];
  failure?: string;
  anchorRejections?: number;
  /** 这一批跑多久才回。批次受限并行之后完成顺序由它决定(issue #232)。 */
  delayMs?: number;
};

/** 按批次给出不同结果的 Reviewer 桩:第 n 次调用取 script[n]。 */
function batchedReviewer(
  model: string,
  script: readonly BatchScript[],
): Reviewer & { calls: { range: ReviewRange; worktreePath: string }[] } {
  const calls: { range: ReviewRange; worktreePath: string }[] = [];
  return {
    model,
    calls,
    review: async ({ range, worktreePath }) => {
      const step = script[calls.length] ?? {};
      calls.push({ range, worktreePath });
      if (step.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      }
      return {
        model,
        findings: (step.findings ?? []).map((f) => ({ ...f, model })),
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: step.anchorRejections ?? 0,
        ...(step.failure === undefined ? {} : { failure: step.failure }),
      };
    },
  };
}

/** 追加行落在 diff 内,第 4 行是每个文件的首个新增行。 */
function findingAt(file: string, description: string): Omit<Finding, "model"> {
  return {
    file,
    line: 4,
    severity: "P0",
    category: "bug",
    title: "",
    description,
    impact: "",
    suggestion: "",
  };
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

test("文件数与改动行数任一超上限即封箱:40 个各 1 行的文件加 1 个是两批", () => {
  const files = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
  const changedLines = new Map(files.map((file) => [file, 1]));

  const batches = splitIntoBatches(files, changedLines, DEFAULT_MAX_CHANGED_LINES_PER_BATCH, 40);

  assert.deepEqual(batches.map((batch) => batch.length), [40, 1]);
  assert.deepEqual(batches.flat(), files, "文件顺序与归属不该因为按文件数封箱而变");
});

test("单个文件超改动行上限时仍自成一批,不受文件数上限影响", () => {
  const changedLines = new Map([["src/big.ts", 300], ["src/a.ts", 5], ["src/b.ts", 5]]);

  assert.deepEqual(
    splitIntoBatches(["src/big.ts", "src/a.ts", "src/b.ts"], changedLines, 100, 40),
    [["src/big.ts"], ["src/a.ts", "src/b.ts"]],
  );
});

test("文件数上限经 ReviewRunDeps 传到分批,改动行远没到上限也照样切", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 10, "src/b.ts": 10, "src/c.ts": 10 });
  const reviewer = scriptedReviewer("model-a", []);

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 2,
  });

  assert.deepEqual(
    reviewer.calls.map((c) => c.range.files),
    [["src/a.ts", "src/b.ts"], ["src/c.ts"]],
  );
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
  const reviewer = readingReviewer(scriptedReviewer("model-a", []), "src/c.ts");

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
  assert.deepEqual(reviewer.seen, [head["src/c.ts"], head["src/c.ts"]]);
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
  // 两个模型的来源都在合并结果里;评论正文不署名,合并证据看数据层。
  const onA = result.findings.find((f) => f.file === "src/a.ts")!;
  assert.deepEqual([...onA.attributions.map((a) => a.model)].sort(), ["model-a", "model-b"]);
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
  // 厂商错误原文不外发到 PR:它是运维信息,只留在库里。
  assert.doesNotMatch(review.body, /context length exceeded/);
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
  assert.deepEqual(result.findings[0]!.attributions.map((a) => a.model), ["model-b"]);

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

test("锚定打回次数跨批次累加,不是只留最后一批的数", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/c.ts": 60 });

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [batchedReviewer("model-a", [{ anchorRejections: 2 }, { anchorRejections: 3 }])],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
  });

  assert.equal(result.outcomes[0]!.anchorRejections, 5);
  const rows = query(db.path, "SELECT anchor_rejections FROM reviewer_outcome");
  assert.equal(rows[0]!["anchor_rejections"], 5);
});

test("跨批次的 token 用量按五列累加", () => {
  const usage = (totalTokens: number): ReviewerUsage => ({
    inputTokens: totalTokens - 3,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens,
  });
  const timed = (entry: ReviewerUsage) => ({
    startedAt: 0,
    durationMs: 1,
    outcome: {
      model: "model-a",
      findings: [],
      anomalies: [],
      rejectedToolCalls: 0,
      anchorRejections: 0,
      usage: entry,
    },
  });

  const merged = mergeBatchOutcomes([timed(usage(10)), timed(usage(20))]);
  assert.deepEqual(merged.outcome.usage, {
    inputTokens: 24,
    outputTokens: 2,
    cacheReadTokens: 2,
    cacheWriteTokens: 2,
    totalTokens: 30,
  });
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
      title: "示例 PR",
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

test("每批只注入 glob 命中该批文件的知识条目,全仓库条目每批都给,两型同一条口径", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 60, "src/b.ts": 30, "src/c.ts": 60 });
  const reviewer = scriptedReviewer("model-a", []);

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    ruleSetVersion: 3,
    rules: [
      { id: 1, scope: "", statement: "改动要带测试" },
      { id: 2, scope: "src/a.ts", statement: "a 里不写 any" },
      { id: 3, scope: "src/c.*", statement: "c 里不写 console" },
      { id: 4, scope: "docs/**", statement: "文档要跟着改" },
    ],
    // 事实与规则同一条路由(issue #221):一条只描述某个目录的事实不进不含它的批次。
    facts: [
      { id: 11, scope: "", statement: "这个服务只跑在内网" },
      { id: 12, scope: "src/a.ts", statement: "a 的调用方只有 b" },
      { id: 13, scope: "docs/**", statement: "文档由另一个仓库生成" },
    ],
  });

  // a(60)+b(30) 是第一批,c 自成第二批。条目跟着批次里的文件走,一条都不该串批。
  assert.deepEqual(
    reviewer.calls.map((call) => call.rules.map((rule) => rule.id)),
    [
      [1, 2],
      [1, 3],
    ],
  );
  assert.deepEqual(
    reviewer.calls.map((call) => call.facts.map((fact) => fact.id)),
    [
      [11, 12],
      [11],
    ],
  );
});

/**
 * 记下同时在跑的批次数的 Reviewer 桩(issue #232)。每批睡一会儿才回,睡着的这段时间里
 * 并发池若还有名额就会开下一批,`peak` 因此等于实测的并发峰值。
 */
function probingReviewer(model: string, delayMs = 5): Reviewer & {
  peak: number;
  started: string[][];
} {
  let active = 0;
  const probe = {
    model,
    peak: 0,
    started: [] as string[][],
    review: async ({ range }: ReviewerInput): Promise<ReviewerOutcome> => {
      probe.started.push([...range.files]);
      active += 1;
      probe.peak = Math.max(probe.peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      return { model, findings: [], anomalies: [], rejectedToolCalls: 0, anchorRejections: 0 };
    },
  };
  return probe;
}

/** 六个各改 5 行的文件,配上文件数上限 1 即六个批次。 */
const SIX_FILES = Object.fromEntries(
  Array.from({ length: 6 }, (_, i) => [`src/f${i}.ts`, 5]),
) as Record<string, number>;

test("批次受限并行:同时在跑的批次数不超过并发上限", async () => {
  const { cache, db, forge } = setup(SIX_FILES);
  const reviewer = probingReviewer("model-a");

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
    maxParallelBatches: 3,
  });

  assert.equal(reviewer.started.length, 6);
  assert.equal(reviewer.peak, 3);
});

test("并发上限为 1 时逐批跑完再开下一批,与分批以来的行为一致", async () => {
  const { cache, db, forge } = setup(SIX_FILES);
  const reviewer = probingReviewer("model-a");

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
    maxParallelBatches: 1,
  });

  assert.equal(reviewer.peak, 1);
  assert.deepEqual(reviewer.started, Object.keys(SIX_FILES).map((file) => [file]));
});

test("各批完成顺序打乱时,汇总仍按批次序号定序", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 5, "src/b.ts": 5, "src/c.ts": 5 });

  // 第 1 批最后才回,第 3 批最先回:按完成顺序记的话失败会被记成第 3 批。
  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      batchedReviewer("model-a", [
        { failure: "context length exceeded", delayMs: 60 },
        { findings: [findingAt("src/b.ts", "b 的问题")], delayMs: 30 },
        { findings: [findingAt("src/c.ts", "c 的问题")], delayMs: 0 },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
    maxParallelBatches: 3,
  });

  const outcome = result.outcomes[0]!;
  assert.deepEqual(outcome.incompleteCoverage?.failures, [
    { batchIndex: 1, failure: "context length exceeded" },
  ]);
  // 失败批之外的两批照常保留。
  assert.deepEqual(result.findings.map((f) => f.file).sort(), ["src/b.ts", "src/c.ts"]);
});

test("单模型耗时是首批开始到末批结束的墙上时间,不是各批相加", () => {
  const outcome = (): ReviewerOutcome => ({
    model: "model-a",
    findings: [],
    anomalies: [],
    rejectedToolCalls: 0,
    anchorRejections: 0,
  });

  const merged = mergeBatchOutcomes([
    { outcome: outcome(), startedAt: 1_000, durationMs: 100 },
    { outcome: outcome(), startedAt: 1_050, durationMs: 100 },
  ]);

  assert.equal(merged.startedAt, 1_000);
  assert.equal(merged.durationMs, 150);
});

test("同一条被两批复核到时序号大的那批作数", () => {
  const timed = (verdict: "present" | "fixed") => ({
    startedAt: 0,
    durationMs: 1,
    outcome: {
      model: "model-a",
      findings: [],
      anomalies: [],
      rejectedToolCalls: 0,
      anchorRejections: 0,
      verdicts: [{ findingId: 7, verdict }],
    },
  });

  // 传入按批次序号排,后面那项即序号大的那批。
  const merged = mergeBatchOutcomes([timed("present"), timed("fixed")]);
  assert.deepEqual(merged.outcome.verdicts, [{ findingId: 7, verdict: "fixed" }]);
});

test("并行跑的三批落库的耗时是墙上时间,不是三批相加", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 5, "src/b.ts": 5, "src/c.ts": 5 });

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [probingReviewer("model-a", 100)],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
    maxParallelBatches: 3,
  });

  // 串行相加是 300 ms 起步,三批同时跑只用一批的时间。
  const duration = Number(query(db.path, "SELECT duration_ms FROM reviewer_outcome")[0]!["duration_ms"]);
  assert.ok(duration < 250, `耗时 ${duration} ms 看着像各批相加`);
});

test("Reviewer 作用域的轨迹事件带批次序号", async () => {
  const { cache, db, forge } = setup({ "src/a.ts": 5, "src/b.ts": 5 });
  const reviewer = scriptedReviewer("model-a", [], {
    events: [{ kind: "assistant_message", text: "正在读文件" }],
  });

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
  });

  const rows = query(
    db.path,
    "SELECT payload FROM review_trace WHERE scope = 'reviewer' AND kind = 'assistant_message' ORDER BY seq",
  );
  assert.deepEqual(
    rows.map((row) => JSON.parse(String(row["payload"])) as { text: string; batch: number }),
    [
      { text: "正在读文件", batch: 1 },
      { text: "正在读文件", batch: 2 },
    ],
  );
});
