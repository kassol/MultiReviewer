/**
 * Pi 内置的模型目录。面板的模型选择器要在运行时知道「这一版 Pi 里有哪些 provider、
 * 哪些模型」,而目录是运行时事实:随 Pi 升级而变,打进前端产物就会与服务用的那份错开,
 * 选出一个当前 Pi 里不存在的模型标识。
 *
 * 目录读一次就缓存在进程里:同一个进程里的 Pi 就是同一份目录,每次请求重建
 * `ModelRuntime` 只是重复解析同样的内置表。读失败不进缓存,下一次请求重来;模型行改动之后
 * 由写入方显式失效(`invalidateModelCatalog`),否则写完在这个进程里看不见。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { isolatedModelRuntime, type SharedModelPaths, sharedModelPaths } from "./model-runtime.ts";

/**
 * 远程目录那一层的结果。`ok` 是内置目录加上了 pi.dev 的增量;`unavailable` 是远程
 * 没拿到,给出的只有内置那一份;`off` 是按配置关掉了远程(`PI_OFFLINE`)。
 * 端点把它原样透出:选择器里少了几十个模型时,运维要能分清是关掉了还是拉失败了。
 */
export type CatalogRemote = "ok" | "unavailable" | "off";

/** 一次目录读取的结果:模型表,以及远程那一层的状态。 */
export type Catalog = {
  providers: CatalogProvider[];
  remote: CatalogRemote;
};

/**
 * 远程刷新的时间上限。Pi 对 39 家 provider 各发一次请求,单次失败还会立即重试两轮,
 * 且不带自己的超时——网络黑洞时会一直挂到 TCP 超时,面板第一次开选择器就跟着挂住。
 *
 * 实测冷启动一轮 1-2 秒,首次连接(DNS 与 TLS 都是冷的)偶尔超过 5 秒。这段等待一个
 * 进程只付一次(目录进程内缓存),因此给到 10 秒:宁可多等,也不要因为抖动就少掉 72
 * 个模型。真的拉不到也只是降级到内置目录。
 */
const MODEL_REFRESH_TIMEOUT_MS = 10_000;

/** 模型单价,原样透出 Pi 的 `ModelCost`(单位随 Pi,不做换算)。 */
export type CatalogCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: readonly (CatalogCost & { inputTokensAbove: number })[];
};

/**
 * 一个模型。只给选择器要展示与要回填的那几项:`id` 是模型标识的后半段
 * (`provider:model`),其余三项是选型判据。reasoning / maxTokens / input / baseUrl
 * 不给——面板不用它们做判断,透出去只会被误当成筛选条件。
 */
export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  cost: CatalogCost;
};

export type CatalogProvider = {
  id: string;
  name: string;
  models: CatalogModel[];
};

let cached: Promise<Catalog> | undefined;

/**
 * 进程内的那一份目录。失败的 promise 不留在缓存里:留住的话首次读失败后这个进程再也
 * 拿不到目录,模型选择器永远空白,只能重启容器。
 *
 * 清缓存前先认一认是不是自己那一份:一次读还在飞的时候有人失效了缓存,后来的请求会存进
 * 一份新的,而先前那一份此刻才失败——无条件清就会把新的一起清掉,一次失效于是引出两轮
 * 重新加载(各带一轮远程目录请求),而且先存进去的那一份成功了也留不住。
 *
 * `load` 带默认值是为了能在测试里喂一个必然失败的读取,生产路径不传。
 */
export function modelCatalog(load: () => Promise<Catalog> = loadFromPi): Promise<Catalog> {
  if (cached === undefined) {
    const pending: Promise<Catalog> = load().catch((error: unknown) => {
      if (cached === pending) cached = undefined;
      throw error;
    });
    cached = pending;
  }
  return cached;
}

/**
 * 丢掉缓存住的那一份,下一次读重新组装。
 *
 * 缓存住的是 Pi 那张模型表,而模型行落在派生的 `models.json` 上、由面板随时改写:不失效
 * 的话写入在这个进程里永远看不见,操作员加完一个模型标识却选不到它。
 *
 * 幂等:没有待失效的东西时也调得动,而且只丢缓存不预热——下一次真有人读目录时才重新组装,
 * 免得一次写入白搭上一轮 pi.dev 刷新。
 */
export function invalidateModelCatalog(): void {
  cached = undefined;
}

/** `loadFromPi` 的可注入项。生产路径一个都不传,全部按环境推导。 */
export type LoadOptions = {
  allowNetwork?: boolean;
  timeoutMs?: number;
  /** 两份共用文件的位置。不传就按 `MULTIREVIEWER_CACHE_DIR` 推导。 */
  paths?: SharedModelPaths;
};

/**
 * 读一份目录。内置表先到位,再让 Pi 去 pi.dev 拉每家 provider 的增量(约多出 72 个
 * 模型)。联网只发生在这一份上:子进程应当尽量少对外通信(ADR 0004),`worker.ts` 那处
 * 因此不联网,只读这里落盘的 overlay——面板选得出的模型子进程必须取得到,共用一份落盘
 * 文件是它们之间唯一的通路(见 `model-runtime.ts`)。
 *
 * 不用 `ModelRuntime.create({ allowModelNetwork: true })`,而是先建再自己刷一次:
 * `create` 把刷新结果吞掉了,拿不到「哪几家没拉到」;自己刷才能把远程那一层的成败
 * 透出去。Pi 把每家的失败收进 `errors` 而不抛,内置表在失败时原样留着。
 */
export async function loadFromPi(options: LoadOptions = {}): Promise<Catalog> {
  // 凭据那一份仍私有:authPath 指进空的临时目录,默认位置在 `~/.pi/agent` 下,那里的
  // auth.json 存着宿主机上配置过的每一家厂商的凭据。目录那两份是共用的。
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-catalog-"));
  const runtime = await isolatedModelRuntime(dir, options.paths ?? sharedModelPaths());

  const allowNetwork = options.allowNetwork ?? remoteEnabled();
  const remote = allowNetwork
    ? await refreshRemote(runtime, options.timeoutMs ?? MODEL_REFRESH_TIMEOUT_MS)
    : "off";

  return {
    remote,
    providers: runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        cost: model.cost,
      })),
    })),
  };
}

/**
 * 拉远程增量。超时与单家失败都只降级到内置目录:选择器空白比少几十个模型严重得多。
 */
async function refreshRemote(runtime: ModelRuntime, timeoutMs: number): Promise<CatalogRemote> {
  try {
    const result = await runtime.refresh({
      allowNetwork: true,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result.aborted || result.errors.size > 0 ? "unavailable" : "ok";
  } catch {
    return "unavailable";
  }
}

/**
 * 与 Pi 自己一致的开关:`PI_OFFLINE` 一旦出现(任何值)就不联网。离线部署与内网无
 * 出口的场景复用它,不再加项目自己的变量。
 */
function remoteEnabled(): boolean {
  return process.env["PI_OFFLINE"] === undefined;
}

