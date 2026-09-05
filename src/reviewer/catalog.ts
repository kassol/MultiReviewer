/** Pi 内置、远程与厂商目录只在模型服务显式发现时读取并合成。 */
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  isolatedModelRuntime,
  modelCatalogStorePath,
  type RuntimeApi,
  type RuntimeModelCompat,
  type RuntimeThinkingLevelMap,
} from "./model-runtime.ts";
import { openRouterCatalog, type VendorModel } from "./vendor-catalog.ts";

/**
 * 远程目录那一层的结果。`ok` 是内置目录加上了 pi.dev 的增量;`unavailable` 是远程
 * 没拿到,给出的只有内置那一份;`off` 是按配置关掉了远程(`PI_OFFLINE`)。
 * 端点把它原样透出:选择器里少了几十个模型时,运维要能分清是关掉了还是拉失败了。
 */
export type CatalogRemote = "ok" | "unavailable" | "off";

/**
 * 厂商目录那一层的结果,按 provider 记一格。`ok` 是问过那一家、缺的都补上了;
 * `unavailable` 是没拉到,给出的只有内置目录加远程目录那一份;`off` 是关掉了(`PI_OFFLINE`)。
 * 与远程那一层分开记:两层都可能少掉一批模型,合成一个字段就分不清少在哪一层。
 */
export type CatalogVendor = "ok" | "unavailable" | "off";


/**
 * 远程刷新的时间上限。Pi 对 39 家 provider 各发一次请求,单次失败还会立即重试两轮,
 * 且不带自己的超时——网络黑洞时会一直挂到 TCP 超时,面板第一次开选择器就跟着挂住。
 *
 * 实测冷启动一轮 1-2 秒,首次连接(DNS 与 TLS 都是冷的)偶尔超过 5 秒。这段等待一个
 * 进程只付一次(目录进程内缓存),因此给到 10 秒:宁可多等,也不要因为抖动就少掉 72
 * 个模型。真的拉不到也只是降级到内置目录。
 */
const MODEL_REFRESH_TIMEOUT_MS = 10_000;

/** 模型服务发现的可注入项。 */
export type LoadOptions = {
  allowNetwork?: boolean;
  timeoutMs?: number;
  /** Pi 远程目录缓存；不传就按 `MULTIREVIEWER_CACHE_DIR` 推导。 */
  catalogStorePath?: string;
};

/** 完整的可信 Pi 模型字段，供模型服务发现使用。 */
export type PiCatalogModel = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: RuntimeThinkingLevelMap;
  compat?: RuntimeModelCompat;
};

export type PiProviderCatalog = {
  id: string;
  name: string;
  models: PiCatalogModel[];
  remote: CatalogRemote;
  vendors: Record<string, CatalogVendor>;
};

/** 显式目录发现串行，避免两次刷新并发覆盖同一份 Pi store。 */
let catalogLoads: Promise<void> = Promise.resolve();

/** 两次显式发现不得并发改写同一个 Pi store；失败不污染后续队列。 */
function queueCatalogLoad<T>(load: () => Promise<T>): Promise<T> {
  const queued = catalogLoads.then(load);
  // 链上留的那一份不带失败:一次加载失败不该把排在它后面的一起拖红。
  catalogLoads = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}


/** 模型服务的内置发现输入；私有 `models.json` 保证模型补录不会伪装成自动来源。 */
export function loadPiProviderCatalog(
  providerId: string,
  options: LoadOptions = {},
): Promise<PiProviderCatalog | undefined> {
  return queueCatalogLoad(async () => {
    const loaded = await loadPiRuntime(options);
    const provider = loaded.runtime.getProvider(providerId);
    if (provider === undefined) return undefined;
    return {
      id: provider.id,
      name: provider.name,
      remote: loaded.remote,
      vendors: loaded.vendors,
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        input: model.input,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        // 内置表里这两项可能是 null(如 opus-4-5 的 thinkingLevelMap),null 即没有。
        ...(model.thinkingLevelMap == null ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
        ...(model.compat == null ? {} : { compat: model.compat }),
      })),
    };
  });
}

async function loadPiRuntime(options: LoadOptions): Promise<{
  runtime: ModelRuntime;
  remote: CatalogRemote;
  vendors: Record<string, CatalogVendor>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-catalog-"));
  const catalogStore = options.catalogStorePath ?? modelCatalogStorePath();
  const runtime = await isolatedModelRuntime(dir, catalogStore);

  const allowNetwork = options.allowNetwork ?? remoteEnabled();
  const timeoutMs = options.timeoutMs ?? MODEL_REFRESH_TIMEOUT_MS;
  const remote = allowNetwork ? await refreshRemote(runtime, timeoutMs) : "off";
  const vendor = allowNetwork
    ? await mergeVendorCatalog(runtime, openRouterCatalog, catalogStore, timeoutMs)
    : "off";
  return { runtime, remote, vendors: { [openRouterCatalog.provider]: vendor } };
}


