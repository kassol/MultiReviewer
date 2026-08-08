import { readFileSync } from "node:fs";

import type { Reviewer } from "./review/finding.ts";
import { createPiReviewer } from "./reviewer/pi-reviewer.ts";

/** 模型组合是全局的,所有仓库共用一组。 */
export type ReviewerSpec = {
  /** Pi 的 provider 标识。 */
  provider: string;
  /** Pi 的 model 标识,同时用作 Finding 的模型标识。 */
  model: string;
  /** 存放该厂商凭据的环境变量名。凭据本身不进配置文件。 */
  apiKeyEnv: string;
};

export type Config = {
  reviewers: ReviewerSpec[];
};

export const DEFAULT_CONFIG_PATH = "multireviewer.config.json";

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error(`读不到配置文件: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `配置文件解析失败: ${path} — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const reviewers = (parsed as { reviewers?: unknown }).reviewers;
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error(`配置文件至少配置一个 Reviewer: ${path}`);
  }

  const seen = new Set<string>();
  for (const [index, entry] of reviewers.entries()) {
    for (const field of ["provider", "model", "apiKeyEnv"] as const) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value !== "string" || value === "") {
        throw new Error(`reviewers[${index}] 缺少 ${field}`);
      }
    }
    const model = (entry as ReviewerSpec).model;
    if (seen.has(model)) {
      // Finding 以模型标识归属来源,标识重复就分不清是哪一个 Reviewer 提的。
      throw new Error(`模型标识重复: ${model}`);
    }
    seen.add(model);
  }

  return { reviewers: reviewers as ReviewerSpec[] };
}

/**
 * 按配置建出全部 Reviewer,每个只拿到自己那一家的凭据。
 *
 * 凭据在这里一次性取齐:缺失要在服务启动时暴露,而不是等一次 Review Run 跑到
 * 一半才发现某个模型没法用。
 */
export function buildReviewers(
  config: Config,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Reviewer[] {
  return config.reviewers.map((spec) => {
    const apiKey = env[spec.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(`环境变量 ${spec.apiKeyEnv} 未设置,${spec.model} 无法使用`);
    }
    return createPiReviewer({
      provider: spec.provider,
      model: spec.model,
      apiKey,
    });
  });
}
