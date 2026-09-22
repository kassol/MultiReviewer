/**
 * Review Run 的持久化。库是 PostgreSQL,经 Drizzle 读写(ADR 0036)。
 *
 * 这个文件是库的装配处:连接池、事务、各域方法的组装。表的声明在 `../schema/`,按域一个
 * 文件;方法按域分在这个目录下的 `accounts.ts` / `repos.ts` / … 里(spec #445 第二段)。
 *
 * Disposition 的权威状态在 Forge 上,`finding.disposition` 只缓存最近一次读回的
 * 结果,默认 `unknown`。
 */
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "../schema/index.ts";
import { accountsMethods } from "./accounts.ts";
import { sessionsMethods } from "./sessions.ts";
import { productsMethods } from "./products.ts";
import { reposMethods } from "./repos.ts";
// 仓库域搬走的那几件公共符号(issue #451):调用方仍从这里引,路径不动。
export {
  CUSTOM_PROVIDER_NAME_PATTERN,
  storedReviewersEmpty,
  toProjectFact,
  toReviewRule,
  type BatchLimitField,
} from "./repos.ts";
import { stagesMethods } from "./stages.ts";
import {
  AUTO_DISPOSABLE,
  BACKFILL_TARGET,
  carriedByFinding,
  identityKey,
  PULL_REQUEST_SCOPE,
  readMinReportSeverity,
  readTriggerSource,
  recordedAttribution,
  recordedUsage,
  repoPairCondition,
  representativeSegment,
  STAGE_ID_FROM_RUN,
  stageScope,
  storeHelpers,
  usageColumns,
  type ModelServiceBoundTarget,
  type PlannedAcceptance,
  type StoreContext,
} from "./shared.ts";
export * from "./shared.ts";
import { createPool, storeDb, type PgPool } from "./pg.ts";
export type { StoreTransaction, TransactionMode } from "./pg.ts";

import {
  type ReviewerSpec,
  type ReviewRunReviewerPin,
  type ThinkingLevel,
} from "../../config.ts";
import type { LineAuthor } from "../../git/worktree.ts";
import type { PanelPermission } from "../../panel/permissions.ts";
import { type DiscoveredModel } from "../../reviewer/model-service-runtime.ts";
import type {
  CarriedAttribution,
  Category,
  Disposition,
  HistoryFinding,
  KnowledgeEntry,
  KnowledgeType,
  PendingProposal,
  ProjectFact,
  ReviewerUsage,
  ReviewRule,
  ReviewRunMode,
  ReviewTriggerSource,
  ReviewVerdict,
  RuleProposalChange,
  Severity,
} from "../finding.ts";
import { DEFAULT_MIN_REPORT_SEVERITY } from "../finding.ts";
import type { RunProjection } from "../../contracts/runs.ts";
// 只取类型:`batch.ts` 反过来引用本模块的 `sumUsage`,类型导入在运行时被抹掉,不成环。
import type { TimedOutcome } from "../batch.ts";
import type { RangeReviewState } from "../range-review.ts";
import type {
  RuleTraceEvent,
  RuleTraceEventInput,
  RuleTraceKind,
  TraceEvent,
  TraceEventInput,
  TraceKind,
  TraceScope,
} from "../trace.ts";

