import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadPiProviderCatalog } from "../src/reviewer/catalog.ts";
import { discoverModels } from "../src/reviewer/model-service-runtime.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("模型服务内置发现不读取旧 models.json 当前配置", async () => {
  const root = mkdtempSync(join(tmpdir(), "multireviewer-service-catalog-"));
  dirs.push(root);
  const cacheDir = join(root, "pi-models");
  mkdirSync(cacheDir, { recursive: true });
  const legacyModel = "legacy-derived-model-must-not-appear";
  writeFileSync(
    join(cacheDir, "models.json"),
    JSON.stringify({
      providers: {
        deepseek: {
          api: "openai-responses",
          baseUrl: "https://legacy.example.test/v1",
          models: [{ id: legacyModel, name: "Legacy derived model" }],
        },
      },
    }),
  );
  const options = {
    allowNetwork: false,
    catalogStorePath: join(cacheDir, "models-store.json"),
  } as const;

  const catalog = await loadPiProviderCatalog("deepseek", options);
  assert.ok(catalog !== undefined);
  assert.ok(catalog.models.length > 0);
  assert.equal(catalog.models.some((model) => model.id === legacyModel), false);

  const discovered = await discoverModels(
    { kind: "builtin", provider: "deepseek", credential: "unused" },
    options,
  );
  assert.equal(discovered.ok, true);
  if (discovered.ok) {
    assert.equal(discovered.models.some((model) => model.id === legacyModel), false);
  }
});

/**
 * Pi 1.2 起 OpenRouter 的落盘那一条整份替换目录(`withPersonalizedCatalog`)。厂商补缺只写补的
 * 那几行的话,pi.dev 拉不到、落盘又是空的那一次,目录会被冲成只剩补进来的行。
 */
test("pi.dev 拉不到、落盘为空时补缺之后 OpenRouter 目录不少于内置表且含补进来的行", async () => {
  const root = mkdtempSync(join(tmpdir(), "multireviewer-service-catalog-"));
  dirs.push(root);
  const vendorOnly = "multireviewer/vendor-only-model";
  const builtin = await loadPiProviderCatalog("openrouter", {
    allowNetwork: false,
    catalogStorePath: join(root, "offline-store.json"),
  });
  assert.ok(builtin !== undefined && builtin.models.length > 0);

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/models") {
      return Response.json({ data: [{ id: vendorOnly, name: "Vendor only", context_length: 32_000 }] });
    }
    throw new TypeError("network unreachable");
  }) as typeof fetch;
  try {
    const merged = await loadPiProviderCatalog("openrouter", {
      allowNetwork: true,
      timeoutMs: 2_000,
      catalogStorePath: join(root, "online-store.json"),
    });
    assert.ok(merged !== undefined);
    const ids = new Set(merged.models.map((model) => model.id));
    assert.ok(ids.has(vendorOnly));
    assert.ok(merged.models.length >= builtin.models.length + 1, `${merged.models.length} < ${builtin.models.length + 1}`);
    for (const model of builtin.models) assert.ok(ids.has(model.id), `内置行 ${model.id} 被冲掉`);
  } finally {
    globalThis.fetch = original;
  }
});
