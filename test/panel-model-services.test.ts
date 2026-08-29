import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { decryptCredential, encryptCredential } from "../src/panel/credential-crypto.ts";
import { hashPassword } from "../src/panel/password.ts";
import type { PanelPermission } from "../src/panel/permissions.ts";
import {
  modelServiceTargetFingerprint,
  openStore,
  type ModelReference,
  type ModelReferenceLocation,
  type ModelServiceVersionCommit,
} from "../src/review/store.ts";
import {
  PANEL_CREDENTIAL_MASTER_KEY,
  PANEL_PREFIX,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "model-service-reader-password";
const PASSWORD_HASH = await hashPassword(PASSWORD);

function service(
  provider: string,
  input: Partial<ModelServiceVersionCommit> = {},
): ModelServiceVersionCommit {
  const createdAt = "2026-08-20T01:00:00.000Z";
  return {
    provider,
    type: "builtin",
    baseUrl: null,
    api: null,
    targetFingerprint: `target:${provider}`,
    disabledReason: null,
    createdAt,
    updatedAt: "2026-08-20T02:00:00.000Z",
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, `secret-${provider}-1212`),
      updatedAt: "2026-08-20T01:30:00.000Z",
      verifiedAt: "2026-08-20T01:31:00.000Z",
      validationModel: `${provider}:validation-model`,
      verificationSource: "inference",
    },
    directory: {
      state: "available",
      lastAttemptAt: "2026-08-20T01:40:00.000Z",
      lastSuccessAt: "2026-08-20T01:40:00.000Z",
      failure: null,
      ignoredModelCount: 0,
    },
    automaticModels: [
      {
        identity: `${provider}:automatic-model`,
        provider,
        id: "automatic-model",
        fields: {},
      },
    ],
    supplements: [],
    ...input,
  };
}

function seedServices(h: PanelHarness): { ciphertexts: string[]; plaintexts: string[] } {
  const store = openStore(h.db.path);
  const plaintexts = [
    "secret-corp-gateway-1212",
    "secret-openrouter-1212",
    "secret-openai-1212",
    "secret-deepseek-1212",
  ];
  const ciphertexts = plaintexts.map((value) => encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, value));
  const corpTargetFingerprint = modelServiceTargetFingerprint(
    "https://models.corp.example/v1",
    "openai-responses",
  );

  assert.equal(
    store.commitModelServiceVersion(
      null,
      service("corp-gateway", {
        type: "custom",
        baseUrl: "https://models.corp.example/v1",
        api: "openai-responses",
        targetFingerprint: corpTargetFingerprint,
        credential: {
          state: "verified",
          apiKeyEncrypted: ciphertexts[0]!,
          updatedAt: "2026-08-20T01:30:00.000Z",
          verifiedAt: "2026-08-20T01:31:00.000Z",
          validationModel: "corp-gateway:automatic-model",
          verificationSource: "inference",
        },
        directory: {
          state: "refresh-failed",
          lastAttemptAt: "2026-08-20T02:00:00.000Z",
          lastSuccessAt: "2026-08-20T01:40:00.000Z",
          failure: "刷新超时；继续使用最近成功目录",
          ignoredModelCount: 2,
        },
        automaticModels: [
          {
            identity: "corp-gateway:automatic-model",
            provider: "corp-gateway",
            id: "automatic-model",
            fields: {
              name: "Committed Automatic Model",
              api: "openai-completions",
              baseUrl: "https://catalog-target.example/v1",
              input: ["text", "image"],
              reasoning: true,
              maxTokens: 4096,
            },
          },
          {
            identity: "corp-gateway:both-model",
            provider: "corp-gateway",
            id: "both-model",
            fields: {},
          },
        ],
        supplements: [
          {
            model: "both-model",
            source: "manual",
            targetFingerprint: corpTargetFingerprint,
            createdAt: "2026-08-20T01:10:00.000Z",
          },
          {
            model: "retained-model",
            source: "migration-retention",
            targetFingerprint: null,
            createdAt: "2026-08-20T01:11:00.000Z",
          },
        ],
      }),
    ),
    1,
  );
  assert.equal(
    store.commitModelServiceVersion(
      null,
      service("openrouter", {
        credential: {
          state: "pending-reverification",
          apiKeyEncrypted: ciphertexts[1]!,
          updatedAt: "2026-08-20T01:30:00.000Z",
          verifiedAt: null,
          validationModel: null,
          verificationSource: null,
        },
        directory: {
          state: "refresh-failed",
          lastAttemptAt: "2026-08-20T02:00:00.000Z",
          lastSuccessAt: "2026-08-20T01:40:00.000Z",
          failure: "上游返回 503；继续使用已提交快照",
          ignoredModelCount: 0,
        },
        automaticModels: [
          {
            identity: "openrouter:auto",
            provider: "openrouter",
            id: "auto",
            fields: {
              name: "Committed Snapshot, Not Pi Cache",
              api: "openai-completions",
              baseUrl: "https://committed-snapshot.example/v1",
              input: ["image"],
              reasoning: false,
              contextWindow: 7777,
              maxTokens: 333,
            },
          },
        ],
        supplements: [
          {
            model: "legacy-model",
            source: "migration-retention",
            targetFingerprint: null,
            createdAt: "2026-08-20T01:12:00.000Z",
          },
        ],
      }),
    ),
    1,
  );
  assert.equal(
    store.commitModelServiceVersion(
      null,
      service("openai", {
        type: "custom",
        baseUrl: "https://old-openai-gateway.example/v1",
        api: "openai-completions",
        disabledReason: "name-conflict",
        credential: {
          state: "verified",
          apiKeyEncrypted: ciphertexts[2]!,
          updatedAt: "2026-08-20T01:30:00.000Z",
          verifiedAt: "2026-08-20T01:31:00.000Z",
          validationModel: "openai:legacy-model",
          verificationSource: "inference",
        },
        automaticModels: [],
        supplements: [
          {
            model: "legacy-model",
            source: "manual",
            targetFingerprint: "target:openai",
            createdAt: "2026-08-20T01:12:00.000Z",
          },
        ],
      }),
    ),
    1,
  );
  const deepseekTargetFingerprint = modelServiceTargetFingerprint(
    "https://api.deepseek.com",
    "openai-completions",
  );
  assert.equal(
    store.commitModelServiceVersion(
      null,
      service("deepseek", {
        targetFingerprint: deepseekTargetFingerprint,
        credential: {
          state: "verified",
          apiKeyEncrypted: ciphertexts[3]!,
          updatedAt: "2026-08-20T01:30:00.000Z",
          verifiedAt: "2026-08-20T01:31:00.000Z",
          validationModel: "deepseek:deepseek-v4-flash",
          verificationSource: "inference",
        },
        directory: {
          state: "discovery-failed",
          lastAttemptAt: "2026-08-20T02:00:00.000Z",
          lastSuccessAt: null,
          failure: "目录发现失败；验证模型推理成功",
          ignoredModelCount: 0,
        },
        automaticModels: [],
        supplements: [
          {
            model: "deepseek-v4-flash",
            source: "manual",
            targetFingerprint: deepseekTargetFingerprint,
            createdAt: "2026-08-20T01:12:00.000Z",
          },
          {
            model: "migration-model",
            source: "migration-retention",
            targetFingerprint: null,
            createdAt: "2026-08-20T01:13:00.000Z",
          },
          {
            model: "stale-model",
            source: "manual",
            targetFingerprint: "stale-target-fingerprint",
            createdAt: "2026-08-20T01:14:00.000Z",
          },
        ],
      }),
    ),
    1,
  );
  store.close();
  return { ciphertexts, plaintexts };
}

