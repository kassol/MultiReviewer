import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { resolvePiBuiltinProviderTarget } from "../src/reviewer/catalog.ts";
import {
  MODEL_RUNTIME_BASELINE,
  discoverModels,
  synthesizeRuntimeModel,
  validateMinimalInference,
  type DiscoveredModel,
} from "../src/reviewer/model-service-runtime.ts";
import { isolatedPinnedModelRuntime } from "../src/reviewer/model-runtime.ts";
import { stubFetch } from "./support/stub-fetch.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

test("OpenAI-compatible 发现保留非空 model id 与服务目标,并规范化地址去重", async () => {
  const credential = "candidate-secret-must-not-leak";
  const stub = stubFetch({
    "GET /v1/models": {
      body: {
        object: "list",
        data: [
          { id: "acme/code-model", context_window: 999_999, price: 0 },
          { id: "  " },
          null,
          { id: "acme/code-model", owned_by: "duplicate" },
        ],
      },
    },
  });
  try {
    const result = await discoverModels({
      kind: "openai-compatible",
      provider: "acme-gateway",
      baseUrl: "https://gateway.example.test/v1///",
      api: "openai-completions",
      credential,
    });

    assert.deepEqual(result, {
      ok: true,
      ignoredCount: 2,
      models: [
        {
          identity: "acme-gateway:acme/code-model",
          provider: "acme-gateway",
          id: "acme/code-model",
          fields: {
            api: "openai-completions",
            baseUrl: "https://gateway.example.test/v1",
          },
          fieldSources: {
            api: "service-target",
            baseUrl: "service-target",
          },
        },
      ],
    });
    assert.deepEqual(stub.calls, [
      {
        method: "GET",
        url: "https://gateway.example.test/v1/models",
        auth: `Bearer ${credential}`,
        body: undefined,
      },
    ]);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    stub.restore();
  }
});

test("OpenAI-compatible 发现保留服务接口名称并按厂商用 Pi 目录补齐运行信息", async () => {
  const stub = stubFetch({
    "GET /v1/models": {
      body: {
        object: "list",
        data: [{
          id: "gpt-5.6-sol",
          object: "model",
          created: 1_780_876_800,
          display_name: "Gateway GPT-5.6 Sol",
          owned_by: "openai",
          type: "model",
        }],
      },
    },
  });
  try {
    const result = await discoverModels({
      kind: "openai-compatible",
      provider: "sub2-openai",
      baseUrl: "https://gateway.example.test/v1",
      api: "openai-completions",
      credential: "candidate-secret-must-not-leak",
    }, { allowNetwork: false });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.models, [{
      identity: "sub2-openai:gpt-5.6-sol",
      provider: "sub2-openai",
      id: "gpt-5.6-sol",
      fields: {
        name: "Gateway GPT-5.6 Sol",
        api: "openai-completions",
        baseUrl: "https://gateway.example.test/v1",
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
    }]);
    const synthesized = synthesizeRuntimeModel({
      kind: "openai-compatible",
      provider: "sub2-openai",
      baseUrl: "https://gateway.example.test/v1",
      api: "openai-completions",
      credential: "candidate-secret-must-not-leak",
    }, result.models[0]!);
    assert.equal(synthesized.ok, true);
    if (synthesized.ok) {
      assert.equal(synthesized.value.runtime.cost, undefined);
      assert.equal(synthesized.value.runtime.sources.cost, "unknown");
    }
  } finally {
    stub.restore();
  }
});

test("未知型号保留服务接口名称与目标，运行信息回退基线", async () => {
  const candidate = {
    kind: "openai-compatible" as const,
    provider: "corp-unknown",
    baseUrl: "https://unknown.example.test/v1",
    api: "openai-responses" as const,
    credential: "candidate-secret-must-not-leak",
  };
  const stub = stubFetch({
    "GET /v1/models": {
      body: { data: [{ id: "private-reasoner-7", name: "Private Reasoner 7" }] },
    },
  });
  try {
    const discovered = await discoverModels(candidate, { allowNetwork: false });
    assert.equal(discovered.ok, true);
    if (!discovered.ok) return;
    assert.deepEqual(discovered.models[0], {
      identity: "corp-unknown:private-reasoner-7",
      provider: "corp-unknown",
      id: "private-reasoner-7",
      fields: {
        name: "Private Reasoner 7",
        api: "openai-responses",
        baseUrl: "https://unknown.example.test/v1",
      },
      fieldSources: {
        name: "service-interface",
        api: "service-target",
        baseUrl: "service-target",
      },
    });

    const synthesized = synthesizeRuntimeModel(candidate, discovered.models[0]!);
    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    assert.deepEqual({
      input: synthesized.value.runtime.input,
      reasoning: synthesized.value.runtime.reasoning,
      contextWindow: synthesized.value.runtime.contextWindow,
      maxTokens: synthesized.value.runtime.maxTokens,
      cost: synthesized.value.runtime.cost,
      sources: synthesized.value.runtime.sources,
    }, {
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 16_000,
      cost: undefined,
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
    });
  } finally {
    stub.restore();
  }
});

