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
  auxiliaryModel: { provider: string; model: string; thinkingLevel?: string } | null;
  maxChangedLinesPerBatch: number | null;
  maxParallelBatches: number | null;
  maxFilesPerBatch: number | null;
  maxEvidenceCallsPerBatch: number | null;
  minReportSeverity: "P0" | "P1" | "P2" | null;
  version: number;
  defaults: Record<string, number | string>;
};

/** 读接口随每一份对象给出的系统默认值:上限项与报告等级留空时面板拿它当占位符。 */
const DEFAULTS = {
  maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  maxParallelBatches: DEFAULT_MAX_PARALLEL_BATCHES,
  maxFilesPerBatch: DEFAULT_MAX_FILES_PER_BATCH,
  maxEvidenceCallsPerBatch: EVIDENCE_SESSION_BUDGET,
  minReportSeverity: "P2",
};

/**
 * 辅助模型、四项上限与报告等级都没配的那一份:值是 null。上限与等级即「跟随系统默认」,
 * 辅助模型即「退回生效模型组合的第一个」(issue #303)。
 */
const UNSET_SETTINGS = {
  auxiliaryModel: null,
  maxChangedLinesPerBatch: null,
  maxParallelBatches: null,
  maxFilesPerBatch: null,
  maxEvidenceCallsPerBatch: null,
  minReportSeverity: null,
};

/** harness 播种的那一份全局模型组合。 */
const SEEDED_REVIEWERS = [{ provider: "test", model: "global-model" }];

async function readSettings(h: PanelHarness): Promise<SettingsBody> {
  return await (await h.api("GET", "/settings")).json() as SettingsBody;
}

/**
 * 整页保存(issue #301):以服务端当前的整份对象为基线,只把 `patch` 里那几项换掉,连同
 * 期望版本一次发出去。面板做的就是这件事。
 */
async function putSettings(
  h: PanelHarness,
  patch: Record<string, unknown>,
  expectedVersion?: number,
): Promise<Response> {
  const { version, defaults: _defaults, ...current } = await readSettings(h);
  return h.api("PUT", "/settings", {
    ...current,
    ...patch,
    expectedVersion: expectedVersion ?? version,
  });
}

test("审查策略整页一次保存,版本加一;陈旧写入 409 并带回当前整份对象", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "corp-deepseek", ["deepseek-v4-flash"]);
  assert.deepEqual(await readSettings(h), {
    reviewers: SEEDED_REVIEWERS,
    ...UNSET_SETTINGS,
    version: 1,
    defaults: DEFAULTS,
  });

  // 模型组合、一项上限与报告等级一次写完,一个请求,版本只推一版。
  const reviewers = [{ provider: "corp-deepseek", model: "deepseek-v4-flash" }];
  const saved = await putSettings(h, {
    reviewers,
    maxChangedLinesPerBatch: 800,
    minReportSeverity: "P1",
  });
  assert.equal(saved.status, 200);
  const expected = {
    reviewers,
    ...UNSET_SETTINGS,
    maxChangedLinesPerBatch: 800,
    minReportSeverity: "P1",
    version: 2,
    defaults: DEFAULTS,
  };
  assert.deepEqual(await saved.json(), expected);

  // 别人先改过这一页:陈旧的期望版本被拦下,响应体带回服务端当前的整份对象。
  const stale = await putSettings(h, { maxChangedLinesPerBatch: 900 }, 1);
  assert.equal(stale.status, 409);
  const conflict = (await stale.json()) as { error: string; settings: SettingsBody };
  assert.deepEqual(conflict.settings, expected);
  assert.deepEqual(await readSettings(h), expected, "409 之后一项都没写进去");
});

