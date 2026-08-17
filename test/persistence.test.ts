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

test("每条 Finding 落库并带上来源模型、位置、severity、category 与内容指纹", async () => {
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

  const rows = query(db.path, "SELECT * FROM finding ORDER BY model");
  // 两个模型报的是同一处,合并成一条评论,但两条来源各自落库。
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r["model"]),
    ["model-a", "model-b"],
  );
  assert.equal(rows[0]!["group_index"], rows[1]!["group_index"]);
  for (const row of rows) {
    assert.equal(row["file"], "src/calc.js");
    assert.equal(row["line"], 6);
    assert.equal(row["severity"], "P0");
    assert.equal(row["category"], "bug");
    assert.match(row["fingerprint"] as string, /^[0-9a-f]{64}$/);
    // Disposition 的权威状态在 Forge,本地默认未知。
    assert.equal(row["disposition"], "unknown");
  }
  assert.equal(rows[0]!["description"], "sub 多减了 1");
  assert.equal(rows[1]!["description"], "减法结果偏移");
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

test("用量与耗时落库,Review Run 一级是各 Reviewer 之和", async () => {
  const { cache, db, forge } = setup();

  const usage: ReviewerUsage = {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 900,
    cacheWriteTokens: 100,
    totalTokens: 2500,
    costUsd: 0.0042,
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
  assert.equal(outcomes[0]!["cost_usd"], 0.0042);
  const slowRow = outcomes.find((r) => r["model"] === "slow-model")!;
  assert.ok((slowRow["duration_ms"] as number) >= 30, "Reviewer 的耗时没有被记录");

  const run = query(db.path, "SELECT * FROM review_run")[0]!;
  assert.equal(run["input_tokens"], 2400);
  assert.equal(run["total_tokens"], 5000);
  assert.equal(run["cost_usd"], 0.0084);
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
