import type { ModelSpecOverrides, ModelSpecProjection } from "../../../src/contracts/model-specs.ts";

export const MODEL_SPEC_FIELDS = ["input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap", "compat"] as const;
export type ModelSpecField = typeof MODEL_SPEC_FIELDS[number];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ModelSpecDraft = {
  enabled: Record<ModelSpecField, boolean>;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
  contextWindow: string;
  maxTokens: string;
  thinkingLevelMap: string;
  compat: string;
};

export function modelSpecDraft(projection: ModelSpecProjection): ModelSpecDraft {
  const values = projection.effectiveFields;
  return {
    enabled: Object.fromEntries(MODEL_SPEC_FIELDS.map((field) => [field, Object.hasOwn(projection.overrides, field)])) as ModelSpecDraft["enabled"],
    input: [...(values.input ?? ["text"])],
    reasoning: values.reasoning ?? false,
    contextWindow: String(values.contextWindow ?? ""),
    maxTokens: String(values.maxTokens ?? ""),
    thinkingLevelMap: JSON.stringify(values.thinkingLevelMap ?? {}, null, 2),
    compat: JSON.stringify(values.compat ?? {}, null, 2),
  };
}

export function parseModelSpecDraft(draft: ModelSpecDraft): {
  overrides: ModelSpecOverrides;
  errors: Partial<Record<ModelSpecField, string>>;
  valid: boolean;
} {
  const overrides: ModelSpecOverrides = {};
  const errors: Partial<Record<ModelSpecField, string>> = {};
  if (draft.enabled.input) {
    if (draft.input.length === 0 || new Set(draft.input).size !== draft.input.length || draft.input.some((value) => value !== "text" && value !== "image")) {
      errors.input = "至少选择一种输入类型，仅支持 text 与 image。";
    } else overrides.input = [...draft.input];
  }
  if (draft.enabled.reasoning) overrides.reasoning = draft.reasoning;
  for (const field of ["contextWindow", "maxTokens"] as const) {
    if (!draft.enabled[field]) continue;
    const text = draft[field].trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
      errors[field] = "请输入 1–2147483647 之间的整数。";
    } else overrides[field] = value;
  }
  for (const field of ["thinkingLevelMap", "compat"] as const) {
    if (!draft.enabled[field]) continue;
    let value: unknown;
    try { value = JSON.parse(draft[field]); } catch {
      errors[field] = "请输入有效的 JSON 对象。";
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors[field] = "请输入 JSON 对象，空对象 {} 也可保存。";
    } else if (field === "thinkingLevelMap") {
      if (Object.entries(value).some(([key, entry]) => !THINKING_LEVELS.includes(key) || (entry !== null && typeof entry !== "string"))) {
        errors[field] = "仅支持 off、minimal、low、medium、high、xhigh、max，值须为字符串或 null。";
      } else overrides.thinkingLevelMap = value;
    } else overrides.compat = value as Record<string, unknown>;
  }
  return { overrides, errors, valid: Object.keys(errors).length === 0 };
}

export type ModelSpecEditor = {
  baseline: ModelSpecProjection;
  draft: ModelSpecDraft;
  targetFingerprint: string | null;
  targetUnavailable: boolean;
};

export function modelSpecEditor(projection: ModelSpecProjection): ModelSpecEditor {
  return { baseline: projection, draft: modelSpecDraft(projection), targetFingerprint: projection.targetFingerprint, targetUnavailable: projection.targetFingerprint === null };
}

/** 冲突只更换基线；目标变动后须显式重载，旧草稿不能跨目标提交。 */
export function rebaseModelSpecEditor(editor: ModelSpecEditor, current: ModelSpecProjection | null): ModelSpecEditor {
  return current === null
    ? { ...editor, targetUnavailable: true }
    : { ...editor, baseline: current, targetUnavailable: editor.targetUnavailable || current.targetFingerprint === null || current.targetFingerprint !== editor.targetFingerprint };
}

export function modelSpecTargetChanged(editor: ModelSpecEditor, latest: ModelSpecProjection): boolean {
  return editor.targetUnavailable || latest.targetFingerprint === null || latest.targetFingerprint !== editor.targetFingerprint || editor.baseline.targetFingerprint !== editor.targetFingerprint;
}

/** 键序无关的比较:一次原样保存不必再写一版,它会推进模型服务版本、让别的标签页的版本失效。 */
export function sameModelSpecOverrides(left: ModelSpecOverrides, right: ModelSpecOverrides): boolean {
  return stableModelSpecValue(left) === stableModelSpecValue(right);
}

function stableModelSpecValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableModelSpecValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableModelSpecValue(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
