/**
 * 范围审查、审查阶段与统计域的持久化(spec #445 第二段,issue #453)。
 *
 * 装的是四件事:范围审查那一串写入与读取(含每日增量的定时检查)、评审记录的阶段列表
 * 与阶段详情、一个阶段的汇总,以及处置率 / 参与条数 / token 用量与库体量。
 *
 * 这一域已经迁到 Drizzle:简单读写走 builder,UNION、CTE 与四段聚合那几条走 `sql` 模板
 * 并引 schema 的列对象。迁法见 `src/AGENTS.md` 的「各域迁 Drizzle 的施工指南」。
 */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type {
  FindingPlacement,
  RecordedFindingAttribution,
} from "../../contracts/finding.ts";
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
  StageSummaryFinding,
} from "../../contracts/stage-summary.ts";
import type { Category, Disposition, Severity } from "../finding.ts";
import { containerBranches } from "../range-review.ts";
import { rangeReview, rangeReviewComparison } from "../schema/stages.ts";
import {
  finding,
  findingAttribution,
  findingCarriedAttribution,
  findingVerdict,
  reviewRun,
  reviewerOutcome,
  reviewTrace,
} from "../schema/runs.ts";
import type {
  ComparisonSource,
  RangeReviewRecord,
  ScheduledCheckResult,
  StageRowEntry,
  StageScope,
  Store,
} from "./index.ts";
import { UNRECORDED_RUN_FAILURE } from "./index.ts";
import {
  carriedAttribution,
  identityKey,
  readTriggerSource,
  recordedAttribution,
  representativeSegment,
  STATS_IDENTITY_CTE,
  type StoreContext,
} from "./shared.ts";

/** 一行 finding 属于哪条 Finding Identity。列名按 Drizzle 渲染的表限定写法取。 */
const FINDING_IDENTITY = sql.raw(identityKey('"finding".'));

/**
 * 一个审查阶段的范围(CONTEXT.md 审查阶段)。与 `shared.ts` 的 `stageScope` 是同一条判据
 * 的 Drizzle 写法:pull request 阶段是「owner + repo + pull number 且不属于任何范围审查」
 * 的全部轮次,范围审查阶段是它名下的全部轮次。
 */
function scopeCondition(scope: StageScope): SQL {
  return "rangeReviewId" in scope
    ? sql`${reviewRun.rangeReviewId} = ${scope.rangeReviewId}`
    : sql`${reviewRun.owner} = ${scope.owner} AND ${reviewRun.repo} = ${scope.repo}
            AND ${reviewRun.pullNumber} = ${scope.pullNumber}
            AND ${reviewRun.rangeReviewId} IS NULL`;
}

/**
 * 一组 owner/repo 对的过滤条件(CONTEXT.md 仓库分配)。省略即不限,空数组即一个都不给;
 * `prefix` 是这两列在查询里的表别名前缀。与 `shared.ts` 的 `repoPairCondition` 同一条
 * 规则,这里回的是 Drizzle 的 `SQL` 片段。
 */
function repoPairFilter(
  pairs: readonly { owner: string; repo: string }[] | undefined,
  prefix: string,
): SQL {
  if (pairs === undefined) return sql`true`;
  if (pairs.length === 0) return sql`false`;
  const at = sql.raw(prefix);
  return sql`(${sql.join(
    pairs.map((pair) => sql`(${at}owner = ${pair.owner} AND ${at}repo = ${pair.repo})`),
    sql` OR `,
  )})`;
}

/**
 * 走 `orm.execute` 的原始查询取回来的一格时刻。
 *
 * `store/pg.ts` 装的全局解析器把 `timestamptz` 读成 ISO 字符串,而 Drizzle 对自己发出的
 * 每一条查询都把这个类型改回「原样的 PostgreSQL 文本」(它自己按列类型再映)——builder
 * 的结果因此是 ISO,`execute` 的结果是 `2026-08-03 00:00:00+00` 这种写法。这一格在这里
 * 归一,面板与用例看到的仍是 ISO。
 */
