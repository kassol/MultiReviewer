import { readFileSync } from "node:fs";

import type { Reviewer } from "./review/finding.ts";
import { createPiReviewer } from "./reviewer/pi-reviewer.ts";

/** 模型组合是全局的,所有仓库共用一组。 */
export type ReviewerSpec = {
  /** Pi 的 provider 标识。 */
  provider: string;
  /** Pi 的 model 标识。模型标识另取 `modelIdentity`。 */
  model: string;
  /**
   * 存放该厂商凭据的环境变量名。凭据搬进库之后(ADR 0008)组装 Reviewer 不再读它,
   * 字段还留着只是为了不在这一票里动配置文件的形状,issue #66 删。
   */
  apiKeyEnv: string;
};

/**
 * 模型标识:`provider:model`。Finding 与 Reviewer 的统计都按它归属来源。
 *
 * 带 provider 段是因为 Pi 目录里有 216 个 model id 跨 provider 重复;分隔用冒号而非
 * 斜杠,是因为部分 model id 本身带斜杠,首次出现的冒号即边界。
 */
export function modelIdentity(spec: { provider: string; model: string }): string {
  return `${spec.provider}:${spec.model}`;
}

export type Config = {
  reviewers: ReviewerSpec[];
  /**
   * 一批最多多少改动行。超过即按文件分批,同一文件的改动不跨批。
   * 不配置时取 `DEFAULT_MAX_CHANGED_LINES_PER_BATCH`。
   */
  maxChangedLinesPerBatch?: number;
};

export const DEFAULT_CONFIG_PATH = "multireviewer.config.json";

/**
 * 校验一组 ReviewerSpec 并返回。配置文件与面板的每仓库模型覆盖共用这套判据,
 * `context` 写进报错里指认来源(文件路径或仓库)。
 */
export function assertReviewerSpecs(value: unknown, context: string): ReviewerSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`至少配置一个 Reviewer: ${context}`);
  }

  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    for (const field of ["provider", "model", "apiKeyEnv"] as const) {
      const fieldValue = (entry as Record<string, unknown>)[field];
      if (typeof fieldValue !== "string" || fieldValue === "") {
        throw new Error(`reviewers[${index}] 缺少 ${field}: ${context}`);
      }
    }
    const identity = modelIdentity(entry as ReviewerSpec);
    if (seen.has(identity)) {
      // Finding 以模型标识归属来源,标识重复就分不清是哪一个 Reviewer 提的。
      // 键是完整标识:同一个 model id 在两家 provider 下是两个 Reviewer,可共存。
      throw new Error(`模型标识重复: ${identity}`);
    }
    seen.add(identity);
  }
  return value as ReviewerSpec[];
}

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

  const reviewers = assertReviewerSpecs((parsed as { reviewers?: unknown }).reviewers, path);

  const maxChangedLinesPerBatch = (parsed as { maxChangedLinesPerBatch?: unknown })
    .maxChangedLinesPerBatch;
  if (
    maxChangedLinesPerBatch !== undefined &&
    (typeof maxChangedLinesPerBatch !== "number" ||
      !Number.isInteger(maxChangedLinesPerBatch) ||
      maxChangedLinesPerBatch <= 0)
  ) {
    throw new Error(`maxChangedLinesPerBatch 必须是正整数: ${path}`);
  }

  return {
    reviewers: reviewers as ReviewerSpec[],
    ...(maxChangedLinesPerBatch === undefined ? {} : { maxChangedLinesPerBatch }),
  };
}

/**
 * 一次 Review Run 开始时取到的模型凭据:provider → 明文 key。快照在编排进程里解密
 * 得到,整轮不重读(ADR 0008)——轮转对进行中的 Run 无影响,下一次投递自然用新的。
 */
export type CredentialSnapshot = ReadonlyMap<string, string>;

/**
 * 缺凭据的 provider 照样建出一个 Reviewer,它一跑就报失败并写明缺哪一家。
 *
 * 这里不抛:抛出去的话这次投递在时间线上一点痕迹都不留,人看到的是「投了没反应」。
 * 报成 Reviewer 失败则这次 Review Run 留下一条失败记录,原因跟着落库。
 */
function missingCredentialReviewer(spec: ReviewerSpec): Reviewer {
  const identity = modelIdentity(spec);
  return {
    model: identity,
    review: () =>
      Promise.resolve({
        model: identity,
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        failure: `没有配置 ${spec.provider} 的模型凭据,${identity} 这次没跑。去面板的凭据页配好再重跑。`,
      }),
  };
}

/**
 * 按模型组合建出全部 Reviewer,每个只拿到自己那一家的凭据。
 *
 * 凭据来自 Review Run 开始时的快照,缺失不拦启动也不拦投递:服务照常起,那一家的
 * Reviewer 报失败(issue #65)。
 */
export function buildReviewers(
  specs: readonly ReviewerSpec[],
  credentials: CredentialSnapshot,
): Reviewer[] {
  return specs.map((spec) => {
    const apiKey = credentials.get(spec.provider);
    if (apiKey === undefined || apiKey === "") return missingCredentialReviewer(spec);
    return createPiReviewer({
      provider: spec.provider,
      model: spec.model,
      apiKey,
    });
  });
}
