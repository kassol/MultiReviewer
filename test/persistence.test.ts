import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Reviewer, ReviewerUsage } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const BASE = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}

export function mul(a, b) {
  return a * b;
}
`;

const HEAD = BASE.replace("return a - b;", "return a - b - 1;");

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const EVENT = { owner: "acme", repo: "widgets", number: 7 };

function setup(head: string = HEAD) {
  const repo = makeRepo({ base: { "src/calc.js": BASE }, head: { "src/calc.js": head } });
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
    changedFiles: [{ path: "src/calc.js", status: "modified" }],
  });

  return { repo, cache, db, forge };
}

/** 只读地查一次落库结果。测试断言的是外部可观察的行,不是实现。 */
function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

test("历史审查策略进入独立初始版本，写一项只推进该项版本", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  openStore(db.path).close();
  const seed = new DatabaseSync(db.path);
  seed.prepare("INSERT INTO global_setting (key, value) VALUES (?, ?)").run(
    "reviewers",
    JSON.stringify([{ provider: "test", model: "legacy" }]),
  );
  seed.prepare("INSERT INTO global_setting (key, value) VALUES (?, ?)").run(
    "max_changed_lines_per_batch",
    "777",
  );
  seed.close();

  const store = openStore(db.path);
  assert.deepEqual(store.getGlobalSettings(), {
    reviewersJson: JSON.stringify([{ provider: "test", model: "legacy" }]),
    reviewersVersion: 1,
    maxChangedLinesPerBatch: 777,
    maxChangedLinesPerBatchVersion: 1,
    maxParallelBatches: null,
    maxParallelBatchesVersion: 1,
    maxFilesPerBatch: null,
    maxFilesPerBatchVersion: 1,
    maxEvidenceCallsPerBatch: null,
    maxEvidenceCallsPerBatchVersion: 1,
  });
  assert.equal(store.putGlobalReviewers(1, JSON.stringify([])), false, "新组合不能写成空值");
  assert.equal(store.putGlobalBatchLimit("maxChangedLinesPerBatch", 1, null), true);
  assert.deepEqual(store.getGlobalSettings(), {
    reviewersJson: JSON.stringify([{ provider: "test", model: "legacy" }]),
    reviewersVersion: 1,
    maxChangedLinesPerBatch: null,
    maxChangedLinesPerBatchVersion: 2,
    maxParallelBatches: null,
    maxParallelBatchesVersion: 1,
    maxFilesPerBatch: null,
    maxFilesPerBatchVersion: 1,
    maxEvidenceCallsPerBatch: null,
    maxEvidenceCallsPerBatchVersion: 1,
  });
  assert.equal(store.putGlobalBatchLimit("maxChangedLinesPerBatch", 1, 900), false, "陈旧版本不得覆盖新值");
  assert.equal(store.getGlobalSettings().maxChangedLinesPerBatch, null);
  store.close();
});

const FINDING = {
  file: "src/calc.js",
  line: 6,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub 多减了 1",
};

test("Review Run 的元数据落库:仓库、PR、head commit、起止时间、预估规模、批数", async () => {
  const { repo, cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const rows = query(db.path, "SELECT * FROM review_run");
  assert.equal(rows.length, 1);
  const run = rows[0]!;
  assert.equal(run["owner"], "acme");
  assert.equal(run["repo"], "widgets");
  assert.equal(run["pull_number"], 7);
  assert.equal(run["head_sha"], repo.headSha);
  assert.ok(typeof run["started_at"] === "string");
  assert.ok(typeof run["finished_at"] === "string");
  assert.ok(Date.parse(run["finished_at"] as string) >= Date.parse(run["started_at"] as string));
  assert.equal(run["changed_files"], 1);
  // 只改了一行:一条 `-` 加一条 `+`。
  assert.equal(run["changed_lines"], 2);
  assert.equal(run["batch_count"], 1);
  assert.equal(run["failed"], 0);
});

test("Review Run 的触发者快照可空且不引用用户表", async () => {
  const { cache, db, forge } = setup();
  const seed = openStore(db.path);
  seed.createPanelUser({
    username: "deleted-operator",
    displayName: null,
    passwordHash: "test-only-hash",
    mustChangePassword: false,
    createdAt: "2026-08-19T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: null,
  });
  seed.close();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [])],
    cacheDir: cache.dir,
    dbPath: db.path,
    triggeredBy: "deleted-operator",
  });

  const store = openStore(db.path);
  assert.equal(store.hasHistoricalRunTrigger("deleted-operator"), true);
  assert.equal(store.hasHistoricalRunTrigger("never-used"), false);
  store.close();
  assert.equal(query(db.path, "SELECT triggered_by FROM review_run")[0]!["triggered_by"], "deleted-operator");

  const sqlite = new DatabaseSync(db.path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.prepare("DELETE FROM panel_user WHERE username = ?").run("deleted-operator");
  sqlite.close();
  assert.equal(query(db.path, "SELECT triggered_by FROM review_run")[0]!["triggered_by"], "deleted-operator");
});

test("同一处的 Finding 落一行,报出它的每个模型各落一条归属", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [FINDING]),
      scriptedReviewer("model-b", [{ ...FINDING, description: "减法结果偏移" }]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  // Finding Identity 不含模型(ADR 0015):同一处不论几个模型报出都是一条。
  const rows = query(db.path, "SELECT * FROM finding");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row["file"], "src/calc.js");
  assert.equal(row["line"], 6);
  assert.equal(row["severity"], "P0");
  assert.equal(row["category"], "bug");
  assert.match(row["fingerprint"] as string, /^[0-9a-f]{64}$/);
  // Disposition 的权威状态在 Forge,本地默认未知。
  assert.equal(row["disposition"], "unknown");

  const attributions = query(
    db.path,
    "SELECT * FROM finding_attribution ORDER BY position",
  );
  assert.deepEqual(
    attributions.map((a) => ({
      finding: a["finding_id"],
      model: a["model"],
      severity: a["severity"],
      category: a["category"],
      description: a["description"],
    })),
    [
      {
        finding: row["id"],
        model: "model-a",
        severity: "P0",
        category: "bug",
        description: "sub 多减了 1",
      },
      {
        finding: row["id"],
        model: "model-b",
        severity: "P0",
        category: "bug",
        description: "减法结果偏移",
      },
    ],
  );
});

test("内容指纹只看指向行前后 3 行的代码,不看空白", async () => {
  // 仅缩进不同。
  const reindented = HEAD.replace("  return a - b - 1;", "      return a - b - 1;");
  // 窗口内的代码真的变了。
  const rewritten = HEAD.replace("return a - b - 1;", "return a - b - 2;");
  // 窗口(3..9 行)之外的改动。
  const outside = HEAD.replace("return a * b;", "return a * b * 2;");

  const fingerprintOf = async (head: string): Promise<string> => {
    const { cache, db, forge } = setup(head);
    await runReview(EVENT, {
      forge: forge.forge,
      reviewers: [scriptedReviewer("model-a", [FINDING])],
      cacheDir: cache.dir,
      dbPath: db.path,
    });
    return query(db.path, "SELECT fingerprint FROM finding")[0]!["fingerprint"] as string;
  };

  const base = await fingerprintOf(HEAD);
  assert.equal(await fingerprintOf(reindented), base, "缩进变化不该改变指纹");
  assert.equal(await fingerprintOf(outside), base, "窗口之外的改动不该改变指纹");
  assert.notEqual(await fingerprintOf(rewritten), base, "窗口内的改动必须改变指纹");
});

test("每个 Reviewer 的执行结果与失败原因落库", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [FINDING], { rejectedToolCalls: 2 }),
      scriptedReviewer("model-b", [], { failure: "402 dead credential" }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const rows = query(db.path, "SELECT * FROM reviewer_outcome ORDER BY model");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!["model"], "model-a");
  assert.equal(rows[0]!["failure"], null);
  assert.equal(rows[0]!["finding_count"], 1);
  assert.equal(rows[0]!["rejected_tool_calls"], 2);
  assert.equal(rows[1]!["model"], "model-b");
  assert.equal(rows[1]!["failure"], "402 dead credential");
  assert.equal(rows[1]!["finding_count"], 0);
});

/** 时间流一页的逐模型行。测试只看外部可观察的那三个字段。 */
function runModels(dbPath: string): { model: string; findings: number; failure: string | null }[] {
  const store = openStore(dbPath);
  try {
    return store.listRuns({ limit: 30 })[0]!.models;
  } finally {
    store.close();
  }
}

test("时间流:一个模型失败一个成功时两行都在,失败那行带原因", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [FINDING]),
      scriptedReviewer("model-b", [], { failure: "403 This model is not available in your region." }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const store = openStore(db.path);
  const run = store.listRuns({ limit: 30 })[0]!;
  store.close();
  // 部分失败不是这一轮失败:Finding 是真的,处置照做。
  assert.equal(run.failed, false);
  assert.deepEqual(run.models, [
    { model: "model-a", findings: 1, failure: null },
    { model: "model-b", findings: 0, failure: "403 This model is not available in your region." },
  ]);
});

test("时间流:全部模型失败时每行都带原因,这一轮标失败", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [], { failure: "timeout" }),
      scriptedReviewer("model-b", [], { failure: "402 dead credential" }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const store = openStore(db.path);
  const run = store.listRuns({ limit: 30 })[0]!;
  store.close();
  assert.equal(run.failed, true);
  assert.deepEqual(run.models, [
    { model: "model-a", findings: 0, failure: "timeout" },
    { model: "model-b", findings: 0, failure: "402 dead credential" },
  ]);
});

test("时间流:一条 Finding 都没报的成功模型照样列出", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.deepEqual(runModels(db.path), [{ model: "model-a", findings: 0, failure: null }]);
});

test("时间流:失败原因压成一行并截断,原文仍在库里", async () => {
  const { cache, db, forge } = setup();
  const long = `403 {\n  "error": {\n    "message": "${"x".repeat(400)}"\n  }\n}`;

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING]), scriptedReviewer("model-b", [], { failure: long })],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const failure = runModels(db.path).find((entry) => entry.model === "model-b")!.failure!;
  assert.equal(failure.length, 201, "节选是 200 字加一个省略号");
  assert.ok(failure.endsWith("…"));
  assert.ok(!failure.includes("\n"), "换行压成空格,卡片上只占一句话");
  assert.match(failure, /^403 \{ "error": \{ "message": "x+…$/);
  assert.equal(query(db.path, "SELECT failure FROM reviewer_outcome WHERE model = 'model-b'")[0]!["failure"], long);
});

test("锚定打回次数落库,与被拒的工具调用分列两列", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [FINDING], { rejectedToolCalls: 2, anchorRejections: 5 }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const rows = query(db.path, "SELECT * FROM reviewer_outcome");
  assert.equal(rows[0]!["rejected_tool_calls"], 2);
  assert.equal(rows[0]!["anchor_rejections"], 5);
});

test("升级前建的数据库仍能打开,锚定打回列补在既有表上", async () => {
  const { cache, db, forge } = setup();

  // 升级前的 reviewer_outcome:没有 anchor_rejections 这一列。CREATE TABLE IF NOT
  // EXISTS 对既有表不做任何事,少了补列这一步,升级后第一次落库就写不进去。
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE reviewer_outcome (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    model TEXT NOT NULL,
    failure TEXT,
    finding_count INTEGER NOT NULL,
    anomaly_count INTEGER NOT NULL,
    rejected_tool_calls INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL
  )`);
  old.exec("PRAGMA user_version = 1");
  old.close();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING], { anchorRejections: 4 })],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const rows = query(db.path, "SELECT * FROM reviewer_outcome");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["anchor_rejections"], 4);
});

