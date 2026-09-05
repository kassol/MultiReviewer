/**
 * 审查策略端点(issue #145)。模型组合与批次上限都在库里,面板是唯一的配置面,
 * 没有配置文件与之竞争。走 panel harness 的真实 HTTP 缝。
 *
 * 「空库没配组合」那一条测在既有的 runReview 集成缝上:harness 注入的
 * `buildReviewers` 就是服务真用的那一个入口,这里传真实实现。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { buildReviewers } from "../src/config.ts";
import {
  DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  DEFAULT_MAX_FILES_PER_BATCH,
  DEFAULT_MAX_PARALLEL_BATCHES,
} from "../src/review/batch.ts";
import { openStore } from "../src/review/store.ts";
import { EVIDENCE_SESSION_BUDGET } from "../src/reviewer/evidence.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  seedAvailableModelService,
  seedHistoricalRepo,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type SettingsBody = {
  reviewers: { provider: string; model: string; thinkingLevel?: string }[];
  reviewersVersion: number;
  maxChangedLinesPerBatch: number;
  maxChangedLinesPerBatchSource: "default" | "custom";
  maxChangedLinesPerBatchVersion: number;
  maxParallelBatches: number;
  maxParallelBatchesSource: "default" | "custom";
  maxParallelBatchesVersion: number;
  maxFilesPerBatch: number;
  maxFilesPerBatchSource: "default" | "custom";
  maxFilesPerBatchVersion: number;
  maxEvidenceCallsPerBatch: number;
  maxEvidenceCallsPerBatchSource: "default" | "custom";
  maxEvidenceCallsPerBatchVersion: number;
};

/** 并发数、文件数上限与取证上限在下面这些用例里一次都没被改过,读回来恒是这一份。 */
const UNTOUCHED_BATCH_LIMITS = {
  maxParallelBatches: DEFAULT_MAX_PARALLEL_BATCHES,
  maxParallelBatchesSource: "default",
  maxParallelBatchesVersion: 1,
  maxFilesPerBatch: DEFAULT_MAX_FILES_PER_BATCH,
  maxFilesPerBatchSource: "default",
  maxFilesPerBatchVersion: 1,
  maxEvidenceCallsPerBatch: EVIDENCE_SESSION_BUDGET,
  maxEvidenceCallsPerBatchSource: "default",
  maxEvidenceCallsPerBatchVersion: 1,
};

async function readSettings(h: PanelHarness): Promise<SettingsBody> {
  return await (await h.api("GET", "/settings")).json() as SettingsBody;
}

async function putReviewers(h: PanelHarness, reviewers: unknown): Promise<Response> {
  return h.api("PUT", "/settings", {
    reviewers,
    expectedVersion: (await readSettings(h)).reviewersVersion,
  });
}

async function putLimit(h: PanelHarness, maxChangedLinesPerBatch: unknown): Promise<Response> {
  return h.api("PUT", "/settings", {
    maxChangedLinesPerBatch,
    expectedVersion: (await readSettings(h)).maxChangedLinesPerBatchVersion,
  });
}

test("审查策略两项独立保存，陈旧写入只冲突目标项", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "corp-deepseek", ["deepseek-v4-flash"]);
  const initial = await (await h.api("GET", "/settings")).json() as {
    reviewersVersion: number;
    maxChangedLinesPerBatchVersion: number;
  };
  const reviewers = [{ provider: "corp-deepseek", model: "deepseek-v4-flash" }];

  const coupledWrite = await h.api("PUT", "/settings", {
    reviewers,
    maxChangedLinesPerBatch: 800,
    expectedVersion: initial.reviewersVersion,
  });
  assert.equal(coupledWrite.status, 400, "一个请求不得同时改两项");

  const modelWrite = await h.api("PUT", "/settings", {
    reviewers,
    expectedVersion: initial.reviewersVersion,
  });
  assert.equal(modelWrite.status, 200);
  const limitWrite = await h.api("PUT", "/settings", {
    maxChangedLinesPerBatch: 800,
    expectedVersion: initial.maxChangedLinesPerBatchVersion,
  });
  assert.equal(limitWrite.status, 200);
  assert.deepEqual(await limitWrite.json(), {
    reviewers,
    reviewersVersion: initial.reviewersVersion + 1,
    maxChangedLinesPerBatch: 800,
    maxChangedLinesPerBatchSource: "custom",
    maxChangedLinesPerBatchVersion: initial.maxChangedLinesPerBatchVersion + 1,
    ...UNTOUCHED_BATCH_LIMITS,
  });

  const stale = await h.api("PUT", "/settings", {
    maxChangedLinesPerBatch: 900,
    expectedVersion: initial.maxChangedLinesPerBatchVersion,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), {
    reviewers,
    reviewersVersion: initial.reviewersVersion + 1,
    maxChangedLinesPerBatch: 800,
    maxChangedLinesPerBatchSource: "custom",
    maxChangedLinesPerBatchVersion: initial.maxChangedLinesPerBatchVersion + 1,
    ...UNTOUCHED_BATCH_LIMITS,
  });
});

