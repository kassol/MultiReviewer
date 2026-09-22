import { boolean, index, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";
import { isoTimestamp, jsonText } from "./columns.ts";

export const reviewRun = pgTable(
  "review_run",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    owner: text().notNull(),
    repo: text().notNull(),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    /** 开跑时那个 pull request 的标题快照;范围审查那一档为 NULL。 */
    title: text(),
    /** 属于哪个范围审查(ADR 0012)。PR 触发的为 NULL。 */
    rangeReviewId: integer("range_review_id"),
    /** pull request 的状态,closed 回填写上(ADR 0006)。 */
    prState: text("pr_state"),
    /** 手动重跑的调用者用户名快照,NULL 即投递。刻意不引用 panel_user:删号后历史保留。 */
    triggeredBy: text("triggered_by"),
    /** 这一轮被谁开出来(issue #312):投递、面板,或定时检查。 */
    triggerSource: text("trigger_source"),
    startedAt: isoTimestamp("started_at").notNull(),
    finishedAt: isoTimestamp("finished_at"),
    durationMs: integer("duration_ms"),
    changedFiles: integer("changed_files").notNull(),
    changedLines: integer("changed_lines").notNull(),
    batchCount: integer("batch_count").notNull(),
    /** 全部 Reviewer 都失败(ADR 0016 据它决定不做自动处置)。 */
    failed: boolean(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    totalTokens: integer("total_tokens"),
    /** 开跑时生效的规则集版本,没有规则集时为 NULL。 */
    ruleSetVersion: integer("rule_set_version"),
    /** 本轮指令(issue #225):只属于这一轮的一次性要求。 */
    directive: text(),
    /** 这一轮的模式(issue #242)。NULL 读作完整审查。 */
    mode: text(),
    /** 开跑时的历史 Finding 快照(issue #248),续跑的批次读它。NULL 即续跑不成立。 */
    historyJson: jsonText("history_json"),
    /** 轮次级的失败原因(ADR 0026,issue #256)。NULL 即收尾正常,与 failed 分开记。 */
    failure: text(),
    /** 开跑时冻结的完整批次计划(issue #253),JSON 数组套数组。NULL 即续跑不成立。 */
    batchPlanJson: jsonText("batch_plan_json"),
    /** 开跑时生效的最低报告等级(issue #271)。NULL 读作 P2。 */
    minReportSeverity: text("min_report_severity"),
    /** 开跑时冻结的辅助模型(ADR 0029,issue #304),一处 ReviewerSpec 的 JSON。 */
    auxiliaryModel: jsonText("auxiliary_model"),
  },
  (t) => [
    index("review_run_by_pr").on(t.owner, t.repo, t.pullNumber),
    index("review_run_by_range").on(t.rangeReviewId),
  ],
);

export const reviewRunReviewerPin = pgTable(
  "review_run_reviewer_pin",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    position: integer().notNull(),
    identity: text().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    modelServiceVersion: integer("model_service_version"),
    baseUrl: text("base_url"),
    api: text(),
    runtimeModelJson: jsonText("runtime_model_json"),
    materializationFailure: text("materialization_failure"),
    thinkingLevel: text("thinking_level"),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.position] }),
    unique("review_run_reviewer_pin_run_id_identity_key").on(t.runId, t.identity),
  ],
);

/**
 * 一个 Reviewer 在一批上跑完就落一行(issue #410,ADR 0024 的 2026-09-21 修订)。中间态刻意与
 * reviewer_outcome / finding 分表:事后统计只认已结束的轮次,这里的行不进任何分母。
 */
export const reviewRunBatchOutcome = pgTable(
  "review_run_batch_outcome",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    batchIndex: integer("batch_index").notNull(),
    model: text().notNull(),
    outcomeJson: jsonText("outcome_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.batchIndex, t.model] })],
);

export const reviewerOutcome = pgTable("reviewer_outcome", {
  id: integer().generatedByDefaultAsIdentity().primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => reviewRun.id),
  model: text().notNull(),
  failure: text(),
  findingCount: integer("finding_count").notNull(),
  anomalyCount: integer("anomaly_count").notNull(),
  rejectedToolCalls: integer("rejected_tool_calls").notNull(),
  anchorRejections: integer("anchor_rejections").notNull().default(0),
  durationMs: integer("duration_ms").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  totalTokens: integer("total_tokens"),
});

/**
 * 一条 Finding 一行:Finding Identity 是「同一处的同一问题」,不含模型(ADR 0030)。报出它的
 * 每个模型各记一条 finding_attribution,同一处问题只有这一行、只有一条 Forge 评论。
 */
