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
  assert.equal(catalog.remote, "off");
  assert.equal(catalog.vendors.openrouter, "off");
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
