import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { RuntimeModel } from "./model-service-runtime.ts";

export type RuntimeApi = NonNullable<
  Parameters<ModelRuntime["registerProvider"]>[1]["api"]
>;

export const CACHE_DIR_ENV = "MULTIREVIEWER_CACHE_DIR";
const DEFAULT_CACHE_DIR = ".cache/worktrees";
const MODEL_CATALOG_DIR = "pi-models";

/** Pi 的远程目录缓存只供显式模型服务发现使用；模型服务快照才是产品真相源。 */
export function modelCatalogStorePath(root?: string): string | undefined {
  const dir = join(
    root === undefined ? resolve(process.env[CACHE_DIR_ENV] ?? DEFAULT_CACHE_DIR) : resolve(root),
    MODEL_CATALOG_DIR,
  );
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  return join(dir, "models-store.json");
}

/** 自定义 OpenAI-compatible 模型服务允许使用的 Pi 接口协议。 */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses"] as const;

/**
 * 注册进 Pi 的模型必须带费率:pi-ai 每次调用都拿它折算会话统计,缺这一项当场抛
 * (`pi-ai/dist/models.js` 的 `calculateCost` 直接读 `model.cost.tiers`)。产品自己不
 * 记账(issue #188),这里给零费率把它填住,Pi 回的那个数字没有读取方。
 */
export const ZERO_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * 建一份凭据与 `models.json` 都私有的运行时。可选的 store 只是发现输入缓存，绝不把旧的
 * 当前模型配置带进模型服务发现或 Review Run。
 */
export function isolatedModelRuntime(
  agentDir: string,
  catalogStorePath: string | undefined,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    ...(catalogStorePath === undefined ? {} : { modelsStorePath: catalogStorePath }),
  });
}

/** 在私有、不联网的运行时里注册 Review Run 已固定的模型服务版本。 */
export async function isolatedPinnedModelRuntime(
  agentDir: string,
  target: RuntimeModel,
): Promise<ModelRuntime> {
  const runtime = await isolatedModelRuntime(agentDir, undefined);
  runtime.registerProvider(target.provider, {
    name: target.provider,
    baseUrl: target.baseUrl,
    api: target.api,
    models: [
      {
        id: target.id,
        name: target.name,
        api: target.api,
        baseUrl: target.baseUrl,
        reasoning: target.reasoning,
        input: [...target.input],
        cost: { ...ZERO_MODEL_COST },
        contextWindow: target.contextWindow,
        maxTokens: target.maxTokens,
      },
    ],
  });
  return runtime;
}