test("升级前的 review_run 补 triggered_by 与 title,历史行按投递读且标题为空", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE review_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    pr_state TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    changed_files INTEGER NOT NULL,
    changed_lines INTEGER NOT NULL,
    batch_count INTEGER NOT NULL,
    failed INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL
  );
  CREATE TABLE reviewer_outcome (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    model TEXT NOT NULL,
    failure TEXT,
    finding_count INTEGER NOT NULL,
    anomaly_count INTEGER NOT NULL,
    rejected_tool_calls INTEGER NOT NULL,
    anchor_rejections INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL
  )`);
  const oldRun = old.prepare(
    `INSERT INTO review_run
       (owner, repo, pull_number, head_sha, started_at, changed_files, changed_lines, batch_count,
        total_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("acme", "widgets", 7, "old-sha", "2026-08-01T00:00:00.000Z", 1, 2, 1, 10, 0);
  old.prepare(
    `INSERT INTO reviewer_outcome
       (run_id, model, finding_count, anomaly_count, rejected_tool_calls, duration_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(Number(oldRun.lastInsertRowid), "legacy-free", 0, 0, 0, 1, 8, 2, 0, 0, 10, 0);
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  assert.equal(store.listRuns({ limit: 10 })[0]!.triggeredBy, null);
  // 标题那一列是升级补出来的,升级前落的这一行自然没有(issue #173)。
  assert.equal(store.listRuns({ limit: 10 })[0]!.title, null);
  assert.deepEqual(store.listRuns({ limit: 10 })[0]!.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
  });
  assert.deepEqual(store.listRuns({ limit: 10 })[0]!.models[0]!.usage, {
    inputTokens: 8,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
  });
  store.startRun({
    owner: "acme",
    repo: "widgets",
    pullNumber: 8,
    headSha: "new-sha",
    startedAt: "2026-08-19T00:00:00.000Z",
    changedFiles: 1,
    changedLines: 2,
    batchCount: 1,
    triggeredBy: "operator",
    title: "把登录超时改回三十秒",
    reviewerPins: [],
  });
  assert.equal(store.listRuns({ limit: 10 })[0]!.triggeredBy, "operator");
  assert.equal(store.listRuns({ limit: 10 })[0]!.title, "把登录超时改回三十秒");
  store.close();
});

test("用量与耗时落库,Review Run 一级是各 Reviewer 之和", async () => {
  const { cache, db, forge } = setup();

  const usage: ReviewerUsage = {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 900,
    cacheWriteTokens: 100,
    totalTokens: 2500,
  };
  const slow: Reviewer = {
    model: "slow-model",
    review: async () => {
      await delay(30);
      return {
        model: "slow-model",
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        usage,
      };
    },
  };

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING], { usage }), slow],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const outcomes = query(db.path, "SELECT * FROM reviewer_outcome ORDER BY model");
  assert.equal(outcomes[0]!["total_tokens"], 2500);
  const slowRow = outcomes.find((r) => r["model"] === "slow-model")!;
  assert.ok((slowRow["duration_ms"] as number) >= 30, "Reviewer 的耗时没有被记录");

  const run = query(db.path, "SELECT * FROM review_run")[0]!;
  assert.equal(run["input_tokens"], 2400);
  assert.equal(run["total_tokens"], 5000);
  assert.ok((run["duration_ms"] as number) >= 30);
});


test("同一数据库上的第二次 Review Run 追加一行,不覆盖上一次", async () => {
  const { repo, cache, db, forge } = setup();
  const deps = {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  await runReview(EVENT, deps);
  forge.pullRequest.headSha = repo.pushToHead({
    "src/calc.js": HEAD.replace("return a * b;", "return a * b * 2;"),
  });
  await runReview(EVENT, deps);

  const runs = query(db.path, "SELECT id, head_sha FROM review_run ORDER BY id");
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0]!["head_sha"], runs[1]!["head_sha"]);
  assert.equal(query(db.path, "SELECT * FROM finding").length, 2);
});
test("时间流带上每条 Finding 的 Forge 评论 id 与链接", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const published = forge.publishedComments[0]!;
  const store = openStore(db.path);
  const run = store.listRuns({ limit: 10 })[0]!;
  store.close();
  assert.deepEqual(run.findings, [
    {
      id: run.findings[0]!.id,
      models: ["model-a"],
      file: FINDING.file,
      line: FINDING.line,
      severity: FINDING.severity,
      category: FINDING.category,
      description: FINDING.description,
      disposition: "unknown",
      placement: "inline",
      commentId: published.id,
      commentHtmlUrl: published.htmlUrl,
      disposedBy: null,
      disposedAt: null,
      note: null,
      continuedFrom: null,
      handoffPending: false,
    },
  ]);
});

test("升级前的 finding 补评论 id 与链接两列,历史行两项为空", async () => {
  const { cache, db, forge } = setup();

  // 升级前的 finding 表:没有 comment_id / comment_html_url。CREATE TABLE IF NOT
  // EXISTS 对既有表什么都不做,少了补列这一步,升级后第一次落库就写不进去。
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    fingerprint TEXT,
    group_index INTEGER NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'unknown',
    placement TEXT NOT NULL DEFAULT 'inline'
  )`);
  old.exec("PRAGMA user_version = 1");
  old.close();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const store = openStore(db.path);
  const run = store.listRuns({ limit: 10 })[0]!;
  store.close();
  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0]!.commentId, forge.publishedComments[0]!.id);
});