test("整份写入里任一项校验不过,整页一项都不写", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model"]);

  const badLimit = await putSettings(h, { maxParallelBatches: 5, maxFilesPerBatch: 0 });
  assert.equal(badLimit.status, 400);
  assert.match(((await badLimit.json()) as { error: string }).error, /maxFilesPerBatch/);
  const untouched = await readSettings(h);
  assert.deepEqual(untouched, {
    reviewers: SEEDED_REVIEWERS,
    ...UNSET_SETTINGS,
    version: 1,
    defaults: DEFAULTS,
  });

  // 模型不可用同样整份拒收:合法的那几项不会先落一半进去。
  const badModel = await putSettings(h, {
    reviewers: [{ provider: "vanished-service", model: "missing" }],
    maxParallelBatches: 5,
  });
  assert.equal(badModel.status, 400);
  assert.deepEqual(await readSettings(h), untouched);
});

test("四项上限与报告等级一次写全,留空即回系统默认", async () => {
  const h = await startPanelHarness(cleanups);
  // 整页一起校验,保存要求组合里的模型当前可用:先把 harness 播种的那一个坐实。
  seedAvailableModelService(h, "test", ["global-model"]);
  // harness 的库这几格从没写过,与升级前的库同一形态:读出来全是 null。
  const store = openStore(h.db.path);
  try {
    const stored = store.getGlobalSettings();
    assert.deepEqual(
      {
        auxiliaryModel: stored.auxiliaryModelJson,
        maxChangedLinesPerBatch: stored.maxChangedLinesPerBatch,
        maxParallelBatches: stored.maxParallelBatches,
        maxFilesPerBatch: stored.maxFilesPerBatch,
        maxEvidenceCallsPerBatch: stored.maxEvidenceCallsPerBatch,
        minReportSeverity: stored.minReportSeverity,
      },
      UNSET_SETTINGS,
    );
  } finally {
    store.close();
  }

  const saved = await putSettings(h, {
    maxChangedLinesPerBatch: 700,
    maxParallelBatches: 5,
    maxFilesPerBatch: 12,
    maxEvidenceCallsPerBatch: 4,
    minReportSeverity: "P1",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    reviewers: SEEDED_REVIEWERS,
    auxiliaryModel: null,
    maxChangedLinesPerBatch: 700,
    maxParallelBatches: 5,
    maxFilesPerBatch: 12,
    maxEvidenceCallsPerBatch: 4,
    minReportSeverity: "P1",
    version: 2,
    defaults: DEFAULTS,
  });

  // 「恢复默认」就是把那一格写成 null,随整页一起提交;别的项原样留着。
  const cleared = await putSettings(h, { maxParallelBatches: null, minReportSeverity: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), {
    reviewers: SEEDED_REVIEWERS,
    auxiliaryModel: null,
    maxChangedLinesPerBatch: 700,
    maxParallelBatches: null,
    maxFilesPerBatch: 12,
    maxEvidenceCallsPerBatch: 4,
    minReportSeverity: null,
    version: 3,
    defaults: DEFAULTS,
  });
});

