import type {
  Category,
  Finding,
  FindingVerdict,
  RawFinding,
  RawVerdict,
  ReviewVerdict,
  Severity,
} from "../review/finding.ts";

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
      // title / impact / suggestion 为空不算异常:呈现层跳过空段,不为排版丢 Finding。
      title: typeof raw.title === "string" ? raw.title.trim() : "",
      description: raw.description.trim(),
      impact: typeof raw.impact === "string" ? raw.impact.trim() : "",
      suggestion: typeof raw.suggestion === "string" ? raw.suggestion.trim() : "",
      model,
    },
  };
}

/**
 * 复核结论的取值是 present / fixed / unclear,同义词一并收下,理由同 severity:
 * 收窄枚举会让模型自造词汇、调用被拒(ADR 0004)。
 */
const VERDICT: Record<string, ReviewVerdict> = {
  present: "present",
  still_present: "present",
  unfixed: "present",
  fixed: "fixed",
  resolved: "fixed",
  unclear: "unclear",
  unknown: "unclear",
};

/**
 * 归一化一条复核结论。id 不是正整数即无从对应到历史条目,丢弃;词映射不上按
 * 「无法判断」收——保守优先,而漏给结论本来就是这一档(ADR 0016)。
 */
export function normalizeVerdict(raw: RawVerdict): FindingVerdict | undefined {
  if (!Number.isInteger(raw.id) || raw.id < 1) return undefined;
  return {
    findingId: raw.id,
    verdict: VERDICT[canonical(String(raw.verdict))] ?? "unclear",
  };
}
