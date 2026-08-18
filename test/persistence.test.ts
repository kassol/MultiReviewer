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

/**
 * 手填的模型行(issue #87)。库是这些行唯一的真相源,派生的 `models.json` 从它整份重建,
 * 因此这张表的读写与唯一约束是整条链路的地基。
 */
test("手填的模型行按 provider 与 model id 唯一,同键二次写入是覆盖", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);

  store.putModelRow({
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    costInput: 1,
    costOutput: 2,
    contextWindow: 200_000,
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  // 同一个模型标识写第二次:改的是单价与上下文窗口,不是新增一行。
  store.putModelRow({
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    costInput: 3,
    costOutput: null,
    contextWindow: null,
    createdAt: "2026-08-19T00:00:00.000Z",
  });
  const rows = store.listModelRows();
  store.close();

  assert.deepEqual(rows, [
    {
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      costInput: 3,
      costOutput: null,
      contextWindow: null,
      // 创建时间记的是这一行什么时候被填出来,覆盖不动它。
      createdAt: "2026-08-18T00:00:00.000Z",
    },
  ]);
  // 唯一约束在表上,不是读取时去重出来的。
  assert.equal(query(db.path, "SELECT * FROM model_row").length, 1);
});

/**
 * 唯一约束的键是模型标识的两段而不是裸 model id:同一个 model id 在两家 provider 下是两个
 * 模型标识(`CONTEXT.md` 的模型标识词条),可以共存,删一个不动另一个。
 */
test("同一个 model id 在两家 provider 下各占一行,删一行不动另一行", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);

  const row = { costInput: null, costOutput: null, contextWindow: null, createdAt: "2026-08-18T00:00:00.000Z" };
  store.putModelRow({ provider: "openrouter", model: "glm-5.2", ...row });
  store.putModelRow({ provider: "deepseek", model: "glm-5.2", ...row });
  store.putModelRow({ provider: "deepseek", model: "deepseek-v4", ...row });

  // 按模型标识排序:面板一览与派生文件都按这个顺序,同一家的行挨在一起。
  assert.deepEqual(
    store.listModelRows().map((entry) => `${entry.provider}:${entry.model}`),
    ["deepseek:deepseek-v4", "deepseek:glm-5.2", "openrouter:glm-5.2"],
  );

  store.removeModelRow("deepseek", "glm-5.2");
  assert.deepEqual(
    store.listModelRows().map((entry) => `${entry.provider}:${entry.model}`),
    ["deepseek:deepseek-v4", "openrouter:glm-5.2"],
  );
  // 不存在的行删了也不抛——目标状态已达成。
  store.removeModelRow("deepseek", "glm-5.2");
  assert.equal(store.listModelRows().length, 2);
  store.close();
});

/**
 * 自定义 provider 的定义(issue #88)。名字是主键:它与 Pi 内置的那些家共用同一命名空间
 * (`CONTEXT.md` 的自定义 provider 词条),一个名字对应一个 base URL 与一把模型凭据。
 *
 * 同名二次写入直接抛,不像模型行那样是覆盖:改一家已有的 base URL 与「加一家新的」是两件
 * 事,而端点在撞名时就已经拒收了(库这一层照实反映那条约束)。
 */