/**
 * 问一家厂商要它的现货清单,把内置表与远程目录都还没有的那些补进目录。
 *
 * 对齐按裸 model id(模型标识 `provider:model` 的后半段)。已有那一行整行保留——它可能是
 * Pi 内置的、也可能是远程目录换掉的,厂商目录只补缺,Pi 独有的 `auto` 因此留得下来。
 *
 * 上一轮我们自己补进落盘的那些行不算「已有」:它们出现在运行时的目录里只是因为上一轮写了
 * 落盘,拿它们当已有的话这一层就再也摘不掉任何东西——厂商下线一个模型时那一行留在落盘与
 * 选择器里,直到 pi.dev 那一家下一次刷新成功才被顺带冲掉(判据与实测见 ADR 0009)。因此
 * 每一轮都拿当下这份清单重算,由 `writeVendorModels` 整批换掉上一轮那批。
 *
 * 补进来的行写进远程目录那一份落盘再让 Pi 重读,而不是只改内存里的目录:落盘是面板与
 * Reviewer 子进程之间唯一的通路,只补内存等于面板选得出、子进程取不到,那是本票最要紧的
 * 不变量反过来的样子。共用落盘拿不到时(缓存目录建不出来)因此干脆不补:那一档补了也只是
 * 造出一批取不到的模型。
 */
async function mergeVendorCatalog(
  runtime: ModelRuntime,
  vendor: typeof openRouterCatalog,
  storePath: string | undefined,
  timeoutMs: number,
): Promise<CatalogVendor> {
  const provider = runtime.getProviders().find((entry) => entry.id === vendor.provider);
  if (storePath === undefined || provider === undefined) return "unavailable";

  const models = await vendor.fetchModels(timeoutMs);
  if (models === undefined) return "unavailable";

  let store: Store = {};
  try {
    store = JSON.parse(readFileSync(storePath, "utf8")) as Store;
  } catch {
    // 落盘还不在或者读坏了:当空的重建,反正它是可以从 pi.dev 与厂商目录重建的派生物。
  }
  const previous = new Set(store[vendor.provider]?.[VENDOR_MODEL_IDS] ?? []);
  const known = new Set(provider.getModels().map((model) => model.id));
  const additions = models.filter((model) => !known.has(model.id) || previous.has(model.id));
  if (additions.length > 0 || previous.size > 0) {
    writeVendorModels(storePath, store, vendor.provider, additions);
    // 不联网的这一次刷新只做一件事:把落盘里的条目恢复进内存。
    await runtime.refresh({ allowNetwork: false });
  }
  return "ok";
}

/**
 * 厂商目录那一层补进落盘的那些 model id。Pi 只认 `models` / `checkedAt` / `lastModified` /
 * `etag` 四项,多出来的键它原样带着走——远程刷新失败、304 与 404 那几条路写回去的都是
 * `{...stored, …}`(`dist/core/remote-catalog-provider.js`)。只有远程目录 200 那一条路整条
 * 换成一个只含远程行的新对象,这一位于是跟着消失,而那正是它该消失的时刻:那一刻厂商目录
 * 这一层被远程目录整条冲掉了,下一次读目录按当下的厂商清单从零补一遍。
 */
const VENDOR_MODEL_IDS = "multireviewerVendorModels";

/**
 * `models-store.json` 里一家 provider 的那一条。除了 `models` 与上面那一位,其余都是 Pi
 * 自己的记账。`models` 的每一行由 Pi 与本模块两边写,`id` 两边都必有。
 */
type StoreEntry = {
  models?: readonly { readonly id: string }[];
  lastModified?: number;
  [VENDOR_MODEL_IDS]?: readonly string[];
};

type Store = Record<string, StoreEntry | undefined>;

