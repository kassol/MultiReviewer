/**
 * Review Run 域的持久化(spec #445 第二段,issue #452):轮次、Reviewer 结果、批次中间态、
 * Finding 与归属、承接说法、复核结论、同根因组与审查轨迹。
 *
 * 读写走 builder,builder 表达不了的(CTE、`identityKey` 拼出来的折叠键、行值赋值)用
 * `sql` 模板。写法见 `src/AGENTS.md` 的「域文件的分工与写法」。
 */
import { matchesGlob } from "node:path";

import { and, asc, count, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ReviewRunReviewerPin, ThinkingLevel } from "../../config.ts";
import type {
  FindingPlacement,
  RecordedFindingAttribution,
} from "../../contracts/finding.ts";
import type {
  CarriedAttribution,
  Category,
  Disposition,
  HistoryFinding,
  ReviewerUsage,
  ReviewRunMode,
  Severity,
} from "../finding.ts";
import { DEFAULT_MIN_REPORT_SEVERITY } from "../finding.ts";
import type { TimedOutcome } from "../batch.ts";
import type { TraceKind, TraceScope } from "../trace.ts";
import { rangeReview } from "../schema/stages.ts";
import {
  finding,
  findingAttribution,
  findingCarriedAttribution,
  findingVerdict,
  reviewerOutcome,
  reviewRun,
  reviewRunBatchOutcome,
  reviewRunReviewerPin,
  reviewTrace,
  rootCauseGroup,
  rootCauseGroupMember,
} from "../schema/runs.ts";
import type { RootCauseGroup, RunListItem, Store } from "./index.ts";
import {
  columnName,
  identityKey,
  readMinReportSeverity,
  readTriggerSource,
  repoPairFilter,
  representativeSegment,
  stageScopeFilter,
  type StoreContext,
} from "./shared.ts";

/** finding 与 review_run 在那几条 `sql` 模板里的别名,列引用因此不必手写表限定写法。 */
const F = alias(finding, "f");
const RUN = alias(reviewRun, "run");
/** 同一条查询里 finding 的第二份:被继承、被交接的那一行。 */
const PRIOR = alias(finding, "prior");

/**
 * 还能自动处置的那些行(ADR 0016):当前处置是 unknown 或未处置,且从来没有被显式处置过。
 * `disposed_at` 就是那个标记——面板处置写它,自动处置也写它(处置人留空),于是一行至多被
 * 自动处置一次:人把「已修复」改回未处置之后,自动规则不再碰它。
 */
const AUTO_DISPOSABLE = sql`${finding.disposition} IN ('unknown', 'unresolved')
                            AND ${finding.disposedAt} IS NULL`;

/** 「同一个 pull request 名下的历史 finding」。回填与自动处置都按它限定范围。 */
function pullRequestScope(owner: string, repo: string, pullNumber: number): SQL {
  return sql`${finding.runId} IN (SELECT ${reviewRun.id} FROM ${reviewRun}
                                   WHERE ${reviewRun.owner} = ${owner}
                                     AND ${reviewRun.repo} = ${repo}
                                     AND ${reviewRun.pullNumber} = ${pullNumber})`;
}

/**
 * 回填一条更新时它该落在哪些行上(issue #307)。先认评论:一条评论的 resolve 状态只说得了
 * 它自己承载的那条 Finding,同一处的另一条 Identity 各有各的评论(ADR 0030)。没有评论
 * 载体的行才退回「文件 + 指纹」,与 `identityKey` 的兜底同一档。评论 id 传 null 时前一档
 * 恒不成立,整个条件就只剩后一档,正文锚点那一档因此走同一句 SQL。
 */
function backfillTarget(commentId: string | null, file: string, fingerprint: string): SQL {
  return sql`(${finding.commentId} = ${commentId}
              OR (${finding.commentId} IS NULL AND ${finding.file} = ${file}
                  AND ${finding.fingerprint} = ${fingerprint}))`;
}

/** 五列用量读成一份 `ReviewerUsage`。总量为 NULL 即这一行没有记过用量。 */
function recordedUsage(row: {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}): ReviewerUsage | undefined {
  if (row.totalTokens === null) return undefined;
  return {
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
    totalTokens: row.totalTokens,
  };
}

/** 一份用量摊成五列的写入值。没有用量即五列全 NULL。 */
function usageValues(usage: ReviewerUsage | undefined): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
} {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
}

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

const FAILURE_EXCERPT_CHARS = 200;

function failureExcerpt(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > FAILURE_EXCERPT_CHARS
    ? `${text.slice(0, FAILURE_EXCERPT_CHARS)}…`
    : text;
}

type RunsMethods = Pick<
  Store,
  | "startRun"
  | "failInterruptedRuns"
  | "recordRunFailure"
  | "interruptedRuns"
  | "recordBatchOutcome"
  | "resumeState"
  | "finishRun"
  | "rootCauseGroups"
  | "stageHistory"
  | "relocationCandidates"
  | "recordFindingRelocations"
  | "listRepoFindings"
  | "pendingLineAuthors"
  | "recordLineAuthors"
  | "recordFindingComments"
  | "appendTrace"
  | "listTrace"
  | "listRuns"
  | "getRunRange"
  | "getFinding"
  | "recordDisposition"
  | "pendingAutoDispositions"
  | "recordAutoDisposition"
  | "historyPlacements"
  | "continuationCandidates"
  | "recordContinuation"
  | "pendingHandoffs"
  | "completeHandoff"
  | "backfillDispositions"
  | "markPullRequestState"
>;