test("历史空组合可读但不能再次保存，批次上限可恢复系统默认", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const initial = await (await h.api("GET", "/settings")).json() as {
    reviewersVersion: number;
    maxChangedLinesPerBatchVersion: number;
  };
  const empty = await h.api("PUT", "/settings", {
    reviewers: [],
    expectedVersion: initial.reviewersVersion,
  });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /至少要选一个模型/);

  const custom = await h.api("PUT", "/settings", {
    maxChangedLinesPerBatch: 800,
    expectedVersion: initial.maxChangedLinesPerBatchVersion,
  });
  const customBody = await custom.json() as { maxChangedLinesPerBatchVersion: number };
  const reset = await h.api("PUT", "/settings", {
    maxChangedLinesPerBatch: null,
    expectedVersion: customBody.maxChangedLinesPerBatchVersion,
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), {
    reviewers: [],
    reviewersVersion: initial.reviewersVersion,
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    maxChangedLinesPerBatchSource: "default",
    maxChangedLinesPerBatchVersion: customBody.maxChangedLinesPerBatchVersion + 1,
    ...UNTOUCHED_BATCH_LIMITS,
  });
});

test("全局组合按模型服务候选校验，失效项可移除且批次上限独立保存", async () => {
  const selected = [
    { provider: "healthy-service", model: "keep" },
    { provider: "recovering-service", model: "saved" },
    { provider: "vanished-service", model: "missing" },
  ];
  const h = await startPanelHarness(cleanups, { reviewers: selected });
  seedAvailableModelService(h, "healthy-service", ["keep"]);
  seedAvailableModelService(h, "recovering-service", ["saved"]);

  const setRecoveringCredential = (state: "verified" | "pending-reverification"): void => {
    const sqlite = new DatabaseSync(h.db.path);
    try {
      if (state === "pending-reverification") {
        sqlite.prepare(
          `UPDATE model_service_credential
              SET state = 'pending-reverification', verified_at = NULL,
                  validation_model = NULL, verification_source = NULL
            WHERE provider = ?`,
        ).run("recovering-service");
      } else {
        sqlite.prepare(
          `UPDATE model_service_credential
              SET state = 'verified', verified_at = ?, validation_model = ?,
                  verification_source = 'inference'
            WHERE provider = ?`,
        ).run(
          "2026-08-20T00:01:00.000Z",
          "recovering-service:saved",
          "recovering-service",
        );
      }
    } finally {
      sqlite.close();
    }
  };
  const serviceState = () => {
    const store = openStore(h.db.path);
    try {
      return {
        services: store.listModelServices(),
        supplements: store.listModelSupplements(),
      };
    } finally {
      store.close();
    }
  };

  setRecoveringCredential("pending-reverification");
  const projectionResponse = await h.api("GET", "/model-services");
  assert.equal(projectionResponse.status, 200);
  const projection = (await projectionResponse.json()) as {
    candidates: {
      identity: string;
      available: boolean;
      unavailableReasonText: string | null;
    }[];
  };
  assert.deepEqual(
    projection.candidates
      .filter((model) => selected.some((spec) => `${spec.provider}:${spec.model}` === model.identity))
      .map((model) => ({
        identity: model.identity,
        available: model.available,
        unavailableReasonText: model.unavailableReasonText,
      })),
    [
      { identity: "healthy-service:keep", available: true, unavailableReasonText: null },
      {
        identity: "recovering-service:saved",
        available: false,
        unavailableReasonText: "模型凭据不可用",
      },
      {
        identity: "vanished-service:missing",
        available: false,
        unavailableReasonText: "模型来源消失",
      },
    ],
  );

  const beforeBlockedWrites = serviceState();
  const blocked = await putReviewers(h, selected);
  assert.equal(blocked.status, 400);
  assert.match((await blocked.text()), /模型凭据不可用.*模型来源消失/);

  const limitOnly = await putLimit(h, 733);
  assert.equal(limitOnly.status, 200);
  assert.deepEqual(await limitOnly.json(), {
    reviewers: selected,
    reviewersVersion: 1,
    maxChangedLinesPerBatch: 733,
    maxChangedLinesPerBatchSource: "custom",
    maxChangedLinesPerBatchVersion: 2,
    ...UNTOUCHED_BATCH_LIMITS,
  });
  assert.deepEqual(serviceState(), beforeBlockedWrites, "组合与批次写入不应改服务或模型来源");

  setRecoveringCredential("verified");
  const recoveredResponse = await h.api("GET", "/model-services");
  const recoveredBody = (await recoveredResponse.json()) as {
    candidates: { identity: string; available: boolean }[];
  };
  assert.equal(
    recoveredBody.candidates.find((model) => model.identity === "recovering-service:saved")?.available,
    true,
  );
  const recoveredSettings = (await (await h.api("GET", "/settings")).json()) as {
    reviewers: unknown;
  };
  assert.deepEqual(recoveredSettings.reviewers, selected);

  const beforeMissingRemoval = serviceState();
  const withoutMissing = selected.slice(0, 2);
  const removedMissing = await putReviewers(h, withoutMissing);
  assert.equal(removedMissing.status, 200);
  assert.deepEqual(await removedMissing.json(), {
    reviewers: withoutMissing,
    reviewersVersion: 2,
    maxChangedLinesPerBatch: 733,
    maxChangedLinesPerBatchSource: "custom",
    maxChangedLinesPerBatchVersion: 2,
    ...UNTOUCHED_BATCH_LIMITS,
  });
  assert.deepEqual(serviceState(), beforeMissingRemoval);

  setRecoveringCredential("pending-reverification");
  const beforeUnavailableRemoval = serviceState();
  const removedUnavailable = await putReviewers(h, [selected[0]!]);
  assert.equal(removedUnavailable.status, 200);
  assert.deepEqual(await removedUnavailable.json(), {
    reviewers: [selected[0]],
    reviewersVersion: 3,
    maxChangedLinesPerBatch: 733,
    maxChangedLinesPerBatchSource: "custom",
    maxChangedLinesPerBatchVersion: 2,
    ...UNTOUCHED_BATCH_LIMITS,
  });
  assert.deepEqual(serviceState(), beforeUnavailableRemoval);
});

