/**
 * Review Run 的持久化。用 Node 内置的 SQLite,不引入第三方驱动。
 *
 * Disposition 的权威状态在 Forge 上,`finding.disposition` 只缓存最近一次读回的
 * 结果,默认 `unknown`。
 */
import { DatabaseSync } from "node:sqlite";

import {
  assertReviewerSpecs,
  GLOBAL_REVIEWERS_CONTEXT,
  modelIdentity,
  type ReviewerSpec,
  type ReviewRunReviewerPin,
} from "../config.ts";
import { isPanelPermission, type PanelPermission } from "../panel/permissions.ts";
import type {
  DiscoveredModel,
  ModelCost,
  TrustedModelFields,
  TrustedModelFieldSource,
  TrustedModelFieldSources,
} from "../reviewer/model-service-runtime.ts";
import type {
  Category,
  Disposition,
  HistoryFinding,
  ReviewerUsage,
  ReviewVerdict,
  Severity,
} from "./finding.ts";
import { containerBranches, type RangeReviewState } from "./range-review.ts";

export const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  -- 这一轮属于哪个范围审查(ADR 0012)。PR 触发的为 NULL;范围审查那一档的
  -- pull_number 是它的容器 PR。
  range_review_id INTEGER,
  -- pull request 的状态,closed 回填写上,NULL 即尚未见到关闭。unknown 的 finding
  -- 只在已关闭的 PR 上进统计分母(ADR 0006)。
  pr_state TEXT,
  -- 手动重跑的调用者用户名快照,NULL 即投递。刻意不引用 panel_user:删号后历史保留。
  triggered_by TEXT,
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
  cost_usd REAL,
  known_cost_usd REAL,
  cost_source TEXT,
  unknown_cost_reviewer_count INTEGER
);

CREATE TABLE IF NOT EXISTS review_run_reviewer_pin (
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  position INTEGER NOT NULL,
  identity TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_service_version INTEGER,
  base_url TEXT,
  api TEXT,
  runtime_model_json TEXT,
  materialization_failure TEXT,
  PRIMARY KEY (run_id, position),
  UNIQUE (run_id, identity)
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
  cost_usd REAL,
  known_cost_usd REAL,
  cost_source TEXT
);

-- 一条 Finding 一行:Finding Identity 是「pull request + 文件 + 内容指纹」,不含模型
-- (ADR 0015)。报出它的模型各记一条 finding_attribution,同一处问题不论几个模型报出
-- 都只有这一行、只有一条 Forge 评论。
CREATE TABLE IF NOT EXISTS finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  -- 合并后的标题。历史注入要拿它给已处置的条目占那一行(ADR 0016),升级前的行为 NULL。
  title TEXT,
  description TEXT NOT NULL,
  fingerprint TEXT,
  group_index INTEGER NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'unknown',
  -- 来源类型:进了行级评论(inline)还是 review 正文(body)。正文没有 resolve 状态
  -- 可读,body 行排除在处置率统计外(ADR 0006)。
  placement TEXT NOT NULL DEFAULT 'inline',
  -- 承载它的那条 Forge 行级评论:id 供面板按评论 resolve,链接供「跳到 Forge 看原版」。
  -- 正文 fallback 没有行级评论,两项为 NULL;升级前的历史行同样为 NULL。
  comment_id TEXT,
  comment_html_url TEXT,
  -- 作出这次处置的人与时刻。回填链路不写这两列:在 Gitea 上点的 resolve 没有面板
  -- 身份可记,那一档留 NULL,disposed_by 非 NULL 即「人在面板上显式设置过」。
  -- 「已修复」自动处置(ADR 0016)只写 disposed_at,处置人留空:disposed_at
  -- 非 NULL 因此等于「这一行被显式处置过一次」,自动规则据此不再碰它。
  disposed_by TEXT,
  disposed_at TEXT,
  -- 处置备注(CONTEXT.md):只存面板,不写入 Forge。至多一条,unresolve 之后仍留着。
  disposition_note TEXT,
  -- 这一行承接的那条旧评论在 Forge 页面上的地址(CONTEXT.md 已延续,issue #167)。
  -- 只有延续过来的新行有它,面板据此显示「延续自」;其余行为 NULL。
  continued_from TEXT
);

CREATE INDEX IF NOT EXISTS finding_by_run ON finding(run_id);

-- 一条 Finding 的归属:报出它的每个模型一行,带它自己的严重度、分类与表述(ADR 0015)。
-- position 是首报先后,0 即首报——合并后的分类取它,统计矩阵的模型也取它。
CREATE TABLE IF NOT EXISTS finding_attribution (
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  position INTEGER NOT NULL,
  model TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (finding_id, position),
  UNIQUE (finding_id, model)
);
CREATE INDEX IF NOT EXISTS finding_attribution_by_model ON finding_attribution(model);

-- 一轮里每个 Reviewer 对每条未处置历史 Finding 的复核结论(ADR 0016)。finding_id
-- 指注入时该 Finding Identity 的最新一行。漏给结论的按「无法判断」照样落一行并标
-- missing:沉默不是证据,但"这个模型压根没复核"要数得出来。这批记录同时是自动处置的裁决输入。
CREATE TABLE IF NOT EXISTS finding_verdict (
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  model TEXT NOT NULL,
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  verdict TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, model, finding_id)
);

-- 回填的索引:回填按「文件 + 指纹」改行、按 PR 定位 Review Run。统计矩阵是全表
-- 聚合,时间窗过滤在聚合之后,建不出能用上的索引。
CREATE INDEX IF NOT EXISTS finding_by_anchor ON finding(file, fingerprint);
CREATE INDEX IF NOT EXISTS review_run_by_pr ON review_run(owner, repo, pull_number);

-- 范围审查(ADR 0012):人在面板发起的一个阶段性审查,不依赖任何既有 pull request。
-- 不按 base 去重,每次发起都是新的一条;同一仓库同一 base 已有进行中的只提醒。
-- 两条分支名由 id 推出,仍然落库——清理与展示要读同一份事实,而不是各自再推一次。
-- 不引用 repo(id):仓库移除后评审记录只写不清,范围审查同理。
CREATE TABLE IF NOT EXISTS range_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  comparison_sha TEXT NOT NULL,
  state TEXT NOT NULL,
  container_pull_number INTEGER,
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_by TEXT,
  completed_at TEXT,
  -- 最近一次 Forge 操作的失败原因。是权限还是分支保护,只有这一行能说明。
  last_forge_failure TEXT
);
CREATE INDEX IF NOT EXISTS range_review_by_base ON range_review(owner, repo, base_sha);

