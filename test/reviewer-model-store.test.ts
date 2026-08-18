/**
 * 面板与 Reviewer 子进程共用的两份 Pi 模型文件:pi.dev 增量的落盘 `models-store.json`,
 * 与由库里的模型行派生出的 `models.json`。
 *
 * 这一档守四件事:面板落盘的东西子进程读得到、文件不在时子进程仍拿到 Pi 内置的那一份、
 * 子进程一个对外目录请求都不发、凭据那一份仍各自私有不共用(ADR 0004)。落盘内容用预置
 * 文件喂进来,测试不打 pi.dev:真发请求的话模型数随外网与那边的目录版本变,断言也就不
 * 再是判据。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { after, test } from "node:test";

import { loadFromPi } from "../src/reviewer/catalog.ts";
import { PI_AGENT_DIR_ENV } from "../src/reviewer/env.ts";
import {
  CACHE_DIR_ENV,
  cacheRoot,
  isolatedModelRuntime,
  missingModelHint,
  sharedModelPaths,
  writeSharedModelsConfig,
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

/** overlay 与手填行都只加在 Pi 内置就有的 provider 上:两份文件都按 provider 标识分条。 */
const PROVIDER = "openrouter";
const OVERLAY_MODEL = "multireviewer-overlay-only";
/** 只在派生的 `models.json` 里的那一行,用来分辨读的是哪一份文件。 */
const CONFIG_MODEL = "multireviewer-config-only";
/** 预置在「宿主机」默认凭据位置的那一家。子进程读到它即凭据分割失效。 */
const HOST_PROVIDER = "multireviewer-host-only-vendor";
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

/**
 * 往共用的 `models.json` 里塞一行。给已有 provider 加行时 `api` 与 `baseUrl` 从该家的
 * 第一个模型继承,一个 id 就够。
 */
function writeConfigRow(configPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: { [PROVIDER]: { models: [{ id: CONFIG_MODEL, name: "手填的模型" }] } },
    }),
  );
}

test("两份共用文件都是绝对路径,落在同一个目录下", () => {
  cacheDir(false);
  const paths = sharedModelPaths();
  assert.ok(paths !== undefined, "缓存目录建得出来时不该退回私有目录");
  // 子进程的 cwd 是工作副本,相对路径会解析到别处。
  assert.ok(isAbsolute(paths.store) && isAbsolute(paths.config), "共用路径必须是绝对路径");
  assert.equal(dirname(paths.store), dirname(paths.config));
});

test("面板落盘的 overlay 子进程读得到,且一个对外请求都不发", async () => {
  cacheDir(true);
  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    assert.ok(
      runtime.getModel(PROVIDER, OVERLAY_MODEL),
      "只在 overlay 里的模型没有进到子进程的目录",
    );
    assert.deepEqual(stub.calls, [], "子进程发了对外目录请求");
  } finally {
    stub.restore();
  }
});

/**
 * 这一条是整票的目的:派生的 `models.json` 写一次,面板那侧与子进程那侧都要看见同一行。
 * 两侧任一处指回自己的临时目录,这一条就挂——那正是下一票要写模型行的前提。
 *
 * 两侧都按生产的取法拿路径(子进程调 `sharedModelPaths`,面板不传 `paths`),让「从环境
 * 变量推导」这一步也进断言:显式注两个同样的路径进去,默认推导退化成只认入参也测不出来。
 */
test("派生的 models.json 面板与子进程读的是同一份", async () => {
  cacheDir(false);
  writeConfigRow(sharedModelPaths()!.config);

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    assert.ok(runtime.getModel(PROVIDER, CONFIG_MODEL), "子进程没读到派生的 models.json");
    assert.deepEqual(stub.calls, [], "子进程发了对外目录请求");

    const catalog = await loadFromPi({ allowNetwork: false });
    const provider = catalog.providers.find((entry) => entry.id === PROVIDER);
    assert.ok(
      provider?.models.some((model) => model.id === CONFIG_MODEL),
      "面板侧的目录里没有派生的那一行",
    );
  } finally {
    stub.restore();
  }
});

/**
 * 凭据那一份是私有的另一半(ADR 0004)。
 *
 * 判据是「运行时看得见哪些凭据」,而不是共用目录里有没有 `auth.json`:后者挡不住真正要防
 * 的那条路——`authPath` 漏传时 Pi 转去读宿主机默认位置的 `auth.json`,共用目录照样干净,
 * 而面板与子进程已经在共读宿主机上配置过的每一家厂商的凭据。实测漏传时读到的正是本机
 * 那几条(anthropic / openai-codex / xai 的 oauth)。
 *
 * 默认位置用 `PI_CODING_AGENT_DIR` 挪到临时目录并预置一条,判据因此与跑测试的机器上有没有
 * 配过 Pi 无关,也一个字都不碰真实的 `~/.pi/agent`。
 */
