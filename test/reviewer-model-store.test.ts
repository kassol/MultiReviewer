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

import type { CustomProviderRecord, ModelRowRecord } from "../src/review/store.ts";
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

/** 远程目录与手填行都只加在 Pi 内置就有的 provider 上:两份文件都按 provider 标识分条。 */
const PROVIDER = "openrouter";
const REMOTE_MODEL = "multireviewer-remote-only";
/** 只在派生的 `models.json` 里的那一行,用来分辨读的是哪一份文件。 */
const CONFIG_MODEL = "multireviewer-config-only";
/** 预置在「宿主机」默认凭据位置的那一家。子进程读到它即凭据分割失效。 */
const HOST_PROVIDER = "multireviewer-host-only-vendor";
/**
 * Pi 判定落盘的远程目录是否过期看 `lastModified` 与内置表的生成时间:早于内置表的整条
 * 丢掉。取一个远在未来的时间,断言才不随 Pi 升级而失效。
 */
const FUTURE_MS = Date.UTC(2999, 0, 1);
/** 撞名的自定义 provider 一家都没有,落盘的常态(issue #94)。 */
const NO_CONFLICT: ReadonlySet<string> = new Set();

/** 换一个空的缓存根目录,并按 `write` 决定要不要预置一份带远程目录的 store。 */
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
            id: REMOTE_MODEL,
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

