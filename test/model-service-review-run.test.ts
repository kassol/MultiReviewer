import assert from "node:assert/strict";
import { after, test } from "node:test";

import { buildReviewers, modelIdentity } from "../src/config.ts";
import { encryptCredential } from "../src/panel/credential-crypto.ts";
import type { ReviewerOutcome } from "../src/review/finding.ts";
import { modelServiceTargetFingerprint } from "../src/review/model-service-migration.ts";
import { openStore } from "../src/review/store.ts";
import type { TrustedModelFields } from "../src/reviewer/model-service-runtime.ts";
import {
  HARNESS_PR,
  PANEL_CREDENTIAL_MASTER_KEY,
  seedHistoricalRepo,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});
function commitRunService(
  h: PanelHarness,
  expectedVersion: number | null,
  options: {
    provider?: string;
    model: string;
    baseUrl: string;
    api: "openai-completions" | "openai-responses";
    credential: string | null;
    fields?: TrustedModelFields;
    disabledReason?: "name-conflict" | null;
  },
): number {
  const provider = options.provider ?? "test";
  const at = `2026-08-20T12:0${expectedVersion ?? 0}:00.000Z`;
  const store = openStore(h.db.path);
  try {
    const version = store.commitModelServiceVersion(expectedVersion, {
      provider,
      type: "custom",
      baseUrl: options.baseUrl,
      api: options.api,
      targetFingerprint: modelServiceTargetFingerprint(options.baseUrl, options.api),
      disabledReason: options.disabledReason ?? null,
      createdAt: at,
      updatedAt: at,
      credential: {
        state: options.credential === null ? "unconfigured" : "verified",
        apiKeyEncrypted:
          options.credential === null
            ? null
            : encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, options.credential),
        updatedAt: options.credential === null ? null : at,
        verifiedAt: options.credential === null ? null : at,
        validationModel: options.credential === null ? null : `${provider}:${options.model}`,
        verificationSource: options.credential === null ? null : "inference",
      },
      directory: {
        state: "available",
        lastAttemptAt: at,
        lastSuccessAt: at,
        failure: null,
        ignoredModelCount: 0,
      },
      automaticModels: [
        {
          identity: `${provider}:${options.model}`,
          provider,
          id: options.model,
          fields: options.fields ?? {},
        },
      ],
      supplements: [],
    });
    assert.ok(version !== undefined, "模型服务版本提交失败");
    return version;
  } finally {
    store.close();
  }
}


test("凭据未配置时只失败该 Reviewer 并留下固定服务版本审计", async () => {
  const h = await startPanelHarness(cleanups, { buildReviewers });
  const historicalHook = seedHistoricalRepo(h);
  assert.equal(
    commitRunService(h, null, {
      model: "global-model",
      baseUrl: "https://missing-credential.example.test/v1",
      api: "openai-completions",
      credential: null,
    }),
    1,
  );

  assert.equal((await h.deliverViaHook("sha-missing-credential", historicalHook)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  const store = openStore(h.db.path);
  const run = store.listRuns({ limit: 1 })[0]!;
  store.close();
  assert.equal(run.failed, true);
  assert.match(run.models[0]!.failure ?? "", /没有配置 test 的模型凭据/);
  assert.equal(run.reviewerPins[0]!.modelServiceVersion, 1);
  assert.equal(run.reviewerPins[0]!.target?.baseUrl, "https://missing-credential.example.test/v1");
});

test("Pi 内置目标漂移时不解密凭据，也不生成可执行 Reviewer 计划", async () => {
  const spec = { provider: "openai", model: "drift-model" };
  const h = await startPanelHarness(cleanups, {
    reviewers: [spec],
    buildReviewers: (plans) => plans.map((plan) => scriptedReviewer(plan.spec.model, [])),
  });
  const historicalHook = seedHistoricalRepo(h);
  const at = "2026-08-20T12:30:00.000Z";
  const store = openStore(h.db.path);
  assert.equal(store.commitModelServiceVersion(null, {
    provider: spec.provider,
    type: "builtin",
    baseUrl: null,
    api: null,
    targetFingerprint: "committed-target-that-no-longer-matches-pi",
    disabledReason: null,
    createdAt: at,
    updatedAt: at,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, "must-not-be-decrypted"),
      updatedAt: at,
      verifiedAt: at,
      validationModel: modelIdentity(spec),
      verificationSource: "inference",
    },
    directory: {
      state: "available",
      lastAttemptAt: at,
      lastSuccessAt: at,
      failure: null,
      ignoredModelCount: 0,
    },
    automaticModels: [{
      identity: modelIdentity(spec),
      provider: spec.provider,
      id: spec.model,
      fields: {},
    }],
    supplements: [],
  }), 1);
  store.close();

  assert.equal((await h.deliverViaHook("sha-builtin-target-drift", historicalHook)).status, 200);
  await h.settledAtLeast(1);
  const plan = h.runtimePlans[0]![0]!;
  assert.equal(plan.credential, null);
  assert.equal(h.snapshots[0]!.has(spec.provider), false);
  assert.match(plan.failure ?? "", /Pi 内置目标已经变化/);
});

