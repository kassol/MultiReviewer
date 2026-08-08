/**
 * Review Run 的持久化。用 Node 内置的 SQLite,不引入第三方驱动。
 *
 * Disposition 的权威状态在 Forge 上,`finding.disposition` 只缓存最近一次读回的
 * 结果,默认 `unknown`。
 */
import { DatabaseSync } from "node:sqlite";

import type { Category, Disposition, ReviewerUsage, Severity } from "./finding.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  changed_files INTEGER NOT NULL,
  changed_lines INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  failed INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL
);

CREATE TABLE IF NOT EXISTS reviewer_outcome (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  model TEXT NOT NULL,
  failure TEXT,
  finding_count INTEGER NOT NULL,
  anomaly_count INTEGER NOT NULL,
  rejected_tool_calls INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL
);

CREATE TABLE IF NOT EXISTS finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  model TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  fingerprint TEXT,
  group_index INTEGER NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS finding_by_run ON finding(run_id);
`;

/** Review Run 开始时即已知的元数据。 */
export type RunMeta = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  /** 预估规模:本次 Review Range 覆盖的文件数。 */
  changedFiles: number;
  /** 预估规模:本次 Review Range 的增删行数。 */
  changedLines: number;
  /** 预估规模:本次 Review Range 被切成几批。规模在阈值内时为 1。 */
  batchCount: number;
};

export type OutcomeRecord = {
  model: string;
  failure?: string;
  findingCount: number;
  anomalyCount: number;
  rejectedToolCalls: number;
  durationMs: number;
  usage?: ReviewerUsage;
};

/** 一条来源 Finding。`groupIndex` 是它在本次 Review Run 中所属合并组的序号。 */
export type FindingRecord = {
  model: string;
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  description: string;
  fingerprint?: string;
  groupIndex: number;
  /** 本轮读回的处置结论。同一合并组内各来源共用一条评论,取值相同。 */
  disposition: Disposition;
};

export type RunResult = {
  finishedAt: string;
  durationMs: number;
  failed: boolean;
  outcomes: readonly OutcomeRecord[];
  findings: readonly FindingRecord[];
};

/** 按模型与 category 聚合的 Finding 处置结果。 */
export type DispositionRow = {
  model: string;
  category: string;
  total: number;
  resolved: number;
  unresolved: number;
  unknown: number;
};

export type Store = {
  startRun(meta: RunMeta): number;
  finishRun(runId: number, result: RunResult): void;
  /** 按模型与 category 聚合 Finding 的处置结果。 */
  dispositionsByModelAndCategory(): DispositionRow[];
  close(): void;
};

function usageColumns(usage: ReviewerUsage | undefined): (number | null)[] {
  if (usage === undefined) return [null, null, null, null, null, null];
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
    usage.costUsd,
  ];
}

/** 累加用量。取 `usage` 一个字段,`ReviewerOutcome` 与 `OutcomeRecord` 都能传。 */
export function sumUsage(
  outcomes: readonly { usage?: ReviewerUsage }[],
): ReviewerUsage {
  const total: ReviewerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.usage === undefined) continue;
    total.inputTokens += outcome.usage.inputTokens;
    total.outputTokens += outcome.usage.outputTokens;
    total.cacheReadTokens += outcome.usage.cacheReadTokens;
    total.cacheWriteTokens += outcome.usage.cacheWriteTokens;
    total.totalTokens += outcome.usage.totalTokens;
    total.costUsd += outcome.usage.costUsd;
  }
  return total;
}

export function openStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  return {
    startRun(meta) {
      const result = db
        .prepare(
          `INSERT INTO review_run
             (owner, repo, pull_number, head_sha, started_at,
              changed_files, changed_lines, batch_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meta.owner,
          meta.repo,
          meta.pullNumber,
          meta.headSha,
          meta.startedAt,
          meta.changedFiles,
          meta.changedLines,
          meta.batchCount,
        );
      return Number(result.lastInsertRowid);
    },

    finishRun(runId, result) {
      // 一次 Review Run 的收尾要么整体可见,要么整体不可见:半张表的 Finding
      // 会让事后的采纳率统计算出偏低的分母。
      db.exec("BEGIN");
      try {
        db.prepare(
          `UPDATE review_run
              SET finished_at = ?, duration_ms = ?, failed = ?,
                  input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
                  cache_write_tokens = ?, total_tokens = ?, cost_usd = ?
            WHERE id = ?`,
        ).run(
          result.finishedAt,
          result.durationMs,
          result.failed ? 1 : 0,
          ...usageColumns(sumUsage(result.outcomes)),
          runId,
        );

        const insertOutcome = db.prepare(
          `INSERT INTO reviewer_outcome
             (run_id, model, failure, finding_count, anomaly_count,
              rejected_tool_calls, duration_ms, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, total_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const outcome of result.outcomes) {
          insertOutcome.run(
            runId,
            outcome.model,
            outcome.failure ?? null,
            outcome.findingCount,
            outcome.anomalyCount,
            outcome.rejectedToolCalls,
            outcome.durationMs,
            ...usageColumns(outcome.usage),
          );
        }

        const insertFinding = db.prepare(
          `INSERT INTO finding
             (run_id, model, file, line, severity, category, description,
              fingerprint, group_index, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const finding of result.findings) {
          insertFinding.run(
            runId,
            finding.model,
            finding.file,
            finding.line,
            finding.severity,
            finding.category,
            finding.description,
            finding.fingerprint ?? null,
            finding.groupIndex,
            finding.disposition,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    dispositionsByModelAndCategory() {
      const rows = db
        .prepare(
          `SELECT model,
                  category,
                  COUNT(*) AS total,
                  SUM(disposition = 'resolved') AS resolved,
                  SUM(disposition = 'unresolved') AS unresolved,
                  SUM(disposition = 'unknown') AS unknown
             FROM finding
            GROUP BY model, category
            ORDER BY model, category`,
        )
        .all();
      // 逐字段取出:node:sqlite 返回的是 null 原型对象,直接外传会让调用方拿到
      // 一个没有 Object 方法的怪东西。
      return rows.map((row) => ({
        model: String(row["model"]),
        category: String(row["category"]),
        total: Number(row["total"]),
        resolved: Number(row["resolved"]),
        unresolved: Number(row["unresolved"]),
        unknown: Number(row["unknown"]),
      }));
    },

    close() {
      db.close();
    },
  };
}