test("面板落盘的远程目录子进程读得到,且一个对外请求都不发", async () => {
  cacheDir(true);
  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    assert.ok(
      runtime.getModel(PROVIDER, REMOTE_MODEL),
      "只在落盘的远程目录里的模型没有进到子进程的目录",
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
 * 库里一行都没有时写出来的是空集合。
 */
test("写派生文件是重写而不是合并,空集合不改变目录", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeConfigRow(paths.config);

  writeSharedModelsConfig(paths.config, [], [], NO_CONFLICT);
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
    // 拿不到落盘的远程目录只是少掉那些模型,整轮审查不因此失败。
    assert.equal(runtime.getModel(PROVIDER, REMOTE_MODEL), undefined);
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

/** 手填的那一行。库里存的是它,派生的 `models.json` 从库重建出来。 */
const HAND_FILLED = "multireviewer-hand-filled";

/** 一条手填的模型行。三项可空的字段按入参给,其余照库里的形状。 */
function handFilled(fields: Partial<ModelRowRecord> = {}): ModelRowRecord {
  return {
    provider: PROVIDER,
    model: HAND_FILLED,
    costInput: null,
    costOutput: null,
    contextWindow: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    ...fields,
  };
}

/**
 * 整票最要紧的那条不变量的子进程那一半(issue #87):面板选得出的,Reviewer 子进程必须
 * 取得到。手填的行落成派生文件之后,不联网的运行时 `getModel` 要拿得到它,且一个对外
 * 请求都不发。
 *
 * 填过的单价与上下文窗口按库里的走;`api` 与 `baseUrl` 一个字都没写进文件,由 Pi 从该家
 * 第一个模型继承——手填一行最少只要一个 model id 就是靠这一层。
 */
test("手填的模型行落盘后子进程 getModel 取得到,且零对外请求", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeSharedModelsConfig(
    paths.config,
    [handFilled({ costInput: 3, costOutput: 4, contextWindow: 4321 })],
    [],
    NO_CONFLICT,
  );

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
    const model = runtime.getModel(PROVIDER, HAND_FILLED);
    assert.ok(model !== undefined, "手填的模型行没有进到子进程的目录");
    assert.equal(model.contextWindow, 4321);
    assert.equal(model.cost.input, 3);
    assert.equal(model.cost.output, 4);
    // 继承来的两项:与该家第一个模型逐字相同,文件里一个字都没写。
    const inherited = runtime.getModels(PROVIDER)[0]!;
    assert.equal(model.api, inherited.api);
    assert.equal(model.baseUrl, inherited.baseUrl);
    assert.deepEqual(stub.calls, [], "子进程发了对外目录请求");
  } finally {
    stub.restore();
  }
});

/**
 * upsert 语义:手填一行只是多一行,该家原有的每个模型对象一字不变。
 *
 * 判据打在运行时的模型对象上而不是目录端点上:端点只给 id / name / contextWindow / cost
 * 四项,而这一条要守的恰恰是端点看不见的 `api` 与 `baseUrl`——派生文件里只要在 provider
 * 一级多写一个 `baseUrl`,Pi 会把该家已有的每个模型原样保留、却全部改指那个新端点
 * (`applyModelsJson` 的第一步就是这个映射),已经选进模型组合的模型于是静悄悄换了厂商。
 */
test("手填一行只是多一行,该家原有的每个模型对象一字不变", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  const agentDir = tempDir("multireviewer-store-agent-");

  const stub = stubFetch({});
  try {
    writeSharedModelsConfig(paths.config, [], [], NO_CONFLICT);
    const before = (await isolatedModelRuntime(agentDir, paths)).getModels(PROVIDER);
    assert.ok(before.length > 0, "这一家一个模型都没有,这条断言失去意义");

    writeSharedModelsConfig(paths.config, [handFilled()], [], NO_CONFLICT);
    const after = (await isolatedModelRuntime(agentDir, paths)).getModels(PROVIDER);

    assert.deepEqual(
      after.filter((model) => !before.some((old) => old.id === model.id)).map((m) => m.id),
      [HAND_FILLED],
      "多出来的不止手填那一行",
    );
    for (const original of before) {
      assert.deepEqual(
        after.find((model) => model.id === original.id),
        original,
        `${original.id} 被手填那一行改动了`,
      );
    }
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

/**
 * 单价与上下文窗口留空即走 Pi 的默认值。默认值本身由 Pi 定,这里断言的是「留空不写」这个
 * 决定成立:写成 0 或者只写单价的一半都会让这一行连整份配置一起校验不过,而 Pi 把那类错误
 * 吞进 provider 的合成里,表象是这一行凭空消失。
 */
test("手填的模型行留空单价与上下文窗口时走 Pi 的默认值", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeSharedModelsConfig(paths.config, [handFilled()], [], NO_CONFLICT);

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
    const model = runtime.getModel(PROVIDER, HAND_FILLED);
    assert.ok(model !== undefined, "只填了 model id 的那一行取不到");
    assert.equal(model.contextWindow, 128_000);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

/**
 * 拦下发往 pi.dev 的远程目录请求,每家回一个只在远程有的模型。
 *
 * `stubFetch` 要为每个 key 预置响应,而这里要拦的是 39 家 provider 各一次,因此另写一个。
 * 打到本机的请求直通:同一个测试进程里还有别的真实服务在跑。
 */
function stubRemoteCatalog(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return original(input as Parameters<typeof original>[0], init);
    }
    calls.push(url.toString());
    const providerId = decodeURIComponent(url.pathname.replace("/api/models/providers/", ""));
    return new Response(
      JSON.stringify({
        models: [
          {
            id: `${providerId}-remote-only`,
            name: "只在远程目录里的模型",
            contextWindow: 1234,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
      {
        status: 200,
        // 早于内置表生成时间的远程目录会被 Pi 当作过期直接丢掉。
        headers: { "content-type": "application/json", "last-modified": new Date(FUTURE_MS).toUTCString() },
      },
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/**
 * 面板拉过一次远程目录之后手填的行仍在(issue #87 的最后一条验收)。
 *
 * 判据是两层各自独立:远程目录落 `models-store.json`,手填的行落 `models.json`,而 Pi 每次
 * `getModels()` 都把后者重新叠在前者之上(`provider-composer.ts` 的 `applyModelsJson` 叠在
 * `base.getModels()` 上),远程刷新换掉的只是里面那一层。两条入口共用同一个文件才会互相
 * 抹掉,那正是 issue #82 修正掉的前提。
 */
test("面板刷过一次远程目录之后,手填的模型行仍在", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeSharedModelsConfig(paths.config, [handFilled()], [], NO_CONFLICT);

  const stub = stubRemoteCatalog();
  try {
    const catalog = await loadFromPi({ allowNetwork: true, paths });
    assert.equal(catalog.remote, "ok");
    assert.ok(stub.calls.length > 0, "一个远程请求都没发,这一条没有测到刷新");
    const ids = catalog.providers.find((entry) => entry.id === PROVIDER)!.models.map((m) => m.id);
    assert.ok(ids.includes(`${PROVIDER}-remote-only`), "远程目录那一层没进来");
    assert.ok(ids.includes(HAND_FILLED), "刷过远程目录之后手填的模型行不见了");
  } finally {
    stub.restore();
  }

  // 刷新的结果落了盘,子进程那侧此刻同时看得见两层,而且照旧不联网。
  const offline = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
    assert.ok(runtime.getModel(PROVIDER, HAND_FILLED) !== undefined, "子进程取不到手填的行");
    assert.ok(
      runtime.getModel(PROVIDER, `${PROVIDER}-remote-only`) !== undefined,
      "子进程读不到落盘的远程目录",
    );
    assert.deepEqual(offline.calls, []);
  } finally {
    offline.restore();
  }
});

/**
 * 厂商目录补进来的行走的是远程目录那一份落盘(`models-store.json`),因此与远程目录的
 * 那些行同一条通路:面板那侧联网补上,不联网的 Reviewer 子进程必须取得到。这条不成立
 * 时,操作员在选择器里选得到的模型会在 Review Run 里报「模型不存在」。
 *
 * 断言落在模型对象的 `api` 与 `baseUrl` 上,不只看它取不取得到:这两项是子进程真正把请求
 * 发去哪里的依据,而目录端点上一项都看不见(端点只给 id / name / contextWindow / cost)。
 * 落盘那一行把它们写错时,操作员选中的模型会被发往错的端点,而「取得到」照旧成立。
 */
test("只在厂商目录里的模型,不联网的子进程也取得到", async () => {
  const vendorOnly = "multireviewer/vendor-catalog-only";
  cacheDir(false);

  // pi.dev 那几家一律没有预置响应、当作拉不到:这条只验厂商目录那一层。
  const online = stubFetch({
    "GET /api/v1/models": {
      body: {
        data: [
          {
            id: vendorOnly,
            name: "只在厂商目录里的模型",
            context_length: 128_000,
            architecture: { input_modalities: ["text"] },
            pricing: { prompt: "0.000002", completion: "0.000008" },
            top_provider: { context_length: 128_000, max_completion_tokens: 4096 },
            supported_parameters: ["tools"],
          },
        ],
      },
    },
  });
  try {
    const catalog = await loadFromPi({});
    assert.equal(catalog.vendors[PROVIDER], "ok");
  } finally {
    online.restore();
  }

  const offline = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(
      tempDir("multireviewer-store-agent-"),
      sharedModelPaths(),
    );
    const model = runtime.getModel(PROVIDER, vendorOnly);
    assert.ok(model, "只在厂商目录里的模型子进程取不到");
    assert.equal(model.api, "openai-completions", "补进来的那一行的接口协议不对");
    assert.equal(model.baseUrl, "https://openrouter.ai/api/v1", "补进来的那一行指向了别的端点");
    assert.deepEqual(offline.calls, [], "子进程发了对外目录请求");
  } finally {
    offline.restore();
  }
});

/** 自定义 provider 的那一家(issue #88)。Pi 内置目录里没有这个名字。 */
const CUSTOM_PROVIDER = "multireviewer-corp-gateway";
const CUSTOM_BASE_URL = "https://ai.corp.example/v1";
const CUSTOM_API = "openai-completions";
const CUSTOM_MODEL = "corp-qwen3-max";

/** 库里那一家自定义 provider 的定义。 */
function customProvider(fields: Partial<CustomProviderRecord> = {}): CustomProviderRecord {
  return {
    name: CUSTOM_PROVIDER,
    baseUrl: CUSTOM_BASE_URL,
    api: CUSTOM_API,
    createdAt: "2026-08-18T00:00:00.000Z",
    ...fields,
  };
}

/**
 * 自定义 provider 那条竖切最要紧的不变量(issue #88):面板选得出的,Reviewer 子进程必须
 * 取得到。这一家 Pi 内置目录里根本没有,`api` 与 `baseUrl` 因此继承不到任何东西,只能由
 * 派生文件在 provider 一级给出。
 *
 * 「取得到」不够:还要断言拿到的 `baseUrl` 真是填的那一个。落盘时把 `baseUrl` 写错位置
 * (例如漏掉 provider 一级、或者写进别的键)时,模型对象照样存在,只是指向另一个端点——
 * 那正是操作员完全看不出来的一档。
 */
test("自定义 provider 落盘后子进程 getModel 取得到,baseUrl 与 api 就是填的那两个", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeSharedModelsConfig(
    paths.config,
    [{ ...handFilled(), provider: CUSTOM_PROVIDER, model: CUSTOM_MODEL }],
    [customProvider()],
    NO_CONFLICT,
  );

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
    const model = runtime.getModel(CUSTOM_PROVIDER, CUSTOM_MODEL);
    assert.ok(model !== undefined, "自定义 provider 的模型没有进到子进程的目录");
    assert.equal(model.baseUrl, CUSTOM_BASE_URL, "模型取得到,可是指向别的端点");
    assert.equal(model.api, CUSTOM_API);
    assert.equal(model.provider, CUSTOM_PROVIDER);
    assert.deepEqual(stub.calls, [], "子进程发了对外目录请求");
  } finally {
    stub.restore();
  }
});

/**
 * 一家自定义 provider 一个模型行都没有时它仍在目录里,只是没有模型可选:`baseUrl` 在
 * provider 一级就够 Pi 把这一家合成出来。这一条守的是「名字仍被占用」——名字随着最后一个
 * 模型行被删而从目录里消失的话,同一个名字会被重新登记成另一个端点,而已经选进模型组合的
 * 模型标识悄声换了厂商。
 */
test("自定义 provider 一个模型行都没有时仍在目录里", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  writeSharedModelsConfig(paths.config, [], [customProvider()], NO_CONFLICT);

  const stub = stubFetch({});
  try {
    const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
    assert.ok(
      runtime.getProviders().some((provider) => provider.id === CUSTOM_PROVIDER),
      "自定义 provider 一个模型都没有时整家从目录里消失了",
    );
    assert.deepEqual(runtime.getModels(CUSTOM_PROVIDER), []);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

/**
 * 拒收「缺 base URL」与「缺接口协议」的判据(issue #88):全新 provider 没有继承来源,缺
 * 任一者这一家**整个从目录消失**——不是报错,是消失(Pi 把合成错误收进 `compositionErrors`,
 * 没有 base 可退回时直接 `deleteProvider`)。
 *
 * 这两份配置是手写的,不经 `writeSharedModelsConfig`:那个函数从库里的行落盘,而两列在表上
 * 都是 NOT NULL,写不出缺项的形态。守的是「端点必须在保存前收齐这两项」这条约束的前提。
 */
test("全新 provider 缺 api 或缺 baseUrl 时整家从目录里消失", async () => {
  const stub = stubFetch({});
  try {
    for (const [missing, provider] of [
      ["api", { baseUrl: CUSTOM_BASE_URL, models: [{ id: CUSTOM_MODEL }] }],
      ["baseUrl", { api: CUSTOM_API, models: [{ id: CUSTOM_MODEL }] }],
    ] as const) {
      cacheDir(false);
      const paths = sharedModelPaths()!;
      mkdirSync(dirname(paths.config), { recursive: true });
      writeFileSync(paths.config, JSON.stringify({ providers: { [CUSTOM_PROVIDER]: provider } }));

      const runtime = await isolatedModelRuntime(tempDir("multireviewer-store-agent-"), paths);
      assert.equal(
        runtime.getProviders().some((entry) => entry.id === CUSTOM_PROVIDER),
        false,
        `缺 ${missing} 时这一家竟然还在目录里,拒收那一道就失去依据了`,
      );
      assert.equal(runtime.getModel(CUSTOM_PROVIDER, CUSTOM_MODEL), undefined);
    }
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

/**
 * 撞名拒收的判据(issue #81 / #88):Pi 对同名 provider 不报错而是做覆盖——只给 base URL
 * 不给模型列表时,内置那份模型列表原样保留、每一个都改指新端点(`applyModelsJson` 的第一步
 * 就是这个映射)。叫 `openai` 会让已有的模型组合悄声换掉接口地址,面板上零痕迹。
 */
test("同名 provider 在 Pi 里是覆盖:内置模型全部改指新端点", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  const agentDir = tempDir("multireviewer-store-agent-");

  const stub = stubFetch({});
  try {
    writeSharedModelsConfig(paths.config, [], [], NO_CONFLICT);
    const before = (await isolatedModelRuntime(agentDir, paths)).getModels(PROVIDER);
    assert.ok(before.length > 0, "这一家一个模型都没有,这条断言失去意义");
    assert.ok(
      before.every((model) => model.baseUrl !== CUSTOM_BASE_URL),
      "内置的 baseUrl 恰好等于测试用的那个,换一个",
    );

    mkdirSync(dirname(paths.config), { recursive: true });
    writeFileSync(
      paths.config,
      JSON.stringify({ providers: { [PROVIDER]: { baseUrl: CUSTOM_BASE_URL } } }),
    );
    const after = (await isolatedModelRuntime(agentDir, paths)).getModels(PROVIDER);

    assert.deepEqual(
      after.map((model) => model.id),
      before.map((model) => model.id),
      "模型列表本身变了,覆盖的形态不是这样",
    );
    assert.deepEqual(
      [...new Set(after.map((model) => model.baseUrl))],
      [CUSTOM_BASE_URL],
      "同名登记没有把内置模型改指新端点,撞名拒收那一道的理由要重写",
    );
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

/**
 * 撞名那一档不覆盖内置那一家(issue #94)。
 *
 * 前一条用例证实了 Pi 的语义:同名 provider 是覆盖,内置那份模型列表原样保留、每一个都改指
 * 新端点,而模型标识一个字都没变。登记时的拒收挡得住「今天就撞」,挡不住「今天不撞、Pi 升级
 * 之后才撞」——内置目录是运行时事实。这一档的做法是**不把撞名的那一家写进派生文件**:落盘里
 * 没有它,Pi 也就没有东西可以拿来覆盖。
 *
 * 它的模型行一并跳过。留着的话 Pi 会把那几行当成给内置这一家手填的模型追加进来(`api` 与
 * `baseUrl` 从内置那一家继承),于是内置这一家凭空多出几个在它自己的端点上根本不存在的模型。
 *
 * 判据打在运行时的模型对象上,不打在目录端点上:端点只给 id / name / contextWindow / cost,
 * 而这一条要守的恰恰是端点看不见的 `baseUrl` 与 `api`。
 */
test("撞名的自定义 provider 不落进派生文件,内置那一家的模型仍指向原本的端点", async () => {
  cacheDir(false);
  const paths = sharedModelPaths()!;
  const agentDir = tempDir("multireviewer-store-agent-");

  const stub = stubFetch({});
  try {
    writeSharedModelsConfig(paths.config, [], [], NO_CONFLICT);
    const before = (await isolatedModelRuntime(agentDir, paths)).getModels(PROVIDER);
    assert.ok(before.length > 0, "这一家一个模型都没有,这条断言失去意义");
    assert.ok(
      before.every((model) => model.baseUrl !== CUSTOM_BASE_URL),
      "内置的 baseUrl 恰好等于测试用的那个,换一个",
    );

    // 库里那条登记的名字与内置这一家撞上了:定义在库里,模型行也在库里。
    writeSharedModelsConfig(
      paths.config,
      [{ ...handFilled(), provider: PROVIDER, model: CUSTOM_MODEL }],
      [customProvider({ name: PROVIDER })],
      new Set([PROVIDER]),
    );
    const after = (await isolatedModelRuntime(agentDir, paths)).getModels(PROVIDER);

    assert.deepEqual(
      after.map((model) => ({ id: model.id, api: model.api, baseUrl: model.baseUrl })),
      before.map((model) => ({ id: model.id, api: model.api, baseUrl: model.baseUrl })),
      "撞名那一家把内置这一家覆盖掉了",
    );
    assert.equal(
      after.find((model) => model.id === CUSTOM_MODEL),
      undefined,
      "撞名那一家的模型行被当成内置这一家的手填行追加进来了",
    );
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});