test("批次上限自定义与恢复默认都不改模型组合", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  seedAvailableModelService(h, "test", ["global-model"]);
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), {
    reviewers: [],
    reviewersVersion: 1,
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    maxChangedLinesPerBatchSource: "default",
    maxChangedLinesPerBatchVersion: 1,
    ...UNTOUCHED_BATCH_LIMITS,
  });

  const reviewers = [{ provider: "test", model: "global-model" }];
  await putReviewers(h, reviewers);
  const custom = await putLimit(h, 800);
  assert.deepEqual(await custom.json(), {
    reviewers,
    reviewersVersion: 2,
    maxChangedLinesPerBatch: 800,
    maxChangedLinesPerBatchSource: "custom",
    maxChangedLinesPerBatchVersion: 2,
    ...UNTOUCHED_BATCH_LIMITS,
  });
  const cleared = await putLimit(h, null);
  assert.deepEqual(await cleared.json(), {
    reviewers,
    reviewersVersion: 2,
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    maxChangedLinesPerBatchSource: "default",
    maxChangedLinesPerBatchVersion: 3,
    ...UNTOUCHED_BATCH_LIMITS,
  });
});

test("非法的 reviewers 被既有校验拒绝,报错标注来源是全局这一层", async () => {
  const h = await startPanelHarness(cleanups);

  const missingField = await putReviewers(h, [{ provider: "deepseek" }]);
  assert.equal(missingField.status, 400);
  assert.match(((await missingField.json()) as { error: string }).error, /全局模型组合.*model/);

  const duplicate = await putReviewers(h, [
      { provider: "a", model: "same" },
      { provider: "a", model: "same" },
    ]);
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /a:same 选了两次/);

  // 坏入参一条都不落库:组合还是 harness 播种的那一份。
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), {
    reviewers: [{ provider: "test", model: "global-model" }],
    reviewersVersion: 1,
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    maxChangedLinesPerBatchSource: "default",
    maxChangedLinesPerBatchVersion: 1,
    ...UNTOUCHED_BATCH_LIMITS,
  });
});

