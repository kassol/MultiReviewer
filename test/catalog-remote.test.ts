/**
 * pi.dev 的远程模型目录 overlay。三档行为:远程可用时模型多于内置、远程拿不到时降级
 * 到内置且端点照常 200、按 `PI_OFFLINE` 关掉时一个外部请求都不发。
 *
 * 全程打桩 `globalThis.fetch`,测试不打 pi.dev:真发请求的话结果随外网与那边的目录
 * 版本变,断言也就不再是判据。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadFromPi } from "../src/reviewer/catalog.ts";
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

/** 内置目录的时间戳之后:早于它的 overlay 会被 Pi 当作过期直接丢掉。 */
const FUTURE = new Date(Date.UTC(2999, 0, 1)).toUTCString();

type Stub = { calls: string[]; restore: () => void };

/**
 * 拦下所有发往 pi.dev 的目录请求。`respond` 回 undefined 表示这一家拉失败。
 * 打到本机的请求直通:面板 harness 自己的 HTTP 缝也走 fetch。
 */
function stubCatalog(respond: (providerId: string) => unknown): Stub {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return original(input as Parameters<typeof original>[0], init);
    }
    calls.push(url.toString());
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