test("升级前的 finding 补 title 列,历史注入时旧行的标题为空", async () => {
  const { cache, db, forge } = setup();

  // 升级前的 finding 表:没有 title 列。历史注入要拿标题给已处置的条目占那一行
  // (ADR 0016),少了补列这一步,升级后第一次落库就写不进去。
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    fingerprint TEXT,
    group_index INTEGER NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'unknown',
    placement TEXT NOT NULL DEFAULT 'inline'
  )`);
  old.exec("PRAGMA user_version = 1");
  old.close();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [{ ...FINDING, title: "减法多减一" }])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  // 升级前落的那些行没有标题可补:少一句话胜过让整条历史掉出注入。
  const patch = new DatabaseSync(db.path);
  patch.exec("UPDATE finding SET title = NULL");
  patch.close();

  const store = openStore(db.path);
  const history = store.stageHistory({
    owner: EVENT.owner,
    repo: EVENT.repo,
    pullNumber: EVENT.number,
  });
  store.close();
  assert.deepEqual(history.map((entry) => entry.title), [""]);
});

test("升级前建的数据库:轨迹表补出来,历史轮次的轨迹是空列表而不是报错", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  // 升级前的库里根本没有 review_trace 这张表。新表走 CREATE TABLE IF NOT EXISTS,
  // 打开时补出来即可;补不出来,那一轮的 /trace 会直接抛。
  const old = new DatabaseSync(db.path);
  old.exec(LEGACY_SCHEMA);
  const runId = Number(
    old
      .prepare(
        `INSERT INTO review_run
           (owner, repo, pull_number, head_sha, started_at, changed_files, changed_lines, batch_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("acme", "widgets", 7, "old-sha", "2026-08-01T00:00:00.000Z", 1, 2, 1).lastInsertRowid,
  );
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  try {
    assert.deepEqual(store.listTrace(runId), [], "那时候还不记过程,空列表不是错误");
    // 补出来的表照常能写:升级之后跑的那一轮从序号 1 起。
    const appended = store.appendTrace(runId, {
      scope: "run",
      kind: "worktree_ready",
      payload: { baseSha: "a", headSha: "b" },
    });
    assert.equal(appended.seq, 1);
    assert.deepEqual(store.listTrace(runId), [appended]);
  } finally {
    store.close();
  }
});

