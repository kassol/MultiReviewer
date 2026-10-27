import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { supportedThinkingLevels } from "../src/config.ts";
import {
  loadPiProviderCatalog,
  piBuiltinProviderTargets,
  type PiCatalogModel,
  type PiProviderCatalog,
} from "../src/reviewer/catalog.ts";
import {
  MODEL_RUNTIME_BASELINE,
  customCatalogFields,
  discoverModels,
  distinctBuiltinTargets,
  resolveBuiltinModelTarget,
  synthesizeRuntimeModel,
  validateMinimalInference,
  type DiscoveredModel,
} from "../src/reviewer/model-service-runtime.ts";
import { isolatedPinnedModelRuntime } from "../src/reviewer/model-runtime.ts";
import { applyModelSpecOverrides, validModelSpecOverrides } from "../src/reviewer/model-spec-overrides.ts";
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

function privateCatalog() {
  return { catalogStorePath: join(tempDir("model-discovery-catalog-"), "models-store.json") };
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
    }, { allowNetwork: false, ...privateCatalog() });

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
    }, { allowNetwork: false, ...privateCatalog() });

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

test("Pi 0.85.1 目录收录 gpt-6-astra:自定义服务取到 272k 上下文与五档思考", async () => {
  // 0.85.0 的内置与远程目录都没有这一行,可信字段整片回落到运行基线(不推理、128k / 16k,
  // 档位只剩 off);0.85.1 收录后走同一条 pi-catalog 路径补齐(issue #265)。夹具不给
  // display_name,名字也从目录取。
  const stub = stubFetch({
    "GET /v1/models": {
      body: {
        object: "list",
        data: [{ id: "gpt-6-astra", object: "model", owned_by: "openai", type: "model" }],
      },
    },
  });
  const candidate = {
    kind: "custom",
    provider: "sub2-openai",
    baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions",
    credential: "candidate-secret-must-not-leak",
  } as const;
  try {
    const result = await discoverModels(candidate, { allowNetwork: false, ...privateCatalog() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.models, [{
      identity: "sub2-openai:gpt-6-astra",
      provider: "sub2-openai",
      id: "gpt-6-astra",
      fields: {
        name: "GPT-6 Astra",
        api: "openai-completions",
        baseUrl: "https://gateway.example.test/v1",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 272_000,
        maxTokens: 128_000,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        compat: {
          supportsStrictMode: true,
          supportsOpenAIGrammarTools: true,
          supportsAdditionalTools: true,
          supportsToolSearch: true,
          supportsExplicitPromptCacheMode: true,
        },
      },
      fieldSources: {
        name: "pi-catalog",
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
    assert.equal(
      Object.hasOwn(result.models[0]!.fields.compat ?? {}, "supportsMidConvoEffort"),
      false,
      "自定义服务照旧不继承 supportsMidConvoEffort",
    );
    const synthesized = synthesizeRuntimeModel(candidate, result.models[0]!);
    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    assert.equal(synthesized.value.runtime.contextWindow, 272_000);
    assert.equal(synthesized.value.runtime.sources.contextWindow, "trusted");
    assert.equal(synthesized.value.runtime.maxTokens, 128_000);
    assert.equal(synthesized.value.runtime.sources.maxTokens, "trusted");
    assert.deepEqual(
      supportedThinkingLevels(synthesized.value.runtime),
      ["low", "medium", "high", "xhigh", "max"],
      "off 与 minimal 映射为 null,两档都不出现",
    );
  } finally {
    stub.restore();
  }
});

test("models.dev 完整 ID 优先,去路径精确兜底,只补四个基础字段且共享一次请求", async () => {
  // 这几个 id 刻意不落在 Pi 目录里:Pi 命中在先,models.dev 只在 Pi 没给的基础字段上兜底。
  const candidate = {
    kind: "custom", provider: "corp-gateway", baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions", credential: "candidate-secret-must-not-leak",
  } as const;
  const stub = stubFetch({
    "GET /v1/models": { body: { data: [
      { id: "corp/core-model" },
      { id: "private-flash", display_name: "Corp Flash" },
      { id: "core-model-preview", display_name: "Corp Flash Preview" },
      { id: "gateway/other-model" },
    ] } },
    "GET /api.json": { body: { a: { models: {
      exact: { id: "corp/core-model", name: "Untrusted name", reasoning: true,
        modalities: { input: ["image", "audio", "text"] }, limit: { context: 1_000_000, output: 384_000 },
        api: "anthropic-messages", baseUrl: "https://untrusted.test", compat: { supportsStore: true },
        thinkingLevelMap: { max: "max" } },
      bare: { id: "core-model", reasoning: false, limit: { context: 1 } },
      other: { id: "vendor/other-model", reasoning: false, limit: { context: 200_000, output: 8_000 } },
    } } } },
  });
  try {
    const result = await discoverModels(candidate, privateCatalog());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const model = result.models[0]!;
    assert.deepEqual(model.fields, {
      api: candidate.api, baseUrl: candidate.baseUrl,
      input: ["text", "image"], reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000,
    });
    for (const field of ["input", "reasoning", "contextWindow", "maxTokens"] as const) {
      assert.equal(model.fieldSources?.[field], "models-dev");
    }
    const synthesized = synthesizeRuntimeModel(candidate, model);
    assert.equal(synthesized.ok, true);
    if (synthesized.ok) {
      assert.equal(synthesized.value.runtime.contextWindow, 1_000_000);
      assert.equal(synthesized.value.runtime.maxTokens, 384_000);
      assert.equal(synthesized.value.runtime.thinkingLevelMap, undefined);
    }
    for (const unmatched of result.models.slice(1, 3)) {
      assert.equal(unmatched.fields.reasoning, undefined);
      assert.equal(unmatched.fields.contextWindow, undefined);
      assert.equal(unmatched.fields.compat, undefined);
    }
    assert.equal(result.models[3]!.fields.contextWindow, 200_000);
    assert.equal(result.models[3]!.fields.reasoning, false);
    const calls = stub.calls.filter(({ url }) => url === "https://models.dev/api.json");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.auth, undefined, "服务凭据不发往公共目录");
  } finally {
    stub.restore();
  }
});

test("models.dev 多候选逐字段取一致值,忽略缺失与非法值,冲突保持未知", async () => {
  const candidate = {
    kind: "custom", provider: "corp-gateway", baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions", credential: "private-key",
  } as const;
  const stub = stubFetch({
    "GET /v1/models": { body: { data: [{ id: "shared-model" }, { id: "invalid-model" }] } },
    "GET /api.json": { body: {
      a: { models: {
        shared: { id: "a/shared-model", reasoning: true, modalities: { input: ["image", "text"] }, limit: { context: 100, output: 10 } },
        invalid: { id: "invalid-model", reasoning: "true", modalities: { input: ["audio"] }, limit: { context: 0, output: 1.5 } },
        noId: { name: "invalid-model", reasoning: true },
      } },
      b: { models: { shared: { id: "b/shared-model", reasoning: false, modalities: { input: ["text", "image"] }, limit: { output: 20 } } } },
      c: { models: { shared: { id: "c/shared-model", limit: { context: -1, output: "10" } } } },
    } },
  });
  try {
    const result = await discoverModels(candidate, privateCatalog());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.models[0]!.fields, {
      api: candidate.api, baseUrl: candidate.baseUrl, input: ["text", "image"], contextWindow: 100,
    });
    assert.deepEqual(result.models[0]!.fieldSources, {
      api: "service-target", baseUrl: "service-target", input: "models-dev", contextWindow: "models-dev",
    });
    assert.deepEqual(result.models[1]!.fields, { api: candidate.api, baseUrl: candidate.baseUrl });
    const runtime = synthesizeRuntimeModel(candidate, result.models[1]!);
    assert.equal(runtime.ok, true);
    if (runtime.ok) assert.equal(runtime.value.runtime.contextWindow, MODEL_RUNTIME_BASELINE.contextWindow);
  } finally { stub.restore(); }
});

test("models.dev 不覆盖 Pi 字段,基础字段完整时不请求补缺", async () => {
  const candidate = {
    kind: "custom", provider: "corp-gateway", baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions", credential: "private-key",
  } as const;
  const routes = {
    "GET /v1/models": { body: { data: [{ id: "gpt-6-astra" }, { id: "unknown-model" }] } },
    "GET /api.json": { body: { a: { models: { gpt: { id: "gpt-6-astra", reasoning: false, limit: { context: 1, output: 1 } } } } } },
  };
  let stub = stubFetch(routes);
  try {
    const result = await discoverModels(candidate, privateCatalog());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.models[0]!.fields.contextWindow, 272_000);
    assert.equal(result.models[0]!.fields.reasoning, true);
    assert.equal(result.models[0]!.fieldSources?.contextWindow, "pi-catalog");
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
  stub = stubFetch({ "GET /v1/models": { body: { data: [{ id: "gpt-6-astra" }] } } });
  try {
    assert.equal((await discoverModels(candidate, privateCatalog())).ok, true);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test("models.dev 在禁网与离线时零请求,HTTP、网络与非法 JSON 失败保留发现结果", async () => {
  const candidate = {
    kind: "custom", provider: "corp-gateway", baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions", credential: "private-key",
  } as const;
  const offline = process.env["PI_OFFLINE"];
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ["disabled", "offline", "http", "network", "json", "shape"] as const) {
      delete process.env["PI_OFFLINE"];
      if (mode === "offline") process.env["PI_OFFLINE"] = "1";
      let supplements = 0;
      let discoverySignal: AbortSignal | null | undefined;
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith("/v1/models")) {
          discoverySignal = init?.signal;
          return Response.json({ data: [{ id: "unknown-model" }] });
        }
        supplements++;
        assert.equal(String(input), "https://models.dev/api.json");
        assert.equal(init?.signal, discoverySignal);
        assert.equal(init?.redirect, "error");
        assert.deepEqual(init?.headers, { accept: "application/json" });
        if (mode === "network") throw new Error("network unavailable");
        if (mode === "json") return new Response("{");
        if (mode === "shape") return Response.json([]);
        return new Response("unavailable", { status: 503 });
      };
      const result = await discoverModels(candidate, { ...privateCatalog(), allowNetwork: mode !== "disabled" });
      assert.equal(result.ok, true, mode);
      if (result.ok) assert.deepEqual(result.models[0]!.fields, { api: candidate.api, baseUrl: candidate.baseUrl });
      assert.equal(supplements, mode === "disabled" || mode === "offline" ? 0 : 1, mode);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (offline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = offline;
  }
});

test("自定义服务按全目录匹配:官方厂商优先,id 自带厂商次之,容量按多数,并列即未知", () => {
  const model = (overrides: Partial<PiCatalogModel> & { id: string }): PiCatalogModel => ({
    name: "Demo Model", api: "openai-completions", baseUrl: "https://upstream.test/v1",
    input: ["text"], reasoning: true, contextWindow: 1_000, maxTokens: 100, ...overrides,
  });
  const catalog = (id: string, ...models: PiCatalogModel[]): PiProviderCatalog => ({ id, name: id, models });

  // 官方厂商那一行是权威:同一个 id 在转售家报的容量不作数。
  assert.deepEqual(
    customCatalogFields([
      catalog("openai", model({ id: "gpt-x", contextWindow: 100, compat: { supportsStrictMode: true } })),
      catalog("azure", model({ id: "gpt-x", contextWindow: 200, compat: { supportsOpenAIGrammarTools: true } })),
    ], "gpt-x"),
    { name: "Demo Model", input: ["text"], reasoning: true, contextWindow: 100, maxTokens: 100, compat: { supportsStrictMode: true } },
  );
  // id 自带厂商路径时先看同名 provider。
  assert.equal(customCatalogFields([
    catalog("deepseek", model({ id: "deepseek/demo-flash", contextWindow: 300 })),
    catalog("openrouter", model({ id: "deepseek/demo-flash", contextWindow: 400 })),
  ], "deepseek/demo-flash").contextWindow, 300);
  // 没有权威一行时按多数取值,compat 与 input 要全体一致。
  const levelMap = { off: null, low: "low", high: "high", max: "max" };
  const majority = customCatalogFields([
    catalog("opencode", model({ id: "demo-flash", maxTokens: 384_000, thinkingLevelMap: levelMap, compat: { thinkingFormat: "deepseek" } })),
    catalog("opencode-go", model({ id: "demo-flash", maxTokens: 384_000, thinkingLevelMap: levelMap, compat: { thinkingFormat: "deepseek" } })),
    catalog("qwen-token-plan", model({ id: "demo-flash", maxTokens: 384_000, thinkingLevelMap: levelMap, input: ["text", "image"] })),
    catalog("radius", model({ id: "demo-flash", maxTokens: 32_768, thinkingLevelMap: { ...levelMap, off: "none" } })),
  ], "demo-flash");
  assert.equal(majority.maxTokens, 384_000);
  assert.deepEqual(majority.thinkingLevelMap, levelMap);
  assert.equal(majority.input, undefined, "输入能力有人报 text+image 有人只报 text,不采纳");
  assert.equal(majority.compat, undefined, "compat 有人给有人不给,不采纳");
  // 并列即未知;其余一致的字段照常采纳。
  const tie = customCatalogFields([
    catalog("a", model({ id: "tie-model", contextWindow: 1_000 })),
    catalog("b", model({ id: "tie-model", contextWindow: 2_000 })),
  ], "tie-model");
  assert.equal(tie.contextWindow, undefined);
  assert.equal(tie.reasoning, true);
  // 只有带厂商路径的那一行时,按去掉路径后的 id 命中。
  assert.equal(customCatalogFields([
    catalog("nvidia", model({ id: "deepseek-ai/demo-flash", contextWindow: 500 })),
  ], "demo-flash").contextWindow, 500);
  assert.deepEqual(customCatalogFields([catalog("openai", model({ id: "other" }))], "demo-flash"), {});
});

test("Pi 统一完整 ID 集合内按官方、路径、其余候选逐字段补齐", () => {
  const model = (id: string, fields: Partial<PiCatalogModel> = {}): PiCatalogModel => ({
    id, name: "", api: "openai-completions", baseUrl: "https://catalog.test",
    input: ["text"], reasoning: false, contextWindow: 0, maxTokens: 0, ...fields,
  });
  const catalog = (id: string, ...models: PiCatalogModel[]): PiProviderCatalog => ({ id, name: id, models });
  const id = "route/deepseek-test";
  const catalogs = [
    catalog("deepseek", model(id, { contextWindow: 1_000, reasoning: true })),
    catalog("route", model(id, { maxTokens: 200, input: ["text", "image"] })),
    catalog("other", model(id, { contextWindow: 3_000, maxTokens: 300, thinkingLevelMap: { high: "high" }, compat: { supportsStore: false } })),
  ];
  const fields = customCatalogFields(catalogs, id);
  assert.equal(fields.contextWindow, 1_000);
  assert.equal(fields.maxTokens, 200);
  assert.equal(fields.reasoning, true);
  assert.deepEqual(fields.thinkingLevelMap, { high: "high" });
  assert.deepEqual(fields.compat, { supportsStore: false });
  // 路径层两条互相冲突的 input 与容量同样继续回落,其余候选不含路径层。
  const conflicted = customCatalogFields([
    catalog("route", model(id, { contextWindow: 100 }), model(id, { contextWindow: 200, input: ["image"] })),
    catalog("other", model(id, { contextWindow: 300, input: ["text", "image"] })),
  ], id);
  assert.equal(conflicted.contextWindow, 300);
  assert.deepEqual(conflicted.input, ["text", "image"]);
  // 完整 ID 已有命中时,官方裸 ID 与路径 provider 裸 ID 都不能进入集合补缺。
  const exact = customCatalogFields([
    catalog("deepseek", model("deepseek-test", { maxTokens: 9_000, thinkingLevelMap: { max: "max" } })),
    catalog("route", model("deepseek-test", { maxTokens: 8_000 })),
    catalog("other", model(id, { contextWindow: 300 })),
  ], id);
  assert.equal(exact.contextWindow, 300);
  assert.equal(exact.maxTokens, undefined);
  assert.equal(exact.thinkingLevelMap, undefined);
  assert.equal(customCatalogFields(catalogs, "gateway/deepseek-test").contextWindow, 1_000);
  assert.deepEqual(customCatalogFields(catalogs, "deepseek-test-preview"), {});
  assert.deepEqual(customCatalogFields([catalog("deepseek", model("deepseek-flash"))], "deepseek-v4.1-flash"), {});
});

test("models.dev 官方补缺限定统一候选集合,官方缺项才从同集合补齐", async () => {
  const candidate = { kind: "custom", provider: "corp", baseUrl: "https://gateway.test/v1", api: "openai-completions", credential: "key" } as const;
  const stub = stubFetch({
    "GET /v1/models": { body: { data: [{ id: "route/deepseek-private" }, { id: "deepseek-private" }, { id: "gateway/deepseek-bare" }] } },
    "GET /api.json": { body: {
      deepseek: { models: {
        bare: { id: "deepseek-private", reasoning: true, limit: { context: 100 } },
        exact: { id: "route/deepseek-private", limit: { output: 20 } },
        fallback: { id: "deepseek-bare", reasoning: true, limit: { context: 700 } },
      } },
      other: { models: {
        exact: { id: "route/deepseek-private", reasoning: false, limit: { context: 300, output: 30 } },
        fallback: { id: "other/deepseek-bare", reasoning: false, limit: { output: 70 } },
      } },
    } },
  });
  try {
    const result = await discoverModels(candidate, privateCatalog());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.models[0]!.fields.reasoning, false);
    assert.equal(result.models[0]!.fields.contextWindow, 300);
    assert.equal(result.models[0]!.fields.maxTokens, 20);
    assert.equal(result.models[1]!.fields.reasoning, true);
    assert.equal(result.models[1]!.fields.maxTokens, undefined, "完整裸 ID 命中后不吸收带路径的其他行");
    assert.equal(result.models[2]!.fields.contextWindow, 700);
    assert.equal(result.models[2]!.fields.reasoning, true);
    assert.equal(result.models[2]!.fields.maxTokens, 70);
  } finally { stub.restore(); }
});

test("规格覆盖严格校验六字段及 Pi 嵌套 schema,空映射与 null 档位保留", () => {
  const overrides = {
    input: ["image", "text"] as const, reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000,
    thinkingLevelMap: { off: null, high: "high" }, compat: { supportsStore: false },
  };
  assert.equal(validModelSpecOverrides(overrides), true);
  assert.equal(validModelSpecOverrides({ thinkingLevelMap: {}, compat: {} }), true);
  for (const invalid of [null, [], { api: "openai-responses" }, { baseUrl: "https://bad.test" },
    { input: [] }, { input: ["text", "text"] }, { input: ["audio"] }, { reasoning: "true" },
    { contextWindow: 0 }, { maxTokens: 1.5 }, { maxTokens: 2_147_483_648 },
    { thinkingLevelMap: null }, { thinkingLevelMap: { unknown: "high" } }, { thinkingLevelMap: { high: true } },
    { compat: null }, { compat: { unknown: true } }, { compat: { supportsStore: "true" } },
    { compat: { thinkingFormat: "invented" } },
    { compat: { chatTemplateKwargs: { enable_thinking: { $var: "thinking.invalid" } } } },
    { compat: { chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled", unknown: true } } } },
  ]) assert.equal(validModelSpecOverrides(invalid), false, JSON.stringify(invalid));
  for (const field of ["input", "reasoning", "contextWindow", "maxTokens"]) {
    assert.equal(validModelSpecOverrides({ [field]: null }), false, field);
  }
  const discovery: DiscoveredModel = { identity: "corp:model", provider: "corp", id: "model",
    fields: { reasoning: false, contextWindow: 100, compat: { supportsStore: true } },
  };
  const applied = applyModelSpecOverrides(discovery, overrides);
  assert.deepEqual(applied.fields, overrides);
  assert.equal(applied.fieldSources?.compat, "manual-override");
  assert.equal(discovery.fields.contextWindow, 100);
  const runtime = synthesizeRuntimeModel({ kind: "custom", provider: "corp", api: "openai-completions", baseUrl: "https://gateway.test/v1", credential: "key" }, applied);
  assert.equal(runtime.ok, true);
  if (runtime.ok) {
    assert.equal(runtime.value.runtime.contextWindow, 1_000_000);
    assert.deepEqual(runtime.value.runtime.thinkingLevelMap, overrides.thinkingLevelMap);
  }
  assert.deepEqual(applyModelSpecOverrides(discovery, { compat: {}, thinkingLevelMap: {} }).fields.compat, {});
});

test("自定义服务按全目录命中 deepseek-v4.1-flash:容量与思考档位来自 Pi,不再请求 models.dev", async () => {
  const candidate = {
    kind: "custom", provider: "sub2api-opencode", baseUrl: "https://gateway.example.test/v1",
    api: "openai-completions", credential: "candidate-secret-must-not-leak",
  } as const;
  const stub = stubFetch({ "GET /v1/models": { body: { data: [{ id: "deepseek-v4.1-flash" }] } } });
  try {
    const result = await discoverModels(candidate, privateCatalog());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const model = result.models[0]!;
    assert.equal(model.fields.input && [...model.fields.input].join("+"), "text+image");
    assert.equal(model.fields.reasoning, true);
    assert.equal(model.fields.contextWindow, 1_000_000);
    assert.equal(model.fields.maxTokens, 384_000);
    assert.equal(model.fields.thinkingLevelMap?.low, "low");
    for (const field of ["input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap"] as const) {
      assert.equal(model.fieldSources?.[field], "pi-catalog", field);
    }
    const synthesized = synthesizeRuntimeModel(candidate, model);
    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    assert.deepEqual(supportedThinkingLevels(synthesized.value.runtime), ["low", "high", "max"]);
    assert.equal(
      stub.calls.length,
      1,
      "基础的四个字段全部由 Pi 给出,models.dev 一次都不请求",
    );
  } finally {
    stub.restore();
  }
});

test("自定义服务的 OpenAI、Anthropic、Google 精确 ID 继续采用各自厂商目录", async () => {
  const entries = [
    { provider: "openai", id: "gpt-5.6-sol" },
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "google", id: "gemini-2.5-pro" },
  ];
  const stub = stubFetch({ "GET /v1/models": { body: { data: entries.map(({ id }) => ({ id })) } } });
  try {
    const result = await discoverModels({
      kind: "custom", provider: "corp-gateway", baseUrl: "https://gateway.example.test/v1",
      api: "openai-completions", credential: "candidate-secret-must-not-leak",
    }, { allowNetwork: false, ...privateCatalog() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const [index, entry] of entries.entries()) {
      const catalog = await loadPiProviderCatalog(entry.provider, { allowNetwork: false, ...privateCatalog() });
      const expected = catalog?.models.find(({ id }) => id === entry.id);
      assert.ok(expected, `${entry.provider}:${entry.id} 必须在本机 Pi 目录中`);
      const fields: DiscoveredModel["fields"] = result.models[index]!.fields;
      assert.equal(fields.contextWindow, expected.contextWindow);
      assert.equal(fields.maxTokens, expected.maxTokens);
      assert.deepEqual(fields.thinkingLevelMap, expected.thinkingLevelMap);
      const compat: Record<string, unknown> = { ...expected.compat };
      delete compat.supportsMidConvoEffort;
      delete compat.supportsMidConvoSystemMessages;
      assert.deepEqual(fields.compat, Object.keys(compat).length === 0 ? undefined : compat);
    }
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("自定义服务不继承 supportsMidConvoEffort：兼容网关不认 output_config，内置服务照常", () => {
  // Pi 0.85.0 给 claude-opus-5 打上 supportsMidConvoEffort,anthropic-messages 据此往 messages
  // 里插 output_config 并加 beta 头;走自定义地址的兼容网关(sub2 代理)回 400。目录里的
  // 这一位只对官方 Anthropic 地址成立,自定义服务抄 compat 时剥掉它(issue #262 验收)。
  const discovery = {
    identity: "sub2anthropic:claude-opus-5",
    provider: "sub2anthropic",
    id: "claude-opus-5",
    fields: {
      api: "anthropic-messages",
      baseUrl: "https://gateway.example.test/v1",
      compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, forceAdaptiveThinking: true },
    },
    fieldSources: { api: "service-target" as const, baseUrl: "service-target" as const, compat: "pi-catalog" as const },
  };
  const custom = synthesizeRuntimeModel({
    kind: "custom",
    provider: "sub2anthropic",
    baseUrl: "https://gateway.example.test/v1",
    api: "anthropic-messages",
    credential: "candidate-secret-must-not-leak",
  }, discovery);
  assert.equal(custom.ok, true);
  if (custom.ok) {
    assert.deepEqual(custom.value.runtime.compat, { forceAdaptiveThinking: true }, "剥掉 supportsMidConvoEffort,其余 compat 保留");
  }
  const builtin = synthesizeRuntimeModel(
    { kind: "builtin", provider: "anthropic", credential: "candidate-secret-must-not-leak" },
    { ...discovery, identity: "anthropic:claude-opus-5", provider: "anthropic", fields: { ...discovery.fields, baseUrl: "https://api.anthropic.com/v1" } },
    { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
  );
  assert.equal(builtin.ok, true);
  if (builtin.ok) {
    assert.equal((builtin.value.runtime.compat as { supportsMidConvoEffort?: boolean })?.supportsMidConvoEffort, true, "内置官方地址照常");
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
    const discovered = await discoverModels(candidate, { allowNetwork: false, ...privateCatalog() });
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

test("Responses 最小真实推理遵守低于 16 的输出上限,其余上限仍最多请求 16", async () => {
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const event = {
      type: "response.completed",
      response: { id: "resp-validation", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    for (let maxTokens = 1; maxTokens <= 17; maxTokens++) {
      const result = await validateMinimalInference({
        kind: "custom", provider: "responses-validation", api: "openai-responses",
        baseUrl: "https://responses-validation.test/v1", credential: "test-validation-secret",
      }, {
        identity: "responses-validation:validation-model", provider: "responses-validation",
        id: "validation-model", fields: { maxTokens },
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(calls.length, maxTokens, "每次验证恰好发出一笔请求");
      assert.equal(calls.at(-1)!["max_output_tokens"], Math.min(16, maxTokens));
    }
  } finally {
    globalThis.fetch = original;
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
    }, { allowNetwork: false, ...privateCatalog() });

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