/**
 * 把厂商目录那一层写进远程目录共用的那份落盘:上一轮补的整批换成这一轮的。
 *
 * 换而不是追加,守住两件事。一、**厂商下线的模型跟着消失**:上一轮那批按 `VENDOR_MODEL_IDS`
 * 认出来先丢掉,这一轮清单里没有它就不再写回去。二、**同一个 id 在落盘里只出现一次**:
 * 落盘里已有该 id 而运行时看不见它这一档是真的(Pi 升级后内置表的生成时间新于 store 的
 * `lastModified`,或者 pi.dev 回 404 把它压成 0,两种情形下 Pi 都不把 store 里的行恢复进内存),
 * 盲追加于是让同一个 id 在文件里出现两次、而且每读一次目录再多一份。
 *
 * `etag` 与 `checkedAt` 原样留着:那是远程那一层的记账,动了它下一次要么白拉一遍,要么
 * 该拉的不拉。`lastModified` 反过来必须改成现在——Pi 拿它与内置表的生成时间比,早于内置表
 * 的整条丢掉,沿用旧值时补进来的行会在下一次读目录时凭空消失。
 *
 * 清单没变时也照写:这些行的上下文窗口以厂商那份清单为准,跳过写入等于把第一次拉到的
 * 那一份冻在落盘里。一次目录加载只付一次,而目录在进程里是缓存住的。
 *
 * 先写临时文件再原子改名:显式预览或刷新可能同时读取这份可丢弃缓存,不能让 Pi 看到只写了
 * 一半的 JSON。
 */
function writeVendorModels(
  storePath: string,
  store: Store,
  providerId: string,
  models: readonly VendorModel[],
): void {
  const entry = store[providerId];
  const replaced = new Set([
    ...(entry?.[VENDOR_MODEL_IDS] ?? []),
    ...models.map((model) => model.id),
  ]);
  store[providerId] = {
    ...entry,
    models: [...(entry?.models ?? []).filter((row) => !replaced.has(row.id)), ...models],
    [VENDOR_MODEL_IDS]: models.map((model) => model.id),
    lastModified: Date.now(),
  };
  const pending = `${storePath}.pending`;
  writeFileSync(pending, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(pending, storePath);
}

/**
 * 拉远程目录。超时与单家失败都只降级到内置目录:选择器空白比少几十个模型严重得多。
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

/**
 * 探问内置目录用的私有目录。一个进程建一次:每次读目录都新建一个,长跑服务里会堆一地临时
 * 目录。里面始终是空的——Pi 只读 `models.json` 与 `auth.json`,这两份都不在。
 */
let builtinProbeDir: string | undefined;

export type PiBuiltinProvider = { id: string; name: string };
export type PiBuiltinProviderTarget = Readonly<{ api: RuntimeApi; baseUrl: string }>;

async function piBuiltinRuntime() {
  builtinProbeDir ??= mkdtempSync(join(tmpdir(), "multireviewer-builtin-"));
  return isolatedModelRuntime(builtinProbeDir, undefined);
}

/**
 * Pi 内置 provider 的只读索引。不给共用目录与用户配置，因此只含这一版 Pi 自带的
 * provider；模型服务搜索用它，不能从混入自定义服务的旧目录端点反推。
 */
export async function listPiBuiltinProviders(): Promise<PiBuiltinProvider[]> {
  const runtime = await piBuiltinRuntime();
  return runtime.getProviders().map((provider) => ({ id: provider.id, name: provider.name }));
}

/**
 * Pi 当前内置 provider 逐模型的调用目标(ADR 0027):model id → 该行自己的 api/baseUrl。
 * 同一家下的模型可以走不同协议与地址(OpenRouter 既有 Chat Completions 也有 Anthropic
 * Messages),所以不再取第一行当整家的目标。只返回合成模型所需的两项,不把当前 Pi 的
 * name、能力或上下文混进数据库已提交的自动目录事实;两项缺一的行不进结果。provider
 * 不存在回 undefined。
 */
export async function piBuiltinProviderTargets(
  providerId: string,
): Promise<ReadonlyMap<string, PiBuiltinProviderTarget> | undefined> {
  const provider = (await piBuiltinRuntime()).getProvider(providerId);
  if (provider === undefined) return undefined;
  const targets = new Map<string, PiBuiltinProviderTarget>();
  for (const model of provider.getModels()) {
    if (
      typeof model.api !== "string" ||
      model.api.trim() === "" ||
      typeof model.baseUrl !== "string" ||
      model.baseUrl.trim() === ""
    ) continue;
    targets.set(model.id, { api: model.api, baseUrl: model.baseUrl });
  }
  return targets;
}

/** 自定义模型服务与当前 Pi 内置 provider 的动态名字冲突。 */
export async function conflictingBuiltinProviderNames(
  providers: readonly string[],
): Promise<ReadonlySet<string>> {
  if (providers.length === 0) return new Set();
  const builtin = new Set((await listPiBuiltinProviders()).map((provider) => provider.id));
  return new Set(providers.filter((provider) => builtin.has(provider)));
}