test("升级前落的 finding 行读得出来,评论 id 与链接为空", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE review_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    changed_files INTEGER NOT NULL,
    changed_lines INTEGER NOT NULL,
    batch_count INTEGER NOT NULL,
    failed INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL
  );
  CREATE TABLE finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    fingerprint TEXT,
    group_index INTEGER NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'unknown',
    placement TEXT NOT NULL DEFAULT 'inline'
  )`);
  const oldRun = old.prepare(
    `INSERT INTO review_run
       (owner, repo, pull_number, head_sha, started_at, changed_files, changed_lines, batch_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("acme", "widgets", 7, "old-sha", "2026-08-01T00:00:00.000Z", 1, 2, 1);
  old.prepare(
    `INSERT INTO finding
       (run_id, file, line, severity, category, description, group_index)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(Number(oldRun.lastInsertRowid), "src/calc.js", 6, "P0", "bug", "旧行", 0);
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  const run = store.listRuns({ limit: 10 })[0]!;
  store.close();
  // 升级前的表连处置人、处置时间、处置备注与「延续自」几列都没有,补列之后旧行全是空;
  // 归属表那时也还没有,旧行读出来一个模型都不挂。
  assert.deepEqual(run.findings, [
    {
      id: run.findings[0]!.id,
      models: [],
      file: "src/calc.js",
      line: 6,
      severity: "P0",
      category: "bug",
      description: "旧行",
      disposition: "unknown",
      placement: "inline",
      commentId: null,
      commentHtmlUrl: null,
      disposedBy: null,
      disposedAt: null,
      note: null,
      continuedFrom: null,
      handoffPending: false,
    },
  ]);
});

test("升级前的 finding 补相邻改动列,历史行的标记为空", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  // 升级前的 finding 表:行作者四列已经有了,没有 line_author_adjacent(issue #241)。
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE review_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    changed_files INTEGER NOT NULL,
    changed_lines INTEGER NOT NULL,
    batch_count INTEGER NOT NULL,
    failed INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL
  );
  CREATE TABLE finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    fingerprint TEXT,
    group_index INTEGER NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'unknown',
    placement TEXT NOT NULL DEFAULT 'inline',
    line_author_sha TEXT,
    line_author_name TEXT,
    line_author_email TEXT,
    line_author_at TEXT
  )`);
  const oldRun = old.prepare(
    `INSERT INTO review_run
       (owner, repo, pull_number, head_sha, started_at, changed_files, changed_lines, batch_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("acme", "widgets", 7, "old-sha", "2026-08-01T00:00:00.000Z", 1, 2, 1);
  old.prepare(
    `INSERT INTO finding
       (run_id, file, line, severity, category, description, group_index,
        line_author_sha, line_author_name, line_author_email, line_author_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Number(oldRun.lastInsertRowid),
    "src/calc.js",
    6,
    "P0",
    "bug",
    "旧行",
    0,
    "old-author-sha",
    "Old Author",
    "old@example.invalid",
    "2026-07-01T00:00:00.000Z",
  );
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  const summary = store.stageSummary({ owner: "acme", repo: "widgets", pullNumber: 7 });
  store.close();
  // 存量不回填:升级前落的那一行仍是它当时的判定,补出来的这一列是空,读回不带标记。
  assert.deepEqual(summary.findings[0]!.lineAuthor, {
    sha: "old-author-sha",
    name: "Old Author",
    email: "old@example.invalid",
    authoredAt: "2026-07-01T00:00:00.000Z",
    adjacent: false,
  });
});

