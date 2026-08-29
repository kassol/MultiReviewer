import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { reviewerPin, type ReviewerRuntimePlan } from "../src/config.ts";
import {
  modelServiceTargetFingerprint,
  openStore,
  type ModelServiceVersionCommit,
} from "../src/review/store.ts";
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


test("自动目录快照往返稀疏可信字段", () => {
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
          fieldSources: {
            name: "service-interface",
            api: "service-target",
            baseUrl: "service-target",
            input: "pi-catalog",
            reasoning: "pi-catalog",
            contextWindow: "pi-catalog",
            maxTokens: "pi-catalog",
          },
        },
        {
          identity: "corp-gateway:free-model",
          provider: "corp-gateway",
          id: "free-model",
          fields: { reasoning: false },
        },
      ],
      supplements: [],
    }),
    1,
  );

  store.close();
  const reopened = openStore(db.path);
  assert.deepEqual(reopened.getModelService("corp-gateway")!.automaticModels, [
    {
      identity: "corp-gateway:free-model",
      provider: "corp-gateway",
      id: "free-model",
      fields: { reasoning: false },
    },
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
      fieldSources: {
        name: "service-interface",
        api: "service-target",
        baseUrl: "service-target",
        input: "pi-catalog",
        reasoning: "pi-catalog",
        contextWindow: "pi-catalog",
        maxTokens: "pi-catalog",
      },
    },
  ]);
  reopened.close();
  const sqlite = new DatabaseSync(db.path, { readOnly: true });
  const idOnly = sqlite.prepare(
    `SELECT name, api, base_url, input_json, reasoning, context_window, max_tokens
       FROM model_directory_model WHERE provider = ? AND model = ?`,
  ).get("corp-gateway", "id-only-model")!;
  assert.deepEqual(
    [
      idOnly["name"],
      idOnly["api"],
      idOnly["base_url"],
      idOnly["input_json"],
      idOnly["reasoning"],
      idOnly["context_window"],
      idOnly["max_tokens"],
    ],
    [null, null, null, null, null, null, null],
    "运行基线被写成了自动发现事实",
  );
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

test("冲突自定义 provider 改名原子迁移服务、全局组合与全部仓库覆盖，历史记录不动", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  const conflicted = {
    ...availableService("openai", ["global-model", "repo-model"]),
    disabledReason: "name-conflict" as const,
  };
  assert.equal(store.commitModelServiceVersion(null, conflicted), 1);
  assert.equal(store.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "openai", model: "global-model" }]),
    maxChangedLinesPerBatch: 17,
  }), true);
  assert.equal(store.registerRepo({
    repoId: 41,
    owner: "acme",
    repo: "first",
    generation: 1,
    key: "first-key",
    reviewersJson: JSON.stringify([{ provider: "openai", model: "repo-model" }]),
  }), true);
  assert.equal(store.registerRepo({
    repoId: 42,
    owner: "acme",
    repo: "second",
    generation: 1,
    key: "second-key",
    reviewersJson: JSON.stringify([{ provider: "openai", model: "global-model" }]),
  }), true);
  store.close();

  const sqlite = new DatabaseSync(db.path);
  const run = sqlite.prepare(
    `INSERT INTO review_run
       (owner, repo, pull_number, head_sha, started_at, changed_files, changed_lines, batch_count, failed)
     VALUES (?, ?, ?, ?, ?, 1, 2, 1, 0)`,
  ).run("acme", "first", 7, "head", "2026-08-20T11:00:00.000Z");
  sqlite.prepare(
    `INSERT INTO reviewer_outcome
       (run_id, model, failure, finding_count, anomaly_count, rejected_tool_calls, duration_ms)
     VALUES (?, ?, NULL, 1, 0, 0, 23)`,
  ).run(run.lastInsertRowid, "openai:global-model");
  const finding = sqlite.prepare(
    `INSERT INTO finding
       (run_id, file, line, severity, category, description, fingerprint, group_index)
     VALUES (?, 'src/a.ts', 3, 'P1', 'correctness', 'history', 'stable-fingerprint', 0)`,
  ).run(run.lastInsertRowid);
  sqlite.prepare(
    `INSERT INTO finding_attribution
       (finding_id, position, model, severity, category, description)
     VALUES (?, 0, ?, 'P1', 'correctness', 'history')`,
  ).run(finding.lastInsertRowid, "openai:global-model");
  const historyBefore = {
    runs: sqlite.prepare("SELECT * FROM review_run").all(),
    outcomes: sqlite.prepare("SELECT * FROM reviewer_outcome").all(),
    findings: sqlite.prepare("SELECT * FROM finding").all(),
    attributions: sqlite.prepare("SELECT * FROM finding_attribution").all(),
  };
  sqlite.close();

  const reopened = openStore(db.path);
  const result = reopened.renameConflictingCustomModelService(
    "openai",
    "corp-openai",
    1,
    "2026-08-20T12:00:00.000Z",
  );
  assert.deepEqual(result, { status: "renamed", version: 2 });
  assert.equal(reopened.getModelService("openai"), undefined);
  const renamed = reopened.getModelService("corp-openai")!;
  assert.equal(renamed.version, 2);
  assert.equal(renamed.disabledReason, null);
  assert.equal(renamed.credential.validationModel, "corp-openai:global-model");
  assert.deepEqual(renamed.automaticModels.map(({ identity }) => identity), [
    "corp-openai:global-model",
    "corp-openai:repo-model",
  ]);
  assert.deepEqual(JSON.parse(reopened.getGlobalSettings().reviewersJson!), [
    { provider: "corp-openai", model: "global-model" },
  ]);
  assert.equal(reopened.getGlobalSettings().reviewersVersion, 3);
  assert.deepEqual(JSON.parse(reopened.getRepo(41)!.reviewersJson!), [
    { provider: "corp-openai", model: "repo-model" },
  ]);
  assert.deepEqual(JSON.parse(reopened.getRepo(42)!.reviewersJson!), [
    { provider: "corp-openai", model: "global-model" },
  ]);
  reopened.close();

  const history = new DatabaseSync(db.path, { readOnly: true });
  assert.deepEqual({
    runs: history.prepare("SELECT * FROM review_run").all(),
    outcomes: history.prepare("SELECT * FROM reviewer_outcome").all(),
    findings: history.prepare("SELECT * FROM finding").all(),
    attributions: history.prepare("SELECT * FROM finding_attribution").all(),
  }, historyBefore);
  history.close();
});