test("自定义 provider 按名字唯一,同名二次写入抛", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);

  store.putCustomProvider({
    name: "corp-gateway",
    baseUrl: "https://ai.corp.example/v1",
    api: "openai-completions",
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  store.putCustomProvider({
    name: "local-vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    api: "openai-responses",
    createdAt: "2026-08-18T01:00:00.000Z",
  });

  // 按名字排序:面板一览与派生文件都按这个顺序。
  assert.deepEqual(store.listCustomProviders(), [
    {
      name: "corp-gateway",
      baseUrl: "https://ai.corp.example/v1",
      api: "openai-completions",
      createdAt: "2026-08-18T00:00:00.000Z",
    },
    {
      name: "local-vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-responses",
      createdAt: "2026-08-18T01:00:00.000Z",
    },
  ]);

  assert.throws(() =>
    store.putCustomProvider({
      name: "corp-gateway",
      baseUrl: "https://elsewhere.example/v1",
      api: "openai-completions",
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  );
  // 抛掉的那一次一个字都没写进去。
  assert.equal(store.listCustomProviders()[0]!.baseUrl, "https://ai.corp.example/v1");
  assert.equal(query(db.path, "SELECT * FROM custom_provider").length, 2);
  store.close();
});

/**
 * 摘掉一家自定义 provider 就是摘掉这一家整个:它的模型行与它那把凭据都归这个名字,留着
 * 会让派生文件里出现一家没有 `api` 也没有 `baseUrl` 的 provider(Pi 把这一家整个丢掉),
 * 凭据页上则列着一家目录里根本没有的厂商。别家的行一个都不动。
 */
test("摘掉一家自定义 provider 连它的模型行与凭据一起摘掉,别家不动", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  const at = "2026-08-18T00:00:00.000Z";

  store.putCustomProvider({
    name: "corp-gateway",
    baseUrl: "https://ai.corp.example/v1",
    api: "openai-completions",
    createdAt: at,
  });
  const blank = { costInput: null, costOutput: null, contextWindow: null, createdAt: at };
  store.putModelRow({ provider: "corp-gateway", model: "qwen3-max", ...blank });
  store.putModelRow({ provider: "corp-gateway", model: "glm-5.2", ...blank });
  store.putModelRow({ provider: "openrouter", model: "glm-5.2", ...blank });
  store.putModelCredential("corp-gateway", "cipher-corp", at, false);
  store.putModelCredential("openrouter", "cipher-openrouter", at, true);

  store.removeCustomProvider("corp-gateway");

  assert.deepEqual(store.listCustomProviders(), []);
  assert.deepEqual(
    store.listModelRows().map((row) => `${row.provider}:${row.model}`),
    ["openrouter:glm-5.2"],
  );
  assert.deepEqual(
    store.listModelCredentials().map((row) => row.provider),
    ["openrouter"],
  );
  // 不存在的那一家删了也不抛——目标状态已达成。
  store.removeCustomProvider("corp-gateway");
  store.close();
});

/**
 * 级联删除以「`custom_provider` 里真有这一条登记」为前提。名字与 Pi 内置那三十九家共用同一
 * 命名空间(`CONTEXT.md` 的自定义 provider 词条),而 `model_row` 与 `model_credential` 两张
 * 表都以 provider 名为键:不先确认登记就按名字级联,删一个从来没登记过的名字(比如
 * `DELETE <前缀>/api/custom-providers/openai`)会把内置同名那一家的模型凭据与它名下的手填
 * 模型行一起永久删掉。凭据只写不回显,删了只能重新去厂商后台取一把。
 *
 * 没有这条登记时什么都不做,并且不抛——与 `removeModelCredential` / `removeRepoKey` 同一档:
 * 目标状态已达成。
 */
test("删一个没登记过的名字:同名内置 provider 的凭据与模型行一条不少", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  const at = "2026-08-19T00:00:00.000Z";
  const blank = { costInput: null, costOutput: null, contextWindow: null, createdAt: at };

  // 内置的那一家:一把粘过的模型凭据,加一行手填的模型行。它从来没被登记成自定义 provider。
  store.putModelCredential("openai", "cipher-openai", at, true);
  store.putModelRow({ provider: "openai", model: "gpt-5-mini", ...blank });
  assert.deepEqual(store.listCustomProviders(), []);

  store.removeCustomProvider("openai");

  assert.deepEqual(
    store.listModelRows().map((row) => `${row.provider}:${row.model}`),
    ["openai:gpt-5-mini"],
    "内置那一家的手填模型行被级联删掉了",
  );
  assert.deepEqual(
    store.listModelCredentials().map((row) => ({
      provider: row.provider,
      apiKeyEncrypted: row.apiKeyEncrypted,
    })),
    [{ provider: "openai", apiKeyEncrypted: "cipher-openai" }],
    "内置那一家的模型凭据被级联删掉了",
  );
  store.close();
});

