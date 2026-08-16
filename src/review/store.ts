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
-- (ReviewerSpec 的 JSON 数组),NULL 即跟随 global_setting 里的全局模型组合。
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

-- 模型凭据。按 provider 一把,同一家下的多个 model 共用(ADR 0008)。密文由面板加密后
-- 落库,主密钥在环境变量里,库里没有还原它的材料——与上面明文存的 repo_key 是两类
-- 东西:那一条是 HMAC 验签逼出来的,这一条没有这个约束。
-- verified 记的是「保存时有没有真发过厂商验证请求」:认得的那几家发过并通过,
-- 其余的跳过验证照样落库,面板据此标出「未验证」。
CREATE TABLE IF NOT EXISTS model_credential (
  provider TEXT PRIMARY KEY,
  api_key_encrypted TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1
);

-- 全局设置,一项一行。reviewers 是全局模型组合,与 repo.reviewers 同构(ReviewerSpec
-- 的 JSON 数组);max_changed_lines_per_batch 是正整数的字符串形,缺行即取默认值。
-- 库是唯一的配置面(issue #66),没有配置文件与它竞争。
CREATE TABLE IF NOT EXISTS global_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  // 升级前只有通过了厂商验证的凭据才落得进来,旧行默认 1 是照实记。
  "ALTER TABLE model_credential ADD COLUMN verified INTEGER NOT NULL DEFAULT 1",
];

/*
 * 历史的裸 model id 不回填(issue #73 的取舍)。升级前 `finding.model` 与
 * `reviewer_outcome.model` 存的是裸 model id,新形态是 `provider:model`,而 provider
 * 从库里恢复不出来——两张表都没记过它,当前的模型组合也不是历史的证据:同一个 model id
 * 当初走 deepseek 直连、现在只配了 openrouter,按当前组合反查就会把历史 Finding 永久
 * 标成 openrouter,而这一步改完再也回不去。
 *
 * 已知代价:同一个模型在迁移前后裂成两行,统计矩阵里旧行挂裸 id、新行挂模型标识。
 * 错归厂商是不可逆的错数据,裂成两行只是看起来多一条,选后者。
 */

/** `global_setting` 的两个键。 */
const GLOBAL_REVIEWERS_KEY = "reviewers";
const GLOBAL_MAX_CHANGED_LINES_KEY = "max_changed_lines_per_batch";

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

/** 一家厂商的模型凭据。`apiKeyEncrypted` 是密文,还原要主密钥(ADR 0008)。 */
export type ModelCredentialRecord = {
  provider: string;
  apiKeyEncrypted: string;
  updatedAt: string;
  /** 保存时是否真发过厂商验证请求并通过。认不出的 provider 落库时为假。 */
  verified: boolean;
};

/**
 * 全局设置。两项都可能没配:空库刚起来时就是这个样子,面板的设置页把它们配起来。
 */
export type GlobalSettings = {
  /** 全局模型组合的 JSON(ReviewerSpec 数组),null 即还没配。 */
  reviewersJson: string | null;
  /** 一批最多多少改动行,null 即取编排层的默认值。 */
  maxChangedLinesPerBatch: number | null;
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
  /** 全局设置。没写过的项回 null,调用方各自取默认。 */
  getGlobalSettings(): GlobalSettings;
  /** 改写全局设置,两项一起写。null 即清掉该项,读回来重新取默认。 */
  putGlobalSettings(settings: GlobalSettings): void;
  /** 写一家厂商的凭据密文。同 provider 二次写入是覆盖,不是新增(ADR 0008)。 */
  putModelCredential(
    provider: string,
    apiKeyEncrypted: string,
    updatedAt: string,
    verified: boolean,
  ): void;
  /** 全部厂商凭据,按 provider 排序。密文原样给出,解密由调用方做。 */
  listModelCredentials(): ModelCredentialRecord[];
  /** 摘掉一家厂商的凭据。不存在时静默通过——目标状态已达成。 */
  removeModelCredential(provider: string): void;
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

/** 开库并跑迁移。 */
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

    getGlobalSettings() {
      const rows = db.prepare("SELECT key, value FROM global_setting").all();
      const values = new Map(rows.map((row) => [String(row["key"]), String(row["value"])]));
      const limit = values.get(GLOBAL_MAX_CHANGED_LINES_KEY);
      return {
        reviewersJson: values.get(GLOBAL_REVIEWERS_KEY) ?? null,
        maxChangedLinesPerBatch: limit === undefined ? null : Number(limit),
      };
    },

    putGlobalSettings(settings) {
      const write = (key: string, value: string | null): void => {
        if (value === null) {
          db.prepare("DELETE FROM global_setting WHERE key = ?").run(key);
          return;
        }
        db.prepare(
          `INSERT INTO global_setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(key, value);
      };
      write(GLOBAL_REVIEWERS_KEY, settings.reviewersJson);
      write(
        GLOBAL_MAX_CHANGED_LINES_KEY,
        settings.maxChangedLinesPerBatch === null
          ? null
          : String(settings.maxChangedLinesPerBatch),
      );
    },

    putModelCredential(provider, apiKeyEncrypted, updatedAt, verified) {
      // 覆盖语义直接落在主键上:同一家写第二次替掉第一次,库里永远只有一把。
      db.prepare(
        `INSERT INTO model_credential (provider, api_key_encrypted, updated_at, verified)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           api_key_encrypted = excluded.api_key_encrypted,
           updated_at = excluded.updated_at,
           verified = excluded.verified`,
      ).run(provider, apiKeyEncrypted, updatedAt, verified ? 1 : 0);
    },

    listModelCredentials() {
      const rows = db
        .prepare(
          `SELECT provider, api_key_encrypted, updated_at, verified
           FROM model_credential ORDER BY provider`,
        )
        .all();
      return rows.map((row) => ({
        provider: String(row["provider"]),
        apiKeyEncrypted: String(row["api_key_encrypted"]),
        updatedAt: String(row["updated_at"]),
        verified: Number(row["verified"]) === 1,
      }));
    },

    removeModelCredential(provider) {
      db.prepare("DELETE FROM model_credential WHERE provider = ?").run(provider);
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