export const finding = pgTable(
  "finding",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    file: text().notNull(),
    line: integer().notNull(),
    severity: text().notNull(),
    category: text().notNull(),
    title: text(),
    description: text().notNull(),
    /** 代表段的影响与建议(issue #278)。两列同为 NULL 即升级前落的行。 */
    impact: text(),
    suggestion: text(),
    fingerprint: text(),
    groupIndex: integer("group_index").notNull(),
    disposition: text().notNull().default("unknown"),
    /** 进了行级评论(inline)还是 review 正文(body)。body 行排除在处置率统计外(ADR 0006)。 */
    placement: text().notNull().default("inline"),
    /** 承载它的那条 Forge 行级评论。正文 fallback 与升级前的历史行为 NULL。 */
    commentId: text("comment_id"),
    commentHtmlUrl: text("comment_html_url"),
    /** 处置人与时刻。回填链路不写这两列;自动处置只写 disposedAt。 */
    disposedBy: text("disposed_by"),
    disposedAt: isoTimestamp("disposed_at"),
    /** 处置备注:只存面板,不写入 Forge。 */
    dispositionNote: text("disposition_note"),
    /** 承接的那条旧评论在 Forge 页面上的地址(issue #167)。 */
    continuedFrom: text("continued_from"),
    /** 交接未完成(ADR 0025,issue #252):旧评论还留在 Forge 上待关闭。 */
    handoffPending: boolean("handoff_pending"),
    /** 行作者(issue #198):四列要么一起有值、要么一起是 NULL。 */
    lineAuthorSha: text("line_author_sha"),
    lineAuthorName: text("line_author_name"),
    lineAuthorEmail: text("line_author_email"),
    lineAuthorAt: isoTimestamp("line_author_at"),
    /** 行作者取自相邻改动(issue #241)。NULL 读回按 false。 */
    lineAuthorAdjacent: boolean("line_author_adjacent"),
    /** 命中的那条评审规则,没有命中或升级前落的行为 NULL。 */
    ruleId: integer("rule_id"),
    /** 此刻的位置与定下它的那一轮(issue #368)。两列同 NULL 即「与 line / run_id 相同」。 */
    placedLine: integer("placed_line"),
    placedRunId: integer("placed_run_id").references(() => reviewRun.id),
  },
  (t) => [
    index("finding_by_run").on(t.runId),
    // 回填按「文件 + 指纹」改行。
    index("finding_by_anchor").on(t.file, t.fingerprint),
  ],
);

/**
 * 一条 Finding 的归属:报出它的每个模型一行(ADR 0015)。position 是首报先后,0 即首报。
 * 同一模型允许多条归属——模型对同一处报出内容不同的几条时全部保留(检出率优先,2026-08-31)。
 */
export const findingAttribution = pgTable(
  "finding_attribution",
  {
    findingId: integer("finding_id")
      .notNull()
      .references(() => finding.id),
    position: integer().notNull(),
    model: text().notNull(),
    severity: text().notNull(),
    category: text().notNull(),
    description: text().notNull(),
    /** 空串即模型没给;NULL 只出现在升级前落的行上。 */
    impact: text(),
    suggestion: text(),
  },
  (t) => [
    primaryKey({ columns: [t.findingId, t.position] }),
    index("finding_attribution_by_model").on(t.model),
  ],
);

/**
 * 延续承接来的历史说法(issue #267)。它不是本轮的归属:参与条数与各处统计都不读这张表。
 */
export const findingCarriedAttribution = pgTable(
  "finding_carried_attribution",
  {
    findingId: integer("finding_id")
      .notNull()
      .references(() => finding.id),
    position: integer().notNull(),
    model: text().notNull(),
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    description: text().notNull(),
    impact: text(),
    suggestion: text(),
  },
  (t) => [primaryKey({ columns: [t.findingId, t.position] })],
);

/**
 * 一轮里每个 Reviewer 对每条未处置历史 Finding 的复核结论(ADR 0016)。漏给结论的按「无法
 * 判断」照样落一行并标 missing;missingReason 说的是为什么没结论(issue #412、#413)。
 */
export const findingVerdict = pgTable(
  "finding_verdict",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    model: text().notNull(),
    findingId: integer("finding_id")
      .notNull()
      .references(() => finding.id),
    verdict: text().notNull(),
    missing: boolean().notNull().default(false),
    missingReason: text("missing_reason"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.model, t.findingId] })],
);

/**
 * 同根因组(ADR 0030,issue #308)。组属于轮次,每轮重新提,不跨轮次保持同一性——因此没有
 * 阶段维度的键,也没有更新路径:一轮收尾时写一次,之后只读。
 */
export const rootCauseGroup = pgTable(
  "root_cause_group",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    /** 根因说明:合并 agent 写的那一句中文。 */
    reason: text().notNull(),
  },
  (t) => [index("root_cause_group_by_run").on(t.runId)],
);

export const rootCauseGroupMember = pgTable(
  "root_cause_group_member",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => rootCauseGroup.id),
    findingId: integer("finding_id")
      .notNull()
      .references(() => finding.id),
    position: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.findingId] })],
);

/**
 * 一轮 Review Run 的审查轨迹(ADR 0017)。seq 在一轮之内自增,断线续传按它续;轮次级事件的
 * reviewer 为 NULL。随 Review Run 永久保留。
 */
export const reviewTrace = pgTable(
  "review_trace",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id),
    seq: integer().notNull(),
    at: isoTimestamp().notNull(),
    scope: text().notNull(),
    reviewer: text(),
    kind: text().notNull(),
    payload: jsonText().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);