type LimitField = "maxParallelBatches" | "maxFilesPerBatch" | "maxEvidenceCallsPerBatch";

async function putBatchLimit(
  h: PanelHarness,
  field: LimitField,
  value: unknown,
): Promise<Response> {
  const settings = await readSettings(h);
  return h.api("PUT", "/settings", {
    [field]: value,
    expectedVersion: settings[`${field}Version`],
  });
}

test("批次并发数与文件数上限各自独立读写,版本各推各的", async () => {
  const h = await startPanelHarness(cleanups);
  const initial = await readSettings(h);
  assert.equal(initial.maxParallelBatches, DEFAULT_MAX_PARALLEL_BATCHES);
  assert.equal(initial.maxParallelBatchesSource, "default");
  assert.equal(initial.maxFilesPerBatch, DEFAULT_MAX_FILES_PER_BATCH);
  assert.equal(initial.maxFilesPerBatchSource, "default");

  const parallel = await putBatchLimit(h, "maxParallelBatches", 5);
  assert.equal(parallel.status, 200);
  const files = await putBatchLimit(h, "maxFilesPerBatch", 12);
  assert.equal(files.status, 200);
  assert.deepEqual(await files.json(), {
    reviewers: initial.reviewers,
    reviewersVersion: initial.reviewersVersion,
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    maxChangedLinesPerBatchSource: "default",
    maxChangedLinesPerBatchVersion: 1,
    maxParallelBatches: 5,
    maxParallelBatchesSource: "custom",
    maxParallelBatchesVersion: 2,
    maxFilesPerBatch: 12,
    maxFilesPerBatchSource: "custom",
    maxFilesPerBatchVersion: 2,
    maxEvidenceCallsPerBatch: EVIDENCE_SESSION_BUDGET,
    maxEvidenceCallsPerBatchSource: "default",
    maxEvidenceCallsPerBatchVersion: 1,
  });

  // 陈旧写只冲突目标项,另外两项一个都不动。
  const stale = await h.api("PUT", "/settings", {
    maxFilesPerBatch: 20,
    expectedVersion: 1,
  });
  assert.equal(stale.status, 409);

  const reset = await putBatchLimit(h, "maxParallelBatches", null);
  assert.equal(reset.status, 200);
  const afterReset = await readSettings(h);
  assert.equal(afterReset.maxParallelBatches, DEFAULT_MAX_PARALLEL_BATCHES);
  assert.equal(afterReset.maxParallelBatchesSource, "default");
  assert.equal(afterReset.maxParallelBatchesVersion, 3);
  assert.equal(afterReset.maxFilesPerBatch, 12);
  assert.equal(afterReset.maxFilesPerBatchVersion, 2);
});

