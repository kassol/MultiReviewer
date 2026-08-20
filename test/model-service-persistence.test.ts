import assert from "node:assert/strict";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { reviewerPin, type ReviewerRuntimePlan } from "../src/config.ts";
import { encryptCredential } from "../src/panel/credential-crypto.ts";
import {
  acknowledgeModelServiceMigration,
  migrateModelServiceDatabase,
  MODEL_SERVICE_SCHEMA_VERSION,
  modelServiceTargetFingerprint,
  readPendingModelServiceMigration,
} from "../src/review/model-service-migration.ts";
import { openStore, type ModelServiceVersionCommit } from "../src/review/store.ts";
import { makeDbPath } from "./support/git-fixture.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function availableService(
  provider: string,
  models: readonly string[],
  ciphertext = `ciphertext-${provider}`,
  baseUrl = `https://${provider}.example.test/v1`,
): ModelServiceVersionCommit {
  const committedAt = "2026-08-20T10:00:00.000Z";
  return {
    provider,
    type: "custom",
    baseUrl,
    api: "openai-completions",
    targetFingerprint: modelServiceTargetFingerprint(baseUrl, "openai-completions"),
    disabledReason: null,
    createdAt: committedAt,
    updatedAt: committedAt,
    credential: {
      state: "verified",
      apiKeyEncrypted: ciphertext,
      updatedAt: committedAt,
      verifiedAt: committedAt,
      validationModel: `${provider}:${models[0] ?? "validation"}`,
      verificationSource: "inference",
    },
    directory: {
      state: "available",
      lastAttemptAt: committedAt,
      lastSuccessAt: committedAt,
      failure: null,
      ignoredModelCount: 0,
    },
    automaticModels: models.map((model) => ({
      identity: `${provider}:${model}`,
      provider,
      id: model,
      fields: {},
    })),
    supplements: [],
  };
}


function tableExists(dbPath: string, table: string): boolean {
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) !== undefined;
  } finally {
    sqlite.close();
  }
}