/**
 * 登记一家自定义 provider 是一个事务:定义、它的第一个模型行、那把凭据要么一起在、要么一起
 * 没有。分三句自动提交时,中途报错、进程退出或者盘满会留下一份半成品(定义在了、凭据没存上),
 * 而客户端重试会撞上「名字已被占用」被拒,补不齐——与 `registerRepo` 消除「有仓库无 Key」是
 * 同一个道理。
 *
 * 名字的唯一约束排在三句的最后一句,这里因此测得到:撞名那一刻前两张表已经写过了,回滚要把
 * 它们一起撤掉,尤其是那把凭据不能被后来这一次的密文换掉。
 */
test("登记一家自定义 provider 是一个事务:撞名那一次三张表一行都没多", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  const first = {
    name: "corp-gateway",
    baseUrl: "https://ai.corp.example/v1",
    api: "openai-completions",
    model: "corp-qwen3-max",
    apiKeyEncrypted: "cipher-first",
    verified: false,
    createdAt: "2026-08-19T00:00:00.000Z",
  };
  store.registerCustomProvider(first);

  assert.deepEqual(store.listCustomProviders(), [
    {
      name: first.name,
      baseUrl: first.baseUrl,
      api: first.api,
      createdAt: first.createdAt,
    },
  ]);
  assert.deepEqual(
    store.listModelRows().map((row) => `${row.provider}:${row.model}`),
    ["corp-gateway:corp-qwen3-max"],
  );
  assert.deepEqual(
    store.listModelCredentials().map((row) => row.apiKeyEncrypted),
    ["cipher-first"],
  );

  assert.throws(() =>
    store.registerCustomProvider({
      ...first,
      baseUrl: "https://elsewhere.example/v1",
      model: "corp-glm-5",
      apiKeyEncrypted: "cipher-second",
      createdAt: "2026-08-19T01:00:00.000Z",
    }),
  );

  // 抛掉的那一次三张表一个字都没留下。
  assert.deepEqual(
    store.listModelRows().map((row) => `${row.provider}:${row.model}`),
    ["corp-gateway:corp-qwen3-max"],
    "撞名那一次的模型行留在库里了",
  );
  assert.deepEqual(
    store.listModelCredentials().map((row) => row.apiKeyEncrypted),
    ["cipher-first"],
    "撞名那一次把已有的那把凭据换掉了",
  );
  assert.deepEqual(
    store.listCustomProviders().map((entry) => entry.baseUrl),
    [first.baseUrl],
  );
  assert.equal(query(db.path, "SELECT * FROM model_row").length, 1);
  assert.equal(query(db.path, "SELECT * FROM model_credential").length, 1);
  store.close();
});

// issue #95:Pi 内置表给 `openrouter/auto` 这类路由模型的费率是 -1000000(OpenRouter 报的
// 单价是 "-1",意思是随路由到的那个模型浮动),折算出来的这一轮成本因此是负数。库是这个数变成
// 面板上那句「花了多少」的地方,负成本在任何口径下都不是事实。
test("负成本按零落库,同一轮里别的模型那份照实记", async () => {
  const { cache, db, forge } = setup();

  const negative: ReviewerUsage = {
    inputTokens: 120,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 160,
    costUsd: -0.9,
  };
  const priced: ReviewerUsage = { ...negative, costUsd: 0.25 };

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("openrouter:openrouter/auto", [FINDING], { usage: negative }),
      scriptedReviewer("deepseek:deepseek-v4-flash", [FINDING], { usage: priced }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.deepEqual(
    query(db.path, "SELECT model, cost_usd FROM reviewer_outcome ORDER BY model").map((row) => [
      row["model"],
      row["cost_usd"],
    ]),
    [
      ["deepseek:deepseek-v4-flash", 0.25],
      ["openrouter:openrouter/auto", 0],
    ],
  );
  // 整轮的合计对负那一份也按零算:先加再截会把正的那一份一起吃掉。
  assert.equal(query(db.path, "SELECT cost_usd FROM review_run")[0]!["cost_usd"], 0.25);
});