/** 升级前的一份库结构:`review_trace` 那张表还不存在。 */
const LEGACY_SCHEMA = `CREATE TABLE review_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    changed_files INTEGER NOT NULL,
    changed_lines INTEGER NOT NULL,
    batch_count INTEGER NOT NULL,
    failed INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL
  );
  CREATE TABLE finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES review_run(id),
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    fingerprint TEXT,
    group_index INTEGER NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'unknown',
    placement TEXT NOT NULL DEFAULT 'inline'
  )`;

test("升级前建的库没有比较项来源两列,打开后补出来,旧行读回 comparisonSource: null", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  // 升级前的 range_review 表:没有 comparison_source_kind / comparison_source_name。
  // CREATE TABLE IF NOT EXISTS 对既有表不做任何事,少了补列这一步,来源就没地方落。
  const old = new DatabaseSync(db.path);
  old.exec(`CREATE TABLE range_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    title TEXT,
    base_sha TEXT NOT NULL,
    comparison_sha TEXT NOT NULL,
    state TEXT NOT NULL,
    container_pull_number INTEGER,
    base_branch TEXT NOT NULL,
    head_branch TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_by TEXT,
    completed_at TEXT,
    last_forge_failure TEXT
  )`);
  const oldRow = old
    .prepare(
      `INSERT INTO range_review
         (repo_id, owner, repo, title, base_sha, comparison_sha, state,
          base_branch, head_branch, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in-progress', ?, ?, ?, ?)`,
    )
    .run(
      1,
      "acme",
      "widgets",
      "示例范围审查",
      "base-sha",
      "cmp-sha",
      "range/1/base",
      "range/1/head",
      "kassol",
      "2026-08-01T00:00:00.000Z",
    );
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  try {
    const columns = query(db.path, "PRAGMA table_info(range_review)").map((row) => row["name"]);
    assert.ok(columns.includes("comparison_source_kind"));
    assert.ok(columns.includes("comparison_source_name"));

    const record = store.getRangeReview(Number(oldRow.lastInsertRowid));
    assert.equal(record?.comparisonSource, null);
  } finally {
    store.close();
  }
});