async function cookieFor(
  h: PanelHarness,
  username: string,
  permissions: readonly PanelPermission[],
): Promise<string> {
  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: `role-${username}`,
    permissions,
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username,
    displayName: null,
    passwordHash: PASSWORD_HASH,
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.close();
  const response = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

function request(h: PanelHarness, cookie: string, path: string): Promise<Response> {
  return fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${path}`, { headers: { cookie } });
}

function mutation(
  h: PanelHarness,
  cookie: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type ModelFetchCall = {
  url: URL;
  auth: string | null;
  body: Record<string, unknown> | undefined;
};

type Candidate = {
  provider: string;
  id: string;
  identity: string;
  sources: string[];
  available: boolean;
  unavailableReason: string | null;
  unavailableReasonText: string | null;
  unavailableAction: string | null;
};

type ModelServicesBody = {
  services: Record<string, unknown>[];
  candidates: Candidate[];
};

type ModelFetchStub = { calls: ModelFetchCall[]; restore: () => void };

function stubModelFetch(
  respond: (call: ModelFetchCall, index: number) => Response | Promise<Response>,
): ModelFetchStub {
  const calls: ModelFetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return original(input as Parameters<typeof original>[0], init);
    }
    const call = {
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function successfulInference(model: string): Response {
  const chunk = {
    id: "chatcmpl-panel-validation",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [
      { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openRouterRow(id: string): Record<string, unknown> {
  return {
    id,
    name: `测试目录 ${id}`,
    context_length: 128_000,
    architecture: { input_modalities: ["text"] },
    top_provider: { context_length: 128_000, max_completion_tokens: 4096 },
    supported_parameters: ["tools"],
  };
}

test("内置候选预览只凭凭据写权限发现并脱敏，且不创建服务端草稿", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const writerCookie = await cookieFor(h, "builtin-writer", ["credential:write"]);
  const wrongCookie = await cookieFor(h, "model-only-writer", ["model:write"]);
  const plaintext = "preview-secret-never-returned";
  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  const stub = stubModelFetch((call) =>
    Response.json(call.url.hostname === "openrouter.ai" ? { data: [] } : { models: [] }),
  );
  try {
    const forbidden = await mutation(h, wrongCookie, "POST", "/model-services/builtin/preview", {
      provider: "deepseek",
      credential: plaintext,
      expectedVersion: null,
    });
    assert.equal(forbidden.status, 403);
    const missingVersion = await mutation(h, writerCookie, "POST", "/model-services/builtin/preview", {
      provider: "deepseek",
      credential: plaintext,
    });
    assert.equal(missingVersion.status, 400);

    const response = await mutation(h, writerCookie, "POST", "/model-services/builtin/preview", {
      provider: "deepseek",
      credential: plaintext,
      expectedVersion: null,
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(plaintext), false);
    const body = JSON.parse(text) as {
      provider: string;
      expectedVersion: number | null;
      target: { baseUrl: string; api: string };
      models: { identity: string; provider: string; id: string }[];
    };
    assert.equal(body.provider, "deepseek");
    assert.equal(body.expectedVersion, null);
    assert.equal(body.target.baseUrl, "https://api.deepseek.com");
    assert.equal(body.target.api, "openai-completions");
    assert.ok(body.models.length > 0);
    assert.ok(body.models.every((model) => model.provider === "deepseek"));

    const store = openStore(h.db.path);
    assert.equal(store.getModelService("deepseek"), undefined);
    store.close();
  } finally {
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});

test("内置预览失败只返回安全摘要与 request id，日志用同一 id 保留原始原因且数据库零写入", async () => {
  const provider = "deepseek";
  const credential = "preview-failure-secret";
  const upstreamDetail = "upstream-body-marker /private/runtime/models.json";
  const h = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => ({
      ok: false,
      failure: {
        code: "request-error",
        message: `${upstreamDetail}; credential=${credential}`,
      },
    }),
  });
  const cookie = await cookieFor(h, "builtin-preview-failure", ["credential:write"]);
  const logs: string[] = [];
  const priorError = console.error;
  console.error = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  try {
    const response = await mutation(h, cookie, "POST", "/model-services/builtin/preview", {
      provider,
      credential,
      expectedVersion: null,
    });
    const text = await response.text();
    assert.equal(response.status, 422);
    const body = JSON.parse(text) as { error: string; requestId: string; failure?: unknown };
    assert.match(body.requestId, /^[a-f0-9]{16}$/);
    assert.equal(body.error, "模型发现失败，请按 request id 查看服务日志");
    assert.equal("failure" in body, false);
    for (const hidden of [credential, upstreamDetail, "/private/runtime/models.json"]) {
      assert.equal(text.includes(hidden), false);
    }
    assert.equal(logs.some((line) => line.includes(body.requestId) && line.includes(upstreamDetail)), true);
    assert.equal(logs.some((line) => line.includes(credential)), false);
    const store = openStore(h.db.path);
    assert.equal(store.getModelService(provider), undefined);
    store.close();
  } finally {
    console.error = priorError;
  }
});

test("最终提交重新发现并真实推理后原子写入加密凭据、目录与版本", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "builtin-committer", ["credential:write"]);
  const credential = "commit-secret-never-returned";
  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  const stub = stubModelFetch((call) =>
    call.auth === null
      ? Response.json(call.url.hostname === "openrouter.ai" ? { data: [] } : { models: [] })
      : successfulInference(String(call.body?.["model"])),
  );
  try {
    const settingsBefore = await (await h.api("GET", "/settings")).json();
    const previewResponse = await mutation(h, cookie, "POST", "/model-services/builtin/preview", {
      provider: "deepseek",
      credential,
      expectedVersion: null,
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { models: { id: string }[] };
    const validationModel = preview.models[0]!.id;

    const response = await mutation(h, cookie, "POST", "/model-services/builtin/commit", {
      provider: "deepseek",
      credential,
      validationModel,
      expectedVersion: null,
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    assert.equal(responseText.includes(credential), false);
    const committed = JSON.parse(responseText) as {
      provider: string;
      version: number;
      credential: { state: string };
      directory: { state: string };
    };
    assert.deepEqual(committed, {
      provider: "deepseek",
      version: 1,
      credential: { state: "verified" },
      directory: { state: "available" },
    });
    const credentialCalls = stub.calls.filter((call) => call.auth === `Bearer ${credential}`);
    assert.equal(credentialCalls.length, 1, "候选凭据只应随最小真实推理外发一次");
    assert.equal(credentialCalls[0]!.url.toString(), "https://api.deepseek.com/chat/completions");
    assert.equal(credentialCalls[0]!.auth, `Bearer ${credential}`);
    assert.equal(credentialCalls[0]!.body?.["model"], validationModel);

    const store = openStore(h.db.path);
    const record = store.getModelService("deepseek")!;
    store.close();
    assert.equal(record.version, 1);
    assert.equal(record.baseUrl, null);
    assert.equal(record.api, null);
    assert.equal(record.targetFingerprint, modelServiceTargetFingerprint(
      "https://api.deepseek.com",
      "openai-completions",
    ));
    assert.equal(record.credential.state, "verified");
    assert.notEqual(record.credential.apiKeyEncrypted, credential);
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, record.credential.apiKeyEncrypted!),
      credential,
    );
    assert.equal(record.credential.validationModel, `deepseek:${validationModel}`);
    assert.equal(record.credential.verificationSource, "inference");
    assert.equal(record.directory.state, "available");
    assert.equal(record.directory.failure, null);
    assert.deepEqual(record.automaticModels.map((model) => model.id), preview.models.map((model) => model.id));
    assert.equal(responseText.includes(record.credential.apiKeyEncrypted!), false);
    assert.equal(readFileSync(h.db.path).includes(Buffer.from(credential)), false);
    const settingsAfter = await (await h.api("GET", "/settings")).json();
    assert.deepEqual(settingsAfter, settingsBefore, "创建模型服务不得自动修改全局模型组合");
  } finally {
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});
test("预览与最终目录漂移时只提交最终快照，并用目标绑定补录保住验证模型", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "builtin-drift-writer", ["credential:write"]);
  const credential = "drift-secret-never-returned";
  const previewModel = "multireviewer/preview-only-135";
  const finalModel = "multireviewer/final-only-135";
  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  let catalogCalls = 0;
  const stub = stubModelFetch((call) => {
    if (call.url.pathname.endsWith("/models")) {
      catalogCalls += 1;
      return Response.json({ data: [openRouterRow(catalogCalls === 1 ? previewModel : finalModel)] });
    }
    return successfulInference(String(call.body?.["model"]));
  });
  try {
    const previewResponse = await mutation(h, cookie, "POST", "/model-services/builtin/preview", {
      provider: "openrouter",
      credential,
      expectedVersion: null,
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { models: { id: string }[] };
    assert.ok(preview.models.some((model) => model.id === previewModel));

    const response = await mutation(h, cookie, "POST", "/model-services/builtin/commit", {
      provider: "openrouter",
      credential,
      validationModel: previewModel,
      expectedVersion: null,
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(text.includes(credential), false);
    assert.deepEqual(JSON.parse(text), {
      provider: "openrouter",
      version: 1,
      credential: { state: "verified" },
      directory: { state: "discovery-failed" },
    });
    assert.equal(catalogCalls, 2, "最终提交必须重新发现，不能复用预览结果");

    const store = openStore(h.db.path);
    const record = store.getModelService("openrouter")!;
    store.close();
    assert.equal(record.automaticModels.some((model) => model.id === previewModel), false);
    assert.equal(record.automaticModels.some((model) => model.id === finalModel), true);
    assert.equal(record.directory.state, "discovery-failed");
    assert.match(record.directory.failure!, /最终目录里已没有验证模型/);
    assert.deepEqual(
      record.supplements.find((entry) => entry.model === previewModel),
      {
        provider: "openrouter",
        model: previewModel,
        source: "manual",
        targetFingerprint: modelServiceTargetFingerprint(
          "https://openrouter.ai/api/v1",
          "openai-completions",
        ),
        createdAt: record.supplements.find((entry) => entry.model === previewModel)!.createdAt,
      },
    );
    const inferenceCalls = stub.calls.filter((call) => call.auth === `Bearer ${credential}`);
    assert.equal(inferenceCalls.length, 1);
    assert.equal(inferenceCalls[0]!.body?.["model"], previewModel);
  } finally {
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});

test("最终目录失败后仍真实验证所选模型，成功则只提交失败状态与目标绑定补录", async () => {
  const h = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => ({
      ok: false,
      failure: { code: "request-error", message: "目录上游失败" },
    }),
  });
  const cookie = await cookieFor(h, "builtin-directory-fallback", ["credential:write"]);
  const credential = "directory-fallback-secret";
  const validationModel = "deepseek-fallback-135";
  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  const stub = stubModelFetch((call) =>
    call.url.hostname === "api.deepseek.com"
      ? successfulInference(String(call.body?.["model"]))
      : Response.json({ data: [] }),
  );
  try {
    const response = await mutation(h, cookie, "POST", "/model-services/builtin/commit", {
      provider: "deepseek",
      credential,
      validationModel,
      expectedVersion: null,
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(text.includes(credential), false);

    const store = openStore(h.db.path);
    const record = store.getModelService("deepseek")!;
    store.close();
    assert.equal(record.directory.state, "discovery-failed");
    assert.equal(record.directory.failure, "目录上游失败");
    assert.deepEqual(record.automaticModels, []);
    assert.equal(record.supplements.length, 1);
    assert.equal(record.supplements[0]!.model, validationModel);
    assert.equal(record.supplements[0]!.source, "manual");
    assert.equal(record.supplements[0]!.targetFingerprint, record.targetFingerprint);
    const inferenceCalls = stub.calls.filter((call) => call.auth === `Bearer ${credential}`);
    assert.equal(inferenceCalls.length, 1);
    assert.equal(inferenceCalls[0]!.body?.["model"], validationModel);
  } finally {
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});

test("真实推理失败不创建新服务，凭据轮换失败也完整保留旧版本", async () => {
  const newHarness = await startPanelHarness(cleanups, { reviewers: [] });
  const existingHarness = await startPanelHarness(cleanups, { reviewers: [] });
  const newCookie = await cookieFor(newHarness, "builtin-new-failure", ["credential:write"]);
  const existingCookie = await cookieFor(existingHarness, "builtin-rotation-failure", ["credential:write"]);
  const oldStore = openStore(existingHarness.db.path);
  assert.equal(oldStore.commitModelServiceVersion(null, service("deepseek")), 1);
  const before = oldStore.getModelService("deepseek")!;
  oldStore.close();

  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  const newSecret = "new-service-rejected-secret";
  const rotatedSecret = "rotation-rejected-secret";
  const logs: string[] = [];
  const priorConsole = { log: console.log, warn: console.warn, error: console.error };
  const captureLog = (...values: unknown[]): void => { logs.push(values.map(String).join(" ")); };
  console.log = captureLog;
  console.warn = captureLog;
  console.error = captureLog;
  const stub = stubModelFetch((call) =>
    call.url.pathname.endsWith("/models")
      ? Response.json({ data: [] })
      : Response.json(
          { error: `上游拒绝 ${call.auth}` },
          { status: 401 },
        ),
  );
  try {
    const previewResponse = await mutation(
      newHarness,
      newCookie,
      "POST",
      "/model-services/builtin/preview",
      { provider: "deepseek", credential: newSecret, expectedVersion: null },
    );
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { models: { id: string }[] };
    const validationModel = preview.models[0]!.id;

    const newResponse = await mutation(
      newHarness,
      newCookie,
      "POST",
      "/model-services/builtin/commit",
      { provider: "deepseek", credential: newSecret, validationModel, expectedVersion: null },
    );
    const newText = await newResponse.text();
    assert.equal(newResponse.status, 422);
    assert.equal(newText.includes(newSecret), false);
    const newFailure = JSON.parse(newText) as { error: string; requestId: string; failure?: unknown };
    assert.equal(newFailure.error, "模型验证失败，请按 request id 查看服务日志");
    assert.match(newFailure.requestId, /^[a-f0-9]{16}$/);
    assert.equal("failure" in newFailure, false);
    assert.equal(logs.some((line) => line.includes(newFailure.requestId)), true);
    const newAfter = openStore(newHarness.db.path);
    assert.equal(newAfter.getModelService("deepseek"), undefined);
    newAfter.close();

    const rotationResponse = await mutation(
      existingHarness,
      existingCookie,
      "POST",
      "/model-services/builtin/commit",
      { provider: "deepseek", credential: rotatedSecret, validationModel, expectedVersion: 1 },
    );
    const rotationText = await rotationResponse.text();
    assert.equal(rotationResponse.status, 422);
    assert.equal(rotationText.includes(rotatedSecret), false);
    const existingAfter = openStore(existingHarness.db.path);
    assert.deepEqual(existingAfter.getModelService("deepseek"), before);
    existingAfter.close();
    for (const material of [newSecret, rotatedSecret, before.credential.apiKeyEncrypted!]) {
      assert.equal(logs.some((line) => line.includes(material)), false, "日志泄露了凭据材料");
    }
  } finally {
    console.log = priorConsole.log;
    console.warn = priorConsole.warn;
    console.error = priorConsole.error;
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});

test("并发旧候选只有一个能推进版本，后到提交与旧预览都返回版本冲突", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "builtin-concurrent-writer", ["credential:write"]);
  const firstSecret = "concurrent-first-secret";
  const secondSecret = "concurrent-second-secret";
  const validationModel = "deepseek-chat";
  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  const releases = new Map<string, () => void>();
  const bothReachedInference = Promise.withResolvers<void>();
  const stub = stubModelFetch((call) => {
    if (call.auth === null) {
      return Response.json(call.url.hostname === "openrouter.ai" ? { data: [] } : { models: [] });
    }
    const pending = Promise.withResolvers<Response>();
    releases.set(call.auth!, () => pending.resolve(successfulInference(String(call.body?.["model"]))));
    if (releases.size === 2) bothReachedInference.resolve();
    return pending.promise;
  });
  try {
    const commit = (credential: string) => mutation(
      h,
      cookie,
      "POST",
      "/model-services/builtin/commit",
      { provider: "deepseek", credential, validationModel, expectedVersion: null },
    );
    const firstPending = commit(firstSecret);
    const secondPending = commit(secondSecret);
    await bothReachedInference.promise;
    assert.equal(releases.size, 2, "两个并发候选没有都走到真实推理");
    releases.get(`Bearer ${firstSecret}`)!();
    const first = await firstPending;
    assert.equal(first.status, 200, await first.text());
    releases.get(`Bearer ${secondSecret}`)!();
    const second = await secondPending;
    const secondText = await second.text();
    assert.equal(second.status, 409, secondText);
    assert.equal(secondText.includes(secondSecret), false);

    const store = openStore(h.db.path);
    const record = store.getModelService("deepseek")!;
    store.close();
    assert.equal(record.version, 1);
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, record.credential.apiKeyEncrypted!),
      firstSecret,
    );

    const callsBeforeStalePreview = stub.calls.length;
    const stalePreview = await mutation(h, cookie, "POST", "/model-services/builtin/preview", {
      provider: "deepseek",
      credential: secondSecret,
      expectedVersion: null,
    });
    assert.equal(stalePreview.status, 409);
    assert.equal(stub.calls.length, callsBeforeStalePreview, "旧版本预览不应再发目录请求");
    const missingVersion = await mutation(h, cookie, "POST", "/model-services/builtin/commit", {
      provider: "deepseek",
      credential: secondSecret,
      validationModel,
    });
    assert.equal(missingVersion.status, 400, "expectedVersion 必须显式携带");
  } finally {
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});

test("同目标重验解密已存待重验凭据，真实推理成功后原子推进为已验证", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const writerCookie = await cookieFor(h, "builtin-reverify-writer", ["credential:write"]);
  const wrongCookie = await cookieFor(h, "builtin-reverify-model-writer", ["model:write"]);
  const credential = "pending-stored-secret";
  const credentialUpdatedAt = "2026-08-19T05:00:00.000Z";
  const targetFingerprint = modelServiceTargetFingerprint(
    "https://api.deepseek.com",
    "openai-completions",
  );
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service("deepseek", {
    targetFingerprint,
    credential: {
      state: "pending-reverification",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, credential),
      updatedAt: credentialUpdatedAt,
      verifiedAt: null,
      validationModel: null,
      verificationSource: null,
    },
  })), 1);
  const ciphertext = seed.getModelService("deepseek")!.credential.apiKeyEncrypted!;
  seed.close();

  const priorOffline = process.env["PI_OFFLINE"];
  process.env["PI_OFFLINE"] = "1";
  const stub = stubModelFetch((call) =>
    call.auth === null
      ? Response.json(call.url.hostname === "openrouter.ai" ? { data: [] } : { models: [] })
      : successfulInference(String(call.body?.["model"])),
  );
  try {
    const forbidden = await mutation(h, wrongCookie, "POST", "/model-services/deepseek/reverify", {
      validationModel: "deepseek-chat",
      expectedVersion: 1,
    });
    assert.equal(forbidden.status, 403);
    const missingVersion = await mutation(h, writerCookie, "POST", "/model-services/deepseek/reverify", {
      validationModel: "deepseek-chat",
    });
    assert.equal(missingVersion.status, 400);

    const response = await mutation(h, writerCookie, "POST", "/model-services/deepseek/reverify", {
      validationModel: "deepseek-chat",
      expectedVersion: 1,
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(text.includes(credential), false);
    assert.equal(text.includes(ciphertext), false);
    const inferenceCalls = stub.calls.filter((call) => call.auth === `Bearer ${credential}`);
    assert.equal(inferenceCalls.length, 1);

    const store = openStore(h.db.path);
    const record = store.getModelService("deepseek")!;
    store.close();
    assert.equal(record.version, 2);
    assert.equal(record.credential.state, "verified");
    assert.equal(record.credential.updatedAt, credentialUpdatedAt);
    assert.equal(record.credential.validationModel, "deepseek:deepseek-chat");
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, record.credential.apiKeyEncrypted!),
      credential,
    );
  } finally {
    stub.restore();
    if (priorOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = priorOffline;
  }
});

test("凭据写用户可用自定义服务同目标的已存凭据重新验证", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-reverify-writer", ["credential:write"]);
  const provider = "custom-reverify";
  const baseUrl = "https://custom-reverify.example/v1";
  const api = "openai-completions";
  const fingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const credential = "custom-pending-stored-secret";
  const credentialUpdatedAt = "2026-08-19T06:00:00.000Z";
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint: fingerprint,
    credential: {
      state: "pending-reverification",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, credential),
      updatedAt: credentialUpdatedAt,
      verifiedAt: null,
      validationModel: null,
      verificationSource: null,
    },
    supplements: [{
      model: "kept-supplement",
      source: "manual",
      targetFingerprint: fingerprint,
      createdAt: "2026-08-19T05:00:00.000Z",
    }],
  })), 1);
  const ciphertext = seed.getModelService(provider)!.credential.apiKeyEncrypted!;
  seed.close();

  const stub = stubModelFetch((call) =>
    call.url.pathname.endsWith("/models")
      ? Response.json({ data: [{ id: "validation-model" }] })
      : successfulInference(String(call.body?.["model"])),
  );
  try {
    const response = await mutation(h, cookie, "POST", `/model-services/${provider}/reverify`, {
      validationModel: "validation-model",
      expectedVersion: 1,
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(text.includes(credential), false);
    assert.equal(text.includes(ciphertext), false);
    assert.ok(stub.calls.length >= 2);
    assert.ok(stub.calls.every((call) => call.url.hostname === "custom-reverify.example"));
    assert.ok(stub.calls.every((call) => call.auth === `Bearer ${credential}`));

    const store = openStore(h.db.path);
    const record = store.getModelService(provider)!;
    store.close();
    assert.equal(record.version, 2);
    assert.equal(record.targetFingerprint, fingerprint);
    assert.equal(record.credential.state, "verified");
    assert.equal(record.credential.apiKeyEncrypted, ciphertext);
    assert.equal(record.credential.updatedAt, credentialUpdatedAt);
    assert.equal(record.credential.validationModel, `${provider}:validation-model`);
    assert.deepEqual(record.supplements.map(({ model }) => model), ["kept-supplement"]);
  } finally {
    stub.restore();
  }
});

test("删除内置凭据列出全部引用位置，清空引用后才原子推进为未配置", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const writerCookie = await cookieFor(h, "builtin-delete-writer", ["credential:write"]);
  const wrongCookie = await cookieFor(h, "builtin-delete-model-writer", ["model:write"]);
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service("deepseek", {
    credential: {
      state: "pending-reverification",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, "pending-delete-secret"),
      updatedAt: "2026-08-19T06:00:00.000Z",
      verifiedAt: null,
      validationModel: null,
      verificationSource: null,
    },
  })), 1);
  const ciphertext = seed.getModelService("deepseek")!.credential.apiKeyEncrypted!;
  assert.equal(seed.registerRepo({
    repoId: 1351,
    owner: "acme",
    repo: "follows-global",
    generation: 1,
    key: "follow-key",
  }), true);
  assert.equal(seed.registerRepo({
    repoId: 1352,
    owner: "acme",
    repo: "explicit",
    generation: 1,
    key: "explicit-key",
  }), true);
  seed.close();
  const legacyReferences = new DatabaseSync(h.db.path);
  legacyReferences.prepare("INSERT INTO global_setting (key, value) VALUES (?, ?)").run(
    "reviewers",
    JSON.stringify([{ provider: "deepseek", model: "global-model" }]),
  );
  legacyReferences.prepare("UPDATE repo SET reviewers = ? WHERE id = ?").run(
    JSON.stringify([{ provider: "deepseek", model: "override-model" }]),
    1352,
  );
  legacyReferences.close();

  const forbidden = await mutation(
    h,
    wrongCookie,
    "DELETE",
    "/model-services/deepseek/credential",
    { expectedVersion: 1 },
  );
  assert.equal(forbidden.status, 403);
  const missingVersion = await mutation(
    h,
    writerCookie,
    "DELETE",
    "/model-services/deepseek/credential",
    {},
  );
  assert.equal(missingVersion.status, 400);
  const blocked = await mutation(
    h,
    writerCookie,
    "DELETE",
    "/model-services/deepseek/credential",
    { expectedVersion: 1 },
  );
  const blockedText = await blocked.text();
  assert.equal(blocked.status, 409, blockedText);
  assert.equal(blockedText.includes(ciphertext), false);
  const blockedBody = JSON.parse(blockedText) as {
    references: { identity: string; locations: { kind: string; repositoryCount?: number; repo?: string }[] }[];
  };
  assert.deepEqual(blockedBody.references.map((entry) => entry.identity), [
    "deepseek:global-model",
    "deepseek:override-model",
  ]);
  assert.deepEqual(blockedBody.references[0]!.locations, [
    { kind: "global" },
    { kind: "following-global", repositoryCount: 1 },
  ]);
  assert.deepEqual(blockedBody.references[1]!.locations, [
    { kind: "repository-override", repoId: 1352, owner: "acme", repo: "explicit" },
  ]);

  const clear = openStore(h.db.path);
  clear.putGlobalSettings({ reviewersJson: null, maxChangedLinesPerBatch: null });
  clear.removeRepo(1351);
  clear.removeRepo(1352);
  clear.close();
  const deleted = await mutation(
    h,
    writerCookie,
    "DELETE",
    "/model-services/deepseek/credential",
    { expectedVersion: 1 },
  );
  const deletedText = await deleted.text();
  assert.equal(deleted.status, 200, deletedText);
  assert.equal(deletedText.includes(ciphertext), false);
  assert.deepEqual(JSON.parse(deletedText), {
    provider: "deepseek",
    version: 2,
    credential: { state: "unconfigured" },
  });
  const store = openStore(h.db.path);
  const record = store.getModelService("deepseek")!;
  store.close();
  assert.equal(record.version, 2);
  assert.deepEqual(record.credential, {
    state: "unconfigured",
    apiKeyEncrypted: null,
    updatedAt: null,
    verifiedAt: null,
    validationModel: null,
    verificationSource: null,
  });
  assert.equal(record.baseUrl, null);
  assert.equal(record.api, null);
  assert.equal(record.automaticModels.length, 1, "删除凭据不应顺带删除目录来源");

  const stale = await mutation(
    h,
    writerCookie,
    "DELETE",
    "/model-services/deepseek/credential",
    { expectedVersion: 1 },
  );
  assert.equal(stale.status, 409);
});

test("凭据写用户可删除自定义模型服务凭据并保留目标与模型来源", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-delete-writer", ["credential:write"]);
  const provider = "custom-delete";
  const baseUrl = "https://custom-delete.example/v1";
  const api = "openai-completions" as const;
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint,
  })), 1);
  seed.close();

  const response = await mutation(
    h,
    cookie,
    "DELETE",
    `/model-services/${provider}/credential`,
    { expectedVersion: 1 },
  );
  assert.equal(response.status, 200, await response.text());
  const store = openStore(h.db.path);
  const record = store.getModelService(provider)!;
  store.close();
  assert.equal(record.version, 2);
  assert.equal(record.type, "custom");
  assert.equal(record.baseUrl, baseUrl);
  assert.equal(record.api, api);
  assert.equal(record.targetFingerprint, targetFingerprint);
  assert.equal(record.credential.state, "unconfigured");
  assert.equal(record.credential.apiKeyEncrypted, null);
  assert.equal(record.automaticModels.length, 1);
});

test("模型服务读取按模型与凭据权限独立裁剪，合并来源并保留运行基线", async () => {
  const h = await startPanelHarness(cleanups);
  const secrets = seedServices(h);
  const modelCookie = await cookieFor(h, "model-reader", ["model:read"]);
  const credentialCookie = await cookieFor(h, "credential-reader", ["credential:read"]);
  const bothCookie = await cookieFor(h, "combined-reader", ["model:read", "credential:read"]);
  const noneCookie = await cookieFor(h, "no-model-service-access", []);

  const modelResponse = await request(h, modelCookie, "/model-services");
  assert.equal(modelResponse.status, 200);
  const modelText = await modelResponse.text();
  for (const secret of [...secrets.plaintexts, ...secrets.ciphertexts]) {
    assert.equal(modelText.includes(secret), false, "模型读取响应泄露了凭据材料");
  }
  const modelBody = JSON.parse(modelText) as ModelServicesBody;
  const corp = modelBody.services.find((entry) => entry["provider"] === "corp-gateway")!;
  assert.deepEqual(Object.keys(corp).sort(), [
    "credential",
    "directory",
    "health",
    "models",
    "name",
    "provider",
    "providerState",
    "references",
    "runCapability",
    "target",
    "type",
    "version",
  ]);
  assert.deepEqual(corp["credential"], { state: "verified" });
  assert.deepEqual(corp["target"], {
    baseUrl: "https://models.corp.example/v1",
    api: "openai-responses",
  });
  assert.deepEqual(corp["directory"], {
    state: "refresh-failed",
    lastAttemptAt: "2026-08-20T02:00:00.000Z",
    lastSuccessAt: "2026-08-20T01:40:00.000Z",
    failure: "刷新超时；继续使用最近成功目录",
    ignoredModelCount: 2,
  });
  const models = corp["models"] as {
    id: string;
    sources: string[];
    available: boolean;
    unavailableReason: string | null;
    discovery: {
      name: string | null;
      api: string | null;
      baseUrl: string | null;
      input: readonly ("text" | "image")[] | null;
      reasoning: boolean | null;
      contextWindow: number | null;
      maxOutput: number | null;
    };
    runtime: { contextWindow: number; maxOutput: number; sources: Record<string, string> };
  }[];
  assert.deepEqual(
    models.map((model) => ({ id: model.id, sources: model.sources })),
    [
      { id: "automatic-model", sources: ["automatic"] },
      { id: "both-model", sources: ["automatic", "manual"] },
      { id: "retained-model", sources: ["migration-retention"] },
    ],
  );
  assert.equal(models.every((model) => model.available), true, "刷新失败时最近成功目录仍应可用");
  assert.deepEqual(models[0]!.discovery, {
    name: "Committed Automatic Model",
    api: "openai-responses",
    baseUrl: "https://models.corp.example/v1",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: null,
    maxOutput: 4096,
    sources: {
      name: "service-interface",
      api: "service-target",
      baseUrl: "service-target",
      input: "service-interface",
      reasoning: "service-interface",
      contextWindow: null,
      maxOutput: "service-interface",
    },
  });
  assert.deepEqual(models[0]!.runtime, {
    input: ["text", "image"],
    reasoning: true,
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    contextWindow: 128_000,
    maxOutput: 4096,
    sources: {
      input: "service-interface",
      reasoning: "service-interface",
      contextWindow: "runtime-baseline",
      maxOutput: "service-interface",
    },
  });
  assert.deepEqual(models[1]!.discovery, {
    name: null,
    api: "openai-responses",
    baseUrl: "https://models.corp.example/v1",
    input: null,
    reasoning: null,
    contextWindow: null,
    maxOutput: null,
    sources: {
      name: null,
      api: "service-target",
      baseUrl: "service-target",
      input: null,
      reasoning: null,
      contextWindow: null,
      maxOutput: null,
    },
  });
  assert.deepEqual(models[1]!.runtime, {
    input: ["text"],
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 128_000,
    maxOutput: 16_000,
    sources: {
      input: "runtime-baseline",
      reasoning: "runtime-baseline",
      contextWindow: "runtime-baseline",
      maxOutput: "runtime-baseline",
    },
  });
  const builtin = modelBody.services.find((entry) => entry["provider"] === "deepseek")!;
  assert.deepEqual(builtin["target"], {
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
  });
  assert.deepEqual(builtin["directory"], {
    state: "discovery-failed",
    lastAttemptAt: "2026-08-20T02:00:00.000Z",
    lastSuccessAt: null,
    failure: "目录发现失败；验证模型推理成功",
    ignoredModelCount: 0,
  });
  const builtinModels = builtin["models"] as {
    id: string;
    sources: string[];
    available: boolean;
    unavailableReason: string | null;
    discovery: Record<string, unknown>;
    runtime: Record<string, unknown>;
  }[];
  const validationSupplement = builtinModels.find((model) => model.id === "deepseek-v4-flash")!;
  assert.deepEqual(validationSupplement.sources, ["manual"]);
  assert.equal(validationSupplement.available, true);
  assert.equal(validationSupplement.unavailableReason, null);
  assert.deepEqual(validationSupplement.discovery, {
    name: null,
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    input: null,
    reasoning: null,
    contextWindow: null,
    maxOutput: null,
    sources: {
      name: null,
      api: "service-target",
      baseUrl: "service-target",
      input: null,
      reasoning: null,
      contextWindow: null,
      maxOutput: null,
    },
  });
  assert.deepEqual(validationSupplement.runtime, {
    input: ["text"],
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 128_000,
    maxOutput: 16_000,
    sources: {
      input: "runtime-baseline",
      reasoning: "runtime-baseline",
      contextWindow: "runtime-baseline",
      maxOutput: "runtime-baseline",
    },
  });
  const migrationRetention = builtinModels.find((model) => model.id === "migration-model")!;
  assert.equal(migrationRetention.available, true);
  assert.equal(migrationRetention.unavailableReason, null);
  const staleSupplement = builtinModels.find((model) => model.id === "stale-model")!;
  assert.equal(staleSupplement.available, false);
  assert.equal(staleSupplement.unavailableReason, "model-source-missing");
  const pending = modelBody.services.find((entry) => entry["provider"] === "openrouter")!;
  assert.deepEqual(pending["credential"], { state: "pending-reverification" });
  assert.deepEqual(pending["target"], {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
  });
  const pendingModels = pending["models"] as {
    id: string;
    available: boolean;
    unavailableReason: string | null;
    discovery: Record<string, unknown>;
    runtime: Record<string, unknown>;
  }[];
  const pendingAutomatic = pendingModels.find((model) => model.id === "auto")!;
  assert.deepEqual(pendingAutomatic.discovery, {
    name: "Committed Snapshot, Not Pi Cache",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["image"],
    reasoning: false,
    contextWindow: 7777,
    maxOutput: 333,
    sources: {
      name: "pi-catalog",
      api: "service-target",
      baseUrl: "service-target",
      input: "pi-catalog",
      reasoning: "pi-catalog",
      contextWindow: "pi-catalog",
      maxOutput: "pi-catalog",
    },
  });
  assert.deepEqual(pendingAutomatic.runtime, {
    input: ["image"],
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 7777,
    maxOutput: 333,
    sources: {
      input: "pi-catalog",
      reasoning: "pi-catalog",
      contextWindow: "pi-catalog",
      maxOutput: "pi-catalog",
    },
  });
  assert.equal(pendingModels.every((model) => !model.available), true);
  assert.equal(
    pendingModels.every((model) => model.unavailableReason === "credential-unavailable"),
    true,
  );
  const conflict = modelBody.services.find((entry) => entry["provider"] === "openai")!;
  assert.equal(conflict["providerState"], "name-conflict");
  assert.deepEqual(
    (conflict["models"] as { available: boolean; unavailableReason: string | null }[]).map((model) => ({
      available: model.available,
      unavailableReason: model.unavailableReason,
    })),
    [{ available: false, unavailableReason: "provider-name-conflict" }],
  );

  const candidates = modelBody.candidates;
  assert.equal(candidates.length, new Set(candidates.map((model) => model.identity)).size);
  assert.deepEqual(
    candidates
      .filter((model) => model.provider === "corp-gateway")
      .map((model) => ({ id: model.id, sources: model.sources })),
    [
      { id: "automatic-model", sources: ["automatic"] },
      { id: "both-model", sources: ["automatic", "manual"] },
      { id: "retained-model", sources: ["migration-retention"] },
    ],
    "自动目录与补录来源合并后仍应只有一个完整模型标识",
  );
  assert.equal(
    candidates.find((model) => model.identity === "openrouter:auto"),
    undefined,
    "未被当前组合选中的不可用模型不能占候选名额",
  );
  assert.deepEqual(
    candidates.find((model) => model.identity === "test:global-model"),
    {
      provider: "test",
      id: "global-model",
      identity: "test:global-model",
      enabled: false,
      sources: [],
      available: false,
      unavailableReason: "model-source-missing",
      unavailableReasonText: "模型来源消失",
      unavailableAction: "/credentials",
      discovery: {
        name: null,
        api: null,
        baseUrl: null,
        input: null,
        reasoning: null,
        contextWindow: null,
        maxOutput: null,
        sources: {
          name: null,
          api: null,
          baseUrl: null,
          input: null,
          reasoning: null,
          contextWindow: null,
          maxOutput: null,
        },
      },
      runtime: {
        input: ["text"],
        reasoning: false,
        thinkingLevels: ["off"],
        contextWindow: 128_000,
        maxOutput: 16_000,
        sources: {
          input: "runtime-baseline",
          reasoning: "runtime-baseline",
          contextWindow: "runtime-baseline",
          maxOutput: "runtime-baseline",
        },
      },
    },
    "已经保存但服务与来源都消失的模型仍要留在统一候选里",
  );

  const credentialResponse = await request(h, credentialCookie, "/model-services");
  assert.equal(credentialResponse.status, 200);
  const credentialText = await credentialResponse.text();
  for (const secret of [...secrets.plaintexts, ...secrets.ciphertexts]) {
    assert.equal(credentialText.includes(secret), false, "凭据读取响应泄露了凭据材料");
  }
  const credentialBody = JSON.parse(credentialText) as { services: Record<string, unknown>[] };
  const credentialCorp = credentialBody.services.find((entry) => entry["provider"] === "corp-gateway")!;
  assert.deepEqual(Object.keys(credentialCorp).sort(), [
    "credential",
    "health",
    "name",
    "provider",
    "runCapability",
    "type",
    "version",
  ]);
  assert.deepEqual(credentialCorp["credential"], {
    state: "verified",
    last4: "1212",
    updatedAt: "2026-08-20T01:30:00.000Z",
    verifiedAt: "2026-08-20T01:31:00.000Z",
    validationModel: "corp-gateway:automatic-model",
    verificationSource: "inference",
  });
  assert.equal("target" in credentialCorp, false);
  assert.equal("directory" in credentialCorp, false);
  assert.equal("models" in credentialCorp, false);
  assert.equal("candidates" in credentialBody, false);

  const bothResponse = await request(h, bothCookie, "/model-services");
  assert.equal(bothResponse.status, 200);
  const bothBody = (await bothResponse.json()) as {
    services: Record<string, unknown>[];
    candidates: Candidate[];
  };
  const bothCorp = bothBody.services.find((entry) => entry["provider"] === "corp-gateway")!;
  assert.deepEqual(bothCorp["credential"], credentialCorp["credential"]);
  assert.deepEqual(bothCorp["models"], corp["models"]);
  assert.deepEqual(bothBody.candidates, candidates, "两处编辑器按不同读权限拿到的候选不能漂移");
  assert.equal((await request(h, noneCookie, "/model-services")).status, 403);

  const admin = await h.api("GET", "/model-services");
  assert.equal(admin.status, 200);
  const adminCorp = ((await admin.json()) as { services: Record<string, unknown>[] }).services.find(
    (entry) => entry["provider"] === "corp-gateway",
  )!;
  assert.deepEqual(adminCorp["credential"], credentialCorp["credential"]);
  assert.deepEqual(adminCorp["models"], corp["models"]);
});

test("模型目录支持批量停用与重新启用，并拒绝未知模型", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  seedServices(h);
  const modelWriter = await cookieFor(h, "model-state-writer", ["model:write"]);

  const initial = (await h.api("GET", "/model-services").then((response) => response.json())) as {
    services: { provider: string; version: number; models: { id: string; enabled: boolean; available: boolean }[] }[];
  };
  const corp = initial.services.find((entry) => entry.provider === "corp-gateway")!;
  assert.equal(corp.models.find((model) => model.id === "automatic-model")?.enabled, true);

  const disabled = await mutation(h, modelWriter, "PUT", "/model-services/corp-gateway/model-states", {
    models: ["automatic-model", "both-model"],
    expectedVersion: corp.version,
    enabled: false,
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { provider: "corp-gateway", enabled: false, updated: 2 });

  const projected = (await h.api("GET", "/model-services").then((response) => response.json())) as {
    services: { provider: string; models: { id: string; enabled: boolean; available: boolean; unavailableReason: string | null }[] }[];
    candidates: { identity: string }[];
  };
  const updated = projected.services.find((entry) => entry.provider === "corp-gateway")!;
  assert.equal(updated.models.find((model) => model.id === "automatic-model")?.enabled, false);
  assert.equal(updated.models.find((model) => model.id === "automatic-model")?.available, false);
  assert.equal(updated.models.find((model) => model.id === "automatic-model")?.unavailableReason, "model-disabled");
  assert.equal(projected.candidates.some((model) => model.identity === "corp-gateway:automatic-model"), false);

  const unknown = await mutation(h, modelWriter, "PUT", "/model-services/corp-gateway/model-states", {
    models: ["does-not-exist"],
    expectedVersion: corp.version,
    enabled: false,
  });
  assert.equal(unknown.status, 400);

  const reenabled = await mutation(h, modelWriter, "PUT", "/model-services/corp-gateway/model-states", {
    models: ["automatic-model"],
    expectedVersion: corp.version,
    enabled: true,
  });
  assert.equal(reenabled.status, 200);
  const store = openStore(h.db.path);
  assert.equal(store.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "corp-gateway", model: "automatic-model" }]),
    maxChangedLinesPerBatch: null,
  }), true);
  store.close();
  const blocked = await mutation(h, modelWriter, "PUT", "/model-services/corp-gateway/model-states", {
    models: ["automatic-model"],
    expectedVersion: corp.version,
    enabled: false,
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual((await blocked.json() as { references: { identity: string }[] }).references.map((entry) => entry.identity), [
    "corp-gateway:automatic-model",
  ]);
});

test("自定义服务中与 Pi 同 model id 的信息来源按字段投影", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const provider = "sub2-openai";
  const baseUrl = "https://sub2.example/v1";
  const api = "openai-completions" as const;
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const store = openStore(h.db.path);
  assert.equal(store.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, "sub2-secret-1212"),
      updatedAt: "2026-08-20T01:30:00.000Z",
      verifiedAt: "2026-08-20T01:31:00.000Z",
      validationModel: `${provider}:gpt-5.6-sol`,
      verificationSource: "inference",
    },
    automaticModels: [{
      identity: `${provider}:gpt-5.6-sol`,
      provider,
      id: "gpt-5.6-sol",
      fields: {
        name: "Sub2 GPT-5.6 Sol",
        api,
        baseUrl,
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 272_000,
        maxTokens: 128_000,
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
    }],
  })), 1);
  store.close();

  const response = await h.api("GET", "/model-services");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    services: { provider: string; models: { id: string; discovery: unknown; runtime: unknown }[] }[];
  };
  const model = body.services.find((entry) => entry.provider === provider)!.models[0]!;
  assert.deepEqual(model.discovery, {
    name: "Sub2 GPT-5.6 Sol",
    api,
    baseUrl,
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    sources: {
      name: "service-interface",
      api: "service-target",
      baseUrl: "service-target",
      input: "pi-catalog",
      reasoning: "pi-catalog",
      contextWindow: "pi-catalog",
      maxOutput: "pi-catalog",
    },
  });
  assert.deepEqual(model.runtime, {
    input: ["text", "image"],
    reasoning: true,
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    contextWindow: 272_000,
    maxOutput: 128_000,
    sources: {
      input: "pi-catalog",
      reasoning: "pi-catalog",
      contextWindow: "pi-catalog",
      maxOutput: "pi-catalog",
    },
  });
});

test("模型服务投影给出运行能力与引用位置，并隐藏没有管理事实的内置 provider", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const store = openStore(h.db.path);
  const baseUrl = "https://runtime-gateway.example/v1";
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, "openai-completions");
  assert.equal(store.commitModelServiceVersion(null, service("runtime-gateway", {
    type: "custom",
    baseUrl,
    api: "openai-completions",
    targetFingerprint,
    directory: {
      state: "discovery-failed",
      lastAttemptAt: "2026-08-20T02:00:00.000Z",
      lastSuccessAt: null,
      failure: "目录发现失败；继续使用已验证补录",
      ignoredModelCount: 0,
    },
    automaticModels: [],
    supplements: [{
      model: "manual-model",
      source: "manual",
      targetFingerprint,
      createdAt: "2026-08-20T01:10:00.000Z",
    }],
  })), 1);
  assert.equal(store.commitModelServiceVersion(null, service("openrouter", {
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
  })), 1);
  store.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "runtime-gateway", model: "manual-model" }]),
    maxChangedLinesPerBatch: null,
  });
  store.registerRepo({
    repoId: 81,
    owner: "acme",
    repo: "follows-global",
    generation: 1,
    key: "follow-key",
  });
  store.registerRepo({
    repoId: 82,
    owner: "acme",
    repo: "explicit",
    generation: 1,
    key: "explicit-key",
    reviewersJson: JSON.stringify([{ provider: "runtime-gateway", model: "manual-model" }]),
  });
  store.close();

  const cookie = await cookieFor(h, "runtime-reader", ["model:read"]);
  const first = await request(h, cookie, "/model-services");
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as ModelServicesBody;
  assert.equal(firstBody.services.some((entry) => entry["provider"] === "openrouter"), false);
  const runnable = firstBody.services.find((entry) => entry["provider"] === "runtime-gateway")!;
  assert.deepEqual(runnable["runCapability"], {
    runnable: true,
    reason: null,
    reasonText: null,
    nextAction: null,
  });
  assert.deepEqual(runnable["references"], [{
    identity: "runtime-gateway:manual-model",
    provider: "runtime-gateway",
    model: "manual-model",
    locations: [
      { kind: "global" },
      { kind: "following-global", repositoryCount: 1 },
      { kind: "repository-override", repoId: 82, owner: "acme", repo: "explicit" },
    ],
  }]);

  const search = await request(h, cookie, "/model-services/providers?query=openrouter");
  assert.equal(search.status, 200);
  assert.deepEqual((await search.json()) as unknown, {
    providers: [{
      id: "openrouter",
      name: "OpenRouter",
      configured: false,
      version: 1,
      conflict: false,
    }],
  });

  const referencedHarness = await startPanelHarness(cleanups, {
    reviewers: [{ provider: "openrouter", model: "missing" }],
  });
  const referencedStore = openStore(referencedHarness.db.path);
  assert.equal(referencedStore.commitModelServiceVersion(null, service("openrouter", {
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
  })), 1);
  referencedStore.registerRepo({
    repoId: 91,
    owner: "acme",
    repo: "references-empty-provider",
    generation: 1,
    key: "reference-key",
  });
  referencedStore.close();
  const referencedCookie = await cookieFor(referencedHarness, "reference-reader", ["model:read"]);
  const second = await request(referencedHarness, referencedCookie, "/model-services");
  const secondBody = (await second.json()) as ModelServicesBody;
  const referenced = secondBody.services.find((entry) => entry["provider"] === "openrouter")!;
  assert.deepEqual(referenced["runCapability"], {
    runnable: false,
    reason: "credential-unavailable",
    reasonText: "模型凭据不可用",
    nextAction: "configure-credential",
  });
  assert.deepEqual(referenced["references"], [{
    identity: "openrouter:missing",
    provider: "openrouter",
    model: "missing",
    locations: [
      { kind: "global" },
      { kind: "following-global", repositoryCount: 1 },
    ],
  }]);
});

test("组合候选只含可用模型与已选失效模型，内置目标漂移不解密凭据", async () => {
  const selected = [
    { provider: "openai", model: "selected-drift" },
    { provider: "candidate-custom", model: "selected-missing" },
  ];
  const h = await startPanelHarness(cleanups, { reviewers: selected });
  const store = openStore(h.db.path);
  assert.equal(store.commitModelServiceVersion(null, service("openai", {
    targetFingerprint: "stale-openai-target",
    automaticModels: [{
      identity: "openai:selected-drift",
      provider: "openai",
      id: "selected-drift",
      fields: {},
    }],
  })), 1);
  const customBaseUrl = "https://candidate-custom.example/v1";
  const customFingerprint = modelServiceTargetFingerprint(customBaseUrl, "openai-completions");
  assert.equal(store.commitModelServiceVersion(null, service("candidate-custom", {
    type: "custom",
    baseUrl: customBaseUrl,
    api: "openai-completions",
    targetFingerprint: customFingerprint,
    automaticModels: [{
      identity: "candidate-custom:available",
      provider: "candidate-custom",
      id: "available",
      fields: {},
    }],
    supplements: [{
      model: "unrelated-disabled",
      source: "manual",
      targetFingerprint: "old-custom-target",
      createdAt: "2026-08-20T01:10:00.000Z",
    }],
  })), 1);
  store.close();

  const cookie = await cookieFor(h, "candidate-reader", ["model:read", "credential:read"]);
  const response = await request(h, cookie, "/model-services");
  const body = (await response.json()) as ModelServicesBody;
  assert.equal(response.status, 200);
  assert.deepEqual(
    body.candidates.map(({ identity, available }) => ({ identity, available })),
    [
      { identity: "candidate-custom:available", available: true },
      { identity: "candidate-custom:selected-missing", available: false },
      { identity: "openai:selected-drift", available: false },
    ],
  );
  const builtin = body.services.find(({ provider }) => provider === "openai")!;
  assert.equal((builtin["credential"] as { last4: string | null }).last4, null);
});

test("Pi 内置 provider 搜索接受任一相关读写权限并标出已配置与名字冲突", async () => {
  const h = await startPanelHarness(cleanups);
  const secrets = seedServices(h);
  const permissions: PanelPermission[] = [
    "model:read",
    "model:write",
    "credential:read",
    "credential:write",
  ];

  for (const [index, permission] of permissions.entries()) {
    const cookie = await cookieFor(h, `searcher-${index}`, [permission]);
    const response = await request(h, cookie, "/model-services/providers?query=OPENR");
    assert.equal(response.status, 200, `${permission} 应可搜索内置 provider`);
    const text = await response.text();
    for (const secret of [...secrets.plaintexts, ...secrets.ciphertexts]) {
      assert.equal(text.includes(secret), false, "provider 搜索泄露了凭据材料");
    }
    const body = JSON.parse(text) as {
      providers: { id: string; name: string; configured: boolean; version: number | null; conflict: boolean }[];
    };
    assert.deepEqual(
      body.providers.map(({ id, configured, version, conflict }) => ({ id, configured, version, conflict })),
      [{ id: "openrouter", configured: true, version: 1, conflict: false }],
    );
  }

  const conflictCookie = await cookieFor(h, "conflict-searcher", ["credential:write"]);
  const conflictResponse = await request(h, conflictCookie, "/model-services/providers?query=openai");
  assert.equal(conflictResponse.status, 200);
  const conflictBody = (await conflictResponse.json()) as {
    providers: { id: string; configured: boolean; version: number | null; conflict: boolean }[];
  };
  const openai = conflictBody.providers.find(({ id }) => id === "openai");
  assert.ok(openai !== undefined);
  assert.deepEqual(
    { id: openai.id, configured: openai.configured, version: openai.version, conflict: openai.conflict },
    { id: "openai", configured: true, version: 1, conflict: true },
  );

  const noneCookie = await cookieFor(h, "searcher-without-permission", []);
  assert.equal(
    (await request(h, noneCookie, "/model-services/providers?query=openrouter")).status,
    403,
  );
});

test("自定义候选预览无草稿，最终重新发现与真实推理后原子创建", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const combined = await cookieFor(h, "custom-create-writer", ["model:write", "credential:write"]);
  const modelOnly = await cookieFor(h, "custom-create-model-only", ["model:write"]);
  const credentialOnly = await cookieFor(h, "custom-create-credential-only", ["credential:write"]);
  const credential = "custom-create-secret-never-returned";
  const candidate = {
    provider: "corp-create",
    baseUrl: "https://gateway.example/v1///?ignored=1#fragment",
    api: "openai-completions",
    credential,
    expectedVersion: null,
    reconfirmedSupplements: [],
  };
  let discoveryCalls = 0;
  const stub = stubModelFetch((call) => {
    if (call.url.pathname.endsWith("/models")) {
      discoveryCalls += 1;
      return Response.json({ data: [{ id: "reasoner-a" }, { id: "reasoner-b" }] });
    }
    return successfulInference(String(call.body?.["model"]));
  });
  try {
    assert.equal(
      (await mutation(h, modelOnly, "POST", "/model-services/custom/preview", candidate)).status,
      403,
    );
    assert.equal(
      (await mutation(h, credentialOnly, "POST", "/model-services/custom/preview", candidate)).status,
      403,
    );

    const previewResponse = await mutation(
      h,
      combined,
      "POST",
      "/model-services/custom/preview",
      candidate,
    );
    const previewText = await previewResponse.text();
    assert.equal(previewResponse.status, 200, previewText);
    assert.equal(previewText.includes(credential), false);
    assert.deepEqual(JSON.parse(previewText), {
      provider: "corp-create",
      expectedVersion: null,
      target: { baseUrl: "https://gateway.example/v1", api: "openai-completions" },
      models: [
        {
          identity: "corp-create:reasoner-a",
          provider: "corp-create",
          id: "reasoner-a",
          fields: { api: "openai-completions", baseUrl: "https://gateway.example/v1" },
          fieldSources: { api: "service-target", baseUrl: "service-target" },
        },
        {
          identity: "corp-create:reasoner-b",
          provider: "corp-create",
          id: "reasoner-b",
          fields: { api: "openai-completions", baseUrl: "https://gateway.example/v1" },
          fieldSources: { api: "service-target", baseUrl: "service-target" },
        },
      ],
      ignoredModelCount: 0,
    });
    const afterPreview = openStore(h.db.path);
    assert.equal(afterPreview.getModelService("corp-create"), undefined);
    afterPreview.close();

    const commitResponse = await mutation(
      h,
      combined,
      "POST",
      "/model-services/custom/commit",
      { ...candidate, validationModel: "reasoner-a" },
    );
    const commitText = await commitResponse.text();
    assert.equal(commitResponse.status, 200, commitText);
    assert.equal(commitText.includes(credential), false);
    assert.equal(discoveryCalls, 2, "最终提交必须重新发现，不能复用预览快照");

    const store = openStore(h.db.path);
    const record = store.getModelService("corp-create")!;
    store.close();
    assert.deepEqual(JSON.parse(commitText), {
      provider: "corp-create",
      version: 1,
      credential: { state: "verified" },
      directory: { state: "available" },
    });
    assert.equal(record.type, "custom");
    assert.equal(record.baseUrl, "https://gateway.example/v1");
    assert.equal(record.api, "openai-completions");
    assert.equal(
      record.targetFingerprint,
      modelServiceTargetFingerprint("https://gateway.example/v1", "openai-completions"),
    );
    assert.equal(record.credential.validationModel, "corp-create:reasoner-a");
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, record.credential.apiKeyEncrypted!),
      credential,
    );
    assert.deepEqual(record.automaticModels.map(({ id }) => id), ["reasoner-a", "reasoner-b"]);
    assert.equal(commitText.includes(record.credential.apiKeyEncrypted!), false);
    const candidateCalls = stub.calls.filter((call) => call.auth === `Bearer ${credential}`);
    assert.equal(candidateCalls.length, 3, "两次发现与一次真实推理都只能使用候选凭据");
    assert.equal(candidateCalls[2]!.body?.["model"], "reasoner-a");
  } finally {
    stub.restore();
  }
});

test("自定义模型发现失败无需验证模型，返回 request id 且候选保持数据库零写入", async () => {
  const credential = "custom-preview-failure-secret";
  const h = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => ({
      ok: false,
      failure: {
        code: "request-error",
        message: `upstream body at /private/models.json; credential=${credential}`,
      },
    }),
  });
  const cookie = await cookieFor(h, "custom-preview-failure", ["model:write", "credential:write"]);
  const logs: string[] = [];
  const priorError = console.error;
  console.error = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  try {
    const response = await mutation(h, cookie, "POST", "/model-services/custom/preview", {
      provider: "corp-preview-failure",
      baseUrl: "https://preview-failure.example/v1",
      api: "openai-responses",
      credential,
      expectedVersion: null,
      reconfirmedSupplements: [],
    });
    const text = await response.text();
    assert.equal(response.status, 422, text);
    const body = JSON.parse(text) as { error: string; requestId: string; failure?: unknown };
    assert.equal(body.error, "模型发现失败，请按 request id 查看服务日志");
    assert.match(body.requestId, /^[a-f0-9]{16}$/);
    assert.equal("failure" in body, false);
    for (const hidden of [credential, "/private/models.json", "upstream body"]) {
      assert.equal(text.includes(hidden), false);
    }
    assert.equal(logs.some((line) => line.includes(body.requestId) && line.includes("upstream body")), true);
    assert.equal(logs.some((line) => line.includes(credential)), false);
    const store = openStore(h.db.path);
    assert.equal(store.getModelService("corp-preview-failure"), undefined);
    store.close();
  } finally {
    console.error = priorError;
  }
});

test("未捕获的模型服务异常只返回安全摘要与 request id", async () => {
  const rawFailure = "upstream exploded at /private/provider.json";
  const h = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => {
      throw new Error(rawFailure);
    },
  });
  const cookie = await cookieFor(h, "custom-preview-throw", ["model:write", "credential:write"]);
  const logs: string[] = [];
  const priorError = console.error;
  console.error = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  try {
    const response = await mutation(h, cookie, "POST", "/model-services/custom/preview", {
      provider: "corp-preview-throw",
      baseUrl: "https://preview-throw.example/v1",
      api: "openai-responses",
      credential: "throw-secret",
      expectedVersion: null,
      reconfirmedSupplements: [],
    });
    const text = await response.text();
    assert.equal(response.status, 500, text);
    const body = JSON.parse(text) as { error: string; requestId: string };
    assert.equal(body.error, "内部错误，请按 request id 查看服务日志");
    assert.match(body.requestId, /^[a-f0-9]{16}$/);
    assert.equal(text.includes(rawFailure), false);
    assert.equal(logs.some((line) => line.includes(body.requestId) && line.includes(rawFailure)), true);
  } finally {
    console.error = priorError;
  }
});

test("自定义最终发现失败可由真实推理提交，推理失败不留空壳且所有错误脱敏", async () => {
  const discoveryCredential = "custom-directory-fallback-secret";
  const rejectedCredential = "custom-inference-rejected-secret";
  const injectedFailure =
    `目录失败 authorization: Bearer ${discoveryCredential}; ` +
    `master-key=${PANEL_CREDENTIAL_MASTER_KEY}`;
  const successHarness = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => ({
      ok: false,
      failure: { code: "request-error", message: injectedFailure },
    }),
  });
  const failureHarness = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async () => ({
      ok: false,
      failure: { code: "request-error", message: `目录也失败 ${rejectedCredential}` },
    }),
  });
  const successCookie = await cookieFor(successHarness, "custom-fallback-writer", [
    "model:write",
    "credential:write",
  ]);
  const failureCookie = await cookieFor(failureHarness, "custom-rejected-writer", [
    "model:write",
    "credential:write",
  ]);
  const logs: string[] = [];
  const priorConsole = { log: console.log, warn: console.warn, error: console.error };
  const captureLog = (...values: unknown[]): void => { logs.push(values.map(String).join(" ")); };
  console.log = captureLog;
  console.warn = captureLog;
  console.error = captureLog;
  const stub = stubModelFetch((call) => {
    if (call.auth === `Bearer ${discoveryCredential}`) {
      return successfulInference(String(call.body?.["model"]));
    }
    return Response.json(
      {
        error: {
          message:
            `credential=${rejectedCredential}; master-key=${PANEL_CREDENTIAL_MASTER_KEY}`,
        },
      },
      { status: 401 },
    );
  });
  try {
    const fallbackResponse = await mutation(
      successHarness,
      successCookie,
      "POST",
      "/model-services/custom/commit",
      {
        provider: "corp-fallback",
        baseUrl: "https://fallback.example/v1",
        api: "openai-completions",
        credential: discoveryCredential,
        validationModel: "fallback-model",
        expectedVersion: null,
        reconfirmedSupplements: [],
      },
    );
    const fallbackText = await fallbackResponse.text();
    assert.equal(fallbackResponse.status, 200, fallbackText);
    for (const material of [discoveryCredential, PANEL_CREDENTIAL_MASTER_KEY]) {
      assert.equal(fallbackText.includes(material), false);
    }
    const committedStore = openStore(successHarness.db.path);
    const committed = committedStore.getModelService("corp-fallback")!;
    committedStore.close();
    assert.equal(committed.directory.state, "discovery-failed");
    assert.equal(committed.directory.failure!.includes(discoveryCredential), false);
    assert.equal(committed.directory.failure!.includes(PANEL_CREDENTIAL_MASTER_KEY), false);
    assert.deepEqual(
      committed.supplements.map(({ model, source, targetFingerprint }) => ({ model, source, targetFingerprint })),
      [{
        model: "fallback-model",
        source: "manual",
        targetFingerprint: modelServiceTargetFingerprint(
          "https://fallback.example/v1",
          "openai-completions",
        ),
      }],
    );

    const rejectedResponse = await mutation(
      failureHarness,
      failureCookie,
      "POST",
      "/model-services/custom/commit",
      {
        provider: "corp-rejected",
        baseUrl: "https://rejected.example/v1",
        api: "openai-completions",
        credential: rejectedCredential,
        validationModel: "rejected-model",
        expectedVersion: null,
        reconfirmedSupplements: [],
      },
    );
    const rejectedText = await rejectedResponse.text();
    assert.equal(rejectedResponse.status, 422, rejectedText);
    const rejectedBody = JSON.parse(rejectedText) as { requestId: string; failure?: unknown };
    assert.match(rejectedBody.requestId, /^[a-f0-9]{16}$/);
    assert.equal("failure" in rejectedBody, false);
    for (const material of [rejectedCredential, PANEL_CREDENTIAL_MASTER_KEY]) {
      assert.equal(rejectedText.includes(material), false, `错误响应泄露了 ${material}`);
      assert.equal(logs.some((line) => line.includes(material)), false, `日志泄露了 ${material}`);
    }
    const rejectedStore = openStore(failureHarness.db.path);
    assert.equal(rejectedStore.getModelService("corp-rejected"), undefined);
    rejectedStore.close();
  } finally {
    console.log = priorConsole.log;
    console.warn = priorConsole.warn;
    console.error = priorConsole.error;
    stub.restore();
  }
});

test("自定义凭据轮换失败保留完整旧版本，同目标成功轮换保留全部来源", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-rotation-writer", ["model:write", "credential:write"]);
  const provider = "corp-rotate";
  const baseUrl = "https://rotate.example/v1";
  const api = "openai-completions";
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const oldCredential = "custom-old-rotation-secret";
  const rejectedCredential = "custom-rejected-rotation-secret";
  const acceptedCredential = "custom-accepted-rotation-secret";
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, oldCredential),
      updatedAt: "2026-08-20T01:30:00.000Z",
      verifiedAt: "2026-08-20T01:31:00.000Z",
      validationModel: `${provider}:automatic-model`,
      verificationSource: "inference",
    },
    supplements: [
      {
        model: "manual-model",
        source: "manual",
        targetFingerprint,
        createdAt: "2026-08-20T01:10:00.000Z",
      },
      {
        model: "migration-model",
        source: "migration-retention",
        targetFingerprint: null,
        createdAt: "2026-08-20T01:11:00.000Z",
      },
    ],
  })), 1);
  const before = seed.getModelService(provider)!;
  seed.close();

  const stub = stubModelFetch((call) => {
    if (call.url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "automatic-model" }] });
    }
    if (call.auth === `Bearer ${rejectedCredential}`) {
      return Response.json({ error: { message: "候选凭据被拒" } }, { status: 401 });
    }
    return successfulInference(String(call.body?.["model"]));
  });
  try {
    const callsBeforeMissing = stub.calls.length;
    const missingCredential = await mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/commit",
      {
        provider,
        baseUrl: "https://changed.example/v1",
        api,
        validationModel: "automatic-model",
        expectedVersion: 1,
        reconfirmedSupplements: [],
      },
    );
    assert.equal(missingCredential.status, 400);
    assert.equal(stub.calls.length, callsBeforeMissing, "缺少新凭据时不得向候选目标发请求");

    const rejected = await mutation(h, cookie, "POST", "/model-services/custom/commit", {
      provider,
      baseUrl,
      api,
      credential: rejectedCredential,
      validationModel: "automatic-model",
      expectedVersion: 1,
      reconfirmedSupplements: [],
    });
    assert.equal(rejected.status, 422, await rejected.text());
    const afterRejectedStore = openStore(h.db.path);
    assert.deepEqual(afterRejectedStore.getModelService(provider), before);
    afterRejectedStore.close();

    const accepted = await mutation(h, cookie, "POST", "/model-services/custom/commit", {
      provider,
      baseUrl,
      api,
      credential: acceptedCredential,
      validationModel: "automatic-model",
      expectedVersion: 1,
      reconfirmedSupplements: [],
    });
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 200, acceptedText);
    const finalStore = openStore(h.db.path);
    const final = finalStore.getModelService(provider)!;
    finalStore.close();
    assert.equal(final.version, 2);
    assert.equal(final.baseUrl, baseUrl);
    assert.equal(final.api, api);
    assert.deepEqual(final.supplements, before.supplements);
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, final.credential.apiKeyEncrypted!),
      acceptedCredential,
    );
    assert.equal(
      stub.calls.some((call) => call.auth === `Bearer ${oldCredential}`),
      false,
      "候选流程不得解密并外发旧凭据",
    );
  } finally {
    stub.restore();
  }
});

test("自定义目标切换只带入新发现与明确重录来源，并返回完整引用阻断位置", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-target-writer", ["model:write", "credential:write"]);
  const provider = "corp-switch";
  const oldBaseUrl = "https://old-switch.example/v1";
  const newBaseUrl = "https://new-switch.example/v1";
  const api = "openai-completions";
  const oldFingerprint = modelServiceTargetFingerprint(oldBaseUrl, api);
  const newFingerprint = modelServiceTargetFingerprint(newBaseUrl, api);
  const oldCredential = "custom-switch-old-secret";
  const newCredential = "custom-switch-new-secret";
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl: oldBaseUrl,
    api,
    targetFingerprint: oldFingerprint,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, oldCredential),
      updatedAt: "2026-08-20T01:30:00.000Z",
      verifiedAt: "2026-08-20T01:31:00.000Z",
      validationModel: `${provider}:old-automatic`,
      verificationSource: "inference",
    },
    automaticModels: [{
      identity: `${provider}:old-automatic`,
      provider,
      id: "old-automatic",
      fields: {},
    }],
    supplements: [
      {
        model: "manual-reconfirm",
        source: "manual",
        targetFingerprint: oldFingerprint,
        createdAt: "2026-08-20T01:10:00.000Z",
      },
      {
        model: "manual-drop",
        source: "manual",
        targetFingerprint: oldFingerprint,
        createdAt: "2026-08-20T01:11:00.000Z",
      },
      {
        model: "blocked-global",
        source: "manual",
        targetFingerprint: oldFingerprint,
        createdAt: "2026-08-20T01:12:00.000Z",
      },
      {
        model: "blocked-repo",
        source: "migration-retention",
        targetFingerprint: null,
        createdAt: "2026-08-20T01:13:00.000Z",
      },
    ],
  })), 1);
  assert.equal(seed.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider, model: "blocked-global" }]),
    maxChangedLinesPerBatch: null,
  }), true);
  seed.registerRepo({
    repoId: 8101,
    owner: "acme",
    repo: "follows-global",
    generation: 1,
    key: "following-key",
  });
  seed.registerRepo({
    repoId: 8102,
    owner: "acme",
    repo: "explicit-models",
    generation: 1,
    key: "explicit-key",
    reviewersJson: JSON.stringify([{ provider, model: "blocked-repo" }]),
  });
  const before = seed.getModelService(provider)!;
  seed.close();

  const candidate = {
    provider,
    baseUrl: newBaseUrl,
    api,
    credential: newCredential,
    validationModel: "validation-only",
    expectedVersion: 1,
    reconfirmedSupplements: [`${provider}:manual-reconfirm`],
  };
  const stub = stubModelFetch((call) =>
    call.url.pathname.endsWith("/models")
      ? Response.json({ data: [{ id: "newly-discovered" }] })
      : successfulInference(String(call.body?.["model"])),
  );
  try {
    const implicitCarryResponse = await mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/commit",
      { ...candidate, validationModel: "blocked-global" },
    );
    const implicitCarryText = await implicitCarryResponse.text();
    assert.equal(implicitCarryResponse.status, 409, implicitCarryText);
    assert.doesNotMatch(
      implicitCarryText,
      /corp-switch:blocked-global/,
      "新目标真实验证成功的模型必须成为新补录，不再算旧目标遗留来源",
    );
    assert.match(implicitCarryText, /corp-switch:blocked-repo/);

    const blockedResponse = await mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/commit",
      candidate,
    );
    const blockedText = await blockedResponse.text();
    assert.equal(blockedResponse.status, 409, blockedText);
    assert.equal(blockedText.includes(newCredential), false);
    assert.equal(blockedText.includes(oldCredential), false);
    const blocked = JSON.parse(blockedText) as {
      references: { identity: string; locations: ModelReferenceLocation[] }[];
    };
    assert.deepEqual(blocked.references, [
      {
        identity: `${provider}:blocked-global`,
        provider,
        model: "blocked-global",
        locations: [
          { kind: "global" },
          { kind: "following-global", repositoryCount: 1 },
        ],
      },
      {
        identity: `${provider}:blocked-repo`,
        provider,
        model: "blocked-repo",
        locations: [
          {
            kind: "repository-override",
            repoId: 8102,
            owner: "acme",
            repo: "explicit-models",
          },
        ],
      },
    ]);
    const afterBlockedStore = openStore(h.db.path);
    assert.deepEqual(afterBlockedStore.getModelService(provider), before);
    assert.equal(afterBlockedStore.putGlobalSettings({
      reviewersJson: JSON.stringify([]),
      maxChangedLinesPerBatch: null,
    }), true);
    assert.equal(afterBlockedStore.setRepoReviewers(8102, null), true);
    afterBlockedStore.close();

    const committedResponse = await mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/commit",
      candidate,
    );
    const committedText = await committedResponse.text();
    assert.equal(committedResponse.status, 200, committedText);
    const finalStore = openStore(h.db.path);
    const final = finalStore.getModelService(provider)!;
    assert.equal(finalStore.putGlobalSettings({
      reviewersJson: JSON.stringify([
        { provider, model: "newly-discovered" },
        { provider, model: "manual-reconfirm" },
        { provider, model: "validation-only" },
      ]),
      maxChangedLinesPerBatch: null,
    }), true);
    assert.equal(
      finalStore.setRepoReviewers(
        8102,
        JSON.stringify([{ provider, model: "newly-discovered" }]),
      ),
      true,
    );
    finalStore.close();
    assert.equal(final.version, 2);
    assert.equal(final.baseUrl, newBaseUrl);
    assert.equal(final.targetFingerprint, newFingerprint);
    assert.deepEqual(final.automaticModels.map(({ id }) => id), ["newly-discovered"]);
    assert.deepEqual(
      final.supplements.map(({ model, source, targetFingerprint, createdAt }) => ({
        model,
        source,
        targetFingerprint,
        createdAt,
      })),
      [
        {
          model: "manual-reconfirm",
          source: "manual",
          targetFingerprint: newFingerprint,
          createdAt: "2026-08-20T01:10:00.000Z",
        },
        {
          model: "validation-only",
          source: "manual",
          targetFingerprint: newFingerprint,
          createdAt: final.supplements.find(({ model }) => model === "validation-only")!.createdAt,
        },
      ],
    );
    assert.equal(final.supplements.some(({ model }) => model === "manual-drop"), false);
    assert.equal(final.supplements.some(({ model }) => model === "blocked-global"), false);
    assert.equal(final.supplements.some(({ model }) => model === "blocked-repo"), false);
    assert.equal(
      stub.calls.some((call) => call.auth === `Bearer ${oldCredential}`),
      false,
      "目标切换不得解密并向新目标发送旧凭据",
    );
    assert.ok(stub.calls.every((call) => call.url.hostname === "new-switch.example"));
  } finally {
    stub.restore();
  }
});

test("Pi 内置名称后来冲突时自定义服务自动停用，冲突消失后自动恢复且不改写版本", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const collisionBaseUrl = "https://collision.example/v1";
  const recoveryBaseUrl = "https://recovered.example/v1";
  const api = "openai-completions";
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service("openai", {
    type: "custom",
    baseUrl: collisionBaseUrl,
    api,
    targetFingerprint: modelServiceTargetFingerprint(collisionBaseUrl, api),
    disabledReason: null,
  })), 1);
  assert.equal(seed.commitModelServiceVersion(null, service("recovered-custom", {
    type: "custom",
    baseUrl: recoveryBaseUrl,
    api,
    targetFingerprint: modelServiceTargetFingerprint(recoveryBaseUrl, api),
    disabledReason: "name-conflict",
  })), 1);
  seed.close();
  const cookie = await cookieFor(h, "collision-reader", ["model:read"]);
  const writerCookie = await cookieFor(h, "collision-model-writer", ["model:write"]);
  const stub = stubModelFetch((call) => successfulInference(String(call.body?.["model"])));
  try {
    const blockedRefresh = await mutation(h, writerCookie, "POST", "/model-services/openai/refresh", {
      expectedVersion: 1,
    });
    assert.equal(blockedRefresh.status, 409, await blockedRefresh.text());
    const blockedSupplement = await mutation(
      h,
      writerCookie,
      "POST",
      "/model-services/openai/supplements",
      { model: "must-not-be-added", expectedVersion: 1 },
    );
    assert.equal(blockedSupplement.status, 409, await blockedSupplement.text());
    assert.equal(stub.calls.length, 0, "冲突服务不得发起刷新请求");

    const recoveredSupplement = await mutation(
      h,
      writerCookie,
      "POST",
      "/model-services/recovered-custom/supplements",
      { model: "recovered-supplement", expectedVersion: 1 },
    );
    assert.equal(recoveredSupplement.status, 200, await recoveredSupplement.text());
  } finally {
    stub.restore();
  }

  const response = await request(h, cookie, "/model-services");
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed !== null && typeof parsed === "object" && "services" in parsed);
  assert.ok(Array.isArray(parsed.services));
  const services = parsed.services as {
    provider: string;
    version: number;
    providerState: string;
    health: string;
    models: { identity: string; available: boolean; unavailableReason?: string }[];
  }[];
  const collided = services.find(({ provider }) => provider === "openai")!;
  assert.equal(collided.version, 1);
  assert.equal(collided.providerState, "name-conflict");
  assert.equal(collided.health, "disabled");
  assert.ok(collided.models.length > 0);
  assert.ok(collided.models.every(({ available }) => !available));
  assert.ok(
    collided.models.every(({ unavailableReason }) => unavailableReason === "provider-name-conflict"),
  );
  const recovered = services.find(({ provider }) => provider === "recovered-custom")!;
  assert.equal(recovered.version, 2);
  assert.equal(recovered.providerState, "normal");
  assert.notEqual(recovered.health, "disabled");
  assert.ok(recovered.models.every(({ available }) => available));

  const persistedStore = openStore(h.db.path);
  assert.equal(persistedStore.getModelService("openai")!.disabledReason, null);
  assert.equal(persistedStore.getModelService("recovered-custom")!.disabledReason, null);
  assert.deepEqual(
    persistedStore.getModelService("recovered-custom")!.supplements.map(({ model }) => model),
    ["recovered-supplement"],
  );
  persistedStore.close();
});

test("冲突自定义 provider 通过维护端点改名并立即刷新模型服务投影", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "conflict-rename-writer", [
    "model:read",
    "model:write",
    "credential:write",
  ]);
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service("openai", {
    type: "custom",
    baseUrl: "https://rename.example/v1",
    api: "openai-completions",
    targetFingerprint: modelServiceTargetFingerprint(
      "https://rename.example/v1",
      "openai-completions",
    ),
    disabledReason: "name-conflict",
  })), 1);
  seed.close();

  const stale = await mutation(
    h,
    cookie,
    "POST",
    "/model-services/custom/openai/rename",
    { provider: "corp-openai", expectedVersion: 2 },
  );
  assert.equal(stale.status, 409, await stale.text());

  const collision = await mutation(
    h,
    cookie,
    "POST",
    "/model-services/custom/openai/rename",
    { provider: "openrouter", expectedVersion: 1 },
  );
  assert.equal(collision.status, 409, await collision.text());

  const renamed = await mutation(
    h,
    cookie,
    "POST",
    "/model-services/custom/openai/rename",
    { provider: "corp-openai", expectedVersion: 1 },
  );
  const renamedText = await renamed.text();
  assert.equal(renamed.status, 200, renamedText);
  assert.deepEqual(JSON.parse(renamedText), { provider: "corp-openai", version: 2 });

  const projection = await request(h, cookie, "/model-services");
  const projectionText = await projection.text();
  assert.equal(projection.status, 200, projectionText);
  const body = JSON.parse(projectionText) as { services: { provider: string; version: number }[] };
  assert.equal(body.services.some(({ provider }) => provider === "openai"), false);
  assert.equal(body.services.find(({ provider }) => provider === "corp-openai")?.version, 2);

  const ordinary = openStore(h.db.path);
  assert.equal(ordinary.commitModelServiceVersion(null, service("ordinary", {
    type: "custom",
    baseUrl: "https://ordinary.example/v1",
    api: "openai-completions",
    disabledReason: null,
  })), 1);
  ordinary.close();
  const rejectedOrdinary = await mutation(
    h,
    cookie,
    "POST",
    "/model-services/custom/ordinary/rename",
    { provider: "ordinary-renamed", expectedVersion: 1 },
  );
  assert.equal(rejectedOrdinary.status, 409, await rejectedOrdinary.text());
});

test("冲突 provider 改名返回完整缺失引用并保持 HTTP 前后的数据库不变", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "conflict-rename-blocked", [
    "model:write",
    "credential:write",
  ]);
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service("openai", {
    type: "custom",
    baseUrl: "https://rename-blocked.example/v1",
    api: "openai-completions",
    targetFingerprint: modelServiceTargetFingerprint(
      "https://rename-blocked.example/v1",
      "openai-completions",
    ),
    disabledReason: "name-conflict",
  })), 1);
  seed.close();
  const sqlite = new DatabaseSync(h.db.path);
  sqlite.prepare(
    "INSERT INTO global_setting (key, value) VALUES ('reviewers', ?)",
  ).run(JSON.stringify([{ provider: "openai", model: "missing-global" }]));
  sqlite.prepare(
    `INSERT INTO repo (id, owner, repo, reviewers, registered_at)
     VALUES (71, 'acme', 'blocked', ?, '2026-08-20T12:00:00.000Z')`,
  ).run(JSON.stringify([{ provider: "openai", model: "missing-repo" }]));
  const before = {
    services: sqlite.prepare("SELECT * FROM model_service ORDER BY provider").all(),
    settings: sqlite.prepare("SELECT * FROM global_setting ORDER BY key").all(),
    repos: sqlite.prepare("SELECT * FROM repo ORDER BY id").all(),
  };
  sqlite.close();

  const response = await mutation(
    h,
    cookie,
    "POST",
    "/model-services/custom/openai/rename",
    { provider: "corp-openai", expectedVersion: 1 },
  );
  const text = await response.text();
  assert.equal(response.status, 409, text);
  const body = JSON.parse(text) as { references: ModelReference[] };
  assert.deepEqual(body.references, [
    {
      identity: "openai:missing-global",
      provider: "openai",
      model: "missing-global",
      locations: [{ kind: "global" }],
    },
    {
      identity: "openai:missing-repo",
      provider: "openai",
      model: "missing-repo",
      locations: [{
        kind: "repository-override",
        repoId: 71,
        owner: "acme",
        repo: "blocked",
      }],
    },
  ]);

  const after = new DatabaseSync(h.db.path, { readOnly: true });
  assert.deepEqual({
    services: after.prepare("SELECT * FROM model_service ORDER BY provider").all(),
    settings: after.prepare("SELECT * FROM global_setting ORDER BY key").all(),
    repos: after.prepare("SELECT * FROM repo ORDER BY id").all(),
  }, before);
  after.close();
});

test("自定义服务删除返回完整引用阻断，失败整笔回滚，成功后历史 Review Run 保留", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-delete-writer", ["model:write", "credential:write"]);
  const provider = "corp-delete";
  const baseUrl = "https://delete.example/v1";
  const api = "openai-completions";
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const credential = "custom-delete-secret";
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, credential),
      updatedAt: "2026-08-20T02:00:00.000Z",
      verifiedAt: "2026-08-20T02:01:00.000Z",
      validationModel: `${provider}:automatic-model`,
      verificationSource: "inference",
    },
    supplements: [{
      model: "delete-global",
      source: "manual",
      targetFingerprint,
      createdAt: "2026-08-20T01:59:00.000Z",
    }, {
      model: "delete-repo",
      source: "manual",
      targetFingerprint,
      createdAt: "2026-08-20T01:59:30.000Z",
    }],
  })), 1);
  seed.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider, model: "delete-global" }]),
    maxChangedLinesPerBatch: null,
  });
  seed.registerRepo({
    repoId: 8201,
    owner: "acme",
    repo: "delete-follower",
    generation: 1,
    key: "delete-follow-key",
  });
  seed.registerRepo({
    repoId: 8202,
    owner: "acme",
    repo: "delete-explicit",
    generation: 1,
    key: "delete-explicit-key",
    reviewersJson: JSON.stringify([{ provider, model: "delete-repo" }]),
  });
  const historicalRunId = seed.startRun({
    owner: "acme",
    repo: "historical-review",
    pullNumber: 136,
    headSha: "historical-custom-service-sha",
    changedFiles: 1,
    changedLines: 2,
    batchCount: 1,
    startedAt: "2026-08-20T02:02:00.000Z",
    reviewerPins: [],
  });
  seed.finishRun(historicalRunId, {
    finishedAt: "2026-08-20T02:02:01.000Z",
    durationMs: 1_000,
    failed: false,
    outcomes: [{
      model: `${provider}:automatic-model`,
      findingCount: 0,
      anomalyCount: 0,
      rejectedToolCalls: 0,
      anchorRejections: 0,
      durationMs: 1_000,
    }],
    findings: [],
  });
  const before = seed.getModelService(provider)!;
  seed.close();

  const blockedResponse = await mutation(
    h,
    cookie,
    "DELETE",
    `/model-services/custom/${provider}`,
    { expectedVersion: 1 },
  );
  const blockedText = await blockedResponse.text();
  assert.equal(blockedResponse.status, 409, blockedText);
  const blockedBody = JSON.parse(blockedText) as {
    references: { identity: string; locations: ModelReferenceLocation[] }[];
  };
  assert.deepEqual(blockedBody.references, [
    {
      identity: `${provider}:delete-global`,
      provider,
      model: "delete-global",
      locations: [
        { kind: "global" },
        { kind: "following-global", repositoryCount: 1 },
      ],
    },
    {
      identity: `${provider}:delete-repo`,
      provider,
      model: "delete-repo",
      locations: [{
        kind: "repository-override",
        repoId: 8202,
        owner: "acme",
        repo: "delete-explicit",
      }],
    },
  ]);

  const unlink = openStore(h.db.path);
  assert.equal(unlink.putGlobalSettings({ reviewersJson: JSON.stringify([]), maxChangedLinesPerBatch: null }), true);
  assert.equal(unlink.setRepoReviewers(8202, null), true);
  unlink.close();
  const sqlite = new DatabaseSync(h.db.path);
  sqlite.exec(`
    CREATE TRIGGER reject_corp_delete
    BEFORE DELETE ON model_directory
    WHEN OLD.provider = 'corp-delete'
    BEGIN
      SELECT RAISE(ABORT, 'injected model service delete failure');
    END
  `);
  const failedResponse = await mutation(
    h,
    cookie,
    "DELETE",
    `/model-services/custom/${provider}`,
    { expectedVersion: 1 },
  );
  const failedText = await failedResponse.text();
  assert.equal(failedResponse.status, 500, failedText);
  assert.equal(failedText.includes(credential), false);
  const afterFailure = openStore(h.db.path);
  assert.deepEqual(afterFailure.getModelService(provider), before);
  afterFailure.close();
  sqlite.exec("DROP TRIGGER reject_corp_delete");

  const staleResponse = await mutation(
    h,
    cookie,
    "DELETE",
    `/model-services/custom/${provider}`,
    { expectedVersion: 2 },
  );
  assert.equal(staleResponse.status, 409, await staleResponse.text());
  const deletedResponse = await mutation(
    h,
    cookie,
    "DELETE",
    `/model-services/custom/${provider}`,
    { expectedVersion: 1 },
  );
  const deletedText = await deletedResponse.text();
  assert.equal(deletedResponse.status, 200, deletedText);
  assert.deepEqual(JSON.parse(deletedText), { provider, deleted: true });
  for (const table of [
    "model_service",
    "model_service_credential",
    "model_directory",
    "model_directory_model",
    "model_supplement",
  ]) {
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE provider = ?`)
      .get(provider);
    assert.equal(Number(count?.["count"]), 0, `${table} 仍有被删服务的行`);
  }
  sqlite.close();
  const historyStore = openStore(h.db.path);
  const history = historyStore.listRuns({ limit: 10 });
  historyStore.close();
  assert.equal(
    history.find(({ id }) => id === historicalRunId)!.models[0]!.model,
    `${provider}:automatic-model`,
  );
});

