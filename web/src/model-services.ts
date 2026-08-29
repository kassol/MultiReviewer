/**
 * `GET /model-services` 的共享前端契约。模型服务页与两处模型组合编辑器只读这一份查询；
 * 候选已经按完整 `provider:model` 标识合并来源并带服务端可用性结论。
 */
import { useQuery } from "@tanstack/react-query";

import { fetchJson } from "./api.ts";

export type ModelServiceHealth = "healthy" | "attention" | "disabled";
export type ModelCredentialState = "unconfigured" | "pending-reverification" | "verified";
export type ModelDirectoryState =
  | "undiscovered"
  | "available"
  | "refresh-failed"
  | "discovery-failed";
export type ModelSource = "automatic" | "manual" | "migration-retention";
export type ModelUnavailableReason =
  | "provider-name-conflict"
  | "credential-unavailable"
  | "model-source-missing"
  | "model-disabled";
export type ModelServiceNextAction =
  | "recover-service"
  | "configure-credential"
  | "add-model-source"
  | "enable-model";
export type ModelReferenceLocation =
  | { kind: "global" }
  | { kind: "following-global"; repositoryCount: number }
  | { kind: "repository-override"; repoId: number; owner: string; repo: string };
export type ModelReference = {
  identity: string;
  provider: string;
  model: string;
  locations: ModelReferenceLocation[];
};

export type ModelDiscoveryFieldSource = "service-interface" | "pi-catalog" | "service-target";
export type ModelRuntimeFieldSource = ModelDiscoveryFieldSource | "runtime-baseline" | "unknown";

export type ModelServiceModel = {
  provider: string;
  id: string;
  identity: string;
  enabled: boolean;
  sources: readonly ModelSource[];
  available: boolean;
  unavailableReason: ModelUnavailableReason | null;
  unavailableReasonText: string | null;
  unavailableAction: "/credentials" | null;
  discovery: {
    name: string | null;
    api: string | null;
    baseUrl: string | null;
    input: readonly ("text" | "image")[] | null;
    reasoning: boolean | null;
    contextWindow: number | null;
    maxOutput: number | null;
    sources: {
      name: ModelDiscoveryFieldSource | null;
      api: ModelDiscoveryFieldSource | null;
      baseUrl: ModelDiscoveryFieldSource | null;
      input: ModelDiscoveryFieldSource | null;
      reasoning: ModelDiscoveryFieldSource | null;
      contextWindow: ModelDiscoveryFieldSource | null;
      maxOutput: ModelDiscoveryFieldSource | null;
    };
  };
  runtime: {
    input: readonly ("text" | "image")[];
    reasoning: boolean;
    contextWindow: number;
    maxOutput: number;
    sources: {
      input: ModelRuntimeFieldSource;
      reasoning: ModelRuntimeFieldSource;
      contextWindow: ModelRuntimeFieldSource;
      maxOutput: ModelRuntimeFieldSource;
    };
  };
};

export type ModelService = {
  version: number;
  provider: string;
  name: string;
  type: "builtin" | "custom";
  health: ModelServiceHealth;
  runCapability: {
    runnable: boolean;
    reason: ModelUnavailableReason | null;
    reasonText: string | null;
    nextAction: ModelServiceNextAction | null;
  };
  providerState?: "normal" | "name-conflict";
  target?: { baseUrl: string | null; api: string | null };
  credential: {
    state: ModelCredentialState;
    last4?: string | null;
    updatedAt?: string | null;
    verifiedAt?: string | null;
    validationModel?: string | null;
    verificationSource?: "legacy-provider-check" | "legacy-review-run" | "inference" | null;
  };
  directory?: {
    state: ModelDirectoryState;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    failure: string | null;
    ignoredModelCount: number;
  };
  references?: readonly ModelReference[];
  models?: readonly ModelServiceModel[];
};

export type ModelServicesResponse = {
  services: ModelService[];
  /** 只有 `model:read` 可见；凭据只读会话拿不到模型字段。 */
  candidates?: ModelServiceModel[];
};

export const SOURCE_LABEL: Record<ModelSource, string> = {
  automatic: "自动发现",
  manual: "模型补录",
  "migration-retention": "迁移保留",
};

export function useModelServices(enabled = true) {
  return useQuery({
    queryKey: ["model-services"],
    queryFn: () => fetchJson<ModelServicesResponse>("/model-services"),
    enabled,
  });
}

/** 模型标识：`provider:model`，与后端 `modelIdentity` 同一形状。 */
export function modelIdentity(spec: { provider: string; model: string }): string {
  return `${spec.provider}:${spec.model}`;
}

/** 标识拆回原有 ReviewerSpec；model id 本身允许带冒号，只切第一个。 */
export function parseModelIdentity(identity: string): { provider: string; model: string } {
  const at = identity.indexOf(":");
  return { provider: identity.slice(0, at), model: identity.slice(at + 1) };
}

/**
 * 思考档位的取值与展示名(CONTEXT.md)。与服务端 `THINKING_LEVELS` 逐字一致;`off` 与
 * 不设这个字段同义,控件选回 `off` 即把字段去掉,组合里因此不留一堆等同默认的值。
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LEVEL_LABEL: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
};

/** 编辑器里的一处模型引用:模型标识加它自己的思考档位。 */
export type ModelRef = { identity: string; thinkingLevel?: ThinkingLevel };

/** 后端的一项模型组合 → 编辑器里的一处模型引用。 */
export function toModelRef(spec: {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}): ModelRef {
  return {
    identity: modelIdentity(spec),
    ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel }),
  };
}

/** 编辑器里的一处模型引用 → 后端的一项模型组合。 */
export function fromModelRef(ref: ModelRef): {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
} {
  return {
    ...parseModelIdentity(ref.identity),
    ...(ref.thinkingLevel === undefined ? {} : { thinkingLevel: ref.thinkingLevel }),
  };
}
