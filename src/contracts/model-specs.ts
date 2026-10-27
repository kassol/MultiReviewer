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

/**
 * 目录里同一个型号的一组候选元数据(2026-10-27)。一个自定义服务常能在 Pi 目录里匹配到
 * 多行(同一型号在几家转售站各有一份),每行各说各的容量;这里把它们逐行留着,面板按字段
 * 让人挑用哪一组,挑中的那一个值落成普通覆盖。`values` 里缺的字段表示这一行没给。
 */
export type ModelSpecCandidate = {
  id: string;
  label: string;
  official: boolean;
  values: {
    input?: readonly ("text" | "image")[];
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    thinkingLevelMap?: ModelSpecOverrides["thinkingLevelMap"];
    compat?: ModelSpecOverrides["compat"];
  };
};

export type ModelSpecProjection = {
  currentVersion: number;
  targetFingerprint: string | null;
  automaticFields: ModelSpecFields;
  overrides: ModelSpecOverrides;
  effectiveFields: ModelSpecFields;
  /** 不加任何手动覆盖时的生效值;面板用它说明「恢复自动会得到什么」。 */
  automaticEffectiveFields: ModelSpecFields;
  /** 目录里匹配到的候选组;空数组即没有匹配,自动值只剩运行基线。 */
  candidates: readonly ModelSpecCandidate[];
};

export type ModelSpecMutation = { expectedVersion: number; overrides: ModelSpecOverrides };
export type ModelSpecMutationResponse = ModelSpecProjection & { provider: string; model: string };
export type ModelSpecConflictResponse = {
  error: string;
  expectedVersion: number;
  actualVersion: number | null;
  current: ModelSpecMutationResponse | null;
};
