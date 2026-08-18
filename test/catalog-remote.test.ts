/**
 * 模型目录的两层增量:pi.dev 的**远程目录**,与它之后那一步的**厂商目录**。
 *
 * 远程那一层三档行为:可用时模型多于内置、拿不到时降级到内置且端点照常 200、按
 * `PI_OFFLINE` 关掉时一个外部请求都不发。厂商那一层同样三档,另加只补缺、已有行不动,
 * 以及两层的成败彼此不绑死。
 *
 * 全程打桩 `globalThis.fetch`,测试不打 pi.dev 也不打 openrouter.ai:真发请求的话结果
 * 随外网与那边的目录版本变,断言也就不再是判据。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  type Catalog,
  type CatalogModel,
  invalidateModelCatalog,
  loadFromPi,
} from "../src/reviewer/catalog.ts";
import type { SharedModelPaths } from "../src/reviewer/model-runtime.ts";
import { startPanelHarness } from "./support/panel-harness.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 每个用例一份空的共用文件位置:上一条留下的 `models-store.json` 不得成为下一条的输入,
 * 派生的 `models.json` 同理——两份都要与本机上真实的缓存目录隔开。
 */
function paths(): SharedModelPaths {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-catalog-store-"));
  dirs.push(dir);
  return { store: join(dir, "models-store.json"), config: join(dir, "models.json") };
}

process.env["MULTIREVIEWER_CACHE_DIR"] = mkdtempSync(join(tmpdir(), "multireviewer-cache-"));

/** 内置目录的时间戳之后:早于它的远程目录会被 Pi 当作过期直接丢掉。 */
const FUTURE = new Date(Date.UTC(2999, 0, 1)).toUTCString();

type Stub = { calls: string[]; restore: () => void };

/**
 * 厂商目录那一次请求的应答。拿得到 `init` 才能测超时:桩挂住不回,等 `signal` 中止。
 */
type VendorRespond = (init: RequestInit | undefined) => Response | Promise<Response>;

/** 默认这一家没拉到:只关心远程那一层的用例不必各写一遍。 */
const VENDOR_UNREACHABLE: VendorRespond = () => {
  throw new Error("厂商目录拉不到");
};

/**
 * 拦下所有发往 pi.dev 与 openrouter.ai 的目录请求。`respond` 回 undefined 表示这一家
 * 远程目录拉失败。打到本机的请求直通:面板 harness 自己的 HTTP 缝也走 fetch。
 */
