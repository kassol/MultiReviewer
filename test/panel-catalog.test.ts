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
import {
  HARNESS_PR,
  PANEL_CREDENTIAL_MASTER_KEY,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

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
    /** 是不是操作员自己加的那一家(issue #88)。 */
    custom: boolean;
    /** 名字撞上 Pi 内置的同一家(issue #94)。真即这一家已停用。 */
    conflict: boolean;
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

test("模型只带 id、name、contextWindow、cost、costUnset 五项", async () => {
  const h = await startPanelHarness(cleanups);
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;

  const models = body.providers.flatMap((provider) => provider.models);
  assert.ok(models.length > 0, "目录里一个模型都没有");
  for (const model of models) {
    assert.deepEqual(
      Object.keys(model).sort(),
      ["contextWindow", "cost", "costUnset", "id", "name"],
    );
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

/**
 * 目录端点把两层增量的状态分开报:少了一批模型时,运维要能分清是远程目录那一层还是
 * 厂商目录那一层。这个文件里 `PI_OFFLINE` 是设死的,因此两层都该是「关掉了」。
 */
test("目录端点按 provider 报厂商目录那一层的状态,与远程那一层分开", async () => {
  const h = await startPanelHarness(cleanups);
  const res = await h.api("GET", "/catalog");
  assert.equal(res.status, 200);

  const body = (await res.json()) as { remote: string; vendors: Record<string, string> };
  assert.equal(body.remote, "off");
  assert.equal(body.vendors["openrouter"], "off");
});

/** 一条手填的模型行读回来的形状。 */
type ModelRow = {
  provider: string;
  model: string;
  costInput: number | null;
  costOutput: number | null;
  contextWindow: number | null;
  createdAt: string;
};

/**
 * 手填只开在已配凭据的厂商上(issue #80),而 `CHECKED_PROVIDERS` 那几家保存凭据时会真发
 * 一次验证请求。测试要的不是验证,取一家目录里有、验证名单外的。
 */
const HAND_FILL_PROVIDER = "groq";

/** 该家的模型集合,由目录端点给出——面板选得出什么,判据只在这里。 */
async function catalogModels(
  h: PanelHarness,
  providerId: string,
): Promise<Record<string, unknown>[]> {
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const provider = body.providers.find((entry) => entry.id === providerId);
  assert.ok(provider !== undefined, `目录里没有 ${providerId}`);
  return provider.models;
}

/**
 * 手填的模型行(issue #87)。这一条走完整一圈:加一行、列出、目录端点里多出那一个 id、
 * 该家其余行一字不变、删掉之后目录回到原样。
 *
 * 「该家其余行一字不变」是 upsert 语义的判据:落盘的那一层若把整份模型列表替掉,面板上
 * 那一家会只剩手填的一行,已经选进模型组合的模型全部报「模型不存在」。
 *
 * 删掉那一步不只是覆盖删除端点:这个文件里的共用 `models.json` 一份到底,留一行给后面的
 * 用例就是留一个错的输入。
 */
test("手填一行:目录里多出那个 id,该家其余行一字不变,删掉又回去", async () => {
  const h = await startPanelHarness(cleanups);
  const model = "multireviewer/hand-filled-row";
  assert.ok(!CHECKED_PROVIDERS.includes(HAND_FILL_PROVIDER), "换一家验证名单外的 provider");
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0001" }))
      .status,
    200,
  );

  const before = await catalogModels(h, HAND_FILL_PROVIDER);
  assert.ok(before.length > 0, "这一家一个模型都没有,继承不到接口协议,换一家");

  const added = await h.api("POST", "/model-rows", {
    provider: HAND_FILL_PROVIDER,
    model,
    costInput: 0.5,
    contextWindow: 65_536,
  });
  assert.equal(added.status, 200);
  const addedBody = (await added.json()) as { rows: ModelRow[] };
  const addedRows = addedBody.rows;
  assert.deepEqual(
    addedRows.map((row) => `${row.provider}:${row.model}`),
    [`${HAND_FILL_PROVIDER}:${model}`],
  );
  assert.equal(addedRows[0]!.costInput, 0.5);
  // 没填的那两项留 null,落盘时整项不写、由 Pi 取默认值。
  assert.equal(addedRows[0]!.costOutput, null);
  assert.equal(addedRows[0]!.contextWindow, 65_536);

  // 列出的与写入回的是同一份。
  const listed = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(listed.rows, addedRows);

  const after = await catalogModels(h, HAND_FILL_PROVIDER);
  assert.deepEqual(
    after.filter((entry) => !before.some((old) => old["id"] === entry["id"])),
    [
      {
        id: model,
        // 显示名没有存储面,Pi 回落到 id 本身。
        name: model,
        contextWindow: 65_536,
        cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 },
        // 填了入价,因此这一行不算单价留空(issue #89)。
        costUnset: false,
      },
    ],
    "目录里多出来的不止手填那一行",
  );
  for (const original of before) {
    assert.deepEqual(
      after.find((entry) => entry["id"] === original["id"]),
      original,
      `${String(original["id"])} 被手填那一行改动了`,
    );
  }

  assert.equal(
    (await h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    204,
  );
  const emptied = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(emptied.rows, []);
  assert.deepEqual(await catalogModels(h, HAND_FILL_PROVIDER), before, "删掉之后目录没有回原样");
});

/**
 * 三类拒收各一条。手填只开在「目录里有、且已配模型凭据」的 provider 上(issue #80):放开
 * 到全部 39 家会让选择器里点不动的那一家在这里填得进,两套规则并存。
 */
test("手填拒收三类:provider 不在目录、该家没配凭据、model id 是空的", async () => {
  const h = await startPanelHarness(cleanups);

  const unknownRes = await h.api("POST", "/model-rows", {
    provider: "no-such-vendor",
    model: "m",
  });
  assert.equal(unknownRes.status, 400);
  const unknownBody = (await unknownRes.json()) as { error: string };
  assert.match(unknownBody.error, /模型目录里没有 no-such-vendor/);

  const noKey = await h.api("POST", "/model-rows", { provider: HAND_FILL_PROVIDER, model: "m" });
  assert.equal(noKey.status, 400);
  const noKeyBody = (await noKey.json()) as { error: string };
  assert.match(noKeyBody.error, /还没配模型凭据/);

  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0002" }))
      .status,
    200,
  );
  const blank = await h.api("POST", "/model-rows", {
    provider: HAND_FILL_PROVIDER,
    model: "   ",
  });
  assert.equal(blank.status, 400);
  const blankBody = (await blank.json()) as { error: string };
  assert.match(blankBody.error, /model id 不能是空的/);

  // 三条都没落库,派生文件因此也没被动过。
  const stillEmpty = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(stillEmpty.rows, []);
});

/**
 * 目录里一个模型都没有的那一家拒收:`api` 与 `baseUrl` 是从该家第一个模型继承来的,没有
 * 第一个模型就继承不到,Pi 会把这一行整个丢掉——人看到「保存成功」,选择器里却找不到它。
 */
test("手填拒收目录里一个模型都没有的 provider", async () => {
  const h = await startPanelHarness(cleanups);
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const empty = body.providers.find((provider) => provider.models.length === 0);
  assert.ok(empty !== undefined, "这一版 Pi 里没有空模型列表的 provider,这条断言失去意义");

  const store = openStore(h.db.path);
  store.putModelCredential(
    empty.id,
    encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, "sk-empty-provider"),
    new Date(0).toISOString(),
    true,
  );
  store.close();

  const res = await h.api("POST", "/model-rows", { provider: empty.id, model: "anything" });
  assert.equal(res.status, 400);
  const resBody = (await res.json()) as { error: string };
  assert.match(resBody.error, /一个模型都没有/);
});

/**
 * 手填的模型标识进得了模型组合。判据取的是目录端点给出的那个 id 而不是测试里的字面量:
 * 面板的选择器就是这样拼出模型标识的(`provider:model`),库里存的、目录里给的与组合里
 * 保存的必须是同一个字符串,中间任何一步做归一化都会让人选中的模型在 Review Run 里取不到。
 */
test("手填的模型标识能选进模型组合并保存", async () => {
  const h = await startPanelHarness(cleanups);
  const model = "multireviewer/hand-filled-in-set";
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0003" }))
      .status,
    200,
  );
  assert.equal(
    (await h.api("POST", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    200,
  );

  const listed = await catalogModels(h, HAND_FILL_PROVIDER);
  const picked = listed.find((entry) => entry["id"] === model);
  assert.ok(picked !== undefined, "目录端点里没有手填那一行,选择器也就选不到它");

  const saved = await h.api("PUT", "/settings", {
    reviewers: [{ provider: HAND_FILL_PROVIDER, model: picked["id"] }],
    maxChangedLinesPerBatch: 2000,
  });
  assert.equal(saved.status, 200);
  const readBack = (await (await h.api("GET", "/settings")).json()) as {
    reviewers: { provider: string; model: string }[];
  };
  assert.deepEqual(readBack.reviewers, [{ provider: HAND_FILL_PROVIDER, model }]);

  assert.equal(
    (await h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    204,
  );
});

/** 一家自定义 provider 读回来的形状。 */
type CustomProvider = {
  name: string;
  baseUrl: string;
  api: string;
  createdAt: string;
};

/** 自定义 provider 的三个入参加它的第一个 model id 与那把 key。 */
const CUSTOM = {
  name: "corp-gateway",
  baseUrl: "https://ai.corp.example/v1",
  api: "openai-completions",
  model: "corp-qwen3-max",
  apiKey: "sk-corp-gateway-0001",
};

/** 目录端点里那一家,连它的自定义标记一起。找不到时回 undefined。 */
async function catalogProvider(
  h: PanelHarness,
  providerId: string,
): Promise<CatalogBody["providers"][number] | undefined> {
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  return body.providers.find((entry) => entry.id === providerId);
}

/**
 * 加一家自定义 provider 走完整一圈(issue #88):加一家 → 目录里这家带着那个模型出现、
 * 带自定义标记 → 列出 → 它的模型标识进得了模型组合 → 在这家下面继续手填第二个 model id
 * → 删。
 *
 * 判据里最要紧的是「这家出现在目录里、和内置那些家并列」:全新 provider 没有继承来源,
 * 派生文件的 provider 一级漏掉 `api` 或 `baseUrl` 的话这一家整个从目录消失,而人只看到
 * 「保存成功」。
 */
test("加一家自定义 provider:目录里出现、带自定义标记、模型进得了组合,删掉又没了", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal(await catalogProvider(h, CUSTOM.name), undefined, "这个名字内置目录里已经有了");

  const added = await h.api("POST", "/custom-providers", CUSTOM);
  const addedText = await added.text();
  assert.equal(added.status, 200, addedText);
  const addedBody = JSON.parse(addedText) as { providers: CustomProvider[] };
  assert.deepEqual(
    addedBody.providers.map((entry) => ({
      name: entry.name,
      baseUrl: entry.baseUrl,
      api: entry.api,
    })),
    [{ name: CUSTOM.name, baseUrl: CUSTOM.baseUrl, api: CUSTOM.api }],
  );
  // key 只写不回显:响应体里一个字都没有。
  assert.equal(addedText.includes(CUSTOM.apiKey), false, "响应体回显了 key");

  const provider = await catalogProvider(h, CUSTOM.name);
  assert.ok(provider !== undefined, "加完这一家不在模型目录里");
  assert.equal(provider.custom, true, "自定义那一位没有标出来");
  // 凭据与这个名字一起落库,因此这一家一开始就是已配凭据的。
  assert.equal(provider.configured, true);
  assert.deepEqual(
    provider.models.map((model) => model["id"]),
    [CUSTOM.model],
  );

  // 列出的与写入回的是同一份。
  const listed = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(listed.providers, addedBody.providers);

  // 它的模型标识进得了模型组合:目录里给的那个 id 与库里存的必须是同一个字符串。
  const saved = await h.api("PUT", "/settings", {
    reviewers: [{ provider: CUSTOM.name, model: provider.models[0]!["id"] }],
    maxChangedLinesPerBatch: 2000,
  });
  assert.equal(saved.status, 200, await saved.text());
  const readBack = (await (await h.api("GET", "/settings")).json()) as {
    reviewers: { provider: string; model: string }[];
  };
  assert.deepEqual(readBack.reviewers, [{ provider: CUSTOM.name, model: CUSTOM.model }]);

  // 这家下面继续手填第二个 model id,复用上一票那条入口。
  const second = await h.api("POST", "/model-rows", { provider: CUSTOM.name, model: "corp-glm-5" });
  assert.equal(second.status, 200, await second.text());
  const twoModels = await catalogProvider(h, CUSTOM.name);
  assert.deepEqual(
    twoModels?.models.map((model) => model["id"]).sort(),
    ["corp-glm-5", CUSTOM.model].sort(),
  );

  // 组合里还引用着就删不掉,先把组合清空再删(引用那一档另有一条用例)。
  assert.equal(
    (await h.api("PUT", "/settings", { reviewers: [], maxChangedLinesPerBatch: 2000 })).status,
    200,
  );
  assert.equal((await h.api("DELETE", `/custom-providers/${CUSTOM.name}`)).status, 204);
  assert.equal(await catalogProvider(h, CUSTOM.name), undefined, "删掉之后这一家还在目录里");
  const emptied = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(emptied.providers, []);
  // 这一家的模型行与凭据跟着一起摘掉:留着会让派生文件里出现一家没有 api 的 provider。
  const rowsLeft = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(
    rowsLeft.rows.filter((row) => row.provider === CUSTOM.name),
    [],
  );
});

/**
 * 内置那些家不带自定义标记。少了这一条,`custom` 恒真也能让上面那条用例通过。
 */
test("内置的 provider 不带自定义标记", async () => {
  const h = await startPanelHarness(cleanups);
  const builtin = await catalogProvider(h, HAND_FILL_PROVIDER);
  assert.equal(builtin?.custom, false);
});

/**
 * 四类拒收各一条(issue #88)。
 *
 * 撞名那一条最要紧:Pi 对同名 provider 不报错而是做覆盖——只给 base URL 不给模型列表时
 * 内置那份模型列表原样保留、全部改指新端点,叫 `openai` 会让已有组合悄声换掉接口地址,
 * 面板上零痕迹(Pi 侧的形态在 `reviewer-model-store` 那条缝上另有一条用例)。
 *
 * base URL 与接口协议缺任一者则该家整个从目录消失(不是报错,是消失),因此必须在保存前
 * 收齐。
 */
test("自定义 provider 六类拒收:撞内置名、非法字符、缺 base URL、缺接口协议、缺 model id、缺 key", async () => {
  const h = await startPanelHarness(cleanups);

  const taken = await h.api("POST", "/custom-providers", { ...CUSTOM, name: HAND_FILL_PROVIDER });
  assert.equal(taken.status, 409);
  assert.match((await taken.json() as { error: string }).error, /已被占用/);

  for (const name of ["Corp-Gateway", "corp_gateway", "corp:gateway", "corp gateway", ""]) {
    const res = await h.api("POST", "/custom-providers", { ...CUSTOM, name });
    assert.equal(res.status, 400, `${name} 竟然收下了`);
    assert.match((await res.json() as { error: string }).error, /小写字母、数字与连字符/);
  }

  const noUrl = await h.api("POST", "/custom-providers", { ...CUSTOM, baseUrl: "" });
  assert.equal(noUrl.status, 400);
  assert.match((await noUrl.json() as { error: string }).error, /base URL/);

  const noApi = await h.api("POST", "/custom-providers", { ...CUSTOM, api: "" });
  assert.equal(noApi.status, 400);
  assert.match((await noApi.json() as { error: string }).error, /接口协议/);
  const badApi = await h.api("POST", "/custom-providers", { ...CUSTOM, api: "grpc" });
  assert.equal(badApi.status, 400);
  assert.match((await badApi.json() as { error: string }).error, /接口协议/);

  const noModel = await h.api("POST", "/custom-providers", { ...CUSTOM, model: "  " });
  assert.equal(noModel.status, 400);
  assert.match((await noModel.json() as { error: string }).error, /model id/);

  const noKey = await h.api("POST", "/custom-providers", { ...CUSTOM, apiKey: "" });
  assert.equal(noKey.status, 400);
  assert.match((await noKey.json() as { error: string }).error, /key 不能留空/);

  // 六类都没落库,目录里因此也没有这一家。
  const listed = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(listed.providers, []);
  assert.equal(await catalogProvider(h, CUSTOM.name), undefined);
});

/**
 * 撞上一家已经登记过的自定义 provider 也算撞名:第二次写入若被当成覆盖,那一家的 base URL
 * 会悄声换掉,而已经选进模型组合的模型标识一个字都没变。
 */
test("撞上已登记的自定义 provider 名字同样拒收", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal((await h.api("POST", "/custom-providers", CUSTOM)).status, 200);

  const again = await h.api("POST", "/custom-providers", {
    ...CUSTOM,
    baseUrl: "https://elsewhere.example/v1",
  });
  assert.equal(again.status, 409);
  assert.match((await again.json() as { error: string }).error, /已被占用/);

  const listed = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(
    listed.providers.map((entry) => entry.baseUrl),
    [CUSTOM.baseUrl],
  );
  assert.equal((await h.api("DELETE", `/custom-providers/${CUSTOM.name}`)).status, 204);

  // 库里登记过、派生文件却还没跟上的那一档也算撞名:判据取目录与库两处的并集。这个状态在
  // 派生文件写不出来(共用目录只读)时是真会出现的,而只查目录会让同一个名字被登记第二次,
  // 撞在主键上直抛 500 而不是给一句「已被占用」。
  const store = openStore(h.db.path);
  store.putCustomProvider({
    name: "db-only-gateway",
    baseUrl: CUSTOM.baseUrl,
    api: CUSTOM.api,
    createdAt: new Date(0).toISOString(),
  });
  store.close();
  assert.equal(
    await catalogProvider(h, "db-only-gateway"),
    undefined,
    "这一家进了目录,那这条用例就测不到库那一侧的判据了",
  );
  const dbOnly = await h.api("POST", "/custom-providers", { ...CUSTOM, name: "db-only-gateway" });
  assert.equal(dbOnly.status, 409);
  assert.match((await dbOnly.json() as { error: string }).error, /已被占用/);
});

/**
 * key 走既有的模型凭据加密路径(ADR 0008):只写不回显,而且标成未验证——自定义端点没有
 * 厂商验证认得的那种只读端点,key 对不对要等 Review Run 才知道。
 */
test("自定义 provider 的 key 只写不回显,并标成未验证", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal((await h.api("POST", "/custom-providers", CUSTOM)).status, 200);

  const credentials = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: { provider: string; configured: boolean; verified: boolean; last4: string }[];
  };
  const row = credentials.credentials.find((entry) => entry.provider === CUSTOM.name);
  assert.ok(row !== undefined, "key 没有落进模型凭据表");
  assert.equal(row.configured, true);
  assert.equal(row.verified, false, "自定义端点验证不了,不能标成已验证");
  // 只回尾 4 位,明文一个字都不回显。
  assert.equal(row.last4, CUSTOM.apiKey.slice(-4));
  assert.equal(JSON.stringify(credentials).includes(CUSTOM.apiKey), false);

  assert.equal((await h.api("DELETE", `/custom-providers/${CUSTOM.name}`)).status, 204);
});

