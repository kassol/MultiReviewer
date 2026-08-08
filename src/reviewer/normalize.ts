import type { Category, Finding, RawFinding, Severity } from "../review/finding.ts";

export type { RawFinding };

export type NormalizeResult =
  | { ok: true; finding: Finding }
  | { ok: false; reason: string; raw: RawFinding };

/**
 * 约定的取值是 P0 / P1 / P2,形容词一并收下:模型不总照约定报,而收窄枚举会让它
 * 自造词汇、调用被拒、Finding 全部丢失(ADR 0004)。宽松接收加服务端归一化是配套的。
 */
const SEVERITY: Record<string, Severity> = {
  p0: "P0",
  critical: "P0",
  high: "P0",
  major: "P0",
  blocker: "P0",
  p1: "P1",
  medium: "P1",
  moderate: "P1",
  p2: "P2",
  low: "P2",
  minor: "P2",
  info: "P2",
  nit: "P2",
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