-- 范围审查先后审过的每一个比较项(issue #157)。当前那个在 range_review.comparison_sha
-- 上,这张表留的是整段历史:推进之后那一轮 Review Run 没跑起来时,轮次里不会有它的
-- 记录,而「这个阶段审到过哪里、谁在什么时候推的」仍然要留得下来。
CREATE TABLE IF NOT EXISTS range_review_comparison (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  range_review_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS range_review_comparison_by_review
  ON range_review_comparison(range_review_id);

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


-- 审查策略,一项一行。reviewers 是全局模型组合,与 repo.reviewers 同构(ReviewerSpec
-- 的 JSON 数组);max_changed_lines_per_batch 是正整数的字符串形,缺行即取默认值。两项各有
-- 一个独立的 *_version 键;历史库没有版本键时按版本 1 读,首次写入再落版本键。
-- 库是唯一的配置面(issue #66),没有配置文件与它竞争。
CREATE TABLE IF NOT EXISTS global_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS panel_role (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_role_permission (
  role_id INTEGER NOT NULL REFERENCES panel_role(id),
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS panel_user (
  username TEXT PRIMARY KEY,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  is_system_admin INTEGER NOT NULL DEFAULT 0,
  role_id INTEGER REFERENCES panel_role(id),
  CHECK (is_system_admin IN (0, 1)),
  CHECK (is_system_admin = 0 OR role_id IS NULL)
);

CREATE TABLE IF NOT EXISTS panel_session (
  session_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES panel_user(username),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS panel_session_by_user ON panel_session(username);
`;


/**
 * 模型服务的当前态。只保留当前版本；运行中的 Review Run 在内存里持有旧版本，不为它建
 * 历史表。迁移模块也复用这段建表语句，确保新库与迁入库只有一份 schema 定义。
 */
export const MODEL_SERVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_service (
  provider TEXT PRIMARY KEY,
  service_type TEXT NOT NULL CHECK (service_type IN ('builtin', 'custom')),
  version INTEGER NOT NULL CHECK (version > 0),
  base_url TEXT,
  api TEXT,
  target_fingerprint TEXT,
  disabled_reason TEXT CHECK (disabled_reason IS NULL OR disabled_reason = 'name-conflict'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (service_type = 'custom' AND base_url IS NOT NULL AND api IS NOT NULL
      AND target_fingerprint IS NOT NULL)
    OR (service_type = 'builtin' AND base_url IS NULL AND api IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS model_service_credential (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('unconfigured', 'pending-reverification', 'verified')),
  api_key_encrypted TEXT,
  updated_at TEXT,
  verified_at TEXT,
  validation_model TEXT,
  verification_source TEXT CHECK (
    verification_source IS NULL OR verification_source IN (
      'legacy-provider-check', 'legacy-review-run', 'inference'
    )
  ),
  CHECK (
    (state = 'unconfigured' AND api_key_encrypted IS NULL AND updated_at IS NULL
      AND verified_at IS NULL AND validation_model IS NULL AND verification_source IS NULL)
    OR (state = 'pending-reverification' AND api_key_encrypted IS NOT NULL
      AND updated_at IS NOT NULL AND verified_at IS NULL AND validation_model IS NULL
      AND verification_source IS NULL)
    OR (state = 'verified' AND api_key_encrypted IS NOT NULL AND updated_at IS NOT NULL
      AND verified_at IS NOT NULL AND verification_source IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS model_directory (
  provider TEXT PRIMARY KEY,
  service_version INTEGER NOT NULL CHECK (service_version > 0),
  state TEXT NOT NULL CHECK (
    state IN ('undiscovered', 'available', 'refresh-failed', 'discovery-failed')
  ),
  last_attempt_at TEXT,
  last_success_at TEXT,
  failure TEXT,
  ignored_model_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_model_count >= 0),
  CHECK (
    (state = 'undiscovered' AND last_attempt_at IS NULL AND last_success_at IS NULL
      AND failure IS NULL AND ignored_model_count = 0)
    OR (state = 'available' AND last_attempt_at IS NOT NULL AND last_success_at IS NOT NULL
      AND failure IS NULL)
    OR (state = 'refresh-failed' AND last_attempt_at IS NOT NULL
      AND last_success_at IS NOT NULL AND failure IS NOT NULL)
    OR (state = 'discovery-failed' AND last_attempt_at IS NOT NULL
      AND last_success_at IS NULL AND failure IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS model_directory_model (
  provider TEXT NOT NULL,
  model TEXT NOT NULL CHECK (model <> ''),
  service_version INTEGER NOT NULL CHECK (service_version > 0),
  name TEXT,
  api TEXT,
  base_url TEXT,
  input_json TEXT,
  reasoning INTEGER CHECK (reasoning IS NULL OR reasoning IN (0, 1)),
  cost_json TEXT,
  context_window INTEGER,
  max_tokens INTEGER,
  field_sources_json TEXT,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS model_supplement (
  provider TEXT NOT NULL,
  model TEXT NOT NULL CHECK (model <> ''),
  source TEXT NOT NULL CHECK (source IN ('manual', 'migration-retention')),
  target_fingerprint TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, model),
  CHECK (
    (source = 'manual' AND target_fingerprint IS NOT NULL)
    OR (source = 'migration-retention' AND target_fingerprint IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS model_service_model_state (
  provider TEXT NOT NULL,
  model TEXT NOT NULL CHECK (model <> ''),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
`;

/**
 * 加在既有表上的列。`CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做,升级前建的
 * 数据库因此拿不到新列,第一次落库就写不进去。SQLite 的 ADD COLUMN 没有 IF NOT EXISTS,
 * 只能照跑一遍、把"列已存在"这一种错吞掉。NOT NULL 列带默认值;可空列的旧行自然是
 * NULL,不需要回填。
 *
 * placement 的默认值 'inline' 对升级前的历史 fallback 行是错标(它们本该是 body),
 * 迁移时无从分辨;回填链路会在该 PR 下一次被读到时按正文锚点把它们纠正回来。
 */
const ADD_COLUMNS = [
  "ALTER TABLE reviewer_outcome ADD COLUMN anchor_rejections INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE repo ADD COLUMN reviewers TEXT",
  "ALTER TABLE review_run ADD COLUMN pr_state TEXT",
  "ALTER TABLE review_run ADD COLUMN triggered_by TEXT",
  "ALTER TABLE finding ADD COLUMN placement TEXT NOT NULL DEFAULT 'inline'",
  "ALTER TABLE review_run ADD COLUMN known_cost_usd REAL",
  "ALTER TABLE review_run ADD COLUMN cost_source TEXT",
  "ALTER TABLE review_run ADD COLUMN unknown_cost_reviewer_count INTEGER",
  "ALTER TABLE reviewer_outcome ADD COLUMN known_cost_usd REAL",
  "ALTER TABLE reviewer_outcome ADD COLUMN cost_source TEXT",
  "ALTER TABLE model_directory_model ADD COLUMN field_sources_json TEXT",
  "ALTER TABLE finding ADD COLUMN comment_id TEXT",
  "ALTER TABLE finding ADD COLUMN comment_html_url TEXT",
  "ALTER TABLE review_run ADD COLUMN range_review_id INTEGER",
  "ALTER TABLE finding ADD COLUMN disposed_by TEXT",
  "ALTER TABLE finding ADD COLUMN disposed_at TEXT",
  "ALTER TABLE finding ADD COLUMN disposition_note TEXT",
  "ALTER TABLE finding ADD COLUMN title TEXT",
  "ALTER TABLE finding ADD COLUMN continued_from TEXT",
];

/**
 * 建在 `ADD_COLUMNS` 补出来的列上的索引。
 *
 * 不能放进 `STORE_SCHEMA`:升级前建的表里那一列还不存在,而 `CREATE TABLE IF NOT
 * EXISTS` 不会补,建索引会当场报「no such column」。补列之后再建就都有了。
 */
const ADD_INDEXES = [
  "CREATE INDEX IF NOT EXISTS review_run_by_range ON review_run(range_review_id)",
];


/*
 * 历史的裸 model id 不回填(issue #73 的取舍)。升级前 `finding.model`(现已改为
 * `finding_attribution.model`)与 `reviewer_outcome.model` 存的是裸 model id,新形态是
 * `provider:model`,而 provider 从库里恢复不出来——两张表都没记过它,当前的模型组合
 * 也不是历史的证据:同一个 model id
 * 当初走 deepseek 直连、现在只配了 openrouter,按当前组合反查就会把历史 Finding 永久
 * 标成 openrouter,而这一步改完再也回不去。
 *
 * 已知代价:同一个模型在迁移前后裂成两行,统计矩阵里旧行挂裸 id、新行挂模型标识。
 * 错归厂商是不可逆的错数据,裂成两行只是看起来多一条,选后者。
 */

/** `global_setting` 的设置值与独立版本键。 */
const GLOBAL_REVIEWERS_KEY = "reviewers";
const GLOBAL_MAX_CHANGED_LINES_KEY = "max_changed_lines_per_batch";
const GLOBAL_REVIEWERS_VERSION_KEY = "reviewers_version";
const GLOBAL_MAX_CHANGED_LINES_VERSION_KEY = "max_changed_lines_per_batch_version";

/**
 * 等锁的上限。webhook 服务里 webhook 层与后台 Review Run 各持一个句柄写同一个文件,
 * 默认的 0 会让撞上写锁的那一方当场报错,而这里等几十毫秒就过去了。
 */
const BUSY_TIMEOUT_MS = 5_000;

/** 「同一个 pull request 名下的历史 finding」。回填与自动处置都按它限定范围。 */
const PULL_REQUEST_SCOPE = `run_id IN (SELECT id FROM review_run
                                        WHERE owner = ? AND repo = ? AND pull_number = ?)`;

/**
 * 还能自动处置的那些行(ADR 0016):当前处置是 unknown 或未处置,且从来没有被显式
 * 处置过。`disposed_at` 就是那个标记——面板处置写它,自动处置也写它(处置人留空),
 * 于是一行至多被自动处置一次:人把「已修复」改回未处置之后,自动规则不再碰它。
 */
const AUTO_DISPOSABLE = "disposition IN ('unknown', 'unresolved') AND disposed_at IS NULL";

/**
 * 统计口径的共同前半段:`src` 把参与统计的 finding 行摊平(fallback 在最内层就排除),
 * `identity` 按 Finding Identity(PR + 文件 + 指纹)折叠——指纹为 NULL 的行用自己的 id
 * 兜底成独立键(算不出指纹就各算一条)。处置率与参与条数共用它,两个数才落在同一批
 * Identity 上;补的那半段各自接在后面。
 */
const STATS_IDENTITY_CTE = `WITH src AS (
             SELECT f.id, f.category, f.file, f.disposition,
                    COALESCE(f.fingerprint, 'row:' || f.id) AS fp,
                    run.owner, run.repo, run.pull_number, run.started_at,
                    CASE WHEN run.pr_state = 'closed' THEN 1 ELSE 0 END AS closed
               FROM finding f
               JOIN review_run run ON f.run_id = run.id
              WHERE f.placement = 'inline'
           ),
           identity AS (
             SELECT owner, repo, pull_number, file, fp,
                    MIN(started_at) AS first_seen,
                    MAX(CASE disposition
                          WHEN 'resolved' THEN 3
                          WHEN 'fixed' THEN 2
                          WHEN 'unresolved' THEN 1
                          ELSE 0 END) AS disp,
                    -- 「已延续」的整条 Identity 退出统计(CONTEXT.md 已延续):它只是位置
                    -- 的交接,分子分母都不进,新位置那条自成一条 Identity。按 MAX 判而不是
                    -- 逐行过滤——过滤掉那一行,同一条上更早的未处置行还会把它带回分母。
                    MAX(CASE WHEN disposition = 'continued' THEN 1 ELSE 0 END) AS continued,
                    MAX(closed) AS closed
               FROM src
              GROUP BY owner, repo, pull_number, file, fp
           )`;

/** Review Run 开始时即已知的元数据。 */
export type RunMeta = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** 手动重跑的调用者用户名快照;省略或 null 即投递触发。 */
  triggeredBy?: string | null;
  /** 这一轮归属的范围审查;省略或 null 即 PR 触发(ADR 0012)。 */
  rangeReviewId?: number | null;
  startedAt: string;
  /** 预估规模:本次 Review Range 覆盖的文件数。 */
  changedFiles: number;
  /** 预估规模:本次 Review Range 的增删行数。 */
  changedLines: number;
  /** 预估规模:本次 Review Range 被切成几批。规模在阈值内时为 1。 */
  batchCount: number;
  /** 本轮固定的非秘密模型服务审计快照；没有 Reviewer 时显式传空数组。 */
  reviewerPins: readonly ReviewRunReviewerPin[];
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

/** 一条 Finding 的一个归属:报出它的那个模型自己的说法(ADR 0015)。 */
export type FindingAttributionRecord = {
  model: string;
  severity: Severity;
  category: Category;
  description: string;
};

/**
 * 一条 Finding。`groupIndex` 是它在本次 Review Run 中的合并组序号,发布之后按它把
 * Forge 评论标识记回来。
 */
export type FindingRecord = {
  file: string;
  line: number;
  /** 代表段那条归属给的标题:与 `description` 同一条来源。空串即模型没给,历史注入时占位为空。 */
  title: string;
  /** 各归属里最高的那一档。 */
  severity: Severity;
  /** 首报那个模型的分类。 */
  category: Category;
  /** 代表段:严重度最高的那条归属的表述。逐模型的表述在 `attributions` 里。 */
  description: string;
  /** 报出它的每个模型一条,按首报先后。至少一条。 */
  attributions: readonly FindingAttributionRecord[];
  fingerprint?: string;
  groupIndex: number;
  /** 本轮读回的处置结论。 */
  disposition: Disposition;
  placement: FindingPlacement;
  /** 承载它的 Forge 评论 id。本轮新发的评论要等发布之后才知道,那时走 `recordFindingComments`。 */
  commentId?: string;
  /** 那条评论在 Forge 页面上的地址。 */
  commentHtmlUrl?: string;
};

/** 一个合并组落成的那条 Forge 行级评论。发布之后才拿得到,因此与落库分成两步。 */
export type FindingCommentRef = {
  groupIndex: number;
  commentId: string;
  commentHtmlUrl: string;
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

/**
 * 复核判已修、且还能自动处置的一条历史 Finding(ADR 0016)。`findingId` 是该 Finding
 * Identity 最新一行的落库 id,也就是注入 Reviewer 时给它的那个;`commentId` 是承载它的
 * 那条 Forge 评论——自动处置写回 Forge 的仍是同一个 resolve,载体与人工处置是同一条。
 */
export type AutoDispositionCandidate = {
  findingId: number;
  commentId: string;
};

/**
 * 一条还能被延续的历史 Finding(CONTEXT.md 已延续,issue #167)。`findingId` 是注入
 * Reviewer 时给它的那个 id;`file` 与 `fingerprint` 供调用方判「旧指纹在本轮 head 上还
 * 算不算得出」;`commentId` 与 `commentHtmlUrl` 是它的旧评论——延续要 resolve 它,并把
 * 它的链接写进新评论。
 *
 * 三种行不在候选里:没有指纹的(判不了代码有没有改写)、没有评论载体或链接的(升级前
 * 的历史行与正文 fallback,resolve 不了也链不过去)、以及已经处置过的(人工处置与
 * 「已修复」都是终点,不再交接位置)。判据只看处置值,不看 `disposed_at`:延续是位置的
 * 交接,不是处置,「已修复」自动处置那道「人碰过就不再碰」的闸门不适用于它——人显式标回
 * 未处置的那条照样参与延续,它的备注与署名跟着 Identity 走到新位置(issue #163 US 36)。
 *
 * `title` 与 `description` 供调用方判「本轮这条讲的是不是同一回事」;升级前的行没有
 * 标题,取空串,判据自会退回正文。
 */
export type ContinuationCandidate = {
  findingId: number;
  file: string;
  line: number;
  title: string;
  description: string;
  fingerprint: string;
  commentId: string;
  commentHtmlUrl: string;
};

/**
 * 面板处置一条 Finding 要用的那几项。处置写在承载它的那条 Forge 评论上,因此这里
 * 带上评论 id 与它所属仓库;`commentId` 为 null 即 fallback,没有可处置的载体。
 */
export type FindingDispositionTarget = {
  id: number;
  owner: string;
  repo: string;
  commentId: string | null;
  disposition: Disposition;
  note: string | null;
};

/**
 * 一轮 Review Run 的 Review Range 两端。base 只有范围审查那一档记在库里(阶段基准),
 * PR 触发的那一档要去 Forge 上读当时那个 pull request 的 base,因此这里给 null。
 */
export type RunRange = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  rangeReviewId: number | null;
  baseSha: string | null;
};

/**
 * 一个 Reviewer 对一条历史 Finding 的复核结论(ADR 0016)。`findingId` 是注入时该
 * Finding Identity 的最新一行。`missing` 即这个模型没给这条结论,按「无法判断」落库。
 */
export type VerdictRecord = {
  model: string;
  findingId: number;
  verdict: ReviewVerdict;
  missing: boolean;
};

export type RunResult = {
  finishedAt: string;
  durationMs: number;
  failed: boolean;
  outcomes: readonly OutcomeRecord[];
  findings: readonly FindingRecord[];
  /** 本轮各 Reviewer 的复核结论。缺省即这一轮没有历史可复核。 */
  verdicts?: readonly VerdictRecord[];
};

/**
 * 处置率矩阵的一格:仓库 × category(ADR 0015)。计数单位是**同一处 Finding**
 * (Finding Identity,见 CONTEXT.md),不是落库行。分母 = resolved + fixed +
 * unresolved + unknownClosed;unknownOpen 不进分母也不上页面,API 带上它只为让口径
 * 可对账。「已延续」的那些整条不出现在这里,它是位置的交接而不是处置(CONTEXT.md
 * 已延续)。
 *
 * 主维度不含模型:一条 Finding 可以有几个归属(ADR 0015),按归属各计一次会让同一条
 * 进几格、分母重复计入,比率不可解释。模型那一维只剩参与条数,见 `ModelParticipation`。
 * 一个范围审查与一个 pull request 各是一个审查阶段,阶段之间不折叠,但同一个仓库上的
 * 各个阶段合成这一行。
 */
export type DispositionCell = {
  owner: string;
  repo: string;
  category: string;
  /** 分子的人工那一列:人在面板或 Gitea 上 resolve 的(折叠组内任一行算数)。 */
  resolved: number;
  /** 分子的自动那一列:「已修复」自动处置。人工处置优先于它。 */
  fixed: number;
  /** 人看过但未 resolve。 */
  unresolved: number;
  /** 已关闭 PR 上仍无人处置——到了终态还没人处置,那就是未处置,进分母。 */
  unknownClosed: number;
  /** 开放 PR 上还没人看——它还在流程中,不进分母。 */
  unknownOpen: number;
};

/**
 * 一个模型的参与条数:它报出过的 Finding Identity 数(ADR 0015)。Identity 与处置率
 * 分母同一批——同一时间窗、同样排除 fallback 与「已延续」——差别只在这里按归属摊开,
 * 一条 Finding 由几个模型合报时每个模型各加一。
 *
 * 它不是处置率:模型报出的问题被不被处置由人决定,拿它给模型打分读不出意义(ADR 0015)。
 * 这一列回答的是「这个模型有没有在干活」。
 */
export type ModelParticipation = {
  model: string;
  /** 该模型报出过的 Finding Identity 数。 */
  findings: number;
};

/** 仓库持有的一把 key。`generation` 是它的代次,写在 hook URL 的 `?k=` 上。 */
export type RepoKey = {
  generation: number;
  key: string;
};


export type ModelCredentialState = "unconfigured" | "pending-reverification" | "verified";
export type ModelVerificationSource =
  | "legacy-provider-check"
  | "legacy-review-run"
  | "inference";
export type ModelDirectoryState =
  | "undiscovered"
  | "available"
  | "refresh-failed"
  | "discovery-failed";
export type ModelSupplementSource = "manual" | "migration-retention";

export type ModelServiceCredential = {
  state: ModelCredentialState;
  apiKeyEncrypted: string | null;
  updatedAt: string | null;
  verifiedAt: string | null;
  /** 完整模型标识；旧版 provider 专用检查没有验证模型，因而可空。 */
  validationModel: string | null;
  verificationSource: ModelVerificationSource | null;
};

export type ModelDirectory = {
  state: ModelDirectoryState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  failure: string | null;
  ignoredModelCount: number;
};

export type ModelSupplementRecord = {
  provider: string;
  model: string;
  source: ModelSupplementSource;
  /** 手动补录绑定服务目标；迁移保留无法证明旧目标，因而为空。 */
  targetFingerprint: string | null;
  createdAt: string;
};

export type ModelServiceModelStateRecord = {
  provider: string;
  model: string;
  enabled: boolean;
  updatedAt: string;
};

export type ModelServiceModelStateUpdateResult =
  | { status: "updated"; updated: number }
  | { status: "version-conflict" }
  | { status: "unknown-models"; models: string[] }
  | { status: "referenced"; references: ModelReference[] };

export type ModelServiceRecord = {
  provider: string;
  type: "builtin" | "custom";
  version: number;
  /** 内置 provider 的目标来自 Pi，不复制进库。 */
  baseUrl: string | null;
  api: string | null;
  /** 自定义服务必有；内置服务可由 Pi 当前定义在使用时合成。 */
  targetFingerprint: string | null;
  disabledReason: "name-conflict" | null;
  createdAt: string;
  updatedAt: string;
  credential: ModelServiceCredential;
  directory: ModelDirectory;
  automaticModels: DiscoveredModel[];
  supplements: ModelSupplementRecord[];
};

/**
 * 一次 SQLite 读事务取得的全部可变启动输入。`modelServices` 只含本轮模型组合实际引用的
 * provider，因而未引用凭据的密文也不会越过这条边界。
 */
export type ReviewRunStoreSnapshot = Readonly<{
  reviewers: readonly ReviewerSpec[];
  maxChangedLinesPerBatch: number | null;
  modelServices: readonly ModelServiceRecord[];
}>;

export type ModelReferenceLocation =
  | { kind: "global" }
  | { kind: "following-global"; repositoryCount: number }
  | { kind: "repository-override"; repoId: number; owner: string; repo: string };

export type ModelReference = {
  identity: string;
  provider: string;
  model: string;
  locations: ModelReferenceLocation[];
};

export const CUSTOM_PROVIDER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export type RenameConflictingCustomModelServiceResult =
  | { status: "renamed"; version: number }
  | {
      status:
        | "version-conflict"
        | "not-conflicting"
        | "invalid-provider"
        | "provider-conflict";
    }
  | { status: "missing-models"; references: ModelReference[] };

/**
 * 一次完整当前版本写入。版本号由库按 expectedVersion 生成，避免调用方拿旧候选覆盖新版本。
 * automaticModels 是本次成功发现的完整可信快照；supplements 是这家服务的新完整集合。
 */
export type ModelServiceVersionCommit = Omit<ModelServiceRecord, "version" | "automaticModels" | "supplements"> & {
  automaticModels: readonly DiscoveredModel[];
  supplements: readonly Omit<ModelSupplementRecord, "provider">[];
};

function serializedTrustedCost(cost: ModelCost | undefined): string | null {
  if (cost === undefined || typeof cost !== "object" || cost === null) return null;
  if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every((rate) => Number.isFinite(rate) && rate >= 0)) {
    return null;
  }
  if (
    cost.tiers !== undefined &&
    (!Array.isArray(cost.tiers) ||
      cost.tiers.some(
        (tier) =>
          typeof tier !== "object" ||
          tier === null ||
          !Number.isSafeInteger(tier.inputTokensAbove) ||
          tier.inputTokensAbove <= 0 ||
          ![tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(
            (rate) => Number.isFinite(rate) && rate >= 0,
          ),
      ))
  ) {
    return null;
  }
  try {
    return JSON.stringify(cost) ?? null;
  } catch {
    return null;
  }
}

const TRUSTED_MODEL_FIELD_KEYS = [
  "name",
  "api",
  "baseUrl",
  "input",
  "reasoning",
  "cost",
  "contextWindow",
  "maxTokens",
] as const satisfies readonly (keyof TrustedModelFields)[];
const TRUSTED_MODEL_FIELD_SOURCES = new Set<TrustedModelFieldSource>([
  "service-interface",
  "pi-catalog",
  "service-target",
]);

function normalizedTrustedFieldSources(
  fields: TrustedModelFields,
  sources: TrustedModelFieldSources | undefined,
  hasTrustedCost: boolean,
): TrustedModelFieldSources | undefined {
  if (sources === undefined) return undefined;
  const normalized: TrustedModelFieldSources = {};
  for (const key of TRUSTED_MODEL_FIELD_KEYS) {
    const source = sources[key];
    if (
      source !== undefined &&
      TRUSTED_MODEL_FIELD_SOURCES.has(source) &&
      fields[key] !== undefined &&
      (key !== "cost" || hasTrustedCost)
    ) normalized[key] = source;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

/**
 * 审查策略。两项都可能没配:空库刚起来时就是这个样子,面板把它们配起来。
 */
export type GlobalSettings = {
  /** 全局模型组合的 JSON(ReviewerSpec 数组),null 即还没配。 */
  reviewersJson: string | null;
  reviewersVersion: number;
  /** 一批最多多少改动行,null 即取编排层的默认值。 */
  maxChangedLinesPerBatch: number | null;
  maxChangedLinesPerBatchVersion: number;
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
  /** 累计 Finding 数(落库行数,同一处的多个模型只算一条)。 */
  findingCount: number;
  /** 最近一次 Review Run 的开始时间,没跑过为 null。 */
  lastActivity: string | null;
};

export type RecordedCostSource = "trusted" | "unknown" | "legacy" | "mixed";

/** 面板读取的持久化用量；历史数字保留为 legacy，未知金额另带已知小计。 */
export type RecordedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  knownCostUsd: number;
  costSource: RecordedCostSource;
  costIncomplete: boolean;
  unknownCostReviewers: number;
};

/**
 * 时间流里的一条 Review Run。`models` 一行一个参与本轮的模型,按模型名排序:行的
 * 来源是 `reviewer_outcome`(一轮一模型一行),不是 `finding`——被厂商拒掉的模型产出
 * 零条 Finding,按 `finding` 分组会让它从面板上消失,失败读成没跑。
 */
export type RunListItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  /** 手动重跑的调用者用户名快照;null 即投递触发。 */
  triggeredBy: string | null;
  /** 这一轮归属的范围审查;null 即 PR 触发。时间流据此区分两类来源。 */
  rangeReviewId: number | null;
  failed: boolean;
  models: {
    model: string;
    findings: number;
    failure: string | null;
    usage?: RecordedUsage;
  }[];
  /** 本轮没有任何会话统计时省略，与失败/未运行的既有缺失语义一致。 */
  usage?: RecordedUsage;
  /** 本轮固定的模型服务版本与运行模型，不含凭据。 */
  reviewerPins: ReviewRunReviewerPin[];
  /**
   * 本轮落库的每一条 Finding,带承载它的 Forge 评论 id 与链接。面板据此按评论
   * 处置并跳到 Forge 看原版;正文 fallback 没有行级评论,两项为 null。
   */
  findings: {
    /** 落库行的 id。面板按它处置一条 Finding。 */
    id: number;
    /** 报出它的全部模型,按首报先后(ADR 0015)。 */
    models: string[];
    file: string;
    line: number;
    severity: Severity;
    category: Category;
    description: string;
    disposition: Disposition;
    placement: FindingPlacement;
    commentId: string | null;
    commentHtmlUrl: string | null;
    /** 在面板上处置的人与时刻;在 Gitea 上处置的与升级前的历史行为 null。 */
    disposedBy: string | null;
    disposedAt: string | null;
    /** 处置备注,只存面板。 */
    note: string | null;
    /**
     * 这一行承接的那条旧评论的地址(CONTEXT.md 已延续)。面板据此显示「延续自」;
     * 不是延续来的行为 null。
     */
    continuedFrom: string | null;
  }[];
  /**
   * 本轮漏复核的条数(ADR 0016):注入了历史却没给结论的「Reviewer × 历史 Finding」
   * 对数。它们按「无法判断」落库,这个数说的是模型有没有认真复核。
   */
  missedVerdicts: number;
  /** 人工处置掉的 Finding 条数。 */
  resolved: number;
  /** 「已修复」自动处置掉的 Finding 条数。 */
  fixed: number;
  total: number;
};

/**
 * 阶段汇总里的一条 Finding(issue #168):一个审查阶段按 Finding Identity 折叠之后的
 * 一条,取它最新一轮那一行——只有那一行带着当前的处置状态、备注与承载它的评论。
 *
 * `id` 是那一行的落库 id,面板按它走既有的处置接口。`firstRunId` / `lastRunId` 说的是
 * 这条活了多久:延续过的那些首见轮次跟着 Identity 走,不从交接那一轮重新算。
 *
 * 「已延续」的整条不在这里:那处 Finding 已经交接到新位置,新位置那条自己在列表里。
 */
export type StageSummaryFinding = {
  id: number;
  file: string;
  line: number;
  /** 代表段那条归属给的标题:与 `description` 同一条来源;升级前的行没有它,占位为空。 */
  title: string;
  severity: Severity;
  category: Category;
  description: string;
  /** 报出它的全部模型,按首报先后(ADR 0015)。 */
  models: string[];
  disposition: Exclude<Disposition, "continued">;
  placement: FindingPlacement;
  commentId: string | null;
  commentHtmlUrl: string | null;
  disposedBy: string | null;
  disposedAt: string | null;
  note: string | null;
  /** 承接来的那条旧评论的地址(CONTEXT.md 已延续);不是延续来的为 null。 */
  continuedFrom: string | null;
  firstRunId: number;
  firstReportedAt: string;
  lastRunId: number;
  lastReportedAt: string;
};

/**
 * 阶段时间线的一轮(issue #168)。轮次降为这个阶段的历史,每轮只说它做了什么:
 *
 * - `reported` / `folded` / `continued` 三类互斥,加起来就是这一轮落的 Finding 行数
 *   ——承接旧位置的算已延续,本阶段更早出现过的算折叠,其余是本轮新报出。
 * - `fixed` 是本轮复核判已修、且这一条现在仍记着「已修复」的条数(ADR 0016);人事后
 *   把它改回未处置之后就退出这个数——那一条从此是人工处置。
 * - `missedVerdicts` 是注入了历史却没给结论的「Reviewer × 历史 Finding」对数。
 */
export type StageTimelineEntry = {
  runId: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  reported: number;
  folded: number;
  fixed: number;
  continued: number;
  missedVerdicts: number;
};

/**
 * 一个审查阶段的当前状态(issue #168)。三个计数与列表同一口径:待处置 + 人工已处置 +
 * 已修复 恰好等于列表长度,「已延续」两边都不占。
 */
export type StageSummary = {
  findings: StageSummaryFinding[];
  counts: { pending: number; resolved: number; fixed: number };
  timeline: StageTimelineEntry[];
};

/**
 * 一个范围审查。分支名与容器 PR 序号是它在 Forge 上的全部痕迹;`lastForgeFailure`
 * 记最近一次 Forge 操作为什么没成,运维凭它分辨是权限还是分支保护。
 */
export type RangeReviewRecord = {
  id: number;
  repoId: number;
  owner: string;
  repo: string;
  baseSha: string;
  comparisonSha: string;
  state: RangeReviewState;
  /** 容器 PR 的序号;建出来之前为 null。 */
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  lastForgeFailure: string | null;
};

/** 一个范围审查审过的一个比较项。发起时那个也在内,按记录先后。 */
export type RangeReviewComparison = {
  id: number;
  sha: string;
  /** 发起或推进的人。 */
  recordedBy: string;
  recordedAt: string;
};

export type PanelRoleRecord = {
  id: number;
  name: string;
  permissions: PanelPermission[];
  createdAt: string;
};

export type PanelUserRecord = {
  username: string;
  displayName: string | null;
  passwordHash: string;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  isSystemAdmin: boolean;
  roleId: number | null;
};

export type PanelSessionRecord = {
  username: string;
  displayName: string | null;
  mustChangePassword: boolean;
  isSystemAdmin: boolean;
  roleId: number | null;
  expiresAt: string;
};

/**
 * 失败原因在面板上只显示一句话的量。厂商拒绝的原文可能是一整段 JSON(区域封禁那条
 * 403 就是),整段带到前端会把卡片撑开,而人要的是「哪个模型、为什么」——换行压成
 * 空格、截到这个长度,原文仍在库里可查。
 */
const FAILURE_EXCERPT_CHARS = 200;

function failureExcerpt(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > FAILURE_EXCERPT_CHARS
    ? `${text.slice(0, FAILURE_EXCERPT_CHARS)}…`
    : text;
}

function rangeReviewRecord(row: Record<string, unknown>): RangeReviewRecord {
  return {
    id: Number(row["id"]),
    repoId: Number(row["repo_id"]),
    owner: String(row["owner"]),
    repo: String(row["repo"]),
    baseSha: String(row["base_sha"]),
    comparisonSha: String(row["comparison_sha"]),
    state: String(row["state"]) as RangeReviewState,
    containerPullNumber:
      row["container_pull_number"] === null ? null : Number(row["container_pull_number"]),
    baseBranch: String(row["base_branch"]),
    headBranch: String(row["head_branch"]),
    createdBy: String(row["created_by"]),
    createdAt: String(row["created_at"]),
    completedBy: row["completed_by"] === null ? null : String(row["completed_by"]),
    completedAt: row["completed_at"] === null ? null : String(row["completed_at"]),
    lastForgeFailure:
      row["last_forge_failure"] === null ? null : String(row["last_forge_failure"]),
  };
}

export type Store = {
  listPanelRoles(): PanelRoleRecord[];
  createPanelRole(record: {
    name: string;
    permissions: readonly PanelPermission[];
    createdAt: string;
  }): PanelRoleRecord;
  updatePanelRole(
    id: number,
    record: { name: string; permissions: readonly PanelPermission[] },
  ): PanelRoleRecord | undefined;
  removePanelRole(id: number): { removed: boolean; usernames: string[] };
  listPanelUsers(): PanelUserRecord[];
  updatePanelUser(
    username: string,
    record: { displayName: string | null; roleId: number | null; isSystemAdmin: boolean },
  ): "updated" | "missing" | "last-system-admin";
  resetPanelPassword(username: string, passwordHash: string): boolean;
  countPanelUsers(): number;
  getPanelUser(username: string): PanelUserRecord | undefined;
  /** 这个用户名是否已作为手动重跑的调用者写进历史;建号时据此拒绝名字重用。 */
  hasHistoricalRunTrigger(username: string): boolean;
  registerFirstPanelUser(record: Omit<PanelUserRecord, "lastLoginAt">): boolean;
  createPanelUser(record: Omit<PanelUserRecord, "lastLoginAt">): void;
  createPanelSession(record: {
    sessionHash: string;
    username: string;
    expiresAt: string;
    createdAt: string;
  }): void;
  getPanelSession(sessionHash: string): PanelSessionRecord | undefined;
  renewPanelSession(sessionHash: string, expiresAt: string): void;
  removePanelSession(sessionHash: string): void;
  removePanelSessions(username: string, exceptHash?: string): void;
  updatePanelPassword(username: string, passwordHash: string, mustChangePassword: boolean): void;
  removePanelUser(username: string): void;
  /**
   * 注册表行、第一把 Key 与可选仓库模型覆盖在一个写事务里落库。覆盖只有在同一事务
   * 看到的当前模型服务仍可运行全部模型时才写；状态已经变化则返回 false。
   */
  registerRepo(record: {
    repoId: number;
    owner: string;
    repo: string;
    generation: number;
    key: string;
    reviewersJson?: string;
  }): boolean;
  /** 给仓库加一把 key,轮转(ADR 0007)开新代次用。同仓库同代次重复添加直接抛。 */
  addRepoKey(repoId: number, generation: number, key: string): void;
  /** 摘掉一把 key,轮转收尾时删旧代次用。不存在时静默通过——目标状态已达成。 */
  removeRepoKey(repoId: number, generation: number): void;
  /** 仓库持有的全部 key。未注册的仓库得到空数组——这就是「未注册」的判据。 */
  listRepoKeys(repoId: number): RepoKey[];
  getRepo(repoId: number): RepoRecord | undefined;
  /** 改写模型覆盖；与当前模型服务原子校验，状态变化返回 false。null 即跟随全局。 */
  setRepoReviewers(repoId: number, reviewersJson: string | null): boolean;
  /** 摘掉注册表行与它的 Key。评审记录一行不动:模型选型的历史不因下线而断。 */
  removeRepo(repoId: number): void;
  /** 全部已注册仓库,按最近活动排序,没跑过的按注册时间排在后面。 */
  listRepos(): RepoSummary[];
  /** 审查策略。历史值和未写过的项都从版本 1 开始。 */
  getGlobalSettings(): GlobalSettings;
  /** 按独立版本改写全局模型组合；陈旧版本或模型服务状态变化返回 false。 */
  putGlobalReviewers(expectedVersion: number, reviewersJson: string): boolean;
  /** 按独立版本设置批次上限；null 移除自定义值，陈旧版本返回 false。 */
  putGlobalBatchLimit(expectedVersion: number, limit: number | null): boolean;
  /** 测试夹具和启动播种的兼容入口；面板写链不得使用。 */
  putGlobalSettings(settings: Pick<GlobalSettings, "reviewersJson" | "maxChangedLinesPerBatch">): boolean;
  /**
   * 在一个 SQLite 读事务里取得仓库生效组合、批次上限及其引用的当前模型服务版本。
   * 仓库不存在时抛错；坏配置沿用设置入口的校验错误。
   */
  getReviewRunSnapshot(repoId: number): ReviewRunStoreSnapshot;
  /**
   * 原子提交一个完整当前版本。expectedVersion 为 null 表示只在名称仍不存在时新建；否则
   * 只在当前版本相等时推进一版。版本不匹配返回 undefined，任何字段都不写。
   */
  commitModelServiceVersion(
    expectedVersion: number | null,
    record: ModelServiceVersionCommit,
  ): number | undefined;
  /** 只恢复因内置名称冲突而停用的自定义服务；当前引用与服务事实同事务改名。 */
  renameConflictingCustomModelService(
    provider: string,
    newProvider: string,
    expectedVersion: number,
    updatedAt: string,
  ): RenameConflictingCustomModelServiceResult;
  /**
   * 仅在自定义服务版本仍等于 expectedVersion 时原子删除当前服务、凭据、目录和补录。
   * 版本不匹配、服务不存在或不是自定义服务时返回 false，任何字段都不删。
   */
  removeCustomModelService(provider: string, expectedVersion: number): boolean;
  getModelService(provider: string): ModelServiceRecord | undefined;
  listModelServices(): ModelServiceRecord[];
  /**
   * 当前模型组合里的全部完整模型标识及位置。跟随全局的仓库按人数汇总；已移除仓库不在
   * `repo` 表里，自然不参与。凭据、模型补录与服务删除共用这一份引用判据。
   */
  listModelReferences(): ModelReference[];
  listModelServiceModelStates(provider?: string): ModelServiceModelStateRecord[];
  updateModelServiceModelStates(
    provider: string,
    expectedVersion: number,
    models: readonly string[],
    enabled: boolean,
    updatedAt: string,
  ): ModelServiceModelStateUpdateResult;
  /** provider 省略时也包含没有当前服务承载的迁移保留。 */
  listModelSupplements(provider?: string): ModelSupplementRecord[];
  startRun(meta: RunMeta): number;
  finishRun(runId: number, result: RunResult): void;
  /**
   * 本审查阶段已经报过的 Finding,注入给这一轮的每个 Reviewer(ADR 0016)。
   *
   * 阶段的范围:`rangeReviewId` 给了就取该范围审查名下全部轮次,没给就取该 pull
   * request 名下、不属于任何范围审查的全部轮次。按 Finding Identity(文件 + 指纹,
   * 算不出指纹的行各算一条)折叠,每条取最新一行——那一行才带着当前的处置状态与备注。
   * 不设条数上限;已处置的条目由调用方按 `disposition` 只用那一行的字段。
   */
  stageHistory(scope: StageScope): HistoryFinding[];
  /**
   * 一个审查阶段的当前状态(issue #168):按 Finding Identity 折叠的 Finding 列表、
   * 三个计数与逐轮的时间线。
   *
   * 阶段的范围与 `stageHistory` 同一份判据(`stageScope`)。折叠键同样是「文件 + 指纹」,
   * 算不出指纹的行各算一条;每条取最新一行。延续把同一条 Identity 交接到新位置,交接
   * 前后是同一条:旧那条不单独出现,新那条继承它的首见轮次。
   */
  stageSummary(scope: StageScope): StageSummary;
  /**
   * 把本轮新发出去的行级评论的 id 与链接补到对应的合并组上。
   *
   * 与 `finishRun` 分成两步:落库要先于发布(发布失败不该把这轮的过程记录一并丢掉),
   * 而评论 id 只有发布之后才拿得到。跨轮匹配折叠的那些不走这里,它们记的是历史评论,
   * `finishRun` 时就已经知道。
   */
  recordFindingComments(runId: number, refs: readonly FindingCommentRef[]): void;
  /**
   * 处置率统计(ADR 0006,主维度见 ADR 0015):按 Finding Identity 折叠,fallback
   * (body)排除,unknown 按 PR 状态分流,时间窗按同一处 Finding 首次报出那轮的开始
   * 时间归属(闭区间,ISO 字符串按字典序即时间序)。
   */
  dispositionStats(from: string, to: string): DispositionCell[];
  /** 同一时间窗、同一批 Identity 上每个模型的参与条数(ADR 0015)。 */
  modelParticipation(from: string, to: string): ModelParticipation[];
  /** 时间窗内 Review Run 的 token、已知费用小计与未知费用 Reviewer 数。 */
  usageStats(from: string, to: string): RecordedUsage | undefined;
  /**
   * 时间流的一页:按 id 倒序(id 即落库顺序,与开跑时间同序),`beforeId` 取更早的
   * 一页。覆盖全部评审记录——已移除仓库的历史照常出现,这是留存决策的呈现面。
   */
  listRuns(opts: {
    beforeId?: number;
    limit: number;
    owner?: string;
    repo?: string;
    rangeReviewId?: number;
  }): RunListItem[];
  /**
   * 落一条范围审查,返回它的 id。两条分支名由 id 推出,和插入在同一个事务里补上——
   * 记录一旦可见就必须带着分支名,否则中途失败的清理无从知道该删哪两条。
   */
  createRangeReview(record: {
    repoId: number;
    owner: string;
    repo: string;
    baseSha: string;
    comparisonSha: string;
    createdBy: string;
    createdAt: string;
  }): number;
  /** 容器 PR 建成后记下它的序号,并清掉上一次的失败原因。 */
  attachRangeReviewContainer(id: number, containerPullNumber: number): void;
  /** Forge 操作失败:记下原因并让这条进入 failed,它不再占住「同一 base 进行中」。 */
  failRangeReview(id: number, failure: string): void;
  /**
   * 记下一次 Forge 操作为什么没成,状态不变。
   *
   * 与 `failRangeReview` 分开:发起失败的记录没有容器 PR,只能作废;推进与审查完成
   * 失败的记录容器 PR 还在,人改完权限再点一次就该继续,把它打成 failed 反而堵死重试。
   */
  recordRangeReviewForgeFailure(id: number, failure: string): void;
  /**
   * 把当前比较项推到新的 commit,并把它记进历史(issue #157)。上一次的失败原因跟着
   * 清掉——这一次成了,那条原因说的是上一次的事。
   */
  advanceRangeReview(record: {
    id: number;
    comparisonSha: string;
    advancedBy: string;
    advancedAt: string;
  }): void;
  /** 这个范围审查先后审过的比较项,按记录先后。 */
  listRangeReviewComparisons(rangeReviewId: number): RangeReviewComparison[];
  /**
   * 审查完成:进终态并记下完成人与时刻(CONTEXT.md 审查完成)。
   *
   * 只在 Forge 那几步都做完之后调用——容器 PR 还开着的时候记成已完成,人就再也推不动
   * 比较项,而仓库里那两条分支还留着。
   */
  completeRangeReview(record: {
    id: number;
    completedBy: string;
    completedAt: string;
  }): void;
  getRangeReview(id: number): RangeReviewRecord | undefined;
  /** 按 id 倒序。四个过滤条件都可省,省掉即不过滤。 */
  listRangeReviews(opts: {
    owner?: string;
    repo?: string;
    baseSha?: string;
    state?: RangeReviewState;
  }): RangeReviewRecord[];
  /**
   * 一轮 Review Run 的两端。diff 视图按它去本地 clone 上取 base..head。
   * id 不存在时返回 undefined。
   */
  getRunRange(id: number): RunRange | undefined;
  /** 面板处置前要读的那一行。id 不存在时返回 undefined。 */
  getFinding(id: number): FindingDispositionTarget | undefined;
  /**
   * 面板作出的一次处置。写的是「承载它的那条 Forge 评论」名下、同一仓库里的每一行:
   * 一条 Finding 落成一条评论,resolve 作用在评论上;跨轮折叠的历史行记的也是同一条
   * 评论,同样跟着变。
   *
   * `note` 省略即保留原备注:unresolve 之后备注仍要留着(CONTEXT.md 处置备注)。
   * 返回被改写的行数。
   */
  recordDisposition(input: {
    owner: string;
    repo: string;
    commentId: string;
    disposition: Disposition;
    disposedBy: string;
    disposedAt: string;
    note?: string;
  }): number;
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
   * 这些历史 Finding 里还能自动处置的那些(ADR 0016):当前处置是 unknown 或未处置、
   * 从来没有被显式处置过、且有一条行级评论承载。只活在 review 正文里的没有 resolve
   * 载体,写不回 Forge,一律挡掉。
   *
   * 先问库再写 Forge:已经自动处置过的、以及人在面板上处置过的都在这里被挡掉,
   * Forge 那一步因此不会一轮轮重复 resolve 同一条评论,也不会与在 Forge 上撤回处置
   * 的人对着干。
   */
  pendingAutoDispositions(findingIds: readonly number[]): AutoDispositionCandidate[];
  /**
   * 记一次「已修复」自动处置(ADR 0016)。处置人留空——这一档不是人做的;处置时刻
   * 照记,它同时是「这一行已被显式处置过」的标记,自动规则据此至多碰一行一次。
   *
   * 落的是整条 Finding Identity:这个 pull request 名下与它同「文件 + 指纹」的历史行
   * 一并改写,口径与回填一致。
   */
  recordAutoDisposition(
    owner: string,
    repo: string,
    pullNumber: number,
    candidate: AutoDispositionCandidate,
    disposedAt: string,
  ): void;
  /**
   * 这些历史 Finding 里还能被延续的那些(CONTEXT.md 已延续,issue #167)。判据见
   * `ContinuationCandidate`;顺序与传入的 id 同序,调用方据此得到确定的配对结果。
   */
  continuationCandidates(findingIds: readonly number[]): ContinuationCandidate[];
  /**
   * 记一次延续:旧行改记「已延续」,处置备注、处置人与处置时刻随 Identity 落到本轮
   * 新行上,新行同时记下旧评论的链接。
   *
   * 旧那一侧落的是整条 Finding Identity(同「文件 + 指纹」的历史行一并改写),口径与
   * 「已修复」自动处置和回填一致。元数据继承与 issue #152 同一个理由:处置的载体换了
   * 位置,人的备注、署名与「已经显式处置过」这个标记要跟着走,否则自动规则会再碰一次。
   */
  recordContinuation(input: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** 承接它的本轮 Review Run 与合并组。 */
    runId: number;
    groupIndex: number;
    candidate: ContinuationCandidate;
  }): void;
  /**
   * 回填 disposition(ADR 0006):对这个 pull request 名下、文件与指纹都对上的全部
   * 历史 finding,以 Forge 的最新状态覆盖已有值——人 resolve 后又 unresolve,库里跟着改。
   *
   * 「已修复」不被读回的 resolved 降级成人工处置那一档;「已延续」两个方向都不被覆盖
   * ——那条评论的 resolve 状态说的已经不是这条 Finding 的处置。
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

function nonNegativeFinite(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

/** 坏的或来源不可信的金额在持久化边界统一降为未知，绝不夹成零。 */
function normalizedUsage(usage: ReviewerUsage): ReviewerUsage {
  const costUsd = nonNegativeFinite(usage.costUsd);
  if (usage.costSource === "trusted" && costUsd !== undefined) {
    return { ...usage, costUsd, knownCostUsd: costUsd, costSource: "trusted" };
  }
  return {
    ...usage,
    costUsd: null,
    knownCostUsd: nonNegativeFinite(usage.knownCostUsd) ?? 0,
    costSource: "unknown",
  };
}

function usageColumns(usage: ReviewerUsage | undefined): (number | string | null)[] {
  if (usage === undefined) return Array.from({ length: 8 }, () => null);
  const recorded = normalizedUsage(usage);
  return [
    recorded.inputTokens,
    recorded.outputTokens,
    recorded.cacheReadTokens,
    recorded.cacheWriteTokens,
    recorded.totalTokens,
    recorded.costUsd,
    recorded.knownCostUsd,
    recorded.costSource,
  ];
}

function unknownCostReviewerCount(outcomes: readonly { usage?: ReviewerUsage }[]): number {
  return outcomes.reduce(
    (count, outcome) =>
      count +
      (outcome.usage !== undefined && normalizedUsage(outcome.usage).costSource === "unknown"
        ? 1
        : 0),
    0,
  );
}

function recordedUsage(
  row: Record<string, unknown>,
  unknownCountColumn = "unknown_cost_reviewer_count",
): RecordedUsage | undefined {
  if (row["total_tokens"] === null || row["total_tokens"] === undefined) return undefined;

  const rawSource = row["cost_source"];
  let costSource: RecordedCostSource =
    rawSource === "trusted" || rawSource === "unknown" || rawSource === "legacy"
      ? rawSource
      : row["cost_usd"] === null || row["cost_usd"] === undefined
        ? "unknown"
        : "legacy";
  const numericCost = nonNegativeFinite(row["cost_usd"]);
  if (costSource !== "unknown" && numericCost === undefined) costSource = "unknown";
  const costUsd = costSource === "unknown" ? null : numericCost!;
  const unknownCostReviewers =
    nonNegativeFinite(row[unknownCountColumn]) ?? (costSource === "unknown" ? 1 : 0);

  return {
    inputTokens: Number(row["input_tokens"] ?? 0),
    outputTokens: Number(row["output_tokens"] ?? 0),
    cacheReadTokens: Number(row["cache_read_tokens"] ?? 0),
    cacheWriteTokens: Number(row["cache_write_tokens"] ?? 0),
    totalTokens: Number(row["total_tokens"]),
    costUsd,
    knownCostUsd: nonNegativeFinite(row["known_cost_usd"]) ?? costUsd ?? 0,
    costSource,
    costIncomplete: costSource === "unknown" || unknownCostReviewers > 0,
    unknownCostReviewers,
  };
}

/**
 * 累加 Reviewer 用量。没有任何会话统计时保持缺失；任一项价格未知时总费用未知，但 token 与
 * 已知金额小计照常累加。未知占优使跨批次和整轮聚合使用同一条语义。
 */
export function sumUsage(
  outcomes: readonly { usage?: ReviewerUsage }[],
): ReviewerUsage | undefined {
  const usages = outcomes.flatMap((outcome) =>
    outcome.usage === undefined ? [] : [outcome.usage],
  );
  if (usages.length === 0) return undefined;

  const total: ReviewerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    knownCostUsd: 0,
    costSource: "trusted",
  };
  for (const rawUsage of usages) {
    const usage = normalizedUsage(rawUsage);
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.totalTokens += usage.totalTokens;
    total.knownCostUsd += usage.knownCostUsd;
    if (usage.costSource === "unknown" || usage.costUsd === null) {
      total.costSource = "unknown";
      total.costUsd = null;
    } else if (total.costUsd !== null) {
      total.costUsd += usage.costUsd;
    }
  }
  return total;
}


/** 高的在前,与 `dedupe.ts` 的 SEVERITY_RANK 同序。 */
const MIGRATION_SEVERITY_RANK: Record<string, number> = { P0: 3, P1: 2, P2: 1 };

/** 同一处上取最强的那一档,与处置率折叠同序。旧字面量 `changed` 与 `fixed` 同档。 */
const MIGRATION_DISPOSITION_RANK: Record<string, number> = {
  resolved: 3,
  fixed: 2,
  changed: 2,
  unresolved: 1,
  unknown: 0,
};

/**
 * 把升级前「一模型一行」的 finding 按新的 Finding Identity 重新折叠(ADR 0015)。
 *
 * 键是「同一轮 + 文件 + 指纹」,算不出指纹的退回它当初的合并组序号——那正是它当初落成
 * 的那一条评论。组内 id 最小的那行留下:它是首报,分类与归属次序都以它为准;严重度取
 * 组内最高,代表段取严重度最高的那条,处置取最强的那一档。每一条旧行留一条模型归属,
 * 历史统计因此不断裂。
 *
 * `changed` 改写为 `fixed`(只换名不换义,判据由 ADR 0016 换成复核结论)。重新折叠、
 * 归属写入、删旧行、去掉 model 列与改写字面量全在同一个事务里:中途失败整体回滚,
 * 下次启动从原样重来。
 */
function foldFindingIdentity(db: DatabaseSync): void {
  const legacyShape = db
    .prepare("PRAGMA table_info(finding)")
    .all()
    .some((row) => String(row["name"]) === "model");
  const legacyLiteral =
    db.prepare("SELECT 1 FROM finding WHERE disposition = 'changed' LIMIT 1").get() !==
    undefined;
  if (!legacyShape && !legacyLiteral) return;

  db.exec("BEGIN");
  try {
    if (legacyShape) {
      const rows = db
        .prepare(
          `SELECT id, run_id, model, file, line, severity, category, description,
                  fingerprint, group_index, disposition, placement,
                  comment_id, comment_html_url, disposed_by, disposed_at, disposition_note
             FROM finding ORDER BY id`,
        )
        .all();

      const groups = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        // 指纹算不出的行退回合并组序号:它与同组的其他行落在同一条评论上。
        const anchor =
          row["fingerprint"] === null
            ? `group:${String(row["group_index"])}`
            : String(row["fingerprint"]);
        const key = `${String(row["run_id"])}\n${String(row["file"])}\n${anchor}`;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }

      const updateKeeper = db.prepare(
        `UPDATE finding
            SET line = ?, severity = ?, category = ?, description = ?,
                disposition = ?, comment_id = ?, comment_html_url = ?,
                disposed_by = ?, disposed_at = ?, disposition_note = ?
          WHERE id = ?`,
      );
      const insertAttribution = db.prepare(
        `INSERT INTO finding_attribution
           (finding_id, position, model, severity, category, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const deleteRow = db.prepare("DELETE FROM finding WHERE id = ?");
      const firstNotNull = (
        list: readonly Record<string, unknown>[],
        column: string,
      ): unknown => list.find((row) => row[column] !== null)?.[column] ?? null;
      const strongest = (
        list: readonly Record<string, unknown>[],
        column: string,
        rank: Record<string, number>,
      ): string =>
        [...list].sort(
          (a, b) => (rank[String(b[column])] ?? 0) - (rank[String(a[column])] ?? 0),
        )[0]![column] as string;

      for (const group of groups.values()) {
        const keeper = group[0]!;
        const bySeverity = [...group].sort(
          (a, b) =>
            (MIGRATION_SEVERITY_RANK[String(b["severity"])] ?? 0) -
            (MIGRATION_SEVERITY_RANK[String(a["severity"])] ?? 0),
        );
        const leading = bySeverity[0]!;
        updateKeeper.run(
          Math.min(...group.map((row) => Number(row["line"]))),
          String(leading["severity"]),
          String(keeper["category"]),
          String(leading["description"]),
          strongest(group, "disposition", MIGRATION_DISPOSITION_RANK),
          firstNotNull(group, "comment_id") as string | null,
          firstNotNull(group, "comment_html_url") as string | null,
          firstNotNull(group, "disposed_by") as string | null,
          firstNotNull(group, "disposed_at") as string | null,
          firstNotNull(group, "disposition_note") as string | null,
          Number(keeper["id"]),
        );

        // 一个模型一条归属,按首报先后;同一个模型在组里有两行时留严重度高的那条。
        const attributions: Record<string, unknown>[] = [];
        for (const row of group) {
          const index = attributions.findIndex((a) => a["model"] === row["model"]);
          if (index === -1) attributions.push(row);
          else if (
            (MIGRATION_SEVERITY_RANK[String(row["severity"])] ?? 0) >
            (MIGRATION_SEVERITY_RANK[String(attributions[index]!["severity"])] ?? 0)
          ) {
            attributions[index] = row;
          }
        }
        for (const [position, said] of attributions.entries()) {
          insertAttribution.run(
            Number(keeper["id"]),
            position,
            String(said["model"]),
            String(said["severity"]),
            String(said["category"]),
            String(said["description"]),
          );
        }

        for (const row of group.slice(1)) deleteRow.run(Number(row["id"]));
      }

      db.exec("ALTER TABLE finding DROP COLUMN model");
    }

    // 旧库里的「已改动」就是这一档:名字改成「已修复」,判据由 ADR 0016 换成复核结论。
    db.exec("UPDATE finding SET disposition = 'fixed' WHERE disposition = 'changed'");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 一个审查阶段覆盖哪些 Review Run(CONTEXT.md 审查阶段)。两条链路各一档:范围审查取
 * 它名下全部轮次,PR 触发取这个 pull request 名下、不属于任何范围审查的那些——容器 PR
 * 的轮次不该混进 PR 链路。历史注入与阶段汇总读的是同一个阶段,判据因此只定这一次。
 *
 * 条件里的表别名固定是 `run`,调用方按它 join `review_run`。
 */
export type StageScope =
  | { rangeReviewId: number }
  | { owner: string; repo: string; pullNumber: number };

function stageScope(scope: StageScope): [string, (string | number)[]] {
  return "rangeReviewId" in scope
    ? ["run.range_review_id = ?", [scope.rangeReviewId]]
    : [
        `run.owner = ? AND run.repo = ? AND run.pull_number = ?
           AND run.range_review_id IS NULL`,
        [scope.owner, scope.repo, scope.pullNumber],
      ];
}

/** 打开当前 schema；schema-v0 数据库必须先经过模型服务迁移器。 */
export function openStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  let modelServiceSchemaVersion = Number(
    db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0,
  );
  if (modelServiceSchemaVersion === 0) {
    const existingTables = Number(
      db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).get()?.["count"] ?? 0,
    );
    if (existingTables !== 0) {
      db.close();
      throw new Error("schema-v0 数据库必须先完成模型服务迁移");
    }
    db.exec(STORE_SCHEMA);
    db.exec(MODEL_SERVICE_SCHEMA);
    db.exec("PRAGMA user_version = 1");
    modelServiceSchemaVersion = 1;
  }
  if (modelServiceSchemaVersion !== 1) {
    db.close();
    throw new Error(`不支持数据库 schema 版本 ${modelServiceSchemaVersion}`);
  }
  db.exec(STORE_SCHEMA);
  db.exec(MODEL_SERVICE_SCHEMA);
  for (const statement of ADD_COLUMNS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  for (const statement of ADD_INDEXES) db.exec(statement);
  try {
    foldFindingIdentity(db);
  } catch (error) {
    // 迁移整笔回滚了,库还是升级前那副样子。句柄跟着还回去:webhook 服务是长跑进程。
    db.close();
    throw error;
  }
  const reviewRunColumns = new Set(
    db.prepare("PRAGMA table_info(review_run)").all().map((row) => String(row["name"])),
  );
  const reviewerOutcomeColumns = new Set(
    db.prepare("PRAGMA table_info(reviewer_outcome)").all().map((row) => String(row["name"])),
  );
  if (
    reviewRunColumns.has("total_tokens") &&
    reviewRunColumns.has("cost_usd") &&
    reviewerOutcomeColumns.has("total_tokens") &&
    reviewerOutcomeColumns.has("cost_usd")
  ) {
    db.exec(`
      UPDATE reviewer_outcome
         SET known_cost_usd = CASE WHEN cost_usd >= 0 THEN cost_usd ELSE 0 END,
             cost_source = CASE WHEN cost_usd >= 0 THEN 'legacy' ELSE 'unknown' END
       WHERE total_tokens IS NOT NULL AND cost_source IS NULL;
      UPDATE review_run
         SET known_cost_usd = CASE WHEN cost_usd >= 0 THEN cost_usd ELSE 0 END,
             cost_source = CASE WHEN cost_usd >= 0 THEN 'legacy' ELSE 'unknown' END,
             unknown_cost_reviewer_count = CASE
               WHEN cost_usd >= 0 THEN 0
               ELSE MAX(1, (SELECT COUNT(*) FROM reviewer_outcome outcome
                             WHERE outcome.run_id = review_run.id
                               AND outcome.cost_source = 'unknown'))
             END
       WHERE total_tokens IS NOT NULL AND cost_source IS NULL;
    `);
  }

  // 系统管理员 bootstrap 与普通创建共用同一条用户写入语义。
  const writePanelUser = (record: Omit<PanelUserRecord, "lastLoginAt">): void => {
    db.prepare(
      `INSERT INTO panel_user
         (username, display_name, password_hash, must_change_password, created_at, is_system_admin, role_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.username,
      record.displayName,
      record.passwordHash,
      record.mustChangePassword ? 1 : 0,
      record.createdAt,
      record.isSystemAdmin ? 1 : 0,
      record.roleId,
    );
  };

  const parseStoredReviewers = (reviewersJson: string, context: string): ReviewerSpec[] =>
    assertReviewerSpecs(JSON.parse(reviewersJson), context, { allowEmpty: true });

  const availableModel = db.prepare(`
    SELECT 1
      FROM model_service service
      JOIN model_service_credential credential ON credential.provider = service.provider
     WHERE service.provider = ?
       AND service.target_fingerprint IS NOT NULL
       AND credential.state = 'verified'
       AND credential.api_key_encrypted IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM model_service_model_state state
          WHERE state.provider = service.provider
            AND state.model = ?
            AND state.enabled = 0
       )
       AND (
         EXISTS (
           SELECT 1 FROM model_directory_model automatic
            WHERE automatic.provider = service.provider
              AND automatic.model = ?
              AND automatic.service_version = service.version
         )
         OR EXISTS (
           SELECT 1 FROM model_supplement supplement
            WHERE supplement.provider = service.provider
              AND supplement.model = ?
              AND (
                supplement.source = 'migration-retention'
                OR (supplement.source = 'manual'
                    AND supplement.target_fingerprint = service.target_fingerprint)
              )
         )
       )
  `);
  const modelCombinationAvailable = (reviewersJson: string, context: string): boolean => {
    const reviewers = parseStoredReviewers(reviewersJson, context);
    return reviewers.length > 0 && reviewers.every((reviewer) =>
      availableModel.get(reviewer.provider, reviewer.model, reviewer.model, reviewer.model) !== undefined
    );
  };
  const referencedModels = (provider: string): Set<string> => {
    const models = new Set<string>();
    const globalJson = db
      .prepare("SELECT value FROM global_setting WHERE key = ?")
      .get(GLOBAL_REVIEWERS_KEY)?.["value"];
    if (globalJson !== undefined) {
      for (const reviewer of parseStoredReviewers(String(globalJson), GLOBAL_REVIEWERS_CONTEXT)) {
        if (reviewer.provider === provider) models.add(reviewer.model);
      }
    }
    const overrides = db.prepare("SELECT id, reviewers FROM repo WHERE reviewers IS NOT NULL").all();
    for (const row of overrides) {
      for (const reviewer of parseStoredReviewers(
        String(row["reviewers"]),
        `仓库 ${Number(row["id"])} 的模型覆盖`,
      )) {
        if (reviewer.provider === provider) models.add(reviewer.model);
      }
    }
    return models;
  };
  const recordSupportsCurrentReferences = (record: ModelServiceVersionCommit): boolean => {
    const references = new Set(
      [...referencedModels(record.provider)].filter((model) =>
        availableModel.get(record.provider, model, model, model) !== undefined
      ),
    );
    if (references.size === 0) return true;
    if (
      record.targetFingerprint === null ||
      record.credential.state !== "verified" ||
      record.credential.apiKeyEncrypted === null
    ) return false;
    const models = new Set(record.automaticModels.map((model) => model.id));
    for (const supplement of record.supplements) {
      if (
        supplement.source === "migration-retention" ||
        supplement.targetFingerprint === record.targetFingerprint
      ) models.add(supplement.model);
    }
    return [...references].every((model) => models.has(model));
  };

  const store: Store = {
    listPanelRoles() {
      const rows = db
        .prepare(
          `SELECT r.id, r.name, r.created_at, p.permission
             FROM panel_role r LEFT JOIN panel_role_permission p ON p.role_id = r.id
            ORDER BY r.id, p.permission`,
        )
        .all();
      const roles: PanelRoleRecord[] = [];
      for (const row of rows) {
        const id = Number(row["id"]);
        let role = roles.find((item) => item.id === id);
        if (role === undefined) {
          role = { id, name: String(row["name"]), permissions: [], createdAt: String(row["created_at"]) };
          roles.push(role);
        }
        if (row["permission"] !== null) {
          const value = String(row["permission"]);
          if (isPanelPermission(value)) role.permissions.push(value);
        }
      }
      return roles;
    },

    createPanelRole(record) {
      db.exec("BEGIN");
      try {
        const result = db.prepare("INSERT INTO panel_role (name, created_at) VALUES (?, ?)").run(
          record.name,
          record.createdAt,
        );
        const id = Number(result.lastInsertRowid);
        for (const permission of record.permissions) {
          db.prepare("INSERT INTO panel_role_permission (role_id, permission) VALUES (?, ?)").run(id, permission);
        }
        db.exec("COMMIT");
        return { id, ...record, permissions: [...record.permissions] };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    updatePanelRole(id, record) {
      if (db.prepare("SELECT 1 FROM panel_role WHERE id = ?").get(id) === undefined) return undefined;
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE panel_role SET name = ? WHERE id = ?").run(record.name, id);
        db.prepare("DELETE FROM panel_role_permission WHERE role_id = ?").run(id);
        for (const permission of record.permissions) {
          db.prepare("INSERT INTO panel_role_permission (role_id, permission) VALUES (?, ?)").run(id, permission);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return store.listPanelRoles().find((role) => role.id === id);
    },

    removePanelRole(id) {
      const usernames = db
        .prepare("SELECT username FROM panel_user WHERE role_id = ? ORDER BY username")
        .all(id)
        .map((row) => String(row["username"]));
      if (usernames.length > 0) return { removed: false, usernames };
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM panel_role_permission WHERE role_id = ?").run(id);
        const result = db.prepare("DELETE FROM panel_role WHERE id = ?").run(id);
        db.exec("COMMIT");
        return { removed: Number(result.changes) > 0, usernames: [] };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listPanelUsers() {
      return db
        .prepare(
          `SELECT username, display_name, password_hash, must_change_password, created_at,
                  last_login_at, is_system_admin, role_id FROM panel_user ORDER BY username`,
        )
        .all()
        .map((row) => ({
          username: String(row["username"]),
          displayName: row["display_name"] === null ? null : String(row["display_name"]),
          passwordHash: String(row["password_hash"]),
          mustChangePassword: Number(row["must_change_password"]) === 1,
          createdAt: String(row["created_at"]),
          lastLoginAt: row["last_login_at"] === null ? null : String(row["last_login_at"]),
          isSystemAdmin: Number(row["is_system_admin"]) === 1,
          roleId: row["role_id"] === null ? null : Number(row["role_id"]),
        }));
    },

    updatePanelUser(username, record) {
      const prior = store.getPanelUser(username);
      if (prior === undefined) return "missing";
      db.exec("BEGIN");
      try {
        db.prepare(
          "UPDATE panel_user SET display_name = ?, role_id = ?, is_system_admin = ? WHERE username = ?",
        ).run(record.displayName, record.roleId, record.isSystemAdmin ? 1 : 0, username);
        const admins = Number((db.prepare("SELECT COUNT(*) AS c FROM panel_user WHERE is_system_admin = 1").get()?.["c"] ?? 0));
        if (admins === 0) {
          db.exec("ROLLBACK");
          return "last-system-admin";
        }
        db.exec("COMMIT");
        return "updated";
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    resetPanelPassword(username, passwordHash) {
      db.exec("BEGIN");
      try {
        const result = db.prepare(
          "UPDATE panel_user SET password_hash = ?, must_change_password = 1 WHERE username = ?",
        ).run(passwordHash, username);
        db.prepare("DELETE FROM panel_session WHERE username = ?").run(username);
        db.exec("COMMIT");
        return Number(result.changes) > 0;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    countPanelUsers() {
      const row = db.prepare("SELECT COUNT(*) AS c FROM panel_user").get();
      return Number(row?.["c"] ?? 0);
    },

    getPanelUser(username) {
      const row = db
        .prepare(
          `SELECT username, display_name, password_hash, must_change_password,
                  created_at, last_login_at, is_system_admin, role_id
             FROM panel_user WHERE username = ?`,
        )
        .get(username);
      if (row === undefined) return undefined;

      return {
        username: String(row["username"]),
        displayName: row["display_name"] === null ? null : String(row["display_name"]),
        passwordHash: String(row["password_hash"]),
        mustChangePassword: Number(row["must_change_password"]) === 1,
        createdAt: String(row["created_at"]),
        lastLoginAt: row["last_login_at"] === null ? null : String(row["last_login_at"]),
        isSystemAdmin: Number(row["is_system_admin"]) === 1,
        roleId: row["role_id"] === null ? null : Number(row["role_id"]),
      };
    },
    hasHistoricalRunTrigger(username) {
      return (
        db.prepare("SELECT 1 FROM review_run WHERE triggered_by = ? LIMIT 1").get(username) !==
        undefined
      );
    },

    registerFirstPanelUser(record) {
      // argon2 在调用方 await 完后才进这里;下面没有 await,Node 单线程不会在 COUNT 与
      // INSERT 之间插进另一个请求。事务表达「查与插是一个决定」,不是额外的并发保证。
      db.exec("BEGIN IMMEDIATE");
      try {
        const countRow = db.prepare("SELECT COUNT(*) AS c FROM panel_user").get();
        const count = Number(countRow?.["c"] ?? 0);
        if (count !== 0) {
          db.exec("ROLLBACK");
          return false;
        }
        writePanelUser(record);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    createPanelUser(record) {
      writePanelUser(record);
    },

    createPanelSession(record) {
      db.prepare(
        "INSERT INTO panel_session (session_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)",
      ).run(record.sessionHash, record.username, record.expiresAt, record.createdAt);
      db.prepare("UPDATE panel_user SET last_login_at = ? WHERE username = ?").run(
        record.createdAt,
        record.username,
      );
    },

    getPanelSession(hash) {
      const row = db
        .prepare(
          `SELECT u.username, u.display_name, u.must_change_password, u.is_system_admin,
                  u.role_id, s.expires_at
             FROM panel_session s JOIN panel_user u ON u.username = s.username
            WHERE s.session_hash = ?`,
        )
        .get(hash);
      if (row === undefined) return undefined;
      return {
        username: String(row["username"]),
        displayName: row["display_name"] === null ? null : String(row["display_name"]),
        mustChangePassword: Number(row["must_change_password"]) === 1,
        isSystemAdmin: Number(row["is_system_admin"]) === 1,
        roleId: row["role_id"] === null ? null : Number(row["role_id"]),
        expiresAt: String(row["expires_at"]),
      };
    },

    renewPanelSession(hash, expiresAt) {
      db.prepare("UPDATE panel_session SET expires_at = ? WHERE session_hash = ?").run(expiresAt, hash);
    },

    removePanelSession(hash) {
      db.prepare("DELETE FROM panel_session WHERE session_hash = ?").run(hash);
    },

    removePanelSessions(username, exceptHash) {
      if (exceptHash === undefined) {
        db.prepare("DELETE FROM panel_session WHERE username = ?").run(username);
      } else {
        db.prepare("DELETE FROM panel_session WHERE username = ? AND session_hash <> ?").run(
          username,
          exceptHash,
        );
      }
    },

    updatePanelPassword(username, passwordHash, mustChangePassword) {
      db.prepare(
        "UPDATE panel_user SET password_hash = ?, must_change_password = ? WHERE username = ?",
      ).run(passwordHash, mustChangePassword ? 1 : 0, username);
    },

    removePanelUser(username) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM panel_session WHERE username = ?").run(username);
        db.prepare("DELETE FROM panel_user WHERE username = ?").run(username);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    registerRepo(record) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          record.reviewersJson !== undefined &&
          !modelCombinationAvailable(record.reviewersJson, `仓库 ${record.repoId} 的模型覆盖`)
        ) {
          db.exec("ROLLBACK");
          return false;
        }
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
        return true;
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
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT reviewers FROM repo WHERE id = ?").get(repoId);
        if (row === undefined) {
          db.exec("COMMIT");
          return true;
        }
        const current = row["reviewers"] === null ? null : String(row["reviewers"]);
        if (
          reviewersJson !== current &&
          reviewersJson !== null &&
          !modelCombinationAvailable(reviewersJson, `仓库 ${repoId} 的模型覆盖`)
        ) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare("UPDATE repo SET reviewers = ? WHERE id = ?").run(reviewersJson, repoId);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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
        reviewersVersion: Number(values.get(GLOBAL_REVIEWERS_VERSION_KEY) ?? 1),
        maxChangedLinesPerBatch: limit === undefined ? null : Number(limit),
        maxChangedLinesPerBatchVersion: Number(
          values.get(GLOBAL_MAX_CHANGED_LINES_VERSION_KEY) ?? 1,
        ),
      };
    },

    getReviewRunSnapshot(repoId) {
      db.exec("BEGIN");
      try {
        const repo = store.getRepo(repoId);
        if (repo === undefined) throw new Error(`仓库 ${repoId} 不在注册表里`);
        const settings = store.getGlobalSettings();
        const reviewers = repo.reviewersJson === null
          ? settings.reviewersJson === null
            ? []
            : assertReviewerSpecs(JSON.parse(settings.reviewersJson), GLOBAL_REVIEWERS_CONTEXT, {
                allowEmpty: true,
              })
          : assertReviewerSpecs(JSON.parse(repo.reviewersJson), `仓库 ${repoId} 的模型覆盖`);
        const providers = [...new Set(reviewers.map((reviewer) => reviewer.provider))];
        const modelServices = providers.flatMap((provider) => {
          const service = store.getModelService(provider);
          return service === undefined ? [] : [service];
        });
        db.exec("COMMIT");
        return {
          reviewers: Object.freeze([...reviewers]),
          maxChangedLinesPerBatch: settings.maxChangedLinesPerBatch,
          modelServices: Object.freeze(modelServices),
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    putGlobalReviewers(expectedVersion, reviewersJson) {
      const write = (key: string, value: string): void => {
        db.prepare(
          `INSERT INTO global_setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(key, value);
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        const versionRow = db.prepare("SELECT value FROM global_setting WHERE key = ?")
          .get(GLOBAL_REVIEWERS_VERSION_KEY)?.["value"];
        const version = versionRow === undefined ? 1 : Number(versionRow);
        if (
          version !== expectedVersion ||
          !modelCombinationAvailable(reviewersJson, GLOBAL_REVIEWERS_CONTEXT)
        ) {
          db.exec("ROLLBACK");
          return false;
        }
        write(GLOBAL_REVIEWERS_KEY, reviewersJson);
        write(GLOBAL_REVIEWERS_VERSION_KEY, String(version + 1));
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    putGlobalBatchLimit(expectedVersion, limit) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const versionRow = db.prepare("SELECT value FROM global_setting WHERE key = ?")
          .get(GLOBAL_MAX_CHANGED_LINES_VERSION_KEY)?.["value"];
        const version = versionRow === undefined ? 1 : Number(versionRow);
        if (version !== expectedVersion) {
          db.exec("ROLLBACK");
          return false;
        }
        if (limit === null) {
          db.prepare("DELETE FROM global_setting WHERE key = ?")
            .run(GLOBAL_MAX_CHANGED_LINES_KEY);
        } else {
          db.prepare(
            `INSERT INTO global_setting (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          ).run(GLOBAL_MAX_CHANGED_LINES_KEY, String(limit));
        }
        db.prepare(
          `INSERT INTO global_setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(GLOBAL_MAX_CHANGED_LINES_VERSION_KEY, String(version + 1));
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    putGlobalSettings(settings) {
      const current = store.getGlobalSettings();
      if (
        settings.reviewersJson !== null &&
        parseStoredReviewers(settings.reviewersJson, GLOBAL_REVIEWERS_CONTEXT).length > 0 &&
        !store.putGlobalReviewers(current.reviewersVersion, settings.reviewersJson)
      ) return false;
      if (settings.reviewersJson === null) {
        db.prepare("DELETE FROM global_setting WHERE key = ?").run(GLOBAL_REVIEWERS_KEY);
      } else if (parseStoredReviewers(settings.reviewersJson, GLOBAL_REVIEWERS_CONTEXT).length === 0) {
        db.prepare(
          `INSERT INTO global_setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(GLOBAL_REVIEWERS_KEY, settings.reviewersJson);
      }
      return store.putGlobalBatchLimit(
        store.getGlobalSettings().maxChangedLinesPerBatchVersion,
        settings.maxChangedLinesPerBatch,
      );
    },

    commitModelServiceVersion(expectedVersion, record) {
      if (record.provider === "") throw new Error("模型服务 provider 不能为空");
      const automaticModels = new Map<string, DiscoveredModel>();
      for (const model of record.automaticModels) {
        const identity = modelIdentity({ provider: model.provider, model: model.id });
        if (
          model.provider !== record.provider ||
          model.id.trim() === "" ||
          model.identity !== identity ||
          automaticModels.has(identity)
        ) {
          throw new Error(`${record.provider} 的自动目录含空、重复或身份不一致的模型`);
        }
        automaticModels.set(identity, model);
      }
      const supplementModels = new Set(record.supplements.map((entry) => entry.model));
      if (supplementModels.size !== record.supplements.length || supplementModels.has("")) {
        throw new Error(`${record.provider} 的模型补录含空或重复 model id`);
      }
      for (const supplement of record.supplements) {
        if (
          (supplement.source === "manual" && supplement.targetFingerprint === null) ||
          (supplement.source === "migration-retention" && supplement.targetFingerprint !== null)
        ) {
          throw new Error(`${record.provider}:${supplement.model} 的来源与目标指纹不一致`);
        }
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        if (!recordSupportsCurrentReferences(record)) {
          db.exec("ROLLBACK");
          return undefined;
        }
        let version: number;
        if (expectedVersion === null) {
          if (
            db.prepare("SELECT 1 FROM model_service WHERE provider = ?").get(record.provider) !==
            undefined
          ) {
            db.exec("ROLLBACK");
            return undefined;
          }
          version = 1;
          db.prepare(
            `INSERT INTO model_service
               (provider, service_type, version, base_url, api, target_fingerprint,
                disabled_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            record.provider,
            record.type,
            version,
            record.baseUrl,
            record.api,
            record.targetFingerprint,
            record.disabledReason,
            record.createdAt,
            record.updatedAt,
          );
        } else {
          const changed = db.prepare(
            `UPDATE model_service
                SET service_type = ?, version = version + 1, base_url = ?, api = ?,
                    target_fingerprint = ?, disabled_reason = ?, updated_at = ?
              WHERE provider = ? AND version = ?`,
          ).run(
            record.type,
            record.baseUrl,
            record.api,
            record.targetFingerprint,
            record.disabledReason,
            record.updatedAt,
            record.provider,
            expectedVersion,
          );
          if (Number(changed.changes) === 0) {
            db.exec("ROLLBACK");
            return undefined;
          }
          version = expectedVersion + 1;
        }

        db.prepare("DELETE FROM model_service_credential WHERE provider = ?").run(record.provider);
        db.prepare(
          `INSERT INTO model_service_credential
             (provider, state, api_key_encrypted, updated_at, verified_at,
              validation_model, verification_source)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.provider,
          record.credential.state,
          record.credential.apiKeyEncrypted,
          record.credential.updatedAt,
          record.credential.verifiedAt,
          record.credential.validationModel,
          record.credential.verificationSource,
        );

        db.prepare("DELETE FROM model_directory_model WHERE provider = ?").run(record.provider);
        db.prepare("DELETE FROM model_directory WHERE provider = ?").run(record.provider);
        db.prepare(
          `INSERT INTO model_directory
             (provider, service_version, state, last_attempt_at, last_success_at,
              failure, ignored_model_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.provider,
          version,
          record.directory.state,
          record.directory.lastAttemptAt,
          record.directory.lastSuccessAt,
          record.directory.failure,
          record.directory.ignoredModelCount,
        );
        const insertAutomatic = db.prepare(
          `INSERT INTO model_directory_model
             (provider, model, service_version, name, api, base_url, input_json, reasoning,
              cost_json, context_window, max_tokens, field_sources_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const model of automaticModels.values()) {
          const costJson = serializedTrustedCost(model.fields.cost);
          const fieldSources = normalizedTrustedFieldSources(
            model.fields,
            model.fieldSources,
            costJson !== null,
          );
          insertAutomatic.run(
            record.provider,
            model.id,
            version,
            model.fields.name ?? null,
            model.fields.api ?? null,
            model.fields.baseUrl ?? null,
            model.fields.input === undefined ? null : JSON.stringify(model.fields.input),
            model.fields.reasoning === undefined ? null : Number(model.fields.reasoning),
            costJson,
            model.fields.contextWindow ?? null,
            model.fields.maxTokens ?? null,
            fieldSources === undefined ? null : JSON.stringify(fieldSources),
          );
        }

        db.prepare("DELETE FROM model_supplement WHERE provider = ?").run(record.provider);
        const insertSupplement = db.prepare(
          `INSERT INTO model_supplement
             (provider, model, source, target_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const supplement of record.supplements) {
          insertSupplement.run(
            record.provider,
            supplement.model,
            supplement.source,
            supplement.targetFingerprint,
            supplement.createdAt,
          );
        }
        db.exec("COMMIT");
        return version;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    renameConflictingCustomModelService(provider, newProvider, expectedVersion, updatedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!CUSTOM_PROVIDER_NAME_PATTERN.test(newProvider)) {
          db.exec("ROLLBACK");
          return { status: "invalid-provider" };
        }
        const current = db.prepare(
          `SELECT version, service_type, disabled_reason
             FROM model_service WHERE provider = ?`,
        ).get(provider);
        if (current === undefined || Number(current["version"]) !== expectedVersion) {
          db.exec("ROLLBACK");
          return { status: "version-conflict" };
        }
        if (
          current["service_type"] !== "custom" ||
          current["disabled_reason"] !== "name-conflict"
        ) {
          db.exec("ROLLBACK");
          return { status: "not-conflicting" };
        }
        if (db.prepare("SELECT 1 FROM model_service WHERE provider = ?").get(newProvider) !== undefined) {
          db.exec("ROLLBACK");
          return { status: "provider-conflict" };
        }

        const references = store.listModelReferences().filter(
          (reference) => reference.provider === provider,
        );
        const missing = references.filter(
          (reference) =>
            availableModel.get(provider, reference.model, reference.model, reference.model) === undefined,
        );
        if (missing.length > 0) {
          db.exec("ROLLBACK");
          return { status: "missing-models", references: missing };
        }

        const rewrite = (
          reviewersJson: string,
          context: string,
          allowEmpty: boolean,
        ): string | undefined => {
          const reviewers = assertReviewerSpecs(JSON.parse(reviewersJson), context, { allowEmpty });
          if (!reviewers.some((reviewer) => reviewer.provider === provider)) return undefined;
          return JSON.stringify(reviewers.map((reviewer) =>
            reviewer.provider === provider ? { ...reviewer, provider: newProvider } : reviewer
          ));
        };
        const globalRow = db.prepare("SELECT value FROM global_setting WHERE key = ?")
          .get(GLOBAL_REVIEWERS_KEY);
        if (globalRow !== undefined) {
          const oldJson = String(globalRow["value"]);
          const nextJson = rewrite(oldJson, GLOBAL_REVIEWERS_CONTEXT, true);
          if (nextJson !== undefined) {
            db.prepare("UPDATE global_setting SET value = ? WHERE key = ?")
              .run(nextJson, GLOBAL_REVIEWERS_KEY);
            const versionRow = db.prepare("SELECT value FROM global_setting WHERE key = ?")
              .get(GLOBAL_REVIEWERS_VERSION_KEY);
            const version = versionRow === undefined ? 1 : Number(versionRow["value"]);
            db.prepare(
              `INSERT INTO global_setting (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(GLOBAL_REVIEWERS_VERSION_KEY, String(version + 1));
          }
        }
        for (const row of db.prepare(
          "SELECT id, owner, repo, reviewers FROM repo WHERE reviewers IS NOT NULL",
        ).all()) {
          const repoId = Number(row["id"]);
          const oldJson = String(row["reviewers"]);
          const nextJson = rewrite(
            oldJson,
            `仓库 ${String(row["owner"])}/${String(row["repo"])}（id ${repoId}）的模型覆盖`,
            false,
          );
          if (nextJson !== undefined) {
            db.prepare("UPDATE repo SET reviewers = ? WHERE id = ?").run(nextJson, repoId);
          }
        }

        const nextVersion = expectedVersion + 1;
        db.prepare("UPDATE model_directory_model SET provider = ?, service_version = ? WHERE provider = ?")
          .run(newProvider, nextVersion, provider);
        db.prepare("UPDATE model_directory SET provider = ?, service_version = ? WHERE provider = ?")
          .run(newProvider, nextVersion, provider);
        db.prepare("UPDATE model_supplement SET provider = ? WHERE provider = ?")
          .run(newProvider, provider);
        db.prepare("UPDATE model_service_model_state SET provider = ? WHERE provider = ?")
          .run(newProvider, provider);
        const validationModel = db.prepare(
          "SELECT validation_model FROM model_service_credential WHERE provider = ?",
        ).get(provider)?.["validation_model"];
        db.prepare(
          "UPDATE model_service_credential SET provider = ?, validation_model = ? WHERE provider = ?",
        ).run(
          newProvider,
          validationModel === null || validationModel === undefined
            ? null
            : `${newProvider}:${String(validationModel).slice(provider.length + 1)}`,
          provider,
        );
        db.prepare(
          `UPDATE model_service
              SET provider = ?, version = ?, disabled_reason = NULL, updated_at = ?
            WHERE provider = ? AND version = ?`,
        ).run(newProvider, nextVersion, updatedAt, provider, expectedVersion);
        db.exec("COMMIT");
        return { status: "renamed", version: nextVersion };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    removeCustomModelService(provider, expectedVersion) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db
          .prepare(
            `SELECT 1 FROM model_service
              WHERE provider = ? AND service_type = 'custom' AND version = ?`,
          )
          .get(provider, expectedVersion);
        if (current === undefined) {
          db.exec("ROLLBACK");
          return false;
        }
        if (referencedModels(provider).size > 0) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare("DELETE FROM model_directory_model WHERE provider = ?").run(provider);
        db.prepare("DELETE FROM model_directory WHERE provider = ?").run(provider);
        db.prepare("DELETE FROM model_supplement WHERE provider = ?").run(provider);
        db.prepare("DELETE FROM model_service_model_state WHERE provider = ?").run(provider);
        db.prepare("DELETE FROM model_service_credential WHERE provider = ?").run(provider);
        const removed = db
          .prepare(
            `DELETE FROM model_service
              WHERE provider = ? AND service_type = 'custom' AND version = ?`,
          )
          .run(provider, expectedVersion);
        if (Number(removed.changes) !== 1) {
          db.exec("ROLLBACK");
          return false;
        }
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getModelService(provider) {
      const service = db
        .prepare(
          `SELECT provider, service_type, version, base_url, api, target_fingerprint,
                  disabled_reason, created_at, updated_at
             FROM model_service WHERE provider = ?`,
        )
        .get(provider);
      if (service === undefined) return undefined;
      const credential = db
        .prepare(
          `SELECT state, api_key_encrypted, updated_at, verified_at,
                  validation_model, verification_source
             FROM model_service_credential WHERE provider = ?`,
        )
        .get(provider);
      const directory = db
        .prepare(
          `SELECT service_version, state, last_attempt_at, last_success_at,
                  failure, ignored_model_count
             FROM model_directory WHERE provider = ?`,
        )
        .get(provider);
      if (credential === undefined || directory === undefined) {
        throw new Error(`${provider} 的模型服务当前版本不完整`);
      }
      const version = Number(service["version"]);
      if (Number(directory["service_version"]) !== version) {
        throw new Error(`${provider} 的模型目录不属于当前服务版本`);
      }
      const automaticModels = db
        .prepare(
          `SELECT model, name, api, base_url, input_json, reasoning, cost_json,
                  context_window, max_tokens, field_sources_json
             FROM model_directory_model
            WHERE provider = ? AND service_version = ? ORDER BY model`,
        )
        .all(provider, version)
        .map((row): DiscoveredModel => {
          const id = String(row["model"]);
          const fields: TrustedModelFields = {
            ...(row["name"] === null ? {} : { name: String(row["name"]) }),
            ...(row["api"] === null ? {} : { api: String(row["api"]) }),
            ...(row["base_url"] === null ? {} : { baseUrl: String(row["base_url"]) }),
            ...(row["input_json"] === null
              ? {}
              : { input: JSON.parse(String(row["input_json"])) as readonly ("text" | "image")[] }),
            ...(row["reasoning"] === null ? {} : { reasoning: Number(row["reasoning"]) === 1 }),
            ...(row["cost_json"] === null
              ? {}
              : { cost: JSON.parse(String(row["cost_json"])) as ModelCost }),
            ...(row["context_window"] === null
              ? {}
              : { contextWindow: Number(row["context_window"]) }),
            ...(row["max_tokens"] === null ? {} : { maxTokens: Number(row["max_tokens"]) }),
          };
          const fieldSources = row["field_sources_json"] === null
            ? undefined
            : normalizedTrustedFieldSources(
                fields,
                JSON.parse(String(row["field_sources_json"])) as TrustedModelFieldSources,
                fields.cost !== undefined,
              );
          return {
            identity: modelIdentity({ provider, model: id }),
            provider,
            id,
            fields,
            ...(fieldSources === undefined ? {} : { fieldSources }),
          };
        });
      return {
        provider: String(service["provider"]),
        type: String(service["service_type"]) as "builtin" | "custom",
        version,
        baseUrl: service["base_url"] === null ? null : String(service["base_url"]),
        api: service["api"] === null ? null : String(service["api"]),
        targetFingerprint:
          service["target_fingerprint"] === null
            ? null
            : String(service["target_fingerprint"]),
        disabledReason:
          service["disabled_reason"] === null ? null : "name-conflict" as const,
        createdAt: String(service["created_at"]),
        updatedAt: String(service["updated_at"]),
        credential: {
          state: String(credential["state"]) as ModelCredentialState,
          apiKeyEncrypted:
            credential["api_key_encrypted"] === null
              ? null
              : String(credential["api_key_encrypted"]),
          updatedAt:
            credential["updated_at"] === null ? null : String(credential["updated_at"]),
          verifiedAt:
            credential["verified_at"] === null ? null : String(credential["verified_at"]),
          validationModel:
            credential["validation_model"] === null
              ? null
              : String(credential["validation_model"]),
          verificationSource:
            credential["verification_source"] === null
              ? null
              : String(credential["verification_source"]) as ModelVerificationSource,
        },
        directory: {
          state: String(directory["state"]) as ModelDirectoryState,
          lastAttemptAt:
            directory["last_attempt_at"] === null
              ? null
              : String(directory["last_attempt_at"]),
          lastSuccessAt:
            directory["last_success_at"] === null
              ? null
              : String(directory["last_success_at"]),
          failure: directory["failure"] === null ? null : String(directory["failure"]),
          ignoredModelCount: Number(directory["ignored_model_count"]),
        },
        automaticModels,
        supplements: store.listModelSupplements(provider),
      };
    },

    listModelServices() {
      return db
        .prepare("SELECT provider FROM model_service ORDER BY provider")
        .all()
        .map((row) => store.getModelService(String(row["provider"]))!);
    },

    listModelReferences() {
      const references = new Map<string, ModelReference>();
      const referenceFor = (spec: ReviewerSpec): ModelReference => {
        const identity = modelIdentity(spec);
        const existing = references.get(identity);
        if (existing !== undefined) return existing;
        const created: ModelReference = {
          identity,
          provider: spec.provider,
          model: spec.model,
          locations: [],
        };
        references.set(identity, created);
        return created;
      };
      const parse = (reviewersJson: string, context: string, allowEmpty: boolean): ReviewerSpec[] =>
        assertReviewerSpecs(JSON.parse(reviewersJson), context, { allowEmpty });
      const globalJson = db
        .prepare("SELECT value FROM global_setting WHERE key = ?")
        .get(GLOBAL_REVIEWERS_KEY)?.["value"];
      const global = globalJson === undefined
        ? []
        : parse(String(globalJson), GLOBAL_REVIEWERS_CONTEXT, true);
      const followingGlobal = Number(
        db.prepare("SELECT COUNT(*) AS count FROM repo WHERE reviewers IS NULL").get()!["count"],
      );
      for (const spec of global) {
        const reference = referenceFor(spec);
        reference.locations.push({ kind: "global" });
        if (followingGlobal > 0) {
          reference.locations.push({ kind: "following-global", repositoryCount: followingGlobal });
        }
      }
      for (const row of db
        .prepare("SELECT id, owner, repo, reviewers FROM repo WHERE reviewers IS NOT NULL ORDER BY id")
        .all()) {
        const repoId = Number(row["id"]);
        const owner = String(row["owner"]);
        const repo = String(row["repo"]);
        for (const spec of parse(
          String(row["reviewers"]),
          `仓库 ${owner}/${repo}（id ${repoId}）的模型覆盖`,
          false,
        )) {
          referenceFor(spec).locations.push({
            kind: "repository-override",
            repoId,
            owner,
            repo,
          });
        }
      }
      return [...references.values()].sort((left, right) =>
        left.identity.localeCompare(right.identity),
      );
    },

    listModelServiceModelStates(provider) {
      const rows = provider === undefined
        ? db.prepare(
            `SELECT provider, model, enabled, updated_at
               FROM model_service_model_state ORDER BY provider, model`,
          ).all()
        : db.prepare(
            `SELECT provider, model, enabled, updated_at
               FROM model_service_model_state WHERE provider = ? ORDER BY model`,
          ).all(provider);
      return rows.map((row) => ({
        provider: String(row["provider"]),
        model: String(row["model"]),
        enabled: Number(row["enabled"]) === 1,
        updatedAt: String(row["updated_at"]),
      }));
    },

    updateModelServiceModelStates(provider, expectedVersion, models, enabled, updatedAt) {
      const requested = [...new Set(models.map((model) => model.trim()))];
      if (requested.some((model) => model === "")) {
        throw new Error("模型标识不能为空");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const service = db.prepare(
          "SELECT version FROM model_service WHERE provider = ?",
        ).get(provider);
        if (service === undefined || Number(service["version"]) !== expectedVersion) {
          db.exec("ROLLBACK");
          return { status: "version-conflict" } as const;
        }
        const knownRows = db.prepare(
          `SELECT model FROM model_directory_model WHERE provider = ? AND service_version = ?
           UNION SELECT model FROM model_supplement WHERE provider = ?`,
        ).all(provider, expectedVersion, provider);
        const known = new Set(knownRows.map((row) => String(row["model"])));
        const unknownModels = requested.filter((model) => !known.has(model));
        if (unknownModels.length > 0) {
          db.exec("ROLLBACK");
          return { status: "unknown-models", models: unknownModels } as const;
        }
        if (!enabled) {
          const blocked = store.listModelReferences().filter(
            (reference) => reference.provider === provider && requested.includes(reference.model),
          );
          if (blocked.length > 0) {
            db.exec("ROLLBACK");
            return { status: "referenced", references: blocked } as const;
          }
        }
        const upsert = db.prepare(
          `INSERT INTO model_service_model_state (provider, model, enabled, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(provider, model) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        );
        for (const model of requested) upsert.run(provider, model, enabled ? 1 : 0, updatedAt);
        db.exec("COMMIT");
        return { status: "updated", updated: requested.length } as const;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listModelSupplements(provider) {
      const rows = provider === undefined
        ? db.prepare(
            `SELECT provider, model, source, target_fingerprint, created_at
               FROM model_supplement ORDER BY provider, model`,
          ).all()
        : db.prepare(
            `SELECT provider, model, source, target_fingerprint, created_at
               FROM model_supplement WHERE provider = ? ORDER BY model`,
          ).all(provider);
      return rows.map((row) => ({
        provider: String(row["provider"]),
        model: String(row["model"]),
        source: String(row["source"]) as ModelSupplementSource,
        targetFingerprint:
          row["target_fingerprint"] === null ? null : String(row["target_fingerprint"]),
        createdAt: String(row["created_at"]),
      }));
    },


    startRun(meta) {
      db.exec("BEGIN");
      try {
        const result = db
          .prepare(
            `INSERT INTO review_run
               (owner, repo, pull_number, head_sha, range_review_id, triggered_by,
                started_at, changed_files, changed_lines, batch_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            meta.owner,
            meta.repo,
            meta.pullNumber,
            meta.headSha,
            meta.rangeReviewId ?? null,
            meta.triggeredBy ?? null,
            meta.startedAt,
            meta.changedFiles,
            meta.changedLines,
            meta.batchCount,
          );
        const runId = Number(result.lastInsertRowid);
        const insertPin = db.prepare(
          `INSERT INTO review_run_reviewer_pin
             (run_id, position, identity, provider, model, model_service_version,
              base_url, api, runtime_model_json, materialization_failure)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [position, pin] of meta.reviewerPins.entries()) {
          insertPin.run(
            runId,
            position,
            pin.identity,
            pin.provider,
            pin.model,
            pin.modelServiceVersion,
            pin.target?.baseUrl ?? null,
            pin.target?.api ?? null,
            pin.runtimeModel === null ? null : JSON.stringify(pin.runtimeModel),
            pin.failure,
          );
        }
        db.exec("COMMIT");
        return runId;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    finishRun(runId, result) {
      // 一次 Review Run 的收尾要么整体可见,要么整体不可见:半张表的 Finding
      // 会让事后的处置率统计算出偏低的分母。
      db.exec("BEGIN");
      try {
        const runUsage = sumUsage(result.outcomes);
        db.prepare(
          `UPDATE review_run
              SET finished_at = ?, duration_ms = ?, failed = ?,
                  input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
                  cache_write_tokens = ?, total_tokens = ?, cost_usd = ?,
                  known_cost_usd = ?, cost_source = ?, unknown_cost_reviewer_count = ?
            WHERE id = ?`,
        ).run(
          result.finishedAt,
          result.durationMs,
          result.failed ? 1 : 0,
          ...usageColumns(runUsage),
          runUsage === undefined ? null : unknownCostReviewerCount(result.outcomes),
          runId,
        );

        const insertOutcome = db.prepare(
          `INSERT INTO reviewer_outcome
             (run_id, model, failure, finding_count, anomaly_count,
              rejected_tool_calls, anchor_rejections, duration_ms,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              total_tokens, cost_usd, known_cost_usd, cost_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
             (run_id, file, line, title, severity, category, description,
              fingerprint, group_index, disposition, placement,
              comment_id, comment_html_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertAttribution = db.prepare(
          `INSERT INTO finding_attribution
             (finding_id, position, model, severity, category, description)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const finding of result.findings) {
          const inserted = insertFinding.run(
            runId,
            finding.file,
            finding.line,
            finding.title,
            finding.severity,
            finding.category,
            finding.description,
            finding.fingerprint ?? null,
            finding.groupIndex,
            finding.disposition,
            finding.placement,
            finding.commentId ?? null,
            finding.commentHtmlUrl ?? null,
          );
          const findingId = Number(inserted.lastInsertRowid);
          for (const [position, said] of finding.attributions.entries()) {
            insertAttribution.run(
              findingId,
              position,
              said.model,
              said.severity,
              said.category,
              said.description,
            );
          }
        }

        // 复核结论逐条落库(ADR 0016)。漏给的那些由编排层按「无法判断」补齐并标
        // `missing`,这里只照写:裁决在编排层按同一批记录做完。
        const insertVerdict = db.prepare(
          `INSERT INTO finding_verdict (run_id, model, finding_id, verdict, missing)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const verdict of result.verdicts ?? []) {
          insertVerdict.run(
            runId,
            verdict.model,
            verdict.findingId,
            verdict.verdict,
            verdict.missing ? 1 : 0,
          );
        }

        // 折叠到已有 Forge 评论的行继承那条评论上一次处置的元数据(issue #152)。处置
        // 的载体是评论(ADR 0006),同一条评论名下的历史行与本轮新行说的是同一次处置:
        // 不继承的话备注与署名活不过下一轮,`disposed_at` 这个「这一行被显式处置过」
        // 的标记也会被新的一行稀释,自动处置于是又碰它一次(ADR 0016)。`disposition`
        // 不在此列——它由跨轮匹配与回填决定,口径不变。本轮新发的评论不必走这一步:
        // 它的 id 是新的,库里不会有同 id 的历史行,`recordFindingComments` 因此不动。
        db.prepare(
          `UPDATE finding
              SET (disposed_by, disposed_at, disposition_note) =
                    (SELECT prior.disposed_by, prior.disposed_at, prior.disposition_note
                       FROM finding prior
                      WHERE prior.comment_id = finding.comment_id
                        AND prior.run_id <> finding.run_id
                        AND prior.disposed_at IS NOT NULL
                      ORDER BY prior.id DESC LIMIT 1)
            WHERE run_id = ? AND comment_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM finding prior
                           WHERE prior.comment_id = finding.comment_id
                             AND prior.run_id <> finding.run_id
                             AND prior.disposed_at IS NOT NULL)`,
        ).run(runId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    stageHistory(scope) {
      const [where, params] = stageScope(scope);
      // 折叠键与处置率同源(ADR 0015):文件 + 指纹,算不出指纹的行用自己的 id 兜底
      // 成独立键。同一处取最新那一行——它才带着当前的处置状态、备注与最新表述。
      // 最新一行是「已延续」的整条不注入:这处 Finding 已经交接到新位置,新位置那条
      // 自己在历史里,再给一遍就是同一个问题让模型复核两次。
      const rows = db
        .prepare(
          `WITH scoped AS (
             SELECT f.id AS id, f.file AS file, f.line AS line, f.title AS title,
                    f.severity AS severity, f.category AS category,
                    f.description AS description, f.disposition AS disposition,
                    f.disposition_note AS note,
                    COALESCE(f.fingerprint, 'row:' || f.id) AS fp
               FROM finding f
               JOIN review_run run ON f.run_id = run.id
              WHERE ${where}
           )
           SELECT s.* FROM scoped s
            WHERE s.id = (SELECT MAX(latest.id) FROM scoped latest
                           WHERE latest.file = s.file AND latest.fp = s.fp)
              AND s.disposition <> 'continued'
            ORDER BY s.id`,
        )
        .all(...params);
      return rows.map((row) => {
        const disposition = String(row["disposition"]) as Disposition;
        const note = row["note"] === null ? undefined : String(row["note"]);
        const disposed = disposition === "resolved" || disposition === "fixed";
        return {
          id: Number(row["id"]),
          file: String(row["file"]),
          line: Number(row["line"]),
          // 升级前的历史行没有标题,占位为空:少一句话胜过让整条历史掉出注入。
          title: row["title"] === null ? "" : String(row["title"]),
          disposition,
          ...(note === undefined ? {} : { note }),
          // 已处置的只占一行(ADR 0016 的体积控制):正文、严重度与分类都不给。
          ...(disposed
            ? {}
            : {
                severity: String(row["severity"]) as Severity,
                category: String(row["category"]) as Category,
                description: String(row["description"]),
              }),
        };
      });
    },

    stageSummary(scope) {
      const [where, params] = stageScope(scope);
      const runRows = db
        .prepare(
          `SELECT run.id AS id, run.head_sha AS head_sha, run.started_at AS started_at,
                  run.finished_at AS finished_at, run.failed AS failed
             FROM review_run run
            WHERE ${where}
            ORDER BY run.id`,
        )
        .all(...params);
      if (runRows.length === 0) {
        return { findings: [], counts: { pending: 0, resolved: 0, fixed: 0 }, timeline: [] };
      }
      // 一个阶段的行数有界(轮次 × 每轮的 Finding),折叠在这里用 JS 做:延续要把两个
      // 指纹接成同一条 Identity,写成 SQL 只会让这一步看不出在做什么。
      const findingRows = db
        .prepare(
          `SELECT f.id AS id, f.run_id AS run_id, f.file AS file, f.line AS line,
                  f.title AS title, f.severity AS severity, f.category AS category,
                  f.description AS description, f.disposition AS disposition,
                  f.placement AS placement, f.comment_id AS comment_id,
                  f.comment_html_url AS comment_html_url, f.disposed_by AS disposed_by,
                  f.disposed_at AS disposed_at, f.disposition_note AS note,
                  f.continued_from AS continued_from,
                  COALESCE(f.fingerprint, 'row:' || f.id) AS fp
             FROM finding f
             JOIN review_run run ON f.run_id = run.id
            WHERE ${where}
            ORDER BY f.id`,
        )
        .all(...params);
      const attributionRows = db
        .prepare(
          `SELECT a.finding_id AS finding_id, a.model AS model
             FROM finding_attribution a
             JOIN finding f ON f.id = a.finding_id
             JOIN review_run run ON f.run_id = run.id
            WHERE ${where}
            ORDER BY a.finding_id, a.position`,
        )
        .all(...params);
      const verdictRows = db
        .prepare(
          `SELECT v.run_id AS run_id, v.finding_id AS finding_id, v.verdict AS verdict,
                  v.missing AS missing
             FROM finding_verdict v
             JOIN review_run run ON v.run_id = run.id
            WHERE ${where}`,
        )
        .all(...params);

      const models = new Map<number, string[]>();
      for (const row of attributionRows) {
        const id = Number(row["finding_id"]);
        models.set(id, [...(models.get(id) ?? []), String(row["model"])]);
      }

      type StageRow = {
        id: number;
        runId: number;
        file: string;
        fp: string;
        disposition: Disposition;
        commentHtmlUrl: string | null;
        continuedFrom: string | null;
        row: Record<string, unknown>;
      };
      type Identity = { rows: StageRow[]; firstRow: StageRow };
      // 折叠键与 `stageHistory`、自动处置、回填同源:文件 + 指纹,算不出指纹的行用
      // 自己的 id 兜底成独立键。行按 id 升序,每组的最后一行就是最新那一轮的。
      const byKey = new Map<string, Identity>();
      for (const row of findingRows) {
        const entry: StageRow = {
          id: Number(row["id"]),
          runId: Number(row["run_id"]),
          file: String(row["file"]),
          fp: String(row["fp"]),
          disposition: String(row["disposition"]) as Disposition,
          commentHtmlUrl:
            row["comment_html_url"] === null ? null : String(row["comment_html_url"]),
          continuedFrom: row["continued_from"] === null ? null : String(row["continued_from"]),
          row,
        };
        const key = `${entry.file}\n${entry.fp}`;
        const identity = byKey.get(key);
        if (identity === undefined) byKey.set(key, { rows: [entry], firstRow: entry });
        else identity.rows.push(entry);
      }
      const identities = [...byKey.values()];

      // 延续把同一条 Finding Identity 交接到新位置(CONTEXT.md 已延续):新位置那一行
      // 记着旧评论的地址。首见轮次跟着 Identity 走,否则「活了多久」会从交接那一轮
      // 重新算。按交接发生的先后处理,链条上更早的那一段先把首见轮次传下去。
      const successors = new Map<string, Identity>();
      for (const identity of identities) {
        for (const row of identity.rows) {
          if (row.continuedFrom !== null) successors.set(row.continuedFrom, identity);
        }
      }
      const latestOf = (identity: Identity): StageRow => identity.rows[identity.rows.length - 1]!;
      for (const identity of [...identities].sort((a, b) => latestOf(a).id - latestOf(b).id)) {
        const latest = latestOf(identity);
        if (latest.disposition !== "continued" || latest.commentHtmlUrl === null) continue;
        const successor = successors.get(latest.commentHtmlUrl);
        if (successor === undefined) continue;
        if (identity.firstRow.id < successor.firstRow.id) successor.firstRow = identity.firstRow;
      }

      const startedAt = new Map(
        runRows.map((run) => [Number(run["id"]), String(run["started_at"])] as const),
      );
      const findings: StageSummaryFinding[] = identities
        .filter((identity) => latestOf(identity).disposition !== "continued")
        .map((identity) => {
          const latest = latestOf(identity);
          const row = latest.row;
          return {
            id: latest.id,
            file: latest.file,
            line: Number(row["line"]),
            title: row["title"] === null ? "" : String(row["title"]),
            severity: String(row["severity"]) as Severity,
            category: String(row["category"]) as Category,
            description: String(row["description"]),
            models: models.get(latest.id) ?? [],
            disposition: latest.disposition as Exclude<Disposition, "continued">,
            placement: String(row["placement"]) as FindingPlacement,
            commentId: row["comment_id"] === null ? null : String(row["comment_id"]),
            commentHtmlUrl: latest.commentHtmlUrl,
            disposedBy: row["disposed_by"] === null ? null : String(row["disposed_by"]),
            disposedAt: row["disposed_at"] === null ? null : String(row["disposed_at"]),
            note: row["note"] === null ? null : String(row["note"]),
            // 「延续自」是这条 Identity 的事实,不是某一轮的:交接只发生一次,之后的
            // 轮次折叠出来的新行不再带它,取整条上第一条带着它的那一行。
            continuedFrom:
              identity.rows.find((entry) => entry.continuedFrom !== null)?.continuedFrom ?? null,
            firstRunId: identity.firstRow.runId,
            firstReportedAt: startedAt.get(identity.firstRow.runId)!,
            lastRunId: latest.runId,
            lastReportedAt: startedAt.get(latest.runId)!,
          };
        });
      // 排序在服务端定一次:待处置在前(这一页要回答「还剩什么没处置」),再按严重度,
      // 同档按文件与行号,读的人在 diff 里找得到同样的先后。
      const severityRank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
      const pending = (finding: StageSummaryFinding): boolean =>
        finding.disposition === "unknown" || finding.disposition === "unresolved";
      findings.sort(
        (a, b) =>
          Number(pending(b)) - Number(pending(a)) ||
          severityRank[a.severity] - severityRank[b.severity] ||
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.id - b.id,
      );

      const counts = { pending: 0, resolved: 0, fixed: 0 };
      for (const finding of findings) {
        if (finding.disposition === "fixed") counts.fixed += 1;
        else if (finding.disposition === "resolved") counts.resolved += 1;
        else counts.pending += 1;
      }

      const timeline = new Map<number, StageTimelineEntry>(
        runRows.map((run) => [
          Number(run["id"]),
          {
            runId: Number(run["id"]),
            headSha: String(run["head_sha"]),
            startedAt: String(run["started_at"]),
            finishedAt: run["finished_at"] === null ? null : String(run["finished_at"]),
            failed: Number(run["failed"] ?? 0) === 1,
            reported: 0,
            folded: 0,
            fixed: 0,
            continued: 0,
            missedVerdicts: 0,
          },
        ]),
      );
      for (const identity of identities) {
        for (const row of identity.rows) {
          const entry = timeline.get(row.runId);
          if (entry === undefined) continue;
          // 三类互斥:承接旧位置的算已延续,这条 Identity 更早出现过的算折叠,
          // 其余是本轮新报出。
          if (row.continuedFrom !== null) entry.continued += 1;
          else if (row.id !== identity.rows[0]!.id) entry.folded += 1;
          else entry.reported += 1;
        }
      }
      // 本轮的自动处置:合成规则与 `run.ts` 的 `fixedFindingIds` 同源——全部结论都判
      // 已修才是已修。落到「已修复」上的才计数,写 Forge 没成或人事后改回来的不算。
      const nowFixed = new Set(
        identities
          .filter((identity) => latestOf(identity).disposition === "fixed")
          .flatMap((identity) => identity.rows.map((row) => row.id)),
      );
      const allFixed = new Map<string, boolean>();
      for (const row of verdictRows) {
        const runId = Number(row["run_id"]);
        const entry = timeline.get(runId);
        if (entry === undefined) continue;
        if (Number(row["missing"]) === 1) entry.missedVerdicts += 1;
        const key = `${runId}\n${Number(row["finding_id"])}`;
        allFixed.set(key, (allFixed.get(key) ?? true) && String(row["verdict"]) === "fixed");
      }
      for (const [key, fixed] of allFixed) {
        if (!fixed) continue;
        const [runIdText, findingIdText] = key.split("\n") as [string, string];
        if (!nowFixed.has(Number(findingIdText))) continue;
        timeline.get(Number(runIdText))!.fixed += 1;
      }

      return { findings, counts, timeline: [...timeline.values()] };
    },

    recordFindingComments(runId, refs) {
      const update = db.prepare(
        `UPDATE finding SET comment_id = ?, comment_html_url = ?
          WHERE run_id = ? AND group_index = ?`,
      );
      // 一个合并组落成一条 Finding、一条评论:处置的载体就是它。
      for (const ref of refs) {
        update.run(ref.commentId, ref.commentHtmlUrl, runId, ref.groupIndex);
      }
    },

    dispositionStats(from, to) {
      // 接在共同的 identity 折叠之后:labeled 给每条 Identity 取它首次报出那一行的
      // category(不进折叠键,跨轮改口不挪格,与时间窗归属同一轮)。
      const rows = db
        .prepare(
          `${STATS_IDENTITY_CTE},
           labeled AS (
             SELECT identity.*,
                    (SELECT s.category FROM src s
                      WHERE s.owner = identity.owner
                        AND s.repo = identity.repo AND s.pull_number = identity.pull_number
                        AND s.file = identity.file AND s.fp = identity.fp
                      ORDER BY s.started_at, s.id LIMIT 1) AS category
               FROM identity
           )
           SELECT owner, repo, category,
                  SUM(CASE WHEN disp = 3 THEN 1 ELSE 0 END) AS resolved,
                  SUM(CASE WHEN disp = 2 THEN 1 ELSE 0 END) AS fixed,
                  SUM(CASE WHEN disp = 1 THEN 1 ELSE 0 END) AS unresolved,
                  SUM(CASE WHEN disp = 0 AND closed = 1 THEN 1 ELSE 0 END) AS unknown_closed,
                  SUM(CASE WHEN disp = 0 AND closed = 0 THEN 1 ELSE 0 END) AS unknown_open
             FROM labeled
            WHERE continued = 0 AND first_seen >= ? AND first_seen <= ?
            GROUP BY owner, repo, category
            ORDER BY owner, repo, category`,
        )
        .all(from, to);
      // 逐字段取出:node:sqlite 返回的是 null 原型对象,直接外传会让调用方拿到
      // 一个没有 Object 方法的怪东西。
      return rows.map((row) => ({
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        category: String(row["category"]),
        resolved: Number(row["resolved"]),
        fixed: Number(row["fixed"]),
        unresolved: Number(row["unresolved"]),
        unknownClosed: Number(row["unknown_closed"]),
        unknownOpen: Number(row["unknown_open"]),
      }));
    },

    modelParticipation(from, to) {
      // 先摊成「模型 × Identity」再去重:一条 Identity 在一个阶段里有好几行,同一个
      // 模型在其中几行上都报过也只算这条一次;不同模型报同一条则各算一次。
      const rows = db
        .prepare(
          `${STATS_IDENTITY_CTE}
           SELECT model, COUNT(*) AS findings
             FROM (
               SELECT DISTINCT a.model, s.owner, s.repo, s.pull_number, s.file, s.fp
                 FROM src s
                 JOIN finding_attribution a ON a.finding_id = s.id
                 JOIN identity i
                   ON i.owner = s.owner AND i.repo = s.repo
                  AND i.pull_number = s.pull_number AND i.file = s.file AND i.fp = s.fp
                WHERE i.continued = 0 AND i.first_seen >= ? AND i.first_seen <= ?
             )
            GROUP BY model
            ORDER BY model`,
        )
        .all(from, to);
      return rows.map((row) => ({
        model: String(row["model"]),
        findings: Number(row["findings"]),
      }));
    },

    usageStats(from, to) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS usage_rows,
                  SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read_tokens) AS cache_read_tokens,
                  SUM(cache_write_tokens) AS cache_write_tokens,
                  SUM(total_tokens) AS total_tokens,
                  SUM(known_cost_usd) AS known_cost_usd,
                  SUM(COALESCE(unknown_cost_reviewer_count, 0)) AS unknown_cost_reviewer_count,
                  SUM(CASE WHEN cost_source = 'trusted' THEN 1 ELSE 0 END) AS trusted_rows,
                  SUM(CASE WHEN cost_source = 'legacy' THEN 1 ELSE 0 END) AS legacy_rows
             FROM review_run
            WHERE total_tokens IS NOT NULL AND started_at >= ? AND started_at <= ?`,
        )
        .get(from, to)!;
      if (Number(row["usage_rows"]) === 0) return undefined;

      const unknownCostReviewers = Number(row["unknown_cost_reviewer_count"] ?? 0);
      const trustedRows = Number(row["trusted_rows"] ?? 0);
      const legacyRows = Number(row["legacy_rows"] ?? 0);
      const costSource: RecordedCostSource =
        unknownCostReviewers > 0
          ? "unknown"
          : trustedRows > 0 && legacyRows > 0
            ? "mixed"
            : legacyRows > 0
              ? "legacy"
              : "trusted";
      const knownCostUsd = Number(row["known_cost_usd"] ?? 0);
      return {
        inputTokens: Number(row["input_tokens"] ?? 0),
        outputTokens: Number(row["output_tokens"] ?? 0),
        cacheReadTokens: Number(row["cache_read_tokens"] ?? 0),
        cacheWriteTokens: Number(row["cache_write_tokens"] ?? 0),
        totalTokens: Number(row["total_tokens"] ?? 0),
        costUsd: unknownCostReviewers > 0 ? null : knownCostUsd,
        knownCostUsd,
        costSource,
        costIncomplete: unknownCostReviewers > 0,
        unknownCostReviewers,
      };
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
      if (opts.rangeReviewId !== undefined) {
        conditions.push("range_review_id = ?");
        params.push(opts.rangeReviewId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const runs = db
        .prepare(
          `SELECT id, owner, repo, pull_number, head_sha, range_review_id, triggered_by,
                  started_at, finished_at, failed, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, total_tokens, cost_usd,
                  known_cost_usd, cost_source, unknown_cost_reviewer_count
             FROM review_run ${where}
            ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, opts.limit);
      if (runs.length === 0) return [];

      const ids = runs.map((run) => Number(run["id"]));
      const marks = ids.map(() => "?").join(", ");
      // 逐模型的行来自 reviewer_outcome:它一轮一模型一行并带 failure,失败的模型
      // 因此照样列出。Finding 数仍数 finding 表——outcome 上的 finding_count 是
      // Reviewer 自报的合并前条数,与落库行数不是同一个口径。
      const byOutcome = db
        .prepare(
          `SELECT run_id, model, failure, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, total_tokens, cost_usd,
                  known_cost_usd, cost_source
             FROM reviewer_outcome
            WHERE run_id IN (${marks}) ORDER BY model`,
        )
        .all(...ids);
      // 一个模型报了几条:数它的归属,不数 finding 行——一条 Finding 可以有几个归属
      // (ADR 0015),按行数会把合并掉的那几条从这个模型名下抹掉。
      const byModel = db
        .prepare(
          `SELECT f.run_id AS run_id, a.model AS model, COUNT(*) AS findings
             FROM finding_attribution a
             JOIN finding f ON f.id = a.finding_id
            WHERE f.run_id IN (${marks}) GROUP BY f.run_id, a.model ORDER BY a.model`,
        )
        .all(...ids);
      // 已处置口径与处置率同源:只认行级承载。人工与自动分开数,面板据此把两者分开显示。
      // 「已延续」两头都不占:它既不是处置,也不该继续挂在这一轮的待处置里等人去点
      // ——那处 Finding 已经交接到新位置,要处置的是新位置那条。
      const byGroup = db
        .prepare(
          `SELECT run_id,
                  COUNT(*) AS total,
                  SUM(CASE WHEN disposition = 'resolved' THEN 1 ELSE 0 END) AS resolved,
                  SUM(CASE WHEN disposition = 'fixed' THEN 1 ELSE 0 END) AS fixed
             FROM finding
            WHERE run_id IN (${marks}) AND placement = 'inline'
              AND disposition <> 'continued'
            GROUP BY run_id`,
        )
        .all(...ids);

      // 漏复核只数条数:结论本身在 finding_verdict 里,时间流要的是「有没有认真复核」。
      const byVerdict = db
        .prepare(
          `SELECT run_id, SUM(missing) AS missed
             FROM finding_verdict
            WHERE run_id IN (${marks}) GROUP BY run_id`,
        )
        .all(...ids);

      const byFinding = db
        .prepare(
          `SELECT id, run_id, file, line, severity, category, description,
                  disposition, placement, comment_id, comment_html_url,
                  disposed_by, disposed_at, disposition_note, continued_from
             FROM finding
            WHERE run_id IN (${marks}) ORDER BY id`,
        )
        .all(...ids);
      const byAttribution = db
        .prepare(
          `SELECT a.finding_id AS finding_id, a.model AS model
             FROM finding_attribution a
             JOIN finding f ON f.id = a.finding_id
            WHERE f.run_id IN (${marks}) ORDER BY a.finding_id, a.position`,
        )
        .all(...ids);

      const byPin = db
        .prepare(
          `SELECT run_id, identity, provider, model, model_service_version,
                  base_url, api, runtime_model_json, materialization_failure
             FROM review_run_reviewer_pin
            WHERE run_id IN (${marks}) ORDER BY run_id, position`,
        )
        .all(...ids);
      const findingCounts = new Map<string, number>();
      for (const row of byModel) {
        findingCounts.set(
          `${Number(row["run_id"])}\n${String(row["model"])}`,
          Number(row["findings"]),
        );
      }
      const models = new Map<number, RunListItem["models"]>();
      for (const row of byOutcome) {
        const runId = Number(row["run_id"]);
        const model = String(row["model"]);
        const list = models.get(runId) ?? [];
        const usage = recordedUsage(row);
        list.push({
          model,
          findings: findingCounts.get(`${runId}\n${model}`) ?? 0,
          failure: failureExcerpt(row["failure"]),
          ...(usage === undefined ? {} : { usage }),
        });
        models.set(runId, list);
      }
      // 有 Finding 却没有 outcome 行的模型仍要出现:这一档是历史数据的兜底,漏掉它
      // 就是把已经落库的 Finding 从面板上抹掉。
      for (const [key, findings] of findingCounts) {
        const [runIdText, model] = key.split("\n") as [string, string];
        const runId = Number(runIdText);
        const list = models.get(runId) ?? [];
        if (list.some((entry) => entry.model === model)) continue;
        list.push({ model, findings, failure: null });
        list.sort((a, b) => a.model.localeCompare(b.model));
        models.set(runId, list);
      }
      const missedVerdicts = new Map<number, number>();
      for (const row of byVerdict) {
        missedVerdicts.set(Number(row["run_id"]), Number(row["missed"] ?? 0));
      }
      const groups = new Map<number, { resolved: number; fixed: number; total: number }>();
      for (const row of byGroup) {
        groups.set(Number(row["run_id"]), {
          resolved: Number(row["resolved"]),
          fixed: Number(row["fixed"]),
          total: Number(row["total"]),
        });
      }
      const reviewerPins = new Map<number, ReviewRunReviewerPin[]>();
      for (const row of byPin) {
        const runId = Number(row["run_id"]);
        const list = reviewerPins.get(runId) ?? [];
        list.push({
          identity: String(row["identity"]),
          provider: String(row["provider"]),
          model: String(row["model"]),
          modelServiceVersion:
            row["model_service_version"] === null
              ? null
              : Number(row["model_service_version"]),
          target:
            row["base_url"] === null || row["api"] === null
              ? null
              : { baseUrl: String(row["base_url"]), api: String(row["api"]) },
          runtimeModel:
            row["runtime_model_json"] === null
              ? null
              : JSON.parse(String(row["runtime_model_json"])) as NonNullable<
                  ReviewRunReviewerPin["runtimeModel"]
                >,
          failure:
            row["materialization_failure"] === null
              ? null
              : String(row["materialization_failure"]),
        });
        reviewerPins.set(runId, list);
      }
      const attributionModels = new Map<number, string[]>();
      for (const row of byAttribution) {
        const findingId = Number(row["finding_id"]);
        const list = attributionModels.get(findingId) ?? [];
        list.push(String(row["model"]));
        attributionModels.set(findingId, list);
      }
      const findings = new Map<number, RunListItem["findings"]>();
      for (const row of byFinding) {
        const runId = Number(row["run_id"]);
        const list = findings.get(runId) ?? [];
        list.push({
          id: Number(row["id"]),
          models: attributionModels.get(Number(row["id"])) ?? [],
          file: String(row["file"]),
          line: Number(row["line"]),
          severity: String(row["severity"]) as Severity,
          category: String(row["category"]) as Category,
          description: String(row["description"]),
          disposition: String(row["disposition"]) as Disposition,
          placement: String(row["placement"]) as FindingPlacement,
          commentId: row["comment_id"] === null ? null : String(row["comment_id"]),
          commentHtmlUrl:
            row["comment_html_url"] === null ? null : String(row["comment_html_url"]),
          disposedBy: row["disposed_by"] === null ? null : String(row["disposed_by"]),
          disposedAt: row["disposed_at"] === null ? null : String(row["disposed_at"]),
          note: row["disposition_note"] === null ? null : String(row["disposition_note"]),
          continuedFrom:
            row["continued_from"] === null ? null : String(row["continued_from"]),
        });
        findings.set(runId, list);
      }
      return runs.map((run) => {
        const id = Number(run["id"]);
        const usage = recordedUsage(run);
        return {
          id,
          owner: String(run["owner"]),
          repo: String(run["repo"]),
          pullNumber: Number(run["pull_number"]),
          headSha: String(run["head_sha"]),
          triggeredBy:
            run["triggered_by"] === null ? null : String(run["triggered_by"]),
          rangeReviewId:
            run["range_review_id"] === null ? null : Number(run["range_review_id"]),
          startedAt: String(run["started_at"]),
          finishedAt: run["finished_at"] === null ? null : String(run["finished_at"]),
          failed: Number(run["failed"]) === 1,
          models: models.get(id) ?? [],
          ...(usage === undefined ? {} : { usage }),
          reviewerPins: reviewerPins.get(id) ?? [],
          findings: findings.get(id) ?? [],
          missedVerdicts: missedVerdicts.get(id) ?? 0,
          resolved: groups.get(id)?.resolved ?? 0,
          fixed: groups.get(id)?.fixed ?? 0,
          total: groups.get(id)?.total ?? 0,
        };
      });
    },

    createRangeReview(record) {
      // 分支名要跟着记录一起可见:插入拿到 id 之后立刻补上,失败时整笔回滚。
      // 发起时的比较项同时进历史表:它是这个阶段审过的第一个 commit。
      db.exec("BEGIN");
      try {
        const result = db
          .prepare(
            `INSERT INTO range_review
               (repo_id, owner, repo, base_sha, comparison_sha, state,
                base_branch, head_branch, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, 'in-progress', '', '', ?, ?)`,
          )
          .run(
            record.repoId,
            record.owner,
            record.repo,
            record.baseSha,
            record.comparisonSha,
            record.createdBy,
            record.createdAt,
          );
        const id = Number(result.lastInsertRowid);
        const branches = containerBranches(id);
        db.prepare(
          "UPDATE range_review SET base_branch = ?, head_branch = ? WHERE id = ?",
        ).run(branches.base, branches.head, id);
        db.prepare(
          `INSERT INTO range_review_comparison (range_review_id, sha, recorded_by, recorded_at)
           VALUES (?, ?, ?, ?)`,
        ).run(id, record.comparisonSha, record.createdBy, record.createdAt);
        db.exec("COMMIT");
        return id;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    attachRangeReviewContainer(id, containerPullNumber) {
      db.prepare(
        `UPDATE range_review
            SET container_pull_number = ?, last_forge_failure = NULL
          WHERE id = ?`,
      ).run(containerPullNumber, id);
    },

    failRangeReview(id, failure) {
      db.prepare(
        "UPDATE range_review SET state = 'failed', last_forge_failure = ? WHERE id = ?",
      ).run(failure, id);
    },

    recordRangeReviewForgeFailure(id, failure) {
      db.prepare("UPDATE range_review SET last_forge_failure = ? WHERE id = ?").run(
        failure,
        id,
      );
    },

    advanceRangeReview(record) {
      db.exec("BEGIN");
      try {
        db.prepare(
          `UPDATE range_review
              SET comparison_sha = ?, last_forge_failure = NULL
            WHERE id = ?`,
        ).run(record.comparisonSha, record.id);
        db.prepare(
          `INSERT INTO range_review_comparison (range_review_id, sha, recorded_by, recorded_at)
           VALUES (?, ?, ?, ?)`,
        ).run(record.id, record.comparisonSha, record.advancedBy, record.advancedAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    completeRangeReview(record) {
      db.prepare(
        `UPDATE range_review
            SET state = 'completed', completed_by = ?, completed_at = ?,
                last_forge_failure = NULL
          WHERE id = ?`,
      ).run(record.completedBy, record.completedAt, record.id);
    },

    listRangeReviewComparisons(rangeReviewId) {
      return db
        .prepare(
          `SELECT id, sha, recorded_by, recorded_at
             FROM range_review_comparison
            WHERE range_review_id = ?
            ORDER BY id`,
        )
        .all(rangeReviewId)
        .map((row) => ({
          id: Number(row["id"]),
          sha: String(row["sha"]),
          recordedBy: String(row["recorded_by"]),
          recordedAt: String(row["recorded_at"]),
        }));
    },

    getRangeReview(id) {
      const row = db.prepare("SELECT * FROM range_review WHERE id = ?").get(id);
      return row === undefined ? undefined : rangeReviewRecord(row);
    },

    listRangeReviews(opts) {
      const conditions: string[] = [];
      const params: (number | string)[] = [];
      if (opts.owner !== undefined && opts.repo !== undefined) {
        conditions.push("owner = ? AND repo = ?");
        params.push(opts.owner, opts.repo);
      }
      if (opts.baseSha !== undefined) {
        conditions.push("base_sha = ?");
        params.push(opts.baseSha);
      }
      if (opts.state !== undefined) {
        conditions.push("state = ?");
        params.push(opts.state);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      return db
        .prepare(`SELECT * FROM range_review ${where} ORDER BY id DESC`)
        .all(...params)
        .map(rangeReviewRecord);
    },

    getRunRange(id) {
      const row = db
        .prepare(
          `SELECT run.id, run.owner, run.repo, run.pull_number, run.head_sha,
                  run.range_review_id, rr.base_sha
             FROM review_run run
             LEFT JOIN range_review rr ON run.range_review_id = rr.id
            WHERE run.id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return {
        id: Number(row["id"]),
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        pullNumber: Number(row["pull_number"]),
        headSha: String(row["head_sha"]),
        rangeReviewId:
          row["range_review_id"] === null ? null : Number(row["range_review_id"]),
        baseSha: row["base_sha"] === null ? null : String(row["base_sha"]),
      };
    },

    getFinding(id) {
      const row = db
        .prepare(
          `SELECT f.id, f.comment_id, f.disposition, f.disposition_note,
                  run.owner, run.repo
             FROM finding f
             JOIN review_run run ON f.run_id = run.id
            WHERE f.id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return {
        id: Number(row["id"]),
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        commentId: row["comment_id"] === null ? null : String(row["comment_id"]),
        disposition: String(row["disposition"]) as Disposition,
        note: row["disposition_note"] === null ? null : String(row["disposition_note"]),
      };
    },

    recordDisposition(input) {
      const result = db
        .prepare(
          `UPDATE finding
              SET disposition = ?, disposed_by = ?, disposed_at = ?,
                  disposition_note = COALESCE(?, disposition_note)
            WHERE comment_id = ?
              AND run_id IN (SELECT id FROM review_run WHERE owner = ? AND repo = ?)`,
        )
        .run(
          input.disposition,
          input.disposedBy,
          input.disposedAt,
          input.note ?? null,
          input.commentId,
          input.owner,
          input.repo,
        );
      return Number(result.changes);
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

    pendingAutoDispositions(findingIds) {
      const probe = db.prepare(
        `SELECT comment_id FROM finding
          WHERE id = ? AND comment_id IS NOT NULL AND ${AUTO_DISPOSABLE}`,
      );
      return findingIds.flatMap((findingId) => {
        const row = probe.get(findingId);
        if (row === undefined) return [];
        return [{ findingId, commentId: String(row["comment_id"]) }];
      });
    },

    recordAutoDisposition(owner, repo, pullNumber, candidate, disposedAt) {
      // 折叠键与 `stageHistory` 同源:文件 + 指纹,算不出指纹的行只有它自己一条。
      db.prepare(
        `UPDATE finding SET disposition = 'fixed', disposed_at = ?
          WHERE file = (SELECT file FROM finding WHERE id = ?)
            AND COALESCE(fingerprint, 'row:' || id) =
                (SELECT COALESCE(fingerprint, 'row:' || id) FROM finding WHERE id = ?)
            AND ${AUTO_DISPOSABLE}
            AND ${PULL_REQUEST_SCOPE}`,
      ).run(
        disposedAt,
        candidate.findingId,
        candidate.findingId,
        owner,
        repo,
        pullNumber,
      );
    },

    continuationCandidates(findingIds) {
      const probe = db.prepare(
        `SELECT file, line, title, description, fingerprint,
                comment_id, comment_html_url FROM finding
          WHERE id = ? AND fingerprint IS NOT NULL
            AND comment_id IS NOT NULL AND comment_html_url IS NOT NULL
            AND disposition IN ('unknown', 'unresolved')`,
      );
      return findingIds.flatMap((findingId) => {
        const row = probe.get(findingId);
        if (row === undefined) return [];
        return [
          {
            findingId,
            file: String(row["file"]),
            line: Number(row["line"]),
            title: row["title"] === null ? "" : String(row["title"]),
            description: String(row["description"]),
            fingerprint: String(row["fingerprint"]),
            commentId: String(row["comment_id"]),
            commentHtmlUrl: String(row["comment_html_url"]),
          },
        ];
      });
    },

    recordContinuation({ owner, repo, pullNumber, runId, groupIndex, candidate }) {
      db.exec("BEGIN");
      try {
        // 先把旧行的三列抄到新行上,再改旧行的处置值:两条语句都只碰自己那一侧,
        // 顺序其实无关,写成这样是让「谁继承谁」一眼看得出来。
        db.prepare(
          `UPDATE finding
              SET (disposed_by, disposed_at, disposition_note, continued_from) =
                    (SELECT prior.disposed_by, prior.disposed_at, prior.disposition_note, ?
                       FROM finding prior WHERE prior.id = ?)
            WHERE run_id = ? AND group_index = ?`,
        ).run(candidate.commentHtmlUrl, candidate.findingId, runId, groupIndex);
        // 折叠键与 `stageHistory`、自动处置同源:文件 + 指纹。本轮新行的指纹必然与它
        // 不同——旧指纹在本轮 head 上算不出正是延续的前提,不会被这一笔一起改掉。
        db.prepare(
          `UPDATE finding SET disposition = 'continued'
            WHERE file = (SELECT file FROM finding WHERE id = ?)
              AND COALESCE(fingerprint, 'row:' || id) =
                  (SELECT COALESCE(fingerprint, 'row:' || id) FROM finding WHERE id = ?)
              AND disposition IN ('unknown', 'unresolved')
              AND ${PULL_REQUEST_SCOPE}`,
        ).run(candidate.findingId, candidate.findingId, owner, repo, pullNumber);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    backfillDispositions(owner, repo, pullNumber, updates) {
      if (updates.length === 0) return;
      // 「已延续」两个方向都不覆盖:延续时旧评论被 resolve 过,读回的 resolved 是那次
      // 交接的痕迹,不是处置;人在 Forge 上把它 unresolve 也一样——这条 Finding 的当前
      // 位置已经在新行上,旧行只剩「已经交接过」这一个事实。
      const withDisposition = db.prepare(
        `UPDATE finding SET disposition = ?, placement = ?
          WHERE file = ? AND fingerprint = ? AND disposition <> 'continued'
            AND ${PULL_REQUEST_SCOPE}`,
      );
      // 「已修复」在 Forge 上就是一个 resolve,读回的 resolved 因此不能把它降级成人工
      // 那一档——处置率会凭空多出人工处置。读回 unresolved 是另一回事:人在 Forge 上
      // 撤回了处置,以 Forge 最新状态为准,照写。
      const keepAutoDisposed = db.prepare(
        `UPDATE finding SET disposition = ?, placement = ?
          WHERE file = ? AND fingerprint = ?
            AND disposition <> 'fixed' AND disposition <> 'continued'
            AND ${PULL_REQUEST_SCOPE}`,
      );
      const placementOnly = db.prepare(
        `UPDATE finding SET placement = ?
          WHERE file = ? AND fingerprint = ? AND ${PULL_REQUEST_SCOPE}`,
      );
      db.exec("BEGIN");
      try {
        for (const entry of updates) {
          if (entry.disposition === undefined) {
            placementOnly.run(entry.placement, entry.file, entry.fingerprint, owner, repo, pullNumber);
          } else {
            const update =
              entry.disposition === "resolved" ? keepAutoDisposed : withDisposition;
            update.run(
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
  return store;
}