test("并发同名创建与同版本修改都只有先提交者成功，旧版本预览不外发凭据", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-concurrent-writer", ["model:write", "credential:write"]);
  const provider = "corp-concurrent";
  const firstCredential = "custom-concurrent-first-secret";
  const secondCredential = "custom-concurrent-second-secret";
  const thirdCredential = "custom-concurrent-third-secret";
  const fourthCredential = "custom-concurrent-fourth-secret";
  const releases = new Map<string, () => void>();
  let bothReachedInference = Promise.withResolvers<void>();
  const stub = stubModelFetch((call) => {
    if (call.url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "race-model" }] });
    }
    const pending = Promise.withResolvers<Response>();
    releases.set(
      call.auth!,
      () => pending.resolve(successfulInference(String(call.body?.["model"]))),
    );
    if (releases.size === 2) bothReachedInference.resolve();
    return pending.promise;
  });
  try {
    const commit = (credential: string, expectedVersion: number | null): Promise<Response> => mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/commit",
      {
        provider,
        baseUrl: "https://concurrent.example/v1",
        api: "openai-completions",
        credential,
        validationModel: "race-model",
        expectedVersion,
        reconfirmedSupplements: [],
      },
    );
    const firstPending = commit(firstCredential, null);
    const secondPending = commit(secondCredential, null);
    await bothReachedInference.promise;
    releases.get(`Bearer ${firstCredential}`)!();
    const first = await firstPending;
    assert.equal(first.status, 200, await first.text());
    releases.get(`Bearer ${secondCredential}`)!();
    const second = await secondPending;
    const secondText = await second.text();
    assert.equal(second.status, 409, secondText);
    assert.equal(secondText.includes(secondCredential), false);

    const store = openStore(h.db.path);
    const record = store.getModelService(provider)!;
    store.close();
    assert.equal(record.version, 1);
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, record.credential.apiKeyEncrypted!),
      firstCredential,
    );
    const callsBeforeStalePreview = stub.calls.length;
    const stalePreview = await mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/preview",
      {
        provider,
        baseUrl: "https://concurrent.example/v1",
        api: "openai-completions",
        credential: secondCredential,
        validationModel: "race-model",
        expectedVersion: null,
        reconfirmedSupplements: [],
      },
    );
    assert.equal(stalePreview.status, 409, await stalePreview.text());
    assert.equal(stub.calls.length, callsBeforeStalePreview);

    releases.clear();
    bothReachedInference = Promise.withResolvers<void>();
    const thirdPending = commit(thirdCredential, 1);
    const fourthPending = commit(fourthCredential, 1);
    await bothReachedInference.promise;
    releases.get(`Bearer ${thirdCredential}`)!();
    const third = await thirdPending;
    assert.equal(third.status, 200, await third.text());
    releases.get(`Bearer ${fourthCredential}`)!();
    const fourth = await fourthPending;
    const fourthText = await fourth.text();
    assert.equal(fourth.status, 409, fourthText);
    assert.equal(fourthText.includes(fourthCredential), false);
    const finalStore = openStore(h.db.path);
    const final = finalStore.getModelService(provider)!;
    finalStore.close();
    assert.equal(final.version, 2);
    assert.equal(
      decryptCredential(PANEL_CREDENTIAL_MASTER_KEY, final.credential.apiKeyEncrypted!),
      thirdCredential,
    );
  } finally {
    stub.restore();
  }
});