function createLegacyFixture(): {
  path: string;
  cleanup(): void;
  globalReviewers: string;
  repoReviewers: string;
  plaintexts: string[];
  ciphertexts: string[];
} {
  const fixture = makeDbPath();
  const sqlite = new DatabaseSync(fixture.path);
  sqlite.exec(`
    PRAGMA user_version = 0;
    CREATE TABLE custom_provider (
      name TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      api TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE model_credential (
      provider TEXT PRIMARY KEY,
      api_key_encrypted TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified INTEGER NOT NULL
    );
    CREATE TABLE model_row (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cost_input REAL,
      cost_output REAL,
      context_window INTEGER,
      max_output_tokens INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, model)
    );
    CREATE TABLE global_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE repo (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      reviewers TEXT,
      registered_at TEXT NOT NULL
    );
    CREATE TABLE review_run (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      changed_files INTEGER NOT NULL,
      changed_lines INTEGER NOT NULL,
      batch_count INTEGER NOT NULL
    );
    CREATE TABLE reviewer_outcome (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      failure TEXT
    );
  `);

  const at = {
    created: "2026-08-18T00:00:00.000Z",
    credential: "2026-08-18T01:00:00.000Z",
    successfulRun: "2026-08-18T02:00:00.000Z",
  };
  const custom = sqlite.prepare(
    "INSERT INTO custom_provider (name, base_url, api, created_at) VALUES (?, ?, ?, ?)",
  );
  custom.run("corp-gateway", "https://ai.corp.example/v1/", "openai-completions", at.created);
  // 模拟后来 Pi 新增同名内置 provider：旧库里这条登记本身完全合法。
  custom.run("openai", "https://old-openai-gateway.example/v1", "openai-responses", at.created);
  custom.run("no-key-custom", "https://no-key.example/v1", "openai-completions", at.created);

  const masterKey = "migration-master-key";
  const plaintexts = ["corp-secret-1001", "openai-secret-2002", "router-secret-3003"];
  const ciphertexts = plaintexts.map((secret) => encryptCredential(masterKey, secret));
  const credential = sqlite.prepare(
    `INSERT INTO model_credential
       (provider, api_key_encrypted, updated_at, verified) VALUES (?, ?, ?, ?)`,
  );
  credential.run("corp-gateway", ciphertexts[0]!, at.credential, 0);
  credential.run("openai", ciphertexts[1]!, at.credential, 1);
  credential.run("openrouter", ciphertexts[2]!, at.credential, 0);
  credential.run("broken", "not-a-decryptable-ciphertext", at.credential, 1);

  const modelRow = sqlite.prepare(
    `INSERT INTO model_row
       (provider, model, cost_input, cost_output, context_window, max_output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  modelRow.run("corp-gateway", "qwen3-max", 1, 2, 200_000, 16_000, at.created);
  modelRow.run("openai", "legacy-model", null, null, null, 4096, at.created);
  modelRow.run("openrouter", "route-model", null, null, null, null, at.created);
  modelRow.run("vanished", "ghost-model", null, 5, null, null, at.created);

  const globalReviewers = JSON.stringify([
    { provider: "corp-gateway", model: "qwen3-max" },
    { provider: "openrouter", model: "route-model" },
    { provider: "missing", model: "combo-only" },
  ]);
  const repoReviewers = JSON.stringify([
    { provider: "openai", model: "legacy-model" },
    { provider: "vanished", model: "ghost-model" },
    { provider: "missing", model: "combo-only" },
  ]);
  sqlite.prepare("INSERT INTO global_setting (key, value) VALUES ('reviewers', ?)").run(
    globalReviewers,
  );
  const repo = sqlite.prepare(
    "INSERT INTO repo (id, owner, repo, reviewers, registered_at) VALUES (?, ?, ?, ?, ?)",
  );
  repo.run(1, "acme", "follows-global", null, at.created);
  repo.run(2, "acme", "explicit", repoReviewers, at.created);

  sqlite.prepare(
    `INSERT INTO review_run
       (id, owner, repo, pull_number, head_sha, started_at, finished_at,
        changed_files, changed_lines, batch_count)
     VALUES (1, 'acme', 'fixture', 1, 'legacy-head', ?, ?, 1, 2, 1)`,
  ).run(at.created, at.successfulRun);
  const outcome = sqlite.prepare(
    "INSERT INTO reviewer_outcome (id, run_id, model, failure) VALUES (?, 1, ?, null)",
  );
  outcome.run(1, "corp-gateway:qwen3-max");
  // 内置 provider 的成功旧 Run 不能证明升级后的 Pi 目标相同，仍须待重新验证。
  outcome.run(2, "openrouter:route-model");
  sqlite.close();

  return {
    path: fixture.path,
    cleanup: fixture.cleanup,
    globalReviewers,
    repoReviewers,
    plaintexts,
    ciphertexts: [...ciphertexts, "not-a-decryptable-ciphertext"],
  };
}
test("自动目录快照往返稀疏可信字段，并区分未知价格与可信零价格", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);

  assert.equal(
    store.commitModelServiceVersion(null, {
      provider: "corp-gateway",
      type: "custom",
      baseUrl: "https://ai.corp.example/v1",
      api: "openai-completions",
      targetFingerprint: "target-fingerprint-v1",
      disabledReason: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:01:00.000Z",
      credential: {
        state: "verified",
        apiKeyEncrypted: "cipher-v1",
        updatedAt: "2026-08-20T00:01:00.000Z",
        verifiedAt: "2026-08-20T00:01:30.000Z",
        validationModel: "corp-gateway:free-model",
        verificationSource: "inference",
      },
      directory: {
        state: "available",
        lastAttemptAt: "2026-08-20T00:01:10.000Z",
        lastSuccessAt: "2026-08-20T00:01:10.000Z",
        failure: null,
        ignoredModelCount: 0,
      },
      automaticModels: [
        {
          identity: "corp-gateway:id-only-model",
          provider: "corp-gateway",
          id: "id-only-model",
          fields: {},
        },
        {
          identity: "corp-gateway:sparse-model",
          provider: "corp-gateway",
          id: "sparse-model",
          fields: {
            name: "Sparse Model",
            api: "openai-responses",
            baseUrl: "https://catalog.example/v1",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 32_000,
            maxTokens: 4096,
          },
        },
        {
          identity: "corp-gateway:free-model",
          provider: "corp-gateway",
          id: "free-model",
          fields: {
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          identity: "corp-gateway:negative-price",
          provider: "corp-gateway",
          id: "negative-price",
          fields: {
            name: "Negative price is not trusted",
            cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          identity: "corp-gateway:non-finite-price",
          provider: "corp-gateway",
          id: "non-finite-price",
          fields: {
            name: "Non-finite price is not trusted",
            cost: { input: 0, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
      supplements: [],
    }),
    1,
  );

  assert.deepEqual(store.getModelService("corp-gateway")!.automaticModels, [
    {
      identity: "corp-gateway:free-model",
      provider: "corp-gateway",
      id: "free-model",
      fields: {
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    {
      identity: "corp-gateway:id-only-model",
      provider: "corp-gateway",
      id: "id-only-model",
      fields: {},
    },
    {
      identity: "corp-gateway:negative-price",
      provider: "corp-gateway",
      id: "negative-price",
      fields: { name: "Negative price is not trusted" },
    },
    {
      identity: "corp-gateway:non-finite-price",
      provider: "corp-gateway",
      id: "non-finite-price",
      fields: { name: "Non-finite price is not trusted" },
    },
    {
      identity: "corp-gateway:sparse-model",
      provider: "corp-gateway",
      id: "sparse-model",
      fields: {
        name: "Sparse Model",
        api: "openai-responses",
        baseUrl: "https://catalog.example/v1",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 32_000,
        maxTokens: 4096,
      },
    },
  ]);
  store.close();
  const sqlite = new DatabaseSync(db.path, { readOnly: true });
  const idOnly = sqlite.prepare(
    `SELECT name, api, base_url, input_json, reasoning, cost_json, context_window, max_tokens
       FROM model_directory_model WHERE provider = ? AND model = ?`,
  ).get("corp-gateway", "id-only-model")!;
  assert.deepEqual(
    [
      idOnly["name"],
      idOnly["api"],
      idOnly["base_url"],
      idOnly["input_json"],
      idOnly["reasoning"],
      idOnly["cost_json"],
      idOnly["context_window"],
      idOnly["max_tokens"],
    ],
    [null, null, null, null, null, null, null, null],
    "运行基线被写成了自动发现事实",
  );
  const prices = sqlite.prepare(
    `SELECT model, cost_json FROM model_directory_model
      WHERE provider = ? AND model IN ('free-model', 'negative-price', 'non-finite-price')
      ORDER BY model`,
  ).all("corp-gateway");
  assert.deepEqual(JSON.parse(String(prices[0]!["cost_json"])), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(prices[1]!["cost_json"], null);
  assert.equal(prices[2]!["cost_json"], null);
  sqlite.close();
});

test("模型服务当前版本把目标、凭据证据、目录与补录作为一个原子快照保存", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);

  const committed = store.commitModelServiceVersion(null, {
    provider: "corp-gateway",
    type: "custom",
    baseUrl: "https://ai.corp.example/v1",
    api: "openai-completions",
    targetFingerprint: "target-fingerprint-v1",
    disabledReason: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
    credential: {
      state: "verified",
      apiKeyEncrypted: "cipher-v1",
      updatedAt: "2026-08-20T00:01:00.000Z",
      verifiedAt: "2026-08-20T00:01:30.000Z",
      validationModel: "corp-gateway:qwen3-max",
      verificationSource: "inference",
    },
    directory: {
      state: "available",
      lastAttemptAt: "2026-08-20T00:01:10.000Z",
      lastSuccessAt: "2026-08-20T00:01:10.000Z",
      failure: null,
      ignoredModelCount: 2,
    },
    automaticModels: [
      {
        identity: "corp-gateway:qwen3-max",
        provider: "corp-gateway",
        id: "qwen3-max",
        fields: {},
      },
      {
        identity: "corp-gateway:glm-5",
        provider: "corp-gateway",
        id: "glm-5",
        fields: {},
      },
    ],
    supplements: [
      {
        model: "qwen3-max",
        source: "manual",
        targetFingerprint: "target-fingerprint-v1",
        createdAt: "2026-08-20T00:01:30.000Z",
      },
    ],
  });

  assert.equal(committed, 1);
  assert.deepEqual(store.getModelService("corp-gateway"), {
    provider: "corp-gateway",
    type: "custom",
    version: 1,
    baseUrl: "https://ai.corp.example/v1",
    api: "openai-completions",
    targetFingerprint: "target-fingerprint-v1",
    disabledReason: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
    credential: {
      state: "verified",
      apiKeyEncrypted: "cipher-v1",
      updatedAt: "2026-08-20T00:01:00.000Z",
      verifiedAt: "2026-08-20T00:01:30.000Z",
      validationModel: "corp-gateway:qwen3-max",
      verificationSource: "inference",
    },
    directory: {
      state: "available",
      lastAttemptAt: "2026-08-20T00:01:10.000Z",
      lastSuccessAt: "2026-08-20T00:01:10.000Z",
      failure: null,
      ignoredModelCount: 2,
    },
    automaticModels: [
      {
        identity: "corp-gateway:glm-5",
        provider: "corp-gateway",
        id: "glm-5",
        fields: {},
      },
      {
        identity: "corp-gateway:qwen3-max",
        provider: "corp-gateway",
        id: "qwen3-max",
        fields: {},
      },
    ],
    supplements: [
      {
        provider: "corp-gateway",
        model: "qwen3-max",
        source: "manual",
        targetFingerprint: "target-fingerprint-v1",
        createdAt: "2026-08-20T00:01:30.000Z",
      },
    ],
  });
  store.close();
});

test("旧版本候选不写入，匹配版本时整份快照推进并替换目录来源", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  const first = {
    provider: "openrouter",
    type: "builtin" as const,
    baseUrl: null,
    api: null,
    targetFingerprint: "pi-target-v1",
    disabledReason: null,
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T01:00:00.000Z",
    credential: {
      state: "pending-reverification" as const,
      apiKeyEncrypted: "cipher-old",
      updatedAt: "2026-08-20T01:00:00.000Z",
      verifiedAt: null,
      validationModel: null,
      verificationSource: null,
    },
    directory: {
      state: "discovery-failed" as const,
      lastAttemptAt: "2026-08-20T01:00:10.000Z",
      lastSuccessAt: null,
      failure: "503 unavailable",
      ignoredModelCount: 0,
    },
    automaticModels: [] as const,
    supplements: [
      {
        model: "old-model",
        source: "migration-retention" as const,
        targetFingerprint: null,
        createdAt: "2026-08-20T01:00:00.000Z",
      },
    ],
  };
  assert.throws(
    () =>
      store.commitModelServiceVersion(null, {
        ...first,
        automaticModels: [
          { identity: "openrouter:duplicate", provider: "openrouter", id: "duplicate", fields: {} },
          { identity: "openrouter:duplicate", provider: "openrouter", id: "duplicate", fields: {} },
        ],
      }),
    /空、重复或身份不一致/,
  );
  assert.equal(store.getModelService("openrouter"), undefined);
  assert.equal(store.commitModelServiceVersion(null, first), 1);

  const second = {
    ...first,
    createdAt: "should-not-replace-original-creation-time",
    updatedAt: "2026-08-20T02:00:00.000Z",
    credential: {
      state: "verified" as const,
      apiKeyEncrypted: "cipher-new",
      updatedAt: "2026-08-20T02:00:00.000Z",
      verifiedAt: "2026-08-20T02:00:30.000Z",
      validationModel: "openrouter:new-model",
      verificationSource: "inference" as const,
    },
    directory: {
      state: "available" as const,
      lastAttemptAt: "2026-08-20T02:00:10.000Z",
      lastSuccessAt: "2026-08-20T02:00:10.000Z",
      failure: null,
      ignoredModelCount: 0,
    },
    automaticModels: [
      {
        identity: "openrouter:new-model",
        provider: "openrouter",
        id: "new-model",
        fields: {},
      },
    ] as const,
    supplements: [
      {
        model: "new-model",
        source: "manual" as const,
        targetFingerprint: "pi-target-v1",
        createdAt: "2026-08-20T02:00:30.000Z",
      },
    ],
  };
  assert.equal(store.commitModelServiceVersion(0, second), undefined);
  assert.equal(store.getModelService("openrouter")!.version, 1);
  assert.deepEqual(store.getModelService("openrouter")!.automaticModels, []);

  assert.equal(store.commitModelServiceVersion(1, second), 2);
  const current = store.getModelService("openrouter")!;
  assert.equal(current.version, 2);
  assert.equal(current.createdAt, first.createdAt);
  assert.equal(current.credential.apiKeyEncrypted, "cipher-new");
  assert.deepEqual(current.automaticModels, [
    {
      identity: "openrouter:new-model",
      provider: "openrouter",
      id: "new-model",
      fields: {},
    },
  ]);
  assert.deepEqual(current.supplements.map((entry) => entry.model), ["new-model"]);
  store.close();
});

test("真实旧库先留唯一备份，再按证据与来源优先级一次迁入并可重试确认", async () => {
  const fixture = createLegacyFixture();
  cleanups.push(fixture.cleanup);
  const occupiedBackup = `${fixture.path}.pre-model-service-v${MODEL_SERVICE_SCHEMA_VERSION}.sqlite`;
  writeFileSync(occupiedBackup, "existing backup must survive", { mode: 0o600 });

  const migrated = await migrateModelServiceDatabase({
    dbPath: fixture.path,
    credentialMasterKey: "migration-master-key",
    builtinProviderNames: new Set(["openai", "openrouter", "broken"]),
  });
  assert.equal(migrated.status, "migrated");
  if (migrated.status !== "migrated") return;
  assert.deepEqual(migrated.summary, {
    schemaVersion: MODEL_SERVICE_SCHEMA_VERSION,
    backupPath: `${occupiedBackup}.1`,
    modelServices: 5,
    verifiedCredentials: 2,
    pendingCredentials: 1,
    unconfiguredCredentials: 2,
    manualSupplements: 2,
    migrationRetentions: 3,
    globalCombinationModels: 3,
    repositoryOverrides: 1,
    discardedLegacyModelFactRows: 3,
  });
  assert.equal(readFileSync(occupiedBackup, "utf8"), "existing backup must survive");

  const backup = new DatabaseSync(migrated.summary.backupPath, { readOnly: true });
  assert.equal(
    Number((backup.prepare("SELECT COUNT(*) AS c FROM custom_provider").get()!)["c"]),
    3,
  );
  assert.equal(Number(backup.prepare("PRAGMA user_version").get()!["user_version"]), 0);
  backup.close();

  const sqlite = new DatabaseSync(fixture.path, { readOnly: true });
  assert.equal(Number(sqlite.prepare("PRAGMA user_version").get()!["user_version"]), 1);
  assert.equal(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_row'").get(),
    undefined,
  );
  assert.equal(
    sqlite.prepare("SELECT value FROM global_setting WHERE key <> 'reviewers'").all().length,
    1,
    "一次性摘要标记没有留在库里",
  );
  assert.equal(
    String(sqlite.prepare("SELECT value FROM global_setting WHERE key = 'reviewers'").get()!["value"]),
    fixture.globalReviewers,
  );
  const repos = sqlite.prepare("SELECT id, reviewers FROM repo ORDER BY id").all();
  assert.equal(repos[0]!["reviewers"], null);
  assert.equal(repos[1]!["reviewers"], fixture.repoReviewers);
  const supplementColumns = sqlite.prepare("PRAGMA table_info(model_supplement)").all()
    .map((row) => String(row["name"]));
  assert.equal(supplementColumns.includes("cost_input"), false);
  assert.equal(supplementColumns.includes("cost_output"), false);
  assert.equal(supplementColumns.includes("context_window"), false);
  assert.equal(supplementColumns.includes("max_output_tokens"), false);
  sqlite.close();

  const store = openStore(fixture.path);
  const services = store.listModelServices();
  assert.deepEqual(services.map((entry) => entry.provider), [
    "broken",
    "corp-gateway",
    "no-key-custom",
    "openai",
    "openrouter",
  ]);
  assert.ok(services.every((entry) => entry.version === 1));
  assert.ok(services.every((entry) => entry.directory.state === "undiscovered"));

  const corp = store.getModelService("corp-gateway")!;
  assert.equal(corp.credential.state, "verified");
  assert.equal(corp.credential.verificationSource, "legacy-review-run");
  assert.equal(corp.credential.validationModel, "corp-gateway:qwen3-max");
  assert.equal(corp.credential.verifiedAt, "2026-08-18T02:00:00.000Z");
  assert.equal(
    corp.targetFingerprint,
    modelServiceTargetFingerprint("https://ai.corp.example/v1/", "openai-completions"),
  );

  const collided = store.getModelService("openai")!;
  assert.equal(collided.type, "custom");
  assert.equal(collided.disabledReason, "name-conflict");
  assert.equal(collided.credential.state, "verified");
  assert.equal(collided.credential.verificationSource, "legacy-provider-check");

  const builtin = store.getModelService("openrouter")!;
  assert.equal(builtin.type, "builtin");
  assert.equal(builtin.baseUrl, null);
  assert.equal(builtin.api, null);
  assert.equal(builtin.credential.state, "pending-reverification");
  const broken = store.getModelService("broken")!;
  assert.equal(broken.credential.state, "unconfigured");
  assert.equal(broken.credential.apiKeyEncrypted, null);
  assert.equal(store.getModelService("no-key-custom")!.credential.state, "unconfigured");

  assert.deepEqual(
    store.listModelSupplements().map((entry) => ({
      identity: `${entry.provider}:${entry.model}`,
      source: entry.source,
      fingerprint: entry.targetFingerprint,
    })),
    [
      {
        identity: "corp-gateway:qwen3-max",
        source: "manual",
        fingerprint: corp.targetFingerprint,
      },
      { identity: "missing:combo-only", source: "migration-retention", fingerprint: null },
      {
        identity: "openai:legacy-model",
        source: "manual",
        fingerprint: collided.targetFingerprint,
      },
      {
        identity: "openrouter:route-model",
        source: "migration-retention",
        fingerprint: null,
      },
      {
        identity: "vanished:ghost-model",
        source: "migration-retention",
        fingerprint: null,
      },
    ],
  );
  store.close();
  assert.equal(tableExists(fixture.path, "model_row"), false, "openStore 把已删除的旧表建回来了");

  const marker = readPendingModelServiceMigration(fixture.path);
  assert.deepEqual(marker, migrated.summary);
  const publicSummary = JSON.stringify({ migrated, marker });
  for (const secret of [...fixture.plaintexts, ...fixture.ciphertexts]) {
    assert.equal(publicSummary.includes(secret), false, "摘要泄露了凭据或密文");
  }

  const retried = await migrateModelServiceDatabase({
    dbPath: fixture.path,
    credentialMasterKey: "migration-master-key",
    builtinProviderNames: new Set(["openai", "openrouter", "broken"]),
  });
  assert.deepEqual(retried, { status: "projection-pending", summary: migrated.summary });
  const backups = readdirSync(dirname(fixture.path)).filter((name) =>
    name.startsWith(`${fixture.path.split("/").at(-1)}.pre-model-service-v`),
  );
  assert.equal(backups.length, 2, "重试又建了一份备份");

  acknowledgeModelServiceMigration(fixture.path);
  assert.equal(readPendingModelServiceMigration(fixture.path), undefined);
  assert.deepEqual(
    await migrateModelServiceDatabase({
      dbPath: fixture.path,
      credentialMasterKey: "migration-master-key",
      builtinProviderNames: new Set(["openai", "openrouter", "broken"]),
    }),
    { status: "current" },
  );
});

test("旧库缺少后期模型字段时仍迁移，并只统计实际存在的旧事实", async () => {
  const fixture = createLegacyFixture();
  cleanups.push(fixture.cleanup);
  const sqlite = new DatabaseSync(fixture.path);
  sqlite.exec("ALTER TABLE model_row DROP COLUMN max_output_tokens");
  sqlite.close();

  const migrated = await migrateModelServiceDatabase({
    dbPath: fixture.path,
    credentialMasterKey: "migration-master-key",
    builtinProviderNames: new Set(["openai", "openrouter", "broken"]),
  });
  assert.equal(migrated.status, "migrated");
  if (migrated.status !== "migrated") return;
  assert.equal(migrated.summary.discardedLegacyModelFactRows, 2);
});

test("仓库覆盖 JSON 非法时整个迁移回滚，旧库与组合原样可读", async () => {
  const fixture = createLegacyFixture();
  cleanups.push(fixture.cleanup);
  const sqlite = new DatabaseSync(fixture.path);
  sqlite.prepare("UPDATE repo SET reviewers = '{bad json' WHERE id = 2").run();
  sqlite.close();

  await assert.rejects(
    migrateModelServiceDatabase({
      dbPath: fixture.path,
      credentialMasterKey: "migration-master-key",
      builtinProviderNames: new Set(["openai", "openrouter", "broken"]),
    }),
    /仓库 acme\/explicit.*不是合法 JSON/,
  );

  const afterFailure = new DatabaseSync(fixture.path, { readOnly: true });
  assert.equal(Number(afterFailure.prepare("PRAGMA user_version").get()!["user_version"]), 0);
  assert.equal(Number(afterFailure.prepare("SELECT COUNT(*) AS c FROM model_row").get()!["c"]), 4);
  assert.equal(
    String(afterFailure.prepare("SELECT value FROM global_setting WHERE key = 'reviewers'").get()!["value"]),
    fixture.globalReviewers,
  );
  assert.equal(
    afterFailure.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_service'",
    ).get(),
    undefined,
    "事务里创建的新 schema 没有回滚",
  );
  afterFailure.close();
});

test("迁移前备份无法创建时不开始事务，旧数据库不变", async () => {
  const fixture = createLegacyFixture();
  cleanups.push(fixture.cleanup);
  const parent = dirname(fixture.path);
  chmodSync(parent, 0o500);
  try {
    await assert.rejects(
      migrateModelServiceDatabase({
        dbPath: fixture.path,
        credentialMasterKey: "migration-master-key",
        builtinProviderNames: new Set(["openai", "openrouter", "broken"]),
      }),
      /无法为模型服务迁移创建唯一备份文件/,
    );
  } finally {
    chmodSync(parent, 0o700);
  }

  const unchanged = new DatabaseSync(fixture.path, { readOnly: true });
  assert.equal(Number(unchanged.prepare("PRAGMA user_version").get()!["user_version"]), 0);
  assert.equal(Number(unchanged.prepare("SELECT COUNT(*) AS c FROM custom_provider").get()!["c"]), 3);
  assert.equal(Number(unchanged.prepare("SELECT COUNT(*) AS c FROM model_row").get()!["c"]), 4);
  unchanged.close();
});

test("模型引用按完整身份列出全局、显式覆盖与跟随全局位置", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  assert.equal(store.commitModelServiceVersion(null, availableService("alpha", ["global", "shared"])), 1);
  assert.equal(store.commitModelServiceVersion(null, availableService("beta", ["override"])), 1);
  store.putGlobalSettings({
    reviewersJson: JSON.stringify([
      { provider: "alpha", model: "global" },
      { provider: "alpha", model: "shared" },
    ]),
    maxChangedLinesPerBatch: null,
  });
  store.registerRepo({
    repoId: 1,
    owner: "acme",
    repo: "follows-global",
    generation: 1,
    key: "follow-key",
  });
  store.registerRepo({
    repoId: 2,
    owner: "acme",
    repo: "explicit",
    generation: 1,
    key: "explicit-key",
    reviewersJson: JSON.stringify([
      { provider: "alpha", model: "shared" },
      { provider: "beta", model: "override" },
    ]),
  });
  store.registerRepo({
    repoId: 3,
    owner: "acme",
    repo: "removed",
    generation: 1,
    key: "removed-key",
  });
  store.removeRepo(3);

  assert.deepEqual(store.listModelReferences(), [
    {
      identity: "alpha:global",
      provider: "alpha",
      model: "global",
      locations: [
        { kind: "global" },
        { kind: "following-global", repositoryCount: 1 },
      ],
    },
    {
      identity: "alpha:shared",
      provider: "alpha",
      model: "shared",
      locations: [
        { kind: "global" },
        { kind: "following-global", repositoryCount: 1 },
        {
          kind: "repository-override",
          repoId: 2,
          owner: "acme",
          repo: "explicit",
        },
      ],
    },
    {
      identity: "beta:override",
      provider: "beta",
      model: "override",
      locations: [
        {
          kind: "repository-override",
          repoId: 2,
          owner: "acme",
          repo: "explicit",
        },
      ],
    },
  ]);
  store.close();
});

test("Review Run 启动快照只读生效组合引用的服务密文,后续读取才看见新版本", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);

  store.registerRepo({
    repoId: 7,
    owner: "acme",
    repo: "widgets",
    generation: 1,
    key: "hook-key",
  });
  assert.equal(
    store.commitModelServiceVersion(
      null,
      availableService(
        "used",
        ["m1"],
        "ciphertext-used-v1",
        "https://used-v1.example.test/v1",
      ),
    ),
    1,
  );
  assert.equal(
    store.commitModelServiceVersion(
      null,
      availableService(
        "unused",
        ["other"],
        "ciphertext-must-not-cross-boundary",
        "https://unused.example.test/v1",
      ),
    ),
    1,
  );
  assert.equal(store.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "used", model: "m1" }]),
    maxChangedLinesPerBatch: 17,
  }), true);

  const first = store.getReviewRunSnapshot(7);
  assert.deepEqual(first.reviewers, [{ provider: "used", model: "m1" }]);
  assert.equal(first.maxChangedLinesPerBatch, 17);
  assert.equal(first.modelServices.length, 1);
  assert.equal(first.modelServices[0]!.version, 1);
  assert.equal(first.modelServices[0]!.credential.apiKeyEncrypted, "ciphertext-used-v1");
  assert.equal(JSON.stringify(first).includes("ciphertext-must-not-cross-boundary"), false);

  assert.equal(
    store.commitModelServiceVersion(
      1,
      availableService(
        "used",
        ["m1"],
        "ciphertext-used-v2",
        "https://used-v2.example.test/v1",
      ),
    ),
    2,
  );
  store.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "used", model: "m1" }]),
    maxChangedLinesPerBatch: 999,
  });

  assert.equal(first.modelServices[0]!.version, 1, "已返回的快照被当前服务切版改写了");
  assert.equal(first.maxChangedLinesPerBatch, 17);
  const second = store.getReviewRunSnapshot(7);
  assert.equal(second.modelServices[0]!.version, 2);
  assert.equal(second.modelServices[0]!.credential.apiKeyEncrypted, "ciphertext-used-v2");

  assert.equal(second.maxChangedLinesPerBatch, 999);
  store.close();
});

test("两个 Store handle 交错时组合写与服务来源删除互相原子阻断", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const first = openStore(db.path);
  const second = openStore(db.path);
  try {
    assert.equal(
      first.commitModelServiceVersion(null, availableService("race", ["kept", "removed"])),
      1,
    );
    const staleVersion = first.getModelService("race")!.version;
    assert.equal(
      second.commitModelServiceVersion(
        staleVersion,
        availableService("race", ["kept"], "ciphertext-race-v2"),
      ),
      2,
    );

    const removedCombination = JSON.stringify([{ provider: "race", model: "removed" }]);
    assert.equal(first.putGlobalSettings({
      reviewersJson: removedCombination,
      maxChangedLinesPerBatch: 17,
    }), false, "服务先切版后，旧候选不能写进全局组合");
    assert.equal(first.getGlobalSettings().reviewersJson, null);
    assert.equal(first.registerRepo({
      repoId: 91,
      owner: "acme",
      repo: "rejected-registration",
      generation: 1,
      key: "rejected-key",
      reviewersJson: removedCombination,
    }), false, "注册覆盖与首把 Key 都不能留下");
    assert.equal(first.getRepo(91), undefined);

    assert.equal(first.registerRepo({
      repoId: 92,
      owner: "acme",
      repo: "override-race",
      generation: 1,
      key: "accepted-key",
    }), true);
    assert.equal(first.setRepoReviewers(92, removedCombination), false);
    assert.equal(first.getRepo(92)!.reviewersJson, null);

    const keptCombination = JSON.stringify([{ provider: "race", model: "kept" }]);
    assert.equal(first.putGlobalSettings({
      reviewersJson: keptCombination,
      maxChangedLinesPerBatch: 17,
    }), true);
    const current = second.getModelService("race")!;
    assert.equal(
      second.commitModelServiceVersion(
        current.version,
        availableService("race", [], "ciphertext-race-v3"),
      ),
      undefined,
      "组合先落库后，来源删除即使版本仍匹配也必须整笔回滚",
    );
    assert.equal(second.getModelService("race")!.version, 2);
    assert.equal(second.removeCustomModelService("race", 2), false);
    assert.equal(second.getModelService("race")!.version, 2);
  } finally {
    second.close();
    first.close();
  }
});

test("Review Run 审计只持久化服务版本与运行模型,不落凭据、密文或主密钥", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  const plan: ReviewerRuntimePlan = {
    spec: { provider: "corp", model: "pinned-model" },
    modelServiceVersion: 9,
    target: { api: "openai-completions", baseUrl: "https://pinned.example.test/v1" },
    runtimeModel: {
      provider: "corp",
      id: "pinned-model",
      name: "Pinned Model",
      api: "openai-completions",
      baseUrl: "https://pinned.example.test/v1",
      input: ["text"],
      reasoning: false,
      cost: undefined,
      contextWindow: 128_000,
      maxTokens: 16_000,
      sources: {
        name: "trusted",
        api: "service-target",
        baseUrl: "service-target",
        input: "runtime-baseline",
        reasoning: "runtime-baseline",
        cost: "unknown",
        contextWindow: "runtime-baseline",
        maxTokens: "runtime-baseline",
      },
    },
    credential: "plaintext-reviewer-secret",
    failure: null,
  };
  store.startRun({
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    headSha: "abc123",
    startedAt: "2026-08-20T11:00:00.000Z",
    changedFiles: 1,
    changedLines: 2,
    batchCount: 1,
    reviewerPins: [reviewerPin(plan)],
  });

  const sqlite = new DatabaseSync(db.path, { readOnly: true });
  const persisted = sqlite.prepare("SELECT * FROM review_run_reviewer_pin").get()!;
  sqlite.close();
  const serialized = JSON.stringify(persisted);
  assert.equal(serialized.includes("plaintext-reviewer-secret"), false);
  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("master-key"), false);
  assert.equal(persisted["model_service_version"], 9);
  assert.equal(persisted["base_url"], "https://pinned.example.test/v1");

  const projected = store.listRuns({ limit: 1 })[0]!.reviewerPins[0]!;
  assert.equal(projected.identity, "corp:pinned-model");
  assert.equal(projected.modelServiceVersion, 9);
  assert.equal(projected.runtimeModel?.sources.cost, "unknown");
  assert.equal(JSON.stringify(projected).includes("plaintext-reviewer-secret"), false);
  store.close();
});