test("共用的只有目录,凭据仍私有:宿主机上那份读不到", async () => {
  cacheDir(false);
  const fakeHome = tempDir("multireviewer-store-home-");
  writeFileSync(
    join(fakeHome, "auth.json"),
    JSON.stringify({ [HOST_PROVIDER]: { type: "api_key", key: "sk-host-only" } }),
  );
  const originalAgentDir = process.env[PI_AGENT_DIR_ENV];
  process.env[PI_AGENT_DIR_ENV] = fakeHome;

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    const seen = (await runtime.listCredentials()).map((entry) => entry.providerId);
    assert.ok(!seen.includes(HOST_PROVIDER), `读到了宿主机上的凭据: ${seen.join(", ")}`);
  } finally {
    stub.restore();
    if (originalAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
    else process.env[PI_AGENT_DIR_ENV] = originalAgentDir;
  }

  // 共用目录本身也不该冒出凭据文件。
  assert.ok(
    !existsSync(join(dirname(sharedModelPaths()!.config), "auth.json")),
    "凭据落进了共用目录",
  );
});

/**
 * 派生文件的真相源是库,文件是可重建的派生物:已有内容一律按当前状态重写,不做合并。
 * 这一票库里还没有模型行,写出来的因此是空集合。
 */
test("写派生文件是重写而不是合并,空集合不改变目录", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeConfigRow(paths.config);

  writeSharedModelsConfig(paths.config);
  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
    assert.equal(runtime.getModel(PROVIDER, CONFIG_MODEL), undefined, "重写没有清掉旧的那一行");
    // 空集合对目录不可见:内置那一份原样留着。
    assert.ok(runtime.getModels(PROVIDER).length > 0, "写空集合把内置目录也弄没了");
  } finally {
    stub.restore();
  }
});

test("两份文件都不在时子进程照常拿到 Pi 内置的那一份目录", async () => {
  cacheDir(false);
  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    // 拿不到 overlay 只是少掉那些模型,整轮审查不因此失败。
    assert.equal(runtime.getModel(PROVIDER, OVERLAY_MODEL), undefined);
    assert.ok(runtime.getModels(PROVIDER).length > 0, "内置目录也空了");
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

/**
 * 缓存目录建不出来时退回私有的临时目录:只失去共用,读目录本身不受影响。父目录是个文件,
 * `mkdirSync` 因此必然失败,而且与跑测试的用户是不是 root 无关。
 */
test("缓存目录建不出来时退回私有目录,读目录不受影响", async () => {
  const dir = tempDir("multireviewer-store-blocked-");
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "");
  process.env["MULTIREVIEWER_CACHE_DIR"] = blocker;
  assert.equal(sharedModelPaths(), undefined, "父目录是文件时还给出了共用路径");

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    assert.ok(runtime.getModels(PROVIDER).length > 0, "退回私有目录之后目录空了");
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

test("取不到模型时的失败措辞指向 store,有远程目录时不添噪", () => {
  cacheDir(false);
  const missing = sharedModelPaths()!.store;
  assert.match(missingModelHint(missing), /一条远程目录都没有/);
  assert.ok(missingModelHint(missing).includes(missing), "提示里没有 store 的位置");
  // 目录建不出来时同样要有措辞,而不是一句空话。
  assert.match(missingModelHint(undefined), /一条远程目录都没有/);

  cacheDir(true);
  assert.equal(missingModelHint(sharedModelPaths()!.store), "");
});

/**
 * 共用的前提是两侧算出同一个绝对路径,而 Reviewer 子进程的 `cwd` 是工作副本
 * (`pi-reviewer.ts`)。缓存根的默认值是相对路径,直接交给两侧各自解析就会指到两个地方去,
 * 共用当场落空——`pnpm start` 这条不设 `MULTIREVIEWER_CACHE_DIR` 的部署正是这一档。
 *
 * 收口的办法是父进程解析一次绝对值再传进子进程的环境,这里连着两头一起断言:相对值确实
 * 随 cwd 变(危害成立),而父进程定死之后换 cwd 也不再变(收口有效)。
 */
test("缓存根在父进程里定死,换 cwd 不再改变共用位置", () => {
  const origin = process.cwd();
  const here = tempDir("multireviewer-store-cwd-a-");
  const elsewhere = tempDir("multireviewer-store-cwd-b-");
  try {
    // 相对值:两侧各自解析,结果不同。这就是要收口的那一档。
    delete process.env[CACHE_DIR_ENV];
    process.chdir(here);
    const fromHere = cacheRoot();
    process.chdir(elsewhere);
    assert.notEqual(cacheRoot(), fromHere, "相对缓存根竟然不随 cwd 变,这条断言失去意义");

    // 父进程定死成绝对值之后,子进程换到工作副本也算出同一个位置。
    process.chdir(here);
    process.env[CACHE_DIR_ENV] = cacheRoot();
    const parent = sharedModelPaths()!;
    process.chdir(elsewhere);
    assert.deepEqual(sharedModelPaths(), parent, "子进程的 cwd 下算出了另一个共用位置");
  } finally {
    process.chdir(origin);
  }
});