/**
 * 删一家时说明它在模型组合里还被引用着,全局组合与每仓库覆盖都要查。删掉不问的话那些组合
 * 留着一个取不到的模型标识,下一次审查里那一个模型报「模型不存在」,而人根本不知道是这次
 * 删除引起的。
 */
test("删一家自定义 provider 时说明它在哪些模型组合里还被引用着", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal((await h.api("POST", "/custom-providers", CUSTOM)).status, 200);
  const spec = { provider: CUSTOM.name, model: CUSTOM.model };

  assert.equal(
    (await h.api("PUT", "/settings", { reviewers: [spec], maxChangedLinesPerBatch: 2000 })).status,
    200,
  );
  const register = await h.api("POST", "/repos", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
  });
  assert.equal(register.status, 201);
  const { repoId } = (await register.json()) as { repoId: number };
  assert.equal(
    (await h.api("PUT", `/repos/${repoId}/reviewers`, { reviewers: [spec] })).status,
    204,
  );

  const blocked = await h.api("DELETE", `/custom-providers/${CUSTOM.name}`);
  assert.equal(blocked.status, 409);
  const error = (await blocked.json() as { error: string }).error;
  assert.match(error, /全局组合/);
  assert.match(error, new RegExp(`${HARNESS_PR.owner}/${HARNESS_PR.repo}`));
  // 拒收了就一个字都没删。
  assert.ok(await catalogProvider(h, CUSTOM.name), "拒收了却把这一家删掉了");

  // 两层组合都摘掉之后才删得动。
  assert.equal(
    (await h.api("PUT", `/repos/${repoId}/reviewers`, { reviewers: null })).status,
    204,
  );
  assert.equal(
    (await h.api("PUT", "/settings", { reviewers: [], maxChangedLinesPerBatch: 2000 })).status,
    200,
  );
  assert.equal((await h.api("DELETE", `/custom-providers/${CUSTOM.name}`)).status, 204);
});

