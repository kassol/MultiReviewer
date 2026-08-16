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
  -- pull request 的状态,closed 回填写上,NULL 即尚未见到关闭。unknown 的 finding
  -- 只在已关闭的 PR 上进统计分母(ADR 0006)。
  pr_state TEXT,
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
  disposition TEXT NOT NULL DEFAULT 'unknown',
  -- 来源类型:进了行级评论(inline)还是 review 正文(body)。正文没有 resolve 状态
  -- 可读,body 行排除在处置率统计外(ADR 0006)。
  placement TEXT NOT NULL DEFAULT 'inline'
);

CREATE INDEX IF NOT EXISTS finding_by_run ON finding(run_id);

-- 回填的索引:回填按「文件 + 指纹」改行、按 PR 定位 Review Run。统计矩阵是全表
-- 聚合,时间窗过滤在聚合之后,建不出能用上的索引。
CREATE INDEX IF NOT EXISTS finding_by_anchor ON finding(file, fingerprint);
CREATE INDEX IF NOT EXISTS review_run_by_pr ON review_run(owner, repo, pull_number);

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
 *
 * placement 的默认值 'inline' 对升级前的历史 fallback 行是错标(它们本该是 body),
 * 迁移时无从分辨;回填链路会在该 PR 下一次被读到时按正文锚点把它们纠正回来。
 */
const ADD_COLUMNS = [
  "ALTER TABLE reviewer_outcome ADD COLUMN anchor_rejections INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE repo ADD COLUMN reviewers TEXT",
  "ALTER TABLE review_run ADD COLUMN pr_state TEXT",
  "ALTER TABLE finding ADD COLUMN placement TEXT NOT NULL DEFAULT 'inline'",
];

/** 回填要用的最小形状。`ReviewerSpec` 满足它,store 层不必依赖配置模块。 */
export type ModelSpec = { provider: string; model: string };

/**
 * 模型标识的回填(issue #73)。历史行的 model 列存的是裸 model id,新形态是
 * `provider:model`,而 provider 从库里恢复不出来——两张表都没记过它。
 *
 * 判据因此是「按裸 model id 在当前模型组合里反查得到唯一 provider」:反查得到就改写,
 * 查不到或同一个 id 在多家 provider 下都配着就不动。留下的旧形态行在统计里各成一条,
 * 不会被错误归并到别的模型名下。
 *
 * 幂等靠精确匹配:改写后的值带 provider 段,不再等于任何裸 id,重跑无害;已是新形态的
 * 值同理不被二次加工。不按「值里没有冒号」判断——OpenRouter 的 model id 本身带 `:free`
 * 这类后缀,那样会把它们误判成已迁移。
 */
function backfillModelIdentities(db: DatabaseSync, specs: readonly ModelSpec[]): void {
  const identities = new Map<string, string | undefined>();
  for (const spec of [...specs, ...repoOverrideSpecs(db)]) {
    // 同一个裸 id 落在两家 provider 下时记 undefined:无从判断历史行属于哪一家。
    const identity = `${spec.provider}:${spec.model}`;
    const ambiguous = identities.has(spec.model) && identities.get(spec.model) !== identity;
    identities.set(spec.model, ambiguous ? undefined : identity);
  }

  const updates = [
    db.prepare("UPDATE finding SET model = ? WHERE model = ?"),
    db.prepare("UPDATE reviewer_outcome SET model = ? WHERE model = ?"),
  ];
  for (const [bare, identity] of identities) {
    if (identity === undefined) continue;
    for (const update of updates) update.run(identity, bare);
  }
}

/**
 * 每仓库模型覆盖里出现过的模型。它们不一定在全局模型组合里,而它们提出的历史 Finding
 * 一样要回填。坏 JSON(直接写库的遗留)跳过——一行坏数据不该让迁移掀掉整个进程。
 */
function repoOverrideSpecs(db: DatabaseSync): ModelSpec[] {
  const specs: ModelSpec[] = [];
  const rows = db.prepare("SELECT reviewers FROM repo WHERE reviewers IS NOT NULL").all();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row["reviewers"]));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      const { provider, model } = (entry ?? {}) as Partial<ModelSpec>;
      if (typeof provider === "string" && typeof model === "string") {
        specs.push({ provider, model });
      }
    }
  }
  return specs;
}

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

/** Finding 的来源类型:进了行级评论,还是只进了 review 正文(fallback 与正文匹配)。 */
export type FindingPlacement = "inline" | "body";

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
  /** 同一合并组共用一个来源类型,组内各来源取值相同。 */
  placement: FindingPlacement;
};

