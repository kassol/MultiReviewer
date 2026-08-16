/**
 * Pi 内置的模型目录。面板的模型选择器要在运行时知道「这一版 Pi 里有哪些 provider、
 * 哪些模型」,而目录是运行时事实:随 Pi 升级而变,打进前端产物就会与服务用的那份错开,
 * 选出一个当前 Pi 里不存在的模型标识。
 *
 * 目录只读一次,缓存在进程里:同一个进程里的 Pi 就是同一份目录,每次请求重建
 * `ModelRuntime` 只是重复解析同样的内置表。读失败不进缓存,下一次请求重来。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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

let cached: Promise<CatalogProvider[]> | undefined;

/**
 * 进程内的那一份目录。失败的 promise 不留在缓存里:留住的话首次读失败后这个进程再也
 * 拿不到目录,模型选择器永远空白,只能重启容器。
 *
 * `load` 带默认值是为了能在测试里喂一个必然失败的读取,生产路径不传。
 */
export function modelCatalog(
  load: () => Promise<CatalogProvider[]> = loadFromPi,
): Promise<CatalogProvider[]> {
  cached ??= load().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

async function loadFromPi(): Promise<CatalogProvider[]> {
  // 与 Reviewer 子进程同样的隔离:authPath 与 modelsPath 指进空的临时目录。默认值在
  // `~/.pi/agent` 下,那里的 auth.json 存着宿主机上配置过的每一家厂商的凭据。
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-catalog-"));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  return runtime.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: provider.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      cost: model.cost,
    })),
  }));
}