test("冲突 provider 改名遇到缺失引用或旧版本时完整回滚", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  assert.equal(store.commitModelServiceVersion(null, {
    ...availableService("openai", ["kept"]),
    disabledReason: "name-conflict",
  }), 1);
  const sqlite = new DatabaseSync(db.path);
  sqlite.prepare(
    "INSERT INTO global_setting (key, value) VALUES ('reviewers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify([{ provider: "openai", model: "missing" }]));
  sqlite.close();

  const before = JSON.stringify({
    service: store.getModelService("openai"),
    settings: store.getGlobalSettings(),
  });
  assert.deepEqual(
    store.renameConflictingCustomModelService("openai", "corp-openai", 1, "2026-08-20T12:00:00.000Z"),
    {
      status: "missing-models",
      references: [{
        identity: "openai:missing",
        provider: "openai",
        model: "missing",
        locations: [{ kind: "global" }],
      }],
    },
  );
  assert.equal(JSON.stringify({
    service: store.getModelService("openai"),
    settings: store.getGlobalSettings(),
  }), before);
  assert.equal(store.getModelService("corp-openai"), undefined);
  assert.deepEqual(
    store.renameConflictingCustomModelService("openai", "corp-openai", 2, "2026-08-20T12:00:00.000Z"),
    { status: "version-conflict" },
  );
  assert.deepEqual(
    store.renameConflictingCustomModelService("openai", "INVALID", 1, "2026-08-20T12:00:00.000Z"),
    { status: "invalid-provider" },
  );
  assert.equal(store.getModelService("corp-openai"), undefined);
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
    spec: { provider: "corp", model: "pinned-model", thinkingLevel: "high" },
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
      contextWindow: 128_000,
      maxTokens: 16_000,
      sources: {
        name: "trusted",
        api: "service-target",
        baseUrl: "service-target",
        input: "runtime-baseline",
        reasoning: "runtime-baseline",
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
  // 冻结快照记下这一轮用的档位:事后回看那一轮时说得出它是按哪一档跑的。
  assert.equal(persisted["thinking_level"], "high");

  const projected = store.listRuns({ limit: 1 })[0]!.reviewerPins[0]!;
  assert.equal(projected.identity, "corp:pinned-model");
  assert.equal(projected.modelServiceVersion, 9);
  assert.equal(projected.thinkingLevel, "high");
  assert.equal(projected.runtimeModel?.sources.contextWindow, "runtime-baseline");
  assert.equal(JSON.stringify(projected).includes("plaintext-reviewer-secret"), false);
  store.close();
});