test("OpenAI-compatible 发现把坏响应、空目录、请求失败与超时变成稳定且脱敏的结果", async () => {
  const credential = "candidate-secret-must-not-leak";
  const candidate = {
    kind: "openai-compatible" as const,
    provider: "acme-gateway",
    baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions" as const,
    credential,
  };

  const http = stubFetch({
    "GET /v1/models": {
      status: 401,
      body: { error: `invalid key; Authorization: Bearer ${credential}` },
    },
  });
  try {
    const result = await discoverModels(candidate);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "http-error");
    assert.equal(result.failure.status, 401);
    assert.match(result.failure.message, /invalid key/);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    http.restore();
  }

  for (const [body, code] of [
    [{ models: [] }, "invalid-response"],
    [{ data: [] }, "empty-catalog"],
    [{ data: [null, { id: " " }] }, "empty-catalog"],
  ] as const) {
    const stub = stubFetch({ "GET /v1/models": { body } });
    try {
      const result = await discoverModels(candidate);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failure.code, code);
    } finally {
      stub.restore();
    }
  }

  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error(`gateway refused ${credential}`);
    }) as typeof fetch;
    const failed = await discoverModels(candidate);
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.failure.code, "request-error");
      assert.match(failed.failure.message, /gateway refused/);
      assert.equal(failed.failure.message.includes(credential), false);
    }

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    const timedOut = await discoverModels(candidate, { timeoutMs: 1 });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.equal(timedOut.failure.code, "timeout");
  } finally {
    globalThis.fetch = original;
  }
});