test("新建自定义服务不能占用当前 Pi 内置名称且不会发候选网络请求", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const cookie = await cookieFor(h, "custom-name-collision-writer", [
    "model:write",
    "credential:write",
  ]);
  const stub = stubModelFetch(() => {
    assert.fail("名字冲突应在发现前拒绝");
  });
  try {
    const response = await mutation(
      h,
      cookie,
      "POST",
      "/model-services/custom/preview",
      {
        provider: "openai",
        baseUrl: "https://must-not-be-called.example/v1",
        api: "openai-completions",
        credential: "must-not-be-sent",
        validationModel: "gpt-collision",
        expectedVersion: null,
        reconfirmedSupplements: [],
      },
    );
    const text = await response.text();
    assert.equal(response.status, 409, text);
    assert.match(text, /Pi 内置 provider/);
    assert.equal(text.includes("must-not-be-sent"), false);
    assert.deepEqual(stub.calls, []);
    const store = openStore(h.db.path);
    assert.equal(store.getModelService("openai"), undefined);
    store.close();
  } finally {
    stub.restore();
  }
});

test("手动刷新成功整批替换自动快照，失败推进版本并保留最近成功目录", async () => {
  const provider = "corp-refresh";
  const credential = "refresh-secret-never-returned";
  const ciphertext = encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, credential);
  let discovery: "success" | "failure" = "success";
  const discoveryCredentials: string[] = [];
  const h = await startPanelHarness(cleanups, {
    reviewers: [],
    discoverModelServiceModels: async (candidate) => {
      discoveryCredentials.push(candidate.credential);
      if (discovery === "failure") {
        return {
          ok: false,
          failure: {
            code: "request-error",
            message:
              `刷新失败 authorization: Bearer ${credential}; ` +
              `ciphertext=${ciphertext}; master-key=${PANEL_CREDENTIAL_MASTER_KEY}`,
          },
        };
      }
      return {
        ok: true,
        ignoredCount: 2,
        models: [
          {
            identity: `${provider}:new-a`,
            provider,
            id: "new-a",
            fields: {},
          },
          {
            identity: `${provider}:new-b`,
            provider,
            id: "new-b",
            fields: {},
          },
        ],
      };
    },
  });
  const modelWriter = await cookieFor(h, "refresh-model-writer", ["model:write"]);
  const credentialWriter = await cookieFor(h, "refresh-credential-writer", ["credential:write"]);
  const targetFingerprint = modelServiceTargetFingerprint(
    "https://refresh.example/v1",
    "openai-completions",
  );
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl: "https://refresh.example/v1",
    api: "openai-completions",
    targetFingerprint,
    credential: {
      state: "verified",
      apiKeyEncrypted: ciphertext,
      updatedAt: "2026-08-20T01:00:00.000Z",
      verifiedAt: "2026-08-20T01:01:00.000Z",
      validationModel: `${provider}:old-model`,
      verificationSource: "inference",
    },
    automaticModels: [{
      identity: `${provider}:old-model`,
      provider,
      id: "old-model",
      fields: {},
    }],
    supplements: [{
      model: "supplement-kept",
      source: "manual",
      targetFingerprint,
      createdAt: "2026-08-20T01:02:00.000Z",
    }],
  })), 1);
  seed.close();

  assert.equal(
    (await mutation(h, credentialWriter, "POST", `/model-services/${provider}/refresh`, {
      expectedVersion: 1,
    })).status,
    403,
  );
  assert.deepEqual(discoveryCredentials, []);
  assert.equal(
    (await mutation(h, modelWriter, "POST", `/model-services/${provider}/refresh`, {})).status,
    400,
  );
  assert.deepEqual(discoveryCredentials, []);

  const refreshed = await mutation(h, modelWriter, "POST", `/model-services/${provider}/refresh`, {
    expectedVersion: 1,
  });
  const refreshedText = await refreshed.text();
  assert.equal(refreshed.status, 200, refreshedText);
  assert.equal(refreshedText.includes(credential), false);
  assert.deepEqual(JSON.parse(refreshedText), {
    provider,
    version: 2,
    directory: {
      state: "available",
      ignoredModelCount: 2,
      failure: null,
    },
  });
  const afterSuccessStore = openStore(h.db.path);
  const afterSuccess = afterSuccessStore.getModelService(provider)!;
  afterSuccessStore.close();
  assert.deepEqual(afterSuccess.automaticModels.map(({ id }) => id), ["new-a", "new-b"]);
  assert.deepEqual(afterSuccess.supplements.map(({ model }) => model), ["supplement-kept"]);
  assert.equal(afterSuccess.directory.state, "available");
  assert.equal(afterSuccess.directory.ignoredModelCount, 2);
  assert.equal(afterSuccess.directory.lastSuccessAt, afterSuccess.directory.lastAttemptAt);

  const callsBeforeStale = discoveryCredentials.length;
  const stale = await mutation(h, modelWriter, "POST", `/model-services/${provider}/refresh`, {
    expectedVersion: 1,
  });
  assert.equal(stale.status, 409, await stale.text());
  assert.equal(discoveryCredentials.length, callsBeforeStale, "旧版本刷新不得解密或外发凭据");

  discovery = "failure";
  const failed = await mutation(h, modelWriter, "POST", `/model-services/${provider}/refresh`, {
    expectedVersion: 2,
  });
  const failedText = await failed.text();
  assert.equal(failed.status, 200, failedText);
  for (const material of [credential, ciphertext, PANEL_CREDENTIAL_MASTER_KEY]) {
    assert.equal(failedText.includes(material), false, `刷新响应泄露了 ${material}`);
  }
  const afterFailureStore = openStore(h.db.path);
  const afterFailure = afterFailureStore.getModelService(provider)!;
  afterFailureStore.close();
  assert.equal(afterFailure.version, 3);
  assert.equal(afterFailure.directory.state, "refresh-failed");
  assert.equal(afterFailure.directory.lastSuccessAt, afterSuccess.directory.lastSuccessAt);
  assert.equal(afterFailure.directory.ignoredModelCount, 0);
  assert.deepEqual(afterFailure.automaticModels, afterSuccess.automaticModels);
  assert.deepEqual(afterFailure.supplements, afterSuccess.supplements);
  for (const material of [credential, ciphertext, PANEL_CREDENTIAL_MASTER_KEY]) {
    assert.equal(afterFailure.directory.failure!.includes(material), false, `失败状态泄露了 ${material}`);
  }
  assert.deepEqual(discoveryCredentials, [credential, credential]);
});