test("一个请求仍然只能改一项审查策略", async () => {
  const h = await startPanelHarness(cleanups);
  const coupled = await h.api("PUT", "/settings", {
    maxParallelBatches: 2,
    maxFilesPerBatch: 20,
    expectedVersion: 1,
  });
  assert.equal(coupled.status, 400);
  const settings = await readSettings(h);
  assert.equal(settings.maxParallelBatchesSource, "default");
  assert.equal(settings.maxFilesPerBatchSource, "default");
});

test("批次并发数、文件数上限与取证上限不是正整数时拒绝", async () => {
  const h = await startPanelHarness(cleanups);
  for (const field of ["maxParallelBatches", "maxFilesPerBatch", "maxEvidenceCallsPerBatch"] as const) {
    for (const value of [0, -1, 1.5, "3"]) {
      const response = await putBatchLimit(h, field, value);
      assert.equal(response.status, 400, `${field} 的 ${String(value)} 应被拒绝`);
      assert.match(((await response.json()) as { error: string }).error, new RegExp(field));
    }
  }
});

test("Run 快照冻结分批上限、并发数与取证上限,开跑后改设置不影响本轮", async () => {
  const h = await startPanelHarness(cleanups);
  seedHistoricalRepo(h);
  assert.equal((await putBatchLimit(h, "maxParallelBatches", 5)).status, 200);
  assert.equal((await putBatchLimit(h, "maxFilesPerBatch", 12)).status, 200);
  assert.equal((await putBatchLimit(h, "maxEvidenceCallsPerBatch", 4)).status, 200);

  const store = openStore(h.db.path);
  try {
    const frozen = store.getReviewRunSnapshot(GITEA_REPO.id);
    assert.equal(frozen.maxParallelBatches, 5);
    assert.equal(frozen.maxFilesPerBatch, 12);
    assert.equal(frozen.maxEvidenceCallsPerBatch, 4);

    // 取证上限也是这一轮的:快照取出之后再改,已经开跑的这一轮读到的还是 4。
    assert.equal((await putBatchLimit(h, "maxEvidenceCallsPerBatch", 1)).status, 200);
    assert.equal(frozen.maxEvidenceCallsPerBatch, 4);
    assert.equal(store.getReviewRunSnapshot(GITEA_REPO.id).maxEvidenceCallsPerBatch, 1);

    // 这一轮已经拿到快照;之后改设置只影响下一次取快照。
    assert.equal((await putBatchLimit(h, "maxFilesPerBatch", 1)).status, 200);
    assert.equal(frozen.maxFilesPerBatch, 12);
    assert.equal(store.getReviewRunSnapshot(GITEA_REPO.id).maxFilesPerBatch, 1);
  } finally {
    store.close();
  }
});

test("批次上限不是正整数时拒绝", async () => {
  const h = await startPanelHarness(cleanups);
  for (const limit of [0, -1, 1.5, "800"]) {
    const response = await putLimit(h, limit);
    assert.equal(response.status, 400, `${String(limit)} 应被拒绝`);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /maxChangedLinesPerBatch/,
    );
  }
});

test("全局组合与每仓库覆盖都拒绝新的空组合", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model"]);
  const empty = await putReviewers(h, []);
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /至少要选一个模型/);

  // 每仓库覆盖是另一层判据(issue #69):空覆盖表达不了意图,要停掉就清成 null。
  const register = await h.api("POST", "/repos", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
  });
  assert.equal(register.status, 201);
  const { repoId } = (await register.json()) as { repoId: number };
  const override = await h.api("PUT", `/repos/${repoId}/reviewers`, { reviewers: [] });
  assert.equal(override.status, 400);
  assert.match(((await override.json()) as { error: string }).error, /至少要选一个模型/);
});

test("改过的全局组合下一次投递就生效", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model", "swapped-model"]);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal(
    (
      await putReviewers(h, [{ provider: "test", model: "swapped-model" }])
    ).status,
    200,
  );

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.deepEqual(h.factoryCalls.at(-1), [{ provider: "test", model: "swapped-model" }]);
});

