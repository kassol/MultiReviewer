/**
 * 内置模型服务按模型绑定调用目标(ADR 0027,issue #261)。
 *
 * 当前依赖里 Pi 内置的 OpenRouter 表只有 Chat Completions 一种协议,所以混合协议的目录用
 * 发现桩造出来:同一家里一行走 Anthropic Messages、一行走 Chat Completions。每条用例走真实的
 * HTTP 端点与临时 SQLite,只把目录发现与模型端点打桩。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { modelIdentity } from "../src/config.ts";
import { encryptCredential } from "../src/panel/credential-crypto.ts";
import type { ReviewerOutcome } from "../src/review/finding.ts";
import {
  modelServiceTargetFingerprint,
  modelServiceTargetSetFingerprint,
  openStore,
  type ModelServiceVersionCommit,
} from "../src/review/store.ts";
import type { DiscoveredModel, ModelDiscoveryResult } from "../src/reviewer/model-service-runtime.ts";
import {
  HARNESS_PR,
  PANEL_CREDENTIAL_MASTER_KEY,
  seedHistoricalRepo,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PROVIDER = "openrouter";
const ANTHROPIC_TARGET = { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" };
const OPENAI_TARGET = { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" };
const ANTHROPIC_MODEL = "anthropic/claude-mixed";
const OPENAI_MODEL = "openai/gpt-mixed";
/** 没带自己目标的目录行:混合协议下定不了目标,单目标下沿用整家那一个。 */
const BARE_MODEL = "vendor/no-target";
/** Pi 0.84.4 内置 OpenRouter 表里真实存在的一行,目录桩故意不含它。 */
const PI_TABLE_MODEL = "aion-labs/aion-2.0";

function row(id: string, target?: { api: string; baseUrl: string }): DiscoveredModel {
  return {
    identity: modelIdentity({ provider: PROVIDER, model: id }),
    provider: PROVIDER,
    id,
    fields: target === undefined ? { name: `Row ${id}` } : { name: `Row ${id}`, ...target },
  };
}

function discovered(models: readonly DiscoveredModel[]): ModelDiscoveryResult {
  return { ok: true, models: [...models], ignoredCount: 0 };
}

type ModelCall = {
  url: string;
  bearer: string | null;
  apiKey: string | null;
  body: Record<string, unknown> | undefined;
};