test("模型补录只做一次真实推理并绑定当前目标，失败与旧版本都不写入", async () => {
  const provider = "corp-supplement";
  const baseUrl = "https://supplement.example/v1";
  const api = "openai-completions";
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const credential = "supplement-secret-never-returned";
  const ciphertext = encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, credential);
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  const modelWriter = await cookieFor(h, "supplement-model-writer", ["model:write"]);
  const credentialWriter = await cookieFor(h, "supplement-credential-writer", ["credential:write"]);
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint,
    credential: {
      state: "verified",
      apiKeyEncrypted: ciphertext,
      updatedAt: "2026-08-20T02:00:00.000Z",
      verifiedAt: "2026-08-20T02:01:00.000Z",
      validationModel: `${provider}:automatic-model`,
      verificationSource: "inference",
    },
  })), 1);
  assert.equal(seed.commitModelServiceVersion(null, service("corp-stale-target", {
    type: "custom",
    baseUrl: "https://stale-target.example/v1",
    api,
    targetFingerprint: "different-target-fingerprint",
    credential: {
      state: "verified",
      apiKeyEncrypted: ciphertext,
      updatedAt: "2026-08-20T02:00:00.000Z",
      verifiedAt: "2026-08-20T02:01:00.000Z",
      validationModel: "corp-stale-target:automatic-model",
      verificationSource: "inference",
    },
  })), 1);
  seed.close();

  let inferenceSucceeds = true;
  const stub = stubModelFetch((call) => {
    assert.equal(call.url.pathname.endsWith("/models"), false, "模型补录不得顺带刷新目录");
    if (inferenceSucceeds) return successfulInference(String(call.body?.["model"]));
    return Response.json(
      {
        error: {
          message:
            `credential=${credential}; ciphertext=${ciphertext}; ` +
            `master-key=${PANEL_CREDENTIAL_MASTER_KEY}`,
        },
      },
      { status: 401 },
    );
  });
  try {
    const requestBody = { model: "manual/only", expectedVersion: 1 };
    assert.equal(
      (await mutation(
        h,
        credentialWriter,
        "POST",
        `/model-services/${provider}/supplements`,
        requestBody,
      )).status,
      403,
    );
    assert.equal(stub.calls.length, 0);
    assert.equal(
      (await mutation(
        h,
        modelWriter,
        "POST",
        `/model-services/${provider}/supplements`,
        { model: "manual/only" },
      )).status,
      400,
    );
    assert.equal(stub.calls.length, 0);
    assert.equal(
      (await mutation(
        h,
        modelWriter,
        "POST",
        `/model-services/${provider}/supplements`,
        { model: "manual/only", expectedVersion: 1, name: "Invented trusted name" },
      )).status,
      400,
    );
    assert.equal(stub.calls.length, 0);
    assert.equal(
      (await mutation(
        h,
        modelWriter,
        "POST",
        `/model-services/${provider}/supplements`,
        { model: "manual/only", expectedVersion: 2 },
      )).status,
      409,
    );
    assert.equal(stub.calls.length, 0);

    const added = await mutation(
      h,
      modelWriter,
      "POST",
      `/model-services/${provider}/supplements`,
      requestBody,
    );
    const addedText = await added.text();
    assert.equal(added.status, 200, addedText);
    assert.deepEqual(JSON.parse(addedText), {
      provider,
      model: "manual/only",
      identity: `${provider}:manual/only`,
      source: "manual",
      version: 2,
    });
    assert.equal(stub.calls.length, 1, "补录必须且只能执行一次真实推理");
    assert.equal(stub.calls[0]!.url.hostname, "supplement.example");
    assert.equal(stub.calls[0]!.auth, `Bearer ${credential}`);
    assert.equal(stub.calls[0]!.body?.["model"], "manual/only");
    const stored = openStore(h.db.path);
    const afterAdd = stored.getModelService(provider)!;
    stored.close();
    assert.equal(afterAdd.version, 2);
    assert.deepEqual(afterAdd.supplements, [{
      provider,
      model: "manual/only",
      source: "manual",
      targetFingerprint,
      createdAt: afterAdd.supplements[0]!.createdAt,
    }]);

    const projectedResponse = await h.api("GET", "/model-services");
    const projectedText = await projectedResponse.text();
    assert.equal(projectedResponse.status, 200, projectedText);
    for (const material of [credential, ciphertext, PANEL_CREDENTIAL_MASTER_KEY]) {
      assert.equal(projectedText.includes(material), false);
    }
    const projected = JSON.parse(projectedText) as {
      services: { provider: string; models: { id: string; sources: string[]; discovery: unknown; runtime: unknown }[] }[];
    };
    const manual = projected.services
      .find((entry) => entry.provider === provider)!
      .models.find((model) => model.id === "manual/only")!;
    assert.deepEqual(manual.sources, ["manual"]);
    assert.deepEqual(manual.discovery, {
      name: null,
      api: "openai-completions",
      baseUrl: "https://supplement.example/v1",
      input: null,
      reasoning: null,
      contextWindow: null,
      maxOutput: null,
      sources: {
        name: null,
        api: "service-target",
        baseUrl: "service-target",
        input: null,
        reasoning: null,
        contextWindow: null,
        maxOutput: null,
      },
    });
    assert.deepEqual(manual.runtime, {
      input: ["text"],
      reasoning: false,
      thinkingLevels: ["off"],
      contextWindow: 128_000,
      maxOutput: 16_000,
      sources: {
        input: "runtime-baseline",
        reasoning: "runtime-baseline",
        contextWindow: "runtime-baseline",
        maxOutput: "runtime-baseline",
      },
    });

    const callsBeforeStale = stub.calls.length;
    const stale = await mutation(
      h,
      modelWriter,
      "POST",
      `/model-services/${provider}/supplements`,
      requestBody,
    );
    assert.equal(stale.status, 409, await stale.text());
    assert.equal(stub.calls.length, callsBeforeStale);

    const mismatchedTarget = await mutation(
      h,
      modelWriter,
      "POST",
      "/model-services/corp-stale-target/supplements",
      { model: "must-not-run", expectedVersion: 1 },
    );
    assert.equal(mismatchedTarget.status, 409, await mismatchedTarget.text());
    assert.equal(stub.calls.length, callsBeforeStale, "目标绑定不一致时不得外发已存凭据");

    inferenceSucceeds = false;
    const beforeFailure = afterAdd;
    const rejected = await mutation(
      h,
      modelWriter,
      "POST",
      `/model-services/${provider}/supplements`,
      { model: "rejected-model", expectedVersion: 2 },
    );
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 422, rejectedText);
    for (const material of [credential, ciphertext, PANEL_CREDENTIAL_MASTER_KEY]) {
      assert.equal(rejectedText.includes(material), false, `补录错误泄露了 ${material}`);
    }
    assert.equal(stub.calls.length, callsBeforeStale + 1, "失败补录也只能执行一次真实推理");
    const afterFailureStore = openStore(h.db.path);
    assert.deepEqual(afterFailureStore.getModelService(provider), beforeFailure);
    afterFailureStore.close();
  } finally {
    stub.restore();
  }
});

