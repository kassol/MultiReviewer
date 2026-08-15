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
  anchor_rejections INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (owner, repo, head_sha)
);

-- 仓库注册表。主键是 Forge 的数值 repo id:改名与转移 owner 后凭 payload 里的 id
-- 仍能匹配,owner/repo 只是注册时的名字,不参与准入。reviewers 是模型覆盖
-- (ReviewerSpec 的 JSON 数组),NULL 即跟随全局配置——文件管全局默认,库管每仓库
-- 覆盖,不出现「文件与库谁赢」。
CREATE TABLE IF NOT EXISTS repo (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  reviewers TEXT,
  registered_at TEXT NOT NULL
);

-- 仓库的 key。明文存库:HMAC 验签需要原始值,这是密码学约束,不是疏忽。代次单调
-- 递增并写进 hook URL 的 ?k=,轮转期间一个仓库最多两把并存(ADR 0007)。
CREATE TABLE IF NOT EXISTS repo_key (
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  generation INTEGER NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (repo_id, generation)
);
`;

/**
 * 加在既有表上的列。`CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做,升级前建的
 * 数据库因此拿不到新列,第一次落库就写不进去。SQLite 的 ADD COLUMN 没有 IF NOT EXISTS,
 * 只能照跑一遍、把"列已存在"这一种错吞掉——每条都带默认值,旧行不需要回填。
 */
const ADD_COLUMNS = [
  "ALTER TABLE reviewer_outcome ADD COLUMN anchor_rejections INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE repo ADD COLUMN reviewers TEXT",
];

/**
 * 等锁的上限。webhook 服务里 webhook 层与后台 Review Run 各持一个句柄写同一个文件,
 * 默认的 0 会让撞上写锁的那一方当场报错,而这里等几十毫秒就过去了。
 */
const BUSY_TIMEOUT_MS = 5_000;

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
  /** snippet 锚不上而被打回的 `report_finding` 次数。与上一项分列,语义不同。 */
  anchorRejections: number;
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

/** 仓库持有的一把 key。`generation` 是它的代次,写在 hook URL 的 `?k=` 上。 */
export type RepoKey = {
  generation: number;
  key: string;
};

/** 注册表里的一个仓库。`reviewersJson` 是模型覆盖的 JSON,null 即跟随全局。 */
export type RepoRecord = {
  repoId: number;
  owner: string;
  repo: string;
  reviewersJson: string | null;
};

/** 仓库列表行:注册信息加累计量。 */
export type RepoSummary = {
  repoId: number;
  owner: string;
  repo: string;
  /** 累计 Review Run 数。按注册时的 owner/repo 匹配评审记录。 */
  runCount: number;
  /** 累计来源 Finding 数(落库行数,非合并组数)。 */
  findingCount: number;
  /** 最近一次 Review Run 的开始时间,没跑过为 null。 */
  lastActivity: string | null;
};