export const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  -- 这一轮开跑时那个 pull request 的标题快照。范围审查那一档为 NULL(容器 PR 的标题
  -- 是本工具自己拼的),升级前落库的旧行也是 NULL。
  title TEXT,
  -- 这一轮属于哪个范围审查(ADR 0012)。PR 触发的为 NULL;范围审查那一档的
  -- pull_number 是它的容器 PR。
  range_review_id INTEGER,
  -- pull request 的状态,closed 回填写上,NULL 即尚未见到关闭。unknown 的 finding
  -- 只在已关闭的 PR 上进统计分母(ADR 0006)。
  pr_state TEXT,
  -- 手动重跑的调用者用户名快照,NULL 即投递。刻意不引用 panel_user:删号后历史保留。
  triggered_by TEXT,
  -- 这一轮是被谁开出来的(issue #312):投递、面板,或定时检查。可空是为了让升级前
  -- 的旧行补得进来(openStore 按 triggered_by 回填),回填之后不再有 NULL。
  trigger_source TEXT,
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
  -- 开跑时生效的规则集版本,没有规则集时为 NULL。
  rule_set_version INTEGER,
  -- 本轮指令(CONTEXT.md,issue #225)。发起重审时附的一次性要求,只属于这一轮。
  directive TEXT,
  -- 这一轮的模式(CONTEXT.md 只复核,issue #242)。NULL 读作完整审查。
  mode TEXT,
  -- 开跑时的历史 Finding 快照(issue #248)。续跑的批次读它,不重读库里当前的历史:
  -- 重启期间有人处置了一条历史时,续跑批次拿到的仍要与原轮各批一致。NULL 即「这一轮
  -- 没有快照」,续跑因此不成立,退回改判失败。
  history_json TEXT,
  -- 轮次级的失败原因(ADR 0026,issue #256):这一轮为什么没有正常收尾。NULL 即收尾正常。
  -- 它与 failed 分开——failed 仍只回答「全部 Reviewer 失败」(ADR 0016 据它决定
  -- 不做自动处置),发布 review 失败那一类 Reviewer 结果有效的轮次只写这一列。
  failure TEXT,
  -- 开跑时冻结的完整批次计划(issue #253):全部批次的文件清单,JSON 数组套数组,按批次
  -- 序号排。开跑时写一次、之后不改——它与 review_run_batch_outcome 分工:计划说这一轮要
  -- 切成哪几批,中间态表说哪一批的哪个模型已经有结果。续跑核对重新切批的每一批都与它相符,未完成
  -- 的批次因此也核对得到;NULL 即「没有计划」,续跑不成立,退回改判失败。
  batch_plan_json TEXT,
  -- 开跑时生效的最低报告等级(CONTEXT.md 最低报告等级,issue #271)。NULL 读作 P2。
  min_report_severity TEXT,
  -- 开跑时冻结的辅助模型(CONTEXT.md 辅助模型,ADR 0029,issue #304):这一轮的合并
  -- agent 用哪一处模型与档位,一处 ReviewerSpec 的 JSON。开跑时解析一次写下,之后
  -- 改配置追不上这一轮,续跑读它而不重新解析。NULL 即「没有冻结的那一处」,退回按
  -- 配置序第一个 Reviewer 走。
  auxiliary_model TEXT
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
  thinking_level TEXT,
  PRIMARY KEY (run_id, position),
  UNIQUE (run_id, identity)
);

-- 一个 Reviewer 在一批上跑完就落一行(issue #410,ADR 0024 的 2026-09-21 修订)。服务
-- 重启会让内存里的结果一并消失,已经花掉的 token 保不住;这张表是恢复粒度的落点——
-- 续跑按它知道哪一批的哪个模型已经有结果,同批其他模型不必陪它一起重跑。
--
-- 中间态刻意与 reviewer_outcome / finding 分表:事后统计只认已结束的轮次,这里的行不
-- 进任何分母。收尾仍走 finishRun 那一个事务,一轮只发一次 review 不变。
--
-- outcome_json 是一个 TimedOutcome:这个模型这一批的结果、开始时刻与耗时。这一批的文件
-- 清单不在这里——开跑时冻结的 review_run.batch_plan_json 已经逐批写着它,而续跑没有计划
-- 就根本不成立,两处存一份即够。
CREATE TABLE IF NOT EXISTS review_run_batch_outcome (
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  batch_index INTEGER NOT NULL,
  model TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  PRIMARY KEY (run_id, batch_index, model)
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
  total_tokens INTEGER
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
  -- 代表段的影响与建议(issue #278):与 title / description 同出一条归属,面板与 Forge
  -- 评论的正文读的就是这一份。两列同为 NULL 即升级前落的行,读侧按同一规则从归属现算。
  impact TEXT,
  suggestion TEXT,
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
  continued_from TEXT,
  -- 交接未完成(ADR 0025,issue #252):延续落库时旧评论的 resolve 没成,1 即旧评论
  -- 还留在 Forge 上待关闭。只挂在「已延续」的旧行上,是处置值之上的一个待办标记,
  -- 不是处置;下一轮收尾重试 resolve 成功、或回填读到旧评论已 resolve 时清回 NULL。
  handoff_pending INTEGER,
  -- 行作者(CONTEXT.md):这条 Finding 所在行在本轮 head 上最后一次改动的 git author
  -- 与那次提交。评审落库时一并写入,四列要么一起有值、要么一起是 NULL。
  -- 四列同 NULL 即「未判定」:升级前落的行,以及判定失败留空的那些。读路径会在阶段
  -- 汇总里补录并回写这四列(issue #199),因此 NULL 不是终态。
  line_author_sha TEXT,
  line_author_name TEXT,
  line_author_email TEXT,
  line_author_at TEXT,
  -- 行作者取自相邻改动(issue #241):落点是 hunk 内的上下文行,作者来自同 hunk 内最近
  -- 的那处改动而不是这一行本身。1 即是,0 即落点自己就是本轮的改动行;NULL 是升级前
  -- 落的行与补录路径写的那些,读回按 0。
  line_author_adjacent INTEGER,
  -- 命中的那条评审规则,没有命中或升级前落的行为 NULL。
  rule_id INTEGER,
  -- 这条 Finding 此刻的位置,以及位置是在哪一轮的 head 上定下的(issue #368)。每一轮
  -- 开跑时按内容指纹把本阶段每条 Identity 的最新一行重定位到那一轮的 head 上,解析得到
  -- 才写这两列。两列同 NULL 即「与 line / run_id 相同」:line 与 run_id 说的始终是它在
  -- 哪一轮的哪一行被报出来的,归属、首次报出与指纹窗口都按那一份算,重定位一格不动它们。
  placed_line INTEGER,
  placed_run_id INTEGER REFERENCES review_run(id)
);

CREATE INDEX IF NOT EXISTS finding_by_run ON finding(run_id);

-- 一条 Finding 的归属:报出它的每个模型一行,带它自己的严重度、分类与表述(ADR 0015)。
-- position 是首报先后,0 即首报——合并后的分类取它,统计矩阵的模型也取它。
-- 同一条 Finding 允许同一模型的多条归属:模型对同一处报出内容不同的几条时全部保留
-- (检出率优先,2026-08-31),不再有 (finding_id, model) 唯一约束。
CREATE TABLE IF NOT EXISTS finding_attribution (
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  position INTEGER NOT NULL,
  model TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  -- 这个模型自己给的影响与建议(issue #266)。空串即模型没给;NULL 只出现在升级前落的
  -- 行上,意思是「当时没存」,恢复操作据此认出缺失的那些。
  impact TEXT,
  suggestion TEXT,
  PRIMARY KEY (finding_id, position)
);
CREATE INDEX IF NOT EXISTS finding_attribution_by_model ON finding_attribution(model);

-- 延续承接来的历史说法(issue #267):按复核结论合成的延续那一行,把历史 Finding 各归属的
-- 问题、影响与建议原样带过来,每段记最初说出它的模型与那一轮(head 即建议适用的代码版本)。
-- 它不是本轮的归属:本轮归属只有给出新位置的那个模型,参与条数与各处统计都不读这张表。
-- 连续多轮延续原样再抄一遍,run_id 仍是最初那一轮,不层层嵌套。impact / suggestion 为
-- NULL 即源头本身没存(升级前的行),恢复操作据此补;空串是模型当时没给。
CREATE TABLE IF NOT EXISTS finding_carried_attribution (
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  position INTEGER NOT NULL,
  model TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  description TEXT NOT NULL,
  impact TEXT,
  suggestion TEXT,
  PRIMARY KEY (finding_id, position)
);

-- 一轮里每个 Reviewer 对每条未处置历史 Finding 的复核结论(ADR 0016)。finding_id
-- 指注入时该 Finding Identity 的最新一行。漏给结论的按「无法判断」照样落一行并标
-- missing:沉默不是证据,但"这个模型压根没复核"要数得出来。这批记录同时是自动处置的裁决输入。
--
-- missing_reason 说的是为什么没结论(issue #412、#413):no-verdict 是这个模型跑了那一批
-- 却没给,batch-failed 是那一批根本没跑成,no-batch 是本轮没有哪一批读到它那个文件。三件事
-- 的排障方向不同——前者是模型行为,后两者是模型服务与覆盖缺口。升级前的行是 NULL,按旧口径
-- 整份算漏复核。给了结论的行 missing = 0、这一列为 NULL。
CREATE TABLE IF NOT EXISTS finding_verdict (
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  model TEXT NOT NULL,
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  verdict TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  missing_reason TEXT,
  PRIMARY KEY (run_id, model, finding_id)
);

-- 同根因组(CONTEXT.md,ADR 0030,issue #308):一轮里由合并 agent 指出的一组 Finding,
-- 它们各自成立,却出自同一个根因。组属于轮次,每轮重新提,不跨轮次保持同一性——因此
-- 没有阶段维度的键,也没有更新路径:一轮收尾时写一次,之后只读。
-- 合并 agent 缺席、失败或方案没过验收的那一轮一行都没有。
CREATE TABLE IF NOT EXISTS root_cause_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  -- 根因说明:合并 agent 写的那一句中文。
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS root_cause_group_by_run ON root_cause_group(run_id);

-- 同根因组的成员:一条 Finding 一行,position 是组内次序(agent 报出这几个合并组的先后)。
-- finding_id 是最终落库的那一行——本轮新报的、折叠到的历史行、延续承接后的新行。
-- 一条 Finding 至多进一个同根因组,主键因此够用。
CREATE TABLE IF NOT EXISTS root_cause_group_member (
  group_id INTEGER NOT NULL REFERENCES root_cause_group(id),
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, finding_id)
);

-- 一轮 Review Run 的审查轨迹(CONTEXT.md,ADR 0017):按时间顺序发生的事件,一行一条。
-- seq 在一轮之内自增,断线续传按它续;reviewer 是模型标识,与 reviewer_outcome.model
-- 同一个值,轮次级事件为 NULL。payload 是事件正文的 JSON 文本,不设长度上限。
-- 随 Review Run 永久保留:Review Run 没有删除路径,轨迹也没有。
CREATE TABLE IF NOT EXISTS review_trace (
  run_id INTEGER NOT NULL REFERENCES review_run(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  scope TEXT NOT NULL,
  reviewer TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- 回填的索引:回填按「文件 + 指纹」改行、按 PR 定位 Review Run。统计矩阵是全表
-- 聚合,时间窗过滤在聚合之后,建不出能用上的索引。
CREATE INDEX IF NOT EXISTS finding_by_anchor ON finding(file, fingerprint);
CREATE INDEX IF NOT EXISTS review_run_by_pr ON review_run(owner, repo, pull_number);
CREATE INDEX IF NOT EXISTS review_run_by_range ON review_run(range_review_id);

-- 范围审查(ADR 0012):人在面板发起的一个阶段性审查,不依赖任何既有 pull request。
-- 不按 base 去重,每次发起都是新的一条;同一仓库同一 base 已有进行中的只提醒。
-- 两条分支名由 id 推出,仍然落库——清理与展示要读同一份事实,而不是各自再推一次。
-- 不引用 repo(id):仓库移除后评审记录只写不清,范围审查同理。
CREATE TABLE IF NOT EXISTS range_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  -- 发起时由人给的标题(issue #177),发起后不可改。升级前的旧行是 NULL,
  -- 评审记录按「#编号」显示它们。
  title TEXT,
  base_sha TEXT NOT NULL,
  comparison_sha TEXT NOT NULL,
  -- 选定当前比较项时用的分支或 Tag(issue #234)。增量评审的选择器据它开在同一条分支
  -- 上,不是历史事实——历次比较项在 range_review_comparison 上,那张表不记来源。
  comparison_source_kind TEXT,
  comparison_source_name TEXT,
  state TEXT NOT NULL,
  container_pull_number INTEGER,
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_by TEXT,
  completed_at TEXT,
  -- 最近一次 Forge 操作的失败原因。是权限还是分支保护,只有这一行能说明。
  last_forge_failure TEXT,
  -- 每日增量(CONTEXT.md 每日增量,issue #313):开着时定时检查每天把这条分支的最新
  -- commit 推成新比较项。关着时分支与开启时刻都是 NULL。
  daily_increment_enabled INTEGER NOT NULL DEFAULT 0,
  daily_increment_branch TEXT,
  -- 最近一次开启或改分支的时刻。定时检查按它判「开启当天不算错过」——刚开就补跑一
  -- 次不是人要的(CONTEXT.md 定时检查)。
  daily_increment_enabled_at TEXT,
  -- 最近一次定时检查的时刻与结果(issue #314)。只留一条,新的覆盖旧的;开轮次的那
  -- 一次本身已在时间线里,不另记事件。任何结果都刷新时刻,一天因此至多检查一次。
  scheduled_check_at TEXT,
  scheduled_check_result TEXT,
  -- 每天几点检查(本地时区 HH:mm)与检查模式(issue #315)。关着时回到默认值。
  scheduled_check_time TEXT NOT NULL DEFAULT '00:00',
  scheduled_check_mode TEXT NOT NULL DEFAULT 'verdict-only'
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
-- (ReviewerSpec 的 JSON 数组),NULL 即跟随 global_setting 里的全局模型组合;
-- min_report_severity 是最低报告等级的覆盖(issue #273),NULL 同样即跟随全局。
-- worktree_* 三列是工作副本的准备状态(issue #184):state 取 preparing / ready /
-- failed,升级前注册的那些行是 NULL,按 unknown 读;worktree_failure 只在 failed 时
-- 有值,worktree_checked_at 是这个结果的时刻。
CREATE TABLE IF NOT EXISTS repo (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  reviewers TEXT,
  worktree_state TEXT,
  worktree_failure TEXT,
  worktree_checked_at TEXT,
  registered_at TEXT NOT NULL,
  -- 这个仓库自己的辅助模型覆盖,NULL 即跟随全局。
  auxiliary_model TEXT,
  -- 这个仓库自己的最低报告等级覆盖(CONTEXT.md 最低报告等级,issue #273)。NULL 即跟随全局。
  min_report_severity TEXT,
  -- 这个仓库的默认分支(CONTEXT.md 默认分支,issue #350)。NULL 即跟随 Gitea 的默认分支。
  default_branch TEXT,
  -- 仓库配置的整块版本号(issue #302):模型覆盖与最低报告等级一次写完,版本随之加一。
  -- 从 0 起,配置一次都没经这个端点写过的仓库因此是 0。
  settings_version INTEGER NOT NULL DEFAULT 0
);

-- 仓库的 key。明文存库:HMAC 验签需要原始值,这是密码学约束,不是疏忽。代次单调
-- 递增并写进 hook URL 的 ?k=,轮转期间一个仓库最多两把并存(ADR 0007)。
CREATE TABLE IF NOT EXISTS repo_key (
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  generation INTEGER NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (repo_id, generation)
);

-- 知识集版本(CONTEXT.md)。一次知识确认或裁决采纳记一行,版本按仓库从 1 递增。
-- 有没有行就是「这个仓库确认过知识集没有」的判据:空知识集是合法状态,它与「还没
-- 确认」在规则行上分不出来,只有这张表分得出。
CREATE TABLE IF NOT EXISTS rule_set_version (
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, version)
);

-- 知识条目(CONTEXT.md)。scope 是 glob,空串即全仓库;statement 是那一句陈述;
-- origin 是出处。layer 列是退役的层标签:代码不再读也不再写新值,新行一律空串,存量行
-- 原样留着——它 NOT NULL 且没人读,删列要重建整张表,不值当。
--
-- type 是封闭的两值枚举(ADR 0020):rule 是评审规则,违反即 Finding;fact 是项目
-- 事实,注入后只作判断依据。两型同表是因为它们形状同构——作用范围、陈述、出处与两态
-- 生命周期一模一样,差别只在注入模板与消费语义。升级前的行没有这一列,DEFAULT 把它们
-- 全部读成规则型(ADR 0020 的存量迁移)。
--
-- 两态生命周期不另存历史表:effective_version 是它进集的那一版,retired_version 是它
-- 被废止的那一版(NULL 即仍生效)。知识集版本 V 的快照因此是一句 WHERE——
-- effective_version <= V 且(retired_version 为 NULL 或 > V),Review Run 冻结版本后按
-- 它取当时那一组,两型一体。state 与 retired_version 由 CHECK 绑死,两者不会各说各话。
CREATE TABLE IF NOT EXISTS review_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  type TEXT NOT NULL DEFAULT 'rule' CHECK (type IN ('rule', 'fact')),
  scope TEXT NOT NULL,
  statement TEXT NOT NULL,
  layer TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  origin TEXT NOT NULL,
  effective_version INTEGER NOT NULL,
  retired_version INTEGER,
  created_at TEXT NOT NULL,
  CHECK ((state = 'active') = (retired_version IS NULL))
);
CREATE INDEX IF NOT EXISTS review_rule_by_repo ON review_rule(repo_id);

-- 基点探索(CONTEXT.md,issue #205)。每仓库至多一行:重新探索覆盖上一次的那一行,
-- 「同仓库同时只跑一个」因此就是这一行的 state 是不是 running。
--
-- model 是这次探索所用的模型标识,thinking_level 是那一次的思考档位(NULL 即没选,
-- 等同 off)。**两列只作历史**(issue #304):此后没有任何任务读它们选模型——发起时
-- 用的是这个仓库生效的辅助模型(resolveAuxiliaryModel),处置反哺与人工提议同律。
CREATE TABLE IF NOT EXISTS rule_exploration (
  repo_id INTEGER PRIMARY KEY REFERENCES repo(id),
  baseline_sha TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT,
  trace_task_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('running', 'failed', 'completed')),
  failure TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- 知识整理(CONTEXT.md,issue #284)。与基点探索同形:每仓库至多一行,三态加失败原因,
-- 加这一次的模型、思考档位与知识轨迹;merged / retargeted / proposed 是完成后的摘要(合并
-- 掉的提案条数、改写的条数与对现集提出的提案条数,issue #285),没跑完即 NULL。
--
-- 与 rule_exploration 分表而不是在那一行上加一个 kind:那张表的 baseline_sha 是探索独有的
-- 输入(整理不读代码,没有基点),而它的 model 同时是「这个仓库最近一次探索用的是什么
-- 模型」那份记录,处置反哺沿用它——同一行两用,一次整理就会把那份记录顶掉。互斥不靠同
-- 一行:「同仓库同时只跑一个」判的是两张表里有没有 running,判据写在 startRule* 两处。
CREATE TABLE IF NOT EXISTS rule_consolidation (
  repo_id INTEGER PRIMARY KEY REFERENCES repo(id),
  model TEXT NOT NULL,
  thinking_level TEXT,
  trace_task_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('running', 'failed', 'completed')),
  failure TEXT,
  merged INTEGER,
  retargeted INTEGER,
  proposed INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- 修订意图(CONTEXT.md,ADR 0028,issue #294)。与探索、整理不同,它每仓库多行:一个人
-- 写下一段话即一行,自带三态与自己的知识轨迹,行永久保留供轨迹回溯。
--
-- target_kind 五值,target_id 是那一条的标识('none' 时为 NULL)。五档都写得进:'none'
-- (issue #294)、'proposal'(issue #295)、'finding'(issue #296)、'rule'(issue #297)与
-- 'draft'(issue #298);枚举与列一次落定,免得每加一档就重建一次表。
--
-- produced 是这一次产出的提案与草案条目标识(JSON),summary 是 agent 的一句收尾,
-- 两者都要跑完才有;model 与 thinking_level 是这一次沿反哺规则选出的那一组。
CREATE TABLE IF NOT EXISTS rule_intent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  text TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('none', 'rule', 'proposal', 'draft', 'finding')),
  target_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('running', 'failed', 'completed')),
  failure TEXT,
  summary TEXT,
  model TEXT,
  thinking_level TEXT,
  trace_task_id INTEGER,
  produced_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((target_kind = 'none') = (target_id IS NULL))
);
CREATE INDEX IF NOT EXISTS rule_intent_by_repo ON rule_intent(repo_id);

-- 知识草案(CONTEXT.md,issue #205)。每仓库至多一份,重新探索覆盖未确认的旧草案;
-- 知识确认把这里的条目整组搬进 review_rule 之后清空。
--
-- 与 review_rule 分表而不是给它加一列「未确认」:草案条目没有生效版本,混在同一张表
-- 里,知识集版本 V 的那句 WHERE 就要多一道「而且不是草案」的条件。
CREATE TABLE IF NOT EXISTS rule_draft_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  type TEXT NOT NULL DEFAULT 'rule' CHECK (type IN ('rule', 'fact')),
  scope TEXT NOT NULL,
  statement TEXT NOT NULL,
  layer TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rule_draft_item_by_repo ON rule_draft_item(repo_id);

-- 修订提案(CONTEXT.md,issue #207)。一条待裁决的知识集变更:change 是变更类型,
-- target_rule_ids 是这条变更指向的现有条目(新增没有目标,修改与废止一条,合并两条
-- 以上,issue #282),scope / statement 是提案内容(废止那一档是目标规则当时的原样,
-- 只为看得懂队列里这条要废止什么)。
-- 出处不在这张表上,一条提案的出处是它名下的那一列出处附注(issue #281)。
--
-- 目标存成一个 JSON 数组而不是子表:目标只随提案整条读写,没有一处按目标反查提案;
-- 子表换来的是每条投影多一次连接、每处摘除提案的地方多一次删除,而这张表已经带着
-- 一张附注子表了。
--
-- 与知识草案分表:草案是「还没有知识集时的那一整份」,提案是「已有知识集之上的一条
-- 变更」,它多出变更类型、目标规则、出处与状态机四样,共用一张表就要给草案留四列空值。
CREATE TABLE IF NOT EXISTS rule_proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  type TEXT NOT NULL DEFAULT 'rule' CHECK (type IN ('rule', 'fact')),
  change TEXT NOT NULL CHECK (change IN ('add', 'modify', 'retire', 'merge')),
  target_rule_ids TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL,
  statement TEXT NOT NULL,
  layer TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((change = 'add') = (target_rule_ids = '[]'))
);
CREATE INDEX IF NOT EXISTS rule_proposal_by_repo ON rule_proposal(repo_id);

-- 出处附注(CONTEXT.md,issue #281)。一条提案的出处是一列附注,一行一条:origin 是
-- 这一次的来源,note 是备注原文(只有处置反哺有),evidence 是 agent 为这一条给出的理由
-- 与代码证据(issue #287),finding_id 是引发它的那条 Finding(只有处置反哺有),
-- trace_task_id 是提出它的那一次任务的知识轨迹。
--
-- 与提案分表而不是三列写在提案上:一条提案会被多次来源提到(反哺并入、知识整理合并,
-- issue #280),单值列只留得下最后一次,而人要看的正是「它被哪几件事提过」。
CREATE TABLE IF NOT EXISTS rule_proposal_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES rule_proposal(id),
  origin TEXT NOT NULL
    CHECK (origin IN ('baseline-exploration', 'disposition-feedback', 'knowledge-consolidation',
                      'manual-proposal')),
  note TEXT,
  evidence TEXT,
  finding_id INTEGER,
  trace_task_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rule_proposal_source_by_proposal
  ON rule_proposal_source(proposal_id);

-- 知识轨迹(CONTEXT.md,issue #214)。一次基点探索或一次处置反哺是一条轨迹,task_id
-- 标识它,seq 在一条轨迹之内自增。事件行的形状与 review_trace 同源(ADR 0017):按时间
-- 顺序一行一条,payload 是 JSON 文本、不设长度上限。
--
-- 与 review_trace 分表:那张表的每一行都挂在一个 Review Run 上(run_id 引用 review_run),
-- 而规则 agent 跑在 Review Run 之外,共用一张表就要给它的行留一个空的 run_id 与一套
-- 说不通的 scope。
--
-- 没有单独的任务表:task_id 由这一句 INSERT 里的子查询取全表的 MAX+1 分配(与 seq 同一条
-- 口径),第一条 rule_agent_started 事件就是这条轨迹的存在本身,起了却一条事件都没有的
-- 任务因此不存在。source 与 repo_id 逐行重复,换来的是不必维护第二张表的生命周期。
CREATE TABLE IF NOT EXISTS rule_trace (
  task_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  source TEXT NOT NULL
    CHECK (source IN ('baseline-exploration', 'disposition-feedback', 'knowledge-consolidation',
                      'manual-proposal')),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE INDEX IF NOT EXISTS rule_trace_by_repo ON rule_trace(repo_id);


-- 审查策略,一项一行。reviewers 是全局模型组合,与 repo.reviewers 同构(ReviewerSpec
-- 的 JSON 数组);max_changed_lines_per_batch、max_parallel_batches、max_files_per_batch
-- 与 max_evidence_calls_per_batch 都是正整数的字符串形,缺行即取默认值。每一项各有一个
-- 独立的 *_version 键;历史库没有版本键时按版本 1 读,首次写入再落版本键。
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

-- 仓库分配:一个用户能看见并操作的仓库集合。系统管理员不受限,不在这里留行。
CREATE TABLE IF NOT EXISTS panel_user_repo (
  username TEXT NOT NULL REFERENCES panel_user(username),
  repo_id INTEGER NOT NULL REFERENCES repo(id),
  PRIMARY KEY (username, repo_id)
);

-- 产品(CONTEXT.md 产品,issue #331)。字段只有唯一名称与仓库集合,名称的唯一性由
-- UNIQUE 表达,重名由写入口接住约束报错回 409。
CREATE TABLE IF NOT EXISTS product (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- 产品的仓库集合。主键是 repo_id:「一个仓库至多属一个产品」这条由它表达,不靠写入口
-- 先查一遍再插——并发两次归属时应用层那一查挡不住,主键挡得住。仓库从注册表移除时由
-- removeRepo 一并摘掉(与仓库分配同律)。
-- role 是仓库职责(CONTEXT.md 仓库职责,issue #341):它说的是这个仓库在这个产品里干什么,
-- 因此挂在归属关系上而不是仓库上,摘出时跟着归属行一起消失。空着即没有职责。
CREATE TABLE IF NOT EXISTS product_repo (
  repo_id INTEGER PRIMARY KEY REFERENCES repo(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  added_at TEXT NOT NULL,
  role TEXT
);
CREATE INDEX IF NOT EXISTS product_repo_by_product ON product_repo(product_id);

-- 产品知识(CONTEXT.md 产品知识、术语条目、仓库关系、产品决策,ADR 0032 与 0035,issue #360)。
-- 三种条目一张表:一行一条,kind 说它是术语条目、仓库关系还是产品决策。分三张表要在读的
-- 每一处 UNION 三遍,而三者的读法只有一种——整份读出来按 kind 分组。
--
-- 逐格的含义按 kind 分:
-- - name:术语的名称、决策的标题;仓库关系没有名字,落空串。
-- - body:术语的定义、关系的那一句陈述、决策的「背景、决定、为什么」。
-- - topic:术语的主题分组,可空;另两种不用。
-- - avoided:术语要避免的同义词,JSON 数组;另两种是空数组。
-- - options / consequences:决策的备选项与后果,可空;另两种不用。
-- - superseded_by:被哪条决策取代(CONTEXT.md 产品决策的状态),空即生效。
-- - annotations:出处附注,一段 { location, reason } 的 JSON 数组。只在产品页展示,不进提示。
--
-- 条目由会话写下即生效,没有提案态,撤回即删行:人的回答就是裁决,不再有第二个队列
-- (ADR 0035)。写下它的那个会话记在 written_by_session_id 上,产品页据它说得出出处。
CREATE TABLE IF NOT EXISTS product_knowledge_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES product(id),
  kind TEXT NOT NULL CHECK (kind IN ('term', 'relationship', 'decision')),
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  topic TEXT,
  avoided TEXT NOT NULL,
  options TEXT,
  consequences TEXT,
  superseded_by INTEGER REFERENCES product_knowledge_entry(id),
  annotations TEXT NOT NULL,
  written_at TEXT NOT NULL,
  written_by_session_id INTEGER
);
CREATE INDEX IF NOT EXISTS product_knowledge_entry_by_product
  ON product_knowledge_entry(product_id, kind);
-- 一个产品内一个名字只有一条:术语与决策都按名字读整条(query_knowledge),两条同名的
-- 读出来就不知道是哪一条。仓库关系没有名字(空串),因此排除在这道唯一性之外。
CREATE UNIQUE INDEX IF NOT EXISTS product_knowledge_entry_by_name
  ON product_knowledge_entry(product_id, kind, name) WHERE name <> '';

-- Agent 会话(CONTEXT.md Agent 会话,issue #332)。挂在产品上,创建者是唯一能续谈与
-- 删除它的人;用途建时定、之后不变(没有改用途的写入口)。用量五列与 review_run 同口径,
-- 按条目累加在常驻子进程那一票接入,在那之前每一行都是 0,所以不可空。删产品级联硬删
-- 它下面的会话行。
CREATE TABLE IF NOT EXISTS agent_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES product(id),
  created_by TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  -- 这个会话每个仓库开在哪个 commit(issue #351):AgentSessionBaseline 那一串的 JSON,建会话
  -- 那一刻写下来(issue #352)。可空,NULL 即这一票之前建的会话——读作空列表,面板什么都
  -- 不显示。
  baselines TEXT,
  -- 产品梳理谈完的时刻(CONTEXT.md 产品梳理,issue #365)。agent 宣告共识时调完成工具写下,
  -- 之后这一场仍读得到、续得了。可空,NULL 即还没谈完;别的用途恒为 NULL。
  completed_at TEXT
);
-- 列表只有一种查法:一个产品下某个人的会话(系统管理员读同一个产品下的全部)。
CREATE INDEX IF NOT EXISTS agent_session_by_product ON agent_session(product_id, created_by);

-- 会话记录(ADR 0031,issue #333)。一行一条 Pi 的 SessionEntry 原样 JSON:条目形状跟着
-- Pi 走,本项目不另造一套消息表——转换层最容易丢 parentId 与 compaction 引用,而丢了 Pi
-- 不报错,只是悄悄少一段历史。type / at 与四列用量是索引列,从那份 JSON 里抄出来:
-- 面板按类型渲染、统计按用量累加,都不必每行解一次 JSON。
-- seq 在一个会话之内自增,SSE 的帧 id 就是它,续传的 after 按它算。
CREATE TABLE IF NOT EXISTS agent_session_entry (
  session_id INTEGER NOT NULL REFERENCES agent_session(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  entry TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
);

-- 发过的客户端消息 id(issue #333)。主键挡住重入队:同一个 id 重发时插入不成立,接口
-- 回的是第一次的受理结果。一个会话里一条消息一行,人点两次发送因此只跑一次。
CREATE TABLE IF NOT EXISTS agent_session_message (
  session_id INTEGER NOT NULL REFERENCES agent_session(id),
  client_message_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (session_id, client_message_id)
);

-- 会话图片(spec #329,issue #336)。一行一张已经落盘的图:文件在 data 目录下的
-- agent-sessions/<会话 id>/<图片 id>.<扩展名>,库里只存路径与 mimeType(base64 一律不进
-- 库,会话记录里的图片块也只存文件引用)。发消息时按 id 认领这几张图,因此主键是两列。
-- 删会话与删产品一并删掉这些行,文件目录由 handler 那一侧删。
CREATE TABLE IF NOT EXISTS agent_session_image (
  session_id INTEGER NOT NULL REFERENCES agent_session(id),
  image_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, image_id)
);

-- 还没投递出去的排队消息(issue #335)。排队的真身在 Pi 那边、镜像在运行时的登记表上,
-- 两处都随进程走;而排空与空闲回收要把子进程收掉,那几条没投出去的消息只能落库,等下次
-- 惰性重建时一并投递。一行一条,seq 即人当初写下它们的顺序;投递出去就整段删掉——「排着」
-- 的定义就是「还没投出去」,留着就会重复投。
CREATE TABLE IF NOT EXISTS agent_session_pending_message (
  session_id INTEGER NOT NULL REFERENCES agent_session(id),
  seq INTEGER NOT NULL,
  mode TEXT NOT NULL,
  text TEXT NOT NULL,
  -- 这一条带的那几张图的文件引用,原样一段 JSON(issue #336)。没带图即 NULL。
  images TEXT,
  PRIMARY KEY (session_id, seq)
);

-- 产品 tracker 的一条 spec(CONTEXT.md spec,issue #361)。挂在产品上,正文只由会话经工具写,
-- session_id 记下是哪一场写的(与产品知识的 proposed_session_id 同律,不设外键:删会话
-- 不该把它写下的 spec 一并带走)。
CREATE TABLE IF NOT EXISTS product_spec (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES product(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  session_id INTEGER,
  created_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_spec_by_product ON product_spec(product_id);

-- 一张票(CONTEXT.md 票,issue #361)。挂在 spec 上,产品经 spec 推出来——票不另存一格
-- product_id:两处存同一件事就能不一致,而「阻塞边只在同一产品的票之间」正是照 spec 那一格判的。
-- 五个 triage 标签是固定字段值(ADR 0035),由 CHECK 表达而不是另开一张配置表。
-- 认领人由人在产品页写(CONTEXT.md 认领,issue #363),会话不碰它。
CREATE TABLE IF NOT EXISTS product_ticket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id INTEGER NOT NULL REFERENCES product_spec(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  label TEXT NOT NULL CHECK (
    label IN ('needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix')
  ),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  claimed_by TEXT,
  session_id INTEGER,
  created_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_ticket_by_spec ON product_ticket(spec_id);

-- 阻塞边:ticket_id 这张票被 blocked_by_id 那张票挡着。自指由 CHECK 挡下——一条边只
-- 可能来自写入口,而写入口要说出打回的理由,两处因此各判一次:这里是兜底,理由在那边。
-- 跨产品的边由写入口判(两张票的产品都要经 spec 查出来,库里表达不了)。
CREATE TABLE IF NOT EXISTS product_ticket_block (
  ticket_id INTEGER NOT NULL REFERENCES product_ticket(id),
  blocked_by_id INTEGER NOT NULL REFERENCES product_ticket(id),
  PRIMARY KEY (ticket_id, blocked_by_id),
  CHECK (ticket_id <> blocked_by_id)
);

-- 票上的一条评论(CONTEXT.md 票,issue #361)。作者两格与产品知识的提案来源同律:人写的
-- 那一条是用户名,会话写的那一条是 session_id,两格恰有一格不空。
CREATE TABLE IF NOT EXISTS product_ticket_comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES product_ticket(id),
  author TEXT,
  session_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_ticket_comment_by_ticket
  ON product_ticket_comment(ticket_id);
`;



/**
 * 模型服务的当前态。只保留当前版本；运行中的 Review Run 在内存里持有旧版本，不为它建
 * 历史表。
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
  -- 这一版绑定的调用目标集合(ADR 0027,issue #261):JSON 数组,每项
  -- {api, baseUrl, fingerprint},去重并稳定排序。自定义服务是 NULL(目标在 base_url /
  -- api 两列上);升级前的内置版本也是 NULL,读回即「旧版本」,只有经指纹证明的那一个
  -- 目标可以延续,证明不了就待重新验证。
  targets_json TEXT,
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
  context_window INTEGER,
  max_tokens INTEGER,
  field_sources_json TEXT,
  thinking_level_map_json TEXT,
  compat_json TEXT,
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

/** 最低报告等级的系统默认住在 `finding.ts`,这里转出:既有的引用方不必改到那边去。 */
export { DEFAULT_MIN_REPORT_SEVERITY };







/** Review Run 开始时即已知的元数据。 */
export type RunMeta = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /**
   * 开跑时那个 pull request 的标题;省略或 null 即不记(范围审查那一档,它的名字
   * 来自范围审查自身)。
   */
  title?: string | null;
  /** 手动重跑的调用者用户名快照;省略或 null 即投递触发。 */
  triggeredBy?: string | null;
  /** 这一轮是被谁开出来的(issue #312);省略即投递,与升级前的旧行同一读法。 */
  triggerSource?: ReviewTriggerSource;
  /** 这一轮归属的范围审查;省略或 null 即 PR 触发(ADR 0012)。 */
  rangeReviewId?: number | null;
  startedAt: string;
  /** 预估规模:本次 Review Range 覆盖的文件数。 */
  changedFiles: number;
  /** 预估规模:本次 Review Range 的增删行数。 */
  changedLines: number;
  /** 预估规模:本次 Review Range 被切成几批。规模在阈值内时为 1。 */
  batchCount: number;
  /**
   * 开跑时冻结的完整批次计划(issue #253):每一批的文件清单,按批次序号排。续跑核对
   * 重新切批的每一批都与它相符。省略即不落计划,那一轮不可续跑。
   */
  batches?: readonly (readonly string[])[];
  /** 本轮固定的非秘密模型服务审计快照；没有 Reviewer 时显式传空数组。 */
  reviewerPins: readonly ReviewRunReviewerPin[];
  /**
   * 本轮冻结的知识集版本(CONTEXT.md 知识集版本,issue #204)。省略或 null 即这一轮
   * 没有规则注入,回看历史轮次时也就知道当时没有规则可依。
   */
  ruleSetVersion?: number | null;
  /**
   * 本轮指令(CONTEXT.md,issue #225)。发起重审时评审方附的一次性要求;省略或 null 即
   * 这一轮没有指令。只落在这一行上,下一轮不继承——它就是「只作用于那一轮」的落点。
   */
  directive?: string | null;
  /**
   * 这一轮的模式(CONTEXT.md 只复核,issue #242)。省略即完整审查,与升级前的旧行同一
   * 读法。轮次列表与轮次详情据它回答「这一轮为什么只有复核」。
   */
  mode?: ReviewRunMode;
  /**
   * 开跑时读到的历史 Finding 快照(issue #248)。续跑的批次读它而不是重读当前历史,
   * 各批拿到的因此始终是同一份。省略即不落快照,那一轮不可续跑。
   */
  history?: readonly HistoryFinding[];
  /**
   * 开跑时生效的最低报告等级(CONTEXT.md,issue #271)。省略即默认 P2,与升级前的旧行
   * 同一读法。轮次要答得出「那一轮按什么阈值跑的」,续跑据它核对阈值有没有改过。
   */
  minReportSeverity?: Severity;
  /**
   * 开跑时解析出的辅助模型(CONTEXT.md 辅助模型,issue #304)。这一轮的合并 agent 用
   * 它,续跑沿用落库的这一处;省略或 null 即这一轮没有解析出辅助模型,合并走算法档。
   * **它不是续跑判据**:改了它只影响下一轮,已开跑的这一轮读的始终是这一行。
   */
  auxiliaryModel?: ReviewerSpec | null;
};

/** 一条被启动改判掉的 Review Run(issue #247)。坐标够撤掉那个 PR 上的 👀。 */
export type InterruptedRun = {
  runId: number;
  owner: string;
  repo: string;
  pullNumber: number;
};

/**
 * 一条停在运行中的 Review Run,带够续跑要的那些冻结事实(issue #248)。head 与模式
 * 决定重新切批切出什么,范围审查标识决定读哪个阶段,本轮指令要原样再给一遍。
 */
export type InterruptedRunDetail = InterruptedRun & {
  headSha: string;
  rangeReviewId: number | null;
  directive: string | null;
  mode: ReviewRunMode;
  triggeredBy: string | null;
  /**
   * 开跑时冻结的辅助模型(issue #304)。续跑的合并 agent 按它建,不重新解析——中断期间
   * 有人改了配置时,续跑的合并用的仍要是这一轮开跑时那一处。旧行与解析不出的那一轮是
   * null,续跑的合并因此走算法档。
   */
  auxiliaryModel: ReviewerSpec | null;
};

/**
 * 续跑一轮要的全部已落库状态(issue #248)。一次读取取齐:批数用来核对重新切批的结果,
 * 历史快照给续跑的批次,已落库的那些(批次, 模型)不再重跑。
 */
export type ResumeState = {
  /** 开跑时审的那个 head。续跑必须审同一个,PR 上推了新 commit 就不再是同一轮。 */
  headSha: string;
  /** 开跑时冻结的知识集版本(issue #204)。续跑要注入同一版,否则各批依的规则会分叉。 */
  ruleSetVersion: number | null;
  /**
   * 开跑时生效的最低报告等级(issue #271)。续跑核对它:阈值改过就说明后跑的批次会按
   * 另一条口径报,与原轮各批对不上。升级前的旧行读回默认 P2。
   */
  minReportSeverity: Severity;
  batchCount: number;
  /**
   * 开跑时冻结的完整批次计划(issue #253),按批次序号排。续跑核对重新切批的每一批都
   * 与它相符——已落库的与还没跑的都在内。升级前落的旧行没有,为 undefined。
   */
  plan: string[][] | undefined;
  /**
   * 开跑时钉下的 Reviewer 身份,按 `position` 升序(issue #248 的评审复核)。零批次落库
   * 时它是核对模型组合的唯一依据——那种轮次没有已落库的批次可比。没有钉下 pin 的轮次
   * (升级前的旧行、一个模型都没配的那一轮)读回空数组,那时无从比对。
   */
  reviewers: string[];
  /** 开跑时的历史快照;升级前落的旧行没有,为 undefined。 */
  history: HistoryFinding[] | undefined;
  /**
   * 已经有结果的那些(批次, 模型),外层键是从 0 起的批次下标、内层键是模型标识
   * (issue #410)。一批里只有几个模型落了库是常态:恢复单位是一次完整的 Reviewer 会话。
   */
  batches: Map<number, Map<string, TimedOutcome>>;
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

/**
 * 来源类型、行作者与读回来的归属这三样同时是阶段汇总的契约字段,因此住在
 * `src/contracts/finding.ts` 里、从这里再导出(issue #429)。面板引得动契约,引不动本
 * 模块——那会把库层的运行时依赖拖进前端的类型检查。服务端的调用点照旧引 `store/index.ts`。
 */
import type {
  FindingPlacement,
  RecordedFindingAttribution,
  RecordedLineAuthor,
} from "../../contracts/finding.ts";

export type { FindingPlacement, RecordedFindingAttribution, RecordedLineAuthor };

/** 一条 Finding 的一个归属:报出它的那个模型自己的说法(ADR 0015)。 */
export type FindingAttributionRecord = {
  model: string;
  severity: Severity;
  category: Category;
  description: string;
  /** 这个模型自己给的影响与建议(issue #266)。模型没给即空串,照样落库。 */
  impact: string;
  suggestion: string;
};

/**
 * 落库的一段延续承接来的历史说法(issue #267),与 `CarriedAttribution` 同一形状去掉
 * `headSha`——那是所属轮次的事实,读回时按 `runId` 取。
 */
export type CarriedAttributionRecord = Omit<CarriedAttribution, "headSha">;

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
  /** 代表段:描述最长的那条归属的表述(issue #278)。逐模型的表述在 `attributions` 里。 */
  description: string;
  /** 代表段的影响与建议:与 `title` / `description` 同出一条归属。模型没给即空串。 */
  impact: string;
  suggestion: string;
  /** 报出它的每个模型一条,按首报先后。至少一条。 */
  attributions: readonly FindingAttributionRecord[];
  /** 延续承接来的历史说法(issue #267),只有按复核结论合成的延续才带。 */
  carried?: readonly CarriedAttributionRecord[];
  fingerprint?: string;
  groupIndex: number;
  /** 本轮读回的处置结论。 */
  disposition: Disposition;
  placement: FindingPlacement;
  /** 承载它的 Forge 评论 id。本轮新发的评论要等发布之后才知道,那时走 `recordFindingComments`。 */
  commentId?: string;
  /** 那条评论在 Forge 页面上的地址。 */
  commentHtmlUrl?: string;
  /** 行作者(CONTEXT.md),按本轮 head 判定;判不出来时不给,几列留 NULL。 */
  lineAuthor?: RecordedLineAuthor;
  /**
   * 模型自报、已经过校验的命中规则(issue #204)。只落库:本期不展示、不进指纹,
   * 也不参与 Finding Identity 与合并去重。
   */
  ruleId?: number;
};

/** 一个合并组落成的那条 Forge 行级评论。发布之后才拿得到,因此与落库分成两步。 */
export type FindingCommentRef = {
  groupIndex: number;
  commentId: string;
  commentHtmlUrl: string;
};

/**
 * 回填的一条更新:PR 里这条 Finding Identity 的历史 finding 照它改写。行级评论承载的带
 * disposition;正文锚点没有 resolve 状态可读,只带来源类型(顺手纠正升级前被默认值
 * 标成 inline 的历史 fallback 行)。
 *
 * `commentId` 是这一条读自哪条 Forge 评论(issue #307):同一「文件 + 指纹」上可以有两条
 * Identity,各带各的评论,一条评论的 resolve 状态只能写到它自己承载的那些行上。正文锚点
 * 那一档没有评论,只落在同一处没有评论载体的行上。
 */
export type DispositionUpdate = {
  file: string;
  fingerprint: string;
  commentId?: string;
  disposition?: Disposition;
  placement: FindingPlacement;
};

/**
 * 复核判已修、且还能自动处置的一行(ADR 0016)。`findingId` 是这一行自己的落库 id,不是
 * 注入 Reviewer 时给的那个代表条 id:一条 Finding Identity 在库里可能有好几行、各带自己
 * 的行级评论(issue #275),候选按行展开,一行一条评论;`commentId` 是承载它的那条 Forge
 * 评论——自动处置写回 Forge 的仍是同一个 resolve,载体与人工处置是同一条。
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
 *
 * `carried` 是合成延续时要带到新位置的历史说法(issue #267):这一行自己每个归属的问题、
 * 影响与建议(出处即那个模型与这一行所在的轮次),加上这一行自己承接来的那些(出处原样
 * 沿用,不层层嵌套)。两段都是空串的归属没有内容可带,不占一段;NULL 的照实带着,恢复
 * 操作据此认出缺失。升级前没有归属行的,列表为空。
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
  carried: CarriedAttribution[];
};

/**
 * 合并 agent 命中的那条历史 Finding 在库里的位置与载体(issue #240)。与
 * `ContinuationCandidate` 是同一批列,差别只在两处:不筛处置状态,并把处置状态带出来。
 *
 * 两处差别都是本票要的:命中已处置的旧条要折叠后沉默,因此不能在这里就把它筛掉;
 * 折叠到已处置还是未处置,本轮那条落库的处置值不同,因此要知道它此刻是哪一档。
 * 没有指纹、没有评论载体或链接的行仍不在里面——那样的行既判不了代码有没有改写,也
 * 没有可折叠上去的评论。
 */
export type HistoryPlacement = ContinuationCandidate & { disposition: Disposition };

/**
 * 一条要在这一轮重新定位的 Finding(issue #368)。
 *
 * `line` 是它此刻的位置(`placed_line ?? line`),不是它被报出来时的那一行:重定位一轮
 * 接一轮地接力,拿报出位置去找最近的那一处会在代码连着挪几轮之后挑错地方。
 */
export type RelocationCandidate = {
  findingId: number;
  file: string;
  line: number;
  fingerprint: string;
};

/** 一条 Finding 在这一轮 head 上解析到的新位置(issue #368)。 */
export type FindingRelocation = { findingId: number; line: number };

/**
 * 面板处置一条 Finding 要用的那几项。处置写在承载它的那条 Forge 评论上,因此这里
 * 带上评论 id 与它所属仓库;`commentId` 为 null 即 fallback,没有可处置的载体。
 *
 * 位置、标题、描述与本轮 head commit 是处置反哺的输入(issue #208):带备注的处置要把
 * 这条 Finding 的上下文交给 agent,工作副本也停在它报出时的那个 commit 上。
 */
export type FindingDispositionTarget = {
  id: number;
  owner: string;
  repo: string;
  commentId: string | null;
  disposition: Disposition;
  note: string | null;
  file: string;
  line: number;
  /** 合并后的标题。升级前落库的历史行为 null。 */
  title: string | null;
  description: string;
  /** 报出这条 Finding 的那一轮 Review Run 的 head commit。 */
  headSha: string;
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
 * 一条结论为什么没给出来(issue #412、#413):这个模型跑了那一批却没给、那一批根本没跑成,
 * 或者本轮没有哪一批读到它那个文件。只有第一种说的是模型有没有认真复核。
 */
export type MissingVerdictReason = "no-verdict" | "batch-failed" | "no-batch";

/**
 * 一个 Reviewer 对一条历史 Finding 的复核结论(ADR 0016)。`findingId` 是注入时该
 * Finding Identity 的最新一行。`missing` 给了就是这个模型没给这条结论,按「无法判断」
 * 落库,值说明是哪一种由来;缺省即它给了结论。
 */
export type VerdictRecord = {
  model: string;
  findingId: number;
  verdict: ReviewVerdict;
  missing?: MissingVerdictReason;
};

export type RunResult = {
  finishedAt: string;
  durationMs: number;
  failed: boolean;
  outcomes: readonly OutcomeRecord[];
  findings: readonly FindingRecord[];
  /** 本轮各 Reviewer 的复核结论。缺省即这一轮没有历史可复核。 */
  verdicts?: readonly VerdictRecord[];
  /**
   * 合并 agent 这一轮的用量(issue #228)。只进 `review_run` 的总量,不落 `reviewer_outcome`
   * ——它不是 Reviewer,记成一行会让按模型的统计多出一个不存在的模型。缺省即这一轮没派
   * 合并 agent,或它连会话都没建起来。
   */
  mergeUsage?: ReviewerUsage;
  /**
   * 本轮的同根因组(ADR 0030,issue #308)。缺省即这一轮没有组——合并 agent 缺席、
   * 没提,或提的都没过验收。
   */
  rootCauses?: readonly RootCauseGroupRecord[];
};

/**
 * 一个待落库的同根因组:根因说明与按组内次序排好的成员。
 *
 * 成员是本轮第几个合并组(评审复核 2026-09-09):每个成员都有本轮自己落的那一行,折叠到
 * 历史的那一条也不例外,那一行与被折叠到的历史在 `identityKey` 下是同一条 Finding
 * Identity。行在收尾插进去之前没有 id,因此用合并组下标说,由这一笔事务换成 id。
 */
export type RootCauseGroupRecord = {
  reason: string;
  members: readonly number[];
};

/** 一轮里落库的一个同根因组(issue #308):组 id、根因说明与成员的 Finding 行 id。 */
export type RootCauseGroup = {
  id: number;
  reason: string;
  findingIds: number[];
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
  /** 自定义服务的目标;内置服务的目标在 `targets` 上,这两列为空。 */
  baseUrl: string | null;
  api: string | null;
  /** 自定义服务是单目标指纹;内置服务是 `targets` 集合的指纹,旧版本是当初首项模型的单目标指纹。 */
  targetFingerprint: string | null;
  /**
   * 内置服务这一版绑定的调用目标集合(ADR 0027)。自定义服务与升级前的内置版本是 null:
   * 后者只能按 `targetFingerprint` 证明当初绑的是哪一个目标。
   */
  targets: ModelServiceBoundTarget[] | null;
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
  /** 本轮冻结的另外两项分批上限(issue #230)。null 即取编排层的默认值。 */
  maxParallelBatches: number | null;
  maxFilesPerBatch: number | null;
  /** 本轮冻结的每批每模型取证上限(issue #258)。null 即取 Reviewer 的系统默认。 */
  maxEvidenceCallsPerBatch: number | null;
  modelServices: readonly ModelServiceRecord[];
  /**
   * 本轮要冻结的知识集版本(issue #204)。仓库还没确认过知识集时为 null。与模型服务
   * 版本同律:这份快照一取出来就固定,之后的规则变更追不上已经开跑的这一轮。
   */
  ruleSetVersion: number | null;
  /** 那一版的生效评审规则全体。按批次路由前的全集,空知识集给空数组。 */
  rules: readonly ReviewRule[];
  /** 那一版的生效项目事实全体(issue #221)。与规则同一版本、同一路由,注入时另起一段。 */
  facts: readonly ProjectFact[];
}>;

export type ModelReferenceLocation =
  | { kind: "global" }
  | { kind: "following-global"; repositoryCount: number }
  | { kind: "repository-override"; repoId: number; owner: string; repo: string }
  // 辅助模型那两处与模型组合同等(ADR 0029,issue #303):被它引用的模型一样删不掉、
  // 切不走,唯一来源的补录一样摘不掉。
  | { kind: "global-auxiliary" }
  | { kind: "repository-auxiliary"; repoId: number; owner: string; repo: string };

export type ModelReference = {
  identity: string;
  provider: string;
  model: string;
  locations: ModelReferenceLocation[];
};

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
export type ModelServiceVersionCommit = Omit<
  ModelServiceRecord,
  "version" | "automaticModels" | "supplements" | "targets"
> & {
  automaticModels: readonly DiscoveredModel[];
  supplements: readonly Omit<ModelSupplementRecord, "provider">[];
  /**
   * 内置服务这一版要绑定的调用目标(ADR 0027);库负责去重、排序并算每项指纹。给了集合时
   * `targetFingerprint` 必须是这个集合的指纹。省略或 null 即不记集合:自定义服务一律如此,
   * 内置服务这样写出来的是旧格式版本。
   */
  targets?: readonly { api: string; baseUrl: string }[] | null;
};

/**
 * 审查策略里可写的那几项。每一项都可能没配:空库刚起来时就是这个样子,面板把它们配
 * 起来。整页一次全量替换(issue #301),因此没有逐项版本。
 */
export type GlobalSettingsValues = {
  /** 全局模型组合的 JSON(ReviewerSpec 数组),null 即还没配。 */
  reviewersJson: string | null;
  /**
   * 辅助模型的 JSON(一处 ReviewerSpec),null 即没设(issue #303)。Reviewer 之外的
   * agent 工作用它;没设即退回这个仓库生效模型组合的第一个。
   */
  auxiliaryModelJson: string | null;
  /** 一批最多多少改动行,null 即取编排层的默认值。 */
  maxChangedLinesPerBatch: number | null;
  /** 同时在跑的批次数上限,null 即取编排层的默认值(issue #230)。 */
  maxParallelBatches: number | null;
  /** 一批最多多少个文件,null 即取编排层的默认值(issue #230)。 */
  maxFilesPerBatch: number | null;
  /** 每批每模型的取证次数上限,null 即取 Reviewer 的系统默认(issue #258)。 */
  maxEvidenceCallsPerBatch: number | null;
  /** 最低报告等级,null 即取系统默认 P2(全报,issue #271)。 */
  minReportSeverity: Severity | null;
};

/** 审查策略读回来的整份对象:各项设置值加整页共用的那一个版本号(issue #301)。 */
export type GlobalSettings = GlobalSettingsValues & {
  /** 整页版本号,缺行即 1。写成功推一版。 */
  version: number;
};

/**
 * 注册表里的一个仓库。`reviewersJson` 是模型覆盖的 JSON,`auxiliaryModelJson` 是辅助模型
 * 覆盖的 JSON(issue #303),`minReportSeverity` 是最低报告等级的覆盖(issue #273),三者
 * 都是 null 即跟随全局;`defaultBranch` 是这个仓库的默认分支(issue #350),null 即跟随
 * Gitea 的默认分支。`settingsVersion` 是这四项的整块版本号(issue #302),每经
 * `putRepoSettings` 写一次加一。
 */
export type RepoRecord = {
  repoId: number;
  owner: string;
  repo: string;
  reviewersJson: string | null;
  auxiliaryModelJson: string | null;
  minReportSeverity: Severity | null;
  defaultBranch: string | null;
  settingsVersion: number;
};

/**
 * 这个仓库生效的辅助模型与它的来源(CONTEXT.md 辅助模型,ADR 0029)。来源三档:仓库自己
 * 的覆盖、审查策略里的那一处、生效模型组合的第一个。选不出即 null。
 */
export type ResolvedAuxiliaryModel = {
  spec: ReviewerSpec;
  source: "repo" | "global" | "first-reviewer";
};

/**
 * 整块写仓库配置的结果(issue #302)。`stale` 是期望版本对不上,`unavailable` 是同一事务
 * 里看到的模型服务已经跑不了这组覆盖,`missing` 是这一行不在了——三种都一项不写。
 */
export type RepoSettingsWrite =
  | { ok: true; version: number }
  | { ok: false; reason: "stale" | "unavailable" | "missing" };

/**
 * 工作副本的准备状态(issue #184)。`unknown` 是升级前注册的仓库与从没备过副本的那些
 * 行:副本可能在也可能不在,面板据此提供准备入口。
 */
export type WorktreeState = "unknown" | "preparing" | "ready" | "failed";

/** 工作副本的准备结果。`failure` 只在 `failed` 时有值,`checkedAt` 是这个结果的时刻。 */
export type WorktreeStatus = {
  state: WorktreeState;
  failure: string | null;
  checkedAt: string | null;
};

/** 仓库列表行:注册信息加累计量。 */
export type RepoSummary = {
  repoId: number;
  owner: string;
  repo: string;
  /** 模型覆盖的 JSON,null 即跟随全局。面板的仓库详情要显示与编辑它。 */
  reviewersJson: string | null;
  /** 辅助模型覆盖的 JSON(issue #303),null 即跟随全局。 */
  auxiliaryModelJson: string | null;
  /** 最低报告等级的覆盖(issue #273),null 即跟随全局。 */
  minReportSeverity: Severity | null;
  /** 这个仓库的默认分支(CONTEXT.md 默认分支,issue #350),null 即跟随 Gitea 的默认分支。 */
  defaultBranch: string | null;
  /** 这四项配置的整块版本号(issue #302、#303、#350)。面板保存时原样回传作期望版本。 */
  settingsVersion: number;
  /** 累计 Review Run 数。按注册时的 owner/repo 匹配评审记录。 */
  runCount: number;
  /** 累计 Finding 数(落库行数,同一处的多个模型只算一条)。 */
  findingCount: number;
  /** 最近一次 Review Run 的开始时间,没跑过为 null。 */
  lastActivity: string | null;
  /** 工作副本的准备状态(issue #184)。 */
  worktree: WorktreeStatus;
};

/** 知识集里的一条知识条目(CONTEXT.md)。`scope` 空串即全仓库。 */
export type ReviewRuleRecord = {
  id: number;
  type: KnowledgeType;
  scope: string;
  statement: string;
  /**
   * 出处。这一票只有读。写这一列的是落条目的那两条路径:知识确认时草案条目带着自己那一列
   * 成为条目(基点探索留 `baseline-exploration`、意图补进草案的留 `manual-proposal`),裁决
   * 采纳时新增与合并取提案第一条附注的来源、修改沿用被改那一行的。存量的 `manual` 只在
   * 库里留着——撤直改之后没有端点再产生这一类行(issue #299)。
   */
  origin: string;
};

/**
 * 知识集里的一条 → 交给规则 agent 的那一份(issue #222)。比注入那两份多一个 `type`:
 * agent 提的是对照现有知识集的变更,分不清哪条是哪型就分不清「改一条规则」与「废止一条
 * 过期事实」。
 */
export function toKnowledgeEntry(entry: ReviewRuleRecord): KnowledgeEntry {
  return { id: entry.id, type: entry.type, scope: entry.scope, statement: entry.statement };
}

/**
 * 队列里的一条 → 交给反哺 agent 的那一份(issue #283)。只给它认出「这是不是队列里已有
 * 的一件事」要的那几样:标识、变更类型、目标与陈述。出处附注不给——agent 判的是这条
 * 提案说的是什么,不是它被谁提过。
 */
export function toPendingProposal(proposal: RuleProposal): PendingProposal {
  return {
    id: proposal.id,
    change: proposal.change,
    targetRuleIds: proposal.targetRuleIds,
    statement: proposal.statement,
  };
}

/**
 * 一个仓库当前生效的知识集与它的知识集版本(CONTEXT.md)。`version` 为 null 即这个
 * 仓库还没确认过知识集;已确认的空知识集是版本有值、规则为空。
 *
 * `retired` 是这个仓库废止过的规则,按废止的先后给:废止的规则不再生效,但仍要查得到
 * (issue #203)。修改一条规则同样在这里留下改之前那一版——两态生命周期里,内容被换掉
 * 的那一行确实是在那一版上停止生效的。
 */
export type RuleSet = {
  version: number | null;
  rules: ReviewRuleRecord[];
  retired: ReviewRuleRecord[];
};

/**
 * 一条知识条目里由人填的那几样:两型之一、作用范围(空串即全仓库)与那一句陈述。
 */
export type ReviewRuleInput = {
  type: KnowledgeType;
  scope: string;
  statement: string;
};

/**
 * 一个仓库最近一次基点探索(CONTEXT.md,issue #205)。每仓库至多一次,重新探索覆盖它。
 * `model` 是那次所用的模型标识,知识确认之后仍留着——处置反哺沿用它(issue #208)。
 * `thinkingLevel` 是那次选的思考档位,null 即没选(等同 off),反哺一并沿用(issue #213)。
 * `traceTaskId` 是那一次的知识轨迹,轨迹起头落库失败与升级前跑过的那些都是 null。
 */
export type RuleExploration = {
  state: "running" | "failed" | "completed";
  baselineSha: string;
  model: string;
  thinkingLevel: ThinkingLevel | null;
  traceTaskId: number | null;
  /** 失败原因,只有 `failed` 那一档有值。人据此知道发生了什么,并可重试。 */
  failure: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/**
 * 一个仓库最近一次知识整理(CONTEXT.md 知识整理,issue #284)。每仓库至多一次,重新
 * 整理覆盖它。三态与失败原因和基点探索同形;`merged` / `retargeted` / `proposed` 是完成
 * 后的摘要——合并掉的提案条数、改写成修改型的条数与对现集提出的提案条数(issue #285),
 * 没跑完即 null。
 */
export type RuleConsolidation = {
  state: "running" | "failed" | "completed";
  model: string;
  thinkingLevel: ThinkingLevel | null;
  traceTaskId: number | null;
  failure: string | null;
  merged: number | null;
  retargeted: number | null;
  proposed: number | null;
  startedAt: string;
  finishedAt: string | null;
};

/** 知识草案里的一条(CONTEXT.md)。`origin` 与生效规则同一套字面量。 */
export type RuleDraftItem = ReviewRuleInput & {
  id: number;
  origin: string;
};

/**
 * 一条出处附注的来源(CONTEXT.md 出处附注)。四元:基点探索、处置反哺、知识整理与
 * 人工提议(ADR 0028,issue #294)。四条链路要用同一套词,字面量因此只有这一份。
 */
export type RuleProposalOrigin =
  | "baseline-exploration"
  | "disposition-feedback"
  | "knowledge-consolidation"
  | "manual-proposal";

/**
 * 一次知识轨迹的来源(CONTEXT.md 知识轨迹)。四元,与出处附注的来源同一套词:基点探索、
 * 处置反哺、知识整理(issue #284)与人工提议(issue #294)。
 */
export type RuleTraceSource = RuleProposalOrigin;

/**
 * 一条修订意图指向什么(CONTEXT.md 修订意图,ADR 0028)。`none` 即无目标,产的是新增;
 * 其余四档各指向一条知识条目、修订提案、草案条目或 Finding。
 */
export type RuleIntentTargetKind = "none" | "rule" | "proposal" | "draft" | "finding";

/**
 * 一条修订意图(CONTEXT.md 修订意图,issue #294)。与探索、整理两行同形地记状态、模型、
 * 轨迹与失败原因,只是每仓库多行:`produced` 是这一次产出的提案与草案条目标识,
 * `summary` 是 agent 的那一句收尾,两者都要跑完才有。
 */
export type RuleIntent = {
  id: number;
  text: string;
  submittedBy: string;
  targetKind: RuleIntentTargetKind;
  targetId: number | null;
  /**
   * 目标 Finding 所在的阶段标识(issue #296)。只有目标为 Finding 的那一档有值,面板据此
   * 开既有的 `?finding=` 侧滑;那条 Finding 的轮次已经不在时同样为 null。
   */
  targetStageId: string | null;
  state: "running" | "failed" | "completed";
  failure: string | null;
  summary: string | null;
  /** 这一次沿反哺规则选出的模型标识。选不出来时为 null。 */
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  traceTaskId: number | null;
  /** 产出的修订提案与草案条目标识。没跑完即两个空数组。 */
  produced: { proposalIds: number[]; draftItemIds: number[] };
  startedAt: string;
  finishedAt: string | null;
};

/** 排进队列的一条出处附注(CONTEXT.md 出处附注,issue #281)。 */
export type RuleProposalSourceInput = {
  origin: RuleProposalOrigin;
  /** 备注原文。只有处置反哺有;基点探索与知识整理没有备注原文,为 null。 */
  note: string | null;
  /**
   * agent 为这一条给出的理由与代码证据(issue #287)。四条链路的 `reason` 都落在这里,
   * agent 没给的为 null。陈述只留那一句结论,凭什么成立看这一格。
   */
  evidence: string | null;
  /** 引发这一次的那条 Finding(只有处置反哺有)。人据此回到那条 Finding 上。 */
  findingId: number | null;
  /**
   * 提出它的那一次规则 agent 任务的轨迹标识(CONTEXT.md 知识轨迹,issue #214)。人据此
   * 回溯到「这条提案是怎么推出来的」。轨迹没起来时为 null,升级前入队的旧提案同理。
   */
  traceTaskId: number | null;
};

/** 队列里的一条出处附注。 */
export type RuleProposalSource = RuleProposalSourceInput & {
  id: number;
  /**
   * 这条 Finding 所在的审查阶段标识,面板据此开它的侧滑。Finding 已经不在库里(仓库
   * 摘掉过)时为 null。
   */
  findingStageId: string | null;
  createdAt: string;
};

/** 排进队列的一条修订提案。内容三样与评审规则同形,采纳前人可以改。 */
export type RuleProposalInput = ReviewRuleInput & {
  change: RuleProposalChange;
  /**
   * 这条变更指向的现有条目(issue #282):新增没有目标,为空;修改与废止一条;合并
   * 一条以上(单目标的合并即改型,issue #289)。存成一个 JSON 数组:目标只随提案整条
   * 读写,没有一处按目标反查提案。
   */
  targetRuleIds: readonly number[];
  /**
   * 它的出处(CONTEXT.md 出处附注)。至少一条:一条提案总是由某一次任务提出来的,
   * 之后每被一次来源提到就追加一条。第一条的来源即采纳时落进知识条目的那个出处。
   */
  sources: readonly [RuleProposalSourceInput, ...RuleProposalSourceInput[]];
};

/** 队列里的一条修订提案。`state` 是裁决状态机,裁决过的仍留在队列里供查。 */
export type RuleProposal = Omit<RuleProposalInput, "sources"> & {
  id: number;
  /** 它的出处附注,按落库先后。 */
  sources: RuleProposalSource[];
  state: "pending" | "accepted" | "rejected";
  createdAt: string;
  /** 裁决时刻,待裁决时为 null。 */
  decidedAt: string | null;
};

/**
 * 一次并入带来的东西(CONTEXT.md 处置反哺,issue #283):合成后的那一句新陈述,与记下
 * 这一次来源的那条出处附注。目标不随并入改。
 *
 * `scope` 与 `type` 只有目标为这条提案的修订意图给(CONTEXT.md 人工提议,issue #295):
 * 改写换的是这一条本身,陈述、作用范围与型都可能换。两格缺席即不动,处置反哺那条并入
 * 路径因此一行未变。
 */
export type RuleProposalMerge = {
  statement: string;
  /** 换新的作用范围。缺席即保持原样。 */
  scope?: string;
  /**
   * 换新的型。缺席即保持原样;给了即按型规则落(CONTEXT.md 修订提案):新增型直接换,
   * 修改型要换型即成单目标合并(目标不变),合并型的型本来就由新陈述定。
   */
  type?: KnowledgeType;
  source: RuleProposalSourceInput;
};

/** 一个时间窗里的用量聚合:落了用量的 Review Run 数,加它们的 token 之和。 */
export type UsageStats = ReviewerUsage & { runs: number };

/**
 * 时间流与轮次详情里的一条 Review Run。逐格形状在 `contracts/runs.ts`,面板读的是同一
 * 个符号(issue #433);这里只多一格 `reviewerPins`——它的类型一路挂到 Pi 的
 * `ModelRuntime`,搬进契约会把 Pi 包拖进面板的类型检查,而面板一个读者都没有。
 */
export type RunListItem = RunProjection & {
  /** 本轮固定的模型服务版本与运行模型，不含凭据。 */
  reviewerPins: ReviewRunReviewerPin[];
};

/**
 * 一条还没判过行作者的 Finding(issue #199):四列同 NULL 的那些。
 *
 * 带上它自己那一轮的 head:行作者按所属 Review Run 的 head 判定,一个阶段里各轮的
 * head 各不相同,补录时不能拿最新那一轮的去判所有行。
 */
export type PendingLineAuthorFinding = {
  findingId: number;
  headSha: string;
  file: string;
  line: number;
};

/** 一条 Finding 补录到的行作者(issue #199)。 */
export type FindingLineAuthor = {
  findingId: number;
  lineAuthor: LineAuthor;
};

/**
 * 阶段列表、阶段详情与阶段汇总的这几个形状住在 `src/contracts/` 下(issue #426、#429):
 * 面板读的与这里投影出去的是同一个符号,漏一格两边都编译不过。从这里再导出,服务端的
 * 调用点照旧引 `store.ts`。
 */
import type {
  StageDetail,
  StageListItem,
  StageRunAlert,
  StageRunGroup,
  StageSource,
  StageStatus,
  StageTimelineEntry,
} from "../../contracts/stages.ts";
import type {
  StageRootCauseGroup,
  StageRootCauseRef,
  StageSummary,
  StageSummaryFinding,
} from "../../contracts/stage-summary.ts";

export type {
  StageDetail,
  StageListItem,
  StageRootCauseGroup,
  StageRootCauseRef,
  StageRunAlert,
  StageRunGroup,
  StageSource,
  StageStatus,
  StageSummary,
  StageSummaryFinding,
  StageTimelineEntry,
};

/** 选定比较项时用的分支或 Tag(issue #234),只用于下次打开选择器。 */
export type ComparisonSource = {
  kind: "branch" | "tag";
  name: string;
};

/**
 * 一次定时检查的结果(issue #314,CONTEXT.md 定时检查)。推进成功是 `advanced`,其余
 * 八档各说明这一次为什么没开轮次;面板按同一组取值写标签。
 *
 * `check-failed` 收的是「这一次没检查成」的其余情形:没配 Forge、容器 PR 还没建出来、
 * 模型覆盖坏了、知识集被退回未确认、本地副本算不出变更文件。把它们并进「分支不存在或
 * 取不到」会让人去查一件没发生的事。
 */
export type ScheduledCheckResult =
  | "advanced"
  | "no-new-commit"
  | "run-in-flight"
  | "nothing-to-verdict"
  | "not-descendant"
  | "branch-unknown"
  | "push-failed"
  | "draining"
  | "check-failed";

/**
 * 一个范围审查。分支名与容器 PR 序号是它在 Forge 上的全部痕迹;`lastForgeFailure`
 * 记最近一次 Forge 操作为什么没成,运维凭它分辨是权限还是分支保护。
 */
export type RangeReviewRecord = {
  id: number;
  repoId: number;
  owner: string;
  repo: string;
  /** 发起时给的标题(issue #177);升级前的旧行是 null。 */
  title: string | null;
  baseSha: string;
  comparisonSha: string;
  /** 选定当前比较项时用的分支或 Tag(issue #234);没带来源与升级前的旧行都是 null。 */
  comparisonSource: ComparisonSource | null;
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
  /** 每日增量(issue #313)开着没有。 */
  dailyIncrementEnabled: boolean;
  /** 每日增量跟的那条分支;关着时是 null。 */
  dailyIncrementBranch: string | null;
  /** 最近一次开启或改分支的时刻;关着时是 null。 */
  dailyIncrementEnabledAt: string | null;
  /** 最近一次定时检查的时刻(issue #314);一次都没检查过时是 null。 */
  scheduledCheckAt: string | null;
  /** 最近一次定时检查的结果;一次都没检查过时是 null。 */
  scheduledCheckResult: ScheduledCheckResult | null;
  /** 每天几点检查(issue #315),本地时区 `HH:mm`;默认 `00:00`。 */
  scheduledCheckTime: string;
  /** 定时检查按哪种模式推进;默认只复核。 */
  scheduledCheckMode: ReviewRunMode;
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

/** 产品里的一个仓库。带 owner/repo 是因为可见性判定按 owner/repo 走(ADR 0018)。 */
export type ProductRepoRecord = {
  repoId: number;
  owner: string;
  repo: string;
  /** 仓库职责(CONTEXT.md 仓库职责,issue #341)。没写过即 null。 */
  role: string | null;
};

/** 一个产品(CONTEXT.md 产品)与它当前的仓库集合。读与写都只经这一种形状。 */
export type ProductRecord = {
  id: number;
  name: string;
  createdAt: string;
  repos: ProductRepoRecord[];
};

/**
 * 把一个仓库归入产品的结果。`other-product` 即这个仓库已经归在别的产品下;`role-updated` 即
 * 这个仓库本来就在这个产品下,这一次只改了仓库职责——仓库集没变,因此不开产品梳理(issue #347)。
 */
export type ProductRepoAttach =
  | "attached"
  | "role-updated"
  | "missing-product"
  | "missing-repo"
  | "other-product";

/** 一条产品知识是三种条目里的哪一种(CONTEXT.md 术语条目、仓库关系、产品决策)。 */
export type ProductKnowledgeKind = "term" | "relationship" | "decision";

/** 一条出处附注:代码里的位置与一句为什么。只在产品页展示,不进任何提示(ADR 0035)。 */
export type ProductKnowledgeAnnotation = { location: string; reason: string };

/** 一条产品知识(CONTEXT.md 产品知识,ADR 0032 与 0035,issue #360)。 */
export type ProductKnowledgeEntry = {
  id: number;
  productId: number;
  kind: ProductKnowledgeKind;
  /** 术语的名称、决策的标题;仓库关系没有名字,是空串。 */
  name: string;
  /** 术语的定义、关系的那一句陈述、决策的「背景、决定、为什么」。 */
  body: string;
  /** 术语的主题分组。没分组即 null,另两种恒为 null。 */
  topic: string | null;
  /** 术语要避免的同义词。另两种恒为空数组。 */
  avoided: string[];
  /** 决策考虑过的备选项。另两种恒为 null。 */
  options: string | null;
  /** 决策的后果。另两种恒为 null。 */
  consequences: string | null;
  /** 取代这条决策的那一条。null 即这条生效(CONTEXT.md 产品决策的状态)。 */
  supersededBy: number | null;
  annotations: ProductKnowledgeAnnotation[];
  writtenAt: string;
  /** 写下它的那个 Agent 会话。 */
  writtenBySessionId: number | null;
};

/** 写一条产品知识要给的那几格。`id` 给了即改写那一条(CONTEXT.md 产品知识:写下即生效)。 */
export type ProductKnowledgeWrite = {
  productId: number;
  kind: ProductKnowledgeKind;
  name: string;
  body: string;
  topic: string | null;
  avoided: readonly string[];
  options: string | null;
  consequences: string | null;
  annotations: readonly ProductKnowledgeAnnotation[];
  at: string;
  sessionId: number | null;
  /** 改写这一条而不是新写一条。这个产品下没有这一条即回 undefined。 */
  id?: number;
  /** 这条决策取代的那一条。它随这一次写入落成「被取代」。 */
  supersedes?: number;
};

/**
 * 票的五个 triage 标签(CONTEXT.md 票,ADR 0035)。固定字段值,不按产品改名也没有配置实体;
 * 库里由 `product_ticket.label` 的 CHECK 表达同一份。
 */
export const PRODUCT_TICKET_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
] as const;

export type ProductTicketLabel = (typeof PRODUCT_TICKET_LABELS)[number];

/** spec 与票共用的状态(CONTEXT.md spec、票):开或关。 */
export type ProductTrackerState = "open" | "closed";

/** 产品 tracker 里的一条 spec(CONTEXT.md spec,issue #361)。 */
export type ProductSpecRecord = {
  id: number;
  productId: number;
  title: string;
  body: string;
  state: ProductTrackerState;
  /** 写下它的那个 Agent 会话。人没有写入口,因此常态不为空。 */
  sessionId: number | null;
  createdAt: string;
  stateChangedAt: string;
};

/** 产品 tracker 里的一张票(CONTEXT.md 票,issue #361)。 */
export type ProductTicketRecord = {
  id: number;
  specId: number;
  /** 它所属 spec 挂的产品。阻塞边只在同一产品的票之间,按它判。 */
  productId: number;
  title: string;
  body: string;
  label: ProductTicketLabel;
  state: ProductTrackerState;
  /** 认领人(CONTEXT.md 认领)。没人认领即 null;人在产品页写它(issue #363)。 */
  claimedBy: string | null;
  sessionId: number | null;
  createdAt: string;
  stateChangedAt: string;
  /** 阻塞它的那几张票,按票号升序。 */
  blockedBy: number[];
};

/** 票上的一条评论(CONTEXT.md 票,issue #361)。作者两格恰有一格不空。 */
export type ProductTicketCommentRecord = {
  id: number;
  ticketId: number;
  /** 人写的那一条是用户名;会话写的即 null。 */
  author: string | null;
  /** 会话写的那一条是它的 id;人写的即 null。 */
  sessionId: number | null;
  body: string;
  createdAt: string;
};

/**
 * 会话用途(CONTEXT.md 会话用途)。需求拆分交结构化产出,开放对话只聊与只读代码、没有产出
 * 类型,产品梳理由人从产品页开、访谈后写产品知识(issue #365);写代码类用途接入时各成一个值。
 * 建时必填、之后不变,因此没有改用途的写入口。
 */
export const AGENT_SESSION_PURPOSES = [
  "requirement-breakdown",
  "open-conversation",
  "product-survey",
] as const;

export type AgentSessionPurpose = (typeof AGENT_SESSION_PURPOSES)[number];

/**
 * Agent 会话的状态(issue #333)。「在跑」是**进程内的事实**:子进程在这个进程里,服务
 * 重启之后没有任何会话在跑。读接口因此按会话运行时的登记表覆盖这一格,库里那一列恒为
 * 空闲——存一个「在跑」下来,崩溃重启后它就永远卡在在跑上。
 */
export type AgentSessionStatus = "idle" | "running";

/**
 * 一个 Agent 会话开在哪个 commit 上,按仓库一条(issue #351)。`sha` 是那棵工作树检出的
 * commit,`branch` 是它来自哪条分支或哪个 Tag(没有显式选择即这个仓库生效的默认分支,CONTEXT.md
 * 默认分支),`kind` 说 `branch` 这个名字是分支还是 Tag(issue #355)——Tag 没有「最新」,
 * 更新基点要靠它分开两者。
 */
export type AgentSessionBaseline = {
  owner: string;
  repo: string;
  sha: string;
  branch: string;
  kind: "branch" | "tag";
};

/** 一个 Agent 会话(CONTEXT.md Agent 会话)。读与写都只经这一种形状。 */
export type AgentSessionRecord = {
  id: number;
  productId: number;
  createdBy: string;
  purpose: AgentSessionPurpose;
  status: AgentSessionStatus;
  createdAt: string;
  /** 累计用量,与 Review Run 同口径:落库的每条记录按它的用量列累加上来(ADR 0031)。 */
  usage: ReviewerUsage;
  /**
   * 这个会话每个仓库开在哪个 commit(issue #351)。建会话那一刻记下来(issue #352);系统
   * 开的梳理没有人来选,首次备工作树时才记。这一票之前建的会话是空列表,面板因此什么都
   * 不显示。
   */
  baselines: AgentSessionBaseline[];
  /**
   * 产品梳理谈完的时刻(CONTEXT.md 产品梳理,issue #365)。agent 宣告共识时写下;在那之前
   * 与别的用途上都是 null。同一个产品同时只有一场 null 的梳理。
   */
  completedAt: string | null;
  /**
   * 这个会话第一条用户消息的正文(读时派生,不落库)。取第一段文本块、去首尾空白、把
   * 连续空白折成一个空格、截到 80 字——不加省略号,视觉上的截断由面板做。还没有人发过
   * 消息(刚建的会话)时是 null。
   */
  title: string | null;
  /** 这个会话最后一次有动静的时刻(读时派生):记录表的 `MAX(at)`,没有记录时落建会话时刻。 */
  lastActiveAt: string;
};

/**
 * 会话记录表里的一行(ADR 0031,issue #333)。`entry` 是 Pi 的 `SessionEntry` 原样 JSON,
 * 其余几格是从它里面抄出来的索引列。
 */
export type AgentSessionEntryRecord = {
  sessionId: number;
  /** 会话内自增。SSE 的帧 id 就是它。 */
  seq: number;
  /** Pi 条目的 `type`:`message` / `custom` / `compaction` 等。 */
  type: string;
  /** Pi 条目的 `timestamp`。 */
  at: string;
  entry: unknown;
  usage: ReviewerUsage;
};

/** 一次发消息的受理结果(issue #333)。`fresh` 为假即这个客户端消息 id 早已受理过。 */
export type AgentSessionMessageAcceptance = { acceptedAt: string; fresh: boolean };

/**
 * 一张落好盘的会话图片(spec #329,issue #336)。库里只有路径与 mimeType:图片本身在 data
 * 目录下的文件里,base64 不进库也不进会话记录。
 */
export type AgentSessionImageRecord = {
  sessionId: number;
  imageId: string;
  path: string;
  mimeType: string;
  createdAt: string;
};

/**
 * 一条还没投递出去的排队消息(issue #335)。`mode` 的取值与 IPC 那一侧的
 * `AgentSessionMessageMode` 同一对字面量;这一层不认它的类型——领域类型定在 `reviewer/`,
 * 而那个目录依赖这里,反过来不成立。读回时由运行时收口。
 */
export type AgentSessionPendingMessage = {
  mode: string;
  text: string;
  /**
   * 这一条带的那几张图的文件引用,原样一段 JSON(issue #336)。没带图即缺席。这一层不解释
   * 它的形状——图片引用的领域类型同样定在 `reviewer/`,与 `mode` 同律。
   */
  images?: string;
};

/**
 * 一条会话记录在 Pi 条目树上的位置(ADR 0031,issue #335)。重建前自检链完整性要的就这三格,
 * 整份条目不必解出来:`id` 与 `parentId` 是那条链,`firstKeptEntryId` 是 compaction 的引用。
 */
export type AgentSessionEntryLink = {
  id: string | null;
  parentId: string | null;
  firstKeptEntryId: string | null;
};

/** 时间窗内的 Agent 会话用量:会话数与它们的 token 之和。一个都没有时缺失。 */
export type AgentSessionUsageStats = ReviewerUsage & { sessions: number };

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

/**
 * 181 个方法的签名写在这里,一律写成同步形状——对外的 `Store` 是它的映射类型,每个方法
 * 返回 `Promise`(spec #445)。这样写只是免得逐个手抄一遍 `Promise<…>`;实现按 `Store` 写。
 */
type SyncStore = {
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
  /** 每行带上这个用户的仓库分配;系统管理员不受限,它那一行照样只回落库的行。 */
  listPanelUsers(): (PanelUserRecord & { repoIds: number[] })[];
  /** 整组覆盖一个用户的仓库分配。空数组即清空,重复的 repo id 只落一行。 */
  setPanelUserAssignment(username: string, repoIds: readonly number[]): void;
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
    /** 注册者的用户名。给了就在同一个事务里把这个仓库分配给他(issue #192)。 */
    assignTo?: string;
  }): boolean;
  /** 给仓库加一把 key,轮转(ADR 0007)开新代次用。同仓库同代次重复添加直接抛。 */
  addRepoKey(repoId: number, generation: number, key: string): void;
  /** 摘掉一把 key,轮转收尾时删旧代次用。不存在时静默通过——目标状态已达成。 */
  removeRepoKey(repoId: number, generation: number): void;
  /** 仓库持有的全部 key。未注册的仓库得到空数组——这就是「未注册」的判据。 */
  listRepoKeys(repoId: number): RepoKey[];
  getRepo(repoId: number): RepoRecord | undefined;
  /**
   * 整块改写这个仓库的配置(issue #302、#303、#350):模型覆盖、辅助模型覆盖、最低报告等级
   * 与默认分支在一笔事务里全量替换,期望版本对得上才写,写成即版本加一。前三项是 null 即
   * 跟随全局,默认分支是 null 即跟随 Gitea 的默认分支。
   */
  putRepoSettings(
    repoId: number,
    expectedVersion: number,
    settings: {
      reviewersJson: string | null;
      auxiliaryModelJson: string | null;
      minReportSeverity: Severity | null;
      defaultBranch: string | null;
    },
  ): RepoSettingsWrite;
  /**
   * 这个仓库生效的辅助模型(ADR 0029,issue #303):仓库覆盖 ?? 全局 ?? 这个仓库生效模型
   * 组合(仓库模型覆盖 ?? 全局组合)的第一个,返回值带来源。**Reviewer 之外的每一件 agent
   * 工作都调这一处**,不各自取。仓库不在注册表里、或三处都给不出模型时回 null。
   */
  resolveAuxiliaryModel(repoId: number): ResolvedAuxiliaryModel | null;
  /**
   * 摘掉注册表行、它的 Key、它的仓库分配与它的产品归属。评审记录一行不动:模型选型的
   * 历史不因下线而断。
   */
  removeRepo(repoId: number): void;
  /** 全部产品与各自的仓库集合,按名称排序。可见性由调用方按仓库分配收窄。 */
  listProducts(): ProductRecord[];
  /** 一个产品与它的仓库集合。没有这个产品即 undefined。 */
  getProduct(productId: number): ProductRecord | undefined;
  /** 建一个空产品。重名时抛 UNIQUE 约束错,由调用方接住回 409。 */
  createProduct(record: { name: string; createdAt: string }): ProductRecord;
  /** 改名。没有这个产品即 false;重名同样抛 UNIQUE 约束错。 */
  renameProduct(productId: number, name: string): boolean;
  /**
   * 把一个已注册仓库归入产品。已经在这个产品下即 `role-updated`,幂等——那一次只把仓库职责
   * (CONTEXT.md 仓库职责)改成给的这一份,归入时间不动。`role` 省略或 null 即没有职责。
   */
  attachProductRepo(
    productId: number,
    repoId: number,
    at: string,
    role?: string | null,
  ): ProductRepoAttach;
  /** 把一个仓库从产品里移出。这个产品下没有这个仓库即 false。 */
  detachProductRepo(productId: number, repoId: number): boolean;
  /**
   * 删产品,摘掉它的仓库归属并级联硬删它下面的 Agent 会话。回的是级联删掉的条数,
   * 接口照它给确认框的数字;没有这个产品即 undefined。
   */
  deleteProduct(productId: number): { sessions: number } | undefined;
  /**
   * 一个产品的全部产品知识条目(CONTEXT.md 产品知识),三种条目在同一份里,按产品页上的
   * 顺序排:术语表、仓库关系、产品决策,每一段里先写下的在前。读的每一处要的都是整份:产品页按种类与主题分组,`query_knowledge`
   * 按名字挑出一条——条目以十计,不值三个查询各走一趟库。
   */
  listProductKnowledge(productId: number): ProductKnowledgeEntry[];
  /**
   * 写一条产品知识:写下即生效,没有提案态(ADR 0035)。形状校验(定义为空、定义里的路径与
   * 类名、决策没有标题)在会话工具那一侧判完,这里只落库。
   *
   * `id` 给了即改写那一条;`supersedes` 给了即把那条决策落成被这一条取代。改写的目标或
   * 取代的目标不在这个产品下时回 undefined,一格不动。
   */
  writeProductKnowledge(record: ProductKnowledgeWrite): ProductKnowledgeEntry | undefined;
  /**
   * 撤回一条产品知识:删行。这个产品下没有这一条即 false——撤回两次不该报成功。条目由会话
   * 在人的回答下写成,撤回的那一条不必留着:留着的是产品页此刻说得出的那一份。
   */
  withdrawProductKnowledge(productId: number, entryId: number): boolean;
  /** 一个产品 tracker 里的全部 spec(CONTEXT.md spec,issue #361),按建立顺序。 */
  listProductSpecs(productId: number): ProductSpecRecord[];
  /** 一条 spec。没有这一条即 undefined;产品由调用方按 `productId` 判。 */
  getProductSpec(specId: number): ProductSpecRecord | undefined;
  /** 写一条 spec。状态落开,`sessionId` 是写下它的那个会话。 */
  createProductSpec(record: {
    productId: number;
    title: string;
    body: string;
    sessionId: number | null;
    at: string;
  }): ProductSpecRecord;
  /** 一个产品下的全部票(CONTEXT.md 票),按票号升序,各带阻塞它的那几张。 */
  listProductTickets(productId: number): ProductTicketRecord[];
  /** 一张票,带阻塞它的那几张。没有这一张即 undefined。 */
  getProductTicket(ticketId: number): ProductTicketRecord | undefined;
  /** 在一条 spec 下开一张票。状态落开,标签由调用方给(默认那一个也在调用方)。 */
  createProductTicket(record: {
    specId: number;
    title: string;
    body: string;
    label: ProductTicketLabel;
    sessionId: number | null;
    at: string;
  }): ProductTicketRecord;
  /** 改写一条 spec 的正文。没有这一条即 false。 */
  setProductSpecBody(specId: number, body: string): boolean;
  /** 开关一条 spec。已经是这个状态即 false——关两次不该报成功。 */
  setProductSpecState(specId: number, state: ProductTrackerState, at: string): boolean;
  /** 改写一张票的正文。没有这一张即 false。 */
  setProductTicketBody(ticketId: number, body: string): boolean;
  /** 开关一张票。已经是这个状态即 false。 */
  setProductTicketState(ticketId: number, state: ProductTrackerState, at: string): boolean;
  /** 改一张票的标签(CONTEXT.md 票,issue #363)。五个取值由调用方判。没有这一张即 false。 */
  setProductTicketLabel(ticketId: number, label: ProductTicketLabel): boolean;
  /**
   * 认领或取消认领一张票(CONTEXT.md 认领,issue #363)。`claimedBy` 给名字即认领,给 null
   * 即取消;`by` 是动手的那个人。**别人认领着的票认不动、也取消不了**(评审复核):那一档
   * 回 false,由调用方说出理由——两个人同时点认领时后一个不该把前一个顶掉,别人手里的活也
   * 不该被随手收走。自己认领两次与取消一张没人认领的票都算成功。系统管理员那一档由调用方
   * 判:他给 `by` 传这张票此刻的认领人。
   */
  setProductTicketClaim(ticketId: number, claimedBy: string | null, by: string): boolean;
  /** 一张票上的评论,老的在前。 */
  listProductTicketComments(ticketId: number): ProductTicketCommentRecord[];
  /** 在一张票上写一条评论。人写的给 `author`,会话写的给 `sessionId`。 */
  addProductTicketComment(record: {
    ticketId: number;
    author: string | null;
    sessionId: number | null;
    body: string;
    at: string;
  }): ProductTicketCommentRecord;
  /**
   * 加一条阻塞边:`ticketId` 被 `blockedById` 挡着。已经有这条边即什么都不做——同一条边
   * 加两遍是同一个意思,因此不回结果。**两张票在不在同一个产品由调用方判**:那一判要说出
   * 打回的理由。
   */
  addProductTicketBlock(ticketId: number, blockedById: number): void;
  /** 去掉一条阻塞边。本来就没有这条边即 false。 */
  removeProductTicketBlock(ticketId: number, blockedById: number): boolean;
  /**
   * 一个产品下的 Agent 会话,新的在前。`createdBy` 给了即只回这个人的(「我的会话」),
   * 给 null 即这个产品下的全部(系统管理员那一档)。
   */
  listAgentSessions(productId: number, createdBy: string | null): AgentSessionRecord[];
  /** 一个 Agent 会话。没有这一条即 undefined;可见性由调用方按创建者判。 */
  getAgentSession(sessionId: number): AgentSessionRecord | undefined;
  /**
   * 建一个 Agent 会话。状态落空闲、用量五格落 0。
   *
   * `baselines` 是这个会话每个仓库开在哪个 commit(issue #352):建会话那一刻就定下来,
   * 工作树按它检出。不给即这一刻还不知道停在哪,首次备树时再写(issue #351)。
   */
  createAgentSession(record: {
    productId: number;
    createdBy: string;
    purpose: AgentSessionPurpose;
    createdAt: string;
    baselines?: readonly AgentSessionBaseline[];
  }): AgentSessionRecord;
  /**
   * 记下这个会话每个仓库开在哪个 commit(issue #351)。备工作树那一刻调它;整列替换。
   * 建会话时已经记过的那一份原样留住(issue #352):空闲回收后重备停在同一个 commit 上,
   * 面板显示的与 agent 读的因此始终是同一份。
   */
  setAgentSessionBaselines(sessionId: number, baselines: readonly AgentSessionBaseline[]): void;
  /**
   * 记下这一场产品梳理谈完了(CONTEXT.md 产品梳理,issue #365)。agent 宣告共识时调完成
   * 工具落这一格;会话本身照旧读得到、续得了,拦的只是同一个产品的下一场梳理。
   */
  completeAgentSession(sessionId: number, at: string): void;
  /** 删一个 Agent 会话,记录、受理过的客户端消息 id 与图片行一并删掉。没有这一条即 false。 */
  deleteAgentSession(sessionId: number): boolean;
  /** 记下一张落好盘的会话图片(issue #336)。发消息时按 `imageId` 认领它。 */
  addAgentSessionImage(record: AgentSessionImageRecord): void;
  /** 这个会话的这一张图。认不出这个 id 即 undefined——发消息时据它回绝。 */
  getAgentSessionImage(sessionId: number, imageId: string): AgentSessionImageRecord | undefined;
  /**
   * 落一条会话记录(ADR 0031,issue #333)并把它的用量累加到会话上。seq 由这一步给,
   * 两件事在同一个事务里:会话上的累计用量就是它的记录行之和,不可能只做一半。
   */
  appendAgentSessionEntry(
    sessionId: number,
    input: { type: string; at: string; entry: unknown; usage: ReviewerUsage },
  ): AgentSessionEntryRecord;
  /** 一个会话的记录,按 seq 升序。`afterSeq` 给了即只回它之后的那些(续传)。 */
  listAgentSessionEntries(sessionId: number, afterSeq?: number): AgentSessionEntryRecord[];
  /**
   * 一页会话记录,按 seq 升序(spec #329 的 US 12)。`before` 给了就取它之前的最后 `limit`
   * 条,缺省即最后一页;`hasMore` 说这一页之前还有没有更早的条目。长会话打开时只取最后一页,
   * 往上翻一页一页来——一次全量读是几 MB 的 JSON。
   */
  agentSessionEntryPage(
    sessionId: number,
    before: number | undefined,
    limit: number,
  ): { records: AgentSessionEntryRecord[]; hasMore: boolean };
  /**
   * 这个客户端消息 id 受理过没有(issue #333):受理过即回那一刻。接口先问它,再判别的——
   * 重发的那一条正是在跑的这一条,落到「正在执行」那一档上会让人以为它没被收下。
   */
  acceptedAgentSessionMessage(sessionId: number, clientMessageId: string): string | undefined;
  /**
   * 受理一条客户端消息(issue #333)。第一次回 `fresh: true`,同一个 id 重发回
   * `fresh: false` 与第一次的受理时刻——接口据此回原受理结果而不再投递一次。
   */
  acceptAgentSessionMessage(
    sessionId: number,
    clientMessageId: string,
    at: string,
  ): AgentSessionMessageAcceptance;

  /**
   * 把这个会话还没投出去的排队消息整段换成给的这几条(issue #335)。空数组即清空。
   * 排空与空闲回收在收掉子进程之前调它:镜像随进程走,落库的这一份等重建时投递。
   */
  putAgentSessionPendingMessages(
    sessionId: number,
    messages: readonly AgentSessionPendingMessage[],
  ): void;
  /**
   * 取出并删掉这个会话落库的排队消息(issue #335),按当初写下的顺序。重建时调它:取出即
   * 投递,留着就会重复投,因此读与删在同一个事务里。
   */
  takeAgentSessionPendingMessages(sessionId: number): AgentSessionPendingMessage[];
  /**
   * 这个会话落库的排队消息,只读(评审复核)。读接口与清队列那一处用它:子进程被回收之后
   * 排队消息还在这张表上,下次发消息时会投出去——面板看得到它们才清得掉。
   */
  listAgentSessionPendingMessages(sessionId: number): AgentSessionPendingMessage[];
  /**
   * 这个会话每条记录在 Pi 条目树上的位置(issue #335),按 seq 升序。只读三格而不解整份
   * 条目:重建前的链自检与读接口上那个「前 N 条不在上下文」都只要这三格,而一个长会话的
   * 条目整段解一遍是几 MB 的 JSON。
   */
  agentSessionEntryLinks(sessionId: number): AgentSessionEntryLink[];
  /**
   * 时间窗内建的 Agent 会话数与它们的 token 之和(spec #329 的统计页单列一行)。
   * `createdBy` 给了即只算这个人的,给 null 即全部(系统管理员那一档)。一条都没有时缺失。
   */
  agentSessionUsageStats(
    from: string,
    to: string,
    createdBy: string | null,
  ): AgentSessionUsageStats | undefined;
  /** 记下工作副本的准备状态(issue #184)。仓库已被移除时没有行可写,静默通过。 */
  setRepoWorktree(repoId: number, status: WorktreeStatus): void;
  /**
   * 把停在「准备中」的行改判失败(issue #184)。进程重启会中断后台的准备,那些行没有
   * 谁再去改它,面板会一直显示准备中而且给不出重试入口。
   */
  failInterruptedWorktrees(failure: string, at: string): void;
  /** 全部已注册仓库,按最近活动排序,没跑过的按注册时间排在后面。 */
  listRepos(): RepoSummary[];
  /**
   * 按 owner/repo 找注册表行的 id。评审记录不引用注册表(仓库移除之后记录照样看得见),
   * 拿着记录上的两个名字回头找注册表行只能这么找。仓库改名或已被移除即回 undefined。
   *
   * 与 `listRepos` 分开:那一份每行带三条聚合子查询,只为取一个 id 的调用付不起。
   */
  findRepoId(owner: string, repo: string): number | undefined;
  /**
   * 这个仓库当前生效的知识集与它的知识集版本。未注册的仓库回 undefined——知识集挂在
   * 注册表行上,没有那一行就没有知识集可谈。
   */
  getRuleSet(repoId: number): RuleSet | undefined;
  /**
   * 直接废止一条生效中的条目:推进一版,那一行废止于那一版,之后可查不可用。条目不在
   * 这个仓库的生效条目里时回 undefined。
   */
  retireReviewRule(repoId: number, ruleId: number): number | undefined;
  /** 这个仓库最近一次基点探索(issue #205)。从没探索过或仓库不在注册表里回 null。 */
  getRuleExploration(repoId: number): RuleExploration | null;
  /**
   * 发起一次基点探索:那一行改写成运行中,失败原因与结束时刻清掉。同仓库已经有一次在
   * 跑时回 false(同时只跑一个),仓库不在注册表里同样回 false。草案这时不动——探索没
   * 跑出结果之前不该先把人手上那份删掉。
   */
  startRuleExploration(
    repoId: number,
    run: {
      baselineSha: string;
      model: string;
      /** 这一次选的思考档位(CONTEXT.md)。缺席即没选,等同 off。 */
      thinkingLevel?: ThinkingLevel;
      startedAt: string;
    },
  ): boolean;
  /** 探索完成:整组覆盖知识草案,那一行改写成已完成。调用方负责截断与去空。 */
  finishRuleExploration(repoId: number, items: readonly ReviewRuleInput[], at: string): void;
  /**
   * 探索完成,产出排进修订提案队列(issue #207):知识集已经确认过时走这一条,草案一行
   * 不动。**待裁决且出处附注全部来自基点探索**的旧提案被这一批取代(与草案同一条覆盖
   * 语义,issue #281);已裁决的、以及带别的来源附注的不动——人写的意见不该被一次重探索
   * 覆盖。那一行同样改写成已完成。调用方负责截断、去空与变更类型的映射。
   */
  finishRuleExplorationAsProposals(
    repoId: number,
    proposals: readonly RuleProposalInput[],
    at: string,
  ): void;
  /** 探索失败:留下原因,草案保持原样。人看得到原因,并可重新发起。 */
  failRuleExploration(repoId: number, failure: string, at: string): void;
  /**
   * 把停在运行中的探索改判失败(与 `failInterruptedWorktrees` 同一个理由):进程重启会
   * 中断后台的探索,那些行没有谁再去改它,面板会一直显示运行中而且给不出重试入口。
   */
  failInterruptedRuleExplorations(failure: string, at: string): void;
  /** 这个仓库最近一次知识整理(issue #284)。从没整理过或仓库不在注册表里回 null。 */
  getRuleConsolidation(repoId: number): RuleConsolidation | null;
  /**
   * 发起一次知识整理:那一行改写成运行中,失败原因、摘要与结束时刻清掉。**与基点探索
   * 共用「同仓库同时只跑一个」**:两张表里任一行是运行中即回 false;仓库不在注册表里
   * 同样回 false。
   */
  startRuleConsolidation(
    repoId: number,
    run: {
      model: string;
      /** 这一次选的思考档位(CONTEXT.md)。缺席即没选,等同 off。 */
      thinkingLevel?: ThinkingLevel;
      startedAt: string;
    },
  ): boolean;
  /** 整理完成:落下这一次的摘要,那一行改写成已完成。队列的改动由两个落地方法各自写。 */
  finishRuleConsolidation(
    repoId: number,
    summary: { merged: number; retargeted: number; proposed: number },
    at: string,
  ): void;
  /** 整理失败:留下原因,已经落地的队列改动保持原样。 */
  failRuleConsolidation(repoId: number, failure: string, at: string): void;
  /** 把停在运行中的整理改判失败,与 `failInterruptedRuleExplorations` 同一个理由。 */
  failInterruptedRuleConsolidations(failure: string, at: string): void;
  /**
   * 这个仓库的全部修订意图(CONTEXT.md 修订意图,issue #294、#317):运行中与失败的在前,
   * 其余按开始时刻倒序。
   *
   * 不再按完成时刻截窗(issue #317):意图列表挪进弹窗自己的 tab,不再挡知识条目;处置时
   * 写的备注去了哪里,多久以后都要查得到。要人处理的(重试、删除)因此置顶。
   */
  listRuleIntents(repoId: number): RuleIntent[];
  /** 一条修订意图。不在这个仓库里回 null。 */
  getRuleIntent(repoId: number, intentId: number): RuleIntent | null;
  /**
   * 这个目标上还有没有跑着的意图(CONTEXT.md 人工提议,issue #295)。同一目标同时只跑
   * 一条:两条改写并发只会互相覆盖。无目标的不限,因此不问这一句。
   */
  hasRunningRuleIntent(repoId: number, targetKind: RuleIntentTargetKind, targetId: number): boolean;
  /**
   * 提交一条修订意图:落一行运行中的。返回新行;仓库不在注册表里回 undefined。
   * 与探索、整理不同,这里不判互斥——意图不受它们的互斥限制(ADR 0028)。
   */
  startRuleIntent(
    repoId: number,
    intent: {
      text: string;
      submittedBy: string;
      targetKind: RuleIntentTargetKind;
      targetId: number | null;
      /** 选不出模型时为 null:那一行落下来就是失败的,人在列表里看得到(issue #296)。 */
      model: string | null;
      thinkingLevel?: ThinkingLevel;
      startedAt: string;
    },
  ): RuleIntent | undefined;
  /** 关联这一次的知识轨迹。轨迹起不来时不调,那一列保持 NULL。 */
  setRuleIntentTrace(intentId: number, taskId: number): void;
  /** 意图完成:落下收尾一句与产出标识。零产出同样是完成。 */
  finishRuleIntent(
    intentId: number,
    outcome: { summary: string; produced: RuleIntent["produced"] },
    at: string,
  ): void;
  /** 意图失败:留下原因。已经落地的产出保持原样。 */
  failRuleIntent(intentId: number, failure: string, at: string): void;
  /** 把停在运行中的意图改判失败,与 `failInterruptedRuleExplorations` 同一个理由。 */
  failInterruptedRuleIntents(failure: string, at: string): void;
  /**
   * 删掉一条修订意图。失败行与完成行删得掉,运行中的删不掉——那一次还在跑,行删了它
   * 结算时就没有落处。回 `missing` / `running` / `deleted` 三态,调用方各回一句话。
   */
  deleteRuleIntent(repoId: number, intentId: number): "missing" | "running" | "deleted";
  /**
   * 重跑一条失败的修订意图(CONTEXT.md 修订意图,issue #316):同一行原地改回运行中,清掉失败
   * 原因、结束时刻、收尾、产出与轨迹标识,写这一次的开始时刻、模型与思考档位;原文、目标、
   * 提交人与行的标识不动。不在这个仓库里或不是失败态回 undefined——判据与改写在同一句
   * UPDATE 里,两次重试并发只有一次改得动。
   */
  rerunRuleIntent(
    repoId: number,
    intentId: number,
    run: { model: string; thinkingLevel?: ThinkingLevel; startedAt: string },
  ): RuleIntent | undefined;
  /**
   * 合并几条待裁决提案(CONTEXT.md 知识整理,issue #284):**保留 id 最小的那一行**,
   * 其余行删除,附注全部并入保留行,陈述换成合成后的这一句。
   *
   * 落地这一刻逐条校验,一条不合即整次跳过回 false:少于两条、陈述为空、有一条已经不
   * 在待裁决队列里(整理期间人照常裁决),或者几条的变更类型、目标条目与知识型不是同一
   * 个——那不是重复,合并会把一条意思不同的变更连同它的出处一起删掉。
   */
  mergeRuleProposals(repoId: number, proposalIds: readonly number[], statement: string): boolean;
  /**
   * 把一条新增型提案改写成指向某条生效条目的修改型(issue #284)。提案不在待裁决队列里、
   * 不是新增型、目标条目此刻不生效、或者两者不同型时回 false,那一条改写丢掉——不同型
   * 的修改采纳不了,改出来只会在队列里留一条裁不掉的。
   */
  retargetRuleProposal(repoId: number, proposalId: number, targetRuleId: number): boolean;
  /** 这个仓库当前的知识草案,按 id 排序。没有草案即空数组。 */
  getRuleDraft(repoId: number): RuleDraftItem[];
  /**
   * 把一次人工提议的产出追加进草案(CONTEXT.md 人工提议,issue #294),出处记人工提议。
   * **追加而不是覆盖**:草案的整组覆盖只属于重新探索,一条意图补的是这份草案里缺的那
   * 几条。返回新条目的标识,按给的先后。
   */
  appendRuleDraftItems(
    repoId: number,
    items: readonly ReviewRuleInput[],
    at: string,
  ): number[];
  /** 改草案里的一条。出处沿用旧值——改文字不改变这条当初从哪来。不在草案里回 false。 */
  updateRuleDraftItem(repoId: number, itemId: number, input: ReviewRuleInput): boolean;
  /** 删草案里的一条。草案未确认,删就是删掉,没有历史版本要为它保留。 */
  deleteRuleDraftItem(repoId: number, itemId: number): boolean;
  /**
   * 知识确认(CONTEXT.md):草案整组成为生效条目,推进一个知识集版本,草案清空。还没
   * 确认过的仓库可以确认空草案——空知识集是合法状态(issue #200),那一版就是一个空集。
   *
   * `itemIds` 给了就只确认这几条,其余的随草案一并丢弃(issue #223 的批量确认:在确认页
   * 取消勾选,与逐条删掉再整组确认是同一件事)。**其中任意一条不在这个仓库的草案里就
   * 整次不做**,回 undefined:一份过期的勾选不该悄悄确认成另一组条目。不给即整组确认。
   *
   * 返回新的知识集版本;仓库不在注册表里、或知识集已确认而这一次确认的是空的一组时回
   * undefined。
   */
  confirmRuleDraft(repoId: number, itemIds?: readonly number[]): number | undefined;
  /** 这个仓库的修订提案队列,按排队先后。待裁决与已裁决的都在里面。 */
  getRuleProposals(repoId: number): RuleProposal[];
  /** 排一条修订提案进队列。返回它的 id;仓库不在注册表里回 undefined。 */
  addRuleProposal(repoId: number, input: RuleProposalInput): number | undefined;
  /**
   * 把一次新来源并进一条待裁决提案(CONTEXT.md 处置反哺,issue #283):陈述换成合成后
   * 的那一句,出处附注追加一条。两条说同一件事的处置备注因此只在队列里留一条提案。
   *
   * **只覆盖陈述**。作用范围与型不动:并入的输入里没有它们(交给 agent 的队列只给标识、
   * 变更类型、目标与陈述),拿一份只看新备注写出的作用范围去覆盖,会把这条提案缩到说不
   * 上话的范围里;型不动另与 `modify` 那道翻型闸同一条口径——并入不是人的裁决,不该悄悄
   * 把一条规则变成事实。变更类型与目标同样不动:并入说的是「同一件事又被提了一遍」,不是
   * 对这条提案是什么变更的重判。
   *
   * 提案不在这个仓库的待裁决队列里(已裁决或根本不存在)时回 false,一行不改;调用方
   * 据此把那一条退回按新增处理。
   */
  mergeIntoRuleProposal(repoId: number, proposalId: number, merge: RuleProposalMerge): boolean;
  /**
   * 采纳一条待裁决的提案(CONTEXT.md 裁决):推进一版知识集版本,按变更类型落库——
   * 新增写一行新规则(出处沿用提案的出处)、修改是旧行废止于新版加新内容作为新行、
   * 废止只让目标那一行停止生效、合并是几条目标全部废止于新版加合成的那一条作为新行
   * (出处与新增同一条口径,issue #282)。**落的就是队列里那一份**:采纳前改内容那一档
   * 已经撤掉(issue #299,ADR 0028),要改内容先写一条修订意图让 agent 改写这条提案。
   *
   * 返回新的知识集版本。提案不在待裁决队列里、或它的目标条目有一条已经不生效时回
   * undefined,一版都不推进。
   */
  acceptRuleProposal(repoId: number, proposalId: number): number | undefined;
  /**
   * 批量采纳一组待裁决的提案(issue #223):在同一个写事务里按排队先后逐条落库,
   * **一次只推进一个知识集版本**——逐条各推一版会让一次裁决在版本轴上散成上百格,
   * 之后回看「那一次采纳的是哪一组」再也拼不回来。
   *
   * 全成或全不成:其中任意一条不在待裁决队列里、或它要改的条目已经不生效,整次回
   * undefined,一行都不改。部分成功会让人对着一份说不清哪些落了的队列继续裁决。
   * **组内两条指向同一个目标条目同样整次回 undefined**:那一组落下去会让一条规则裂成
   * 两条,该由人自己挑一条。空数组同样回 undefined:没有要采纳的东西,不该白推一版。
   */
  acceptRuleProposals(repoId: number, proposalIds: readonly number[]): number | undefined;
  /** 驳回一条待裁决的提案:只改状态,知识集一版都不推进。不在待裁决队列里回 false。 */
  rejectRuleProposal(repoId: number, proposalId: number): boolean;
  /**
   * 批量驳回一组待裁决的提案(issue #223)。与单条同义,只是一次改一组;知识集一版都不
   * 推进。其中任意一条不在待裁决队列里即整次回 false,一条都不改。
   */
  rejectRuleProposals(repoId: number, proposalIds: readonly number[]): boolean;
  /** 审查策略。历史值和未写过的项都读回 null，整页版本从 1 开始。 */
  getGlobalSettings(): GlobalSettings;
  /**
   * 整页全量替换审查策略(issue #301)：版本相等才写，写完推一版。每一项都是 null 即
   * 「跟随系统默认」，那一行随即从库里删掉。非空模型组合里有模型不可用即整次不写。
   * 陈旧版本或组合不可用都返回 false，两种情形一行都不改。
   */
  replaceGlobalSettings(expectedVersion: number, next: GlobalSettingsValues): boolean;
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
  /**
   * 收尾一轮。返回本轮同根因组的落库 id,与 `result.rootCauses` 同序(issue #308):
   * Forge 评论正文里那一行要链到组,而组的 id 要等这一笔事务插完才有。没有组即空数组。
   */
  finishRun(runId: number, result: RunResult): number[];
  /** 一轮的同根因组与成员(issue #308),按落库先后。这一轮没有组即空数组。 */
  rootCauseGroups(runId: number): RootCauseGroup[];
  /**
   * 把停在运行中的 Review Run 改判失败(issue #247,与 `failInterruptedWorktrees` 同一个
   * 理由):进程重启会连着 Reviewer 子进程一起中断,那些行没有谁再去改它,面板会一直
   * 显示进行中并持续轮询。返回被改判的那些轮次,调用方据它去撤 PR 上残留的 👀。
   *
   * 原因写两处(ADR 0026):`review_run.failure` 那一列(零 pin 的轮次也读得到),加这一轮
   * 已固定的 Reviewer 指定各自的 `reviewer_outcome` 行——面板的逐模型失败展示读那里,
   * 与其他失败一轮同一条路径。`failed` 照旧置 1。
   *
   * `runIds` 给了就只改判这几轮(issue #248:续跑不成立的那些);省略即全部停在运行中
   * 的轮次。
   */
  failInterruptedRuns(
    failure: string,
    at: string,
    runIds?: readonly number[],
  ): InterruptedRun[];
  /**
   * 给一轮写轮次级的失败原因(ADR 0026):这一轮为什么没有正常收尾。只写这一列——
   * `failed`、结束时间与 Reviewer 结果都不动,发布 review 失败那一类 Reviewer 结论有效
   * 的收尾失败走这里。
   */
  recordRunFailure(runId: number, failure: string): void;
  /**
   * 停在运行中的那些轮次,带够续跑要的冻结事实(issue #248)。启动时先问它:一行都没有
   * 就什么都不做,启动路径因此零改动。
   */
  interruptedRuns(): InterruptedRunDetail[];
  /**
   * 一个 Reviewer 在一批上跑完立即落库(issue #410)。同一个(批次, 模型)重复落库时
   * 覆盖——续跑本身不会走到这里,但重复写也不该攒出第二份结果。
   */
  recordBatchOutcome(
    runId: number,
    batchIndex: number,
    model: string,
    outcome: TimedOutcome,
  ): void;
  /** 续跑一轮要的已落库状态(issue #248)。那一轮不存在时为 undefined。 */
  resumeState(runId: number): ResumeState | undefined;
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
   * 本审查阶段里要在这一轮重新定位的那些 Finding(issue #368)。
   *
   * 折叠键、阶段范围与「已延续」那道筛都与 `stageHistory` 同一份:一条 Identity 只有
   * 最新那一行说得出它此刻在哪里。**已处置的也在里面**——它们既进不了复核也进不了延续,
   * 不在这里挪位置就永远停在报出它的那一轮上。算不出指纹的行不在里面:没有指纹就没有
   * 重新定位的依据。
   */
  relocationCandidates(scope: StageScope): RelocationCandidate[];
  /**
   * 把这一轮解析到的新位置写进 `placed_line` / `placed_run_id`(issue #368)。
   *
   * 只碰这两列:`line` 与 `run_id` 说的是它在哪一轮的哪一行被报出来的,归属、评论载体
   * 与指纹窗口都按那一份算。不新建行、不写评论、不写复核结论、不写处置。
   */
  recordFindingRelocations(runId: number, placements: readonly FindingRelocation[]): void;
  /**
   * 一个仓库的历史 Finding,供 Agent 会话的查询工具按需取(issue #338)。
   *
   * 折叠键与 `stageHistory` 同一份(`identityKey`),每条 Identity 取最新一行——那一行
   * 才带着当前的处置状态与正文;「已延续」的那条整条不回,它已经交接到新位置,新位置
   * 自己在结果里。跨阶段取:会话里问的是「这块代码历史上出过什么问题」,不是某一个
   * pull request 的现状。
   *
   * `pathGlob` 与 `limit` 在 JS 里收:glob 要在截断之前过一遍,否则截到的 50 条里能匹配
   * 上的只剩几条。一个仓库的 finding 行数有界(轮次 × 每轮的条数),全取回来付得起。
   */
  listRepoFindings(query: RepoFindingQuery, limit: number): RepoFinding[];
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
   * 这个阶段里行作者四列还是 NULL 的 Finding(issue #199),按 id 升序。
   *
   * 升级前落的行,以及当时判定失败留空的那些,都在里面。读路径拿它去补录:NULL 不是
   * 终态,补不上的下次读取再试。
   */
  pendingLineAuthors(scope: StageScope): PendingLineAuthorFinding[];
  /**
   * 把补录到的行作者写回四列(issue #199)。
   *
   * 只写还是 NULL 的那些:补录是异步的,期间可能有新一轮把这条 Finding 的行作者写上,
   * 那一份按自己的 head 判,比补录这份新。
   */
  recordLineAuthors(authors: readonly FindingLineAuthor[]): void;
  /**
   * 把本轮新发出去的行级评论的 id 与链接补到对应的合并组上。
   *
   * 与 `finishRun` 分成两步:落库要先于发布(发布失败不该把这轮的过程记录一并丢掉),
   * 而评论 id 只有发布之后才拿得到。跨轮匹配折叠的那些不走这里,它们记的是历史评论,
   * `finishRun` 时就已经知道。
   */
  recordFindingComments(runId: number, refs: readonly FindingCommentRef[]): void;
  /**
   * 追加一条审查轨迹(CONTEXT.md,ADR 0017),返回落库后的那条(带序号与时刻)。
   *
   * 序号在一轮之内自增,由这一句 INSERT 自己算——SQLite 的单句写是原子的,不需要先查
   * 后写,并发的两条也不会拿到同一个号。
   */
  appendTrace(runId: number, event: TraceEventInput): TraceEvent;
  /**
   * 一轮的轨迹,按 `seq` 升序。`afterSeq` 给了就只回它之后的那些,断线续传用。
   * 没有事件的轮次得到空数组——升级前跑过的轮次就是这一档。
   */
  listTrace(runId: number, afterSeq?: number): TraceEvent[];
  /**
   * 起一条知识轨迹(CONTEXT.md 知识轨迹,issue #214),返回它的任务标识。
   *
   * 标识与序号都由这一句 INSERT 自己算,口径与 `appendTrace` 相同;写下的第一条事件
   * 是 `rule_agent_started`,`payload` 是这一次任务的入参。
   */
  startRuleTrace(repoId: number, source: RuleTraceSource, payload: unknown): number;
  /** 追加一条知识轨迹事件,返回落库后的那条(带序号与时刻)。 */
  appendRuleTrace(taskId: number, event: RuleTraceEventInput): RuleTraceEvent;
  /** 一条知识轨迹,按 `seq` 升序。`afterSeq` 给了就只回它之后的那些,断线续传用。 */
  listRuleTrace(taskId: number, afterSeq?: number): RuleTraceEvent[];
  /** 这条知识轨迹挂在哪个仓库上。认不出的任务回 undefined,可见性据它判。 */
  ruleTraceRepo(taskId: number): number | undefined;
  /**
   * 把这一次基点探索与它的知识轨迹显式关联起来(issue #214)。发起那一刻起完轨迹就写,
   * 轨迹起头失败即不写,那一行的 `trace_task_id` 保持 NULL,面板不显示入口。
   *
   * 不按「这个仓库最近一条 baseline-exploration 轨迹」反推:轨迹起头失败时那样会把
   * 上一次探索的过程挂到这一行上,人点进去看到的是另一次任务。
   */
  setRuleExplorationTrace(repoId: number, taskId: number): void;
  /** 把这一次知识整理与它的知识轨迹关联起来(issue #284),判据与上面那条同律。 */
  setRuleConsolidationTrace(repoId: number, taskId: number): void;
  /**
   * 处置率统计(ADR 0006,主维度见 ADR 0015):按 Finding Identity 折叠,fallback
   * (body)排除,unknown 按 PR 状态分流,时间窗按同一处 Finding 首次报出那轮的开始
   * 时间归属(闭区间,ISO 字符串按字典序即时间序)。
   */
  dispositionStats(from: string, to: string): DispositionCell[];
  /**
   * 同一时间窗、同一批 Identity 上每个模型的参与条数(ADR 0015)。`repos` 给了就只
   * 数这些仓库的(仓库分配),省略即不限,空数组即一个都不数。
   */
  modelParticipation(
    from: string,
    to: string,
    repos?: readonly { owner: string; repo: string }[],
  ): ModelParticipation[];
  /**
   * 时间窗内落了用量的 Review Run 数与它们的 token 之和。一条都没有时缺失。
   * `repos` 与参与条数同一档口径。
   */
  usageStats(
    from: string,
    to: string,
    repos?: readonly { owner: string; repo: string }[],
  ): UsageStats | undefined;
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
    /**
     * 只给这些仓库的轮次(仓库分配)。省略即不限,空数组即一个都不给。收窄在 SQL 里
     * 做,这一页的行数才与 `limit` 和游标对得上。
     */
    repos?: readonly { owner: string; repo: string }[];
    /** 只要这一轮。面板的轮次详情按 id 取,读的与列表是同一份投影。 */
    id?: number;
  }): RunListItem[];
  /**
   * 评审记录的一页(issue #174):每行一个审查阶段,按最新一轮的时间倒序。
   *
   * 归并的判据与 `stageScope` 同源:pull request 阶段是「owner + repo + pull number
   * 且不属于任何范围审查」的全部轮次,范围审查阶段是它名下的全部轮次。三个计数直接
   * 取 `stageSummary`,列表与详情因此不会各算一套。
   *
   * 筛选与分页都在这里做:状态、来源与仓库先筛,再按 `offset` 切页,计数只为这一页
   * 的那几行算。
   */
  listStages(opts: {
    offset: number;
    limit: number;
    owner?: string;
    repo?: string;
    /**
     * 只给这些仓库的阶段(仓库分配,issue #192)。省略即不限,空数组即一个都不给。
     * 与 `owner` + `repo` 同时给时取交集:两者说的是同一件事的两个来源。
     */
    repos?: readonly { owner: string; repo: string }[];
    status?: StageStatus;
    source?: StageSource;
  }): StageListItem[];
  /**
   * 一个审查阶段的详情(issue #175):列表里的那一行,加按代码推进分组的时间线。
   *
   * 入参是列表给出的阶段标识(`pr:<owner>/<repo>/<number>` 与 `range:<id>`),认不出
   * 或没有这个阶段时是 undefined。分组只是把 `stageSummary` 的时间线归到推出它们的那
   * 次推进下面:pull request 按 head commit,范围审查按比较项。
   */
  stageDetail(stageId: string): StageDetail | undefined;
  /**
   * 落一条范围审查,返回它的 id。两条分支名由 id 推出,和插入在同一个事务里补上——
   * 记录一旦可见就必须带着分支名,否则中途失败的清理无从知道该删哪两条。
   */
  createRangeReview(record: {
    repoId: number;
    owner: string;
    repo: string;
    title: string;
    baseSha: string;
    comparisonSha: string;
    /** 选定比较项时用的分支或 Tag(issue #234);不给即不记来源。 */
    comparisonSource?: ComparisonSource;
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
   *
   * 来源跟着这一次的比较项走(issue #234):不给来源就清成 NULL,留着上一次那条说的是
   * 另一个 commit 是从哪儿选的。
   */
  advanceRangeReview(record: {
    id: number;
    comparisonSha: string;
    comparisonSource?: ComparisonSource;
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
  /**
   * 设置每日增量(CONTEXT.md 每日增量,issue #313、#315)。`branch` 为 null 即关闭,
   * 时刻与模式回到默认;开启与改任一项都刷新开启时刻——定时检查按它判这个时刻点算不算
   * 错过。只改状态,不推进。
   */
  setRangeReviewDailyIncrement(record: {
    id: number;
    branch: string | null;
    time: string;
    mode: ReviewRunMode;
    at: string;
  }): void;
  /**
   * 记下最近一次定时检查(issue #314)。任何结果都写,包括跳过的那些——「今天还没检查
   * 过」按这个时刻判,一天因此至多一次。只留最近一条,新的覆盖旧的。
   */
  recordRangeReviewScheduledCheck(record: {
    id: number;
    at: string;
    result: ScheduledCheckResult;
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
  /** 这个库此刻占多少字节(`pg_database_size`)。库不再是文件,体量只有它说得出来。 */
  databaseSize(): number;
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
   *
   * 传入的是折叠出来的代表条 id,返回的按 Finding Identity 展开(issue #275):折叠键
   * (`identityKey`)与它相同、同 PR 范围、仍能自动处置且带评论的每一行各出一条候选,按
   * 落库 id 升序、跨传入 id 去重。同一条 Identity 在一轮里可能有两条 Finding 各带一条
   * 评论,跨轮折叠又会多出旧行;只把代表条交给 Forge 会把其余评论留在那里未 resolve。
   * 同一处的另一条 Identity 不在其中(ADR 0030):它有自己的评论与自己的处置。
   */
  pendingAutoDispositions(findingIds: readonly number[]): AutoDispositionCandidate[];
  /**
   * 记一次「已修复」自动处置(ADR 0016)。处置人留空——这一档不是人做的;处置时刻
   * 照记,它同时是「这一行已被显式处置过」的标记,自动规则据此至多碰一行一次。
   *
   * 落的只有 `candidate.findingId` 那一行(issue #275):写 Forge 与落库一一对应,候选
   * 那一侧已经按 Finding Identity 展开,整条 Identity 因此仍会被逐行改写。没有评论载体
   * 的行(正文 fallback)进不了候选,也就保持原样——它在 Forge 上没有 resolve 可写,
   * 库里先记已修复只会与 Forge 对不上,下一轮回填还会把它改回去。
   *
   * `note` 是这一次自动处置的备注(issue #272):复核判已修那一档不带它,原备注保持
   * 原样;按「文件已回退 / 已删除」处置的带上一句,面板据它答得出这一条为什么关了。
   */
  recordAutoDisposition(
    owner: string,
    repo: string,
    pullNumber: number,
    candidate: AutoDispositionCandidate,
    disposedAt: string,
    note?: string,
  ): void;
  /**
   * 这些历史 Finding 里还能被延续的那些(CONTEXT.md 已延续,issue #167)。判据见
   * `ContinuationCandidate`;顺序与传入的 id 同序,调用方据此得到确定的配对结果。
   */
  continuationCandidates(findingIds: readonly number[]): ContinuationCandidate[];
  /**
   * 这些历史 Finding 在库里的位置与载体(issue #240),判据见 `HistoryPlacement`。
   * 合并 agent 命中一条历史之后,折叠与延续两条收口都读它;顺序与传入的 id 同序。
   */
  historyPlacements(findingIds: readonly number[]): HistoryPlacement[];
  /**
   * 记一次延续:旧行改记「已延续」,处置备注、处置人与处置时刻随 Identity 落到本轮
   * 新行上,新行同时记下旧评论的链接。
   *
   * 旧那一侧落的是整条 Finding Identity(键见 `identityKey`,承载它的那条评论名下的历史
   * 行一并改写;同一处的另一条 Identity 不在其中),口径与
   * 「已修复」自动处置和回填一致。元数据继承与 issue #152 同一个理由:处置的载体换了
   * 位置,人的备注、署名与「已经显式处置过」这个标记要跟着走,否则自动规则会再碰一次。
   *
   * `handoffPending` 即旧评论的 resolve 没成(ADR 0025):延续照记,旧行多一个待办
   * 标记,由下一轮收尾重试或回填清掉。
   */
  recordContinuation(input: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** 承接它的本轮 Review Run 与合并组。 */
    runId: number;
    groupIndex: number;
    candidate: ContinuationCandidate;
    handoffPending: boolean;
  }): void;
  /**
   * 这个 pull request 名下交接未完成的旧评论(ADR 0025):每条待关闭的评论一项,带它
   * 最新那一行的 id。下一轮 Review Run 收尾时按它重试 resolve。
   */
  pendingHandoffs(
    owner: string,
    repo: string,
    pullNumber: number,
  ): { findingId: number; commentId: string }[];
  /**
   * 交接完成:旧评论已在 Forge 上关掉,清掉这条 Finding Identity 上的待办标记。
   * 键与 `recordContinuation` 同源(`identityKey`),整条 Identity 一起清。
   */
  completeHandoff(owner: string, repo: string, pullNumber: number, findingId: number): void;
  /**
   * 回填 disposition(ADR 0006):对这个 pull request 名下、这条更新所指的那条 Finding
   * Identity 的全部历史 finding(键见 `BACKFILL_TARGET`),以 Forge 的最新状态覆盖已有值
   * ——人 resolve 后又 unresolve,库里跟着改。
   *
   * 「已修复」不被读回的 resolved 降级成人工处置那一档;「已延续」两个方向都不被覆盖
   * ——那条评论的 resolve 状态说的已经不是这条 Finding 的处置。只放开一格(ADR 0025):
   * 读到旧评论已 resolve 时把「交接未完成」清掉,那正是交接要等的那个结果。
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

/**
 * 库对外的形状(spec #445):每个方法返回 Promise。`SyncStore` 只是这 181 个签名的写法——
 * 逐个手抄一遍 `Promise<…>` 没有意义,由这个映射类型加上。实现直接按这个形状写。
 */
export type Store = {
  [K in keyof SyncStore]: SyncStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : SyncStore[K];
};





/** 一行 finding_carried_attribution 连同来源轮次的 head 读成一段历史说法(issue #267)。 */






/** 累加 Reviewer 用量。没有任何会话统计时保持缺失;跨批次与整轮聚合同一条语义。 */
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
  };
  for (const usage of usages) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.totalTokens += usage.totalTokens;
  }
  return total;
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

/**
 * 评审记录的一行,外加算计数与时间线要用的范围(阶段行查询的产物)。三个计数与最新
 * 一轮的警示不在这一段查询里:它们只为回到 JS 的那几行算(见 `listStages`)。
 */
export type StageRowEntry = {
  item: Omit<StageListItem, "counts" | "latestRunAlert">;
  scope: StageScope;
};




/**
 * 轮次级失败原因(ADR 0026)去掉首尾空白后为空时落的那句话。写入侧与读取侧共用一处:
 * 两边各写一遍字面量,哪天改文案就会剩下一处没改。
 */
export const UNRECORDED_RUN_FAILURE = "未记录原因";

/**
 * 轮次级失败原因在这里定形(issue #432、#436):通篇空白的原因换成一句话。「非空即
 * 收尾失败」这一档否则可以在没有任何原因的情况下成立,轮次侧滑上得到一句尾巴空着的
 * 话。正常的原因原样返回——不截断,也不改写。
 *
 * 同一句原因有三个去处:`review_run.failure`、改判时借 `reviewer_outcome.failure` 落的
 * 那一份,与轨迹的 `run_failed` 事件。**产生这句话的那一处先过它**,之后三处读的就是
 * 同一个字符串;只在写库那一侧兜底的话,轨迹会与库里说得不一样。
 */
export function runFailureText(failure: string): string {
  return failure.trim() === "" ? UNRECORDED_RUN_FAILURE : failure;
}

/** 历史 Finding 查询的三个条件(issue #338)。仓库必填,另两项缺席即不按它过滤。 */
export type RepoFindingQuery = {
  owner: string;
  repo: string;
  /** 仓库相对的路径 glob,`path.matchesGlob` 语义。 */
  pathGlob?: string;
  disposition?: Disposition;
};

/** 查询回来的一条历史 Finding:标题、严重度、文件行、处置状态与综合说明三段。 */
export type RepoFinding = {
  file: string;
  line: number;
  title: string;
  severity: Severity;
  disposition: Disposition;
  /** 综合说明的「问题」段(CONTEXT.md 综合说明)。 */
  description: string;
  /** 「影响」与「建议」两段。升级前落的行没存过,那时缺席。 */
  impact?: string;
  suggestion?: string;
};


/** 基点探索推导出的规则在 `origin` 上的出处(issue #205)。处置反哺另写自己的字面量。 */
const BASELINE_EXPLORATION_RULE_ORIGIN = "baseline-exploration";

/** 一条人工提议产出的草案条目在 `origin` 上的出处(issue #294)。与来源字面量同一个词。 */
const MANUAL_PROPOSAL_RULE_ORIGIN = "manual-proposal";


/**
 * 读一条修订意图要的那几列(issue #294)。三处查询共用,列名只写一遍。
 *
 * 目标 Finding 的阶段标识在这一句里算出来(issue #296,与出处附注那一格同一个字面形状):
 * 面板手上只有 Finding 标识,拼不出阶段地址,而 `?finding=` 侧滑要的就是它。
 */
const RULE_INTENT_COLUMNS = `SELECT id, text, submitted_by, target_kind, target_id, state,
                                    failure, summary, model, thinking_level, trace_task_id,
                                    produced_json, started_at, finished_at,
                                    (SELECT ${STAGE_ID_FROM_RUN}
                                       FROM finding f
                                       JOIN review_run run ON run.id = f.run_id
                                      WHERE rule_intent.target_kind = 'finding'
                                        AND f.id = rule_intent.target_id) AS target_stage_id
                               FROM rule_intent`;

/** 一行 `rule_intent` 读成一条修订意图。 */
function toRuleIntent(row: Record<string, unknown>): RuleIntent {
  const nullableText = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  const produced = row["produced_json"];
  return {
    id: Number(row["id"]),
    text: String(row["text"]),
    submittedBy: String(row["submitted_by"]),
    targetKind: String(row["target_kind"]) as RuleIntentTargetKind,
    targetId: row["target_id"] === null ? null : Number(row["target_id"]),
    targetStageId: nullableText(row["target_stage_id"]),
    state: String(row["state"]) as RuleIntent["state"],
    failure: nullableText(row["failure"]),
    summary: nullableText(row["summary"]),
    model: nullableText(row["model"]),
    thinkingLevel: nullableText(row["thinking_level"]) as ThinkingLevel | null,
    traceTaskId: row["trace_task_id"] === null ? null : Number(row["trace_task_id"]),
    produced:
      produced === null || produced === undefined
        ? { proposalIds: [], draftItemIds: [] }
        : (JSON.parse(String(produced)) as RuleIntent["produced"]),
    startedAt: String(row["started_at"]),
    finishedAt: nullableText(row["finished_at"]),
  };
}

/** 打开当前 schema；schema-v0 数据库开不起来。 */
/**
 * 进程内按连接串共用的连接池(ADR 0036)。`openStore` 每次给回一份门面,底下永远是同一个池
 * ——「每请求开一次库、用完关掉」的形状到此退役,`(await store.close())` 因此也不再关任何东西。
 * 池由 `closeStorePools()` 关:服务退出时一次,测试每个文件收尾时一次。
 */
const pools = new Map<string, PgPool>();

export function storePool(databaseUrl: string): PgPool {
  const existing = pools.get(databaseUrl);
  if (existing !== undefined) return existing;
  const pool = createPool(databaseUrl);
  pools.set(databaseUrl, pool);
  return pool;
}

/** 关掉一个连接池。测试收尾要它:还连着的库 DROP 不掉。 */
export async function closeStorePool(databaseUrl: string): Promise<void> {
  const pool = pools.get(databaseUrl);
  if (pool === undefined) return;
  pools.delete(databaseUrl);
  await pool.end();
}

/** 关掉这个进程开过的全部连接池。不关的话事件循环上还挂着空闲连接,进程不退出。 */
export async function closeStorePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map(async (pool) => await pool.end()));
}

/**
 * 跑迁移(ADR 0036)。服务在开始监听之前执行它,失败即拒绝启动:schema 与代码对不上时,
 * 起得来却每一条查询都报错比起不来更难查。迁移文件在版本库的 `drizzle/` 下,由
 * `pnpm drizzle-kit generate` 按 `src/review/schema/` 生成。
 */
export async function migrateStore(databaseUrl: string): Promise<void> {
  const pool = storePool(databaseUrl);
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)),
  });
}

/**
 * 有 `id` 列的表。`store/pg.ts` 按它给插入自动补 `RETURNING id`(PostgreSQL 没有
 * `lastInsertRowid`)。从 schema 现算,不另维护清单。
 */
const TABLES_WITH_ID = new Set(
  Object.values(schema)
    .filter((value) => is(value, PgTable))
    .filter((table) => "id" in getTableColumns(table))
    .map((table) => getTableName(table)),
);

export function openStore(databaseUrl: string): Store {
  const pool = storePool(databaseUrl);
  const { db, orm, transaction } = storeDb(pool, TABLES_WITH_ID);
  const base = { db, orm, transaction, store: () => store };
  const ctx: StoreContext = { ...base, ...storeHelpers(base) };
  const {
    parseAuxiliaryModel,
    repoExists,
    activeRule,
    insertReviewRule,
    ruleTaskRunning,
    completeRuleExploration,
    insertRuleProposalSource,
    insertRuleProposal,
    pendingProposal,
    plannedAcceptance,
    applyAcceptance,
    rejectProposalRow,
    retireRuleRow,
    inRuleSetVersion,
  } = ctx;

  /*
   * 各域的接入点(spec #445 第二段)。账号域已经搬走,其余六域的方法还在下面这个字面量里;
   * #451–#457 各把自己那一域搬进 `store/<域>.ts`,然后**只**把自己那一行的注释换成
   * `...xMethods(ctx),`。顺序固定,六票因此各改各的一行,合并时不互相冲突。
   */
  const store: Store = {
    // 面板账号域(角色、用户、会话、仓库分配)已迁 Drizzle,见 `./accounts.ts`。
    ...accountsMethods(ctx),
    // 仓库域(注册表、仓库配置、审查策略、模型服务与凭据)已迁 Drizzle,见 `./repos.ts`。
    ...reposMethods(ctx),
    // #452 Review Run / Finding / 轨迹:...runsMethods(ctx),
    ...stagesMethods(ctx),
    // #454 知识集 / 探索 / 提案 / 意图:...knowledgeMethods(ctx),
    ...productsMethods(ctx),
    ...sessionsMethods(ctx),

    async getRuleSet(repoId) {
      if (!(await repoExists(repoId))) return undefined;
      const version = (await db
        .prepare("SELECT MAX(version) AS version FROM rule_set_version WHERE repo_id = ?")
        .get(repoId))?.["version"];
      const select = async (where: string): Promise<ReviewRuleRecord[]> =>
        (await db
          .prepare(
            `SELECT id, type, scope, statement, origin
               FROM review_rule
              WHERE repo_id = ? AND ${where}
              ORDER BY id`,
          )
          .all(repoId))
          .map((row) => ({
            id: Number(row["id"]),
            type: String(row["type"]) as KnowledgeType,
            scope: String(row["scope"]),
            statement: String(row["statement"]),
            origin: String(row["origin"]),
          }));
      return {
        version: version === null || version === undefined ? null : Number(version),
        rules: await select("retired_version IS NULL"),
        retired: await select("retired_version IS NOT NULL"),
      };
    },

    async retireReviewRule(repoId, ruleId) {
      if ((await activeRule(repoId, ruleId)) === undefined) return undefined;
      return (await inRuleSetVersion(repoId, async (version) => {
        await retireRuleRow(ruleId, version);
        return version;
      }));
    },

    async getRuleExploration(repoId) {
      const row = (await db
        .prepare(
          `SELECT baseline_sha, model, thinking_level, trace_task_id, state, failure,
                  started_at, finished_at
             FROM rule_exploration WHERE repo_id = ?`,
        )
        .get(repoId));
      if (row === undefined) return null;
      const failure = row["failure"];
      const finishedAt = row["finished_at"];
      const thinkingLevel = row["thinking_level"];
      const traceTaskId = row["trace_task_id"];
      return {
        state: String(row["state"]) as RuleExploration["state"],
        baselineSha: String(row["baseline_sha"]),
        model: String(row["model"]),
        thinkingLevel:
          thinkingLevel === null || thinkingLevel === undefined
            ? null
            : (String(thinkingLevel) as ThinkingLevel),
        traceTaskId:
          traceTaskId === null || traceTaskId === undefined ? null : Number(traceTaskId),
        failure: failure === null || failure === undefined ? null : String(failure),
        startedAt: String(row["started_at"]),
        finishedAt: finishedAt === null || finishedAt === undefined ? null : String(finishedAt),
      };
    },

    async startRuleExploration(repoId, run) {
      if (!(await repoExists(repoId)) || (await ruleTaskRunning(repoId))) return false;
      (await db.prepare(
        `INSERT INTO rule_exploration
           (repo_id, baseline_sha, model, thinking_level, trace_task_id,
            state, failure, started_at, finished_at)
         VALUES (?, ?, ?, ?, NULL, 'running', NULL, ?, NULL)
         ON CONFLICT(repo_id) DO UPDATE SET
           baseline_sha = excluded.baseline_sha,
           model = excluded.model,
           thinking_level = excluded.thinking_level,
           trace_task_id = NULL,
           state = 'running',
           failure = NULL,
           started_at = excluded.started_at,
           finished_at = NULL`,
      ).run(repoId, run.baselineSha, run.model, run.thinkingLevel ?? null, run.startedAt));
      return true;
    },

    async finishRuleExploration(repoId, items, at) {
      await transaction("deferred", async () => {
        // 整组覆盖:草案每仓库至多一份,重探索的产出取代未确认的旧草案(含人手加的条目)。
        (await db.prepare("DELETE FROM rule_draft_item WHERE repo_id = ?").run(repoId));
        const insert = db.prepare(
          `INSERT INTO rule_draft_item (repo_id, type, scope, statement, layer, origin, created_at)
           VALUES (?, ?, ?, ?, '', ?, ?)`,
        );
        for (const item of items) {
          (await insert.run(
            repoId,
            item.type,
            item.scope,
            item.statement,
            BASELINE_EXPLORATION_RULE_ORIGIN,
            at,
          ));
        }
        (await completeRuleExploration(repoId, at));
      });
    },

    async finishRuleExplorationAsProposals(repoId, proposals, at) {
      await transaction("deferred", async () => {
        // 与草案同一条覆盖语义:一次基点探索是对照当前知识集的完整推导,新一次的未裁决
        // 产出取代上一次的,不是追加。只覆盖出处附注全部来自基点探索的待裁决行(issue
        // #281):已裁决的留作历史;带处置反哺或知识整理附注的那些里有人写下的意见,
        // 探索重跑推不出它们,一次重探索不该把它们抹掉。
        const replaced = `SELECT id FROM rule_proposal
                           WHERE repo_id = ? AND state = 'pending'
                             AND NOT EXISTS (SELECT 1 FROM rule_proposal_source s
                                              WHERE s.proposal_id = rule_proposal.id
                                                AND s.origin <> 'baseline-exploration')`;
        (await db.prepare(
          `DELETE FROM rule_proposal_source WHERE proposal_id IN (${replaced})`,
        ).run(repoId));
        (await db.prepare(`DELETE FROM rule_proposal WHERE id IN (${replaced})`).run(repoId));
        for (const item of proposals) (await insertRuleProposal(repoId, item, at));
        (await completeRuleExploration(repoId, at));
      });
    },

    async failRuleExploration(repoId, failure, at) {
      (await db.prepare(
        "UPDATE rule_exploration SET state = 'failed', failure = ?, finished_at = ? WHERE repo_id = ?",
      ).run(failure, at, repoId));
    },

    async failInterruptedRuleExplorations(failure, at) {
      (await db.prepare(
        `UPDATE rule_exploration
            SET state = 'failed', failure = ?, finished_at = ?
          WHERE state = 'running'`,
      ).run(failure, at));
    },

    async getRuleConsolidation(repoId) {
      const row = (await db
        .prepare(
          `SELECT model, thinking_level, trace_task_id, state, failure, merged, retargeted,
                  proposed, started_at, finished_at
             FROM rule_consolidation WHERE repo_id = ?`,
        )
        .get(repoId));
      if (row === undefined) return null;
      const nullable = (value: unknown): number | null =>
        value === null || value === undefined ? null : Number(value);
      const thinkingLevel = row["thinking_level"];
      const failure = row["failure"];
      const finishedAt = row["finished_at"];
      return {
        state: String(row["state"]) as RuleConsolidation["state"],
        model: String(row["model"]),
        thinkingLevel:
          thinkingLevel === null || thinkingLevel === undefined
            ? null
            : (String(thinkingLevel) as ThinkingLevel),
        traceTaskId: nullable(row["trace_task_id"]),
        failure: failure === null || failure === undefined ? null : String(failure),
        merged: nullable(row["merged"]),
        retargeted: nullable(row["retargeted"]),
        proposed: nullable(row["proposed"]),
        startedAt: String(row["started_at"]),
        finishedAt: finishedAt === null || finishedAt === undefined ? null : String(finishedAt),
      };
    },

    async startRuleConsolidation(repoId, run) {
      if (!(await repoExists(repoId)) || (await ruleTaskRunning(repoId))) return false;
      (await db.prepare(
        `INSERT INTO rule_consolidation
           (repo_id, model, thinking_level, trace_task_id, state, failure, merged, retargeted,
            proposed, started_at, finished_at)
         VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL, ?, NULL)
         ON CONFLICT(repo_id) DO UPDATE SET
           model = excluded.model,
           thinking_level = excluded.thinking_level,
           trace_task_id = NULL,
           state = 'running',
           failure = NULL,
           merged = NULL,
           retargeted = NULL,
           proposed = NULL,
           started_at = excluded.started_at,
           finished_at = NULL`,
      ).run(repoId, run.model, run.thinkingLevel ?? null, run.startedAt));
      return true;
    },

    async finishRuleConsolidation(repoId, summary, at) {
      (await db.prepare(
        `UPDATE rule_consolidation
            SET state = 'completed', failure = NULL, merged = ?, retargeted = ?, proposed = ?,
                finished_at = ?
          WHERE repo_id = ?`,
      ).run(summary.merged, summary.retargeted, summary.proposed, at, repoId));
    },

    async failRuleConsolidation(repoId, failure, at) {
      (await db.prepare(
        "UPDATE rule_consolidation SET state = 'failed', failure = ?, finished_at = ? WHERE repo_id = ?",
      ).run(failure, at, repoId));
    },

    async failInterruptedRuleConsolidations(failure, at) {
      (await db.prepare(
        `UPDATE rule_consolidation
            SET state = 'failed', failure = ?, finished_at = ?
          WHERE state = 'running'`,
      ).run(failure, at));
    },

    async listRuleIntents(repoId) {
      return (await db
        .prepare(
          `${RULE_INTENT_COLUMNS}
             WHERE repo_id = ?
             ORDER BY state = 'completed', started_at DESC, id DESC`,
        )
        .all(repoId))
        .map(toRuleIntent);
    },

    async getRuleIntent(repoId, intentId) {
      const row = (await db
        .prepare(`${RULE_INTENT_COLUMNS} WHERE id = ? AND repo_id = ?`)
        .get(intentId, repoId));
      return row === undefined ? null : toRuleIntent(row);
    },

    async hasRunningRuleIntent(repoId, targetKind, targetId) {
      const row = (await db
        .prepare(
          `SELECT 1 FROM rule_intent
            WHERE repo_id = ? AND state = 'running' AND target_kind = ? AND target_id = ?
            LIMIT 1`,
        )
        .get(repoId, targetKind, targetId));
      return row !== undefined;
    },

    async startRuleIntent(repoId, intent) {
      if (!(await repoExists(repoId))) return undefined;
      const inserted = (await db
        .prepare(
          `INSERT INTO rule_intent
             (repo_id, text, submitted_by, target_kind, target_id, state, failure, summary,
              model, thinking_level, trace_task_id, produced_json, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, NULL, NULL, ?, NULL)`,
        )
        .run(
          repoId,
          intent.text,
          intent.submittedBy,
          intent.targetKind,
          intent.targetId,
          intent.model,
          intent.thinkingLevel ?? null,
          intent.startedAt,
        ));
      return (await store.getRuleIntent(repoId, Number(inserted.lastInsertRowid))) ?? undefined;
    },

    async setRuleIntentTrace(intentId, taskId) {
      (await db.prepare("UPDATE rule_intent SET trace_task_id = ? WHERE id = ?").run(taskId, intentId));
    },

    async finishRuleIntent(intentId, outcome, at) {
      (await db.prepare(
        `UPDATE rule_intent
            SET state = 'completed', failure = NULL, summary = ?, produced_json = ?,
                finished_at = ?
          WHERE id = ?`,
      ).run(outcome.summary, JSON.stringify(outcome.produced), at, intentId));
    },

    async failRuleIntent(intentId, failure, at) {
      (await db.prepare(
        "UPDATE rule_intent SET state = 'failed', failure = ?, finished_at = ? WHERE id = ?",
      ).run(failure, at, intentId));
    },

    async failInterruptedRuleIntents(failure, at) {
      (await db.prepare(
        `UPDATE rule_intent
            SET state = 'failed', failure = ?, finished_at = ?
          WHERE state = 'running'`,
      ).run(failure, at));
    },

    async deleteRuleIntent(repoId, intentId) {
      const intent = (await store.getRuleIntent(repoId, intentId));
      if (intent === null) return "missing";
      if (intent.state === "running") return "running";
      (await db.prepare("DELETE FROM rule_intent WHERE id = ?").run(intentId));
      return "deleted";
    },

    async rerunRuleIntent(repoId, intentId, run) {
      const result = (await db
        .prepare(
          `UPDATE rule_intent
              SET state = 'running', failure = NULL, summary = NULL, produced_json = NULL,
                  trace_task_id = NULL, finished_at = NULL,
                  model = ?, thinking_level = ?, started_at = ?
            WHERE id = ? AND repo_id = ? AND state = 'failed'`,
        )
        .run(run.model, run.thinkingLevel ?? null, run.startedAt, intentId, repoId));
      if (Number(result.changes) === 0) return undefined;
      return (await store.getRuleIntent(repoId, intentId)) ?? undefined;
    },

    async mergeRuleProposals(repoId, proposalIds, statement) {
      const unique = [...new Set(proposalIds)];
      const merged = statement.trim();
      if (unique.length < 2 || merged === "") return false;
      const pending = (await store.getRuleProposals(repoId)).filter((row) => row.state === "pending");
      const rows = unique.map((id) => pending.find((row) => row.id === id));
      if (rows.some((row) => row === undefined)) return false;
      // 合并的对象是重复:变更类型、目标条目与知识型三样都一样才算同一件事。
      const first = rows[0]!;
      if (
        rows.some(
          (row) =>
            row!.change !== first.change ||
            JSON.stringify(row!.targetRuleIds) !== JSON.stringify(first.targetRuleIds) ||
            row!.type !== first.type,
        )
      ) {
        return false;
      }
      const keep = Math.min(...unique);
      const dropped = unique.filter((id) => id !== keep);
      const holes = dropped.map(() => "?").join(", ");
      await transaction("deferred", async () => {
        // 附注并入保留行:一条提案的出处是它被哪几件事提过,合并不该把其中几件丢掉。
        (await db.prepare(
          `UPDATE rule_proposal_source SET proposal_id = ? WHERE proposal_id IN (${holes})`,
        ).run(keep, ...dropped));
        (await db.prepare(`DELETE FROM rule_proposal WHERE id IN (${holes})`).run(...dropped));
        (await db.prepare("UPDATE rule_proposal SET statement = ? WHERE id = ?").run(merged, keep));
      });
      return true;
    },

    async retargetRuleProposal(repoId, proposalId, targetRuleId) {
      const queued = (await pendingProposal(repoId, proposalId));
      if (queued === undefined || queued.change !== "add") return false;
      const target = (await activeRule(repoId, targetRuleId));
      if (target === undefined || target.type !== queued.type) return false;
      (await db.prepare(
        "UPDATE rule_proposal SET change = 'modify', target_rule_ids = ? WHERE id = ?",
      ).run(JSON.stringify([targetRuleId]), proposalId));
      return true;
    },

    async getRuleDraft(repoId) {
      return (await db
        .prepare(
          `SELECT id, type, scope, statement, origin
             FROM rule_draft_item WHERE repo_id = ? ORDER BY id`,
        )
        .all(repoId))
        .map((row) => ({
          id: Number(row["id"]),
          type: String(row["type"]) as KnowledgeType,
          scope: String(row["scope"]),
          statement: String(row["statement"]),
          origin: String(row["origin"]),
        }));
    },

    async appendRuleDraftItems(repoId, items, at) {
      if (!(await repoExists(repoId))) return [];
      const insert = db.prepare(
        `INSERT INTO rule_draft_item (repo_id, type, scope, statement, layer, origin, created_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
      );
      const ids: number[] = [];
      for (const item of items) {
        ids.push(
          Number(
            (await insert.run(
              repoId,
              item.type,
              item.scope,
              item.statement,
              MANUAL_PROPOSAL_RULE_ORIGIN,
              at,
            )).lastInsertRowid,
          ),
        );
      }
      return ids;
    },

    async updateRuleDraftItem(repoId, itemId, input) {
      // 出处沿用旧值,SQL 不碰 origin 这一列。
      const changed = (await db
        .prepare(
          "UPDATE rule_draft_item SET type = ?, scope = ?, statement = ? WHERE id = ? AND repo_id = ?",
        )
        .run(input.type, input.scope, input.statement, itemId, repoId));
      return changed.changes > 0;
    },

    async deleteRuleDraftItem(repoId, itemId) {
      const deleted = (await db
        .prepare("DELETE FROM rule_draft_item WHERE id = ? AND repo_id = ?")
        .run(itemId, repoId));
      return deleted.changes > 0;
    },

    async confirmRuleDraft(repoId, itemIds) {
      if (!(await repoExists(repoId))) return undefined;
      const draft = (await store.getRuleDraft(repoId));
      // 勾选里有一条不在草案里就整次不做:一份过期的勾选不该悄悄确认成另一组条目。
      const selected =
        itemIds === undefined
          ? draft
          : itemIds.map((id) => draft.find((item) => item.id === id));
      if (selected.some((item) => item === undefined)) return undefined;
      // 空知识集是合法状态(issue #200):还没确认过的仓库确认空草案就是在说「这个仓库
      // 没有知识条目」,照样生成一个版本,门禁随之放行。已确认的仓库拿空的一组再确认只会
      // 白推一版,那时回 undefined。
      if (selected.length === 0 && (await store.getRuleSet(repoId))?.version !== null) {
        return undefined;
      }
      return (await inRuleSetVersion(repoId, async (version, at) => {
        for (const item of selected) {
          await insertReviewRule(repoId, item!, item!.origin, version, at);
        }
        // 没勾选的随草案一并丢弃:草案是一次性的那一份,确认完就不剩什么了。
        (await db.prepare("DELETE FROM rule_draft_item WHERE repo_id = ?").run(repoId));
        return version;
      }));
    },

    async getRuleProposals(repoId) {
      // 附注一次查完再按提案分组:队列一屏几十条,逐条再查一次附注就是几十次往返。
      // Finding 的阶段标识在这一句里算出来(与评审记录同一个字面形状),面板据此开侧滑。
      const sources = new Map<number, RuleProposalSource[]>();
      for (const row of (await db
        .prepare(
          `SELECT s.id, s.proposal_id, s.origin, s.note, s.evidence, s.finding_id,
                  s.trace_task_id, s.created_at,
                  ${STAGE_ID_FROM_RUN} AS finding_stage_id
             FROM rule_proposal_source s
             JOIN rule_proposal p ON p.id = s.proposal_id
             LEFT JOIN finding f ON f.id = s.finding_id
             LEFT JOIN review_run run ON run.id = f.run_id
            WHERE p.repo_id = ? ORDER BY s.id`,
        )
        .all(repoId))) {
        const proposalId = Number(row["proposal_id"]);
        const list = sources.get(proposalId) ?? [];
        list.push({
          id: Number(row["id"]),
          origin: String(row["origin"]) as RuleProposalOrigin,
          note: row["note"] === null ? null : String(row["note"]),
          evidence: row["evidence"] === null ? null : String(row["evidence"]),
          findingId: row["finding_id"] === null ? null : Number(row["finding_id"]),
          findingStageId:
            row["finding_stage_id"] === null ? null : String(row["finding_stage_id"]),
          traceTaskId: row["trace_task_id"] === null ? null : Number(row["trace_task_id"]),
          createdAt: String(row["created_at"]),
        });
        sources.set(proposalId, list);
      }
      return (await db
        .prepare(
          `SELECT id, type, change, target_rule_ids, scope, statement, state, created_at,
                  decided_at
             FROM rule_proposal WHERE repo_id = ? ORDER BY id`,
        )
        .all(repoId))
        .map((row) => ({
          id: Number(row["id"]),
          type: String(row["type"]) as KnowledgeType,
          change: String(row["change"]) as RuleProposalChange,
          targetRuleIds: JSON.parse(String(row["target_rule_ids"])) as number[],
          scope: String(row["scope"]),
          statement: String(row["statement"]),
          sources: sources.get(Number(row["id"])) ?? [],
          state: String(row["state"]) as RuleProposal["state"],
          createdAt: String(row["created_at"]),
          decidedAt: row["decided_at"] === null ? null : String(row["decided_at"]),
        }));
    },

    async addRuleProposal(repoId, input) {
      if (!(await repoExists(repoId))) return undefined;
      return (await insertRuleProposal(repoId, input, new Date().toISOString()));
    },

    async mergeIntoRuleProposal(repoId, proposalId, merge) {
      // 已裁决的、不在这个仓库的、根本不存在的都并不进去:那一条退回按新增处理。
      const queued = (await pendingProposal(repoId, proposalId));
      if (queued === undefined) return false;
      const at = new Date().toISOString();
      // 型规则(CONTEXT.md 修订提案,issue #295):修改型要换型即改成指向同一条目标的
      // 单目标合并——修改那一档不许翻型,而改型正是这一次改写的意图。新增型与合并型的
      // 变更类型不动,型直接换。
      const change =
        merge.type !== undefined && merge.type !== queued.type && queued.change === "modify"
          ? "merge"
          : queued.change;
      await transaction("deferred", async () => {
        // 陈述与附注必须一起落:换了陈述没留下附注,队列里那一条就说不出它是被哪两次
        // 备注合起来的。
        (await db.prepare(
          "UPDATE rule_proposal SET statement = ?, scope = ?, type = ?, change = ? WHERE id = ?",
        ).run(
          merge.statement,
          merge.scope ?? queued.scope,
          merge.type ?? queued.type,
          change,
          proposalId,
        ));
        (await insertRuleProposalSource(proposalId, merge.source, at));
      });
      return true;
    },

    async acceptRuleProposal(repoId, proposalId) {
      const planned = (await plannedAcceptance(repoId, proposalId));
      if (planned === undefined) return undefined;
      return (await inRuleSetVersion(repoId, async (version, at) => {
        await applyAcceptance(repoId, planned, version, at);
        return version;
      }));
    },

    async acceptRuleProposals(repoId, proposalIds) {
      // 空的一组不推版:没有要采纳的东西,一个空版本只会让版本轴多一格看不出来历的。
      // 同一条报两遍同样拒:它会被落两遍,而人真正想说的是「这几条」。
      if (proposalIds.length === 0 || new Set(proposalIds).size !== proposalIds.length) {
        return undefined;
      }
      // 先全部算一遍再落:全成或全不成。部分成功会让人对着一份说不清哪些落了的队列继续裁决。
      const planned: (PlannedAcceptance | undefined)[] = [];
      for (const id of proposalIds) planned.push(await plannedAcceptance(repoId, id));
      if (planned.some((entry) => entry === undefined)) return undefined;
      // 组内两条指向同一个目标同样整组不做。判据是「目标此刻还生效吗」,而它对整组只算
      // 一次:两条 modify 会把旧行废止一次、新行插两遍,一条规则就此裂成两条;modify 与
      // retire 撞上,废止的意图会被修改插回的新行抵消。逐条采纳没有这个洞——第一条落完
      // 目标就废止了,第二条自然裁不了;批量要人自己挑一条,而不是替他挑。
      const targets = planned.flatMap((entry) => [...entry!.queued.targetRuleIds]);
      if (new Set(targets).size !== targets.length) return undefined;
      return (await inRuleSetVersion(repoId, async (version, at) => {
        // 全组共用同一个版本号(issue #223):逐条各推一版会让一次裁决在版本轴上散成上百格。
        for (const entry of planned) await applyAcceptance(repoId, entry!, version, at);
        return version;
      }));
    },

    async rejectRuleProposal(repoId, proposalId) {
      if ((await pendingProposal(repoId, proposalId)) === undefined) return false;
      (await rejectProposalRow(proposalId, new Date().toISOString()));
      return true;
    },

    async rejectRuleProposals(repoId, proposalIds) {
      if (proposalIds.length === 0 || new Set(proposalIds).size !== proposalIds.length) {
        return false;
      }
      // 与批量采纳同一条口径:先全部认一遍,有一条不在待裁决队列里就一条都不改。
      for (const id of proposalIds) {
        if ((await pendingProposal(repoId, id)) === undefined) return false;
      }
      const at = new Date().toISOString();
      // 一组状态一起落:「一条都不改」这句话要成立,中途出错时已经改掉的那几条得退回去。
      await transaction("deferred", async () => {
        for (const id of proposalIds) (await rejectProposalRow(id, at));
      });
      return true;
    },

    async startRun(meta) {
      return transaction("deferred", async () => {
        const rangeReviewId = meta.rangeReviewId ?? null;
        // PR 状态属于整个审查阶段。closed/reopened 会改写该 PR 的全部历史行;新轮次在
        // 同一事务里继承当前值,手动重跑已关闭 PR 时不能凭一行 NULL 把阶段改回进行中。
        const pullRequestState =
          rangeReviewId === null &&
          (await db.prepare(
            `SELECT 1
               FROM review_run
              WHERE owner = ? AND repo = ? AND pull_number = ?
                AND range_review_id IS NULL AND pr_state = 'closed'
              LIMIT 1`,
          ).get(meta.owner, meta.repo, meta.pullNumber)) !== undefined
            ? "closed"
            : null;
        const result = (await db
          .prepare(
            `INSERT INTO review_run
               (owner, repo, pull_number, head_sha, title, range_review_id, pr_state,
                triggered_by, trigger_source, started_at, changed_files, changed_lines,
                batch_count, rule_set_version, directive, mode, history_json, batch_plan_json,
                min_report_severity, auxiliary_model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            meta.owner,
            meta.repo,
            meta.pullNumber,
            meta.headSha,
            meta.title ?? null,
            rangeReviewId,
            pullRequestState,
            meta.triggeredBy ?? null,
            // 触发来源(issue #312):调用方说了算,不从用户名快照推——定时那一档也没有
            // 用户名,推出来的会是投递。
            meta.triggerSource ?? "delivery",
            meta.startedAt,
            meta.changedFiles,
            meta.changedLines,
            meta.batchCount,
            meta.ruleSetVersion ?? null,
            meta.directive ?? null,
            meta.mode ?? "full",
            // 历史快照随开跑落库(issue #248):续跑的批次读它,重启期间的处置不改变
            // 这一轮各批看到的历史。
            meta.history === undefined ? null : JSON.stringify(meta.history),
            // 完整批次计划同一次写下(issue #253):任何批次完成之前它就在,第一批就崩的
            // 轮次续跑时也有完整的核对依据。
            meta.batches === undefined ? null : JSON.stringify(meta.batches),
            // 开跑时的阈值随这一轮落库(issue #271):之后改设置追不上已经开跑的它。
            meta.minReportSeverity ?? DEFAULT_MIN_REPORT_SEVERITY,
            // 开跑时解析出的辅助模型同一次写下(issue #304):合并 agent 用哪一处模型
            // 由这一行说了算,续跑读它。
            meta.auxiliaryModel == null ? null : JSON.stringify(meta.auxiliaryModel),
          ));
        const runId = Number(result.lastInsertRowid);
        const insertPin = db.prepare(
          `INSERT INTO review_run_reviewer_pin
             (run_id, position, identity, provider, model, model_service_version,
              base_url, api, runtime_model_json, materialization_failure, thinking_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [position, pin] of meta.reviewerPins.entries()) {
          (await insertPin.run(
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
            pin.thinkingLevel,
          ));
        }
        return runId;
      });
    },

    async failInterruptedRuns(failure, at, runIds) {
      // `runIds` 缺省即全部停在运行中的轮次;给了就只认这几个 id,其余照旧不动
      // (issue #248:续跑不成立的那些逐轮改判,正在续跑的那些不能被一并扫掉)。
      const scope =
        runIds === undefined
          ? ""
          : ` AND id IN (${runIds.map(() => "?").join(", ") || "NULL"})`;
      const params = runIds === undefined ? [] : [...runIds];
      const rows = (await db
        .prepare(
          `SELECT id, owner, repo, pull_number FROM review_run
            WHERE finished_at IS NULL${scope}`,
        )
        .all(...params));
      // 没有中断轮次时一个写都不发:启动路径因此零改动,调用方也不去问 Forge。
      if (rows.length === 0) return [];
      // 一句原因落两处,先定形再写(issue #436):轮次那一列与借来的 outcome 行说的是
      // 同一件事,兜底只在其中一处时两边会说不一样的话。
      const text = runFailureText(failure);
      await transaction("deferred", async () => {
        // 失败原因借 Reviewer 指定各写一行 outcome:计数与耗时都归零,这一轮它们
        // 什么都没跑完。
        const insertOutcome = db.prepare(
          `INSERT INTO reviewer_outcome
             (run_id, model, failure, finding_count, anomaly_count,
              rejected_tool_calls, anchor_rejections, duration_ms)
           VALUES (?, ?, ?, 0, 0, 0, 0, 0)`,
        );
        const pins = db.prepare(
          "SELECT identity FROM review_run_reviewer_pin WHERE run_id = ? ORDER BY position",
        );
        for (const row of rows) {
          for (const pin of (await pins.all(row["id"] as number))) {
            (await insertOutcome.run(row["id"] as number, String(pin["identity"]), text));
          }
        }
        // 结束时间取启动时刻。耗时留空:进程什么时候落地的没人知道,写一个算出来的
        // 数字就是编。同一句原因也写进轮次级那一列(ADR 0026):零 pin 的轮次没有
        // outcome 行可借,原因只在这里读得到。
        (await db.prepare(
          `UPDATE review_run SET finished_at = ?, failed = true, failure = ?
            WHERE finished_at IS NULL${scope}`,
        ).run(at, text, ...params));
        // 改判掉的那些轮次不会再被续跑,中间态的批次结果一并清掉(issue #248)。
        const deleteBatches = db.prepare("DELETE FROM review_run_batch_outcome WHERE run_id = ?");
        for (const row of rows) (await deleteBatches.run(row["id"] as number));
      });
      return rows.map((row) => ({
        runId: Number(row["id"]),
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        pullNumber: Number(row["pull_number"]),
      }));
    },

    async recordRunFailure(runId, failure) {
      (await db.prepare("UPDATE review_run SET failure = ? WHERE id = ?").run(
        runFailureText(failure),
        runId,
      ));
    },

    async interruptedRuns() {
      return (await db
        .prepare(
          `SELECT id, owner, repo, pull_number, head_sha, range_review_id, directive,
                  mode, triggered_by, auxiliary_model
             FROM review_run WHERE finished_at IS NULL ORDER BY id`,
        )
        .all())
        .map((row) => ({
          runId: Number(row["id"]),
          owner: String(row["owner"]),
          repo: String(row["repo"]),
          pullNumber: Number(row["pull_number"]),
          headSha: String(row["head_sha"]),
          rangeReviewId: row["range_review_id"] === null ? null : Number(row["range_review_id"]),
          directive: row["directive"] === null ? null : String(row["directive"]),
          // 升级前的旧行没有这一列,读回按完整审查算,与 `listRuns` 同一读法。
          mode: (row["mode"] === null ? "full" : String(row["mode"])) as ReviewRunMode,
          triggeredBy: row["triggered_by"] === null ? null : String(row["triggered_by"]),
          // 冻结的那一处辅助模型(issue #304):续跑的合并 agent 按它建,不重新解析。
          auxiliaryModel: parseAuxiliaryModel(
            row["auxiliary_model"] === null ? null : String(row["auxiliary_model"]),
          ),
        }));
    },

    async recordBatchOutcome(runId, batchIndex, model, outcome) {
      (await db.prepare(
        `INSERT INTO review_run_batch_outcome (run_id, batch_index, model, outcome_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id, batch_index, model)
         DO UPDATE SET outcome_json = excluded.outcome_json`,
      ).run(runId, batchIndex, model, JSON.stringify(outcome)));
    },

    async resumeState(runId) {
      const run = (await db
        .prepare(
          `SELECT head_sha, rule_set_version, batch_count, history_json, batch_plan_json,
                  min_report_severity
             FROM review_run WHERE id = ?`,
        )
        .get(runId));
      if (run === undefined) return undefined;
      const rows = (await db
        .prepare(
          `SELECT batch_index, model, outcome_json FROM review_run_batch_outcome
            WHERE run_id = ? ORDER BY batch_index`,
        )
        .all(runId));
      // pin 与已落库的批次一起取(issue #248 的评审复核):第一批就崩的那种轮次一个批次
      // 都没有,模型组合换没换只有这几行说得出。
      const pins = (await db
        .prepare(
          "SELECT identity FROM review_run_reviewer_pin WHERE run_id = ? ORDER BY position",
        )
        .all(runId));
      // 逐行按批次归拢成「这一批哪几个模型已经有结果」(issue #410)。
      const batches = new Map<number, Map<string, TimedOutcome>>();
      for (const row of rows) {
        const index = Number(row["batch_index"]);
        const byModel = batches.get(index) ?? new Map<string, TimedOutcome>();
        byModel.set(String(row["model"]), JSON.parse(String(row["outcome_json"])) as TimedOutcome);
        batches.set(index, byModel);
      }
      return {
        headSha: String(run["head_sha"]),
        ruleSetVersion:
          run["rule_set_version"] === null ? null : Number(run["rule_set_version"]),
        // 升级前的旧行没有这一列,读回按全报算,与 `mode` 同律。
        minReportSeverity:
          readMinReportSeverity(
            run["min_report_severity"] === null ? undefined : String(run["min_report_severity"]),
          ) ?? DEFAULT_MIN_REPORT_SEVERITY,
        batchCount: Number(run["batch_count"]),
        plan:
          run["batch_plan_json"] === null
            ? undefined
            : (JSON.parse(String(run["batch_plan_json"])) as string[][]),
        reviewers: pins.map((pin) => String(pin["identity"])),
        history:
          run["history_json"] === null
            ? undefined
            : (JSON.parse(String(run["history_json"])) as HistoryFinding[]),
        batches,
      };
    },

    async finishRun(runId, result) {
      const rootCauseGroupIds: number[] = [];
      // 一次 Review Run 的收尾要么整体可见,要么整体不可见:半张表的 Finding
      // 会让事后的处置率统计算出偏低的分母。
      await transaction("deferred", async () => {
        // 本轮总量含合并 agent(issue #228):面板的花费数字要覆盖这一轮真的花掉的全部
        // token,而逐 Reviewer 那几行仍只有各自的会话——差额就是合并 agent。
        const runUsage = sumUsage([
          ...result.outcomes,
          ...(result.mergeUsage === undefined ? [] : [{ usage: result.mergeUsage }]),
        ]);
        (await db.prepare(
          `UPDATE review_run
              SET finished_at = ?, duration_ms = ?, failed = ?,
                  input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
                  cache_write_tokens = ?, total_tokens = ?
            WHERE id = ?`,
        ).run(
          result.finishedAt,
          result.durationMs,
          result.failed,
          ...usageColumns(runUsage),
          runId,
        ));

        // 中间态的批次结果到这里就没用了(issue #248):收尾已经把合并后的结果落进
        // reviewer_outcome 与 finding,这张表只服务「还没收尾的那一轮」。
        (await db.prepare("DELETE FROM review_run_batch_outcome WHERE run_id = ?").run(runId));

        const insertOutcome = db.prepare(
          `INSERT INTO reviewer_outcome
             (run_id, model, failure, finding_count, anomaly_count,
              rejected_tool_calls, anchor_rejections, duration_ms,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              total_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const outcome of result.outcomes) {
          (await insertOutcome.run(
            runId,
            outcome.model,
            outcome.failure ?? null,
            outcome.findingCount,
            outcome.anomalyCount,
            outcome.rejectedToolCalls,
            outcome.anchorRejections,
            outcome.durationMs,
            ...usageColumns(outcome.usage),
          ));
        }

        const insertFinding = db.prepare(
          `INSERT INTO finding
             (run_id, file, line, title, severity, category, description,
              impact, suggestion,
              fingerprint, group_index, disposition, placement,
              comment_id, comment_html_url,
              line_author_sha, line_author_name, line_author_email, line_author_at,
              line_author_adjacent, rule_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertAttribution = db.prepare(
          `INSERT INTO finding_attribution
             (finding_id, position, model, severity, category, description, impact, suggestion)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertCarried = db.prepare(
          `INSERT INTO finding_carried_attribution
             (finding_id, position, model, run_id, description, impact, suggestion)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        // 同根因组的成员用最终落库的那一行(issue #308):合并组下标在这里换成刚插进去
        // 的 id。折叠到历史的那些成员直接给了历史行 id,不进这张表。
        const findingIdByGroup = new Map<number, number>();
        for (const finding of result.findings) {
          const inserted = (await insertFinding.run(
            runId,
            finding.file,
            finding.line,
            finding.title,
            finding.severity,
            finding.category,
            finding.description,
            finding.impact,
            finding.suggestion,
            finding.fingerprint ?? null,
            finding.groupIndex,
            finding.disposition,
            finding.placement,
            finding.commentId ?? null,
            finding.commentHtmlUrl ?? null,
            finding.lineAuthor?.sha ?? null,
            finding.lineAuthor?.name ?? null,
            finding.lineAuthor?.email ?? null,
            finding.lineAuthor?.authoredAt ?? null,
            finding.lineAuthor === undefined ? null : Number(finding.lineAuthor.adjacent),
            finding.ruleId ?? null,
          ));
          const findingId = Number(inserted.lastInsertRowid);
          findingIdByGroup.set(finding.groupIndex, findingId);
          for (const [position, said] of finding.attributions.entries()) {
            (await insertAttribution.run(
              findingId,
              position,
              said.model,
              said.severity,
              said.category,
              said.description,
              said.impact,
              said.suggestion,
            ));
          }
          for (const [position, said] of (finding.carried ?? []).entries()) {
            (await insertCarried.run(
              findingId,
              position,
              said.model,
              said.runId,
              said.description,
              said.impact,
              said.suggestion,
            ));
          }
        }

        // 复核结论逐条落库(ADR 0016)。漏给的那些由编排层按「无法判断」补齐并标
        // `missing`,这里只照写:裁决在编排层按同一批记录做完。
        const insertVerdict = db.prepare(
          `INSERT INTO finding_verdict (run_id, model, finding_id, verdict, missing, missing_reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const verdict of result.verdicts ?? []) {
          // 两列由同一格推出来:标记与由来因此不会各说各话。
          (await insertVerdict.run(
            runId,
            verdict.model,
            verdict.findingId,
            verdict.verdict,
            verdict.missing === undefined ? 0 : 1,
            verdict.missing ?? null,
          ));
        }

        // 同根因组(ADR 0030,issue #308):组与成员随这一笔事务一起落,组的 id 回给调用方
        // ——Forge 评论正文里「同根因另见 N 处」那一行要链到它。成员指不到落库行的直接跳过
        // (合并组被 diff 终筛丢掉之类):组只是多一层视图,少一个成员不该掀掉整轮收尾。
        const insertRootCause = db.prepare(
          "INSERT INTO root_cause_group (run_id, reason) VALUES (?, ?)",
        );
        const insertRootCauseMember = db.prepare(
          "INSERT INTO root_cause_group_member (group_id, finding_id, position) VALUES (?, ?, ?)",
        );
        for (const group of result.rootCauses ?? []) {
          const groupId = Number((await insertRootCause.run(runId, group.reason)).lastInsertRowid);
          rootCauseGroupIds.push(groupId);
          for (const [position, member] of group.members.entries()) {
            const findingId = findingIdByGroup.get(member);
            if (findingId === undefined) continue;
            (await insertRootCauseMember.run(groupId, findingId, position));
          }
        }

        // 折叠到已有 Forge 评论的行继承那条评论上一次处置的元数据(issue #152)。处置
        // 的载体是评论(ADR 0006),同一条评论名下的历史行与本轮新行说的是同一次处置:
        // 不继承的话备注与署名活不过下一轮,`disposed_at` 这个「这一行被显式处置过」
        // 的标记也会被新的一行稀释,自动处置于是又碰它一次(ADR 0016)。`disposition`
        // 不在此列——它由跨轮匹配与回填决定,口径不变。本轮新发的评论不必走这一步:
        // 它的 id 是新的,库里不会有同 id 的历史行,`recordFindingComments` 因此不动。
        (await db.prepare(
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
        ).run(runId));
      });
      return rootCauseGroupIds;
    },

    async rootCauseGroups(runId) {
      const rows = (await db
        .prepare(
          `SELECT g.id AS id, g.reason AS reason, m.finding_id AS finding_id
             FROM root_cause_group g
             JOIN root_cause_group_member m ON m.group_id = g.id
            WHERE g.run_id = ?
            ORDER BY g.id, m.position`,
        )
        .all(runId)) as unknown as Record<string, unknown>[];
      const byId = new Map<number, RootCauseGroup>();
      for (const row of rows) {
        const id = Number(row["id"]);
        const group = byId.get(id) ?? { id, reason: String(row["reason"]), findingIds: [] };
        group.findingIds.push(Number(row["finding_id"]));
        byId.set(id, group);
      }
      return [...byId.values()];
    },

    async stageHistory(scope) {
      const [where, params] = stageScope(scope);
      // 折叠键与处置率同源(`identityKey`):承载它的那条评论,没有载体的退回文件 + 指纹。
      // 每条 Identity 取最新那一行——它才带着当前的处置状态、备注与最新表述;同一处未
      // 改动代码上的两个不同问题因此各注入一条(ADR 0030),不再被指纹压成一条。
      // 最新一行是「已延续」的整条不注入:这处 Finding 已经交接到新位置,新位置那条
      // 自己在历史里,再给一遍就是同一个问题让模型复核两次。
      // 行号取当前位置(issue #368):本轮开跑时已经把它重定位到这一轮的 head 上,注入
      // 给 Reviewer 的必须是它此刻指着的那一行,而不是几轮之前被报出来时的那一行。
      const rows = (await db
        .prepare(
          `WITH scoped AS (
             SELECT f.id AS id, f.file AS file,
                    COALESCE(f.placed_line, f.line) AS line, f.title AS title,
                    f.severity AS severity, f.category AS category,
                    f.description AS description, f.disposition AS disposition,
                    f.disposition_note AS note,
                    ${identityKey("f.")} AS fp
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
        .all(...params));
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

    async relocationCandidates(scope) {
      const [where, params] = stageScope(scope);
      // 折叠与筛选与 `stageHistory` 逐字同源,只多一道「算得出指纹」:没有指纹的行
      // 找不回自己那扇窗口,重定位对它无从下手。
      const rows = (await db
        .prepare(
          `WITH scoped AS (
             SELECT f.id AS id, f.file AS file,
                    COALESCE(f.placed_line, f.line) AS line,
                    f.fingerprint AS fingerprint, f.disposition AS disposition,
                    ${identityKey("f.")} AS fp
               FROM finding f
               JOIN review_run run ON f.run_id = run.id
              WHERE ${where}
           )
           SELECT s.* FROM scoped s
            WHERE s.id = (SELECT MAX(latest.id) FROM scoped latest
                           WHERE latest.file = s.file AND latest.fp = s.fp)
              AND s.disposition <> 'continued'
              AND s.fingerprint IS NOT NULL
            ORDER BY s.id`,
        )
        .all(...params));
      return rows.map((row) => ({
        findingId: Number(row["id"]),
        file: String(row["file"]),
        line: Number(row["line"]),
        fingerprint: String(row["fingerprint"]),
      }));
    },

    async recordFindingRelocations(runId, placements) {
      const update = db.prepare(
        "UPDATE finding SET placed_line = ?, placed_run_id = ? WHERE id = ?",
      );
      for (const placement of placements) (await update.run(placement.line, runId, placement.findingId));
    },

    async listRepoFindings(query, limit) {
      const conditions = ["run.owner = ?", "run.repo = ?"];
      const params: (string | number)[] = [query.owner, query.repo];
      if (query.disposition !== undefined) {
        conditions.push("s.disposition = ?");
        params.push(query.disposition);
      }
      const rows = (await db
        .prepare(
          `WITH scoped AS (
             SELECT f.id AS id, f.file AS file, f.line AS line, f.title AS title,
                    f.severity AS severity, f.disposition AS disposition,
                    f.description AS description, f.impact AS impact,
                    f.suggestion AS suggestion,
                    ${identityKey("f.")} AS fp
               FROM finding f
               JOIN review_run run ON f.run_id = run.id
              WHERE run.owner = ? AND run.repo = ?
           )
           SELECT s.* FROM scoped s
            WHERE s.id = (SELECT MAX(latest.id) FROM scoped latest
                           WHERE latest.file = s.file AND latest.fp = s.fp)
              AND s.disposition <> 'continued'
              ${query.disposition === undefined ? "" : "AND s.disposition = ?"}
            ORDER BY s.id DESC`,
        )
        .all(...params));
      const matched =
        query.pathGlob === undefined
          ? rows
          : rows.filter((row) => matchesGlob(String(row["file"]), query.pathGlob!));
      return matched.slice(0, limit).map((row) => {
        const impact = row["impact"] === null ? undefined : String(row["impact"]);
        const suggestion = row["suggestion"] === null ? undefined : String(row["suggestion"]);
        return {
          file: String(row["file"]),
          line: Number(row["line"]),
          // 升级前的历史行没有标题,占位为空:与 `stageHistory` 同律。
          title: row["title"] === null ? "" : String(row["title"]),
          severity: String(row["severity"]) as Severity,
          disposition: String(row["disposition"]) as Disposition,
          description: String(row["description"]),
          ...(impact === undefined ? {} : { impact }),
          ...(suggestion === undefined ? {} : { suggestion }),
        };
      });
    },

    async pendingLineAuthors(scope) {
      const [where, params] = stageScope(scope);
      const rows = (await db
        .prepare(
          `SELECT f.id AS id, run.head_sha AS head_sha, f.file AS file, f.line AS line
             FROM finding f
             JOIN review_run run ON f.run_id = run.id
            WHERE ${where} AND f.line_author_sha IS NULL
            ORDER BY f.id`,
        )
        .all(...params));
      return rows.map((row) => ({
        findingId: Number(row["id"]),
        headSha: String(row["head_sha"]),
        file: String(row["file"]),
        line: Number(row["line"]),
      }));
    },

    async recordLineAuthors(authors) {
      const update = db.prepare(
        `UPDATE finding
            SET line_author_sha = ?, line_author_name = ?,
                line_author_email = ?, line_author_at = ?
          WHERE id = ? AND line_author_sha IS NULL`,
      );
      for (const entry of authors) {
        (await update.run(
          entry.lineAuthor.sha,
          entry.lineAuthor.name,
          entry.lineAuthor.email,
          entry.lineAuthor.authoredAt,
          entry.findingId,
        ));
      }
    },

    async recordFindingComments(runId, refs) {
      const update = db.prepare(
        `UPDATE finding SET comment_id = ?, comment_html_url = ?
          WHERE run_id = ? AND group_index = ?`,
      );
      // 一个合并组落成一条 Finding、一条评论:处置的载体就是它。
      for (const ref of refs) {
        (await update.run(ref.commentId, ref.commentHtmlUrl, runId, ref.groupIndex));
      }
    },

    async appendTrace(runId, event) {
      const at = new Date().toISOString();
      const payload = JSON.stringify(event.payload ?? null);
      const reviewer = event.reviewer ?? null;
      // 序号在这一句里算:子查询与插入在同一条语句内,SQLite 不会让两条并发的写拿到
      // 同一个号,先查后写才会。
      const inserted = (await db
        .prepare(
          `INSERT INTO review_trace (run_id, seq, at, scope, reviewer, kind, payload)
           VALUES (
             ?,
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM review_trace WHERE run_id = ?),
             ?, ?, ?, ?, ?
           )
           RETURNING seq`,
        )
        .get(runId, runId, at, event.scope, reviewer, event.kind, payload));
      const seq = Number(inserted?.["seq"]);
      return {
        seq,
        runId,
        at,
        scope: event.scope,
        ...(event.reviewer === undefined ? {} : { reviewer: event.reviewer }),
        kind: event.kind,
        payload: event.payload,
      };
    },

    async listTrace(runId, afterSeq) {
      const rows = (await db
        .prepare(
          `SELECT seq, at, scope, reviewer, kind, payload
             FROM review_trace
            WHERE run_id = ? AND seq > ?
            ORDER BY seq`,
        )
        .all(runId, afterSeq ?? 0));
      return rows.map((row) => ({
        seq: Number(row["seq"]),
        runId,
        at: String(row["at"]),
        scope: String(row["scope"]) as TraceScope,
        ...(row["reviewer"] === null ? {} : { reviewer: String(row["reviewer"]) }),
        kind: String(row["kind"]) as TraceKind,
        payload: JSON.parse(String(row["payload"])) as unknown,
      }));
    },

    async startRuleTrace(repoId, source, payload) {
      const at = new Date().toISOString();
      // 任务标识与序号在同一句里算:先查后写会让并发的两次任务拿到同一个号。
      const inserted = (await db
        .prepare(
          `INSERT INTO rule_trace (task_id, repo_id, source, seq, at, kind, payload)
           VALUES (
             (SELECT COALESCE(MAX(task_id), 0) + 1 FROM rule_trace),
             ?, ?, 1, ?, 'rule_agent_started', ?
           )
           RETURNING task_id`,
        )
        .get(repoId, source, at, JSON.stringify(payload ?? null)));
      return Number(inserted?.["task_id"]);
    },

    async appendRuleTrace(taskId, event) {
      const at = new Date().toISOString();
      const payload = JSON.stringify(event.payload ?? null);
      // repo_id 与 source 从这条轨迹的头一行抄:它们描述的是整条轨迹,逐行重复只是
      // 为了让可见性与级联删除各只读一张表。
      const inserted = (await db
        .prepare(
          `INSERT INTO rule_trace (task_id, repo_id, source, seq, at, kind, payload)
           SELECT ?, repo_id, source,
                  (SELECT COALESCE(MAX(seq), 0) + 1 FROM rule_trace WHERE task_id = ?),
                  ?, ?, ?
             FROM rule_trace WHERE task_id = ? ORDER BY seq LIMIT 1
           RETURNING seq`,
        )
        .get(taskId, taskId, at, event.kind, payload, taskId));
      return { seq: Number(inserted?.["seq"]), taskId, at, kind: event.kind, payload: event.payload };
    },

    async listRuleTrace(taskId, afterSeq) {
      return (await db
        .prepare(
          `SELECT seq, at, kind, payload
             FROM rule_trace
            WHERE task_id = ? AND seq > ?
            ORDER BY seq`,
        )
        .all(taskId, afterSeq ?? 0))
        .map((row) => ({
          seq: Number(row["seq"]),
          taskId,
          at: String(row["at"]),
          kind: String(row["kind"]) as RuleTraceKind,
          payload: JSON.parse(String(row["payload"])) as unknown,
        }));
    },

    async ruleTraceRepo(taskId) {
      const row = (await db.prepare("SELECT repo_id FROM rule_trace WHERE task_id = ? LIMIT 1").get(taskId));
      return row === undefined ? undefined : Number(row["repo_id"]);
    },

    async setRuleExplorationTrace(repoId, taskId) {
      (await db.prepare("UPDATE rule_exploration SET trace_task_id = ? WHERE repo_id = ?")
        .run(taskId, repoId));
    },

    async setRuleConsolidationTrace(repoId, taskId) {
      (await db.prepare("UPDATE rule_consolidation SET trace_task_id = ? WHERE repo_id = ?")
        .run(taskId, repoId));
    },

    async listRuns(opts) {
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
      if (opts.repos !== undefined) {
        const filter = repoPairCondition(opts.repos, "");
        conditions.push(filter.sql);
        params.push(...filter.params);
      }
      if (opts.id !== undefined) {
        conditions.push("id = ?");
        params.push(opts.id);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const runs = (await db
        .prepare(
          `SELECT id, owner, repo, pull_number, head_sha, title, range_review_id, triggered_by,
                  trigger_source, directive, mode, started_at, finished_at, failed, failure,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  total_tokens
             FROM review_run ${where}
            ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, opts.limit));
      if (runs.length === 0) return [];

      const ids = runs.map((run) => Number(run["id"]));
      const marks = ids.map(() => "?").join(", ");
      // 逐模型的行来自 reviewer_outcome:它一轮一模型一行并带 failure,失败的模型
      // 因此照样列出。Finding 数仍数 finding 表——outcome 上的 finding_count 是
      // Reviewer 自报的合并前条数,与落库行数不是同一个口径。
      const byOutcome = (await db
        .prepare(
          `SELECT run_id, model, failure, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, total_tokens
             FROM reviewer_outcome
            WHERE run_id IN (${marks}) ORDER BY model`,
        )
        .all(...ids));
      // 一个模型报了几条:数它的归属,不数 finding 行——一条 Finding 可以有几个归属
      // (ADR 0015),按行数会把合并掉的那几条从这个模型名下抹掉。
      const byModel = (await db
        .prepare(
          `SELECT f.run_id AS run_id, a.model AS model, COUNT(*) AS findings
             FROM finding_attribution a
             JOIN finding f ON f.id = a.finding_id
            WHERE f.run_id IN (${marks}) GROUP BY f.run_id, a.model ORDER BY a.model`,
        )
        .all(...ids));
      // 已处置口径与处置率同源:只认行级承载。人工与自动分开数,面板据此把两者分开显示。
      // 「已延续」两头都不占:它既不是处置,也不该继续挂在这一轮的待处置里等人去点
      // ——那处 Finding 已经交接到新位置,要处置的是新位置那条。
      const byGroup = (await db
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
        .all(...ids));

      const byFinding = (await db
        .prepare(
          `SELECT id, run_id, file, line, severity, category, description,
                  impact, suggestion,
                  disposition, placement, comment_id, comment_html_url,
                  disposed_by, disposed_at, disposition_note, continued_from,
                  handoff_pending
             FROM finding
            WHERE run_id IN (${marks}) ORDER BY id`,
        )
        .all(...ids));
      const byAttribution = (await db
        .prepare(
          `SELECT a.finding_id AS finding_id, a.model AS model, a.severity AS severity,
                  a.category AS category, a.description AS description,
                  a.impact AS impact, a.suggestion AS suggestion
             FROM finding_attribution a
             JOIN finding f ON f.id = a.finding_id
            WHERE f.run_id IN (${marks}) ORDER BY a.finding_id, a.position`,
        )
        .all(...ids));
      const carried = (await carriedByFinding(
        db,
        `SELECT id FROM finding WHERE run_id IN (${marks})`,
        ids,
      ));

      const byPin = (await db
        .prepare(
          `SELECT run_id, identity, provider, model, model_service_version,
                  base_url, api, runtime_model_json, materialization_failure, thinking_level
             FROM review_run_reviewer_pin
            WHERE run_id IN (${marks}) ORDER BY run_id, position`,
        )
        .all(...ids));
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
          thinkingLevel:
            row["thinking_level"] === null || row["thinking_level"] === undefined
              ? null
              : (String(row["thinking_level"]) as ThinkingLevel),
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
      const attributions = new Map<number, RecordedFindingAttribution[]>();
      for (const row of byAttribution) {
        const findingId = Number(row["finding_id"]);
        const list = attributionModels.get(findingId) ?? [];
        const model = String(row["model"]);
        // 同一模型的多条归属(ADR 0015 修订)只贡献一枚模型标识:这份列表回答的是
        // 「哪些模型报出它」,不是有几段归属。
        if (!list.includes(model)) list.push(model);
        attributionModels.set(findingId, list);
        const said = attributions.get(findingId) ?? [];
        said.push(recordedAttribution(row));
        attributions.set(findingId, said);
      }
      const findings = new Map<number, RunListItem["findings"]>();
      for (const row of byFinding) {
        const runId = Number(row["run_id"]);
        const list = findings.get(runId) ?? [];
        const said = attributions.get(Number(row["id"])) ?? [];
        // 代表段(issue #278):升级前落的行两列为 NULL,按同一规则从归属现算。
        const representative = representativeSegment(row, said);
        list.push({
          id: Number(row["id"]),
          models: attributionModels.get(Number(row["id"])) ?? [],
          attributions: said,
          carried: carried.get(Number(row["id"])) ?? [],
          file: String(row["file"]),
          line: Number(row["line"]),
          severity: String(row["severity"]) as Severity,
          category: String(row["category"]) as Category,
          description: representative.description,
          impact: representative.impact,
          suggestion: representative.suggestion,
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
          handoffPending: row["handoff_pending"] === true,
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
          title: run["title"] === null ? null : String(run["title"]),
          triggeredBy:
            run["triggered_by"] === null ? null : String(run["triggered_by"]),
          triggerSource: readTriggerSource(run["trigger_source"]),
          rangeReviewId:
            run["range_review_id"] === null ? null : Number(run["range_review_id"]),
          directive: run["directive"] === null ? null : String(run["directive"]),
          // 升级前的旧行没有这一列:它们都是完整审查,读回来照实说。
          mode: run["mode"] === "verdict-only" ? "verdict-only" : "full",
          startedAt: String(run["started_at"]),
          finishedAt: run["finished_at"] === null ? null : String(run["finished_at"]),
          failed: Number(run["failed"]) === 1,
          failure: run["failure"] === null ? null : String(run["failure"]),
          models: models.get(id) ?? [],
          ...(usage === undefined ? {} : { usage }),
          reviewerPins: reviewerPins.get(id) ?? [],
          findings: findings.get(id) ?? [],
          resolved: groups.get(id)?.resolved ?? 0,
          fixed: groups.get(id)?.fixed ?? 0,
          total: groups.get(id)?.total ?? 0,
        };
      });
    },

    async getRunRange(id) {
      const row = (await db
        .prepare(
          `SELECT run.id, run.owner, run.repo, run.pull_number, run.head_sha,
                  run.range_review_id, rr.base_sha
             FROM review_run run
             LEFT JOIN range_review rr ON run.range_review_id = rr.id
            WHERE run.id = ?`,
        )
        .get(id)) as Record<string, unknown> | undefined;
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

    async getFinding(id) {
      const row = (await db
        .prepare(
          `SELECT f.id, f.comment_id, f.disposition, f.disposition_note,
                  f.file, f.line, f.title, f.description,
                  run.owner, run.repo, run.head_sha
             FROM finding f
             JOIN review_run run ON f.run_id = run.id
            WHERE f.id = ?`,
        )
        .get(id)) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return {
        id: Number(row["id"]),
        owner: String(row["owner"]),
        repo: String(row["repo"]),
        commentId: row["comment_id"] === null ? null : String(row["comment_id"]),
        disposition: String(row["disposition"]) as Disposition,
        note: row["disposition_note"] === null ? null : String(row["disposition_note"]),
        file: String(row["file"]),
        line: Number(row["line"]),
        title: row["title"] === null ? null : String(row["title"]),
        description: String(row["description"]),
        headSha: String(row["head_sha"]),
      };
    },

    async recordDisposition(input) {
      const result = (await db
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
        ));
      return Number(result.changes);
    },

    async pendingAutoDispositions(findingIds) {
      // 折叠键与读侧同源:`identityKey`——承载它的那条 Forge 评论,没有载体的退回
      // 「文件 + 指纹」。不按裸的「文件 + 指纹」扫:同一处可以有两条 Identity(ADR 0030),
      // 那样会把另一条的评论也 resolve 掉、另一条的行也记成已修复。PR 范围与
      // `PULL_REQUEST_SCOPE` 同一句话,只是从传入那一行所在的轮次上取,不另要参数。
      const identity = db.prepare(
        `WITH seed AS (
           SELECT ${identityKey("f.")} AS key,
                  run.owner AS owner, run.repo AS repo, run.pull_number AS pull_number
             FROM finding f JOIN review_run run ON run.id = f.run_id
            WHERE f.id = ?
         )
         SELECT finding.id AS id, finding.comment_id AS comment_id
           FROM finding, seed
          WHERE ${identityKey("finding.")} = seed.key
            AND finding.comment_id IS NOT NULL
            AND ${AUTO_DISPOSABLE}
            AND finding.run_id IN (SELECT id FROM review_run
                                    WHERE owner = seed.owner AND repo = seed.repo
                                      AND pull_number = seed.pull_number)
          ORDER BY finding.id`,
      );
      const seen = new Set<number>();
      const candidates: { findingId: number; commentId: string }[] = [];
      for (const findingId of findingIds) {
        for (const row of await identity.all(findingId)) {
          const id = Number(row["id"]);
          if (seen.has(id)) continue;
          seen.add(id);
          candidates.push({ findingId: id, commentId: String(row["comment_id"]) });
        }
      }
      return candidates;
    },

    async recordAutoDisposition(owner, repo, pullNumber, candidate, disposedAt, note) {
      // 只改候选那一行(issue #275):Identity 的展开在 `pendingAutoDispositions` 那一侧,
      // 每一行都各自先写过 Forge 才走到这里。按折叠键扫整条 Identity 会把没写 Forge 的
      // 那些行也记成已修复,而 Disposition 的权威状态在 Forge 上(ADR 0006)。
      (await db.prepare(
        `UPDATE finding SET disposition = 'fixed', disposed_at = ?,
                disposition_note = COALESCE(?, disposition_note)
          WHERE id = ? AND ${AUTO_DISPOSABLE} AND ${PULL_REQUEST_SCOPE}`,
      ).run(disposedAt, note ?? null, candidate.findingId, owner, repo, pullNumber));
    },

    async historyPlacements(findingIds) {
      const probe = db.prepare(
        `SELECT f.file AS file, f.line AS line, f.title AS title, f.description AS description,
                f.fingerprint AS fingerprint, f.comment_id AS comment_id,
                f.comment_html_url AS comment_html_url, f.disposition AS disposition,
                run.id AS run_id, run.head_sha AS head_sha
           FROM finding f
           JOIN review_run run ON run.id = f.run_id
          WHERE f.id = ? AND f.fingerprint IS NOT NULL
            AND f.comment_id IS NOT NULL AND f.comment_html_url IS NOT NULL`,
      );
      // 这一行自己的归属(issue #267):两段都是空串的没有内容可带,不占一段;NULL 的照实带
      // ——升级前落的行两列是 NULL,`NULL = ''` 在 SQL 里不是假,要显式放行。
      const ownSaid = db.prepare(
        `SELECT model, description, impact, suggestion FROM finding_attribution
          WHERE finding_id = ?
            AND (impact IS NULL OR suggestion IS NULL OR impact <> '' OR suggestion <> '')
          ORDER BY position`,
      );
      const placements: HistoryPlacement[] = [];
      for (const findingId of findingIds) {
        const row = await probe.get(findingId);
        if (row === undefined) continue;
        const from = { runId: Number(row["run_id"]), headSha: String(row["head_sha"]) };
        const own = (await ownSaid.all(findingId)).map((said) => ({
          ...from,
          model: String(said["model"]),
          description: String(said["description"]),
          impact: said["impact"] === null ? null : String(said["impact"]),
          suggestion: said["suggestion"] === null ? null : String(said["suggestion"]),
        }));
        const inherited = (await carriedByFinding(db, "?", [findingId])).get(findingId) ?? [];
        placements.push({
          findingId,
          file: String(row["file"]),
          line: Number(row["line"]),
          title: row["title"] === null ? "" : String(row["title"]),
          description: String(row["description"]),
          fingerprint: String(row["fingerprint"]),
          commentId: String(row["comment_id"]),
          commentHtmlUrl: String(row["comment_html_url"]),
          disposition: String(row["disposition"]) as Disposition,
          carried: [...own, ...inherited],
        });
      }
      return placements;
    },

    async continuationCandidates(findingIds) {
      // 与 `historyPlacements` 同一批列同一道筛,只多一条:已经处置过的不再交接位置。
      return (await store.historyPlacements(findingIds))
        .filter(
          (placement) =>
            placement.disposition === "unknown" || placement.disposition === "unresolved",
        )
        .map(({ disposition: _disposition, ...candidate }) => candidate);
    },

    async recordContinuation({ owner, repo, pullNumber, runId, groupIndex, candidate, handoffPending }) {
      await transaction("deferred", async () => {
        // 先把旧行的三列抄到新行上,再改旧行的处置值:两条语句都只碰自己那一侧,
        // 顺序其实无关,写成这样是让「谁继承谁」一眼看得出来。
        (await db.prepare(
          `UPDATE finding
              SET (disposed_by, disposed_at, disposition_note, continued_from) =
                    (SELECT prior.disposed_by, prior.disposed_at, prior.disposition_note, ?
                       FROM finding prior WHERE prior.id = ?)
            WHERE run_id = ? AND group_index = ?`,
        ).run(candidate.commentHtmlUrl, candidate.findingId, runId, groupIndex));
        // 折叠键与读侧同源:`identityKey`——交接的是承载它的那条评论所指的那条 Finding,
        // 同一处的另一条 Identity 各有各的评论,不跟着这一次交接走(ADR 0030)。本轮新行
        // 的指纹必然与它不同——旧指纹在本轮 head 上算不出正是延续的前提,不会被这一笔一起
        // 改掉。交接未完成的标记与处置值同一笔写(ADR 0025):整条 Identity 一起带上。
        (await db.prepare(
          `UPDATE finding SET disposition = 'continued', handoff_pending = ?
            WHERE ${identityKey("")} =
                  (SELECT ${identityKey("prior.")} FROM finding prior WHERE prior.id = ?)
              AND disposition IN ('unknown', 'unresolved')
              AND ${PULL_REQUEST_SCOPE}`,
        ).run(handoffPending ? 1 : null, candidate.findingId, owner, repo, pullNumber));
      });
    },

    async pendingHandoffs(owner, repo, pullNumber) {
      // 同一条评论在 Identity 的几行上都带着标记,按评论去重、取最新那一行的 id。
      const rows = (await db
        .prepare(
          `SELECT id, comment_id FROM finding
            WHERE handoff_pending = true AND comment_id IS NOT NULL AND ${PULL_REQUEST_SCOPE}
            ORDER BY id`,
        )
        .all(owner, repo, pullNumber));
      const byComment = new Map<string, number>();
      for (const row of rows) byComment.set(String(row["comment_id"]), Number(row["id"]));
      return [...byComment].map(([commentId, findingId]) => ({ findingId, commentId }));
    },

    async completeHandoff(owner, repo, pullNumber, findingId) {
      (await db.prepare(
        `UPDATE finding SET handoff_pending = NULL
          WHERE ${identityKey("")} =
                (SELECT ${identityKey("prior.")} FROM finding prior WHERE prior.id = ?)
            AND handoff_pending = true
            AND ${PULL_REQUEST_SCOPE}`,
      ).run(findingId, owner, repo, pullNumber));
    },

    async backfillDispositions(owner, repo, pullNumber, updates) {
      if (updates.length === 0) return;
      // 「已延续」两个方向都不覆盖:延续时旧评论被 resolve 过,读回的 resolved 是那次
      // 交接的痕迹,不是处置;人在 Forge 上把它 unresolve 也一样——这条 Finding 的当前
      // 位置已经在新行上,旧行只剩「已经交接过」这一个事实。
      const withDisposition = db.prepare(
        `UPDATE finding SET disposition = ?, placement = ?
          WHERE ${BACKFILL_TARGET} AND disposition <> 'continued'
            AND ${PULL_REQUEST_SCOPE}`,
      );
      // 「已修复」在 Forge 上就是一个 resolve,读回的 resolved 因此不能把它降级成人工
      // 那一档——处置率会凭空多出人工处置。读回 unresolved 是另一回事:人在 Forge 上
      // 撤回了处置,以 Forge 最新状态为准,照写。
      const keepAutoDisposed = db.prepare(
        `UPDATE finding SET disposition = ?, placement = ?
          WHERE ${BACKFILL_TARGET}
            AND disposition <> 'fixed' AND disposition <> 'continued'
            AND ${PULL_REQUEST_SCOPE}`,
      );
      const placementOnly = db.prepare(
        `UPDATE finding SET placement = ?
          WHERE ${BACKFILL_TARGET} AND ${PULL_REQUEST_SCOPE}`,
      );
      // 「已延续」只放开这一格(ADR 0025):旧评论读回已 resolve,交接要等的就是这个
      // 结果,待办标记清掉;处置值仍不动。
      const handoffDone = db.prepare(
        `UPDATE finding SET handoff_pending = NULL
          WHERE ${BACKFILL_TARGET} AND disposition = 'continued'
            AND handoff_pending = true AND ${PULL_REQUEST_SCOPE}`,
      );
      await transaction("deferred", async () => {
        for (const entry of updates) {
          // 三个参数一组,顺序与 `BACKFILL_TARGET` 里的三个 `?` 对齐。
          const target = [entry.commentId ?? null, entry.file, entry.fingerprint] as const;
          if (entry.disposition === undefined) {
            (await placementOnly.run(entry.placement, ...target, owner, repo, pullNumber));
          } else {
            const update =
              entry.disposition === "resolved" ? keepAutoDisposed : withDisposition;
            (await update.run(entry.disposition, entry.placement, ...target, owner, repo, pullNumber));
            if (entry.disposition === "resolved") {
              (await handoffDone.run(...target, owner, repo, pullNumber));
            }
          }
        }
      });
    },

    async markPullRequestState(owner, repo, pullNumber, state) {
      (await db.prepare(
        `UPDATE review_run SET pr_state = ?
          WHERE owner = ? AND repo = ? AND pull_number = ?`,
      ).run(state, owner, repo, pullNumber));
    },

    async claimDelivery(owner, repo, headSha) {
      const result = (await db
        .prepare(
          `INSERT INTO webhook_delivery (owner, repo, head_sha, claimed_at)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(owner, repo, headSha, new Date().toISOString()));
      return Number(result.changes) > 0;
    },

    // 连接池活到进程结束,这里不关任何东西(ADR 0036)。调用点仍留着:它们标着「这一段用完
    // 了」,而池的关闭是 `closeStorePools()` 的事。
    async close() {},
  };
  return store;
}
