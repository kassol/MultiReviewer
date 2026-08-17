/**
 * 面板与 Reviewer 子进程共用的 pi.dev 目录 overlay(`models-store.json`)。
 *
 * 这一档守三件事:面板落盘的 overlay 子进程读得到、store 不在时子进程仍拿到 Pi 内置的
 * 那一份、子进程一个对外目录请求都不发。overlay 用预置的 store 文件喂进来,测试不打
 * pi.dev:真发请求的话模型数随外网与那边的目录版本变,断言也就不再是判据。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, test } from "node:test";

import {
  missingModelHint,
  modelsStorePath,
  reviewerModelRuntime,
} from "../src/reviewer/model-runtime.ts";
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

/** overlay 只加在 Pi 内置就有的 provider 上:store 按 provider 标识分条。 */
const PROVIDER = "openrouter";
const OVERLAY_MODEL = "multireviewer-overlay-only";

/**
 * Pi 判定 overlay 是否过期看 `lastModified` 与内置表的生成时间:早于内置表的 overlay
 * 会被整条丢掉。取一个远在未来的时间,断言才不随 Pi 升级而失效。
 */
const FUTURE_MS = Date.UTC(2999, 0, 1);

/** 换一个空的缓存根目录,并按 `write` 决定要不要预置一份带 overlay 的 store。 */
function cacheDir(write: boolean): void {
  const dir = tempDir("multireviewer-store-cache-");
  process.env["MULTIREVIEWER_CACHE_DIR"] = dir;
  if (!write) return;
  const storeDir = join(dir, "pi-models");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    join(storeDir, "models-store.json"),
    JSON.stringify({
      [PROVIDER]: {
        models: [
          {
            id: OVERLAY_MODEL,
            provider: PROVIDER,
            name: "只在远程目录里的模型",
            contextWindow: 4321,
            maxTokens: 1000,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            input: ["text"],
            reasoning: false,
          },
        ],
        checkedAt: FUTURE_MS,
        lastModified: FUTURE_MS,
      },
    }),
  );
}

test("面板落盘的 overlay 子进程读得到,且一个对外请求都不发", async () => {
  cacheDir(true);
  const storePath = modelsStorePath();
  assert.ok(storePath !== undefined && isAbsolute(storePath), "store 路径必须是绝对路径");

  // 子进程的 cwd 是工作副本,相对路径会解析到别处。
  const stub = stubFetch({});
  try {
    const runtime = await reviewerModelRuntime(tempDir("multireviewer-store-agent-"), storePath);
    assert.ok(
      runtime.getModel(PROVIDER, OVERLAY_MODEL),
      "只在 overlay 里的模型没有进到子进程的目录",
    );
    assert.deepEqual(stub.calls, [], "子进程发了对外目录请求");
  } finally {
    stub.restore();
  }
});

test("store 不在时子进程照常拿到 Pi 内置的那一份目录", async () => {
  cacheDir(false);
  const stub = stubFetch({});
  try {
    const runtime = await reviewerModelRuntime(
      tempDir("multireviewer-store-agent-"),
      modelsStorePath(),
    );
    // 拿不到 overlay 只是少掉那些模型,整轮审查不因此失败。
    assert.equal(runtime.getModel(PROVIDER, OVERLAY_MODEL), undefined);
    assert.ok(runtime.getModels(PROVIDER).length > 0, "内置目录也空了");
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

test("取不到模型时的失败措辞指向 store,有 overlay 时不添噪", () => {
  cacheDir(false);
  const missing = modelsStorePath()!;
  assert.match(missingModelHint(missing), /没有 overlay/);
  assert.ok(missingModelHint(missing).includes(missing), "提示里没有 store 的位置");
  // 目录建不出来时同样要有措辞,而不是一句空话。
  assert.match(missingModelHint(undefined), /没有 overlay/);

  cacheDir(true);
  assert.equal(missingModelHint(modelsStorePath()), "");
});
