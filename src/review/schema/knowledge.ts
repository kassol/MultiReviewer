import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { isoTimestamp, jsonText } from "./columns.ts";
import { repo } from "./repos.ts";

/**
 * 知识集版本(CONTEXT.md)。有没有行就是「这个仓库确认过知识集没有」的判据:空知识集是合法
 * 状态,它与「还没确认」在规则行上分不出来,只有这张表分得出。
 */
export const ruleSetVersion = pgTable(
  "rule_set_version",
  {
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    version: integer().notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.version] }),
    check("rule_set_version_positive", sql`${t.version} > 0`),
  ],
);

/**
 * 知识条目(CONTEXT.md)。两态生命周期不另存历史表:effectiveVersion 是它进集的那一版,
 * retiredVersion 是它被废止的那一版(NULL 即仍生效)。
 *
 * layer 是退役的层标签:代码不再读也不再写新值,新行一律空串,存量行原样留着。
 */
export const reviewRule = pgTable(
  "review_rule",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    type: text().notNull().default("rule"),
    scope: text().notNull(),
    statement: text().notNull(),
    layer: text().notNull(),
    state: text().notNull(),
    origin: text().notNull(),
    effectiveVersion: integer("effective_version").notNull(),
    retiredVersion: integer("retired_version"),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [
    index("review_rule_by_repo").on(t.repoId),
    check("review_rule_type", sql`${t.type} IN ('rule', 'fact')`),
    check("review_rule_state", sql`${t.state} IN ('active', 'retired')`),
    check(
      "review_rule_state_matches_retirement",
      sql`(${t.state} = 'active') = (${t.retiredVersion} IS NULL)`,
    ),
  ],
);

/**
 * 基点探索(issue #205)。每仓库至多一行:重新探索覆盖上一次的那一行,「同仓库同时只跑一个」
 * 因此就是这一行的 state 是不是 running。model / thinkingLevel 只作历史(issue #304)。
 */
export const ruleExploration = pgTable(
  "rule_exploration",
  {
    repoId: integer("repo_id")
      .primaryKey()
      .references(() => repo.id),
    baselineSha: text("baseline_sha").notNull(),
    model: text().notNull(),
    thinkingLevel: text("thinking_level"),
    traceTaskId: integer("trace_task_id"),
    state: text().notNull(),
    failure: text(),
    startedAt: isoTimestamp("started_at").notNull(),
    finishedAt: isoTimestamp("finished_at"),
  },
  (t) => [check("rule_exploration_state", sql`${t.state} IN ('running', 'failed', 'completed')`)],
);

/**
 * 知识整理(issue #284)。与基点探索同形而另成一张表:`rule_exploration` 的 `baselineSha`
 * 是探索独有的输入,互斥判的是两张表里有没有 running。
 */
export const ruleConsolidation = pgTable(
  "rule_consolidation",
  {
    repoId: integer("repo_id")
      .primaryKey()
      .references(() => repo.id),
    model: text().notNull(),
    thinkingLevel: text("thinking_level"),
    traceTaskId: integer("trace_task_id"),
    state: text().notNull(),
    failure: text(),
    merged: integer(),
    retargeted: integer(),
    proposed: integer(),
    startedAt: isoTimestamp("started_at").notNull(),
    finishedAt: isoTimestamp("finished_at"),
  },
  (t) => [check("rule_consolidation_state", sql`${t.state} IN ('running', 'failed', 'completed')`)],
);

/**
 * 修订意图(ADR 0028,issue #294)。每仓库多行:一个人写下一段话即一行,自带三态与自己的
 * 知识轨迹,行永久保留供轨迹回溯。
 */
export const ruleIntent = pgTable(
  "rule_intent",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    text: text().notNull(),
    submittedBy: text("submitted_by").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: integer("target_id"),
    state: text().notNull(),
    failure: text(),
    summary: text(),
    model: text(),
    thinkingLevel: text("thinking_level"),
    traceTaskId: integer("trace_task_id"),
    producedJson: jsonText("produced_json"),
    startedAt: isoTimestamp("started_at").notNull(),
    finishedAt: isoTimestamp("finished_at"),
  },
  (t) => [
    index("rule_intent_by_repo").on(t.repoId),
    check(
      "rule_intent_target_kind",
      sql`${t.targetKind} IN ('none', 'rule', 'proposal', 'draft', 'finding')`,
    ),
    check("rule_intent_state", sql`${t.state} IN ('running', 'failed', 'completed')`),
    check(
      "rule_intent_target_shape",
      sql`(${t.targetKind} = 'none') = (${t.targetId} IS NULL)`,
    ),
  ],
);