test("带逐项版本键的旧库开起来:整页只剩一个版本,旧键消失,值一格不变", async () => {
  const h = await startPanelHarness(cleanups);
  const legacy = new DatabaseSync(h.db.path);
  try {
    const legacyRows: [string, string][] = [
      ["reviewers_version", "7"],
      ["max_changed_lines_per_batch", "777"],
      ["max_changed_lines_per_batch_version", "3"],
      ["max_parallel_batches_version", "2"],
      ["max_files_per_batch_version", "2"],
      ["max_evidence_calls_per_batch_version", "2"],
      ["min_report_severity", "P1"],
      ["min_report_severity_version", "5"],
    ];
    for (const [key, value] of legacyRows) {
      legacy.prepare(
        `INSERT INTO global_setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    }
  } finally {
    legacy.close();
  }

  // 开库即一次性合并。跑两遍是为了证明它幂等:第二遍旧键早没了,值仍不变。
  for (const pass of [1, 2]) {
    const store = openStore(h.db.path);
    try {
      assert.deepEqual(store.getGlobalSettings(), {
        reviewersJson: JSON.stringify(SEEDED_REVIEWERS),
        auxiliaryModelJson: null,
        maxChangedLinesPerBatch: 777,
        maxParallelBatches: null,
        maxFilesPerBatch: null,
        maxEvidenceCallsPerBatch: null,
        minReportSeverity: "P1",
        version: 1,
      }, `第 ${pass} 遍`);
    } finally {
      store.close();
    }
  }

  const remaining = new DatabaseSync(h.db.path);
  try {
    assert.deepEqual(
      remaining.prepare(
        "SELECT key FROM global_setting WHERE key LIKE '%_version' AND key <> 'settings_version'",
      ).all(),
      [],
      "逐项版本键一个都不该留下",
    );
    // 旧键换成整页那一个,值从 1 起:缺行也读作 1,但迁移把它显式建起来。
    assert.equal(
      remaining.prepare("SELECT value FROM global_setting WHERE key = 'settings_version'")
        .get()?.["value"],
      "1",
    );
  } finally {
    remaining.close();
  }

  assert.deepEqual(await readSettings(h), {
    reviewers: SEEDED_REVIEWERS,
    ...UNSET_SETTINGS,
    maxChangedLinesPerBatch: 777,
    minReportSeverity: "P1",
    version: 1,
    defaults: DEFAULTS,
  });
});

test("整份对象缺任一项即 400:缺项不当作跟随默认", async () => {
  const h = await startPanelHarness(cleanups);
  const { version, defaults: _defaults, ...current } = await readSettings(h);
  for (
    const field of [
      "reviewers",
      "auxiliaryModel",
      "maxChangedLinesPerBatch",
      "maxParallelBatches",
      "maxFilesPerBatch",
      "maxEvidenceCallsPerBatch",
      "minReportSeverity",
    ]
  ) {
    const body: Record<string, unknown> = { ...current, expectedVersion: version };
    delete body[field];
    const response = await h.api("PUT", "/settings", body);
    assert.equal(response.status, 400, `缺 ${field} 应被拒`);
    assert.match(((await response.json()) as { error: string }).error, new RegExp(field));
  }
  // 一次都没写进去:版本与值原样。
  assert.deepEqual(await readSettings(h), {
    reviewers: SEEDED_REVIEWERS,
    ...UNSET_SETTINGS,
    version: 1,
    defaults: DEFAULTS,
  });
});

test("组合首次配置后非空:配过之前空组合照收,配过非空之后不再收空", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  assert.deepEqual(await readSettings(h), {
    reviewers: [],
    ...UNSET_SETTINGS,
    version: 1,
    defaults: DEFAULTS,
  });

  // 库里现存的组合是空的:这一次照收空组合,上限与等级各自落库(spec #300)。
  const empty = await putSettings(h, { maxChangedLinesPerBatch: 800 });
  assert.equal(empty.status, 200, await empty.text());
  assert.deepEqual(await readSettings(h), {
    reviewers: [],
    ...UNSET_SETTINGS,
    maxChangedLinesPerBatch: 800,
    version: 2,
    defaults: DEFAULTS,
  });

  // 配过一份非空的之后不再收空:要停掉审查不走这一格。
  seedAvailableModelService(h, "test", ["global-model"]);
  assert.equal((await putSettings(h, { reviewers: SEEDED_REVIEWERS })).status, 200);
  const cleared = await putSettings(h, { reviewers: [] });
  assert.equal(cleared.status, 400);
  assert.match(await cleared.text(), /至少要选一个模型/);
  assert.deepEqual((await readSettings(h)).reviewers, SEEDED_REVIEWERS);
});

test("全局组合按模型服务候选校验，失效模型只门禁组合本身的写入", async () => {
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

  // 往这份组合里再添一个模型即算改了组合:候选校验当场拒收,两类原因都写明。
  const beforeBlockedWrites = serviceState();
  const blocked = await putSettings(h, {
    reviewers: [...selected, { provider: "another-vanished-service", model: "gone" }],
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.text()), /模型凭据不可用.*模型来源消失/);

  // 失效模型门禁的是组合本身:组合原样未动的那一次照常保存得下,上限不被连坐。
  const limitOnly = await putSettings(h, { maxChangedLinesPerBatch: 733 });
  assert.equal(limitOnly.status, 200);
  assert.deepEqual(await limitOnly.json(), {
    reviewers: selected,
    ...UNSET_SETTINGS,
    maxChangedLinesPerBatch: 733,
    version: 2,
    defaults: DEFAULTS,
  });
  assert.deepEqual(serviceState(), beforeBlockedWrites, "组合与上限写入不应改服务或模型来源");

  setRecoveringCredential("verified");
  const recoveredResponse = await h.api("GET", "/model-services");
  const recoveredBody = (await recoveredResponse.json()) as {
    candidates: { identity: string; available: boolean }[];
  };
  assert.equal(
    recoveredBody.candidates.find((model) => model.identity === "recovering-service:saved")?.available,
    true,
  );
  assert.deepEqual((await readSettings(h)).reviewers, selected);

  // 去掉那个来源消失的,剩下两个都可用:组合与上限在同一次保存里一起落地。
  const beforeMissingRemoval = serviceState();
  const withoutMissing = selected.slice(0, 2);
  const removedMissing = await putSettings(h, { reviewers: withoutMissing });
  assert.equal(removedMissing.status, 200);
  assert.deepEqual(await removedMissing.json(), {
    reviewers: withoutMissing,
    ...UNSET_SETTINGS,
    maxChangedLinesPerBatch: 733,
    version: 3,
    defaults: DEFAULTS,
  });
  assert.deepEqual(serviceState(), beforeMissingRemoval);

  setRecoveringCredential("pending-reverification");
  const beforeUnavailableRemoval = serviceState();
  const removedUnavailable = await putSettings(h, { reviewers: [selected[0]!] });
  assert.equal(removedUnavailable.status, 200);
  assert.deepEqual(await removedUnavailable.json(), {
    reviewers: [selected[0]],
    ...UNSET_SETTINGS,
    maxChangedLinesPerBatch: 733,
    version: 4,
    defaults: DEFAULTS,
  });
  assert.deepEqual(serviceState(), beforeUnavailableRemoval);
});

test("非法的 reviewers 被既有校验拒绝,报错标注来源是全局这一层", async () => {
  const h = await startPanelHarness(cleanups);

  const missingField = await putSettings(h, { reviewers: [{ provider: "deepseek" }] });
  assert.equal(missingField.status, 400);
  assert.match(((await missingField.json()) as { error: string }).error, /全局模型组合.*model/);

  const duplicate = await putSettings(h, {
    reviewers: [
      { provider: "a", model: "same" },
      { provider: "a", model: "same" },
    ],
  });
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /a:same 选了两次/);

  // 坏入参一条都不落库:组合还是 harness 播种的那一份。
  assert.deepEqual(await readSettings(h), {
    reviewers: SEEDED_REVIEWERS,
    ...UNSET_SETTINGS,
    version: 1,
    defaults: DEFAULTS,
  });
});

test("组合里的模型已经失效:只改上限照常保存,改组合仍被拒", async () => {
  const stale = [{ provider: "vanished-service", model: "missing" }];
  const h = await startPanelHarness(cleanups, { reviewers: stale });
  seedAvailableModelService(h, "healthy-service", ["keep"]);

  // 失效模型门禁的是组合本身的写入:组合原样未动,上限不被连坐。
  const limitOnly = await putSettings(h, { maxParallelBatches: 6 });
  assert.equal(limitOnly.status, 200);
  assert.deepEqual(await limitOnly.json(), {
    reviewers: stale,
    ...UNSET_SETTINGS,
    maxParallelBatches: 6,
    version: 2,
    defaults: DEFAULTS,
  });

  // 同一场景下动了组合:那一份里还有失效模型,整份仍被拒,上限一格不改。
  const changed = await putSettings(h, {
    reviewers: [...stale, { provider: "healthy-service", model: "keep" }],
    maxParallelBatches: 7,
  });
  assert.equal(changed.status, 400);
  assert.match(await changed.text(), /模型来源消失/);
  assert.deepEqual(await readSettings(h), {
    reviewers: stale,
    ...UNSET_SETTINGS,
    maxParallelBatches: 6,
    version: 2,
    defaults: DEFAULTS,
  });
});

test("四项上限与最低报告等级取值不合法时整份拒收", async () => {
  const h = await startPanelHarness(cleanups);
  for (
    const field of [
      "maxChangedLinesPerBatch",
      "maxParallelBatches",
      "maxFilesPerBatch",
      "maxEvidenceCallsPerBatch",
    ] as const
  ) {
    for (const value of [0, -1, 1.5, "3"]) {
      const response = await putSettings(h, { [field]: value });
      assert.equal(response.status, 400, `${field} 的 ${String(value)} 应被拒绝`);
      assert.match(((await response.json()) as { error: string }).error, new RegExp(field));
    }
  }
  for (const value of ["P3", "p1", "high", 1, ""]) {
    const response = await putSettings(h, { minReportSeverity: value });
    assert.equal(response.status, 400, `${String(value)} 应被拒绝`);
    assert.match(((await response.json()) as { error: string }).error, /minReportSeverity/);
  }
  assert.deepEqual(await readSettings(h), {
    reviewers: SEEDED_REVIEWERS,
    ...UNSET_SETTINGS,
    version: 1,
    defaults: DEFAULTS,
  });
});

test("Run 快照冻结分批上限、并发数与取证上限,开跑后改设置不影响本轮", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model"]);
  seedHistoricalRepo(h);
  assert.equal(
    (await putSettings(h, {
      maxParallelBatches: 5,
      maxFilesPerBatch: 12,
      maxEvidenceCallsPerBatch: 4,
    })).status,
    200,
  );

  const store = openStore(h.db.path);
  try {
    const frozen = store.getReviewRunSnapshot(GITEA_REPO.id);
    assert.equal(frozen.maxParallelBatches, 5);
    assert.equal(frozen.maxFilesPerBatch, 12);
    assert.equal(frozen.maxEvidenceCallsPerBatch, 4);

    // 取证上限也是这一轮的:快照取出之后再改,已经开跑的这一轮读到的还是 4。
    assert.equal((await putSettings(h, { maxEvidenceCallsPerBatch: 1 })).status, 200);
    assert.equal(frozen.maxEvidenceCallsPerBatch, 4);
    assert.equal(store.getReviewRunSnapshot(GITEA_REPO.id).maxEvidenceCallsPerBatch, 1);

    // 这一轮已经拿到快照;之后改设置只影响下一次取快照。
    assert.equal((await putSettings(h, { maxFilesPerBatch: 1 })).status, 200);
    assert.equal(frozen.maxFilesPerBatch, 12);
    assert.equal(store.getReviewRunSnapshot(GITEA_REPO.id).maxFilesPerBatch, 1);

    // 留空即跟随系统默认(issue #301):快照里是 null,编排层照它自己的默认值开跑。
    assert.equal(
      (await putSettings(h, {
        maxParallelBatches: null,
        maxFilesPerBatch: null,
        maxEvidenceCallsPerBatch: null,
      })).status,
      200,
    );
    const cleared = store.getReviewRunSnapshot(GITEA_REPO.id);
    assert.deepEqual(
      {
        maxParallelBatches: cleared.maxParallelBatches,
        maxFilesPerBatch: cleared.maxFilesPerBatch,
        maxEvidenceCallsPerBatch: cleared.maxEvidenceCallsPerBatch,
      },
      { maxParallelBatches: null, maxFilesPerBatch: null, maxEvidenceCallsPerBatch: null },
    );
  } finally {
    store.close();
  }
});

test("全局组合与每仓库覆盖都拒绝新的空组合", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model"]);
  const empty = await putSettings(h, { reviewers: [] });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /至少要选一个模型/);

  // 每仓库覆盖是另一层判据(issue #69):空覆盖表达不了意图,要停掉就清成 null。
  const register = await h.api("POST", "/repos", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
  });
  assert.equal(register.status, 201);
  const { repoId } = (await register.json()) as { repoId: number };
  const override = await h.api("PUT", `/repos/${repoId}/settings`, {
    reviewers: [],
    auxiliaryModel: null,
    minReportSeverity: null,
    expectedVersion: 0,
  });
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
      await putSettings(h, { reviewers: [{ provider: "test", model: "swapped-model" }] })
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

  const bad = await putSettings(h, {
    reviewers: [{ provider: "test", model: "global-model", thinkingLevel: "turbo" }],
  });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /全局模型组合.*思考档位/);

  const saved = await putSettings(h, {
    reviewers: [
      { provider: "test", model: "global-model", thinkingLevel: "high" },
      { provider: "test", model: "second-model" },
    ],
  });
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
    (await h.api("PUT", `/repos/${repoId}/settings`, {
      reviewers: [{ provider: "test", model: "second-model", thinkingLevel: "low" }],
      auxiliaryModel: null,
      minReportSeverity: null,
      expectedVersion: 0,
    })).status,
    200,
  );
  const repos = (await (await h.api("GET", "/repos")).json()) as {
    repoId: number;
    reviewers: { thinkingLevel?: string }[] | null;
  }[];
  const row = repos.find((entry) => entry.repoId === repoId)!;
  assert.equal(row.reviewers?.[0]?.thinkingLevel, "low");

  // 取值认得、这个模型却不支持的那一档同样整组拒收:放过去只会被运行侧 clamp 成别的
  // 一档,人以为选的是这一档。
  const tooHigh = await putSettings(h, {
    reviewers: [{ provider: "test", model: "global-model", thinkingLevel: "max" }],
  });
  assert.equal(tooHigh.status, 400);
  assert.match(
    ((await tooHigh.json()) as { error: string }).error,
    /test:global-model 不支持思考档位 max/,
  );

  // 缺席即「关闭」,而 adaptive 模型连「关闭」都不支持:那一档也要显式选过。
  const implicitOff = await putSettings(h, {
    reviewers: [{ provider: "always", model: "adaptive-model" }],
  });
  assert.equal(implicitOff.status, 400);
  assert.match(
    ((await implicitOff.json()) as { error: string }).error,
    /always:adaptive-model 不支持思考档位 off/,
  );
  assert.equal(
    (await putSettings(h, {
      reviewers: [{ provider: "always", model: "adaptive-model", thinkingLevel: "medium" }],
    })).status,
    200,
  );
});

test("辅助模型随整页读写:不可用模型与它不支持的档位被拒,整份一项都不写", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model"]);
  seedAvailableModelService(h, "think", ["deep"], { reasoning: true });

  // 辅助模型与别的项一次写完:它是整份对象里的一项,没有自己的保存按钮。
  const saved = await putSettings(h, {
    auxiliaryModel: { provider: "think", model: "deep", thinkingLevel: "medium" },
    maxParallelBatches: 5,
  });
  assert.equal(saved.status, 200);
  const stored = { provider: "think", model: "deep", thinkingLevel: "medium" };
  assert.deepEqual((await readSettings(h)).auxiliaryModel, stored);

  // 不可用模型整份拒收:同一次提交里的上限也不落。
  const gone = await putSettings(h, {
    auxiliaryModel: { provider: "vanished-service", model: "missing" },
    maxParallelBatches: 6,
  });
  assert.equal(gone.status, 400);
  assert.match(((await gone.json()) as { error: string }).error, /辅助模型/);

  // 档位判据与模型组合同一套:这个模型只支持「关闭」,别的档一律拒。
  const level = await putSettings(h, {
    auxiliaryModel: { provider: "test", model: "global-model", thinkingLevel: "high" },
  });
  assert.equal(level.status, 400);
  assert.match(((await level.json()) as { error: string }).error, /不支持思考档位 high/);

  const after = await readSettings(h);
  assert.deepEqual(after.auxiliaryModel, stored, "两次拒收之后辅助模型原样");
  assert.equal(after.maxParallelBatches, 5, "被拒的那一次上限也没落");

  // 清空即回到「跟随生效模型组合的第一个」。
  assert.equal((await putSettings(h, { auxiliaryModel: null })).status, 200);
  assert.equal((await readSettings(h)).auxiliaryModel, null);
});