export function runsMethods(ctx: StoreContext): RunsMethods {
  const { orm, transaction, store, parseAuxiliaryModel } = ctx;

  /** 这些 Finding 各自承接来的历史说法(issue #267),按 finding id 归组、段内按落库顺序。 */
  const carriedFor = async (
    findingIds: readonly number[],
  ): Promise<Map<number, CarriedAttribution[]>> => {
    if (findingIds.length === 0) return new Map();
    const rows = await orm
      .select({
        findingId: findingCarriedAttribution.findingId,
        model: findingCarriedAttribution.model,
        runId: findingCarriedAttribution.runId,
        description: findingCarriedAttribution.description,
        impact: findingCarriedAttribution.impact,
        suggestion: findingCarriedAttribution.suggestion,
        headSha: reviewRun.headSha,
      })
      .from(findingCarriedAttribution)
      .innerJoin(reviewRun, eq(reviewRun.id, findingCarriedAttribution.runId))
      .where(inArray(findingCarriedAttribution.findingId, [...findingIds]))
      .orderBy(asc(findingCarriedAttribution.findingId), asc(findingCarriedAttribution.position));
    const grouped = Map.groupBy(rows, (row) => row.findingId);
    return new Map(
      [...grouped].map(([id, group]) => [
        id,
        group.map((row) => ({
          model: row.model,
          runId: row.runId,
          headSha: row.headSha,
          description: row.description,
          impact: row.impact,
          suggestion: row.suggestion,
        })),
      ]),
    );
  };

  /**
   * 「本阶段每条 Finding Identity 的最新一行」那段 CTE(`stageHistory` / `relocationCandidates`
   * / `listRepoFindings` 共用)。折叠键与处置率同源(`identityKey`):承载它的那条评论,没有
   * 载体的退回「文件 + 指纹」。「已延续」的整条不出现——那处 Finding 已经交接到新位置。
   */
  const latestPerIdentity = (columns: SQL, scopeCondition: SQL, extra: SQL | undefined): SQL =>
    sql`WITH scoped AS (
          SELECT ${columns}, ${identityKey(F)} AS fp
            FROM ${finding} ${F}
            JOIN ${reviewRun} ${RUN} ON ${F.runId} = ${RUN.id}
           WHERE ${scopeCondition}
        )
        SELECT s.* FROM scoped s
         WHERE s.id = (SELECT MAX(latest.id) FROM scoped latest
                        WHERE latest.file = s.file AND latest.fp = s.fp)
           AND s.disposition <> 'continued'
           ${extra ?? sql``}`;

  return {
    async startRun(meta) {
      return await transaction(async () => {
        const rangeReviewId = meta.rangeReviewId ?? null;
        // PR 状态属于整个审查阶段。closed/reopened 会改写该 PR 的全部历史行;新轮次在
        // 同一事务里继承当前值,手动重跑已关闭 PR 时不能凭一行 NULL 把阶段改回进行中。
        const closedRows =
          rangeReviewId === null
            ? await orm
                .select({ id: reviewRun.id })
                .from(reviewRun)
                .where(
                  and(
                    eq(reviewRun.owner, meta.owner),
                    eq(reviewRun.repo, meta.repo),
                    eq(reviewRun.pullNumber, meta.pullNumber),
                    isNull(reviewRun.rangeReviewId),
                    eq(reviewRun.prState, "closed"),
                  ),
                )
                .limit(1)
            : [];
        const [inserted] = await orm
          .insert(reviewRun)
          .values({
            owner: meta.owner,
            repo: meta.repo,
            pullNumber: meta.pullNumber,
            headSha: meta.headSha,
            title: meta.title ?? null,
            rangeReviewId,
            prState: closedRows.length > 0 ? "closed" : null,
            triggeredBy: meta.triggeredBy ?? null,
            // 触发来源(issue #312):调用方说了算,不从用户名快照推——定时那一档也没有
            // 用户名,推出来的会是投递。
            triggerSource: meta.triggerSource ?? "delivery",
            startedAt: meta.startedAt,
            changedFiles: meta.changedFiles,
            changedLines: meta.changedLines,
            batchCount: meta.batchCount,
            ruleSetVersion: meta.ruleSetVersion ?? null,
            directive: meta.directive ?? null,
            mode: meta.mode ?? "full",
            // 历史快照随开跑落库(issue #248):续跑的批次读它,重启期间的处置不改变
            // 这一轮各批看到的历史。
            historyJson: meta.history === undefined ? null : JSON.stringify(meta.history),
            // 完整批次计划同一次写下(issue #253):任何批次完成之前它就在,第一批就崩的
            // 轮次续跑时也有完整的核对依据。
            batchPlanJson: meta.batches === undefined ? null : JSON.stringify(meta.batches),
            // 开跑时的阈值随这一轮落库(issue #271):之后改设置追不上已经开跑的它。
            minReportSeverity: meta.minReportSeverity ?? DEFAULT_MIN_REPORT_SEVERITY,
            // 开跑时解析出的辅助模型同一次写下(issue #304):合并 agent 用哪一处模型
            // 由这一行说了算,续跑读它。
            auxiliaryModel:
              meta.auxiliaryModel == null ? null : JSON.stringify(meta.auxiliaryModel),
          })
          .returning({ id: reviewRun.id });
        const runId = inserted!.id;
        if (meta.reviewerPins.length > 0) {
          await orm.insert(reviewRunReviewerPin).values(
            meta.reviewerPins.map((pin, position) => ({
              runId,
              position,
              identity: pin.identity,
              provider: pin.provider,
              model: pin.model,
              modelServiceVersion: pin.modelServiceVersion,
              baseUrl: pin.target?.baseUrl ?? null,
              api: pin.target?.api ?? null,
              runtimeModelJson:
                pin.runtimeModel === null ? null : JSON.stringify(pin.runtimeModel),
              materializationFailure: pin.failure,
              thinkingLevel: pin.thinkingLevel,
            })),
          );
        }
        return runId;
      });
    },

    async failInterruptedRuns(failure, at, runIds) {
      // `runIds` 缺省即全部停在运行中的轮次;给了就只认这几个 id,其余照旧不动
      // (issue #248:续跑不成立的那些逐轮改判,正在续跑的那些不能被一并扫掉)。
      const scope =
        runIds === undefined
          ? isNull(reviewRun.finishedAt)
          : and(isNull(reviewRun.finishedAt), inArray(reviewRun.id, [...runIds]));
      const rows = await orm
        .select({
          id: reviewRun.id,
          owner: reviewRun.owner,
          repo: reviewRun.repo,
          pullNumber: reviewRun.pullNumber,
        })
        .from(reviewRun)
        .where(scope);
      // 没有中断轮次时一个写都不发:启动路径因此零改动,调用方也不去问 Forge。
      if (rows.length === 0) return [];
      // 一句原因落两处,先定形再写(issue #436):轮次那一列与借来的 outcome 行说的是
      // 同一件事,兜底只在其中一处时两边会说不一样的话。
      const text = runFailureText(failure);
      const ids = rows.map((row) => row.id);
      await transaction(async () => {
        // 失败原因借 Reviewer 指定各写一行 outcome:计数与耗时都归零,这一轮它们
        // 什么都没跑完。
        const pins = await orm
          .select({ runId: reviewRunReviewerPin.runId, identity: reviewRunReviewerPin.identity })
          .from(reviewRunReviewerPin)
          .where(inArray(reviewRunReviewerPin.runId, ids))
          .orderBy(asc(reviewRunReviewerPin.runId), asc(reviewRunReviewerPin.position));
        if (pins.length > 0) {
          await orm.insert(reviewerOutcome).values(
            pins.map((pin) => ({
              runId: pin.runId,
              model: pin.identity,
              failure: text,
              findingCount: 0,
              anomalyCount: 0,
              rejectedToolCalls: 0,
              anchorRejections: 0,
              durationMs: 0,
            })),
          );
        }
        // 结束时间取启动时刻。耗时留空:进程什么时候落地的没人知道,写一个算出来的
        // 数字就是编。同一句原因也写进轮次级那一列(ADR 0026):零 pin 的轮次没有
        // outcome 行可借,原因只在这里读得到。
        await orm
          .update(reviewRun)
          .set({ finishedAt: at, failed: true, failure: text })
          .where(scope);
        // 改判掉的那些轮次不会再被续跑,中间态的批次结果一并清掉(issue #248)。
        await orm.delete(reviewRunBatchOutcome).where(inArray(reviewRunBatchOutcome.runId, ids));
      });
      return rows.map((row) => ({
        runId: row.id,
        owner: row.owner,
        repo: row.repo,
        pullNumber: row.pullNumber,
      }));
    },

    async recordRunFailure(runId, failure) {
      await orm
        .update(reviewRun)
        .set({ failure: runFailureText(failure) })
        .where(eq(reviewRun.id, runId));
    },

    async interruptedRuns() {
      const rows = await orm
        .select({
          id: reviewRun.id,
          owner: reviewRun.owner,
          repo: reviewRun.repo,
          pullNumber: reviewRun.pullNumber,
          headSha: reviewRun.headSha,
          rangeReviewId: reviewRun.rangeReviewId,
          directive: reviewRun.directive,
          mode: reviewRun.mode,
          triggeredBy: reviewRun.triggeredBy,
          auxiliaryModel: reviewRun.auxiliaryModel,
        })
        .from(reviewRun)
        .where(isNull(reviewRun.finishedAt))
        .orderBy(asc(reviewRun.id));
      return rows.map((row) => ({
        runId: row.id,
        owner: row.owner,
        repo: row.repo,
        pullNumber: row.pullNumber,
        headSha: row.headSha,
        rangeReviewId: row.rangeReviewId,
        directive: row.directive,
        // 升级前的旧行没有这一列,读回按完整审查算,与 `listRuns` 同一读法。
        mode: (row.mode ?? "full") as ReviewRunMode,
        triggeredBy: row.triggeredBy,
        // 冻结的那一处辅助模型(issue #304):续跑的合并 agent 按它建,不重新解析。
        auxiliaryModel: parseAuxiliaryModel(row.auxiliaryModel),
      }));
    },

    async recordBatchOutcome(runId, batchIndex, model, outcome) {
      await orm
        .insert(reviewRunBatchOutcome)
        .values({ runId, batchIndex, model, outcomeJson: JSON.stringify(outcome) })
        .onConflictDoUpdate({
          target: [
            reviewRunBatchOutcome.runId,
            reviewRunBatchOutcome.batchIndex,
            reviewRunBatchOutcome.model,
          ],
          set: {
            outcomeJson: sql`excluded.${columnName(reviewRunBatchOutcome.outcomeJson)}`,
          },
        });
    },

    async resumeState(runId) {
      const [run] = await orm
        .select({
          headSha: reviewRun.headSha,
          ruleSetVersion: reviewRun.ruleSetVersion,
          batchCount: reviewRun.batchCount,
          historyJson: reviewRun.historyJson,
          batchPlanJson: reviewRun.batchPlanJson,
          minReportSeverity: reviewRun.minReportSeverity,
        })
        .from(reviewRun)
        .where(eq(reviewRun.id, runId));
      if (run === undefined) return undefined;
      const rows = await orm
        .select({
          batchIndex: reviewRunBatchOutcome.batchIndex,
          model: reviewRunBatchOutcome.model,
          outcomeJson: reviewRunBatchOutcome.outcomeJson,
        })
        .from(reviewRunBatchOutcome)
        .where(eq(reviewRunBatchOutcome.runId, runId))
        .orderBy(asc(reviewRunBatchOutcome.batchIndex));
      // pin 与已落库的批次一起取(issue #248 的评审复核):第一批就崩的那种轮次一个批次
      // 都没有,模型组合换没换只有这几行说得出。
      const pins = await orm
        .select({ identity: reviewRunReviewerPin.identity })
        .from(reviewRunReviewerPin)
        .where(eq(reviewRunReviewerPin.runId, runId))
        .orderBy(asc(reviewRunReviewerPin.position));
      // 逐行按批次归拢成「这一批哪几个模型已经有结果」(issue #410)。
      const batches = new Map<number, Map<string, TimedOutcome>>();
      for (const row of rows) {
        const byModel = batches.get(row.batchIndex) ?? new Map<string, TimedOutcome>();
        byModel.set(row.model, JSON.parse(row.outcomeJson) as TimedOutcome);
        batches.set(row.batchIndex, byModel);
      }
      return {
        headSha: run.headSha,
        ruleSetVersion: run.ruleSetVersion,
        // 升级前的旧行没有这一列,读回按全报算,与 `mode` 同律。
        minReportSeverity:
          readMinReportSeverity(run.minReportSeverity ?? undefined) ?? DEFAULT_MIN_REPORT_SEVERITY,
        batchCount: run.batchCount,
        plan:
          run.batchPlanJson === null
            ? undefined
            : (JSON.parse(run.batchPlanJson) as string[][]),
        reviewers: pins.map((pin) => pin.identity),
        history:
          run.historyJson === null
            ? undefined
            : (JSON.parse(run.historyJson) as HistoryFinding[]),
        batches,
      };
    },

    async finishRun(runId, result) {
      const rootCauseGroupIds: number[] = [];
      // 一次 Review Run 的收尾要么整体可见,要么整体不可见:半张表的 Finding
      // 会让事后的处置率统计算出偏低的分母。
      await transaction(async () => {
        // 本轮总量含合并 agent(issue #228):面板的花费数字要覆盖这一轮真的花掉的全部
        // token,而逐 Reviewer 那几行仍只有各自的会话——差额就是合并 agent。
        const runUsage = sumUsage([
          ...result.outcomes,
          ...(result.mergeUsage === undefined ? [] : [{ usage: result.mergeUsage }]),
        ]);
        await orm
          .update(reviewRun)
          .set({
            finishedAt: result.finishedAt,
            durationMs: result.durationMs,
            failed: result.failed,
            ...usageValues(runUsage),
          })
          .where(eq(reviewRun.id, runId));

        // 中间态的批次结果到这里就没用了(issue #248):收尾已经把合并后的结果落进
        // reviewer_outcome 与 finding,这张表只服务「还没收尾的那一轮」。
        await orm.delete(reviewRunBatchOutcome).where(eq(reviewRunBatchOutcome.runId, runId));

        if (result.outcomes.length > 0) {
          await orm.insert(reviewerOutcome).values(
            result.outcomes.map((outcome) => ({
              runId,
              model: outcome.model,
              failure: outcome.failure ?? null,
              findingCount: outcome.findingCount,
              anomalyCount: outcome.anomalyCount,
              rejectedToolCalls: outcome.rejectedToolCalls,
              anchorRejections: outcome.anchorRejections,
              durationMs: outcome.durationMs,
              ...usageValues(outcome.usage),
            })),
          );
        }

        // 同根因组的成员用最终落库的那一行(issue #308):合并组下标在这里换成刚插进去
        // 的 id。折叠到历史的那些成员直接给了历史行 id,不进这张表。
        const findingIdByGroup = new Map<number, number>();
        for (const entry of result.findings) {
          const [inserted] = await orm
            .insert(finding)
            .values({
              runId,
              file: entry.file,
              line: entry.line,
              title: entry.title,
              severity: entry.severity,
              category: entry.category,
              description: entry.description,
              impact: entry.impact,
              suggestion: entry.suggestion,
              fingerprint: entry.fingerprint ?? null,
              groupIndex: entry.groupIndex,
              disposition: entry.disposition,
              placement: entry.placement,
              commentId: entry.commentId ?? null,
              commentHtmlUrl: entry.commentHtmlUrl ?? null,
              lineAuthorSha: entry.lineAuthor?.sha ?? null,
              lineAuthorName: entry.lineAuthor?.name ?? null,
              lineAuthorEmail: entry.lineAuthor?.email ?? null,
              lineAuthorAt: entry.lineAuthor?.authoredAt ?? null,
              lineAuthorAdjacent:
                entry.lineAuthor === undefined ? null : entry.lineAuthor.adjacent,
              ruleId: entry.ruleId ?? null,
            })
            .returning({ id: finding.id });
          const findingId = inserted!.id;
          findingIdByGroup.set(entry.groupIndex, findingId);
          if (entry.attributions.length > 0) {
            await orm.insert(findingAttribution).values(
              entry.attributions.map((said, position) => ({
                findingId,
                position,
                model: said.model,
                severity: said.severity,
                category: said.category,
                description: said.description,
                impact: said.impact,
                suggestion: said.suggestion,
              })),
            );
          }
          const carried = entry.carried ?? [];
          if (carried.length > 0) {
            await orm.insert(findingCarriedAttribution).values(
              carried.map((said, position) => ({
                findingId,
                position,
                model: said.model,
                runId: said.runId,
                description: said.description,
                impact: said.impact,
                suggestion: said.suggestion,
              })),
            );
          }
        }

        // 复核结论逐条落库(ADR 0016)。漏给的那些由编排层按「无法判断」补齐并标
        // `missing`,这里只照写:裁决在编排层按同一批记录做完。两列由同一格推出来:
        // 标记与由来因此不会各说各话。
        const verdicts = result.verdicts ?? [];
        if (verdicts.length > 0) {
          await orm.insert(findingVerdict).values(
            verdicts.map((verdict) => ({
              runId,
              model: verdict.model,
              findingId: verdict.findingId,
              verdict: verdict.verdict,
              missing: verdict.missing !== undefined,
              missingReason: verdict.missing ?? null,
            })),
          );
        }

        // 同根因组(ADR 0030,issue #308):组与成员随这一笔事务一起落,组的 id 回给调用方
        // ——Forge 评论正文里「同根因另见 N 处」那一行要链到它。成员指不到落库行的直接跳过
        // (合并组被 diff 终筛丢掉之类):组只是多一层视图,少一个成员不该掀掉整轮收尾。
        for (const group of result.rootCauses ?? []) {
          const [insertedGroup] = await orm
            .insert(rootCauseGroup)
            .values({ runId, reason: group.reason })
            .returning({ id: rootCauseGroup.id });
          const groupId = insertedGroup!.id;
          rootCauseGroupIds.push(groupId);
          const members = group.members.flatMap((member, position) => {
            const findingId = findingIdByGroup.get(member);
            return findingId === undefined ? [] : [{ groupId, findingId, position }];
          });
          if (members.length > 0) await orm.insert(rootCauseGroupMember).values(members);
        }

        // 折叠到已有 Forge 评论的行继承那条评论上一次处置的元数据(issue #152)。处置
        // 的载体是评论(ADR 0006),同一条评论名下的历史行与本轮新行说的是同一次处置:
        // 不继承的话备注与署名活不过下一轮,`disposed_at` 这个「这一行被显式处置过」
        // 的标记也会被新的一行稀释,自动处置于是又碰它一次(ADR 0016)。`disposition`
        // 不在此列——它由跨轮匹配与回填决定,口径不变。本轮新发的评论不必走这一步:
        // 它的 id 是新的,库里不会有同 id 的历史行,`recordFindingComments` 因此不动。
        const inheritable = sql`${PRIOR.commentId} = ${finding.commentId}
                                AND ${PRIOR.runId} <> ${finding.runId}
                                AND ${PRIOR.disposedAt} IS NOT NULL`;
        await orm.execute(sql`
          UPDATE ${finding}
             SET (${columnName(finding.disposedBy)}, ${columnName(finding.disposedAt)},
                  ${columnName(finding.dispositionNote)}) =
                   (SELECT ${PRIOR.disposedBy}, ${PRIOR.disposedAt}, ${PRIOR.dispositionNote}
                      FROM ${finding} ${PRIOR}
                     WHERE ${inheritable}
                     ORDER BY ${PRIOR.id} DESC LIMIT 1)
           WHERE ${finding.runId} = ${runId} AND ${finding.commentId} IS NOT NULL
             AND EXISTS (SELECT 1 FROM ${finding} ${PRIOR} WHERE ${inheritable})`);
      });
      return rootCauseGroupIds;
    },

    async rootCauseGroups(runId) {
      const rows = await orm
        .select({
          id: rootCauseGroup.id,
          reason: rootCauseGroup.reason,
          findingId: rootCauseGroupMember.findingId,
        })
        .from(rootCauseGroup)
        .innerJoin(rootCauseGroupMember, eq(rootCauseGroupMember.groupId, rootCauseGroup.id))
        .where(eq(rootCauseGroup.runId, runId))
        .orderBy(asc(rootCauseGroup.id), asc(rootCauseGroupMember.position));
      const byId = new Map<number, RootCauseGroup>();
      for (const row of rows) {
        const group = byId.get(row.id) ?? { id: row.id, reason: row.reason, findingIds: [] };
        group.findingIds.push(row.findingId);
        byId.set(row.id, group);
      }
      return [...byId.values()];
    },

    async stageHistory(scope) {
      // 每条 Identity 取最新那一行——它才带着当前的处置状态、备注与最新表述;同一处未
      // 改动代码上的两个不同问题因此各注入一条(ADR 0030),不再被指纹压成一条。
      // 最新一行是「已延续」的整条不注入:这处 Finding 已经交接到新位置,新位置那条
      // 自己在历史里,再给一遍就是同一个问题让模型复核两次。
      // 行号取当前位置(issue #368):本轮开跑时已经把它重定位到这一轮的 head 上,注入
      // 给 Reviewer 的必须是它此刻指着的那一行,而不是几轮之前被报出来时的那一行。
      const rows = (
        await orm.execute(
          sql`${latestPerIdentity(
            sql`${F.id} AS id, ${F.file} AS file,
                COALESCE(${F.placedLine}, ${F.line}) AS line, ${F.title} AS title,
                ${F.severity} AS severity, ${F.category} AS category,
                ${F.description} AS description, ${F.disposition} AS disposition,
                ${F.dispositionNote} AS note`,
            stageScopeFilter(scope, RUN),
            undefined,
          )} ORDER BY s.id`,
        )
      ).rows as Record<string, unknown>[];
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
      // 折叠与筛选与 `stageHistory` 逐字同源,只多一道「算得出指纹」:没有指纹的行
      // 找不回自己那扇窗口,重定位对它无从下手。
      const rows = (
        await orm.execute(
          sql`${latestPerIdentity(
            sql`${F.id} AS id, ${F.file} AS file,
                COALESCE(${F.placedLine}, ${F.line}) AS line,
                ${F.fingerprint} AS fingerprint, ${F.disposition} AS disposition`,
            stageScopeFilter(scope, RUN),
            sql`AND s.fingerprint IS NOT NULL`,
          )} ORDER BY s.id`,
        )
      ).rows as Record<string, unknown>[];
      return rows.map((row) => ({
        findingId: Number(row["id"]),
        file: String(row["file"]),
        line: Number(row["line"]),
        fingerprint: String(row["fingerprint"]),
      }));
    },

    async recordFindingRelocations(runId, placements) {
      for (const placement of placements) {
        await orm
          .update(finding)
          .set({ placedLine: placement.line, placedRunId: runId })
          .where(eq(finding.id, placement.findingId));
      }
    },

    async listRepoFindings(query, limit) {
      const rows = (
        await orm.execute(
          sql`${latestPerIdentity(
            sql`${F.id} AS id, ${F.file} AS file, ${F.line} AS line, ${F.title} AS title,
                ${F.severity} AS severity, ${F.disposition} AS disposition,
                ${F.description} AS description, ${F.impact} AS impact,
                ${F.suggestion} AS suggestion`,
            sql`${RUN.owner} = ${query.owner} AND ${RUN.repo} = ${query.repo}`,
            query.disposition === undefined
              ? undefined
              : sql`AND s.disposition = ${query.disposition}`,
          )} ORDER BY s.id DESC`,
        )
      ).rows as Record<string, unknown>[];
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
      return await orm
        .select({
          findingId: finding.id,
          headSha: reviewRun.headSha,
          file: finding.file,
          line: finding.line,
        })
        .from(finding)
        .innerJoin(reviewRun, eq(finding.runId, reviewRun.id))
        .where(and(stageScopeFilter(scope), isNull(finding.lineAuthorSha)))
        .orderBy(asc(finding.id));
    },

    async recordLineAuthors(authors) {
      // 只写还是 NULL 的那些:补录是异步的,期间可能有新一轮把这条 Finding 的行作者写上。
      for (const entry of authors) {
        await orm
          .update(finding)
          .set({
            lineAuthorSha: entry.lineAuthor.sha,
            lineAuthorName: entry.lineAuthor.name,
            lineAuthorEmail: entry.lineAuthor.email,
            lineAuthorAt: entry.lineAuthor.authoredAt,
          })
          .where(and(eq(finding.id, entry.findingId), isNull(finding.lineAuthorSha)));
      }
    },

    async recordFindingComments(runId, refs) {
      // 一个合并组落成一条 Finding、一条评论:处置的载体就是它。
      for (const ref of refs) {
        await orm
          .update(finding)
          .set({ commentId: ref.commentId, commentHtmlUrl: ref.commentHtmlUrl })
          .where(and(eq(finding.runId, runId), eq(finding.groupIndex, ref.groupIndex)));
      }
    },

    async appendTrace(runId, event) {
      const at = new Date().toISOString();
      const payload = JSON.stringify(event.payload ?? null);
      const reviewer = event.reviewer ?? null;
      // 序号是这一轮之内的 `MAX + 1`:事务里先把轮次那一行锁住再取(ADR 0036),否则
      // 两个连接并发追加会算出同一个号,主键当场撞上。
      const seq = await transaction(async () => {
        await orm.execute(
          sql`SELECT 1 FROM ${reviewRun} WHERE ${reviewRun.id} = ${runId} FOR UPDATE`,
        );
        const [current] = await orm
          .select({ value: sql<number | null>`MAX(${reviewTrace.seq})` })
          .from(reviewTrace)
          .where(eq(reviewTrace.runId, runId));
        const next = (current?.value ?? 0) + 1;
        await orm.insert(reviewTrace).values({
          runId,
          seq: next,
          at,
          scope: event.scope,
          reviewer,
          kind: event.kind,
          payload,
        });
        return next;
      });
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
      const rows = await orm
        .select({
          seq: reviewTrace.seq,
          at: reviewTrace.at,
          scope: reviewTrace.scope,
          reviewer: reviewTrace.reviewer,
          kind: reviewTrace.kind,
          payload: reviewTrace.payload,
        })
        .from(reviewTrace)
        .where(and(eq(reviewTrace.runId, runId), sql`${reviewTrace.seq} > ${afterSeq ?? 0}`))
        .orderBy(asc(reviewTrace.seq));
      return rows.map((row) => ({
        seq: row.seq,
        runId,
        at: row.at,
        scope: row.scope as TraceScope,
        ...(row.reviewer === null ? {} : { reviewer: row.reviewer }),
        kind: row.kind as TraceKind,
        payload: JSON.parse(row.payload) as unknown,
      }));
    },

    async listRuns(opts) {
      const conditions: (SQL | undefined)[] = [
        opts.beforeId === undefined ? undefined : lt(reviewRun.id, opts.beforeId),
        opts.owner !== undefined && opts.repo !== undefined
          ? and(eq(reviewRun.owner, opts.owner), eq(reviewRun.repo, opts.repo))
          : undefined,
        opts.rangeReviewId === undefined
          ? undefined
          : eq(reviewRun.rangeReviewId, opts.rangeReviewId),
        repoPairFilter(opts.repos, reviewRun.owner, reviewRun.repo),
        opts.id === undefined ? undefined : eq(reviewRun.id, opts.id),
      ];
      const runs = await orm
        .select({
          id: reviewRun.id,
          owner: reviewRun.owner,
          repo: reviewRun.repo,
          pullNumber: reviewRun.pullNumber,
          headSha: reviewRun.headSha,
          title: reviewRun.title,
          rangeReviewId: reviewRun.rangeReviewId,
          triggeredBy: reviewRun.triggeredBy,
          triggerSource: reviewRun.triggerSource,
          directive: reviewRun.directive,
          mode: reviewRun.mode,
          startedAt: reviewRun.startedAt,
          finishedAt: reviewRun.finishedAt,
          failed: reviewRun.failed,
          failure: reviewRun.failure,
          inputTokens: reviewRun.inputTokens,
          outputTokens: reviewRun.outputTokens,
          cacheReadTokens: reviewRun.cacheReadTokens,
          cacheWriteTokens: reviewRun.cacheWriteTokens,
          totalTokens: reviewRun.totalTokens,
        })
        .from(reviewRun)
        .where(and(...conditions))
        .orderBy(desc(reviewRun.id))
        .limit(opts.limit);
      if (runs.length === 0) return [];

      const ids = runs.map((run) => run.id);
      // 逐模型的行来自 reviewer_outcome:它一轮一模型一行并带 failure,失败的模型
      // 因此照样列出。Finding 数仍数 finding 表——outcome 上的 finding_count 是
      // Reviewer 自报的合并前条数,与落库行数不是同一个口径。
      const byOutcome = await orm
        .select({
          runId: reviewerOutcome.runId,
          model: reviewerOutcome.model,
          failure: reviewerOutcome.failure,
          inputTokens: reviewerOutcome.inputTokens,
          outputTokens: reviewerOutcome.outputTokens,
          cacheReadTokens: reviewerOutcome.cacheReadTokens,
          cacheWriteTokens: reviewerOutcome.cacheWriteTokens,
          totalTokens: reviewerOutcome.totalTokens,
        })
        .from(reviewerOutcome)
        .where(inArray(reviewerOutcome.runId, ids))
        .orderBy(asc(reviewerOutcome.model));
      // 一个模型报了几条:数它的归属,不数 finding 行——一条 Finding 可以有几个归属
      // (ADR 0015),按行数会把合并掉的那几条从这个模型名下抹掉。
      const byModel = await orm
        .select({
          runId: finding.runId,
          model: findingAttribution.model,
          findings: count(),
        })
        .from(findingAttribution)
        .innerJoin(finding, eq(finding.id, findingAttribution.findingId))
        .where(inArray(finding.runId, ids))
        .groupBy(finding.runId, findingAttribution.model)
        .orderBy(asc(findingAttribution.model));
      // 已处置口径与处置率同源:只认行级承载。人工与自动分开数,面板据此把两者分开显示。
      // 「已延续」两头都不占:它既不是处置,也不该继续挂在这一轮的待处置里等人去点
      // ——那处 Finding 已经交接到新位置,要处置的是新位置那条。
      const byGroup = await orm
        .select({
          runId: finding.runId,
          total: count(),
          resolved: sql<number>`SUM(CASE WHEN ${finding.disposition} = 'resolved' THEN 1 ELSE 0 END)`,
          fixed: sql<number>`SUM(CASE WHEN ${finding.disposition} = 'fixed' THEN 1 ELSE 0 END)`,
        })
        .from(finding)
        .where(
          and(
            inArray(finding.runId, ids),
            eq(finding.placement, "inline"),
            sql`${finding.disposition} <> 'continued'`,
          ),
        )
        .groupBy(finding.runId);

      const byFinding = await orm
        .select()
        .from(finding)
        .where(inArray(finding.runId, ids))
        .orderBy(asc(finding.id));
      const byAttribution = await orm
        .select({
          findingId: findingAttribution.findingId,
          model: findingAttribution.model,
          severity: findingAttribution.severity,
          category: findingAttribution.category,
          description: findingAttribution.description,
          impact: findingAttribution.impact,
          suggestion: findingAttribution.suggestion,
        })
        .from(findingAttribution)
        .innerJoin(finding, eq(finding.id, findingAttribution.findingId))
        .where(inArray(finding.runId, ids))
        .orderBy(asc(findingAttribution.findingId), asc(findingAttribution.position));
      const carried = await carriedFor(byFinding.map((row) => row.id));

      const byPin = await orm
        .select({
          runId: reviewRunReviewerPin.runId,
          identity: reviewRunReviewerPin.identity,
          provider: reviewRunReviewerPin.provider,
          model: reviewRunReviewerPin.model,
          modelServiceVersion: reviewRunReviewerPin.modelServiceVersion,
          baseUrl: reviewRunReviewerPin.baseUrl,
          api: reviewRunReviewerPin.api,
          runtimeModelJson: reviewRunReviewerPin.runtimeModelJson,
          materializationFailure: reviewRunReviewerPin.materializationFailure,
          thinkingLevel: reviewRunReviewerPin.thinkingLevel,
        })
        .from(reviewRunReviewerPin)
        .where(inArray(reviewRunReviewerPin.runId, ids))
        .orderBy(asc(reviewRunReviewerPin.runId), asc(reviewRunReviewerPin.position));
      const findingCounts = new Map<string, number>();
      for (const row of byModel) findingCounts.set(`${row.runId}\n${row.model}`, row.findings);
      const models = new Map<number, RunListItem["models"]>();
      for (const row of byOutcome) {
        const list = models.get(row.runId) ?? [];
        const usage = recordedUsage(row);
        list.push({
          model: row.model,
          findings: findingCounts.get(`${row.runId}\n${row.model}`) ?? 0,
          failure: failureExcerpt(row.failure),
          ...(usage === undefined ? {} : { usage }),
        });
        models.set(row.runId, list);
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
        groups.set(row.runId, {
          resolved: Number(row.resolved),
          fixed: Number(row.fixed),
          total: row.total,
        });
      }
      const reviewerPins = new Map<number, ReviewRunReviewerPin[]>();
      for (const row of byPin) {
        const list = reviewerPins.get(row.runId) ?? [];
        list.push({
          identity: row.identity,
          provider: row.provider,
          model: row.model,
          thinkingLevel: (row.thinkingLevel ?? null) as ThinkingLevel | null,
          modelServiceVersion: row.modelServiceVersion,
          target:
            row.baseUrl === null || row.api === null
              ? null
              : { baseUrl: row.baseUrl, api: row.api },
          runtimeModel:
            row.runtimeModelJson === null
              ? null
              : (JSON.parse(row.runtimeModelJson) as NonNullable<
                  ReviewRunReviewerPin["runtimeModel"]
                >),
          failure: row.materializationFailure,
        });
        reviewerPins.set(row.runId, list);
      }
      const attributionModels = new Map<number, string[]>();
      const attributions = new Map<number, RecordedFindingAttribution[]>();
      for (const row of byAttribution) {
        const list = attributionModels.get(row.findingId) ?? [];
        // 同一模型的多条归属(ADR 0015 修订)只贡献一枚模型标识:这份列表回答的是
        // 「哪些模型报出它」,不是有几段归属。
        if (!list.includes(row.model)) list.push(row.model);
        attributionModels.set(row.findingId, list);
        const said = attributions.get(row.findingId) ?? [];
        said.push({
          model: row.model,
          severity: row.severity as Severity,
          category: row.category as Category,
          description: row.description,
          impact: row.impact,
          suggestion: row.suggestion,
        });
        attributions.set(row.findingId, said);
      }
      const findings = new Map<number, RunListItem["findings"]>();
      for (const row of byFinding) {
        const list = findings.get(row.runId) ?? [];
        const said = attributions.get(row.id) ?? [];
        // 代表段(issue #278):升级前落的行两列为 NULL,按同一规则从归属现算。
        const representative = representativeSegment(
          { title: row.title, description: row.description, impact: row.impact, suggestion: row.suggestion },
          said,
        );
        list.push({
          id: row.id,
          models: attributionModels.get(row.id) ?? [],
          attributions: said,
          carried: carried.get(row.id) ?? [],
          file: row.file,
          line: row.line,
          severity: row.severity as Severity,
          category: row.category as Category,
          description: representative.description,
          impact: representative.impact,
          suggestion: representative.suggestion,
          disposition: row.disposition as Disposition,
          placement: row.placement as FindingPlacement,
          commentId: row.commentId,
          commentHtmlUrl: row.commentHtmlUrl,
          disposedBy: row.disposedBy,
          disposedAt: row.disposedAt,
          note: row.dispositionNote,
          continuedFrom: row.continuedFrom,
          handoffPending: row.handoffPending === true,
        });
        findings.set(row.runId, list);
      }
      return runs.map((run) => {
        const usage = recordedUsage(run);
        return {
          id: run.id,
          owner: run.owner,
          repo: run.repo,
          pullNumber: run.pullNumber,
          headSha: run.headSha,
          title: run.title,
          triggeredBy: run.triggeredBy,
          triggerSource: readTriggerSource(run.triggerSource),
          rangeReviewId: run.rangeReviewId,
          directive: run.directive,
          // 升级前的旧行没有这一列:它们都是完整审查,读回来照实说。
          mode: run.mode === "verdict-only" ? "verdict-only" : "full",
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          failed: run.failed === true,
          failure: run.failure,
          models: models.get(run.id) ?? [],
          ...(usage === undefined ? {} : { usage }),
          reviewerPins: reviewerPins.get(run.id) ?? [],
          findings: findings.get(run.id) ?? [],
          resolved: groups.get(run.id)?.resolved ?? 0,
          fixed: groups.get(run.id)?.fixed ?? 0,
          total: groups.get(run.id)?.total ?? 0,
        };
      });
    },

    async getRunRange(id) {
      const [row] = await orm
        .select({
          id: reviewRun.id,
          owner: reviewRun.owner,
          repo: reviewRun.repo,
          pullNumber: reviewRun.pullNumber,
          headSha: reviewRun.headSha,
          rangeReviewId: reviewRun.rangeReviewId,
          baseSha: rangeReview.baseSha,
        })
        .from(reviewRun)
        .leftJoin(rangeReview, eq(reviewRun.rangeReviewId, rangeReview.id))
        .where(eq(reviewRun.id, id));
      return row;
    },

    async getFinding(id) {
      const [row] = await orm
        .select({
          id: finding.id,
          owner: reviewRun.owner,
          repo: reviewRun.repo,
          commentId: finding.commentId,
          disposition: finding.disposition,
          note: finding.dispositionNote,
          file: finding.file,
          line: finding.line,
          title: finding.title,
          description: finding.description,
          headSha: reviewRun.headSha,
        })
        .from(finding)
        .innerJoin(reviewRun, eq(finding.runId, reviewRun.id))
        .where(eq(finding.id, id));
      return row === undefined
        ? undefined
        : { ...row, disposition: row.disposition as Disposition };
    },

    async recordDisposition(input) {
      const updated = await orm
        .update(finding)
        .set({
          disposition: input.disposition,
          disposedBy: input.disposedBy,
          disposedAt: input.disposedAt,
          dispositionNote: sql`COALESCE(${input.note ?? null}, ${finding.dispositionNote})`,
        })
        .where(
          and(
            eq(finding.commentId, input.commentId),
            sql`${finding.runId} IN (SELECT ${reviewRun.id} FROM ${reviewRun}
                                      WHERE ${reviewRun.owner} = ${input.owner}
                                        AND ${reviewRun.repo} = ${input.repo})`,
          ),
        )
        .returning({ id: finding.id });
      return updated.length;
    },

    async pendingAutoDispositions(findingIds) {
      // 折叠键与读侧同源:`identityKey`——承载它的那条 Forge 评论,没有载体的退回
      // 「文件 + 指纹」。不按裸的「文件 + 指纹」扫:同一处可以有两条 Identity(ADR 0030),
      // 那样会把另一条的评论也 resolve 掉、另一条的行也记成已修复。PR 范围与
      // `pullRequestScope` 同一句话,只是从传入那一行所在的轮次上取,不另要参数。
      const seen = new Set<number>();
      const candidates: { findingId: number; commentId: string }[] = [];
      for (const findingId of findingIds) {
        const rows = (
          await orm.execute(
            sql`WITH seed AS (
                  SELECT ${identityKey(F)} AS key,
                         ${RUN.owner} AS owner, ${RUN.repo} AS repo,
                         ${RUN.pullNumber} AS pull_number
                    FROM ${finding} ${F} JOIN ${reviewRun} ${RUN} ON ${RUN.id} = ${F.runId}
                   WHERE ${F.id} = ${findingId}
                )
                SELECT ${finding.id} AS id, ${finding.commentId} AS comment_id
                  FROM ${finding}, seed
                 WHERE ${identityKey(finding)} = seed.key
                   AND ${finding.commentId} IS NOT NULL
                   AND ${AUTO_DISPOSABLE}
                   AND ${finding.runId} IN (SELECT ${reviewRun.id} FROM ${reviewRun}
                                             WHERE ${reviewRun.owner} = seed.owner
                                               AND ${reviewRun.repo} = seed.repo
                                               AND ${reviewRun.pullNumber} = seed.pull_number)
                 ORDER BY ${finding.id}`,
          )
        ).rows as Record<string, unknown>[];
        for (const row of rows) {
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
      await orm.execute(
        sql`UPDATE ${finding}
               SET ${columnName(finding.disposition)} = 'fixed',
                   ${columnName(finding.disposedAt)} = ${disposedAt},
                   ${columnName(finding.dispositionNote)} =
                     COALESCE(${note ?? null}, ${finding.dispositionNote})
             WHERE ${finding.id} = ${candidate.findingId}
               AND ${AUTO_DISPOSABLE}
               AND ${pullRequestScope(owner, repo, pullNumber)}`,
      );
    },

    async historyPlacements(findingIds) {
      const placements = [];
      for (const findingId of findingIds) {
        const [row] = await orm
          .select({
            file: finding.file,
            line: finding.line,
            title: finding.title,
            description: finding.description,
            fingerprint: finding.fingerprint,
            commentId: finding.commentId,
            commentHtmlUrl: finding.commentHtmlUrl,
            disposition: finding.disposition,
            runId: reviewRun.id,
            headSha: reviewRun.headSha,
          })
          .from(finding)
          .innerJoin(reviewRun, eq(reviewRun.id, finding.runId))
          .where(
            and(
              eq(finding.id, findingId),
              sql`${finding.fingerprint} IS NOT NULL`,
              sql`${finding.commentId} IS NOT NULL`,
              sql`${finding.commentHtmlUrl} IS NOT NULL`,
            ),
          );
        if (row === undefined) continue;
        // 这一行自己的归属(issue #267):两段都是空串的没有内容可带,不占一段;NULL 的
        // 照实带——升级前落的行两列是 NULL,`NULL = ''` 在 SQL 里不是假,要显式放行。
        const own = (
          await orm
            .select({
              model: findingAttribution.model,
              description: findingAttribution.description,
              impact: findingAttribution.impact,
              suggestion: findingAttribution.suggestion,
            })
            .from(findingAttribution)
            .where(
              and(
                eq(findingAttribution.findingId, findingId),
                sql`(${findingAttribution.impact} IS NULL OR ${findingAttribution.suggestion} IS NULL
                     OR ${findingAttribution.impact} <> '' OR ${findingAttribution.suggestion} <> '')`,
              ),
            )
            .orderBy(asc(findingAttribution.position))
        ).map((said) => ({ runId: row.runId, headSha: row.headSha, ...said }));
        const inherited = (await carriedFor([findingId])).get(findingId) ?? [];
        placements.push({
          findingId,
          file: row.file,
          line: row.line,
          title: row.title ?? "",
          description: row.description,
          fingerprint: row.fingerprint!,
          commentId: row.commentId!,
          commentHtmlUrl: row.commentHtmlUrl!,
          disposition: row.disposition as Disposition,
          carried: [...own, ...inherited],
        });
      }
      return placements;
    },

    async continuationCandidates(findingIds) {
      // 与 `historyPlacements` 同一批列同一道筛,只多一条:已经处置过的不再交接位置。
      return (await store().historyPlacements(findingIds))
        .filter(
          (placement) =>
            placement.disposition === "unknown" || placement.disposition === "unresolved",
        )
        .map(({ disposition: _disposition, ...candidate }) => candidate);
    },

    async recordContinuation({ owner, repo, pullNumber, runId, groupIndex, candidate, handoffPending }) {
      await transaction(async () => {
        // 先把旧行的三列抄到新行上,再改旧行的处置值:两条语句都只碰自己那一侧,
        // 顺序其实无关,写成这样是让「谁继承谁」一眼看得出来。
        await orm.execute(
          sql`UPDATE ${finding}
                 SET (${columnName(finding.disposedBy)}, ${columnName(finding.disposedAt)},
                      ${columnName(finding.dispositionNote)},
                      ${columnName(finding.continuedFrom)}) =
                       (SELECT ${PRIOR.disposedBy}, ${PRIOR.disposedAt}, ${PRIOR.dispositionNote},
                               ${candidate.commentHtmlUrl}
                          FROM ${finding} ${PRIOR} WHERE ${PRIOR.id} = ${candidate.findingId})
               WHERE ${finding.runId} = ${runId} AND ${finding.groupIndex} = ${groupIndex}`,
        );
        // 折叠键与读侧同源:`identityKey`——交接的是承载它的那条评论所指的那条 Finding,
        // 同一处的另一条 Identity 各有各的评论,不跟着这一次交接走(ADR 0030)。本轮新行
        // 的指纹必然与它不同——旧指纹在本轮 head 上算不出正是延续的前提,不会被这一笔一起
        // 改掉。交接未完成的标记与处置值同一笔写(ADR 0025):整条 Identity 一起带上。
        await orm.execute(
          sql`UPDATE ${finding}
                 SET ${columnName(finding.disposition)} = 'continued',
                     ${columnName(finding.handoffPending)} = ${handoffPending ? true : null}
               WHERE ${identityKey(finding)} =
                     (SELECT ${identityKey(PRIOR)} FROM ${finding} ${PRIOR}
                       WHERE ${PRIOR.id} = ${candidate.findingId})
                 AND ${finding.disposition} IN ('unknown', 'unresolved')
                 AND ${pullRequestScope(owner, repo, pullNumber)}`,
        );
      });
    },

    async pendingHandoffs(owner, repo, pullNumber) {
      // 同一条评论在 Identity 的几行上都带着标记,按评论去重、取最新那一行的 id。
      const rows = await orm
        .select({ id: finding.id, commentId: finding.commentId })
        .from(finding)
        .where(
          and(
            eq(finding.handoffPending, true),
            sql`${finding.commentId} IS NOT NULL`,
            pullRequestScope(owner, repo, pullNumber),
          ),
        )
        .orderBy(asc(finding.id));
      const byComment = new Map<string, number>();
      for (const row of rows) byComment.set(row.commentId!, row.id);
      return [...byComment].map(([commentId, findingId]) => ({ findingId, commentId }));
    },

    async completeHandoff(owner, repo, pullNumber, findingId) {
      await orm.execute(
        sql`UPDATE ${finding} SET ${columnName(finding.handoffPending)} = NULL
             WHERE ${identityKey(finding)} =
                   (SELECT ${identityKey(PRIOR)} FROM ${finding} ${PRIOR}
                     WHERE ${PRIOR.id} = ${findingId})
               AND ${finding.handoffPending} = true
               AND ${pullRequestScope(owner, repo, pullNumber)}`,
      );
    },

    async backfillDispositions(owner, repo, pullNumber, updates) {
      if (updates.length === 0) return;
      await transaction(async () => {
        for (const entry of updates) {
          const target = backfillTarget(entry.commentId ?? null, entry.file, entry.fingerprint);
          const scope = pullRequestScope(owner, repo, pullNumber);
          if (entry.disposition === undefined) {
            await orm.execute(
              sql`UPDATE ${finding} SET ${columnName(finding.placement)} = ${entry.placement}
                   WHERE ${target} AND ${scope}`,
            );
            continue;
          }
          // 「已修复」在 Forge 上就是一个 resolve,读回的 resolved 因此不能把它降级成人工
          // 那一档——处置率会凭空多出人工处置。读回 unresolved 是另一回事:人在 Forge 上
          // 撤回了处置,以 Forge 最新状态为准,照写。
          // 「已延续」两个方向都不覆盖:延续时旧评论被 resolve 过,读回的 resolved 是那次
          // 交接的痕迹,不是处置;人在 Forge 上把它 unresolve 也一样。
          const keepFixed =
            entry.disposition === "resolved"
              ? sql` AND ${finding.disposition} <> 'fixed'`
              : sql``;
          await orm.execute(
            sql`UPDATE ${finding} SET ${columnName(finding.disposition)} = ${entry.disposition},
                                      ${columnName(finding.placement)} = ${entry.placement}
                 WHERE ${target} AND ${finding.disposition} <> 'continued'${keepFixed}
                   AND ${scope}`,
          );
          // 「已延续」只放开这一格(ADR 0025):旧评论读回已 resolve,交接要等的就是这个
          // 结果,待办标记清掉;处置值仍不动。
          if (entry.disposition === "resolved") {
            await orm.execute(
              sql`UPDATE ${finding} SET ${columnName(finding.handoffPending)} = NULL
                   WHERE ${target} AND ${finding.disposition} = 'continued'
                     AND ${finding.handoffPending} = true AND ${scope}`,
            );
          }
        }
      });
    },

    async markPullRequestState(owner, repo, pullNumber, state) {
      await orm
        .update(reviewRun)
        .set({ prState: state })
        .where(
          and(
            eq(reviewRun.owner, owner),
            eq(reviewRun.repo, repo),
            eq(reviewRun.pullNumber, pullNumber),
          ),
        );
    },
  };
}
