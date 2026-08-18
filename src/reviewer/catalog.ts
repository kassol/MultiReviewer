/**
 * Pi 内置的模型目录。面板的模型选择器要在运行时知道「这一版 Pi 里有哪些 provider、
 * 哪些模型」,而目录是运行时事实:随 Pi 升级而变,打进前端产物就会与服务用的那份错开,
 * 选出一个当前 Pi 里不存在的模型标识。
 *
 * 目录读一次就缓存在进程里:同一个进程里的 Pi 就是同一份目录,每次请求重建
 * `ModelRuntime` 只是重复解析同样的内置表。读失败不进缓存,下一次请求重来;模型行改动之后
 * 由写入方显式失效(`invalidateModelCatalog`),否则写完在这个进程里看不见。
 */
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { CustomProviderRecord } from "../review/store.ts";
import { isolatedModelRuntime, type SharedModelPaths, sharedModelPaths } from "./model-runtime.ts";
import { openRouterCatalog, type VendorCatalog, type VendorModel } from "./vendor-catalog.ts";

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

/** 一次目录读取的结果:模型表,以及两层增量各自的状态。 */
export type Catalog = {
  providers: CatalogProvider[];
  remote: CatalogRemote;
  vendors: Record<string, CatalogVendor>;
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

/** 目录加载的串行链,见 `loadFromPi`。 */
let catalogLoads: Promise<void> = Promise.resolve();

/**
 * 读一份目录。内置表先到位,再让 Pi 去 pi.dev 拉每家 provider 的远程目录(约多出 72 个
 * 模型),最后问一遍厂商目录、把那一家自己公布、这两层都还没有的模型补上。联网只发生在
 * 这一份上:子进程应当尽量少对外通信(ADR 0004),`worker.ts` 那处因此不联网,只读这里
 * 落盘的远程目录——面板选得出的模型子进程必须取得到,共用一份落盘文件是它们之间唯一的
 * 通路(见 `model-runtime.ts`)。
 *
 * 不用 `ModelRuntime.create({ allowModelNetwork: true })`,而是先建再自己刷一次:
 * `create` 把刷新结果吞掉了,拿不到「哪几家没拉到」;自己刷才能把远程那一层的成败
 * 透出去。Pi 把每家的失败收进 `errors` 而不抛,内置表在失败时原样留着。
 *
 * 两层的成败各记各的:远程拉不到不妨碍问厂商目录,反过来也一样。超时用同一个上限,
 * 进程内缓存也还是同一份(`modelCatalog`)。
 *
 * **加载串行,同一时刻最多一份在跑。**厂商目录那一步要把行写进共用落盘,而那是「整份读
 * 进来、改一家、整份写回去」:两份同时在飞时后写的那一份会把先写的整批账抹掉。真实的重叠
 * 窗口只有这一个——目录有进程内缓存,只有「一次读还在飞的时候有人失效了缓存」
 * (`invalidateModelCatalog`)才造得出第二份;同一次加载内部 `refreshRemote`(Pi 写,带它
 * 自己的文件锁)与 `writeVendorModels`(我们写)本来就是先后两步,不构成竞争。跨进程同样
 * 不必管:**这份落盘只有服务进程写**,Reviewer 子进程只读(`worker.ts`)。把这一个窗口串
 * 起来等于把整个边界设计掉,不必再加第二把锁——Pi 那把受锁存储只在
 * `dist/core/models-store.js` 里导出,而包的 `exports` 映射只开了三个入口,深导入进不去。
 */
export function loadFromPi(options: LoadOptions = {}): Promise<Catalog> {
  const queued = catalogLoads.then(() => loadCatalog(options));
  // 链上留的那一份不带失败:一次加载失败不该把排在它后面的一起拖红。
  catalogLoads = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function loadCatalog(options: LoadOptions): Promise<Catalog> {
  // 凭据那一份仍私有:authPath 指进空的临时目录,默认位置在 `~/.pi/agent` 下,那里的
  // auth.json 存着宿主机上配置过的每一家厂商的凭据。目录那两份是共用的。
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-catalog-"));
  const paths = options.paths ?? sharedModelPaths();
  const runtime = await isolatedModelRuntime(dir, paths);

  const allowNetwork = options.allowNetwork ?? remoteEnabled();
  const timeoutMs = options.timeoutMs ?? MODEL_REFRESH_TIMEOUT_MS;
  const remote = allowNetwork ? await refreshRemote(runtime, timeoutMs) : "off";
  const vendor = allowNetwork
    ? await mergeVendorCatalog(runtime, openRouterCatalog, paths?.store, timeoutMs)
    : "off";

  return {
    remote,
    vendors: { [openRouterCatalog.provider]: vendor },
    providers: runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        cost: nonNegativeCost(model.cost),
      })),
    })),
  };
}