test("运行模型逐字段采用可信信息,缺项固定回落到 text-only 128k/16k 且价格保持未知", () => {
  assert.deepEqual(MODEL_RUNTIME_BASELINE, {
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_000,
  });

  const candidate = {
    kind: "openai-compatible" as const,
    provider: "acme-gateway",
    baseUrl: "https://gateway.example.test/v1/",
    api: "openai-responses" as const,
    credential: "runtime-secret-must-not-leak",
  };
  const discovery: DiscoveredModel = {
    identity: "acme-gateway:code-model",
    provider: "acme-gateway",
    id: "code-model",
    fields: {
      name: "Acme Code",
      input: ["text", "image"],
      contextWindow: 32_000,
    },
  };

  const result = synthesizeRuntimeModel(candidate, discovery);
  assert.deepEqual(result, {
    ok: true,
    value: {
      discovery,
      runtime: {
        provider: "acme-gateway",
        id: "code-model",
        name: "Acme Code",
        api: "openai-responses",
        baseUrl: "https://gateway.example.test/v1",
        input: ["text", "image"],
        reasoning: false,
        contextWindow: 32_000,
        maxTokens: 16_000,
        cost: undefined,
        sources: {
          name: "trusted",
          api: "service-target",
          baseUrl: "service-target",
          input: "trusted",
          reasoning: "runtime-baseline",
          contextWindow: "trusted",
          maxTokens: "runtime-baseline",
          cost: "unknown",
        },
      },
    },
  });
  assert.equal(JSON.stringify(result).includes(candidate.credential), false);

  const knownZero = synthesizeRuntimeModel(candidate, {
    ...discovery,
    fields: {
      reasoning: false,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  });
  assert.equal(knownZero.ok, true);
  if (knownZero.ok) {
    assert.deepEqual(knownZero.value.runtime.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(knownZero.value.runtime.sources.cost, "trusted");
    assert.equal(knownZero.value.runtime.sources.reasoning, "trusted");
    assert.equal(knownZero.value.runtime.sources.maxTokens, "trusted");
  }

  const unusablePrice = synthesizeRuntimeModel(candidate, {
    ...discovery,
    fields: { cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.equal(unusablePrice.ok, true);
  if (unusablePrice.ok) {
    assert.equal(unusablePrice.value.runtime.cost, undefined);
    assert.equal(unusablePrice.value.runtime.sources.cost, "unknown");
  }
  const nonFinitePrice = synthesizeRuntimeModel(candidate, {
    ...discovery,
    fields: {
      cost: { input: Number.POSITIVE_INFINITY, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  });
  assert.equal(nonFinitePrice.ok, true);
  if (nonFinitePrice.ok) {
    assert.equal(nonFinitePrice.value.runtime.cost, undefined);
    assert.equal(nonFinitePrice.value.runtime.sources.cost, "unknown");
  }
});

test("最小真实推理使用候选地址、协议、凭据与验证模型,且只发这一笔请求", async () => {
  const credential = "inference-secret-must-not-leak";
  const candidate = {
    kind: "openai-compatible" as const,
    provider: "acme-gateway",
    baseUrl: "https://gateway.example.test/v1/",
    api: "openai-completions" as const,
    credential,
  };
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const chunk = {
      id: "chatcmpl-validation",
      object: "chat.completion.chunk",
      created: 1,
      model: "validation-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const result = await validateMinimalInference(candidate, "validation-model");
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1, "真实推理之外又发了别的请求");
    assert.equal(calls[0]!.url, "https://gateway.example.test/v1/chat/completions");
    assert.equal(calls[0]!.auth, `Bearer ${credential}`);
    assert.equal(calls[0]!.body["model"], "validation-model");
    assert.equal(calls[0]!.body["stream"], true);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    globalThis.fetch = original;
  }

  const impossible = await validateMinimalInference(
    { kind: "builtin", provider: "not-a-pi-provider", credential },
    "validation-model",
  );
  assert.equal(impossible.ok, false);
  if (!impossible.ok) {
    assert.equal(impossible.failure.code, "model-unconstructable");
    assert.equal(impossible.failure.message.includes(credential), false);
  }
});

test("内置 provider 目标解析只返回当前 Pi 的 api 与 baseUrl", async () => {
  const target = await resolvePiBuiltinProviderTarget("deepseek");
  assert.deepEqual(target, {
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
  });
  assert.equal(await resolvePiBuiltinProviderTarget("not-a-pi-provider"), undefined);

  const synthesized = synthesizeRuntimeModel(
    { kind: "builtin", provider: "deepseek", credential: "unused" },
    "deepseek-v4-flash",
    target,
  );
  assert.equal(synthesized.ok, true);
  if (synthesized.ok) {
    assert.deepEqual(
      {
        name: synthesized.value.runtime.name,
        api: synthesized.value.runtime.api,
        baseUrl: synthesized.value.runtime.baseUrl,
        reasoning: synthesized.value.runtime.reasoning,
        contextWindow: synthesized.value.runtime.contextWindow,
        maxTokens: synthesized.value.runtime.maxTokens,
        cost: synthesized.value.runtime.cost,
      },
      {
        name: "deepseek-v4-flash",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 16_000,
        cost: undefined,
      },
    );
  }
});

test("内置候选用当前 Pi provider 目标验证只存在于模型补录的 model id", async () => {
  const credential = "builtin-supplement-secret-must-not-leak";
  const modelId = "validation-supplement-only";
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const chunk = {
      id: "chatcmpl-builtin-supplement",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [
        { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const result = await validateMinimalInference(
      { kind: "builtin", provider: "deepseek", credential },
      modelId,
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1, "真实推理之外又发了别的请求");
    assert.equal(calls[0]!.url, "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0]!.auth, `Bearer ${credential}`);
    assert.equal(calls[0]!.body["model"], modelId);
    assert.equal(calls[0]!.body["stream"], true);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("内置候选用当前 Pi provider 目标验证最终发现快照里的模型", async () => {
  const credential = "builtin-inference-secret-must-not-leak";
  const modelId = "multireviewer-vendor-only-validation-133";
  const discovery: DiscoveredModel = {
    identity: `openrouter:${modelId}`,
    provider: "openrouter",
    id: modelId,
    fields: {
      name: "Vendor-only validation model",
      api: "openai-completions",
      baseUrl: "https://vendor-only.example.test/v1",
    },
  };
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const chunk = {
      id: "chatcmpl-builtin-validation",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [
        { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const result = await validateMinimalInference(
      { kind: "builtin", provider: "openrouter", credential },
      discovery,
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1, "真实推理之外又发了别的请求");
    assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0]!.auth, `Bearer ${credential}`);
    assert.equal(calls[0]!.body["model"], modelId);
    assert.equal(calls[0]!.body["stream"], true);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("Reviewer 固定运行模型不读取可变共享当前配置", async () => {
  const cache = tempDir("multireviewer-pinned-current-");
  const agentDir = tempDir("multireviewer-pinned-agent-");
  process.env["MULTIREVIEWER_CACHE_DIR"] = cache;
  const obsoleteProjectionDir = join(cache, "pi-models");
  mkdirSync(obsoleteProjectionDir, { recursive: true });
  writeFileSync(
    join(obsoleteProjectionDir, "models.json"),
    JSON.stringify({
      providers: {
        corp: {
          api: "openai-responses",
          baseUrl: "https://mutable-current.example.test/v2",
          models: [{ id: "same-model", name: "Mutable Current", reasoning: true }],
        },
      },
    }),
  );

  const runtime = await isolatedPinnedModelRuntime(agentDir, {
    provider: "corp",
    id: "same-model",
    name: "Pinned Version One",
    api: "openai-completions",
    baseUrl: "https://pinned-run.example.test/v1",
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
  });
  const model = runtime.getModel("corp", "same-model")!;
  assert.equal(model.name, "Pinned Version One");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://pinned-run.example.test/v1");
  assert.equal(model.reasoning, false);
  assert.equal(existsSync(join(agentDir, "models.json")), false, "固定模型不该写成共享运行文件");
});