test("迁移遗留的冲突标记不阻止当前已无撞名的自定义服务运行", async () => {
  const spec = { provider: "recovered-custom", model: "recovered-model" };
  const h = await startPanelHarness(cleanups, {
    reviewers: [spec],
    buildReviewers: (plans) => plans.map((plan) => scriptedReviewer(plan.spec.model, [])),
  });
  const historicalHook = seedHistoricalRepo(h);
  assert.equal(commitRunService(h, null, {
    provider: spec.provider,
    model: spec.model,
    baseUrl: "https://recovered-custom.example/v1",
    api: "openai-completions",
    credential: "recovered-custom-secret",
    disabledReason: "name-conflict",
  }), 1);

  assert.equal((await h.deliverViaHook("sha-recovered-custom", historicalHook)).status, 200);
  await h.settledAtLeast(1);
  const plan = h.runtimePlans[0]![0]!;
  assert.equal(plan.failure, null);
  assert.equal(plan.credential, "recovered-custom-secret");
});

test("模型来源消失只失败该 Reviewer,同轮可用同伴照常完成", async () => {
  const available = { provider: "test", model: "global-model" };
  const vanished = { provider: "test", model: "vanished-model" };
  const h = await startPanelHarness(cleanups, {
    reviewers: [available, vanished],
    buildReviewers: (plans) =>
      plans.map((plan) => {
        if (plan.failure !== null) return buildReviewers([plan])[0]!;
        return {
          model: modelIdentity(plan.spec),
          review: (): Promise<ReviewerOutcome> =>
            Promise.resolve({
              model: modelIdentity(plan.spec),
              findings: [],
              anomalies: [],
              rejectedToolCalls: 0,
              anchorRejections: 0,
            }),
        };
      }),
  });
  const historicalHook = seedHistoricalRepo(h);
  commitRunService(h, null, {
    model: available.model,
    baseUrl: "https://partly-available.example.test/v1",
    api: "openai-completions",
    credential: "peer-key",
  });

  assert.equal((await h.deliverViaHook("sha-one-model-missing", historicalHook)).status, 200);
  await h.settledAtLeast(1);
  const store = openStore(h.db.path);
  const run = store.listRuns({ limit: 1 })[0]!;
  store.close();
  assert.equal(run.failed, false);
  assert.equal(run.models.find((row) => row.model === modelIdentity(available))?.failure, null);
  assert.match(
    run.models.find((row) => row.model === modelIdentity(vanished))?.failure ?? "",
    /模型来源不存在.*test:vanished-model/,
  );
  assert.deepEqual(
    run.reviewerPins.map((pin) => pin.identity),
    [modelIdentity(available), modelIdentity(vanished)],
  );
});

