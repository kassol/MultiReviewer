/**
 * 模型目录端点(issue #67)。走 panel harness 的真实 HTTP 缝。
 *
 * 期望值不取自被测的 `catalog.ts`,而是在测试里另建一个 `ModelRuntime` 直接问 Pi:
 * 拿被测模块自己的输出当判据,目录读错了也测不出来。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { encryptCredential } from "../src/panel/credential-crypto.ts";
import { openStore } from "../src/review/store.ts";
import { PANEL_CREDENTIAL_MASTER_KEY, startPanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type CatalogBody = {
  providers: {
    id: string;
    name: string;
    configured: boolean;
    models: Record<string, unknown>[];
  }[];
};

/** 直接问 Pi 要一份目录,与服务读的是同一版包、同样的隔离目录。 */
async function piCatalog(): Promise<Map<string, string[]>> {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-catalog-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  return new Map(
    runtime.getProviders().map((provider) => [provider.id, provider.getModels().map((m) => m.id)]),
  );
}

test("目录端点回 Pi 里的全部 provider 与它们的模型", async () => {
  const h = await startPanelHarness(cleanups);
  const expected = await piCatalog();

  const res = await h.api("GET", "/catalog");
  assert.equal(res.status, 200);
  const body = (await res.json()) as CatalogBody;

  assert.equal(body.providers.length, expected.size);
  for (const provider of body.providers) {
    assert.deepEqual(
      provider.models.map((model) => model["id"]),
      expected.get(provider.id),
      `${provider.id} 的模型列表与 Pi 目录不一致`,
    );
    assert.equal(typeof provider.name, "string");
  }
});

test("模型只带 id、name、contextWindow、cost 四项", async () => {
  const h = await startPanelHarness(cleanups);
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;

  const models = body.providers.flatMap((provider) => provider.models);
  assert.ok(models.length > 0, "目录里一个模型都没有");
  for (const model of models) {
    assert.deepEqual(Object.keys(model).sort(), ["contextWindow", "cost", "id", "name"]);
  }
  const sample = models[0]!;
  assert.equal(typeof sample["contextWindow"], "number");
  assert.equal(typeof (sample["cost"] as { input?: unknown }).input, "number");
});

test("配了凭据的那一家标 configured,没配的照常在结果里", async () => {
  const h = await startPanelHarness(cleanups);
  const store = openStore(h.db.path);
  store.putModelCredential(
    "deepseek",
    encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, "sk-catalog-test"),
    new Date(0).toISOString(),
  );
  store.close();

  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const byId = new Map(body.providers.map((provider) => [provider.id, provider]));

  assert.equal(byId.get("deepseek")?.configured, true);
  const unconfigured = body.providers.filter((provider) => !provider.configured);
  assert.ok(unconfigured.length > 0, "没配凭据的 provider 被过滤掉了");
  assert.ok(byId.has("openrouter"), "没配凭据的 openrouter 不在结果里");
  assert.equal(byId.get("openrouter")?.configured, false);
  assert.ok((byId.get("openrouter")?.models.length ?? 0) > 0, "没配凭据的一家没有模型");
});

test("缺主密钥时目录端点不可用", async () => {
  const h = await startPanelHarness(cleanups, { credentialMasterKey: undefined });
  const res = await h.api("GET", "/catalog");
  assert.equal(res.status, 503);
});
