import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { isoTimestamp } from "./columns.ts";

/**
 * 范围审查(ADR 0012):人在面板发起的一个阶段性审查,不依赖任何既有 pull request。
 * 不引用 repo(id):仓库移除后评审记录只写不清,范围审查同理。
 */
export const rangeReview = pgTable(
  "range_review",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    repoId: integer("repo_id").notNull(),
    owner: text().notNull(),
    repo: text().notNull(),
    /** 发起时由人给的标题(issue #177),发起后不可改。升级前的旧行是 NULL。 */
    title: text(),
    baseSha: text("base_sha").notNull(),
    comparisonSha: text("comparison_sha").notNull(),
    /** 选定当前比较项时用的分支或 Tag(issue #234),不是历史事实。 */
    comparisonSourceKind: text("comparison_source_kind"),
    comparisonSourceName: text("comparison_source_name"),
    state: text().notNull(),
    containerPullNumber: integer("container_pull_number"),
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
    completedBy: text("completed_by"),
    completedAt: isoTimestamp("completed_at"),
    /** 最近一次 Forge 操作的失败原因。是权限还是分支保护,只有这一行能说明。 */
    lastForgeFailure: text("last_forge_failure"),
    /** 每日增量(issue #313)。关着时分支与开启时刻都是 NULL。 */
    dailyIncrementEnabled: boolean("daily_increment_enabled").notNull().default(false),
    dailyIncrementBranch: text("daily_increment_branch"),
    dailyIncrementEnabledAt: isoTimestamp("daily_increment_enabled_at"),
    /** 最近一次定时检查的时刻与结果(issue #314)。只留一条,新的覆盖旧的。 */
    scheduledCheckAt: isoTimestamp("scheduled_check_at"),
    scheduledCheckResult: text("scheduled_check_result"),
    /** 每天几点检查(本地时区 HH:mm)与检查模式(issue #315)。 */
    scheduledCheckTime: text("scheduled_check_time").notNull().default("00:00"),
    scheduledCheckMode: text("scheduled_check_mode").notNull().default("verdict-only"),
  },
  (t) => [index("range_review_by_base").on(t.owner, t.repo, t.baseSha)],
);

/**
 * 范围审查先后审过的每一个比较项(issue #157)。当前那个在 rangeReview.comparisonSha 上,
 * 这张表留的是整段历史。
 */
export const rangeReviewComparison = pgTable(
  "range_review_comparison",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    rangeReviewId: integer("range_review_id").notNull(),
    sha: text().notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: isoTimestamp("recorded_at").notNull(),
  },
  (t) => [index("range_review_comparison_by_review").on(t.rangeReviewId)],
);