/**
 * base URL 填错时这一家照样在目录里,它的模型也照样选得出:地址对不对要到真请求才知道,
 * 那时留下的是一条带原因的 Reviewer 失败记录(issue #65 的既有链路)。这一条守的是「不静默
 * 消失」——只要 `api` 与 `baseUrl` 两项都在,Pi 就能把这一家合成出来。
 */
test("base URL 填错时这一家仍在目录里,不静默消失", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/custom-providers", { ...CUSTOM, baseUrl: "totally-not-a-url" })).status,
    200,
  );

  const provider = await catalogProvider(h, CUSTOM.name);
  assert.ok(provider !== undefined, "base URL 填错让这一家从目录里静默消失了");
  assert.deepEqual(
    provider.models.map((model) => model["id"]),
    [CUSTOM.model],
  );
  assert.equal((await h.api("DELETE", `/custom-providers/${CUSTOM.name}`)).status, 204);
});

/**
 * 单价留空这一位(issue #89)。手填一行可以不填单价,留空走 Pi 的默认值,而那个默认值就是
 * 0——于是这个模型的 Review Run 成本记成零,面板不说的话操作员会把「没记账」读成「很便宜」。
 *
 * 判据只在库里:那一行的两个单价字段都是 null 即留空。目录里的 `cost` 是 Pi 给的结果,
 * 区分不出「真是 0」与「没填」。
 */