export type Store = {
  /**
   * 注册一个仓库:注册表行与第一把 Key 在一个事务里落库——「有仓库无 Key」的投递
   * 会被判成未注册,这个中间态从设计上消除。`repoId` 是 Forge 的数值 repo id,
   * 重复注册直接抛(主键冲突)。
   */
  registerRepo(record: {
    repoId: number;
    owner: string;
    repo: string;
    generation: number;
    key: string;
    reviewersJson?: string;
  }): void;
  /** 给仓库加一把 key,轮转(ADR 0007)开新代次用。同仓库同代次重复添加直接抛。 */
  addRepoKey(repoId: number, generation: number, key: string): void;
  /** 仓库持有的全部 key。未注册的仓库得到空数组——这就是「未注册」的判据。 */
  listRepoKeys(repoId: number): RepoKey[];
  getRepo(repoId: number): RepoRecord | undefined;
  /** 摘掉注册表行与它的 Key。评审记录一行不动:模型选型的历史不因下线而断。 */
  removeRepo(repoId: number): void;
  /** 全部已注册仓库,按最近活动排序,没跑过的按注册时间排在后面。 */
  listRepos(): RepoSummary[];
  startRun(meta: RunMeta): number;
  finishRun(runId: number, result: RunResult): void;
  /** 按模型与 category 聚合 Finding 的处置结果。 */
  dispositionsByModelAndCategory(): DispositionRow[];
  /**
   * 领走一次 webhook 投递。同一个「仓库 + head commit」只有第一次返回 true。
   *
   * 判重靠 UNIQUE 约束上的插入冲突,不先查后插:并发投递时先查后插会两个请求都查不到、
   * 都开跑。幂等键只挡自动触发的重复投递,`review_run` 上不加同样的约束——人手动
   * 重审同一个 head commit 是合法的。
   */
  claimDelivery(owner: string, repo: string, headSha: string): boolean;
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
  const db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  db.exec(SCHEMA);
  for (const statement of ADD_COLUMNS) {
    try {
      db.exec(statement);
    } catch (error) {
      // 只放过"列已存在",别的错(表缺失、语法错)照抛——那是真出了事。
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }

  return {
    registerRepo(record) {
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO repo (id, owner, repo, reviewers, registered_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          record.repoId,
          record.owner,
          record.repo,
          record.reviewersJson ?? null,
          new Date().toISOString(),
        );
        db.prepare("INSERT INTO repo_key (repo_id, generation, key) VALUES (?, ?, ?)").run(
          record.repoId,
          record.generation,
          record.key,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    addRepoKey(repoId, generation, key) {
      db.prepare(
        "INSERT INTO repo_key (repo_id, generation, key) VALUES (?, ?, ?)",
      ).run(repoId, generation, key);
    },

    listRepoKeys(repoId) {
      const rows = db
        .prepare(
          "SELECT generation, key FROM repo_key WHERE repo_id = ? ORDER BY generation",
        )
        .all(repoId);
      return rows.map((row) => ({
        generation: Number(row["generation"]),
        key: String(row["key"]),
      }));
    },

    getRepo(repoId) {
      const row = db
        .prepare("SELECT id, owner, repo, reviewers FROM repo WHERE id = ?")
        .get(repoId);
      if (row === undefined) return undefined;
      return {
        repoId: Number(row["id"]),
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        reviewersJson: row["reviewers"] === null ? null : String(row["reviewers"]),
      };
    },

    removeRepo(repoId) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM repo_key WHERE repo_id = ?").run(repoId);
        db.prepare("DELETE FROM repo WHERE id = ?").run(repoId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listRepos() {
      // 评审记录按注册时的 owner/repo 匹配。仓库在 Forge 上改名后新记录用新名字,
      // 旧名字的记录不再计入——注册表的名字由后续的注册流程更新,这里不猜。
      // started_at 是 ISO 字符串,MAX 按字典序即时间序。
      const rows = db
        .prepare(
          `SELECT r.id, r.owner, r.repo,
                  (SELECT COUNT(*) FROM review_run run
                    WHERE run.owner = r.owner AND run.repo = r.repo) AS run_count,
                  (SELECT COUNT(*) FROM finding f JOIN review_run run ON f.run_id = run.id
                    WHERE run.owner = r.owner AND run.repo = r.repo) AS finding_count,
                  (SELECT MAX(run.started_at) FROM review_run run
                    WHERE run.owner = r.owner AND run.repo = r.repo) AS last_activity
             FROM repo r
            ORDER BY (last_activity IS NULL), COALESCE(last_activity, r.registered_at) DESC`,
        )
        .all();
      return rows.map((row) => ({
        repoId: Number(row["id"]),
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        runCount: Number(row["run_count"]),
        findingCount: Number(row["finding_count"]),
        lastActivity: row["last_activity"] === null ? null : String(row["last_activity"]),
      }));
    },

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
              rejected_tool_calls, anchor_rejections, duration_ms,
              input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, total_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const outcome of result.outcomes) {
          insertOutcome.run(
            runId,
            outcome.model,
            outcome.failure ?? null,
            outcome.findingCount,
            outcome.anomalyCount,
            outcome.rejectedToolCalls,
            outcome.anchorRejections,
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

    claimDelivery(owner, repo, headSha) {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO webhook_delivery (owner, repo, head_sha, claimed_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(owner, repo, headSha, new Date().toISOString());
      return Number(result.changes) > 0;
    },

    close() {
      db.close();
    },
  };
}