test("正常收尾的轮次没有轮次级失败原因;recordRunFailure 只写原因,failed 与结束时间不动", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    const runId = store.startRun({
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      headSha: "deadbee",
      startedAt: "2026-09-05T00:00:00.000Z",
      changedFiles: 1,
      changedLines: 2,
      batchCount: 1,
      reviewerPins: [],
    });
    store.finishRun(runId, {
      finishedAt: "2026-09-05T00:10:00.000Z",
      durationMs: 600_000,
      failed: false,
      outcomes: [],
      findings: [],
    });
    assert.equal(store.listRuns({ limit: 10 })[0]!.failure, null);

    // 收尾之后的失败(发布 review 失败那一类)只写这一列:Reviewer 结果是有效的,
    // `failed` 不能因它置位(ADR 0026)。
    store.recordRunFailure(runId, "发布 review 失败:Gitea 回 502");
    const [run] = store.listRuns({ limit: 10 });
    assert.equal(run!.failure, "发布 review 失败:Gitea 回 502");
    assert.equal(run!.failed, false);
    assert.equal(run!.finishedAt, "2026-09-05T00:10:00.000Z");
  } finally {
    store.close();
  }
});

test("升级前的 review_run 补失败原因列,旧行读回无失败记录", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const old = new DatabaseSync(db.path);
  old.exec(LEGACY_SCHEMA);
  old
    .prepare(
      `INSERT INTO review_run
         (owner, repo, pull_number, head_sha, started_at, finished_at, changed_files,
          changed_lines, batch_count, failed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "acme",
      "widgets",
      7,
      "old-sha",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:10:00.000Z",
      1,
      2,
      1,
      1,
    );
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  try {
    const columns = query(db.path, "PRAGMA table_info(review_run)").map((row) => row["name"]);
    assert.ok(columns.includes("failure"));
    // 升级前只有 `failed` 一位:这一轮是 Reviewer 失败,轮次级的原因无从补,读回为空。
    const [run] = store.listRuns({ limit: 10 });
    assert.equal(run!.failed, true);
    assert.equal(run!.failure, null);
  } finally {
    store.close();
  }
});

test("升级前的 review_run 补批次计划列,旧行读回没有计划,已结束的轮次一行不动", () => {
  // issue #253:计划在开跑时写一次。升级前落的行没有它,续跑读回即「没有计划」,退回
  // 改判;已经收尾的历史轮次只多一列 NULL,结束时间与结果都不变。
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const old = new DatabaseSync(db.path);
  old.exec(LEGACY_SCHEMA);
  old
    .prepare(
      `INSERT INTO review_run
         (owner, repo, pull_number, head_sha, started_at, finished_at, changed_files,
          changed_lines, batch_count, failed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "acme",
      "widgets",
      7,
      "old-sha",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:10:00.000Z",
      2,
      4,
      2,
      0,
    );
  old.exec("PRAGMA user_version = 1");
  old.close();

  const store = openStore(db.path);
  try {
    const columns = query(db.path, "PRAGMA table_info(review_run)").map((row) => row["name"]);
    assert.ok(columns.includes("batch_plan_json"));
    const [run] = store.listRuns({ limit: 10 });
    assert.equal(run!.finishedAt, "2026-08-01T00:10:00.000Z");
    assert.equal(run!.failed, false);
    assert.equal(store.resumeState(run!.id)?.plan, undefined);
  } finally {
    store.close();
  }
});
