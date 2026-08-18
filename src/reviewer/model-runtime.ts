/**
 * 面板与 Reviewer 子进程共用的模型运行时构件。
 *
 * 两侧要看到同一份模型目录:面板选得出的模型,子进程必须取得到。共用的是两份落盘文件,
 * 都放在缓存目录下:
 *
 * - `models-store.json` —— **远程目录**(pi.dev 给内置模型表做的那一份)的落盘。只有面板
 *   那侧联网,子进程只读。
 * - `models.json` —— Pi 的用户模型配置,由库里的模型行派生。只有面板那侧写。
 *
 * 这两份文件的默认位置都跟着 `modelsPath` 走,而两侧的 `modelsPath` 原本各在自己每次
 * 新建的临时目录里,于是面板那侧的东西子进程根本读不到:面板列得出 348 个 openrouter
 * 模型,子进程只有内置的 276 个,选中那多出来的 72 个之一,Review Run 上报「模型不存在」。
 *
 * 凭据那一份反过来必须各自私有:`auth.json` 的默认位置在 `~/.pi/agent` 下,那里存着宿
 * 主机上配置过的每一家厂商的凭据,读到就等于凭据分割白做(ADR 0004)。共用的只有目录。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { CustomProviderRecord, ModelRowRecord } from "../review/store.ts";

/** 缓存根目录的环境变量与默认值。工作副本与模型目录都落在它下面。 */
export const CACHE_DIR_ENV = "MULTIREVIEWER_CACHE_DIR";
const DEFAULT_CACHE_DIR = ".cache/worktrees";

/** 缓存根目录下专放 Pi 模型目录的子目录。 */
const MODELS_DIR = "pi-models";

/**
 * 缓存根目录,绝对路径。
 *
 * **必须在父进程里算一次再传给子进程。**默认值是相对路径,而 Reviewer 子进程的 `cwd` 是
 * 工作副本(`pi-reviewer.ts`):同一个相对值在两侧解析出两个不同的绝对路径,共用当场落空。
 * `pi-reviewer.ts` 因此在 fork 时把这里算出的绝对值写进子进程的环境,子进程再调这个函数
 * 只是原样返回。环境变量本身传得进子进程:`env.ts` 的凭据剥离只认变量名里的 KEY/TOKEN
 * 一类词,不命中它。
 */
export function cacheRoot(): string {
  return resolve(process.env[CACHE_DIR_ENV] ?? DEFAULT_CACHE_DIR);
}

/** 面板与 Reviewer 子进程共用的那两份文件,绝对路径。 */
export type SharedModelPaths = {
  /** pi.dev 增量的落盘位置。面板写,子进程只读。 */
  store: string;
  /** 由库里的模型行派生出的 Pi 用户模型配置。面板写,子进程只读。 */
  config: string;
};

/**
 * 两份共用文件的位置,绝对路径(绝对性来自 `cacheRoot`)。
 *
 * 两份一起给、一起退:目录建不出来就整个返回 undefined,调用方退回 Pi 的默认位置(私有
 * 临时目录),只是失去共用,不影响读目录。分成两个函数会多出「store 共用而 config 私有」
 * 这种半共用状态,而那一档没有任何用处。
 *
 * 只保证目录存在,不验证可写:子进程只读这两份文件,拿一个只读的共用目录当失败处理会把
 * 「读得到但写不了」这个完全能用的部署挡掉。写不出来由写入方自己报(`main.ts`)。
 */
