import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Reviewer, ReviewerUsage } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeDbPath, testCleanups } from "./support/git-fixture.ts";
import { query, setup as setupRepo } from "./support/batch-run.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

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

const cleanups = testCleanups();

const EVENT = { owner: "acme", repo: "widgets", number: 7 };

function setup(head: string = HEAD) {
  return setupRepo(cleanups, {
    tree: { base: { "src/calc.js": BASE }, head: { "src/calc.js": head } },
    pullNumber: EVENT.number,
    changedFiles: [{ path: "src/calc.js", status: "modified" }],
  });
}


test("历史审查策略读回整页初始版本，整份替换推一版，陈旧版本不得覆盖", () => {
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
  const legacyJson = JSON.stringify([{ provider: "test", model: "legacy" }]);
  assert.deepEqual(store.getGlobalSettings(), {
    reviewersJson: legacyJson,
    auxiliaryModelJson: null,
    maxChangedLinesPerBatch: 777,
    maxParallelBatches: null,
    maxFilesPerBatch: null,
    maxEvidenceCallsPerBatch: null,
    minReportSeverity: null,
    version: 1,
  });
  // 整页一次全量替换(issue #301):写成 null 的那几项从库里消失,整页版本推一版。
  assert.equal(
    store.replaceGlobalSettings(1, {
      reviewersJson: legacyJson,
      auxiliaryModelJson: null,
      maxChangedLinesPerBatch: null,
      maxParallelBatches: null,
      maxFilesPerBatch: null,
      maxEvidenceCallsPerBatch: null,
      minReportSeverity: null,
    }),
    true,
  );
  assert.deepEqual(store.getGlobalSettings(), {
    reviewersJson: legacyJson,
    auxiliaryModelJson: null,
    maxChangedLinesPerBatch: null,
    maxParallelBatches: null,
    maxFilesPerBatch: null,
    maxEvidenceCallsPerBatch: null,
    minReportSeverity: null,
    version: 2,
  });
  assert.equal(
    store.replaceGlobalSettings(1, {
      reviewersJson: legacyJson,
      auxiliaryModelJson: null,
      maxChangedLinesPerBatch: 900,
      maxParallelBatches: null,
      maxFilesPerBatch: null,
      maxEvidenceCallsPerBatch: null,
      minReportSeverity: "P0",
    }),
    false,
    "陈旧版本不得覆盖新值",
  );
  assert.deepEqual(
    { limit: store.getGlobalSettings().maxChangedLinesPerBatch, version: store.getGlobalSettings().version },
    { limit: null, version: 2 },
  );
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
      attributions: [
        {
          model: "model-a",
          severity: FINDING.severity,
          category: FINDING.category,
          description: FINDING.description,
          impact: "",
          suggestion: "",
        },
      ],
      carried: [],
      file: FINDING.file,
      line: FINDING.line,
      severity: FINDING.severity,
      category: FINDING.category,
      description: FINDING.description,
      impact: "",
      suggestion: "",
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