/**
 * 回填的一条更新:PR 里指纹与文件都对上的历史 finding 照它改写。行级评论承载的带
 * disposition;正文锚点没有 resolve 状态可读,只带来源类型(顺手纠正升级前被默认值
 * 标成 inline 的历史 fallback 行)。
 */
export type DispositionUpdate = {
  file: string;
  fingerprint: string;
  disposition?: Disposition;
  placement: FindingPlacement;
};

export type RunResult = {
  finishedAt: string;
  durationMs: number;
  failed: boolean;
  outcomes: readonly OutcomeRecord[];
  findings: readonly FindingRecord[];
};

/**
 * 处置率矩阵的一格:模型 × category。计数单位是**同一处 Finding**(Finding Identity,
 * 见 CONTEXT.md),不是落库行。分母 = resolved + unresolved + unknownClosed;
 * unknownOpen 不进分母也不上页面,API 带上它只为让口径可对账。
 */
export type DispositionCell = {
  model: string;
  category: string;
  /** 分子:已处置(折叠组内任一行 resolved 即已处置)。 */
  resolved: number;
  /** 人看过但未 resolve。 */
  unresolved: number;
  /** 已关闭 PR 上仍无人处置——到了终态还没人处置,那就是未处置,进分母。 */
  unknownClosed: number;
  /** 开放 PR 上还没人看——它还在流程中,不进分母。 */
  unknownOpen: number;
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
  /** 模型覆盖的 JSON,null 即跟随全局。面板的仓库详情要显示与编辑它。 */
  reviewersJson: string | null;
  /** 累计 Review Run 数。按注册时的 owner/repo 匹配评审记录。 */
  runCount: number;
  /** 累计来源 Finding 数(落库行数,非合并组数)。 */
  findingCount: number;
  /** 最近一次 Review Run 的开始时间,没跑过为 null。 */
  lastActivity: string | null;
};

/** 时间流里的一条 Review Run。`models` 是逐模型的来源 Finding 行数,按模型名排序。 */
export type RunListItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  models: { model: string; findings: number }[];
  /**
   * 已处置的合并组数。已处置判定与处置率同源(任一行 resolved 即已处置,只认行级
   * 承载),但计数单位是本轮合并组,不是处置率的逐模型 Finding Identity——多模型
   * 报同一处这里算 1,处置率矩阵里逐模型各算一条。
   */
  resolved: number;
  /** 行级承载的合并组总数。正文行没有 resolve 载体,不进这一对计数。 */
  total: number;
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
  /** 摘掉一把 key,轮转收尾时删旧代次用。不存在时静默通过——目标状态已达成。 */
  removeRepoKey(repoId: number, generation: number): void;
  /** 仓库持有的全部 key。未注册的仓库得到空数组——这就是「未注册」的判据。 */
  listRepoKeys(repoId: number): RepoKey[];
  getRepo(repoId: number): RepoRecord | undefined;
  /** 改写模型覆盖。null 即清除覆盖、跟随全局。仓库不存在时静默无事发生,调用方先查。 */
  setRepoReviewers(repoId: number, reviewersJson: string | null): void;
  /** 摘掉注册表行与它的 Key。评审记录一行不动:模型选型的历史不因下线而断。 */
  removeRepo(repoId: number): void;
  /** 全部已注册仓库,按最近活动排序,没跑过的按注册时间排在后面。 */
  listRepos(): RepoSummary[];
  startRun(meta: RunMeta): number;
  finishRun(runId: number, result: RunResult): void;
  /**
   * 处置率统计(ADR 0006):按 Finding Identity 折叠,fallback(body)排除,unknown
   * 按 PR 状态分流,时间窗按同一处 Finding 首次报出那轮的开始时间归属(闭区间,
   * ISO 字符串按字典序即时间序)。
   */
  dispositionStats(from: string, to: string): DispositionCell[];
  /**
   * 时间流的一页:按 id 倒序(id 即落库顺序,与开跑时间同序),`beforeId` 取更早的
   * 一页。覆盖全部评审记录——已移除仓库的历史照常出现,这是留存决策的呈现面。
   */
  listRuns(opts: { beforeId?: number; limit: number; owner?: string; repo?: string }): RunListItem[];
  /** 每张表的行数,给面板展示库体量。不做清理,数字只会涨(ADR 0006 的留存决策)。 */
  tableCounts(): { name: string; rows: number }[];
  /**
   * 领走一次 webhook 投递。同一个「仓库 + head commit」只有第一次返回 true。
   *
   * 判重靠 UNIQUE 约束上的插入冲突,不先查后插:并发投递时先查后插会两个请求都查不到、
   * 都开跑。幂等键只挡自动触发的重复投递,`review_run` 上不加同样的约束——人手动
   * 重审同一个 head commit 是合法的。
   */
  claimDelivery(owner: string, repo: string, headSha: string): boolean;
  /**
   * 回填 disposition(ADR 0006):对这个 pull request 名下、文件与指纹都对上的全部
   * 历史 finding,以 Forge 的最新状态覆盖已有值——人 resolve 后又 unresolve,库里跟着改。
   */
  backfillDispositions(
    owner: string,
    repo: string,
    pullNumber: number,
    updates: readonly DispositionUpdate[],
  ): void;
  /**
   * 记下 pull request 的状态:closed 回填写 "closed",reopened 用 null 清掉。
   * 作用于该 PR 的全部 Review Run 行。
   */
  markPullRequestState(
    owner: string,
    repo: string,
    pullNumber: number,
    state: string | null,
  ): void;
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