test("空库、没配模型组合时投递留下一条失败的 Review Run,原因可读", async () => {
  // 真组装:组合为空,零 Reviewer 的 Run 既不失败也不报错,人看到的会是「投了没反应」。
  const h = await startPanelHarness(cleanups, { reviewers: [], buildReviewers });
  const historicalHook = seedHistoricalRepo(h);

  assert.equal((await h.deliverViaHook("sha-1", historicalHook)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30 });
  store.close();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.failed, true);

  const sqlite = new DatabaseSync(h.db.path);
  try {
    const rows = sqlite.prepare("SELECT failure FROM reviewer_outcome").all() as {
      failure: string | null;
    }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.failure ?? "", /还没有配置模型组合/);
  } finally {
    sqlite.close();
  }
});

/**
 * 撞名的自定义 provider 接进 Review Run(issue #94)。测在同一条组装缝上:harness 注入的
 * `buildReviewers` 就是服务真用的那一个入口,而撞名的判据是服务在开跑前自己算出来喂给它的。
 * 少了这一条,服务端不算撞名、一律传空集合也照样全绿——组装那一档的用例是直接调
 * `buildReviewers` 的,碰不到这段接线。
 *
 * 同一个组合里放两家自定义 provider:一家的名字是 Pi 内置就有的(`openrouter`,撞名),另一家
 * 是自己起的名字(不撞)。两句失败措辞必须不同——这既守住接线,也顺带证实判据不是「凡是自定义
 * provider 都算撞名」。`openrouter` 哪天真从 Pi 内置目录里消失,这一条会当场红。
 */
test("组合里有撞名的自定义 provider 时,那一个模型的失败原因写明是名字冲突", async () => {
  const collided = { provider: "openrouter", model: "corp-qwen3-max" };
  const fine = { provider: "corp-gateway", model: "corp-glm-5" };
  const h = await startPanelHarness(cleanups, {
    reviewers: [collided, fine],
    buildReviewers,
  });
  // 只为撞名那一家提交模型服务；另一家完全缺服务，作为独立失败原因的对照。
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, {
    provider: collided.provider,
    type: "custom",
    baseUrl: "https://collided.example/v1",
    api: "openai-completions",
    targetFingerprint: "versioned-collision-target",
    disabledReason: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    credential: {
      state: "unconfigured",
      apiKeyEncrypted: null,
      updatedAt: null,
      verifiedAt: null,
      validationModel: null,
      verificationSource: null,
    },
    directory: {
      state: "undiscovered",
      lastAttemptAt: null,
      lastSuccessAt: null,
      failure: null,
      ignoredModelCount: 0,
    },
    automaticModels: [],
    supplements: [],
  }), 1);
  seed.close();
  const historicalHook = seedHistoricalRepo(h);

  assert.equal((await h.deliverViaHook("sha-1", historicalHook)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const store = openStore(h.db.path);
  const models = store.listRuns({ limit: 1 })[0]!.models;
  store.close();
  const failure = (model: string): string =>
    models.find((row) => row.model === model)?.failure ?? "";
  assert.match(failure("openrouter:corp-qwen3-max"), /名字/, "撞名那一个没写明是名字冲突");
  assert.match(
    failure("corp-gateway:corp-glm-5"),
    /模型服务.*不存在/,
    "不撞名但缺当前模型服务的那一个没有留下独立原因",
  );
});