/** 知识草案(issue #205)。每仓库至多一份,重新探索覆盖未确认的旧草案。 */
export const ruleDraftItem = pgTable(
  "rule_draft_item",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    type: text().notNull().default("rule"),
    scope: text().notNull(),
    statement: text().notNull(),
    layer: text().notNull(),
    origin: text().notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [
    index("rule_draft_item_by_repo").on(t.repoId),
    check("rule_draft_item_type", sql`${t.type} IN ('rule', 'fact')`),
  ],
);

/**
 * 修订提案(issue #207)。targetRuleIds 是这条变更指向的现有条目:新增没有目标,修改与废止
 * 一条,合并两条以上(issue #282)。出处不在这张表上,见 ruleProposalSource。
 */
export const ruleProposal = pgTable(
  "rule_proposal",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    type: text().notNull().default("rule"),
    change: text().notNull(),
    targetRuleIds: jsonText("target_rule_ids").notNull().default("[]"),
    scope: text().notNull(),
    statement: text().notNull(),
    layer: text().notNull(),
    state: text().notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
    decidedAt: isoTimestamp("decided_at"),
  },
  (t) => [
    index("rule_proposal_by_repo").on(t.repoId),
    check("rule_proposal_type", sql`${t.type} IN ('rule', 'fact')`),
    check("rule_proposal_change", sql`${t.change} IN ('add', 'modify', 'retire', 'merge')`),
    check("rule_proposal_state", sql`${t.state} IN ('pending', 'accepted', 'rejected')`),
    check(
      "rule_proposal_pending_undecided",
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    check(
      "rule_proposal_add_has_no_target",
      sql`(${t.change} = 'add') = (${t.targetRuleIds} = '[]'::jsonb)`,
    ),
  ],
);

/**
 * 出处附注(issue #281)。一条提案的出处是一列附注,一行一条:一条提案会被多次来源提到,
 * 单值列只留得下最后一次,而人要看的正是「它被哪几件事提过」。
 */
export const ruleProposalSource = pgTable(
  "rule_proposal_source",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => ruleProposal.id),
    origin: text().notNull(),
    note: text(),
    evidence: text(),
    findingId: integer("finding_id"),
    traceTaskId: integer("trace_task_id"),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [
    index("rule_proposal_source_by_proposal").on(t.proposalId),
    check(
      "rule_proposal_source_origin",
      sql`${t.origin} IN ('baseline-exploration', 'disposition-feedback', 'knowledge-consolidation',
        'manual-proposal')`,
    ),
  ],
);

/**
 * 知识轨迹(issue #214)。一次基点探索、处置反哺、知识整理或人工提议是一条轨迹,taskId 标识
 * 它,seq 在一条轨迹之内自增。与 reviewTrace 分表:那张表的每一行都挂在一个 Review Run 上。
 */
export const ruleTrace = pgTable(
  "rule_trace",
  {
    /**
     * 任务标识由 identity 列发号(ADR 0036):起头那一条不给它,PostgreSQL 自己取下一个;
     * 同一条轨迹后面的每一条照旧显式写回同一个号。自己算 `MAX(task_id) + 1` 的话,两次
     * 并发起头会算出同一个号、主键当场撞上。
     */
    taskId: integer("task_id").notNull().generatedByDefaultAsIdentity(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    source: text().notNull(),
    seq: integer().notNull(),
    at: isoTimestamp().notNull(),
    kind: text().notNull(),
    payload: jsonText().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.seq] }),
    index("rule_trace_by_repo").on(t.repoId),
    check(
      "rule_trace_source",
      sql`${t.source} IN ('baseline-exploration', 'disposition-feedback', 'knowledge-consolidation',
        'manual-proposal')`,
    ),
  ],
);
