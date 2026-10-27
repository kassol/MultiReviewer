import type { ModelSpecCandidate, ModelSpecOverrides, ModelSpecProjection } from "../../../src/contracts/model-specs.ts";

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

/** 目录里同一型号的候选组按字段摊开(2026-10-27):值相同的组合并成一项。 */
export type ModelSpecCandidateChoice = {
  candidateId: string;
  label: string;
  labels: readonly string[];
  official: boolean;
  value: NonNullable<ModelSpecOverrides[ModelSpecField]>;
};

export function modelSpecCandidateChoices(
  candidates: readonly ModelSpecCandidate[],
  field: ModelSpecField,
): ModelSpecCandidateChoice[] {
  const groups = new Map<string, { candidateId: string; labels: string[]; official: boolean; officialLabel?: string; value: NonNullable<ModelSpecOverrides[ModelSpecField]> }>();
  for (const candidate of candidates) {
    const value = candidate.values[field];
    if (value === undefined) continue;
    const key = stableModelSpecValue(value);
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.labels.push(candidate.label);
      existing.official ||= candidate.official;
      if (candidate.official) existing.officialLabel = candidate.label;
      continue;
    }
    groups.set(key, {
      candidateId: candidate.id,
      labels: [candidate.label],
      official: candidate.official,
      ...(candidate.official ? { officialLabel: candidate.label } : {}),
      value: value as NonNullable<ModelSpecOverrides[ModelSpecField]>,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      candidateId: group.candidateId,
      labels: group.labels,
      official: group.official,
      value: group.value,
      label: group.labels.length === 1 ? group.labels[0]! : `${group.officialLabel ?? group.labels[0]} 等 ${group.labels.length} 组`,
    }))
    .sort((left, right) => Number(right.official) - Number(left.official));
}

/** 一个字段此刻的值:自动、某一组候选,或人自己填的第三个数。 */
export function modelSpecSourceChoice(
  draft: ModelSpecDraft,
  field: ModelSpecField,
  choices: readonly ModelSpecCandidateChoice[],
): string {
  if (!draft.enabled[field]) return "auto";
  const value = draftFieldValue(draft, field);
  return choices.find((choice) => stableModelSpecValue(choice.value) === stableModelSpecValue(value))?.candidateId ?? "manual";
}

/** 把某一组或自动值填进草稿,不改「是否覆盖」——切到手动时用它起一个已知的初值。 */
export function withModelSpecValue(
  draft: ModelSpecDraft,
  field: ModelSpecField,
  value: NonNullable<ModelSpecOverrides[ModelSpecField]>,
): ModelSpecDraft {
  switch (field) {
    case "input":
      return { ...draft, input: [...(value as readonly ("text" | "image")[])] };
    case "reasoning":
      return { ...draft, reasoning: value === true };
    case "contextWindow":
      return { ...draft, contextWindow: String(value) };
    case "maxTokens":
      return { ...draft, maxTokens: String(value) };
    case "thinkingLevelMap":
      return { ...draft, thinkingLevelMap: JSON.stringify(value, null, 2) };
    case "compat":
      return { ...draft, compat: JSON.stringify(value, null, 2) };
  }
}

/** 选中某一组:把那一组在这个字段上的值填进草稿,并标成覆盖。 */
export function withModelSpecCandidate(
  draft: ModelSpecDraft,
  field: ModelSpecField,
  value: NonNullable<ModelSpecOverrides[ModelSpecField]>,
): ModelSpecDraft {
  return { ...withModelSpecValue(draft, field, value), enabled: { ...draft.enabled, [field]: true } };
}

function draftFieldValue(draft: ModelSpecDraft, field: ModelSpecField): unknown {
  switch (field) {
    case "input":
      return draft.input;
    case "reasoning":
      return draft.reasoning;
    case "contextWindow":
      return numberOrText(draft.contextWindow);
    case "maxTokens":
      return numberOrText(draft.maxTokens);
    case "thinkingLevelMap":
      return jsonOrText(draft.thinkingLevelMap);
    case "compat":
      return jsonOrText(draft.compat);
  }
}

function numberOrText(text: string): unknown {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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
