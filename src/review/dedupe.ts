import type { Category, Finding, Severity } from "./finding.ts";

/**
 * 同一处问题被多个模型各自提出后合并的结果。
 *
 * 合并保留每一条来源 Finding:模型对同一个缺陷的表述常常不同,只留一条会丢掉
 * 另一个模型看到的角度。
 */
export type MergedFinding = {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  /** 以下四段取严重度最高的那条来源。 */
  title: string;
  description: string;
  impact: string;
  suggestion: string;
  /** 提出它的全部模型,按首次出现顺序。 */
  models: string[];
  sources: Finding[];
};

/**
 * 行号差在此范围内视为指向同一处。模型对同一个缺陷给出的行号常有一两行出入
 * (指到函数签名还是指到出错的那一行)。
 */
const LINE_TOLERANCE = 3;

/** 数字大的先行。合并后的那条取组内最高优先级。 */
const SEVERITY_RANK: Record<Severity, number> = { P0: 3, P1: 2, P2: 1 };

/**
 * 跨模型去重:同一文件且行号相差在阈值内的 Finding 合并为一条。
 *
 * 同一个模型自己报的两条也会被合并——它们同样指向同一处。
 */
export function dedupeFindings(findings: readonly Finding[]): MergedFinding[] {
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.file);
    if (list === undefined) byFile.set(finding.file, [finding]);
    else list.push(finding);
  }

  const merged: MergedFinding[] = [];
  for (const [file, fileFindings] of byFile) {
    const sorted = [...fileFindings].sort((a, b) => a.line - b.line);
    let group: Finding[] = [];

    const flush = (): void => {
      if (group.length > 0) merged.push(mergeGroup(file, group));
      group = [];
    };

    for (const finding of sorted) {
      const last = group.at(-1);
      // 与组内最后一条比较而非与组首:一串两两相近的 Finding 应当聚成一组。
      if (last !== undefined && finding.line - last.line > LINE_TOLERANCE) flush();
      group.push(finding);
    }
    flush();
  }

  return merged;
}

function mergeGroup(file: string, group: readonly Finding[]): MergedFinding {
  const leading = [...group].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )[0]!;

  const models: string[] = [];
  for (const finding of group) {
    if (!models.includes(finding.model)) models.push(finding.model);
  }

  return {
    file,
    // 取组内最小行号:偏保守,评论落在问题起始处而非中段。
    line: Math.min(...group.map((f) => f.line)),
    severity: leading.severity,
    category: leading.category,
    title: leading.title,
    description: leading.description,
    impact: leading.impact,
    suggestion: leading.suggestion,
    models,
    sources: [...group],
  };
}
