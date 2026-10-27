/** 模型规格覆盖的 HTTP 契约。缺席的覆盖字段恢复自动值，空映射保留为显式覆盖。 */
export type ModelSpecOverrides = {
  input?: readonly ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  compat?: Record<string, unknown>;
};

export type BoundModelSpecOverride = { model: string; targetFingerprint: string; overrides: ModelSpecOverrides };

export type ModelSpecFields = { [K in keyof Required<ModelSpecOverrides>]: ModelSpecOverrides[K] | null };

export type ModelSpecProjection = {
  currentVersion: number;
  targetFingerprint: string | null;
  automaticFields: ModelSpecFields;
  overrides: ModelSpecOverrides;
  effectiveFields: ModelSpecFields;
};

export type ModelSpecMutation = { expectedVersion: number; overrides: ModelSpecOverrides };
export type ModelSpecMutationResponse = ModelSpecProjection & { provider: string; model: string };
export type ModelSpecConflictResponse = {
  error: string;
  expectedVersion: number;
  actualVersion: number | null;
  current: ModelSpecMutationResponse | null;
};