function isoTime(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** 阶段行查询回来的一行。两段 SELECT 的列名与顺序逐字对齐。 */
type StageQueryRow = {
  source: string;
  stage_id: string;
  owner: string;
  repo: string;
  pull_number: number | null;
  range_review_id: number | null;
  title: string | null;
  status: string;
  latest_run_id: number | null;
  latest_run_at: string | null;
  latest_run_finished_at: string | null;
  activity_at: string;
};

/**
 * 评审记录一行的两条来源各一段 SELECT(issue #174,归并与排序在 issue #183 进的 SQL)。
 *
 * 两段的列名与顺序逐字对齐:列表把它们 UNION 起来,在 SQL 里筛、排序、切页;详情按阶段
 * 标识只跑其中一段,直接查那一个阶段。行的形状因此仍然只定义这一处。
 *
 * `activity_at` 是排序键:最近有动静的排在前面,范围审查还没有轮次时用它的发起时刻。
 * `filter` 由调用方给——列表给仓库过滤,详情给这一个阶段的键。
 *
 * 每个 pull request 取 id 最大的那一轮——id 即落库顺序,与开跑时间同序,那一轮带着这个
 * 阶段当前的标题与关闭标记。`DISTINCT ON (owner, repo, pull_number)` 加 `ORDER BY … id DESC`
 * 让 PostgreSQL 每组只留 id 最大的那一行(ADR 0036);SQLite 那一版靠的是「与 `MAX()` 同行
 * 的裸列」,PostgreSQL 不认这种写法。
 */
function pullStageSelect(filter: SQL): SQL {
  return sql`SELECT DISTINCT ON (owner, repo, pull_number)
                    'pull-request' AS source,
                    'pr:' || owner || '/' || repo || '/' || pull_number AS stage_id,
                    owner, repo, pull_number,
                    NULL::integer AS range_review_id, title,
                    CASE WHEN pr_state = 'closed' THEN 'closed' ELSE 'active' END AS status,
                    id AS latest_run_id, started_at AS latest_run_at,
                    finished_at AS latest_run_finished_at, started_at AS activity_at
               FROM review_run
              WHERE range_review_id IS NULL AND ${filter}
              ORDER BY owner, repo, pull_number, id DESC`;
}

/** 见 `pullStageSelect`。一轮都还没跑的范围审查也是一个阶段,因此从 `range_review` 出发。 */
function rangeStageSelect(filter: SQL): SQL {
  return sql`SELECT 'range-review' AS source,
                    'range:' || rr.id AS stage_id,
                    rr.owner AS owner, rr.repo AS repo, NULL::integer AS pull_number,
                    rr.id AS range_review_id, rr.title AS title,
                    CASE WHEN rr.state = 'in-progress' THEN 'active' ELSE 'closed' END AS status,
                    latest.id AS latest_run_id, latest.started_at AS latest_run_at,
                    latest.finished_at AS latest_run_finished_at,
                    COALESCE(latest.started_at, rr.created_at) AS activity_at
               FROM range_review rr
               LEFT JOIN review_run latest
                 ON latest.id = (SELECT MAX(run.id) FROM review_run run
                                  WHERE run.range_review_id = rr.id)
              WHERE ${filter}`;
}

/** 把阶段行查询的一行读成评审记录里的那一行,加上算计数与时间线要用的范围。 */
function stageRowEntry(row: StageQueryRow): StageRowEntry {
  const { owner, repo } = row;
  const pullNumber = row.pull_number;
  const rangeReviewId = row.range_review_id;
  return {
    item: {
      stageId: row.stage_id,
      source: row.source as StageSource,
      owner,
      repo,
      pullNumber,
      rangeReviewId,
      title: row.title,
      status: row.status as StageStatus,
      latestRunId: row.latest_run_id,
      latestRunAt: isoTime(row.latest_run_at),
      latestRunFinishedAt: isoTime(row.latest_run_finished_at),
    },
    scope: rangeReviewId === null ? { owner, repo, pullNumber: pullNumber! } : { rangeReviewId },
  };
}

/** 这一行要问警示的那一轮:最新一轮跑完了才问(见 `stageRunAlerts`)。 */
function alertRunId(item: StageRowEntry["item"]): number | null {
  return item.latestRunFinishedAt === null ? null : item.latestRunId;
}

/**
 * 时间线分组(issue #175):一组是一次代码推进。范围审查按比较项分,pull request 没有
 * 比较项这张表,按 head commit 分——两边的分组键都是轮次的 head。
 *
 * 比较项在前,顺序就是推进顺序;head 认不出比较项的轮次仍按自己的 head 单独成一组,
 * 而不是被丢掉——它是真跑过的一轮,时间线上不能没有它。组与组内的轮次都是新的在前。
 */
function groupStageRuns(
  timeline: readonly StageTimelineEntry[],
  comparisons: readonly { sha: string; recordedBy: string; recordedAt: string }[],
): StageRunGroup[] {
  // 时间线本身按轮次落库顺序升序,这里的每一组因此也是升序。
  const byHead = new Map<string, StageTimelineEntry[]>();
  for (const entry of timeline) {
    byHead.set(entry.headSha, [...(byHead.get(entry.headSha) ?? []), entry]);
  }
  const ascending: StageRunGroup[] = [];
  for (const comparison of comparisons) {
    ascending.push({
      sha: comparison.sha,
      recordedBy: comparison.recordedBy,
      recordedAt: comparison.recordedAt,
      runs: byHead.get(comparison.sha) ?? [],
    });
    byHead.delete(comparison.sha);
  }
  const rest = [...byHead.entries()].sort((a, b) => a[1].at(-1)!.runId - b[1].at(-1)!.runId);
  for (const [sha, runs] of rest) {
    ascending.push({ sha, recordedBy: null, recordedAt: null, runs });
  }
  return ascending.reverse().map((group) => ({ ...group, runs: [...group.runs].reverse() }));
}

function rangeReviewRecord(row: typeof rangeReview.$inferSelect): RangeReviewRecord {
  return {
    id: row.id,
    repoId: row.repoId,
    owner: row.owner,
    repo: row.repo,
    title: row.title,
    baseSha: row.baseSha,
    comparisonSha: row.comparisonSha,
    comparisonSource:
      row.comparisonSourceKind === null
        ? null
        : {
            kind: row.comparisonSourceKind as ComparisonSource["kind"],
            name: row.comparisonSourceName ?? "",
          },
    state: row.state as RangeReviewRecord["state"],
    containerPullNumber: row.containerPullNumber,
    baseBranch: row.baseBranch,
    headBranch: row.headBranch,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    completedBy: row.completedBy,
    completedAt: row.completedAt,
    lastForgeFailure: row.lastForgeFailure,
    dailyIncrementEnabled: row.dailyIncrementEnabled,
    dailyIncrementBranch: row.dailyIncrementBranch,
    dailyIncrementEnabledAt: row.dailyIncrementEnabledAt,
    scheduledCheckAt: row.scheduledCheckAt,
    scheduledCheckResult: row.scheduledCheckResult as ScheduledCheckResult | null,
    scheduledCheckTime: row.scheduledCheckTime,
    scheduledCheckMode: row.scheduledCheckMode === "full" ? "full" : "verdict-only",
  };
}

type StagesMethods = Pick<
  Store,
  | "stageSummary"
  | "listStages"
  | "stageDetail"
  | "createRangeReview"
  | "attachRangeReviewContainer"
  | "failRangeReview"
  | "recordRangeReviewForgeFailure"
  | "advanceRangeReview"
  | "listRangeReviewComparisons"
  | "completeRangeReview"
  | "setRangeReviewDailyIncrement"
  | "recordRangeReviewScheduledCheck"
  | "getRangeReview"
  | "listRangeReviews"
  | "dispositionStats"
  | "modelParticipation"
  | "usageStats"
  | "tableCounts"
  | "databaseSize"
>;

export function stagesMethods({ orm, transaction, store }: StoreContext): StagesMethods {
  /**
   * 给定这几轮的警示(issue #421、#424):哪几轮有模型整轮没跑成、哪几轮有模型的某几批
   * 没跑成、哪几轮没有正常收尾。
   *
   * 一条查询算完这一页:逐行回查会让翻一页多发几十次。没有警示的那几轮不在结果里,
   * 调用方取不到即 null——四段各自只在那一档成立时出行,一档都不成立的轮次因此落不进
   * `GROUP BY`。
   *
   * 调用方只把**跑完的**那几轮交进来(见 `alertRunId`):警示说的是这一轮跑出来的结论
   * 不完整,而还在跑的那一轮还没有结论。
   */
  const stageRunAlerts = async (
    runIds: readonly number[],
  ): Promise<Map<number, StageRunAlert>> => {
    const alerts = new Map<number, StageRunAlert>();
    if (runIds.length === 0) return alerts;
    const ids = sql`(${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})`;
    const rows = (
      await orm.execute<{
        run_id: number;
        batch_failed: number;
        model_failed: number;
        failure: string | null;
      }>(sql`
        SELECT run_id, MAX(batch_failed) AS batch_failed, MAX(model_failed) AS model_failed,
               MAX(failure) AS failure
          FROM (SELECT ${findingVerdict.runId} AS run_id, 1 AS batch_failed, 0 AS model_failed,
                       NULL::text AS failure
                  FROM ${findingVerdict}
                 WHERE ${findingVerdict.runId} IN ${ids}
                   AND ${findingVerdict.missingReason} = 'batch-failed'
                 UNION ALL
                SELECT t.run_id, 1 AS batch_failed, 0 AS model_failed, NULL::text AS failure
                  FROM ${reviewTrace} t
                 WHERE t.run_id IN ${ids} AND t.kind = 'reviewer_batch_finished'
                   AND t.payload->>'failed' = 'true'
                   AND NOT EXISTS (SELECT 1 FROM ${reviewerOutcome} o
                                    WHERE o.run_id = t.run_id AND o.model = t.reviewer
                                      AND o.failure IS NOT NULL)
                 UNION ALL
                SELECT ${reviewerOutcome.runId} AS run_id, 0 AS batch_failed, 1 AS model_failed,
                       NULL::text AS failure
                  FROM ${reviewerOutcome}
                 WHERE ${reviewerOutcome.runId} IN ${ids}
                   AND ${reviewerOutcome.failure} IS NOT NULL
                 UNION ALL
                 -- 一轮至多一行,MAX() 因此取的就是它自己那句话。
                SELECT ${reviewRun.id} AS run_id, 0 AS batch_failed, 0 AS model_failed,
                       ${reviewRun.failure} AS failure
                  FROM ${reviewRun}
                 WHERE ${reviewRun.id} IN ${ids} AND ${reviewRun.failure} IS NOT NULL) marked
         GROUP BY run_id`)
    ).rows;
    for (const row of rows) {
      const failure = row.failure;
      alerts.set(Number(row.run_id), {
        modelFailed: Number(row.model_failed) === 1,
        batchFailed: Number(row.batch_failed) === 1,
        // 第一行去掉首尾空白(issue #428):这一格是面板直接读给人看的,空原因会让悬停
        // 说明停在一个「:」上。取不出东西时的那道回落只为写入侧收口(issue #432)之前
        // 落下的旧行留着——新落的行整篇空白已经换成了同一句话。
        closingFailure:
          failure === null
            ? null
            : (failure
                .split("\n")
                .map((line) => line.trim())
                .find((line) => line !== "") ?? UNRECORDED_RUN_FAILURE),
      });
    }
    return alerts;
  };

  /**
   * 评审记录里的一个阶段:按阶段标识直接查它那一行(issue #175,查询在 issue #183 收进
   * SQL)。认不出的标识、以及查不到的阶段都是 undefined,调用方一律按「没有这个阶段」处理。
   *
   * 标识由行自己拼出(`pr:<owner>/<repo>/<number>` 与 `range:<id>`),因此拿回来的行要与
   * 请求的标识逐字相同才算命中——`pr:o/r/007` 解析出的是 7 号,那是另一个标识。
   */
  const stageRowById = async (stageId: string): Promise<StageRowEntry | undefined> => {
    let query: SQL;
    if (stageId.startsWith("range:")) {
      const rangeReviewId = Number(stageId.slice("range:".length));
      if (!Number.isSafeInteger(rangeReviewId) || rangeReviewId <= 0) return undefined;
      query = rangeStageSelect(sql`rr.id = ${rangeReviewId}`);
    } else if (stageId.startsWith("pr:")) {
      const parts = stageId.slice("pr:".length).split("/");
      if (parts.length !== 3) return undefined;
      const pullNumber = Number(parts[2]);
      if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) return undefined;
      query = pullStageSelect(
        sql`owner = ${parts[0]!} AND repo = ${parts[1]!} AND pull_number = ${pullNumber}`,
      );
    } else {
      return undefined;
    }
    const [row] = (await orm.execute<StageQueryRow>(query)).rows;
    if (row === undefined) return undefined;
    const entry = stageRowEntry(row);
    return entry.item.stageId === stageId ? entry : undefined;
  };

  return {
    async stageSummary(scope) {
      const where = scopeCondition(scope);
      const runRows = await orm
        .select({
          id: reviewRun.id,
          head_sha: reviewRun.headSha,
          started_at: reviewRun.startedAt,
          finished_at: reviewRun.finishedAt,
          failed: reviewRun.failed,
          failure: reviewRun.failure,
          mode: reviewRun.mode,
          trigger_source: reviewRun.triggerSource,
        })
        .from(reviewRun)
        .where(where)
        .orderBy(asc(reviewRun.id));
      if (runRows.length === 0) {
        return {
          findings: [],
          counts: { pending: 0, resolved: 0, fixed: 0 },
          timeline: [],
          rootCauseGroups: [],
        };
      }
      // 一个阶段的行数有界(轮次 × 每轮的 Finding),折叠在这里用 JS 做:延续要把两个
      // 指纹接成同一条 Identity,写成 SQL 只会让这一步看不出在做什么。
      const findingRows = await orm
        .select({
          id: finding.id,
          run_id: finding.runId,
          file: finding.file,
          line: finding.line,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          description: finding.description,
          impact: finding.impact,
          suggestion: finding.suggestion,
          disposition: finding.disposition,
          placement: finding.placement,
          comment_id: finding.commentId,
          comment_html_url: finding.commentHtmlUrl,
          disposed_by: finding.disposedBy,
          disposed_at: finding.disposedAt,
          note: finding.dispositionNote,
          continued_from: finding.continuedFrom,
          handoff_pending: finding.handoffPending,
          line_author_sha: finding.lineAuthorSha,
          line_author_name: finding.lineAuthorName,
          line_author_email: finding.lineAuthorEmail,
          line_author_at: finding.lineAuthorAt,
          line_author_adjacent: finding.lineAuthorAdjacent,
          placed_line: finding.placedLine,
          placed_run_id: finding.placedRunId,
          fp: sql<string>`${FINDING_IDENTITY}`,
        })
        .from(finding)
        .innerJoin(reviewRun, eq(finding.runId, reviewRun.id))
        .where(where)
        .orderBy(asc(finding.id));
      const attributionRows = await orm
        .select({
          finding_id: findingAttribution.findingId,
          model: findingAttribution.model,
          severity: findingAttribution.severity,
          category: findingAttribution.category,
          description: findingAttribution.description,
          impact: findingAttribution.impact,
          suggestion: findingAttribution.suggestion,
        })
        .from(findingAttribution)
        .innerJoin(finding, eq(finding.id, findingAttribution.findingId))
        .innerJoin(reviewRun, eq(finding.runId, reviewRun.id))
        .where(where)
        .orderBy(asc(findingAttribution.findingId), asc(findingAttribution.position));
      // 承接来的历史说法(issue #267)记的是它出自哪一轮,那一轮的 head 要一并带出来。
      const origin = alias(reviewRun, "origin");
      const carriedRows = await orm
        .select({
          finding_id: findingCarriedAttribution.findingId,
          model: findingCarriedAttribution.model,
          run_id: findingCarriedAttribution.runId,
          description: findingCarriedAttribution.description,
          impact: findingCarriedAttribution.impact,
          suggestion: findingCarriedAttribution.suggestion,
          head_sha: origin.headSha,
        })
        .from(findingCarriedAttribution)
        .innerJoin(finding, eq(finding.id, findingCarriedAttribution.findingId))
        .innerJoin(reviewRun, eq(finding.runId, reviewRun.id))
        .innerJoin(origin, eq(origin.id, findingCarriedAttribution.runId))
        .where(where)
        .orderBy(asc(findingCarriedAttribution.findingId), asc(findingCarriedAttribution.position));
      const carried = new Map(
        [...Map.groupBy(carriedRows, (row) => row.finding_id)].map(([id, group]) => [
          id,
          group.map(carriedAttribution),
        ]),
      );
      const verdictRows = await orm
        .select({
          run_id: findingVerdict.runId,
          finding_id: findingVerdict.findingId,
          verdict: findingVerdict.verdict,
          missing: findingVerdict.missing,
          missing_reason: findingVerdict.missingReason,
        })
        .from(findingVerdict)
        .innerJoin(reviewRun, eq(findingVerdict.runId, reviewRun.id))
        .where(where);

      const models = new Map<number, string[]>();
      const attributions = new Map<number, RecordedFindingAttribution[]>();
      for (const row of attributionRows) {
        const id = row.finding_id;
        const list = models.get(id) ?? [];
        const model = row.model;
        // 同一模型的多条归属只算一枚(ADR 0015 修订),口径同轮次列表那份。
        if (!list.includes(model)) list.push(model);
        models.set(id, list);
        const said = attributions.get(id) ?? [];
        said.push(recordedAttribution(row));
        attributions.set(id, said);
      }

      type FindingRow = (typeof findingRows)[number];
      type StageRow = {
        id: number;
        runId: number;
        file: string;
        fp: string;
        disposition: Disposition;
        commentHtmlUrl: string | null;
        continuedFrom: string | null;
        handoffPending: boolean;
        row: FindingRow;
      };
      type Identity = { rows: StageRow[]; firstRow: StageRow };
      // 折叠键见 `identityKey`:承载它的那条 Forge 评论,没有载体的退回文件 + 指纹。
      // 同一「文件 + 指纹」下因此可以有两条 Identity(ADR 0030):同一处未改动代码上
      // 的两个不同问题各挂各的评论,各算一条。行按 id 升序,每组的最后一行就是最新那
      // 一轮的。
      const byKey = new Map<string, Identity>();
      for (const row of findingRows) {
        const entry: StageRow = {
          id: row.id,
          runId: row.run_id,
          file: row.file,
          fp: String(row.fp),
          disposition: row.disposition as Disposition,
          commentHtmlUrl: row.comment_html_url,
          continuedFrom: row.continued_from,
          handoffPending: row.handoff_pending === true,
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
      const latestOf = (identity: Identity): StageRow => identity.rows.at(-1)!;
      // 交接未完成(ADR 0025)同样跟着链条走:旧行不在汇总里,标记要落到承接它的那条
      // 上;链上更早那一段没关掉的旧评论,一路传到最后可见的那条。
      const pendingHandoff = new Set<Identity>();
      for (const identity of [...identities].sort((a, b) => latestOf(a).id - latestOf(b).id)) {
        const latest = latestOf(identity);
        if (latest.disposition !== "continued" || latest.commentHtmlUrl === null) continue;
        const successor = successors.get(latest.commentHtmlUrl);
        if (successor === undefined) continue;
        if (identity.firstRow.id < successor.firstRow.id) successor.firstRow = identity.firstRow;
        if (pendingHandoff.has(identity) || identity.rows.some((row) => row.handoffPending)) {
          pendingHandoff.add(successor);
        }
      }

      // 同根因组(CONTEXT.md 同根因组,ADR 0030,issue #309):组属于轮次、每轮重新提,
      // 阶段详情因此只取最新一轮的那一批。成员记的是落库当时那一行,后面的轮次可能已经
      // 把它折叠或延续到别的位置,所以逐个映到此刻列表里的那一条;映不过去的(整条已交接
      // 而没有承接者)不进组——组是多一层视图,少一个成员不该让这一页读不出来。
      const identityOfRow = new Map<number, Identity>();
      for (const identity of identities) {
        for (const row of identity.rows) identityOfRow.set(row.id, identity);
      }
      const currentRowOf = (findingId: number): number | undefined => {
        let identity = identityOfRow.get(findingId);
        // 链长以 Identity 数为界:交接一次只把一条并到后一条,走不完即数据成环,停住。
        for (let hop = 0; identity !== undefined && hop <= identities.length; hop += 1) {
          const latest = latestOf(identity);
          if (latest.disposition !== "continued") return latest.id;
          identity =
            latest.commentHtmlUrl === null ? undefined : successors.get(latest.commentHtmlUrl);
        }
        return undefined;
      };
      const rootCauseGroups: StageRootCauseGroup[] = [];
      const rootCauseOfRow = new Map<number, StageRootCauseRef>();
      // 「最新一轮」要往前找到最近一轮完整审查、没失败、且落下过 Finding 行的:只复核那一
      // 轮不报新的、从不提组(CONTEXT.md 只复核),失败那一轮压根没走到合并,一条都没报出
      // 的那一轮走不到合并 agent、什么也没判过。拿它们当最新一轮会让整个阶段的组凭空消失
      // ——头一轮之后的安静轮次是常态,组卡不该在作者正要组级处置时消失。找到的那一轮报出
      // 过 Finding 却没有组(合并 agent 缺席)就是没有组。
      const runsWithFindings = new Set(findingRows.map((row) => row.run_id));
      const groupRun = runRows.findLast(
        (run) =>
          run.mode !== "verdict-only" &&
          Number(run.failed ?? 0) !== 1 &&
          runsWithFindings.has(run.id),
      );
      for (const group of groupRun === undefined
        ? []
        : await store().rootCauseGroups(groupRun.id)) {
        const findingIds: number[] = [];
        for (const memberId of group.findingIds) {
          const current = currentRowOf(memberId);
          // 一条 Finding 至多属于一个组(ADR 0030):两个成员折到同一行时只留头一份。
          if (current === undefined || rootCauseOfRow.has(current) || findingIds.includes(current)) {
            continue;
          }
          findingIds.push(current);
        }
        // 映完不足两条的整组不出现:同根因组没有单成员这一档(ADR 0030),剩一条时它与
        // 一条普通 Finding 没有分别,组卡只是白占一层。
        if (findingIds.length < 2) continue;
        rootCauseGroups.push({ id: group.id, reason: group.reason, findingIds });
        for (const [position, findingId] of findingIds.entries()) {
          rootCauseOfRow.set(findingId, {
            id: group.id,
            reason: group.reason,
            memberCount: findingIds.length,
            position,
          });
        }
      }

      const startedAt = new Map(runRows.map((run) => [run.id, run.started_at] as const));
      const findings: StageSummaryFinding[] = identities
        .filter((identity) => latestOf(identity).disposition !== "continued")
        .map((identity) => {
          const latest = latestOf(identity);
          const row = latest.row;
          const said = attributions.get(latest.id) ?? [];
          // 代表段(issue #278):升级前落的行两列为 NULL,按同一规则从归属现算。
          const representative = representativeSegment(row, said);
          // 当前位置(issue #368):重定位过的按 placed_*,没有的退回报出它的那一行与
          // 那一轮。两格一起取——行号与它成立的那个 head 分开取就是这一票要修的病。
          const placedLine = row.placed_line;
          const placedRunId = row.placed_run_id === null ? latest.runId : row.placed_run_id;
          return {
            id: latest.id,
            file: latest.file,
            line: placedLine === null ? row.line : placedLine,
            placedRunId,
            reportedLine: row.line,
            title: representative.title,
            severity: row.severity as Severity,
            category: row.category as Category,
            description: representative.description,
            impact: representative.impact,
            suggestion: representative.suggestion,
            models: models.get(latest.id) ?? [],
            attributions: said,
            carried: carried.get(latest.id) ?? [],
            disposition: latest.disposition as Exclude<Disposition, "continued">,
            placement: row.placement as FindingPlacement,
            commentId: row.comment_id,
            commentHtmlUrl: latest.commentHtmlUrl,
            disposedBy: row.disposed_by,
            disposedAt: row.disposed_at,
            note: row.note,
            // 「延续自」是这条 Identity 的事实,不是某一轮的:交接只发生一次,之后的
            // 轮次折叠出来的新行不再带它,取整条上第一条带着它的那一行。
            continuedFrom:
              identity.rows.find((entry) => entry.continuedFrom !== null)?.continuedFrom ?? null,
            handoffPending: pendingHandoff.has(identity),
            // 四列同 NULL 即未判定:取最新那一轮的判定结果,每轮各算各的。
            lineAuthor:
              row.line_author_sha === null
                ? null
                : {
                    sha: row.line_author_sha,
                    name: String(row.line_author_name),
                    email: String(row.line_author_email),
                    authoredAt: String(row.line_author_at),
                    // 升级前的行与补录路径写的那些是 NULL:那时判的就是落点自己那一行。
                    adjacent: row.line_author_adjacent === true,
                  },
            firstRunId: identity.firstRow.runId,
            firstReportedAt: startedAt.get(identity.firstRow.runId)!,
            lastRunId: latest.runId,
            lastReportedAt: startedAt.get(latest.runId)!,
            rootCause: rootCauseOfRow.get(latest.id) ?? null,
          };
        });
      // 排序在服务端定一次:待处置在前(这一页要回答「还剩什么没处置」),再按严重度,
      // 同档按文件与行号,读的人在 diff 里找得到同样的先后。
      const severityRank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
      const pending = (item: StageSummaryFinding): boolean =>
        item.disposition === "unknown" || item.disposition === "unresolved";
      findings.sort(
        (a, b) =>
          Number(pending(b)) - Number(pending(a)) ||
          severityRank[a.severity] - severityRank[b.severity] ||
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.id - b.id,
      );

      const counts = { pending: 0, resolved: 0, fixed: 0 };
      for (const item of findings) {
        if (item.disposition === "fixed") counts.fixed += 1;
        else if (item.disposition === "resolved") counts.resolved += 1;
        else counts.pending += 1;
      }

      const timeline = new Map<number, StageTimelineEntry>(
        runRows.map((run) => [
          run.id,
          {
            runId: run.id,
            headSha: run.head_sha,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            failed: Number(run.failed ?? 0) === 1,
            failure: run.failure,
            // 时间线上要分得出哪一轮是只复核:看到「新报 0」时那不是审查空跑。
            mode: run.mode === "verdict-only" ? "verdict-only" : "full",
            // 时间线上要分得出哪一轮是自己跑起来的(issue #312)。
            triggerSource: readTriggerSource(run.trigger_source),
            reported: 0,
            folded: 0,
            fixed: 0,
            continued: 0,
            missedVerdicts: 0,
            batchFailedVerdicts: 0,
            uncoveredVerdicts: 0,
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
        const runId = row.run_id;
        const entry = timeline.get(runId);
        if (entry === undefined) continue;
        // 没给结论的按由来分三档(issue #412、#413)。升级前的行没有由来这一列,归进
        // 漏复核——那正是它当初被数进去的那一档,旧轮次因此只显示一个总数。
        if (Number(row.missing) === 1) {
          const reason = row.missing_reason;
          if (reason === "batch-failed") entry.batchFailedVerdicts += 1;
          else if (reason === "no-batch") entry.uncoveredVerdicts += 1;
          else entry.missedVerdicts += 1;
        }
        const key = `${runId}\n${row.finding_id}`;
        allFixed.set(key, (allFixed.get(key) ?? true) && row.verdict === "fixed");
      }
      for (const [key, fixed] of allFixed) {
        if (!fixed) continue;
        const [runIdText, findingIdText] = key.split("\n") as [string, string];
        if (!nowFixed.has(Number(findingIdText))) continue;
        timeline.get(Number(runIdText))!.fixed += 1;
      }

      return { findings, counts, timeline: [...timeline.values()], rootCauseGroups };
    },

    async listStages(opts) {
      // 归并、筛选、排序与切页都在这一条查询里:回到 JS 的只有这一页的那几行。
      const scoped = opts.owner !== undefined && opts.repo !== undefined;
      // 仓库过滤先合成一组 owner/repo 对:请求给的那一对与账号可见的那些是同一个维度。
      const pairs =
        opts.repos === undefined
          ? scoped
            ? [{ owner: opts.owner!, repo: opts.repo! }]
            : undefined
          : opts.repos.filter(
              (pair) => !scoped || (pair.owner === opts.owner && pair.repo === opts.repo),
            );
      const conditions: SQL[] = [];
      if (opts.status !== undefined) conditions.push(sql`status = ${opts.status}`);
      if (opts.source !== undefined) conditions.push(sql`source = ${opts.source}`);
      const filtered =
        conditions.length === 0 ? sql`` : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
      // 两段各自加括号:pull 那一段带自己的 `ORDER BY`(DISTINCT ON 要它),不括起来
      // PostgreSQL 会把它读成整个 UNION 的排序而在 `UNION` 处报语法错。
      const rows = (
        await orm.execute<StageQueryRow>(sql`
          SELECT * FROM ((${pullStageSelect(repoPairFilter(pairs, ""))})
                          UNION ALL
                          (${rangeStageSelect(repoPairFilter(pairs, "rr."))})) stages
          ${filtered}
          -- 最近有动静的排在前面。时刻相同的按阶段标识兜底,翻页才不会漂。
          ORDER BY activity_at DESC, stage_id DESC
          LIMIT ${opts.limit} OFFSET ${opts.offset}`)
      ).rows.map(stageRowEntry);
      // 警示也只为这一页算,而且一条查询算完这几轮,不跟着行数涨(issue #421)。
      const alerts = await stageRunAlerts(
        rows.map((row) => alertRunId(row.item)).filter((id) => id !== null),
      );
      // 三个计数只为这一页算:每一行都要读一遍它整个阶段的 Finding。
      const stages: StageListItem[] = [];
      for (const row of rows) {
        const runId = alertRunId(row.item);
        stages.push({
          ...row.item,
          counts: (await store().stageSummary(row.scope)).counts,
          latestRunAlert: runId === null ? null : alerts.get(runId) ?? null,
        });
      }
      return stages;
    },

    async stageDetail(stageId): Promise<StageDetail | undefined> {
      const row = await stageRowById(stageId);
      if (row === undefined) return undefined;
      // 一次 `stageSummary` 同时给出这一行的三个计数与它的时间线:详情页上的汇总与
      // 时间线本来就是同一个阶段的两种看法,算两遍只会让两者有机会对不上。
      const summary = await store().stageSummary(row.scope);
      const comparisons =
        row.item.rangeReviewId === null
          ? []
          : await store().listRangeReviewComparisons(row.item.rangeReviewId);
      // 阶段那一行在详情里与列表里是同一份形状,警示因此照样带上(issue #421)。
      const runId = alertRunId(row.item);
      return {
        stage: {
          ...row.item,
          counts: summary.counts,
          latestRunAlert: runId === null ? null : (await stageRunAlerts([runId])).get(runId) ?? null,
        },
        groups: groupStageRuns(summary.timeline, comparisons),
      };
    },

    async createRangeReview(record) {
      // 分支名要跟着记录一起可见:插入拿到 id 之后立刻补上,失败时整笔回滚。
      // 发起时的比较项同时进历史表:它是这个阶段审过的第一个 commit。
      return await transaction("deferred", async () => {
        const [inserted] = await orm
          .insert(rangeReview)
          .values({
            repoId: record.repoId,
            owner: record.owner,
            repo: record.repo,
            title: record.title,
            baseSha: record.baseSha,
            comparisonSha: record.comparisonSha,
            comparisonSourceKind: record.comparisonSource?.kind ?? null,
            comparisonSourceName: record.comparisonSource?.name ?? null,
            state: "in-progress",
            baseBranch: "",
            headBranch: "",
            createdBy: record.createdBy,
            createdAt: record.createdAt,
          })
          .returning({ id: rangeReview.id });
        const id = inserted!.id;
        const branches = containerBranches(id);
        await orm
          .update(rangeReview)
          .set({ baseBranch: branches.base, headBranch: branches.head })
          .where(eq(rangeReview.id, id));
        await orm.insert(rangeReviewComparison).values({
          rangeReviewId: id,
          sha: record.comparisonSha,
          recordedBy: record.createdBy,
          recordedAt: record.createdAt,
        });
        return id;
      });
    },

    async attachRangeReviewContainer(id, containerPullNumber) {
      await orm
        .update(rangeReview)
        .set({ containerPullNumber, lastForgeFailure: null })
        .where(eq(rangeReview.id, id));
    },

    async failRangeReview(id, failure) {
      await orm
        .update(rangeReview)
        .set({ state: "failed", lastForgeFailure: failure })
        .where(eq(rangeReview.id, id));
    },

    async recordRangeReviewForgeFailure(id, failure) {
      await orm
        .update(rangeReview)
        .set({ lastForgeFailure: failure })
        .where(eq(rangeReview.id, id));
    },

    async advanceRangeReview(record) {
      await transaction("deferred", async () => {
        await orm
          .update(rangeReview)
          .set({
            comparisonSha: record.comparisonSha,
            comparisonSourceKind: record.comparisonSource?.kind ?? null,
            comparisonSourceName: record.comparisonSource?.name ?? null,
            lastForgeFailure: null,
          })
          .where(eq(rangeReview.id, record.id));
        await orm.insert(rangeReviewComparison).values({
          rangeReviewId: record.id,
          sha: record.comparisonSha,
          recordedBy: record.advancedBy,
          recordedAt: record.advancedAt,
        });
      });
    },

    async completeRangeReview(record) {
      // 每日增量随阶段一起关掉(CONTEXT.md 每日增量):完成后的记录不该还写着「开着」。
      await orm
        .update(rangeReview)
        .set({
          state: "completed",
          completedBy: record.completedBy,
          completedAt: record.completedAt,
          lastForgeFailure: null,
          dailyIncrementEnabled: false,
          dailyIncrementBranch: null,
          dailyIncrementEnabledAt: null,
          scheduledCheckTime: "00:00",
          scheduledCheckMode: "verdict-only",
        })
        .where(eq(rangeReview.id, record.id));
    },

    async setRangeReviewDailyIncrement({ id, branch, time, mode, at }) {
      await orm
        .update(rangeReview)
        .set({
          dailyIncrementEnabled: branch !== null,
          dailyIncrementBranch: branch,
          dailyIncrementEnabledAt: branch === null ? null : at,
          scheduledCheckTime: branch === null ? "00:00" : time,
          scheduledCheckMode: branch === null ? "verdict-only" : mode,
        })
        .where(eq(rangeReview.id, id));
    },

    async recordRangeReviewScheduledCheck({ id, at, result }) {
      await orm
        .update(rangeReview)
        .set({ scheduledCheckAt: at, scheduledCheckResult: result })
        .where(eq(rangeReview.id, id));
    },

    async listRangeReviewComparisons(rangeReviewId) {
      return await orm
        .select({
          id: rangeReviewComparison.id,
          sha: rangeReviewComparison.sha,
          recordedBy: rangeReviewComparison.recordedBy,
          recordedAt: rangeReviewComparison.recordedAt,
        })
        .from(rangeReviewComparison)
        .where(eq(rangeReviewComparison.rangeReviewId, rangeReviewId))
        .orderBy(asc(rangeReviewComparison.id));
    },

    async getRangeReview(id) {
      const [row] = await orm.select().from(rangeReview).where(eq(rangeReview.id, id));
      return row === undefined ? undefined : rangeReviewRecord(row);
    },

    async listRangeReviews(opts) {
      const conditions: SQL[] = [];
      if (opts.owner !== undefined && opts.repo !== undefined) {
        conditions.push(eq(rangeReview.owner, opts.owner), eq(rangeReview.repo, opts.repo));
      }
      if (opts.baseSha !== undefined) conditions.push(eq(rangeReview.baseSha, opts.baseSha));
      if (opts.state !== undefined) conditions.push(eq(rangeReview.state, opts.state));
      const rows = await orm
        .select()
        .from(rangeReview)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(sql`${rangeReview.id} DESC`);
      return rows.map(rangeReviewRecord);
    },

    async dispositionStats(from, to) {
      // 接在共同的 identity 折叠之后:labeled 给每条 Identity 取它首次报出那一行的
      // category(不进折叠键,跨轮改口不挪格,与时间窗归属同一轮)。
      const rows = (
        await orm.execute<{
          owner: string;
          repo: string;
          category: string;
          resolved: number;
          fixed: number;
          unresolved: number;
          unknown_closed: number;
          unknown_open: number;
        }>(sql`
          ${sql.raw(STATS_IDENTITY_CTE)},
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
           WHERE continued = 0 AND first_seen >= ${from} AND first_seen <= ${to}
           GROUP BY owner, repo, category
           ORDER BY owner, repo, category`)
      ).rows;
      return rows.map((row) => ({
        owner: row.owner,
        repo: row.repo,
        category: row.category,
        resolved: Number(row.resolved),
        fixed: Number(row.fixed),
        unresolved: Number(row.unresolved),
        unknownClosed: Number(row.unknown_closed),
        unknownOpen: Number(row.unknown_open),
      }));
    },

    async modelParticipation(from, to, repos) {
      // 先摊成「模型 × Identity」再去重:一条 Identity 在一个阶段里有好几行,同一个
      // 模型在其中几行上都报过也只算这条一次;不同模型报同一条则各算一次。
      const rows = (
        await orm.execute<{ model: string; findings: number }>(sql`
          ${sql.raw(STATS_IDENTITY_CTE)}
          SELECT model, COUNT(*) AS findings
            FROM (
              SELECT DISTINCT a.model, s.owner, s.repo, s.pull_number, s.file, s.fp
                FROM src s
                JOIN ${findingAttribution} a ON a.finding_id = s.id
                JOIN identity i
                  ON i.owner = s.owner AND i.repo = s.repo
                 AND i.pull_number = s.pull_number AND i.file = s.file AND i.fp = s.fp
               WHERE i.continued = 0 AND i.first_seen >= ${from} AND i.first_seen <= ${to}
                 AND ${repoPairFilter(repos, "s.")}
            ) participation
           GROUP BY model
           ORDER BY model`)
      ).rows;
      return rows.map((row) => ({ model: row.model, findings: Number(row.findings) }));
    },

    async usageStats(from, to, repos) {
      const [row] = (
        await orm.execute<{
          usage_rows: number;
          input_tokens: number | null;
          output_tokens: number | null;
          cache_read_tokens: number | null;
          cache_write_tokens: number | null;
          total_tokens: number | null;
        }>(sql`
          SELECT COUNT(*) AS usage_rows,
                 SUM(${reviewRun.inputTokens}) AS input_tokens,
                 SUM(${reviewRun.outputTokens}) AS output_tokens,
                 SUM(${reviewRun.cacheReadTokens}) AS cache_read_tokens,
                 SUM(${reviewRun.cacheWriteTokens}) AS cache_write_tokens,
                 SUM(${reviewRun.totalTokens}) AS total_tokens
            FROM ${reviewRun}
           WHERE ${reviewRun.totalTokens} IS NOT NULL
             AND ${reviewRun.startedAt} >= ${from} AND ${reviewRun.startedAt} <= ${to}
             AND ${repoPairFilter(repos, "")}`)
      ).rows;
      const runs = Number(row!.usage_rows);
      if (runs === 0) return undefined;
      return {
        runs,
        inputTokens: Number(row!.input_tokens ?? 0),
        outputTokens: Number(row!.output_tokens ?? 0),
        cacheReadTokens: Number(row!.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(row!.cache_write_tokens ?? 0),
        totalTokens: Number(row!.total_tokens ?? 0),
      };
    },

    async tableCounts() {
      // 表名从 PostgreSQL 的系统目录现问一遍,不另维护清单——清单会跟着建表漂。
      const tables = (
        await orm.execute<{ name: string }>(sql`
          SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           ORDER BY table_name`)
      ).rows;
      const counts: { name: string; rows: number }[] = [];
      for (const table of tables) {
        // 逐表现数,不读 `pg_class.reltuples`:那一列是 ANALYZE 之后的估算,新库上是 -1。
        const [count] = (
          await orm.execute<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${sql.identifier(table.name)}`)
        ).rows;
        counts.push({ name: table.name, rows: Number(count!.c) });
      }
      return counts;
    },

    async databaseSize() {
      const [row] = (
        await orm.execute<{ bytes: number }>(sql`SELECT pg_database_size(current_database()) AS bytes`)
      ).rows;
      return Number(row!.bytes);
    },
  };
}