/**
 * 负单价按 0 透出。Pi 内置表里 `openrouter/auto` 与 `openrouter/auto-beta` 两行的费率是
 * -1000000(实测 0.84.0):OpenRouter 对路由类模型报的单价是 "-1",意思是随路由到的那个模型
 * 浮动,而那个 -1 被照着每百万 token 换算了一遍。原样透出去面板上就写着 `$-1000000/M`。
 *
 * 收口放在这一层而不是去改那两行:内置与远程目录来的行一律不动(ADR 0009),而「负数不是一个
 * 费率」是这个数自己的性质,与它由谁给出无关。取 0 与 Pi 自己那条 `auto` 记的数一致。
 *
 * Review Run 的成本不经过这一层:那个数取自 Pi 的 `session.getSessionStats()`,用的是 Pi
 * 内部那张定价表。那一侧同样按零收,收口在库里(`review/store.ts` 的 `recordedCost`)。
 */
function nonNegativeCost(cost: CatalogCost): CatalogCost {
  if (cost.input >= 0 && cost.output >= 0 && cost.cacheRead >= 0 && cost.cacheWrite >= 0) {
    return cost;
  }
  const floor = (value: number): number => (value > 0 ? value : 0);
  return {
    ...cost,
    input: floor(cost.input),
    output: floor(cost.output),
    cacheRead: floor(cost.cacheRead),
    cacheWrite: floor(cost.cacheWrite),
  };
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
  vendor: VendorCatalog,
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
 * 清单没变时也照写:这些行的单价与上下文窗口以厂商那份清单为准,跳过写入等于把第一次拉到
 * 的那份价格冻在落盘里。一次目录加载只付一次,而目录在进程里是缓存住的。
 *
 * 先写临时文件再原子改名,理由与派生的 `models.json` 相同(`model-runtime.ts`):子进程随时
 * 可能在读,读到写了一半的 JSON 会让 Pi 把整份落盘当作解析失败。不加锁的判据见 `loadFromPi`。
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

/**
 * Pi 内置目录里的那些 provider 名字,不叠我们派生的用户模型配置那一层(`models.json`)。
 *
 * 撞名的判据要的正是这一份:名字一旦撞上,Pi 把两家合成一家(内置那份模型列表原样保留、
 * 全部改指自定义那个端点),从服务读到的目录里再也分不出「这家是内置的」还是「这家是登记
 * 进来的」。因此这里另建一份运行时,`modelsPath` 指进那个私有的空目录。
 *
 * 共用的那份落盘(`models-store.json`)也不给:远程目录与厂商目录加得进模型、加不进
 * provider——`withRemoteCatalog` 只包在内置 provider 列表上,恢复时还按
 * `model.provider === provider.id` 过一遍(issue #82 查证过同一件事)。不给它,这一份结果就
 * 与缓存目录无关。
 *
 * 每次现算,不缓存结果:实测建一份这样的运行时 3 毫秒上下,而且不联网(`ModelRuntime.create`
 * 只在显式传 `allowModelNetwork` 时才发请求)。缓存住的话这个判据会跟着「谁先问」漂——而它
 * 恰恰是那种一漂就把撞名读成不撞名的东西。
 */
async function builtinProviderNames(): Promise<ReadonlySet<string>> {
  builtinProbeDir ??= mkdtempSync(join(tmpdir(), "multireviewer-builtin-"));
  const runtime = await isolatedModelRuntime(builtinProbeDir, undefined);
  return new Set(runtime.getProviders().map((provider) => provider.id));
}

/** 一家撞名的都没有。零个自定义 provider 是常态,那一档连运行时都不必建。 */
const NO_CONFLICT: ReadonlySet<string> = new Set();

/**
 * 撞名的那几家自定义 provider(issue #94):名字在库里有一条登记,而 Pi 的内置目录里也有
 * 同名的一家。
 *
 * 登记时的拒收(`server.ts` 的 `handleAddCustomProvider`)挡得住「今天就撞」,挡不住「今天
 * 不撞、明天才撞」——内置目录是运行时事实,随 Pi 升级而变。这一档必须有确定行为:Pi 对同名
 * provider 不报错而是覆盖,升级一次就可能让某个内置厂商的全部模型悄声换掉接口地址,而模型
 * 标识一个字都不变、面板上零痕迹。
 *
 * 不落库:它是「库里的登记 ∩ Pi 内置目录」这个交集,每次现算。操作员改了名、或者 Pi 又把那个
 * 内置 id 撤了,行为自己就恢复了,不需要额外操作,也不会留下一条对不上现实的状态。
 */
export async function conflictingProviderNames(
  customProviders: readonly CustomProviderRecord[],
): Promise<ReadonlySet<string>> {
  if (customProviders.length === 0) return NO_CONFLICT;
  const builtin = await builtinProviderNames();
  return new Set(
    customProviders.filter((entry) => builtin.has(entry.name)).map((entry) => entry.name),
  );
}