test("手填一行留空单价:目录里那一行标 costUnset,填了单价的不标", async () => {
  const h = await startPanelHarness(cleanups);
  const blank = "multireviewer/cost-blank";
  const priced = "multireviewer/cost-priced";
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0004" }))
      .status,
    200,
  );
  assert.equal(
    (await h.api("POST", "/model-rows", { provider: HAND_FILL_PROVIDER, model: blank })).status,
    200,
  );
  assert.equal(
    (
      await h.api("POST", "/model-rows", {
        provider: HAND_FILL_PROVIDER,
        model: priced,
        costInput: 0.5,
        costOutput: 1.5,
      })
    ).status,
    200,
  );

  const models = await catalogModels(h, HAND_FILL_PROVIDER);
  const blankEntry = models.find((entry) => entry["id"] === blank);
  const pricedEntry = models.find((entry) => entry["id"] === priced);
  assert.ok(blankEntry !== undefined, "目录里没有留空单价那一行");
  assert.ok(pricedEntry !== undefined, "目录里没有填了单价那一行");

  // 留空那一行的单价是 Pi 的默认值,与「真是 0」在目录上长得一模一样——这一位因此不能从
  // 目录算,只能从库算。
  assert.deepEqual(blankEntry["cost"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(blankEntry["costUnset"], true);
  assert.equal(pricedEntry["costUnset"], false);

  for (const model of [blank, priced]) {
    assert.equal(
      (await h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
      204,
    );
  }
});

/**
 * 只填一头的那一档:语义跟着落盘走。`writeSharedModelsConfig` 是「两项都留空才整项不写」,
 * 只填入价时出价按 0 一起落进单价表,那是操作员写下的 0 而不是没填,因此不算留空。
 */
test("只填入价、出价留空的行不算单价留空", async () => {
  const h = await startPanelHarness(cleanups);
  const model = "multireviewer/cost-half";
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0005" }))
      .status,
    200,
  );
  assert.equal(
    (
      await h.api("POST", "/model-rows", {
        provider: HAND_FILL_PROVIDER,
        model,
        costInput: 0.5,
      })
    ).status,
    200,
  );

  const entry = (await catalogModels(h, HAND_FILL_PROVIDER)).find(
    (candidate) => candidate["id"] === model,
  );
  assert.ok(entry !== undefined, "目录里没有只填入价那一行");
  assert.deepEqual(entry["cost"], { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(entry["costUnset"], false);

  assert.equal(
    (await h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    204,
  );
});

/**
 * 目录来的模型一律不标,包括单价本来就是 0 的那些(内置表里实测 109 个)。它们的 0 是目录
 * 给的事实,标出来等于把「免费」诬告成「没记账」。
 *
 * 判据取的是端点自己给出的单价而不是写死一个模型 id:Pi 升级会换掉哪些模型免费,而这一条
 * 要守的是「拿 `cost` 判留空」这个错法必须判错。
 */
test("目录来的模型不标 costUnset,单价本来就是 0 的也不标", async () => {
  const h = await startPanelHarness(cleanups);
  const body = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const models = body.providers.flatMap((provider) => provider.models);

  const free = models.filter((model) => {
    const cost = model["cost"] as { input: number; output: number };
    return cost.input === 0 && cost.output === 0;
  });
  assert.ok(free.length > 0, "目录里一个免费模型都没有,这一条守不住任何东西");
  for (const model of free) {
    assert.equal(model["costUnset"], false, `${String(model["id"])} 的单价是目录给的 0,不是留空`);
  }
  assert.ok(
    models.every((model) => model["costUnset"] === false),
    "库里一行都没有,却有模型被标成单价留空",
  );
});

/**
 * 手填一个该家目录里已经有的 model id 且留空单价:`applyModelsJson` 按 upsert 把已有那一行
 * 整个替掉,单价回落到 Pi 的默认值 0(issue #87 记下的那处别踩)。这一位正是为它准备的——
 * 原本有价的模型从此按零记账,面板必须说出来。
 *
 * 目标取一个「别家也有这个 id」的模型:标注跟着整条模型标识走,只按裸 model id 比对会把别
 * 家同名的那些模型一起标上(内置目录里跨 provider 重复的 id 有 216 个)。
 */
test("手填该家已有的 model id 且留空单价:目录里单价变 0 且标 costUnset", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0006" }))
      .status,
    200,
  );

  const before = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const sharedElsewhere = (id: unknown): boolean =>
    before.providers.some(
      (other) =>
        other.id !== HAND_FILL_PROVIDER && other.models.some((entry) => entry["id"] === id),
    );
  const own = before.providers.find((provider) => provider.id === HAND_FILL_PROVIDER);
  assert.ok(own !== undefined, `目录里没有 ${HAND_FILL_PROVIDER}`);
  const target = own.models.find(
    (entry) => (entry["cost"] as { input: number }).input > 0 && sharedElsewhere(entry["id"]),
  );
  assert.ok(target !== undefined, "这一家没有既有价、别家也有的模型,换一家");
  const model = String(target["id"]);

  assert.equal(
    (await h.api("POST", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    200,
  );

  const after = (await (await h.api("GET", "/catalog")).json()) as CatalogBody;
  const overwritten = after.providers
    .find((provider) => provider.id === HAND_FILL_PROVIDER)
    ?.models.find((entry) => entry["id"] === model);
  assert.ok(overwritten !== undefined, "覆盖之后这个模型从目录里消失了");
  assert.deepEqual(overwritten["cost"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(overwritten["costUnset"], true);

  for (const provider of after.providers) {
    if (provider.id === HAND_FILL_PROVIDER) continue;
    const same = provider.models.find((entry) => entry["id"] === model);
    if (same === undefined) continue;
    assert.equal(same["costUnset"], false, `${provider.id}:${model} 被别家那一行的留空标上了`);
  }

  assert.equal(
    (await h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    204,
  );
  assert.deepEqual(
    (await catalogModels(h, HAND_FILL_PROVIDER)).find((entry) => entry["id"] === model),
    target,
    "删掉手填那一行之后,被覆盖的模型没有回到原样",
  );
});

/**
 * 撞名那一档要一个 Pi 内置就有的名字(issue #94)。用真的内置 id 而不是往落盘里注一家新
 * provider:pi.dev 的**远程目录**加不出新的一家——`withRemoteCatalog` 只包在内置 provider
 * 列表上,恢复时还按 `model.provider === provider.id` 过一遍,落盘里那些没有对应内置家的条目
 * 一条都进不来(issue #82 查证过同一件事)。而「库里有一条登记、内置目录里也有同名的一家」
 * 这个状态本身,拿一个现成的内置 id 播种就与升级之后的现场一模一样。
 */
const COLLIDING_NAME = "cerebras";

/** 撞名那一家的登记与它的第一个模型行,直接播种库——登记端点本来就会拒收这个名字。 */
function seedCollided(dbPath: string, name: string): void {
  const store = openStore(dbPath);
  const createdAt = new Date(0).toISOString();
  store.putCustomProvider({ name, baseUrl: CUSTOM.baseUrl, api: CUSTOM.api, createdAt });
  store.putModelRow({
    provider: name,
    model: CUSTOM.model,
    costInput: null,
    costOutput: null,
    contextWindow: null,
    createdAt,
  });
  store.close();
}

/**
 * 按库重写一次派生文件。删一条不存在的模型行是最小的触发方式——那个端点不存在的行也照样
 * 重建并回 204,而播种是直接写库的,它绕过了每个写入口后面那一次重建。
 */
async function rebuild(h: PanelHarness): Promise<void> {
  const res = await h.api("DELETE", "/model-rows", { provider: "nobody", model: "nothing" });
  assert.equal(res.status, 204, await res.text());
}

/**
 * 撞名的自定义 provider 在目录端点上标成冲突,而内置那一家一点都没被动过(issue #94)。
 *
 * 「没被动过」在这里的判据是模型集合与 Pi 给的一字不差:撞名那一家要是落进了派生文件,Pi 会
 * 把它的模型行当成给内置这一家手填的行追加进来,而内置那些模型全部改指自定义那个端点。后半句
 * 端点看不见(`baseUrl` 不在响应里),由 `reviewer-model-store` 那一条打在运行时对象上。
 */
test("撞名的自定义 provider:目录端点标成冲突,内置那一家的模型集合一字不差", async () => {
  const h = await startPanelHarness(cleanups);
  const builtinModels = (await piCatalog()).get(COLLIDING_NAME);
  assert.ok(
    builtinModels !== undefined && builtinModels.length > 0,
    `Pi 内置目录里没有 ${COLLIDING_NAME} 或者它一个模型都没有,换一个名字`,
  );

  seedCollided(h.db.path, COLLIDING_NAME);
  await rebuild(h);

  const entry = await catalogProvider(h, COLLIDING_NAME);
  assert.ok(entry !== undefined, "撞名之后这一家整个从目录里消失了");
  assert.equal(entry.conflict, true, "撞名那一位没有标出来");
  // 库里那条登记还在,面板要凭这一位把删除入口给出来。
  assert.equal(entry.custom, true);
  assert.deepEqual(
    entry.models.map((model) => model["id"]),
    builtinModels,
    "内置这一家的模型集合变了,撞名那一家的行混进来了",
  );

  // 其余那些家不标冲突。少了这一条,`conflict` 恒真也能让上面那几句通过。
  assert.equal((await catalogProvider(h, HAND_FILL_PROVIDER))?.conflict, false);
});

/**
 * 冲突消失之后行为自动恢复,不需要重启也不需要别的操作(issue #94):冲突不落库,它是每次读
 * 目录时按「库里的登记 ∩ Pi 内置目录」算出来的。这里走的是面板给出的两条出路里的「改名重建」。
 */
test("撞名那一家改名重建之后,目录端点上的冲突自己消失", async () => {
  const h = await startPanelHarness(cleanups);
  seedCollided(h.db.path, COLLIDING_NAME);
  await rebuild(h);
  assert.equal((await catalogProvider(h, COLLIDING_NAME))?.conflict, true);

  // 改名重建:摘掉撞名那一家(连它的模型行一起),换一个没被占用的名字重登记。
  const store = openStore(h.db.path);
  store.removeCustomProvider(COLLIDING_NAME);
  store.close();
  seedCollided(h.db.path, CUSTOM.name);
  await rebuild(h);

  assert.equal((await catalogProvider(h, COLLIDING_NAME))?.conflict, false, "冲突没跟着消失");
  const revived = await catalogProvider(h, CUSTOM.name);
  assert.equal(revived?.conflict, false);
  assert.equal(revived?.custom, true);
  assert.deepEqual(
    revived?.models.map((model) => model["id"]),
    [CUSTOM.model],
    "改完名这一家没有带着它的模型回到目录里",
  );
});

/**
 * 撞名那一家下面填不进模型行(issue #94)。这一家整个停用了,派生文件里没有它,填进去的行
 * 会落库却永远进不了模型目录——正是「保存成功却选不到」那一档(issue #87 的第四道拒收同源)。
 *
 * 手填那三道既有的门禁在这里全部过得去:名字撞上的内置那一家在目录里、有模型、而且凭据就是
 * 登记撞名那一家时落下的那一把。因此这一道必须自己判,不能指望顺带被挡住。
 */
test("撞名那一家下面填不进模型行,拒收并写明是名字冲突", async () => {
  const h = await startPanelHarness(cleanups);
  seedCollided(h.db.path, COLLIDING_NAME);
  const store = openStore(h.db.path);
  store.putModelCredential(
    COLLIDING_NAME,
    encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, "sk-collided-gateway"),
    new Date(0).toISOString(),
    false,
  );
  store.close();
  await rebuild(h);

  const res = await h.api("POST", "/model-rows", { provider: COLLIDING_NAME, model: "corp-glm-5" });
  assert.equal(res.status, 400);
  assert.match((await res.json() as { error: string }).error, /名字/);
  const rows = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(
    rows.rows.filter((row) => row.model === "corp-glm-5"),
    [],
    "拒收了却还是落了库",
  );
});

/**
 * 派生文件的重建串行,而且在轮到自己写的时候重新读库。守的仍是整份 spec 最要紧的那条不变量:
 * 面板选得出的,Reviewer 子进程必须取得到。
 *
 * 并发写入是这条不变量唯一真会断的地方:每个写端点原先先在自己那一次 `withStore` 里截一份
 * 快照,再 `await` 一次撞名探测,最后拿手上这份快照整份重写派生文件。两个请求按 A、B 落库
 * 却按 B、A 写文件时,A 那份旧快照把 B 的结果整份盖掉——两边都回 2xx,而库与派生文件从此
 * 对不上,直到下一次重建或者重启。
 *
 * 这一对请求把那个交错钉成确定的:删掉最后一家自定义 provider 的那个请求手上的登记集合是空
 * 的,撞名探测于是一个运行时都不必建、当场返回(`conflictingProviderNames` 的空集短路),而
 * 并发的那个删行请求手上还有这一家,它要真去建一份运行时。于是先落库的那个请求最后写文件,
 * 写回去的正是它那份还带着这一家的旧快照。
 *
 * 判据是「库与派生文件一致」,不是「端点回了 2xx」。
 */
test("并发的两次写入之后,派生文件与库一致(旧快照不会把删掉的写回去)", async () => {
  const h = await startPanelHarness(cleanups);
  const gateway = { ...CUSTOM, name: "concurrent-gateway", model: "concurrent-qwen3-max" };
  assert.equal(await catalogProvider(h, gateway.name), undefined, "这个名字已经在目录里了");
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0007" }))
      .status,
    200,
  );
  assert.equal((await h.api("POST", "/custom-providers", gateway)).status, 200);
  const model = "multireviewer/concurrent-row";
  assert.equal(
    (await h.api("POST", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    200,
  );

  const [dropRow, dropProvider] = await Promise.all([
    h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model }),
    h.api("DELETE", `/custom-providers/${gateway.name}`),
  ]);
  assert.equal(dropRow.status, 204);
  assert.equal(dropProvider.status, 204, await dropProvider.text());

  // 库里两样都没了:两个请求各自都真删了。
  const providers = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(providers.providers, []);
  const rows = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(rows.rows, []);

  // 派生文件必须跟着库:这一家与那一行在模型目录里都不该再出现。
  assert.equal(
    await catalogProvider(h, gateway.name),
    undefined,
    "库里删掉的那一家被另一个请求的旧快照写回了派生文件",
  );
  assert.equal(
    (await catalogModels(h, HAND_FILL_PROVIDER)).some((entry) => entry["id"] === model),
    false,
    "库里删掉的那一行还在派生文件里",
  );
});

/**
 * 删除的路由收任何合法形状的名字,而那个字符集就是内置 provider id 的字符集——`DELETE
 * <前缀>/api/custom-providers/openai` 是一句发得出去的请求,哪怕从来没有人登记过叫 `openai`
 * 的自定义 provider。级联因此必须先确认登记存在(`model_row` 与 `model_credential` 两张表都以
 * provider 名为键):不确认的话这一句会把内置那一家的模型凭据与它名下的手填模型行一起永久
 * 删掉,而凭据只写不回显,删了只能重新去厂商后台取一把。
 *
 * 端点仍回 204:不存在就静默通过,与 `DELETE /credentials/<provider>`、摘 Key 那两处同一档
 * ——目标状态已达成。
 */
test("删一个没登记过的名字:内置那一家的凭据与手填行一条不少,端点回 204", async () => {
  const h = await startPanelHarness(cleanups);
  const model = "multireviewer/keepsake";
  assert.equal(
    (await h.api("PUT", `/credentials/${HAND_FILL_PROVIDER}`, { apiKey: "sk-groq-rows-0008" }))
      .status,
    200,
  );
  assert.equal(
    (await h.api("POST", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    200,
  );
  // 这个名字是内置的那一家,没有任何一条自定义 provider 的登记。
  const registered = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(registered.providers, []);

  assert.equal((await h.api("DELETE", `/custom-providers/${HAND_FILL_PROVIDER}`)).status, 204);

  const rows = (await (await h.api("GET", "/model-rows")).json()) as { rows: ModelRow[] };
  assert.deepEqual(
    rows.rows.map((row) => `${row.provider}:${row.model}`),
    [`${HAND_FILL_PROVIDER}:${model}`],
    "内置那一家的手填模型行被这一句删掉了",
  );
  const credentials = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: { provider: string; configured: boolean; last4: string }[];
  };
  const credential = credentials.credentials.find((row) => row.provider === HAND_FILL_PROVIDER);
  assert.ok(credential !== undefined, "内置那一家的模型凭据被这一句删掉了");
  assert.equal(credential.configured, true);
  assert.equal(credential.last4, "0008");
  // 派生文件跟着库:那一行照样在模型目录里。
  assert.ok(
    (await catalogModels(h, HAND_FILL_PROVIDER)).some((entry) => entry["id"] === model),
    "那一行从模型目录里消失了",
  );

  assert.equal(
    (await h.api("DELETE", "/model-rows", { provider: HAND_FILL_PROVIDER, model })).status,
    204,
  );
});

/**
 * 名字有长度上限。判据在删除那一头:名字要整个放进 `DELETE <前缀>/api/custom-providers/<名字>`
 * 的路径里,而请求行过大是在路由之前被拒的(Node 默认 16 KiB、nginx 默认 8 KiB),超长的名字
 * 于是登得进去删不出来。上限是 64,登记的校验与删除的路由用的是同一个判据,所以这一条同时钉
 * 住两头:恰好 64 的名字加得进也删得掉,65 个字符加不进、也匹配不上删除的路由。
 */
test("自定义 provider 的名字超过 64 个字符时拒收,恰好 64 的加得进也删得掉", async () => {
  const h = await startPanelHarness(cleanups);
  const tooLong = "a".repeat(65);
  const atLimit = "b".repeat(64);

  const rejected = await h.api("POST", "/custom-providers", { ...CUSTOM, name: tooLong });
  assert.equal(rejected.status, 400);
  const rejectedBody = (await rejected.json()) as { error: string };
  assert.match(rejectedBody.error, /1 到 64 个字符/);
  // 拒收了就没落库,目录里也没有这一家。
  const listed = (await (await h.api("GET", "/custom-providers")).json()) as {
    providers: CustomProvider[];
  };
  assert.deepEqual(listed.providers, []);
  // 超上限的名字连删除的路由都匹配不上:回的是认证之后的 JSON 404。
  assert.equal((await h.api("DELETE", `/custom-providers/${tooLong}`)).status, 404);

  // 恰好在上限上的名字照收,而且删得掉——两头是同一个判据。
  const added = await h.api("POST", "/custom-providers", {
    ...CUSTOM,
    name: atLimit,
    model: "at-limit-model",
  });
  assert.equal(added.status, 200, await added.text());
  assert.ok(await catalogProvider(h, atLimit), "恰好 64 的那一家没进模型目录");
  assert.equal((await h.api("DELETE", `/custom-providers/${atLimit}`)).status, 204);
  assert.equal(await catalogProvider(h, atLimit), undefined, "删掉之后这一家还在目录里");
});
