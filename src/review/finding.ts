export type Severity = "high" | "medium" | "low";

export type Category = "security" | "bug" | "maintainability" | "design";

/**
 * 一条被提出的代码问题。归属于提出它的 Reviewer,并指向 Review Range 内的具体位置。
 *
 * `line` 是 head commit 中该文件的 1-indexed 行号。
 */
export type Finding = {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  description: string;
  /** 提出它的 Reviewer 所绑定的模型标识。 */
  model: string;
};

/** 一次 Review Run 覆盖的代码范围。`baseSha` 是 merge-base,不是 base 分支尖端。 */
export type ReviewRange = {
  baseSha: string;
  headSha: string;
  files: string[];
};

/**
 * Reviewer 经 `report_finding` 报出的、尚未归一化的条目。
 *
 * `severity` 与 `category` 是宽松字符串:用字面量联合强制时模型会自造词汇导致调用
 * 被拒、Finding 全部丢失(prototype 实测,见 ADR 0004)。归一化在服务端做。
 */
export type RawFinding = {
  file: string;
  line: number;
  severity: string;
  category: string;
  description: string;
};

/** 一个 Reviewer 一次执行的用量与成本,由 harness 自己统计。 */
export type ReviewerUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** harness 依自身的定价表折算出的美元成本。 */
  costUsd: number;
};

/** 一个 Reviewer 跑完之后的全部产出,含失败与异常,而不只是 Finding。 */
export type ReviewerOutcome = {
  model: string;
  findings: Finding[];
  /** 归一化失败的条目。记录下来,不静默丢弃。 */
  anomalies: { raw: RawFinding; reason: string }[];
  /** 被 Pi 校验拒绝的工具调用次数。不为零而 findings 为零即契约失配。 */
  rejectedToolCalls: number;
  /** 有值即该 Reviewer 失败,其 findings 不代表"代码没问题"。 */
  failure?: string;
  /** 子进程未回报结果即退出时取不到用量。 */
  usage?: ReviewerUsage;
};

/** 绑定了具体模型的审查执行体。 */
export interface Reviewer {
  readonly model: string;
  review(range: ReviewRange, worktreePath: string): Promise<ReviewerOutcome>;
}