/**
 * 开库并跑迁移。`modelSpecs` 给出时顺带回填模型标识——回填要认得 provider,而它只在
 * 模型组合里,库里没有。进程启动时给一次即可,请求路径上的短开短关不必带。
 */
export function openStore(dbPath: string, modelSpecs?: readonly ModelSpec[]): Store {
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
  if (modelSpecs !== undefined) backfillModelIdentities(db, modelSpecs);

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

    removeRepoKey(repoId, generation) {
      db.prepare("DELETE FROM repo_key WHERE repo_id = ? AND generation = ?").run(
        repoId,
        generation,
      );
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

    setRepoReviewers(repoId, reviewersJson) {
      db.prepare("UPDATE repo SET reviewers = ? WHERE id = ?").run(reviewersJson, repoId);
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
          `SELECT r.id, r.owner, r.repo, r.reviewers,
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
        reviewersJson: row["reviewers"] === null ? null : String(row["reviewers"]),
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
      // 会让事后的处置率统计算出偏低的分母。
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
              fingerprint, group_index, disposition, placement)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            finding.placement,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    dispositionStats(from, to) {
      // 三层:src 摊平行,identity 按「PR + 模型 + 文件 + 指纹」折叠(指纹为 NULL 的
      // 行用自己的 id 兜底成独立键——算不出指纹就各算一条),labeled 给每个 identity
      // 取它首次报出那一行的 category(category 不进折叠键,跨轮漂移时以首次为准,
      // 与时间窗归属同一轮)。
      const rows = db
        .prepare(
          `WITH src AS (
             SELECT f.id, f.model, f.category, f.file, f.disposition,
                    COALESCE(f.fingerprint, 'row:' || f.id) AS fp,
                    run.owner, run.repo, run.pull_number, run.started_at,
                    CASE WHEN run.pr_state = 'closed' THEN 1 ELSE 0 END AS closed
               FROM finding f
               JOIN review_run run ON f.run_id = run.id
              WHERE f.placement = 'inline'
           ),
           identity AS (
             SELECT model, owner, repo, pull_number, file, fp,
                    MIN(started_at) AS first_seen,
                    MAX(CASE disposition
                          WHEN 'resolved' THEN 2
                          WHEN 'unresolved' THEN 1
                          ELSE 0 END) AS disp,
                    MAX(closed) AS closed
               FROM src
              GROUP BY model, owner, repo, pull_number, file, fp
           ),
           labeled AS (
             SELECT identity.*,
                    (SELECT s.category FROM src s
                      WHERE s.model = identity.model AND s.owner = identity.owner
                        AND s.repo = identity.repo AND s.pull_number = identity.pull_number
                        AND s.file = identity.file AND s.fp = identity.fp
                      ORDER BY s.started_at, s.id LIMIT 1) AS category
               FROM identity
           )
           SELECT model, category,
                  SUM(CASE WHEN disp = 2 THEN 1 ELSE 0 END) AS resolved,
                  SUM(CASE WHEN disp = 1 THEN 1 ELSE 0 END) AS unresolved,
                  SUM(CASE WHEN disp = 0 AND closed = 1 THEN 1 ELSE 0 END) AS unknown_closed,
                  SUM(CASE WHEN disp = 0 AND closed = 0 THEN 1 ELSE 0 END) AS unknown_open
             FROM labeled
            WHERE first_seen >= ? AND first_seen <= ?
            GROUP BY model, category
            ORDER BY model, category`,
        )
        .all(from, to);
      // 逐字段取出:node:sqlite 返回的是 null 原型对象,直接外传会让调用方拿到
      // 一个没有 Object 方法的怪东西。
      return rows.map((row) => ({
        model: String(row["model"]),
        category: String(row["category"]),
        resolved: Number(row["resolved"]),
        unresolved: Number(row["unresolved"]),
        unknownClosed: Number(row["unknown_closed"]),
        unknownOpen: Number(row["unknown_open"]),
      }));
    },

    listRuns(opts) {
      const conditions: string[] = [];
      const params: (number | string)[] = [];
      if (opts.beforeId !== undefined) {
        conditions.push("id < ?");
        params.push(opts.beforeId);
      }
      if (opts.owner !== undefined && opts.repo !== undefined) {
        conditions.push("owner = ? AND repo = ?");
        params.push(opts.owner, opts.repo);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const runs = db
        .prepare(
          `SELECT id, owner, repo, pull_number, head_sha, started_at, finished_at, failed
             FROM review_run ${where}
            ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, opts.limit);
      if (runs.length === 0) return [];

      const ids = runs.map((run) => Number(run["id"]));
      const marks = ids.map(() => "?").join(", ");
      const byModel = db
        .prepare(
          `SELECT run_id, model, COUNT(*) AS findings FROM finding
            WHERE run_id IN (${marks}) GROUP BY run_id, model ORDER BY model`,
        )
        .all(...ids);
      // 已处置口径与处置率同源:合并组内任一行 resolved 即已处置,只认行级承载。
      const byGroup = db
        .prepare(
          `SELECT run_id,
                  COUNT(DISTINCT group_index) AS total,
                  COUNT(DISTINCT CASE WHEN disposition = 'resolved' THEN group_index END)
                    AS resolved
             FROM finding
            WHERE run_id IN (${marks}) AND placement = 'inline'
            GROUP BY run_id`,
        )
        .all(...ids);

      const models = new Map<number, { model: string; findings: number }[]>();
      for (const row of byModel) {
        const runId = Number(row["run_id"]);
        const list = models.get(runId) ?? [];
        list.push({ model: String(row["model"]), findings: Number(row["findings"]) });
        models.set(runId, list);
      }
      const groups = new Map<number, { resolved: number; total: number }>();
      for (const row of byGroup) {
        groups.set(Number(row["run_id"]), {
          resolved: Number(row["resolved"]),
          total: Number(row["total"]),
        });
      }
      return runs.map((run) => {
        const id = Number(run["id"]);
        return {
          id,
          owner: String(run["owner"]),
          repo: String(run["repo"]),
          pullNumber: Number(run["pull_number"]),
          headSha: String(run["head_sha"]),
          startedAt: String(run["started_at"]),
          finishedAt: run["finished_at"] === null ? null : String(run["finished_at"]),
          failed: Number(run["failed"]) === 1,
          models: models.get(id) ?? [],
          resolved: groups.get(id)?.resolved ?? 0,
          total: groups.get(id)?.total ?? 0,
        };
      });
    },

    tableCounts() {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all();
      return tables.map((table) => {
        const name = String(table["name"]);
        const count = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as {
          c: number;
        };
        return { name, rows: Number(count.c) };
      });
    },

    backfillDispositions(owner, repo, pullNumber, updates) {
      if (updates.length === 0) return;
      const scope = `run_id IN (SELECT id FROM review_run
                                 WHERE owner = ? AND repo = ? AND pull_number = ?)`;
      const withDisposition = db.prepare(
        `UPDATE finding SET disposition = ?, placement = ?
          WHERE file = ? AND fingerprint = ? AND ${scope}`,
      );
      const placementOnly = db.prepare(
        `UPDATE finding SET placement = ?
          WHERE file = ? AND fingerprint = ? AND ${scope}`,
      );
      db.exec("BEGIN");
      try {
        for (const entry of updates) {
          if (entry.disposition === undefined) {
            placementOnly.run(entry.placement, entry.file, entry.fingerprint, owner, repo, pullNumber);
          } else {
            withDisposition.run(
              entry.disposition,
              entry.placement,
              entry.file,
              entry.fingerprint,
              owner,
              repo,
              pullNumber,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    markPullRequestState(owner, repo, pullNumber, state) {
      db.prepare(
        `UPDATE review_run SET pr_state = ?
          WHERE owner = ? AND repo = ? AND pull_number = ?`,
      ).run(state, owner, repo, pullNumber);
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