/** 只截外部模型端点;面板与假 Gitea 都在回环地址上,原样放行。 */
function stubModelEndpoints(): { calls: ModelCall[]; restore: () => void } {
  const calls: ModelCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return original(input as Parameters<typeof original>[0], init);
    }
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({
      url: url.toString(),
      bearer: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
      body,
    });
    if (url.pathname.endsWith("/v1/messages")) {
      const events = [
        ["message_start", { type: "message_start", message: { id: "msg_target", type: "message", role: "assistant", content: [], model: String(body?.["model"]), stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ] as const;
      const stream = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const chunk = {
        id: "chatcmpl-target",
        object: "chat.completion.chunk",
        created: 1,
        model: String(body?.["model"]),
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ error: `unexpected ${url.toString()}` }, { status: 500 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 直接落一版内置服务。`targets` 给了就是绑定集合的新格式版本,省略即升级前的旧格式版本。 */
function seedBuiltin(
  h: PanelHarness,
  input: {
    credential: string;
    targetFingerprint: string;
    targets?: readonly { api: string; baseUrl: string }[];
    automaticModels: readonly DiscoveredModel[];
    supplements?: ModelServiceVersionCommit["supplements"];
  },
): void {
  const at = "2026-09-05T00:00:00.000Z";
  const store = openStore(h.db.path);
  try {
    assert.equal(store.commitModelServiceVersion(null, {
      provider: PROVIDER,
      type: "builtin",
      baseUrl: null,
      api: null,
      targetFingerprint: input.targetFingerprint,
      ...(input.targets === undefined ? {} : { targets: input.targets }),
      disabledReason: null,
      createdAt: at,
      updatedAt: at,
      credential: {
        state: "verified",
        apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, input.credential),
        updatedAt: at,
        verifiedAt: at,
        validationModel: modelIdentity({ provider: PROVIDER, model: input.automaticModels[0]?.id ?? "x" }),
        verificationSource: "inference",
      },
      directory: {
        state: "available",
        lastAttemptAt: at,
        lastSuccessAt: at,
        failure: null,
        ignoredModelCount: 0,
      },
      automaticModels: input.automaticModels,
      supplements: input.supplements ?? [],
    }), 1);
  } finally {
    store.close();
  }
}

type ProjectedModel = {
  id: string;
  available: boolean;
  unavailableReason: string | null;
  discovery: { api: string | null; baseUrl: string | null; sources: { api: string | null; baseUrl: string | null } };
};
type ProjectedService = {
  provider: string;
  version: number;
  target: { api: string | null; baseUrl: string | null };
  targets: { api: string; baseUrl: string }[];
  credential: { state: string };
  models: ProjectedModel[];
};

async function projectedService(h: PanelHarness): Promise<ProjectedService> {
  const response = await h.api("GET", "/model-services");
  assert.equal(response.status, 200);
  const body = await response.json() as { services: ProjectedService[] };
  const service = body.services.find((entry) => entry.provider === PROVIDER);
  assert.ok(service, "投影里没有 openrouter");
  return service;
}

test("混合协议目录:预览、验证、版本提交、投影与运行计划都按模型自己的目标,与目录排序无关", async () => {
  let reversed = false;
  const h = await startPanelHarness(cleanups, {
    reviewers: [
      { provider: PROVIDER, model: ANTHROPIC_MODEL },
      { provider: PROVIDER, model: OPENAI_MODEL },
      { provider: PROVIDER, model: BARE_MODEL },
    ],
    discoverModelServiceModels: async () => {
      const rows = [row(ANTHROPIC_MODEL, ANTHROPIC_TARGET), row(OPENAI_MODEL, OPENAI_TARGET), row(BARE_MODEL)];
      return discovered(reversed ? rows.reverse() : rows);
    },
  });
  const historicalHook = seedHistoricalRepo(h);
  const credential = "mixed-secret-never-returned";
  const stub = stubModelEndpoints();
  try {
    const preview = await h.api("POST", "/model-services/builtin/preview", {
      provider: PROVIDER,
      credential,
      expectedVersion: null,
    });
    const previewText = await preview.text();
    assert.equal(preview.status, 200, previewText);
    assert.equal(previewText.includes(credential), false);
    const previewBody = JSON.parse(previewText) as { targets: unknown; target?: unknown };
    assert.deepEqual(previewBody.targets, [ANTHROPIC_TARGET, OPENAI_TARGET], "预览要列出本次绑定的目标集合");
    assert.equal("target" in previewBody, false);

    // 验证 Anthropic 那一行:请求打到它自己的地址与协议,凭据走 x-api-key。
    const first = await h.api("POST", "/model-services/builtin/commit", {
      provider: PROVIDER,
      credential,
      validationModel: ANTHROPIC_MODEL,
      expectedVersion: null,
    });
    assert.equal(first.status, 200, await first.text());
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.url, "https://openrouter.ai/api/v1/messages?beta=true");
    assert.equal(stub.calls[0]!.apiKey, credential);
    assert.equal(stub.calls[0]!.body?.["model"], ANTHROPIC_MODEL);

    const expectedTargets = [ANTHROPIC_TARGET, OPENAI_TARGET];
    const setFingerprint = modelServiceTargetSetFingerprint(expectedTargets);
    let store = openStore(h.db.path);
    let record = store.getModelService(PROVIDER)!;
    store.close();
    assert.equal(record.version, 1);
    assert.deepEqual(record.targets?.map(({ api, baseUrl }) => ({ api, baseUrl })), expectedTargets);
    assert.equal(record.targetFingerprint, setFingerprint);
    assert.notEqual(setFingerprint, modelServiceTargetFingerprint(ANTHROPIC_TARGET.baseUrl, ANTHROPIC_TARGET.api));

    // 目录反过来排、换验证 Chat Completions 那一行:绑定集合与指纹一个都不变。
    reversed = true;
    const second = await h.api("POST", "/model-services/builtin/commit", {
      provider: PROVIDER,
      credential,
      validationModel: OPENAI_MODEL,
      expectedVersion: 1,
    });
    assert.equal(second.status, 200, await second.text());
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(stub.calls[1]!.bearer, `Bearer ${credential}`);
    store = openStore(h.db.path);
    record = store.getModelService(PROVIDER)!;
    store.close();
    assert.equal(record.version, 2);
    assert.deepEqual(record.targets?.map(({ api, baseUrl }) => ({ api, baseUrl })), expectedTargets);
    assert.equal(record.targetFingerprint, setFingerprint);

    const service = await projectedService(h);
    assert.deepEqual(service.target, { baseUrl: null, api: null });
    assert.deepEqual(service.targets, expectedTargets);
    assert.equal(service.credential.state, "verified");
    const byId = new Map(service.models.map((model) => [model.id, model]));
    const claude = byId.get(ANTHROPIC_MODEL)!;
    assert.deepEqual(
      {
        available: claude.available,
        api: claude.discovery.api,
        baseUrl: claude.discovery.baseUrl,
        sources: { api: claude.discovery.sources.api, baseUrl: claude.discovery.sources.baseUrl },
      },
      { available: true, ...ANTHROPIC_TARGET, sources: { api: "pi-catalog", baseUrl: "pi-catalog" } },
    );
    assert.deepEqual(
      { available: byId.get(OPENAI_MODEL)!.available, api: byId.get(OPENAI_MODEL)!.discovery.api, baseUrl: byId.get(OPENAI_MODEL)!.discovery.baseUrl },
      { available: true, ...OPENAI_TARGET },
    );
    assert.deepEqual(
      { available: byId.get(BARE_MODEL)!.available, reason: byId.get(BARE_MODEL)!.unavailableReason },
      { available: false, reason: "target-unresolved" },
      "没带目标的行在混合协议下不能猜任何一个目标",
    );

    // 运行计划:每个 Reviewer 冻结自己的目标;定不了目标的那一项明确失败,不拿首项顶替。
    assert.equal((await h.deliverViaHook("sha-mixed-targets", historicalHook)).status, 200);
    await h.settledAtLeast(1);
    const plans = h.runtimePlans[0]!;
    assert.deepEqual(
      plans.map((plan) => [plan.spec.model, plan.target, plan.runtimeModel?.api, plan.runtimeModel?.baseUrl, plan.credential, plan.failure]),
      [
        [ANTHROPIC_MODEL, { baseUrl: ANTHROPIC_TARGET.baseUrl, api: ANTHROPIC_TARGET.api }, "anthropic-messages", "https://openrouter.ai/api", credential, null],
        [OPENAI_MODEL, { baseUrl: OPENAI_TARGET.baseUrl, api: OPENAI_TARGET.api }, "openai-completions", "https://openrouter.ai/api/v1", credential, null],
        [BARE_MODEL, null, undefined, undefined, null, `${modelIdentity({ provider: PROVIDER, model: BARE_MODEL })} 的调用目标未经验证,这次没跑。去模型服务页重新验证或补录后重跑。`],
      ],
    );
    assert.equal(plans.every((plan) => plan.modelServiceVersion === 2), true);
  } finally {
    stub.restore();
  }
});

test("旧格式内置版本只延续指纹能证明的那一个目标;证明不了就待重新验证且不解密凭据", async () => {
  const credential = "legacy-secret-never-decrypted-early";
  const provenFingerprint = modelServiceTargetFingerprint(OPENAI_TARGET.baseUrl, OPENAI_TARGET.api);
  const proven = await startPanelHarness(cleanups, {
    reviewers: [{ provider: PROVIDER, model: OPENAI_MODEL }, { provider: PROVIDER, model: "manual/only" }],
    discoverModelServiceModels: async () => discovered([row(OPENAI_MODEL, OPENAI_TARGET), row(BARE_MODEL)]),
  });
  const provenHook = seedHistoricalRepo(proven);
  seedBuiltin(proven, {
    credential,
    targetFingerprint: provenFingerprint,
    automaticModels: [row(OPENAI_MODEL, OPENAI_TARGET), row(BARE_MODEL)],
    supplements: [
      { model: "manual/only", source: "manual", targetFingerprint: provenFingerprint, createdAt: "2026-09-05T00:00:00.000Z" },
      { model: "retained/only", source: "migration-retention", targetFingerprint: null, createdAt: "2026-09-05T00:00:00.000Z" },
    ],
  });
  const store = openStore(proven.db.path);
  assert.equal(store.getModelService(PROVIDER)!.targets, null, "夹具必须是没有目标集合的旧格式版本");
  store.close();

  const projected = await projectedService(proven);
  assert.equal(projected.credential.state, "verified");
  assert.deepEqual(projected.targets, [OPENAI_TARGET]);
  for (const id of [OPENAI_MODEL, BARE_MODEL, "manual/only", "retained/only"]) {
    const model = projected.models.find((entry) => entry.id === id)!;
    assert.deepEqual(
      { id, available: model.available, api: model.discovery.api, baseUrl: model.discovery.baseUrl, source: model.discovery.sources.api },
      { id, available: true, ...OPENAI_TARGET, source: "service-target" },
    );
  }
  assert.equal((await proven.deliverViaHook("sha-legacy-proven", provenHook)).status, 200);
  await proven.settledAtLeast(1);
  assert.deepEqual([...proven.snapshots[0]!], [[PROVIDER, credential]]);
  assert.deepEqual(
    proven.runtimePlans[0]!.map((plan) => [plan.target, plan.failure]),
    [
      [{ baseUrl: OPENAI_TARGET.baseUrl, api: OPENAI_TARGET.api }, null],
      [{ baseUrl: OPENAI_TARGET.baseUrl, api: OPENAI_TARGET.api }, null],
    ],
  );

  // 指纹既不是目录行的目标,也不是 Pi 当前内置表里任何一行的目标:证明不了,不猜。
  const blocked = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => discovered([row(OPENAI_MODEL, OPENAI_TARGET)]),
  });
  seedBuiltin(blocked, {
    credential,
    targetFingerprint: modelServiceTargetFingerprint("https://gone.example.test/v1", "openai-completions"),
    automaticModels: [row(OPENAI_MODEL, OPENAI_TARGET)],
  });
  const stub = stubModelEndpoints();
  try {
    const pending = await projectedService(blocked);
    assert.equal(pending.credential.state, "pending-reverification");
    assert.deepEqual(pending.targets, []);
    assert.equal(pending.models.every((model) => !model.available && model.unavailableReason === "credential-unavailable"), true);
    const refresh = await blocked.api("POST", `/model-services/${PROVIDER}/refresh`, { expectedVersion: 1 });
    assert.equal(refresh.status, 409);
    assert.match(((await refresh.json()) as { error: string }).error, /调用目标无法确认（需重新验证）/);
    const supplement = await blocked.api("POST", `/model-services/${PROVIDER}/supplements`, { model: "any/model", expectedVersion: 1 });
    assert.equal(supplement.status, 409);
    assert.equal(stub.calls.length, 0, "证明不了目标的版本不得外发凭据");

    // 重新验证是唯一的出路:显式验证之后这一版才绑上目标,旧凭据从此可用。
    const reverify = await blocked.api("POST", `/model-services/${PROVIDER}/reverify`, {
      validationModel: OPENAI_MODEL,
      expectedVersion: 1,
    });
    assert.equal(reverify.status, 200, await reverify.text());
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(stub.calls[0]!.bearer, `Bearer ${credential}`);
    const rebound = await projectedService(blocked);
    assert.equal(rebound.version, 2);
    assert.equal(rebound.credential.state, "verified");
    assert.deepEqual(rebound.targets, [OPENAI_TARGET]);
  } finally {
    stub.restore();
  }
});

test("真实目标变化后:目录刷新不改绑,新目标的模型待验证;重新验证才把新目标绑进版本", async () => {
  const credential = "rebind-secret-never-returned";
  const h = await startPanelHarness(cleanups, {
    reviewers: [],
    // 发现结果已经变成混合协议:Claude 那一行改走 Anthropic Messages。
    discoverModelServiceModels: async () => discovered([row(ANTHROPIC_MODEL, ANTHROPIC_TARGET), row(OPENAI_MODEL, OPENAI_TARGET)]),
  });
  seedBuiltin(h, {
    credential,
    targetFingerprint: modelServiceTargetSetFingerprint([OPENAI_TARGET])!,
    targets: [OPENAI_TARGET],
    automaticModels: [row(ANTHROPIC_MODEL, OPENAI_TARGET), row(OPENAI_MODEL, OPENAI_TARGET)],
  });
  const stub = stubModelEndpoints();
  try {
    const refresh = await h.api("POST", `/model-services/${PROVIDER}/refresh`, { expectedVersion: 1 });
    assert.equal(refresh.status, 200, await refresh.text());
    assert.equal(stub.calls.length, 0, "刷新只发现目录,不做推理");
    const refreshed = await projectedService(h);
    assert.equal(refreshed.version, 2);
    assert.deepEqual(refreshed.targets, [OPENAI_TARGET], "刷新不得凭目录变化改绑目标");
    const claude = refreshed.models.find((model) => model.id === ANTHROPIC_MODEL)!;
    assert.deepEqual(
      { available: claude.available, reason: claude.unavailableReason, api: claude.discovery.api, baseUrl: claude.discovery.baseUrl },
      { available: false, reason: "target-unresolved", ...ANTHROPIC_TARGET },
    );
    assert.equal(refreshed.models.find((model) => model.id === OPENAI_MODEL)!.available, true);

    // 组合写入的库内判据与投影同一口径:待验证目标的模型进不了组合,已绑目标的可以。
    const store = openStore(h.db.path);
    const settingsVersion = store.getGlobalSettings().reviewersVersion;
    assert.equal(
      store.putGlobalReviewers(settingsVersion, JSON.stringify([{ provider: PROVIDER, model: ANTHROPIC_MODEL }])),
      false,
    );
    assert.equal(
      store.putGlobalReviewers(settingsVersion, JSON.stringify([{ provider: PROVIDER, model: OPENAI_MODEL }])),
      true,
    );
    store.close();

    const reverify = await h.api("POST", `/model-services/${PROVIDER}/reverify`, {
      validationModel: ANTHROPIC_MODEL,
      expectedVersion: 2,
    });
    assert.equal(reverify.status, 200, await reverify.text());
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.url, "https://openrouter.ai/api/v1/messages?beta=true");
    assert.equal(stub.calls[0]!.apiKey, credential);
    const rebound = await projectedService(h);
    assert.equal(rebound.version, 3);
    assert.deepEqual(rebound.targets, [ANTHROPIC_TARGET, OPENAI_TARGET]);
    assert.equal(rebound.models.every((model) => model.available), true);
  } finally {
    stub.restore();
  }
});