test("删除补录在自动来源仍在时成功，仅唯一来源按完整标识列出所有引用", async () => {
  const provider = "corp-supplement-delete";
  const baseUrl = "https://supplement-delete.example/v1";
  const api = "openai-completions";
  const targetFingerprint = modelServiceTargetFingerprint(baseUrl, api);
  const h = await startPanelHarness(cleanups, { reviewers: [], credentialMasterKey: undefined });
  const modelWriter = await cookieFor(h, "supplement-delete-model-writer", ["model:write"]);
  const credentialWriter = await cookieFor(
    h,
    "supplement-delete-credential-writer",
    ["credential:write"],
  );
  const seed = openStore(h.db.path);
  assert.equal(seed.commitModelServiceVersion(null, service(provider, {
    type: "custom",
    baseUrl,
    api,
    targetFingerprint,
    directory: {
      state: "available",
      lastAttemptAt: "2026-08-20T02:00:00.000Z",
      lastSuccessAt: "2026-08-20T02:00:00.000Z",
      failure: null,
      ignoredModelCount: 0,
    },
    automaticModels: [{
      identity: `${provider}:shared`,
      provider,
      id: "shared",
      fields: {},
    }],
    supplements: [
      {
        model: "shared",
        source: "manual",
        targetFingerprint,
        createdAt: "2026-08-20T01:50:00.000Z",
      },
      {
        model: "blocked-global",
        source: "manual",
        targetFingerprint,
        createdAt: "2026-08-20T01:51:00.000Z",
      },
      {
        model: "blocked-repo",
        source: "migration-retention",
        targetFingerprint: null,
        createdAt: "2026-08-20T01:52:00.000Z",
      },
      {
        model: "unreferenced",
        source: "manual",
        targetFingerprint,
        createdAt: "2026-08-20T01:53:00.000Z",
      },
    ],
  })), 1);
  seed.putGlobalSettings({
    reviewersJson: JSON.stringify([
      { provider, model: "shared" },
      { provider, model: "blocked-global" },
    ]),
    maxChangedLinesPerBatch: null,
  });
  seed.registerRepo({
    repoId: 8301,
    owner: "acme",
    repo: "follows-global",
    generation: 1,
    key: "supplement-follow-key",
  });
  seed.registerRepo({
    repoId: 8302,
    owner: "acme",
    repo: "explicit-models",
    generation: 1,
    key: "supplement-explicit-key",
    reviewersJson: JSON.stringify([{ provider, model: "blocked-repo" }]),
  });
  seed.close();

  const sharedInput = { model: "shared", expectedVersion: 1 };
  assert.equal(
    (await mutation(
      h,
      credentialWriter,
      "DELETE",
      `/model-services/${provider}/supplements`,
      sharedInput,
    )).status,
    403,
  );
  const shared = await mutation(
    h,
    modelWriter,
    "DELETE",
    `/model-services/${provider}/supplements`,
    sharedInput,
  );
  const sharedText = await shared.text();
  assert.equal(shared.status, 200, sharedText);
  assert.deepEqual(JSON.parse(sharedText), {
    provider,
    model: "shared",
    identity: `${provider}:shared`,
    removedSource: "manual",
    remainingSources: ["automatic"],
    version: 2,
  });
  const afterShared = openStore(h.db.path);
  assert.deepEqual(afterShared.getModelService(provider)!.automaticModels.map(({ id }) => id), ["shared"]);
  assert.equal(afterShared.listModelSupplements(provider).some(({ model }) => model === "shared"), false);
  afterShared.close();

  const globalBlocked = await mutation(
    h,
    modelWriter,
    "DELETE",
    `/model-services/${provider}/supplements`,
    { model: "blocked-global", expectedVersion: 2 },
  );
  const globalBlockedText = await globalBlocked.text();
  assert.equal(globalBlocked.status, 409, globalBlockedText);
  const globalBlockedBody = JSON.parse(globalBlockedText) as { references: ModelReference[] };
  assert.deepEqual(globalBlockedBody.references, [
    {
      identity: `${provider}:blocked-global`,
      provider,
      model: "blocked-global",
      locations: [
        { kind: "global" },
        { kind: "following-global", repositoryCount: 1 },
      ],
    },
  ]);

  const repoBlocked = await mutation(
    h,
    modelWriter,
    "DELETE",
    `/model-services/${provider}/supplements`,
    { model: "blocked-repo", expectedVersion: 2 },
  );
  const repoBlockedText = await repoBlocked.text();
  assert.equal(repoBlocked.status, 409, repoBlockedText);
  const repoBlockedBody = JSON.parse(repoBlockedText) as { references: ModelReference[] };
  assert.deepEqual(repoBlockedBody.references, [
    {
      identity: `${provider}:blocked-repo`,
      provider,
      model: "blocked-repo",
      locations: [{
        kind: "repository-override",
        repoId: 8302,
        owner: "acme",
        repo: "explicit-models",
      }],
    },
  ]);
  const afterBlocked = openStore(h.db.path);
  assert.equal(afterBlocked.getModelService(provider)!.version, 2);
  assert.deepEqual(
    afterBlocked.listModelSupplements(provider).map(({ model }) => model),
    ["blocked-global", "blocked-repo", "unreferenced"],
  );
  afterBlocked.close();

  assert.equal(
    (await mutation(
      h,
      modelWriter,
      "DELETE",
      `/model-services/${provider}/supplements`,
      { model: "unreferenced", expectedVersion: 1 },
    )).status,
    409,
  );
  const unreferenced = await mutation(
    h,
    modelWriter,
    "DELETE",
    `/model-services/${provider}/supplements`,
    { model: "unreferenced", expectedVersion: 2 },
  );
  assert.equal(unreferenced.status, 200, await unreferenced.text());
  assert.equal((await h.api("GET", "/model-services").then((response) => response.text())).includes("unreferenced"), false);

  const unlink = openStore(h.db.path);
  assert.equal(unlink.putGlobalSettings({ reviewersJson: JSON.stringify([]), maxChangedLinesPerBatch: null }), true);
  assert.equal(unlink.setRepoReviewers(8302, null), true);
  unlink.close();
  const removedGlobal = await mutation(
    h,
    modelWriter,
    "DELETE",
    `/model-services/${provider}/supplements`,
    { model: "blocked-global", expectedVersion: 3 },
  );
  assert.equal(removedGlobal.status, 200, await removedGlobal.text());
  const removedRepo = await mutation(
    h,
    modelWriter,
    "DELETE",
    `/model-services/${provider}/supplements`,
    { model: "blocked-repo", expectedVersion: 4 },
  );
  assert.equal(removedRepo.status, 200, await removedRepo.text());
  const finalStore = openStore(h.db.path);
  const final = finalStore.getModelService(provider)!;
  finalStore.close();
  assert.equal(final.version, 5);
  assert.deepEqual(final.automaticModels.map(({ id }) => id), ["shared"]);
  assert.deepEqual(final.supplements, []);
});
