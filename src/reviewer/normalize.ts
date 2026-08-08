import type { Category, Finding, RawFinding, Severity } from "../review/finding.ts";

export type { RawFinding };

export type NormalizeResult =
  | { ok: true; finding: Finding }
  | { ok: false; reason: string; raw: RawFinding };

const SEVERITY: Record<string, Severity> = {
  critical: "high",
  high: "high",
  major: "high",
  medium: "medium",
  moderate: "medium",
  minor: "low",
  low: "low",
  info: "low",
};

const CATEGORY: Record<string, Category> = {
  security: "security",
  bug: "bug",
  logic_error: "bug",
  reliability: "bug",
  correctness: "bug",
  performance: "bug",
  maintainability: "maintainability",
  style: "maintainability",
  design: "design",
  architecture: "design",
};

/** 模型给的词可能带大小写、首尾空白,或用空格与连字符代替下划线。 */
function canonical(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeFinding(raw: RawFinding, model: string): NormalizeResult {
  if (typeof raw.file !== "string" || raw.file.trim() === "") {
    return { ok: false, reason: "file 为空", raw };
  }
  if (typeof raw.description !== "string" || raw.description.trim() === "") {
    return { ok: false, reason: "description 为空", raw };
  }
  if (!Number.isInteger(raw.line) || raw.line < 1) {
    return { ok: false, reason: `line 不是正整数: ${raw.line}`, raw };
  }

  const severity = SEVERITY[canonical(String(raw.severity))];
  if (severity === undefined) {
    return { ok: false, reason: `severity 无法映射: ${raw.severity}`, raw };
  }

  const category = CATEGORY[canonical(String(raw.category))];
  if (category === undefined) {
    return { ok: false, reason: `category 无法映射: ${raw.category}`, raw };
  }

  return {
    ok: true,
    finding: {
      file: raw.file.trim(),
      line: raw.line,
      severity,
      category,
      description: raw.description.trim(),
      model,
    },
  };
}
