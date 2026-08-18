/**
 * 模型目录端点(issue #67)。走 panel harness 的真实 HTTP 缝。
 *
 * 期望值不取自被测的 `catalog.ts`,而是在测试里另建一个 `ModelRuntime` 直接问 Pi:
 * 拿被测模块自己的输出当判据,目录读错了也测不出来。
 *
 * 这一组只测端点的形状,因此按 `PI_OFFLINE` 关掉远程目录:测试不打 pi.dev,期望值
 * 与被测服务读的也就是同一份内置表。远程那一层在 `catalog-remote.test.ts` 里测。
 */
process.env["PI_OFFLINE"] = "1";
// 目录缓存也指进临时目录:测试不在仓库里留下 `.cache`。
process.env["MULTIREVIEWER_CACHE_DIR"] = mkdtempSync(join(tmpdir(), "multireviewer-catalog-cache-"));

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { CHECKED_PROVIDERS } from "../src/panel/credential-check.ts";
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
    verifiable: boolean;
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
    true,
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

test("真发验证请求的那几家标 verifiable,判据取自 credential-check", async () => {
  const h = await startPanelHarness(cleanups);
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const byId = new Map(body.providers.map((provider) => [provider.id, provider]));

  for (const provider of CHECKED_PROVIDERS) {
    assert.equal(byId.get(provider)?.verifiable, true, `${provider} 没标 verifiable`);
  }
  const unverifiable = body.providers.filter((provider) => !provider.verifiable);
  assert.ok(unverifiable.length > 0, "所有 provider 都被标成会验证");
});

test("缺主密钥时目录照常给出,全部按未配置算", async () => {
  const h = await startPanelHarness(cleanups, { credentialMasterKey: undefined });
  const res = await h.api("GET", "/catalog");
  assert.equal(res.status, 200);
  const providers = ((await res.json()) as CatalogBody).providers;
  assert.ok(providers.length > 0, "缺主密钥时目录为空");
  assert.ok(
    providers.every((provider) => provider.configured === false),
    "缺主密钥时有 provider 被标成已配",
  );
});

/**
 * 凭据改了之后目录端点立刻反映,同一个进程里连续两次请求不会拿到旧的 `configured`。
 *
 * 端点把目录与凭据状态拼在一起,而目录那一半是缓存住的——`configured` 一旦被顺手挪进那
 * 一层缓存,这条就会挂:操作员配完 key 回到设置页,那一家仍是灰的,只能重启容器。
 *
 * 走一个 `CHECKED_PROVIDERS` 之外的 provider:那几家保存前会真发一次验证请求,而这一条
 * 测的不是验证。
 */
test("凭据写入与删除之后,紧接着的目录请求立刻跟着变", async () => {
  const h = await startPanelHarness(cleanups);
  const provider = "groq";
  assert.ok(!CHECKED_PROVIDERS.includes(provider), `${provider} 会触发厂商验证,换一家`);

  const configuredNow = async (): Promise<boolean | undefined> => {
    const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
    return body.providers.find((entry) => entry.id === provider)?.configured;
  };

  assert.equal(await configuredNow(), false, `${provider} 一开始就该是未配置`);

  assert.equal(
    (await h.api("PUT", `/credentials/${provider}`, { apiKey: "sk-groq-catalog-4455" })).status,
    200,
  );
  assert.equal(await configuredNow(), true, "配完凭据目录端点还说未配置");

  assert.equal((await h.api("DELETE", `/credentials/${provider}`)).status, 204);
  assert.equal(await configuredNow(), false, "删掉凭据目录端点还说已配置");
});