export function sharedModelPaths(): SharedModelPaths | undefined {
  const dir = join(cacheRoot(), MODELS_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  return { store: join(dir, "models-store.json"), config: join(dir, "models.json") };
}

/**
 * 自定义 provider 的接口协议允许的取值(issue #88)。
 *
 * Pi 注册的接口实现共十个(`pi-ai` 的 `BUILTIN_APIS`:anthropic-messages、
 * openai-completions、openai-responses、openai-codex-responses、azure-openai-responses、
 * google-generative-ai、google-vertex、mistral-conversations、bedrock-converse-stream、
 * pi-messages)。这条入口只面向 OpenAI 兼容的端点,取值集因此只有其中两个:走
 * `/chat/completions` 的与走 `/responses` 的。
 *
 * 取值集是硬门禁而不是提示:Pi 的 `models.json` schema 把 `api` 收成任意非空字符串,填一个
 * 没有实现的值要到真发请求那一刻才报「No API provider registered for api: ...」。
 */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses"] as const;

/** 落盘的一行:Pi `models.json` 里 model definition 的最小子集。 */
type ConfigModel = {
  id: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
};

/** 落盘的一家:自定义 provider 多 `api` 与 `baseUrl` 两项,内置那些家一项都不写。 */
type ConfigProvider = {
  api?: string;
  baseUrl?: string;
  models: ConfigModel[];
};

/**
 * 把库里的模型行与自定义 provider 落成 Pi 的用户模型配置。
 *
 * 真相源是库,这份文件是可以从库重建的派生物:一律按当前状态整份重写,不与文件里已有的
 * 内容合并——合并会让手工改过的文件永远留着改动,而库里删掉的行再也清不掉。
 *
 * provider 一级只有自定义 provider 写 `api` 与 `baseUrl`,而且必须写:全新 provider 没有
 * 继承来源,缺任一者 Pi 把这一家整个从目录里丢掉(错误收进 `compositionErrors`,没有内置的
 * base 可退回时直接 `deleteProvider`)——表象是消失,不是报错。内置那些家反过来一项都不能
 * 写:`applyModelsJson` 的第一步就是把该家已有的每个模型都改指 provider 一级那个 `baseUrl`,
 * 写上去等于把整家人静悄悄换到别的端点。
 *
 * 一家自定义 provider 一个模型行都没有时仍写它自己那一条(`models` 是空数组):有 `baseUrl`
 * 在 provider 一级 Pi 就把这一家合成出来,于是这个名字在目录里一直被占着——名字随着最后一个
 * 模型行被删而从目录里消失的话,同一个名字会被重新登记成另一个端点。
 *
 * 每一个模型行只写 `id` 与填过的那几项。给内置 provider 加行时 `api` 与 `baseUrl` 由 Pi 从
 * 该家的第一个模型继承(`provider-composer.ts` 的 `applyModelsJson`),写死等于把上游哪天改掉
 * 的端点钉在库里。单价与上下文窗口留空就整个不写,由 Pi 取默认值(单价 0、上下文 128000、
 * maxTokens 16384)。
 *
 * 单价一旦要写就得写满四个费率:`ModelCost` 的四项全是必填,少一项这一行连整份配置一起
 * 校验不过,而 Pi 把这类错误吞进 provider 的合成里——表象是那一行凭空消失。缓存读写没有
 * 存储面,按 0 写,与不填单价时的默认值是同一个数。
 *
 * 先写临时文件再原子改名:子进程随时可能在读它,而读到写了一半的 JSON 会让 Pi 把整份
 * 配置当作解析失败(它把错误收进 `ModelConfig.error` 而不抛,于是那一刻起的模型行全部
 * 消失),表象是没头没尾的「模型不存在」。改名在同一个目录里,因此是原子的。
 *
 * 两样都没有时写出来的是空的 provider 集合。空集合对目录不可见:Pi 只对 `providers` 里
 * 真有条目的那几家做叠加。
 *
 * 撞名的那几家(`conflictingProviders`,issue #94)整个不写,连它们的模型行一起:名字被内置
 * 占用时,写进去的 `baseUrl` 会让内置那一家的每个模型都改指自定义那个端点,而模型标识一个字
 * 都不变——落盘里干脆没有它,Pi 也就没有东西可以拿来覆盖。模型行一并跳过,否则 Pi 把它们当成
 * 给内置这一家手填的行追加进来(`api` 与 `baseUrl` 从内置那一家继承),内置这一家凭空多出几个
 * 在它自己的端点上根本不存在的模型。撞名那一家因此整个停用,出路是改名重建或者删掉它。
 *
 * 判据由调用方给,而且必填:漏传等于把这道防覆盖静默摘掉。给内置 provider 手填的模型行不受
 * 影响——那个 provider 名字不在库里的自定义 provider 登记里,交集里就没有它。
 */
export function writeSharedModelsConfig(
  configPath: string,
  rows: readonly ModelRowRecord[],
  customProviders: readonly CustomProviderRecord[],
  conflictingProviders: ReadonlySet<string>,
): void {
  const providers: Record<string, ConfigProvider> = {};
  // 自定义 provider 先落位:它的 api 与 baseUrl 必须在 provider 一级,而下面那一轮只往
  // models 里追加。
  for (const custom of customProviders) {
    if (conflictingProviders.has(custom.name)) continue;
    providers[custom.name] = { api: custom.api, baseUrl: custom.baseUrl, models: [] };
  }
  for (const row of rows) {
    if (conflictingProviders.has(row.provider)) continue;
    (providers[row.provider] ??= { models: [] }).models.push({
      id: row.model,
      ...(row.costInput === null && row.costOutput === null
        ? {}
        : {
            cost: {
              input: row.costInput ?? 0,
              output: row.costOutput ?? 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }),
      ...(row.contextWindow === null ? {} : { contextWindow: row.contextWindow }),
    });
  }
  const pending = `${configPath}.pending`;
  writeFileSync(pending, `${JSON.stringify({ providers }, null, 2)}\n`);
  renameSync(pending, configPath);
}

/**
 * 一份 `ModelRuntime`:凭据私有,目录共用。面板与 Reviewer 子进程都用它,免得两侧的构造
 * 参数各写一遍再悄悄漂移——那正是「面板选得到、子进程取不到」那个缺陷的成因。
 *
 * `authPath` 指进调用方给的私有空目录(ADR 0004);`paths` 为 undefined 时 `modelsPath`
 * 也退回那里,连带 store 一起回到 Pi 的默认位置。
 *
 * 全程不联网:`ModelRuntime.create` 只在显式传 `allowModelNetwork` 时才发请求,这里不传。
 * store 里的远程目录仍然进得来——`create` 内部那一次 `refresh({allowNetwork: false})` 会先
 * 把 store 里的条目恢复进内存,再判断要不要联网,而恢复不受 4 小时刷新窗限制(过期只决定
 * 是否重新联网)。子进程因此一个对外目录请求都不发,却与面板看到同一份模型表。要联网的
 * 是面板那一侧,它建完之后自己再刷一次(`catalog.ts`)。
 */
export function isolatedModelRuntime(
  agentDir: string,
  paths: SharedModelPaths | undefined,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: paths?.config ?? join(agentDir, "models.json"),
    ...(paths === undefined ? {} : { modelsStorePath: paths.store }),
  });
}

/**
 * 「模型不存在」时补的一句成因指向。store 里一条远程目录都没有时,子进程手上只有 Pi
 * 内置的那一份目录,面板上选得到的远程模型这时一个都取不到——单看模型标识看不出这一层,
 * 运维会去查凭据和拼写。store 正常时返回空串,不给正常路径添噪。
 *
 * store 读不出来(文件不在、内容坏了、权限不够)与「一条都没有」同一处理:两者对子进程
 * 的后果相同,而 Pi 自己也是这样降级的——它把每家 provider 的读取失败收进 `refresh` 的
 * `errors` 里而不抛,内置目录原样留着,审查照常跑得起来。
 */
export function missingModelHint(storePath: string | undefined): string {
  if (storePath !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Record<
        string,
        { models?: unknown[] } | undefined
      >;
      if (Object.values(parsed).some((entry) => (entry?.models?.length ?? 0) > 0)) return "";
    } catch {
      // 落到下面那句提示。
    }
  }
  const where = storePath === undefined ? "" : ` ${storePath}`;
  return `(远程模型目录缓存${where} 里一条远程目录都没有,子进程手上只有 Pi 内置目录;面板读过一次模型目录之后它才落盘)`;
}