test("多批次 Run 固定服务版本、目标、运行字段与凭据,手动下一轮才看见切版", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed: {
    run: number;
    version: number | null;
    baseUrl: string | undefined;
    api: string | undefined;
    name: string | undefined;
    credential: string | null;
  }[] = [];
  let buildCount = 0;
  let firstRunCalls = 0;
  const h = await startPanelHarness(cleanups, {
    buildReviewers: (plans) => {
      buildCount += 1;
      const run = buildCount;
      return plans.map((plan) => ({
        model: modelIdentity(plan.spec),
        review: async (): Promise<ReviewerOutcome> => {
          observed.push({
            run,
            version: plan.modelServiceVersion,
            baseUrl: plan.runtimeModel?.baseUrl,
            api: plan.runtimeModel?.api,
            name: plan.runtimeModel?.name,
            credential: plan.credential,
          });
          if (run === 1 && firstRunCalls++ === 0) {
            entered.resolve();
            await release.promise;
          }
          return {
            model: modelIdentity(plan.spec),
            findings: [],
            anomalies: [],
            rejectedToolCalls: 0,
            anchorRejections: 0,
          };
        },
      }));
    },
  });
  const historicalHook = seedHistoricalRepo(h);
  assert.equal(
    commitRunService(h, null, {
      model: "global-model",
      baseUrl: "https://service-v1.example.test/v1",
      api: "openai-completions",
      credential: "key-one",
      fields: { name: "Version One" },
    }),
    1,
  );
  assert.equal(
    commitRunService(h, null, {
      provider: "unreferenced",
      model: "other",
      baseUrl: "https://unused.example.test/v1",
      api: "openai-completions",
      credential: "secret-never-selected",
    }),
    1,
  );
  const settings = openStore(h.db.path);
  settings.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "test", model: "global-model" }]),
    maxChangedLinesPerBatch: 1,
  });
  settings.close();

  assert.equal((await h.deliverViaHook("sha-v1", historicalHook)).status, 200);
  await entered.promise;

  assert.equal(
    commitRunService(h, 1, {
      model: "global-model",
      baseUrl: "https://service-v2.example.test/v2",
      api: "openai-responses",
      credential: "key-two",
      fields: { name: "Version Two", reasoning: true, contextWindow: 256_000 },
    }),
    2,
  );
  const changedSettings = openStore(h.db.path);
  changedSettings.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "test", model: "global-model" }]),
    maxChangedLinesPerBatch: 999,
  });
  changedSettings.close();
  release.resolve();
  await h.settledAtLeast(1);

  const currentRun = observed.filter((entry) => entry.run === 1);
  assert.equal(currentRun.length, 2, "v1 批次上限没有固定成两个批次");
  assert.deepEqual(
    currentRun.map((entry) => [entry.version, entry.baseUrl, entry.api, entry.name, entry.credential]),
    [
      [1, "https://service-v1.example.test/v1", "openai-completions", "Version One", "key-one"],
      [1, "https://service-v1.example.test/v1", "openai-completions", "Version One", "key-one"],
    ],
  );
  assert.deepEqual([...h.snapshots[0]!], [["test", "key-one"]]);
  assert.equal(JSON.stringify(h.runtimePlans[0]).includes("secret-never-selected"), false);

  const firstStored = openStore(h.db.path);
  const firstRun = firstStored.listRuns({ limit: 1 })[0]!;
  firstStored.close();
  assert.equal(firstRun.reviewerPins[0]!.modelServiceVersion, 1);
  assert.equal(firstRun.reviewerPins[0]!.runtimeModel?.baseUrl, "https://service-v1.example.test/v1");
  assert.equal(JSON.stringify(firstRun.reviewerPins).includes("key-one"), false);

  const projectedText = await (await h.api("GET", "/runs?limit=1")).text();
  const projected = JSON.parse(projectedText) as {
    runs: { reviewerPins: { modelServiceVersion: number | null }[] }[];
  };
  assert.equal(projected.runs[0]!.reviewerPins[0]!.modelServiceVersion, 1);
  assert.equal(projectedText.includes("key-one"), false);
  assert.equal(projectedText.includes("key-two"), false);
  assert.equal(projectedText.includes("apiKeyEncrypted"), false);
  assert.equal(projectedText.includes(PANEL_CREDENTIAL_MASTER_KEY), false);

  const rerun = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(rerun.status, 202);
  await h.settledAtLeast(2);

  const nextRun = observed.filter((entry) => entry.run === 2);
  assert.equal(nextRun.length, 1, "新批次上限没有在下一轮生效");
  assert.deepEqual(
    nextRun.map((entry) => [entry.version, entry.baseUrl, entry.api, entry.name, entry.credential]),
    [[2, "https://service-v2.example.test/v2", "openai-responses", "Version Two", "key-two"]],
  );
  assert.equal(h.runtimePlans.length, 2, "自动投递与手动重跑没有共用同一个计划构建入口");
  assert.equal(h.runtimePlans[1]![0]!.modelServiceVersion, 2);
});
