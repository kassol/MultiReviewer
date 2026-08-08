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

/** 绑定了具体模型的审查执行体。 */
export interface Reviewer {
  readonly model: string;
  review(range: ReviewRange, worktreePath: string): Promise<Finding[]>;
}