test("思考档位随模型组合与仓库覆盖一起读写,取值不认得或模型不支持时整组拒收", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model", "second-model"], { reasoning: true });
  // adaptive 模型:`thinkingLevelMap.off` 为 null 即它关不掉思考,「关闭」不是它的一档。
  seedAvailableModelService(h, "always", ["adaptive-model"], {
    reasoning: true,
    thinkingLevelMap: { off: null },
  });

  const bad = await putReviewers(h, [
    { provider: "test", model: "global-model", thinkingLevel: "turbo" },
  ]);
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /全局模型组合.*思考档位/);

  const saved = await putReviewers(h, [
    { provider: "test", model: "global-model", thinkingLevel: "high" },
    { provider: "test", model: "second-model" },
  ]);
  assert.equal(saved.status, 200);
  const settings = await readSettings(h);
  assert.equal(settings.reviewers[0]!.thinkingLevel, "high");
  assert.equal(Object.hasOwn(settings.reviewers[1]!, "thinkingLevel"), false);

  // 每仓库覆盖与全局同构:同一套判据,档位一样存得下。
  const register = await h.api("POST", "/repos", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
  });
  assert.equal(register.status, 201);
  const { repoId } = (await register.json()) as { repoId: number };
  assert.equal(
    (await h.api("PUT", `/repos/${repoId}/reviewers`, {
      reviewers: [{ provider: "test", model: "second-model", thinkingLevel: "low" }],
    })).status,
    204,
  );
  const repos = (await (await h.api("GET", "/repos")).json()) as {
    repoId: number;
    reviewers: { thinkingLevel?: string }[] | null;
  }[];
  const row = repos.find((entry) => entry.repoId === repoId)!;
  assert.equal(row.reviewers?.[0]?.thinkingLevel, "low");

  // 取值认得、这个模型却不支持的那一档同样整组拒收:放过去只会被运行侧 clamp 成别的
  // 一档,人以为选的是这一档。
  const tooHigh = await putReviewers(h, [
    { provider: "test", model: "global-model", thinkingLevel: "max" },
  ]);
  assert.equal(tooHigh.status, 400);
  assert.match(
    ((await tooHigh.json()) as { error: string }).error,
    /test:global-model 不支持思考档位 max/,
  );

  // 缺席即「关闭」,而 adaptive 模型连「关闭」都不支持:那一档也要显式选过。
  const implicitOff = await putReviewers(h, [{ provider: "always", model: "adaptive-model" }]);
  assert.equal(implicitOff.status, 400);
  assert.match(
    ((await implicitOff.json()) as { error: string }).error,
    /always:adaptive-model 不支持思考档位 off/,
  );
  assert.equal(
    (await putReviewers(h, [
      { provider: "always", model: "adaptive-model", thinkingLevel: "medium" },
    ])).status,
    200,
  );
});

test("每批每模型取证上限独立读写,升级前的库读出默认 3", async () => {
  const h = await startPanelHarness(cleanups);
  // harness 的库从没写过这一格,与升级前的库同一形态:读出来是系统默认、版本 1。
  const initial = await readSettings(h);
  assert.equal(initial.maxEvidenceCallsPerBatch, 3);
  assert.equal(initial.maxEvidenceCallsPerBatch, EVIDENCE_SESSION_BUDGET);
  assert.equal(initial.maxEvidenceCallsPerBatchSource, "default");
  assert.equal(initial.maxEvidenceCallsPerBatchVersion, 1);
  // 库里确实没有这一行,不是写了一个 3 进去。
  const store = openStore(h.db.path);
  try {
    assert.equal(store.getGlobalSettings().maxEvidenceCallsPerBatch, null);
  } finally {
    store.close();
  }

  const raised = await putBatchLimit(h, "maxEvidenceCallsPerBatch", 4);
  assert.equal(raised.status, 200);
  const after = (await raised.json()) as SettingsBody;
  assert.equal(after.maxEvidenceCallsPerBatch, 4);
  assert.equal(after.maxEvidenceCallsPerBatchSource, "custom");
  assert.equal(after.maxEvidenceCallsPerBatchVersion, 2);
  // 只推自己的版本,另外三项一个都不动。
  assert.equal(after.maxParallelBatchesVersion, 1);
  assert.equal(after.maxFilesPerBatchVersion, 1);
  assert.equal(after.maxChangedLinesPerBatchVersion, 1);

  const stale = await h.api("PUT", "/settings", { maxEvidenceCallsPerBatch: 5, expectedVersion: 1 });
  assert.equal(stale.status, 409);

  const reset = await putBatchLimit(h, "maxEvidenceCallsPerBatch", null);
  assert.equal(reset.status, 200);
  const restored = await readSettings(h);
  assert.equal(restored.maxEvidenceCallsPerBatch, EVIDENCE_SESSION_BUDGET);
  assert.equal(restored.maxEvidenceCallsPerBatchSource, "default");
  assert.equal(restored.maxEvidenceCallsPerBatchVersion, 3);
});