test("模型补录:优先该模型可确认的目标,单目标可沿用,混合协议下定不了目标就明确拒绝", async () => {
  const credential = "supplement-secret-never-returned";
  const mixed = await startPanelHarness(cleanups, { reviewers: [] });
  seedBuiltin(mixed, {
    credential,
    targetFingerprint: modelServiceTargetSetFingerprint([ANTHROPIC_TARGET, OPENAI_TARGET])!,
    targets: [ANTHROPIC_TARGET, OPENAI_TARGET],
    automaticModels: [row(ANTHROPIC_MODEL, ANTHROPIC_TARGET), row(OPENAI_MODEL, OPENAI_TARGET)],
  });
  const stub = stubModelEndpoints();
  try {
    // 目录里没有、Pi 内置表里也没有:两个目标之间定不了,拒绝并指向自定义模型服务,零写入零外发。
    const ambiguous = await mixed.api("POST", `/model-services/${PROVIDER}/supplements`, {
      model: "unknown/model",
      expectedVersion: 1,
    });
    assert.equal(ambiguous.status, 409);
    const error = ((await ambiguous.json()) as { error: string }).error;
    assert.match(error, /openrouter:unknown\/model 的调用目标无法唯一确定/);
    assert.match(error, /绑定 2 个调用目标/);
    assert.match(error, /改用自定义模型服务/);
    assert.equal(stub.calls.length, 0);
    let store = openStore(mixed.db.path);
    assert.equal(store.getModelService(PROVIDER)!.version, 1);
    store.close();

    // 目录里它自己那一行的目标:验证打到 Anthropic 端点,补录绑的就是那一个目标。
    const own = await mixed.api("POST", `/model-services/${PROVIDER}/supplements`, {
      model: ANTHROPIC_MODEL,
      expectedVersion: 1,
    });
    assert.equal(own.status, 200, await own.text());
    assert.equal(stub.calls[0]!.url, "https://openrouter.ai/api/v1/messages?beta=true");
    store = openStore(mixed.db.path);
    let record = store.getModelService(PROVIDER)!;
    store.close();
    assert.equal(record.version, 2);
    assert.equal(
      record.supplements.find((entry) => entry.model === ANTHROPIC_MODEL)!.targetFingerprint,
      modelServiceTargetFingerprint(ANTHROPIC_TARGET.baseUrl, ANTHROPIC_TARGET.api),
    );

    // 目录里没有但 Pi 内置表里有它那一行:用内置表里它自己的目标(当前版本是 Chat Completions)。
    const fromTable = await mixed.api("POST", `/model-services/${PROVIDER}/supplements`, {
      model: PI_TABLE_MODEL,
      expectedVersion: 2,
    });
    assert.equal(fromTable.status, 200, await fromTable.text());
    assert.equal(stub.calls[1]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(stub.calls[1]!.body?.["model"], PI_TABLE_MODEL);
    store = openStore(mixed.db.path);
    record = store.getModelService(PROVIDER)!;
    store.close();
    assert.equal(
      record.supplements.find((entry) => entry.model === PI_TABLE_MODEL)!.targetFingerprint,
      modelServiceTargetFingerprint(OPENAI_TARGET.baseUrl, OPENAI_TARGET.api),
    );
    assert.deepEqual(record.targets?.map(({ api, baseUrl }) => ({ api, baseUrl })), [ANTHROPIC_TARGET, OPENAI_TARGET]);
    const projected = await projectedService(mixed);
    assert.equal(projected.models.find((model) => model.id === PI_TABLE_MODEL)!.available, true);
  } finally {
    stub.restore();
  }

  // 只有一个已确认目标的内置服务:目录外的 model id 沿用它,行为与升级前一致。
  const single = await startPanelHarness(cleanups, { reviewers: [] });
  seedBuiltin(single, {
    credential,
    targetFingerprint: modelServiceTargetSetFingerprint([OPENAI_TARGET])!,
    targets: [OPENAI_TARGET],
    automaticModels: [row(OPENAI_MODEL, OPENAI_TARGET)],
  });
  const singleStub = stubModelEndpoints();
  try {
    const response = await single.api("POST", `/model-services/${PROVIDER}/supplements`, {
      model: "unknown/model",
      expectedVersion: 1,
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(singleStub.calls.length, 1);
    assert.equal(singleStub.calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(singleStub.calls[0]!.body?.["model"], "unknown/model");
    const store = openStore(single.db.path);
    const record = store.getModelService(PROVIDER)!;
    store.close();
    assert.equal(
      record.supplements.find((entry) => entry.model === "unknown/model")!.targetFingerprint,
      modelServiceTargetFingerprint(OPENAI_TARGET.baseUrl, OPENAI_TARGET.api),
    );
    assert.equal(record.targetFingerprint, modelServiceTargetFingerprint(OPENAI_TARGET.baseUrl, OPENAI_TARGET.api));
  } finally {
    singleStub.restore();
  }
});

test("运行中重新验证换了目标,已开跑的轮次沿用原快照,下一轮才用新目标", async () => {
  const credential = "in-flight-secret-never-returned";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed: { run: number; version: number | null; api: string | undefined; baseUrl: string | undefined }[] = [];
  let buildCount = 0;
  let discoveryTarget = OPENAI_TARGET;
  const h = await startPanelHarness(cleanups, {
    reviewers: [{ provider: PROVIDER, model: ANTHROPIC_MODEL }],
    discoverModelServiceModels: async () => discovered([row(ANTHROPIC_MODEL, discoveryTarget)]),
    buildReviewers: (plans) => {
      buildCount += 1;
      const run = buildCount;
      return plans.map((plan) => ({
        model: modelIdentity(plan.spec),
        review: async (): Promise<ReviewerOutcome> => {
          observed.push({
            run,
            version: plan.modelServiceVersion,
            api: plan.runtimeModel?.api,
            baseUrl: plan.runtimeModel?.baseUrl,
          });
          if (run === 1) {
            entered.resolve();
            await release.promise;
          }
          return { model: modelIdentity(plan.spec), findings: [], anomalies: [], rejectedToolCalls: 0, anchorRejections: 0 };
        },
      }));
    },
  });
  const historicalHook = seedHistoricalRepo(h);
  seedBuiltin(h, {
    credential,
    targetFingerprint: modelServiceTargetSetFingerprint([OPENAI_TARGET])!,
    targets: [OPENAI_TARGET],
    automaticModels: [row(ANTHROPIC_MODEL, OPENAI_TARGET)],
  });
  const stub = stubModelEndpoints();
  try {
    assert.equal((await h.deliverViaHook("sha-in-flight-v1", historicalHook)).status, 200);
    await entered.promise;

    // 轮次跑到一半,目录里这个模型换到了 Anthropic 那一档,并经重新验证绑进新版本。
    discoveryTarget = ANTHROPIC_TARGET;
    const reverify = await h.api("POST", `/model-services/${PROVIDER}/reverify`, {
      validationModel: ANTHROPIC_MODEL,
      expectedVersion: 1,
    });
    assert.equal(reverify.status, 200, await reverify.text());
    assert.equal(stub.calls[0]!.url, "https://openrouter.ai/api/v1/messages?beta=true");
    release.resolve();
    await h.settledAtLeast(1);

    assert.deepEqual(observed.filter((entry) => entry.run === 1).map((entry) => [entry.version, entry.api, entry.baseUrl]), [
      [1, "openai-completions", "https://openrouter.ai/api/v1"],
    ]);
    assert.deepEqual(h.runtimePlans[0]![0]!.target, { baseUrl: OPENAI_TARGET.baseUrl, api: OPENAI_TARGET.api });

    const rerun = await h.api("POST", "/rerun", {
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      pullNumber: HARNESS_PR.number,
      mode: "full",
    });
    assert.equal(rerun.status, 202);
    await h.settledAtLeast(2);
    assert.deepEqual(observed.filter((entry) => entry.run === 2).map((entry) => [entry.version, entry.api, entry.baseUrl]), [
      [2, "anthropic-messages", "https://openrouter.ai/api"],
    ]);
    assert.deepEqual(h.runtimePlans[1]![0]!.target, { baseUrl: ANTHROPIC_TARGET.baseUrl, api: ANTHROPIC_TARGET.api });
  } finally {
    stub.restore();
  }
});
