import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { piBuiltinProviderTargets } from "../src/reviewer/catalog.ts";
import {
  MODEL_RUNTIME_BASELINE,
  discoverModels,
  distinctBuiltinTargets,
  resolveBuiltinModelTarget,
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
      kind: "custom",
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
      kind: "custom",
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
        thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        compat: {
          supportsStrictMode: true,
          supportsOpenAIGrammarTools: true,
          supportsToolSearch: true,
          supportsExplicitPromptCacheMode: true,
          supportsAdditionalTools: true,
        },
      },
      fieldSources: {
        name: "service-interface",
        api: "service-target",
        baseUrl: "service-target",
        input: "pi-catalog",
        reasoning: "pi-catalog",
        contextWindow: "pi-catalog",
        maxTokens: "pi-catalog",
        thinkingLevelMap: "pi-catalog",
        compat: "pi-catalog",
      },
    }]);
    const synthesized = synthesizeRuntimeModel({
      kind: "custom",
      provider: "sub2-openai",
      baseUrl: "https://gateway.example.test/v1",
      api: "openai-completions",
      credential: "candidate-secret-must-not-leak",
    }, result.models[0]!);
    assert.equal(synthesized.ok, true);
    if (synthesized.ok) {
      assert.equal(synthesized.value.runtime.contextWindow, 272_000);
      assert.equal(synthesized.value.runtime.sources.contextWindow, "trusted");
    }
  } finally {
    stub.restore();
  }
});

test("未知型号保留服务接口名称与目标，运行信息回退基线", async () => {
  const candidate = {
    kind: "custom" as const,
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
      sources: synthesized.value.runtime.sources,
    }, {
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
    });
  } finally {
    stub.restore();
  }
});

test("OpenAI-compatible 发现把坏响应、空目录、请求失败与超时变成稳定且脱敏的结果", async () => {
  const credential = "candidate-secret-must-not-leak";
  const candidate = {
    kind: "custom" as const,
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

test("运行模型逐字段采用可信信息,缺项固定回落到 text-only 128k/16k", () => {
  assert.deepEqual(MODEL_RUNTIME_BASELINE, {
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_000,
  });

  const candidate = {
    kind: "custom" as const,
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
        sources: {
          name: "trusted",
          api: "service-target",
          baseUrl: "service-target",
          input: "trusted",
          reasoning: "runtime-baseline",
          contextWindow: "trusted",
          maxTokens: "runtime-baseline",
        },
      },
    },
  });
  assert.equal(JSON.stringify(result).includes(candidate.credential), false);

  const trustedFields = synthesizeRuntimeModel(candidate, {
    ...discovery,
    fields: { reasoning: false, maxTokens: 2048 },
  });
  assert.equal(trustedFields.ok, true);
  if (trustedFields.ok) {
    assert.equal(trustedFields.value.runtime.sources.reasoning, "trusted");
    assert.equal(trustedFields.value.runtime.sources.maxTokens, "trusted");
  }
});