function stubCatalog(
  respond: (providerId: string) => unknown,
  vendor: VendorRespond = VENDOR_UNREACHABLE,
): Stub {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return original(input as Parameters<typeof original>[0], init);
    }
    calls.push(url.toString());
    if (url.hostname === "openrouter.ai") return vendor(init);
    const providerId = decodeURIComponent(url.pathname.replace("/api/models/providers/", ""));
    const body = respond(providerId);
    if (body === undefined) throw new Error(`目录拉不到:${providerId}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "last-modified": FUTURE },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** 远程目录给每家补一行,与厂商目录补的那一行区分得开。 */
function remoteRow(providerId: string): unknown {
  return {
    models: [
      {
        id: `${providerId}-remote-only`,
        name: "远程新增",
        contextWindow: 1234,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

/** 只在厂商目录里的那一行。 */
const VENDOR_ONLY = "multireviewer/vendor-only";

/**
 * 一条 OpenRouter 现货。字段名与官网一致,实测形状见
 * `docs/research/vendor-model-catalog-apis.md`。
 */
function vendorRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `厂商目录的 ${id}`,
    context_length: 128_000,
    architecture: { input_modalities: ["text"] },
    // 官网的单价是「每 token 多少美元」的字符串,目录里那一份是每百万 token。
    pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000005" },
    top_provider: { context_length: 128_000, max_completion_tokens: 4096 },
    supported_parameters: ["tools"],
    ...over,
  };
}

/** 厂商目录拉得到,给出这几行。 */
function vendorOk(rows: Record<string, unknown>[]): VendorRespond {
  return () =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** 厂商目录补的是 OpenRouter 那一家,几乎每条断言都落在它的模型列表上。 */
function openrouterModels(catalog: Catalog): CatalogModel[] {
  const provider = catalog.providers.find((entry) => entry.id === "openrouter");
  assert.ok(provider !== undefined, "目录里没有 openrouter");
  return provider.models;
}

/** 只有远程目录、厂商目录没拉到的那一份,当补之前的判据。 */
async function withoutVendor(): Promise<Catalog> {
  const stub = stubCatalog(remoteRow);
  try {
    return await loadFromPi({ allowNetwork: true, paths: paths() });
  } finally {
    stub.restore();
  }
}

function modelCount(providers: { models: unknown[] }[]): number {
  return providers.reduce((total, provider) => total + provider.models.length, 0);
}

test("远程目录可用时,模型比内置那一份多", async () => {
  const builtin = await loadFromPi({ allowNetwork: false, paths: paths() });
  assert.equal(builtin.remote, "off");

  const stub = stubCatalog((providerId) => ({
    models: [
      {
        id: `${providerId}-remote-only`,
        name: "远程新增",
        contextWindow: 1234,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }));
  try {
    const remote = await loadFromPi({ allowNetwork: true, paths: paths() });
    assert.equal(remote.remote, "ok");
    assert.ok(
      modelCount(remote.providers) > modelCount(builtin.providers),
      "开了远程之后模型没有变多",
    );
    assert.ok(stub.calls.length > 0, "一个远程请求都没发");
  } finally {
    stub.restore();
  }
});

test("远程拿不到时降级到内置目录,端点照常 200 并标 unavailable", async () => {
  const stub = stubCatalog(() => undefined);
  try {
    const cleanups: (() => void)[] = [];
    const h = await startPanelHarness(cleanups);
    try {
      const res = await h.api("GET", "/catalog");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        remote: string;
        providers: { models: unknown[] }[];
      };
      assert.equal(body.remote, "unavailable");
      assert.ok(body.providers.length > 0, "降级之后一个 provider 都没有");
      assert.ok(modelCount(body.providers) > 0, "降级之后一个模型都没有");
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  } finally {
    stub.restore();
  }
});

test("PI_OFFLINE 关掉远程目录,一个外部请求都不发", async () => {
  const stub = stubCatalog(() => ({ models: [] }));
  process.env["PI_OFFLINE"] = "1";
  try {
    const catalog = await loadFromPi({ paths: paths() });
    assert.equal(catalog.remote, "off");
    assert.deepEqual(stub.calls, []);
    assert.ok(modelCount(catalog.providers) > 0, "关掉远程之后目录空了");
  } finally {
    delete process.env["PI_OFFLINE"];
    stub.restore();
  }
});

test("厂商目录拉得到时,OpenRouter 的模型比只有远程目录时多", async () => {
  const before = await withoutVendor();
  assert.equal(before.vendors["openrouter"], "unavailable");

  const stub = stubCatalog(remoteRow, vendorOk([vendorRow(VENDOR_ONLY)]));
  try {
    const after = await loadFromPi({ allowNetwork: true, paths: paths() });
    assert.equal(after.vendors["openrouter"], "ok");
    assert.ok(
      openrouterModels(after).length > openrouterModels(before).length,
      "接上厂商目录之后 OpenRouter 的模型没有变多",
    );
    // 单价换算差 10^6 的话成本会小六个数量级,统计上等于这一行没花钱。
    assert.deepEqual(
      openrouterModels(after).find((model) => model.id === VENDOR_ONLY),
      {
        id: VENDOR_ONLY,
        name: `厂商目录的 ${VENDOR_ONLY}`,
        contextWindow: 128_000,
        cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
      },
      "补进来的那一行不是按官网字段换算出来的",
    );
  } finally {
    stub.restore();
  }
});

test("撞上的模型标识整行保留,Pi 独有的 auto 仍在", async () => {
  const before = await withoutVendor();
  const builtinRow = openrouterModels(before)[0];
  assert.ok(builtinRow !== undefined, "内置目录里一个 OpenRouter 模型都没有");
  const remoteOnlyRow = openrouterModels(before).find(
    (model) => model.id === "openrouter-remote-only",
  );
  assert.ok(remoteOnlyRow !== undefined, "远程目录那一行没进目录");

  // 厂商目录用同样的 id 报了另一套名字与单价:已有那两行必须一字不动。
  const stub = stubCatalog(
    remoteRow,
    vendorOk([
      vendorRow(builtinRow.id, { name: "厂商目录改名", pricing: { prompt: "9", completion: "9" } }),
      vendorRow(remoteOnlyRow.id, {
        name: "厂商目录改名",
        pricing: { prompt: "9", completion: "9" },
      }),
      vendorRow(VENDOR_ONLY),
    ]),
  );
  try {
    const after = await loadFromPi({ allowNetwork: true, paths: paths() });
    const models = openrouterModels(after);
    assert.deepEqual(
      models.find((model) => model.id === builtinRow.id),
      builtinRow,
      "内置那一行被厂商目录改了",
    );
    assert.deepEqual(
      models.find((model) => model.id === remoteOnlyRow.id),
      remoteOnlyRow,
      "远程目录那一行被厂商目录改了",
    );
    assert.ok(
      models.some((model) => model.id === "auto"),
      "Pi 独有的 auto 丢了",
    );
    assert.ok(
      models.some((model) => model.id === VENDOR_ONLY),
      "只补缺这一步把该补的也漏了",
    );
  } finally {
    stub.restore();
  }
});

test("其他 provider 的列表一字不变", async () => {
  const before = await withoutVendor();
  const stub = stubCatalog(remoteRow, vendorOk([vendorRow(VENDOR_ONLY)]));
  try {
    const after = await loadFromPi({ allowNetwork: true, paths: paths() });
    assert.deepEqual(
      after.providers.find((provider) => provider.id === "deepseek"),
      before.providers.find((provider) => provider.id === "deepseek"),
      "厂商目录动了 deepseek 那一家",
    );
    assert.deepEqual(after.vendors, { openrouter: "ok" }, "厂商层状态多报了别家");
  } finally {
    stub.restore();
  }
});

test("厂商目录回非 2xx 时端点照常 200,列表退回 Pi 那一份并标 unavailable", async () => {
  // 正文是一份像模像样的目录,只有状态码不对:这样这一条测的就只是「非 2xx 算没拉到」。
  const stub = stubCatalog(
    remoteRow,
    () =>
      new Response(JSON.stringify({ data: [vendorRow(VENDOR_ONLY)] }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );
  invalidateModelCatalog();
  try {
    const cleanups: (() => void)[] = [];
    const h = await startPanelHarness(cleanups);
    try {
      const res = await h.api("GET", "/catalog");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        vendors: Record<string, string>;
        providers: { id: string; models: { id: string }[] }[];
      };
      assert.equal(body.vendors["openrouter"], "unavailable");
      const openrouter = body.providers.find((provider) => provider.id === "openrouter");
      assert.ok(openrouter !== undefined && openrouter.models.length > 0, "OpenRouter 那一家空了");
      assert.ok(
        !openrouter.models.some((model) => model.id === VENDOR_ONLY),
        "厂商目录没拉到却补了行",
      );
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  } finally {
    invalidateModelCatalog();
    stub.restore();
  }
});

// 桩挂住不回、只等 `signal`,请求不带超时的话这条会一直挂着:给它一个用例级上限,
// 让「忘了带超时」表现成失败而不是卡死。
test("厂商目录超时算没拉到", { timeout: 15_000 }, async () => {
  const stub = stubCatalog(
    remoteRow,
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      }),
  );
  try {
    const catalog = await loadFromPi({ allowNetwork: true, paths: paths(), timeoutMs: 500 });
    assert.equal(catalog.vendors["openrouter"], "unavailable");
    assert.ok(openrouterModels(catalog).length > 0, "降级之后 OpenRouter 那一家空了");
  } finally {
    stub.restore();
  }
});

test("响应不像目录时算没拉到", async () => {
  const stub = stubCatalog(
    remoteRow,
    () =>
      new Response(JSON.stringify({ data: "不是清单" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const catalog = await loadFromPi({ allowNetwork: true, paths: paths() });
    assert.equal(catalog.vendors["openrouter"], "unavailable");
    assert.ok(openrouterModels(catalog).length > 0, "降级之后 OpenRouter 那一家空了");
  } finally {
    stub.restore();
  }
});

test("PI_OFFLINE 把厂商目录也关掉,一个厂商请求都不发", async () => {
  const stub = stubCatalog(remoteRow, vendorOk([vendorRow(VENDOR_ONLY)]));
  process.env["PI_OFFLINE"] = "1";
  try {
    const catalog = await loadFromPi({ paths: paths() });
    assert.equal(catalog.remote, "off");
    assert.equal(catalog.vendors["openrouter"], "off");
    assert.deepEqual(stub.calls, [], "关掉之后还发了请求");
    assert.ok(
      !openrouterModels(catalog).some((model) => model.id === VENDOR_ONLY),
      "关掉之后还补了行",
    );
  } finally {
    delete process.env["PI_OFFLINE"];
    stub.restore();
  }
});

test("远程目录拉不到不妨碍厂商目录补缺", async () => {
  const stub = stubCatalog(() => undefined, vendorOk([vendorRow(VENDOR_ONLY)]));
  try {
    const catalog = await loadFromPi({ allowNetwork: true, paths: paths() });
    assert.equal(catalog.remote, "unavailable");
    assert.equal(catalog.vendors["openrouter"], "ok");
    assert.ok(
      openrouterModels(catalog).some((model) => model.id === VENDOR_ONLY),
      "远程没拉到时厂商目录跟着停了",
    );
  } finally {
    stub.restore();
  }
});

/** 落盘里一家 provider 的那些 model id,按文件里的顺序。 */
function storeModelIds(storePath: string, providerId: string): string[] {
  const store = JSON.parse(readFileSync(storePath, "utf8")) as Record<
    string,
    { models?: { id: string }[] } | undefined
  >;
  return (store[providerId]?.models ?? []).map((model) => model.id);
}

/**
 * 目录加载串行(`catalog.ts` 的 `loadFromPi`)。厂商目录那一步整份读进来、改一家、整份写回
 * 共用落盘,两份加载同时在飞时后写的那一份会把先写的整批账抹掉。
 *
 * 判据是「第一份走完之前第二份一个请求都不发」:把第一份挂在厂商目录那一次请求上不放,再给
 * 一段足够长的窗口,断言这期间 pi.dev 那一家只被问过一次、厂商目录也只被问过一次。不串行的
 * 话第二份此刻正自己建运行时、自己刷远程目录,两个计数都会翻倍。
 *
 * 放开之后再看两件事:第二份建运行时时第一份的写入已经落完(那一行从落盘恢复得到),而落盘
 * 里那一行只有一份。
 */
test("两份目录加载同时在飞时串行,第二份等第一份走完", async () => {
  const shared = paths();
  const firstVendorEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  let vendorCalls = 0;
  const stub = stubCatalog(remoteRow, async (init) => {
    vendorCalls += 1;
    if (vendorCalls > 1) throw new Error("厂商目录拉不到");
    firstVendorEntered.resolve();
    await release.promise;
    return vendorOk([vendorRow(VENDOR_ONLY)])(init);
  });
  try {
    const loads = Promise.all([
      loadFromPi({ allowNetwork: true, paths: shared }),
      loadFromPi({ allowNetwork: true, paths: shared }),
    ]);
    await firstVendorEntered.promise;
    // 这一档要断言的是「第二份什么都没做」,而「没做」等不出信号来,只能给它一段真实的窗口。
    // 100 毫秒:不串行的话第二份这段时间足够把 39 家 pi.dev 全问一遍(整份加载实测 50-100 毫秒)。
    await delay(100);
    assert.deepEqual(
      stub.calls.filter((url) => url.endsWith("/api/models/providers/openrouter")),
      ["https://pi.dev/api/models/providers/openrouter"],
      "第一份还挂在厂商目录上,第二份就已经在拉远程目录了",
    );
    assert.equal(vendorCalls, 1, "第一份还挂在厂商目录上,第二份就已经在问厂商目录了");

    release.resolve();
    const [first, second] = await loads;
    assert.equal(first.vendors["openrouter"], "ok");
    assert.equal(second.vendors["openrouter"], "unavailable");
    assert.ok(
      openrouterModels(second).some((model) => model.id === VENDOR_ONLY),
      "后一份目录看不见前一份补进落盘的那一行",
    );
    assert.deepEqual(
      storeModelIds(shared.store, "openrouter").filter((id) => id === VENDOR_ONLY),
      [VENDOR_ONLY],
      "落盘里那一行丢了,或者写了两遍",
    );
  } finally {
    release.resolve();
    stub.restore();
  }
});

/**
 * 落盘里已经有该 id、而运行时的目录看不见它:Pi 判过期看 store 的 `lastModified` 与内置表的
 * 生成时间,早于内置表的整条都不恢复进内存(`dist/core/remote-catalog-provider.js` 的
 * `remoteModels`)。Pi 升一版内置表的生成时间就可能新过它,pi.dev 回 404 时 Pi 自己把这一位
 * 压成 0 也落到这一档。盲追加于是让同一个 id 在落盘里出现两次,而且每读一次目录再多一份。
 */
test("落盘里已有该 id 而运行时看不见它时,补进来的行不重复", async () => {
  const shared = paths();
  const stub = stubCatalog(remoteRow, vendorOk([vendorRow(VENDOR_ONLY)]));
  try {
    await loadFromPi({ allowNetwork: true, paths: shared });
    assert.deepEqual(
      storeModelIds(shared.store, "openrouter").filter((id) => id === VENDOR_ONLY),
      [VENDOR_ONLY],
      "第一次补就写重了",
    );

    // 造前提:把 `lastModified` 压到内置表之前,`checkedAt` 一动不动——4 小时刷新窗还没过,
    // pi.dev 那一家因此不重拉,这一条也就不依赖两层之间的时序。
    const store = JSON.parse(readFileSync(shared.store, "utf8")) as Record<
      string,
      { lastModified?: number } | undefined
    >;
    const entry = store["openrouter"];
    assert.ok(entry !== undefined, "落盘里没有 openrouter 那一条");
    entry.lastModified = 1;
    writeFileSync(shared.store, JSON.stringify(store, null, 2));

    await loadFromPi({ allowNetwork: true, paths: shared });
    const ids = storeModelIds(shared.store, "openrouter");
    assert.deepEqual([...new Set(ids)], ids, "落盘里出现了重复的 model id");
    assert.ok(ids.includes(VENDOR_ONLY), "补进来的那一行不见了");
  } finally {
    stub.restore();
  }
});

/**
 * 厂商下线一个模型之后,上一轮补进去的那一行要跟着消失(ADR 0009)。
 *
 * 不能等远程那一层顺带冲掉:Pi 对 pi.dev 每家有 4 小时刷新窗,窗内既不重拉也不动 store 那
 * 一条,窗过了且拉成功时才用只含远程行的新对象把整条换掉。已下线的那一行因此至少要在落盘与
 * 选择器里躺满一个刷新窗,而 pi.dev 那一家持续拉不到时(非 2xx 那条路把 `checkedAt` 往前推、
 * `models` 原样留着)就永远躺着。
 */
test("厂商目录下线一个模型之后,落盘与目录里那一行跟着消失", async () => {
  const shared = paths();
  const delisted = "multireviewer/vendor-delisted";
  let rows = [vendorRow(VENDOR_ONLY), vendorRow(delisted)];
  const stub = stubCatalog(remoteRow, (init) => vendorOk(rows)(init));
  try {
    const before = await loadFromPi({ allowNetwork: true, paths: shared });
    assert.ok(
      openrouterModels(before).some((model) => model.id === delisted),
      "第一轮就没补上那一行,这条断言失去意义",
    );

    rows = [vendorRow(VENDOR_ONLY)];
    const after = await loadFromPi({ allowNetwork: true, paths: shared });
    assert.equal(after.vendors["openrouter"], "ok");
    assert.ok(
      !openrouterModels(after).some((model) => model.id === delisted),
      "厂商下线的模型还列在目录里",
    );

    const ids = storeModelIds(shared.store, "openrouter");
    assert.ok(!ids.includes(delisted), "厂商下线的模型还在落盘里");
    assert.ok(ids.includes(VENDOR_ONLY), "还在的那一行被一起摘掉了");
    // 摘的只是厂商目录自己补的那批,远程目录那一层的账一行不动。
    assert.ok(ids.includes("openrouter-remote-only"), "远程目录那一行被摘掉了");
  } finally {
    stub.restore();
  }
});

/**
 * 升级前那份落盘里没有记号(`multireviewerVendorModels` 这一票才加),而厂商目录仍然列着那个
 * id:旧那一行因此不在「上一轮那批」里,拿它当已有的话这一票之前留下的重复行会永远留在文件
 * 里。写进来的这一批一律先按 id 把旧的摘掉,同一个 id 于是只剩一份。
 *
 * 前提照旧用 `lastModified` 造:压到内置表之前 Pi 就不把这一条恢复进内存(那正是重复行当初
 * 出现的成因),`checkedAt` 留在刷新窗内、pi.dev 那一家因此不重拉。
 */
test("升级前那份落盘里已有该 id 却没有记号时,补进来的行不重复", async () => {
  const shared = paths();
  writeFileSync(
    shared.store,
    JSON.stringify({
      openrouter: {
        models: [
          {
            id: VENDOR_ONLY,
            provider: "openrouter",
            name: "升级前那一行",
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            contextWindow: 4321,
            maxTokens: 1000,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            input: ["text"],
            reasoning: false,
          },
        ],
        checkedAt: Date.now(),
        lastModified: 1,
      },
    }),
  );

  const stub = stubCatalog(remoteRow, vendorOk([vendorRow(VENDOR_ONLY)]));
  try {
    const catalog = await loadFromPi({ allowNetwork: true, paths: shared });
    assert.equal(catalog.vendors["openrouter"], "ok");
    assert.deepEqual(
      storeModelIds(shared.store, "openrouter").filter((id) => id === VENDOR_ONLY),
      [VENDOR_ONLY],
      "升级前那一行与这一轮补的行在落盘里并存",
    );
  } finally {
    stub.restore();
  }
});

// 实测发现于部署实例:OpenRouter 给路由类模型(`openrouter/auto` 那几个)的单价是字符串
// "-1",意思是「随路由到的那个模型浮动」。按每百万 token 换算就成了 -1000000,面板上写作
// `$-1000000/M`,而 Review Run 的成本会因此算成负数、把累计花费往下拽。
test("单价是负数的现货按没有单价收,不落成负的费率", async () => {
  const stub = stubCatalog(
    remoteRow,
    vendorOk([vendorRow(VENDOR_ONLY, { pricing: { prompt: "-1", completion: "-1" } })]),
  );
  try {
    const catalog = await loadFromPi({ allowNetwork: true, paths: paths() });
    const row = openrouterModels(catalog).find((model) => model.id === VENDOR_ONLY);
    assert.ok(row !== undefined, "厂商目录那一行没进目录");
    assert.deepEqual(
      { input: row.cost.input, output: row.cost.output },
      { input: 0, output: 0 },
      "浮动单价被当成真实费率算了",
    );
  } finally {
    stub.restore();
  }
});