test("最小真实推理使用候选地址、协议、凭据与验证模型,且只发这一笔请求", async () => {
  const credential = "inference-secret-must-not-leak";
  const candidate = {
    kind: "custom" as const,
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

test("内置 provider 目标按模型解析,只返回当前 Pi 每一行自己的 api 与 baseUrl", async () => {
  const targets = await piBuiltinProviderTargets("deepseek");
  assert.ok(targets !== undefined && targets.size > 0);
  for (const target of targets.values()) {
    assert.deepEqual(target, { api: "openai-completions", baseUrl: "https://api.deepseek.com" });
  }
  assert.deepEqual(distinctBuiltinTargets(targets.values()), [
    { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
  ]);
  assert.equal(await piBuiltinProviderTargets("not-a-pi-provider"), undefined);

  // 目录里没有的 model id:整家只有一个已确认目标时沿用它;混合协议下不猜第一项,明确拒绝。
  const sole = resolveBuiltinModelTarget("deepseek", "deepseek-v4-flash", undefined, [...targets.values()]);
  assert.deepEqual(sole, {
    ok: true,
    target: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
    source: "service-target",
  });
  const mixed = resolveBuiltinModelTarget("openrouter", "unknown/model", undefined, [
    { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
    { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" },
  ]);
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.equal(mixed.failure.code, "target-ambiguous");
    assert.match(mixed.failure.message, /openrouter:unknown\/model 的调用目标无法唯一确定/);
    assert.match(mixed.failure.message, /自定义模型服务/);
  }
  // 模型自己那一行的目标优先于整家的集合,与目录排序无关。
  const own = resolveBuiltinModelTarget(
    "openrouter",
    "anthropic/claude",
    { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api/" },
    [{ api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }],
  );
  assert.deepEqual(own, {
    ok: true,
    target: { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" },
    source: "pi-catalog",
  });

  const target = sole.ok ? sole.target : undefined;
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
      },
      {
        name: "deepseek-v4-flash",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 16_000,
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

test("内置候选按最终发现快照里该模型自己的目标验证,不取整家首项", async () => {
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
    assert.equal(calls[0]!.url, "https://vendor-only.example.test/v1/chat/completions");
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
  });
  const model = runtime.getModel("corp", "same-model")!;
  assert.equal(model.name, "Pinned Version One");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://pinned-run.example.test/v1");
  assert.equal(model.reasoning, false);
  assert.equal(existsSync(join(agentDir, "models.json")), false, "固定模型不该写成共享运行文件");
});

test("anthropic 发现走 x-api-key 与版本头,带 limit=1000,并解析 display_name", async () => {
  const credential = "anthropic-secret-must-not-leak";
  const calls: { url: string; headers: Record<string, string | null> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      headers: {
        "x-api-key": headers.get("x-api-key"),
        "anthropic-version": headers.get("anthropic-version"),
        authorization: headers.get("authorization"),
      },
    });
    return new Response(JSON.stringify({
      data: [
        { type: "model", id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: "2026-02-01T00:00:00Z" },
        { type: "model", id: "claude-fable-5", display_name: "Claude Fable 5" },
        { type: "model", id: "relay-only-model" },
      ],
      has_more: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await discoverModels({
      kind: "custom",
      provider: "sub2anthropic",
      baseUrl: "https://gateway.example.test/v1",
      api: "anthropic-messages",
      credential,
    }, { allowNetwork: false });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://gateway.example.test/v1/models?limit=1000");
    assert.deepEqual(calls[0]!.headers, {
      "x-api-key": credential,
      "anthropic-version": "2023-06-01",
      authorization: null,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.models.map((model) => ({ id: model.id, name: model.fields.name })), [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "claude-fable-5", name: "Claude Fable 5" },
      { id: "relay-only-model", name: undefined },
    ]);
    assert.equal(result.models[0]!.fields.api, "anthropic-messages");
    // adaptive thinking 元数据从 Pi 内置目录补上:off: null 压掉 thinking.type=disabled。
    const fable = result.models[1]!;
    const fableCompat = fable.fields.compat as { forceAdaptiveThinking?: boolean } | undefined;
    assert.equal(fableCompat?.forceAdaptiveThinking, true);
    assert.equal(fable.fields.thinkingLevelMap?.off, null);
    assert.equal(fable.fieldSources?.thinkingLevelMap, "pi-catalog");
    assert.equal(fable.fieldSources?.compat, "pi-catalog");
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("anthropic 运行模型剥掉 baseUrl 尾部 /v1,发现与存库地址不变", () => {
  const candidate = {
    kind: "custom" as const,
    provider: "sub2anthropic",
    baseUrl: "https://gateway.example.test/v1/",
    api: "anthropic-messages" as const,
    credential: "anthropic-secret-must-not-leak",
  };
  const discovery: DiscoveredModel = {
    identity: "sub2anthropic:claude-opus-4-7",
    provider: "sub2anthropic",
    id: "claude-opus-4-7",
    fields: { name: "Claude Opus 4.7" },
  };
  const result = synthesizeRuntimeModel(candidate, discovery);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // @anthropic-ai/sdk 自己在 baseURL 后拼 /v1/messages,带 /v1 注册会打到 /v1/v1/messages。
  assert.equal(result.value.runtime.baseUrl, "https://gateway.example.test");
  // 不带 /v1 的地址原样保留,SDK 拼出的仍是 /v1/messages。
  const bare = synthesizeRuntimeModel(
    { ...candidate, baseUrl: "https://bare.example.test" },
    { ...discovery, identity: "sub2anthropic:claude-opus-4-7" },
  );
  assert.equal(bare.ok, true);
  if (bare.ok) assert.equal(bare.value.runtime.baseUrl, "https://bare.example.test");
});

test("anthropic 最小真实推理打到剥掉 /v1 后的 /v1/messages,凭据走 x-api-key", async () => {
  const credential = "anthropic-inference-secret-must-not-leak";
  const candidate = {
    kind: "custom" as const,
    provider: "sub2anthropic",
    baseUrl: "https://gateway.example.test/v1",
    api: "anthropic-messages" as const,
    credential,
  };
  const calls: { url: string; apiKey: string | null; auth: string | null; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      apiKey: headers.get("x-api-key"),
      auth: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_validation", type: "message", role: "assistant", content: [], model: "claude-fable-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    const stream = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const discovered: DiscoveredModel = {
      identity: "sub2anthropic:claude-fable-5",
      provider: "sub2anthropic",
      id: "claude-fable-5",
      fields: {
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
        compat: { forceAdaptiveThinking: true },
      },
    };
    const result = await validateMinimalInference(candidate, discovered);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1, "真实推理之外又发了别的请求");
    assert.equal(calls[0]!.url, "https://gateway.example.test/v1/messages?beta=true");
    assert.equal(calls[0]!.apiKey, credential);
    assert.equal(calls[0]!.body["model"], "claude-fable-5");
    // adaptive thinking 模型对这两个字段直接 400:off: null 压掉 thinking,验证不带 temperature。
    assert.equal("thinking" in calls[0]!.body, false);
    assert.equal("temperature" in calls[0]!.body, false);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    globalThis.fetch = original;
  }
});
