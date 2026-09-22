/**
 * 知识域的持久化(spec #445 第二段):知识集(评审规则、项目事实与版本)、知识草案、基点
 * 探索、知识整理、修订提案与它的出处附注、修订意图,以及知识轨迹。
 *
 * 读写用 builder,行类型从 schema 推导,不再有手抄的列名字符串。写法见 `src/AGENTS.md`
 * 的「域文件的分工与写法」。
 *
 * 只被这一域用到的那几个闭包(条目、提案与版本推进的写入原语)也在这个文件里——它们本来
 * 长在 `openStore` 里,搬过来是为了让 `store/shared.ts` 只留跨域共用件。
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, max, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import type { ThinkingLevel } from "../../config.ts";
import type { KnowledgeType, RuleProposalChange } from "../finding.ts";
import type { RuleTraceKind } from "../trace.ts";
import {
  reviewRule,
  ruleConsolidation,
  ruleDraftItem,
  ruleExploration,
  ruleIntent,
  ruleProposal,
  ruleProposalSource,
  ruleSetVersion,
  ruleTrace,
} from "../schema/knowledge.ts";
import { repo } from "../schema/repos.ts";
import { finding, reviewRun } from "../schema/runs.ts";
import type {
  ReviewRuleInput,
  ReviewRuleRecord,
  RuleConsolidation,
  RuleExploration,
  RuleIntent,
  RuleIntentTargetKind,
  RuleProposal,
  RuleProposalInput,
  RuleProposalOrigin,
  RuleProposalSource,
  RuleProposalSourceInput,
  Store,
} from "./index.ts";
import type { StoreContext } from "./shared.ts";

/** 基点探索推导出的规则在 `origin` 上的出处(issue #205)。处置反哺另写自己的字面量。 */
const BASELINE_EXPLORATION_RULE_ORIGIN = "baseline-exploration";

/** 一条人工提议产出的草案条目在 `origin` 上的出处(issue #294)。与来源字面量同一个词。 */
const MANUAL_PROPOSAL_RULE_ORIGIN = "manual-proposal";

/**
 * 一条提案采纳前算得出来的全部东西:队列里那一条、实际要落的内容、以及修改与废止的
 * 目标条目此刻的出处。单条与批量共用它,判据因此只有一份;算不出来即这一条采纳不了。
 */
export type PlannedAcceptance = {
  queued: RuleProposal;
  content: ReviewRuleInput;
  targetOrigin: string | undefined;
};

/**
 * 一条 Finding 所在的审查阶段标识(issue #296)。`range:` 与 `pr:` 两个字面形状与评审记录
 * 那一侧(`stages.ts`)逐字相同;轮次是 LEFT JOIN 进来的那一档回 NULL。
 */
const stageIdFromRun = sql<string | null>`CASE
  WHEN ${reviewRun.id} IS NULL THEN NULL
  WHEN ${reviewRun.rangeReviewId} IS NOT NULL THEN 'range:' || ${reviewRun.rangeReviewId}
  ELSE 'pr:' || ${reviewRun.owner} || '/' || ${reviewRun.repo} || '/' || ${reviewRun.pullNumber}
END`;

/** 一行 `rule_intent` 读成一条修订意图。 */
function toRuleIntent(row: {
  id: number;
  text: string;
  submittedBy: string;
  targetKind: string;
  targetId: number | null;
  state: string;
  failure: string | null;
  summary: string | null;
  model: string | null;
  thinkingLevel: string | null;
  traceTaskId: number | null;
  producedJson: string | null;
  startedAt: string;
  finishedAt: string | null;
  targetStageId: string | null;
}): RuleIntent {
  return {
    id: row.id,
    text: row.text,
    submittedBy: row.submittedBy,
    targetKind: row.targetKind as RuleIntentTargetKind,
    targetId: row.targetId,
    targetStageId: row.targetStageId,
    state: row.state as RuleIntent["state"],
    failure: row.failure,
    summary: row.summary,
    model: row.model,
    thinkingLevel: row.thinkingLevel as ThinkingLevel | null,
    traceTaskId: row.traceTaskId,
    produced:
      row.producedJson === null
        ? { proposalIds: [], draftItemIds: [] }
        : (JSON.parse(row.producedJson) as RuleIntent["produced"]),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

type KnowledgeMethods = Pick<
  Store,
  | "getRuleSet"
  | "retireReviewRule"
  | "getRuleExploration"
  | "startRuleExploration"
  | "finishRuleExploration"
  | "finishRuleExplorationAsProposals"
  | "failRuleExploration"
  | "failInterruptedRuleExplorations"
  | "getRuleConsolidation"
  | "startRuleConsolidation"
  | "finishRuleConsolidation"
  | "failRuleConsolidation"
  | "failInterruptedRuleConsolidations"
  | "listRuleIntents"
  | "getRuleIntent"
  | "hasRunningRuleIntent"
  | "startRuleIntent"
  | "setRuleIntentTrace"
  | "finishRuleIntent"
  | "failRuleIntent"
  | "failInterruptedRuleIntents"
  | "deleteRuleIntent"
  | "rerunRuleIntent"
  | "mergeRuleProposals"
  | "retargetRuleProposal"
  | "getRuleDraft"
  | "appendRuleDraftItems"
  | "updateRuleDraftItem"
  | "deleteRuleDraftItem"
  | "confirmRuleDraft"
  | "getRuleProposals"
  | "addRuleProposal"
  | "mergeIntoRuleProposal"
  | "acceptRuleProposal"
  | "acceptRuleProposals"
  | "rejectRuleProposal"
  | "rejectRuleProposals"
  | "startRuleTrace"
  | "appendRuleTrace"
  | "listRuleTrace"
  | "ruleTraceRepo"
  | "setRuleExplorationTrace"
  | "setRuleConsolidationTrace"
>;

export function knowledgeMethods({ orm, transaction, store }: StoreContext): KnowledgeMethods {
  /**
   * 读一条修订意图要的那几格。三处查询共用,列名只写一遍。
   *
   * 目标 Finding 的阶段标识(issue #296)是一句相关子查询:面板手上只有 Finding 标识,
   * 拼不出阶段地址,而 `?finding=` 侧滑要的就是它。子查询由 builder 拼——手写 `sql` 里的
   * 列在没有 JOIN 的外层查询上渲染成不带表名的裸列,`finding.id` 与 `rule_intent.id` 会撞。
   */
  const ruleIntentColumns = {
    id: ruleIntent.id,
    text: ruleIntent.text,
    submittedBy: ruleIntent.submittedBy,
    targetKind: ruleIntent.targetKind,
    targetId: ruleIntent.targetId,
    state: ruleIntent.state,
    failure: ruleIntent.failure,
    summary: ruleIntent.summary,
    model: ruleIntent.model,
    thinkingLevel: ruleIntent.thinkingLevel,
    traceTaskId: ruleIntent.traceTaskId,
    producedJson: ruleIntent.producedJson,
    startedAt: ruleIntent.startedAt,
    finishedAt: ruleIntent.finishedAt,
    targetStageId: sql<string | null>`(${orm
      .select({ stageId: stageIdFromRun })
      .from(finding)
      .innerJoin(reviewRun, eq(reviewRun.id, finding.runId))
      .where(
        and(eq(ruleIntent.targetKind, "finding"), eq(finding.id, ruleIntent.targetId)),
      )})`,
  };

  const repoExists = async (repoId: number): Promise<boolean> =>
    (await orm.select({ id: repo.id }).from(repo).where(eq(repo.id, repoId))).length > 0;

  /**
   * 这条知识条目还生效吗:生效即回它的出处与两型之一(改一条要沿用出处、废止一条要
   * 说得出它是规则还是事实),否则回 undefined。
   */
  const activeRule = async (
    repoId: number,
    ruleId: number,
  ): Promise<{ origin: string; type: KnowledgeType } | undefined> => {
    const [row] = await orm
      .select({ origin: reviewRule.origin, type: reviewRule.type })
      .from(reviewRule)
      .where(
        and(
          eq(reviewRule.id, ruleId),
          eq(reviewRule.repoId, repoId),
          isNull(reviewRule.retiredVersion),
        ),
      );
    return row === undefined ? undefined : { origin: row.origin, type: row.type as KnowledgeType };
  };

  const insertReviewRule = async (
    repoId: number,
    input: ReviewRuleInput,
    origin: string,
    version: number,
    at: string,
  ): Promise<void> => {
    // layer 是退役的层标签,列还在(NOT NULL)但没人读:新行一律写空串。
    await orm.insert(reviewRule).values({
      repoId,
      type: input.type,
      scope: input.scope,
      statement: input.statement,
      layer: "",
      state: "active",
      origin,
      effectiveVersion: version,
      retiredVersion: null,
      createdAt: at,
    });
  };

  const retireRuleRow = async (ruleId: number, version: number): Promise<void> => {
    await orm
      .update(reviewRule)
      .set({ state: "retired", retiredVersion: version })
      .where(eq(reviewRule.id, ruleId));
  };

  /**
   * 这个仓库此刻有没有规则 agent 任务在跑(issue #284)。「同仓库同时只跑一个」跨基点
   * 探索与知识整理两张表:两者都要读这个仓库的知识集与队列,同时跑会互相看着对方的
   * 中间态。判据只有这一份,两个发起口共用。
   */
  const ruleTaskRunning = async (repoId: number): Promise<boolean> =>
    (
      await unionAll(
        orm
          .select({ one: sql<number>`1` })
          .from(ruleExploration)
          .where(and(eq(ruleExploration.repoId, repoId), eq(ruleExploration.state, "running"))),
        orm
          .select({ one: sql<number>`1` })
          .from(ruleConsolidation)
          .where(and(eq(ruleConsolidation.repoId, repoId), eq(ruleConsolidation.state, "running"))),
      )
    ).length > 0;

  const completeRuleExploration = async (repoId: number, at: string): Promise<void> => {
    await orm
      .update(ruleExploration)
      .set({ state: "completed", failure: null, finishedAt: at })
      .where(eq(ruleExploration.repoId, repoId));
  };

  /** 往一条提案上追加一条出处附注(issue #281)。入队与之后的每一次来源共用它。 */
  const insertRuleProposalSource = async (
    proposalId: number,
    source: RuleProposalSourceInput,
    at: string,
  ): Promise<void> => {
    await orm.insert(ruleProposalSource).values({
      proposalId,
      origin: source.origin,
      note: source.note,
      evidence: source.evidence,
      findingId: source.findingId,
      traceTaskId: source.traceTaskId,
      createdAt: at,
    });
  };

  const insertRuleProposal = async (
    repoId: number,
    input: RuleProposalInput,
    at: string,
  ): Promise<number> => {
    const [inserted] = await orm
      .insert(ruleProposal)
      .values({
        repoId,
        type: input.type,
        change: input.change,
        targetRuleIds: JSON.stringify(input.targetRuleIds),
        scope: input.scope,
        statement: input.statement,
        layer: "",
        state: "pending",
        createdAt: at,
        decidedAt: null,
      })
      .returning({ id: ruleProposal.id });
    const proposalId = inserted!.id;
    for (const source of input.sources) await insertRuleProposalSource(proposalId, source, at);
    return proposalId;
  };

  /** 这条提案还等着裁决吗:是即回它自己,否则回 undefined(裁决过的裁不了第二次)。 */
  const pendingProposal = async (
    repoId: number,
    proposalId: number,
  ): Promise<RuleProposal | undefined> =>
    (await store().getRuleProposals(repoId)).find(
      (row) => row.id === proposalId && row.state === "pending",
    );

  /**
   * 同一件事,但先把那一行锁住(ADR 0036):调用方要在同一笔事务里读、判、再写,不锁的话
   * 判完到写下之间那条提案可能已经被人裁决,改写就落在一条已经作数的提案上。只能在事务里调。
   */
  const lockPendingProposal = async (
    repoId: number,
    proposalId: number,
  ): Promise<RuleProposal | undefined> => {
    const [locked] = await orm
      .select({ id: ruleProposal.id })
      .from(ruleProposal)
      .where(and(eq(ruleProposal.id, proposalId), eq(ruleProposal.repoId, repoId)))
      .for("update");
    return locked === undefined ? undefined : await pendingProposal(repoId, proposalId);
  };

  const plannedAcceptance = async (
    repoId: number,
    proposalId: number,
  ): Promise<PlannedAcceptance | undefined> => {
    const queued = await pendingProposal(repoId, proposalId);
    if (queued === undefined) return undefined;
    const content = { type: queued.type, scope: queued.scope, statement: queued.statement };
    // 修改、废止与合并都要目标条目此刻仍然生效:其中一条已经被人废止掉时,这条提案
    // 落不下去(合并那一档同一条判据,只是要逐条都还生效,issue #282)。
    const targets: ({ origin: string; type: KnowledgeType } | undefined)[] = [];
    for (const id of queued.targetRuleIds) targets.push(await activeRule(repoId, id));
    if (queued.change !== "add" && targets.some((target) => target === undefined)) {
      return undefined;
    }
    const target = targets[0];
    // 修改不许翻型(评审复核):采纳一条 modify 把规则悄悄变成事实,那条从此不再产
    // Finding,面板上只是换了个徽章。要改型走「废止 + 新增」两条,意图才看得见。
    // 合并不设这道闸:几条目标本来就可能两型混杂,合成的那一条是哪一型由人裁决时看。
    if (queued.change === "modify" && target !== undefined && content.type !== target.type) {
      return undefined;
    }
    return { queued, content, targetOrigin: target?.origin };
  };

  /** 采纳一条提案在写事务里做的那几笔。版本号由调用方给:批量采纳全组共用同一个。 */
  const applyAcceptance = async (
    repoId: number,
    planned: PlannedAcceptance,
    version: number,
    at: string,
  ): Promise<void> => {
    const { queued, content, targetOrigin } = planned;
    if (queued.change === "add") {
      // 新条目的出处取第一条附注的来源(issue #281):那一次是提出它的那一次,之后追加
      // 的附注说的是「同一件事又被提了一遍」,不改变它当初从哪来。附注至少有一条。
      await insertReviewRule(repoId, content, queued.sources[0]!.origin, version, at);
    } else {
      for (const targetId of queued.targetRuleIds) await retireRuleRow(targetId, version);
      // 修改沿用旧行的出处:改文字不改变这条条目当初从哪来(issue #203 同一条口径)。
      if (queued.change === "modify") {
        await insertReviewRule(repoId, content, targetOrigin!, version, at);
      }
      // 合并的那一条是新写的一句,不是哪一条目标的延续:出处与新增同一条口径,取提案
      // 第一条附注的来源(issue #282)。几条目标的出处各不相同时也没有一份可沿用。
      if (queued.change === "merge") {
        await insertReviewRule(repoId, content, queued.sources[0]!.origin, version, at);
      }
    }
    await orm
      .update(ruleProposal)
      .set({
        state: "accepted",
        type: content.type,
        scope: content.scope,
        statement: content.statement,
        decidedAt: at,
      })
      .where(eq(ruleProposal.id, queued.id));
  };

  const rejectProposalRow = async (proposalId: number, at: string): Promise<void> => {
    await orm
      .update(ruleProposal)
      .set({ state: "rejected", decidedAt: at })
      .where(eq(ruleProposal.id, proposalId));
  };

  /**
   * 推进一版知识集版本,在同一个写事务里跑规则那几行改动。知识集版本与它带来的规则
   * 变更必须一起落:落了版本没落规则,那一版的快照就是错的。
   */
  const inRuleSetVersion = async <T>(
    repoId: number,
    write: (version: number, at: string) => Promise<T>,
  ): Promise<T> =>
    await transaction(async () => {
      // 先锁住这个仓库那一行(ADR 0036):版本号是 `MAX + 1`,不锁的话两次并发的确认会算出
      // 同一个号,主键当场撞上。
      await orm.select({ id: repo.id }).from(repo).where(eq(repo.id, repoId)).for("update");
      const [current] = await orm
        .select({ version: max(ruleSetVersion.version) })
        .from(ruleSetVersion)
        .where(eq(ruleSetVersion.repoId, repoId));
      const version = (current?.version ?? 0) + 1;
      const at = new Date().toISOString();
      await orm.insert(ruleSetVersion).values({ repoId, version, createdAt: at });
      return await write(version, at);
    });

  const readRuleIntent = async (where: SQL): Promise<RuleIntent | undefined> => {
    const [row] = await orm.select(ruleIntentColumns).from(ruleIntent).where(where);
    return row === undefined ? undefined : toRuleIntent(row);
  };

  return {
    async getRuleSet(repoId) {
      if (!(await repoExists(repoId))) return undefined;
      const [current] = await orm
        .select({ version: max(ruleSetVersion.version) })
        .from(ruleSetVersion)
        .where(eq(ruleSetVersion.repoId, repoId));
      const select = async (retired: boolean): Promise<ReviewRuleRecord[]> =>
        (
          await orm
            .select({
              id: reviewRule.id,
              type: reviewRule.type,
              scope: reviewRule.scope,
              statement: reviewRule.statement,
              origin: reviewRule.origin,
            })
            .from(reviewRule)
            .where(
              and(
                eq(reviewRule.repoId, repoId),
                retired
                  ? isNotNull(reviewRule.retiredVersion)
                  : isNull(reviewRule.retiredVersion),
              ),
            )
            .orderBy(asc(reviewRule.id))
        ).map((row) => ({ ...row, type: row.type as KnowledgeType }));
      return {
        version: current?.version ?? null,
        rules: await select(false),
        retired: await select(true),
      };
    },

    async retireReviewRule(repoId, ruleId) {
      if ((await activeRule(repoId, ruleId)) === undefined) return undefined;
      return await inRuleSetVersion(repoId, async (version) => {
        await retireRuleRow(ruleId, version);
        return version;
      });
    },

    async getRuleExploration(repoId) {
      const [row] = await orm
        .select()
        .from(ruleExploration)
        .where(eq(ruleExploration.repoId, repoId));
      if (row === undefined) return null;
      return {
        state: row.state as RuleExploration["state"],
        baselineSha: row.baselineSha,
        model: row.model,
        thinkingLevel: row.thinkingLevel as ThinkingLevel | null,
        traceTaskId: row.traceTaskId,
        failure: row.failure,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      };
    },

    async startRuleExploration(repoId, run) {
      if (!(await repoExists(repoId)) || (await ruleTaskRunning(repoId))) return false;
      await orm
        .insert(ruleExploration)
        .values({
          repoId,
          baselineSha: run.baselineSha,
          model: run.model,
          thinkingLevel: run.thinkingLevel ?? null,
          traceTaskId: null,
          state: "running",
          failure: null,
          startedAt: run.startedAt,
          finishedAt: null,
        })
        .onConflictDoUpdate({
          target: ruleExploration.repoId,
          set: {
            baselineSha: run.baselineSha,
            model: run.model,
            thinkingLevel: run.thinkingLevel ?? null,
            traceTaskId: null,
            state: "running",
            failure: null,
            startedAt: run.startedAt,
            finishedAt: null,
          },
        });
      return true;
    },

    async finishRuleExploration(repoId, items, at) {
      await transaction(async () => {
        // 整组覆盖:草案每仓库至多一份,重探索的产出取代未确认的旧草案(含人手加的条目)。
        await orm.delete(ruleDraftItem).where(eq(ruleDraftItem.repoId, repoId));
        if (items.length > 0) {
          await orm.insert(ruleDraftItem).values(
            items.map((item) => ({
              repoId,
              type: item.type,
              scope: item.scope,
              statement: item.statement,
              layer: "",
              origin: BASELINE_EXPLORATION_RULE_ORIGIN,
              createdAt: at,
            })),
          );
        }
        await completeRuleExploration(repoId, at);
      });
    },

    async finishRuleExplorationAsProposals(repoId, proposals, at) {
      await transaction(async () => {
        // 与草案同一条覆盖语义:一次基点探索是对照当前知识集的完整推导,新一次的未裁决
        // 产出取代上一次的,不是追加。只覆盖出处附注全部来自基点探索的待裁决行(issue
        // #281):已裁决的留作历史;带处置反哺或知识整理附注的那些里有人写下的意见,
        // 探索重跑推不出它们,一次重探索不该把它们抹掉。
        const replaced = (
          await orm
            .select({ id: ruleProposal.id })
            .from(ruleProposal)
            .where(
              and(
                eq(ruleProposal.repoId, repoId),
                eq(ruleProposal.state, "pending"),
                sql`NOT EXISTS (SELECT 1 FROM ${ruleProposalSource}
                                 WHERE ${ruleProposalSource.proposalId} = ${ruleProposal.id}
                                   AND ${ruleProposalSource.origin} <> 'baseline-exploration')`,
              ),
            )
        ).map((row) => row.id);
        if (replaced.length > 0) {
          await orm
            .delete(ruleProposalSource)
            .where(inArray(ruleProposalSource.proposalId, replaced));
          await orm.delete(ruleProposal).where(inArray(ruleProposal.id, replaced));
        }
        for (const item of proposals) await insertRuleProposal(repoId, item, at);
        await completeRuleExploration(repoId, at);
      });
    },

    async failRuleExploration(repoId, failure, at) {
      await orm
        .update(ruleExploration)
        .set({ state: "failed", failure, finishedAt: at })
        .where(eq(ruleExploration.repoId, repoId));
    },

    async failInterruptedRuleExplorations(failure, at) {
      await orm
        .update(ruleExploration)
        .set({ state: "failed", failure, finishedAt: at })
        .where(eq(ruleExploration.state, "running"));
    },

    async getRuleConsolidation(repoId) {
      const [row] = await orm
        .select()
        .from(ruleConsolidation)
        .where(eq(ruleConsolidation.repoId, repoId));
      if (row === undefined) return null;
      return {
        state: row.state as RuleConsolidation["state"],
        model: row.model,
        thinkingLevel: row.thinkingLevel as ThinkingLevel | null,
        traceTaskId: row.traceTaskId,
        failure: row.failure,
        merged: row.merged,
        retargeted: row.retargeted,
        proposed: row.proposed,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      };
    },

    async startRuleConsolidation(repoId, run) {
      if (!(await repoExists(repoId)) || (await ruleTaskRunning(repoId))) return false;
      const fresh = {
        model: run.model,
        thinkingLevel: run.thinkingLevel ?? null,
        traceTaskId: null,
        state: "running",
        failure: null,
        merged: null,
        retargeted: null,
        proposed: null,
        startedAt: run.startedAt,
        finishedAt: null,
      };
      await orm
        .insert(ruleConsolidation)
        .values({ repoId, ...fresh })
        .onConflictDoUpdate({ target: ruleConsolidation.repoId, set: fresh });
      return true;
    },

    async finishRuleConsolidation(repoId, summary, at) {
      await orm
        .update(ruleConsolidation)
        .set({
          state: "completed",
          failure: null,
          merged: summary.merged,
          retargeted: summary.retargeted,
          proposed: summary.proposed,
          finishedAt: at,
        })
        .where(eq(ruleConsolidation.repoId, repoId));
    },

    async failRuleConsolidation(repoId, failure, at) {
      await orm
        .update(ruleConsolidation)
        .set({ state: "failed", failure, finishedAt: at })
        .where(eq(ruleConsolidation.repoId, repoId));
    },

    async failInterruptedRuleConsolidations(failure, at) {
      await orm
        .update(ruleConsolidation)
        .set({ state: "failed", failure, finishedAt: at })
        .where(eq(ruleConsolidation.state, "running"));
    },

    async listRuleIntents(repoId) {
      // 运行中与失败排在前面(布尔升序 false < true),其余按开始时刻倒序。
      const rows = await orm
        .select(ruleIntentColumns)
        .from(ruleIntent)
        .where(eq(ruleIntent.repoId, repoId))
        .orderBy(
          asc(sql`${ruleIntent.state} = 'completed'`),
          desc(ruleIntent.startedAt),
          desc(ruleIntent.id),
        );
      return rows.map(toRuleIntent);
    },

    async getRuleIntent(repoId, intentId) {
      const intent = await readRuleIntent(
        and(eq(ruleIntent.id, intentId), eq(ruleIntent.repoId, repoId))!,
      );
      return intent ?? null;
    },

    async hasRunningRuleIntent(repoId, targetKind, targetId) {
      const rows = await orm
        .select({ id: ruleIntent.id })
        .from(ruleIntent)
        .where(
          and(
            eq(ruleIntent.repoId, repoId),
            eq(ruleIntent.state, "running"),
            eq(ruleIntent.targetKind, targetKind),
            eq(ruleIntent.targetId, targetId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async startRuleIntent(repoId, intent) {
      if (!(await repoExists(repoId))) return undefined;
      const [inserted] = await orm
        .insert(ruleIntent)
        .values({
          repoId,
          text: intent.text,
          submittedBy: intent.submittedBy,
          targetKind: intent.targetKind,
          targetId: intent.targetId,
          state: "running",
          failure: null,
          summary: null,
          model: intent.model,
          thinkingLevel: intent.thinkingLevel ?? null,
          traceTaskId: null,
          producedJson: null,
          startedAt: intent.startedAt,
          finishedAt: null,
        })
        .returning({ id: ruleIntent.id });
      return await readRuleIntent(eq(ruleIntent.id, inserted!.id));
    },

    async setRuleIntentTrace(intentId, taskId) {
      await orm
        .update(ruleIntent)
        .set({ traceTaskId: taskId })
        .where(eq(ruleIntent.id, intentId));
    },

    async finishRuleIntent(intentId, outcome, at) {
      await orm
        .update(ruleIntent)
        .set({
          state: "completed",
          failure: null,
          summary: outcome.summary,
          producedJson: JSON.stringify(outcome.produced),
          finishedAt: at,
        })
        .where(eq(ruleIntent.id, intentId));
    },

    async failRuleIntent(intentId, failure, at) {
      await orm
        .update(ruleIntent)
        .set({ state: "failed", failure, finishedAt: at })
        .where(eq(ruleIntent.id, intentId));
    },

    async failInterruptedRuleIntents(failure, at) {
      await orm
        .update(ruleIntent)
        .set({ state: "failed", failure, finishedAt: at })
        .where(eq(ruleIntent.state, "running"));
    },

    async deleteRuleIntent(repoId, intentId) {
      const intent = await store().getRuleIntent(repoId, intentId);
      if (intent === null) return "missing";
      if (intent.state === "running") return "running";
      await orm.delete(ruleIntent).where(eq(ruleIntent.id, intentId));
      return "deleted";
    },

    async rerunRuleIntent(repoId, intentId, run) {
      const updated = await orm
        .update(ruleIntent)
        .set({
          state: "running",
          failure: null,
          summary: null,
          producedJson: null,
          traceTaskId: null,
          finishedAt: null,
          model: run.model,
          thinkingLevel: run.thinkingLevel ?? null,
          startedAt: run.startedAt,
        })
        .where(
          and(
            eq(ruleIntent.id, intentId),
            eq(ruleIntent.repoId, repoId),
            eq(ruleIntent.state, "failed"),
          ),
        )
        .returning({ id: ruleIntent.id });
      if (updated.length === 0) return undefined;
      return await readRuleIntent(eq(ruleIntent.id, intentId));
    },

    async mergeRuleProposals(repoId, proposalIds, statement) {
      const unique = [...new Set(proposalIds)];
      const merged = statement.trim();
      if (unique.length < 2 || merged === "") return false;
      const pending = (await store().getRuleProposals(repoId)).filter(
        (row) => row.state === "pending",
      );
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
      await transaction(async () => {
        // 附注并入保留行:一条提案的出处是它被哪几件事提过,合并不该把其中几件丢掉。
        await orm
          .update(ruleProposalSource)
          .set({ proposalId: keep })
          .where(inArray(ruleProposalSource.proposalId, dropped));
        await orm.delete(ruleProposal).where(inArray(ruleProposal.id, dropped));
        await orm
          .update(ruleProposal)
          .set({ statement: merged })
          .where(eq(ruleProposal.id, keep));
      });
      return true;
    },

    async retargetRuleProposal(repoId, proposalId, targetRuleId) {
      const queued = await pendingProposal(repoId, proposalId);
      if (queued === undefined || queued.change !== "add") return false;
      const target = await activeRule(repoId, targetRuleId);
      if (target === undefined || target.type !== queued.type) return false;
      await orm
        .update(ruleProposal)
        .set({ change: "modify", targetRuleIds: JSON.stringify([targetRuleId]) })
        .where(eq(ruleProposal.id, proposalId));
      return true;
    },

    async getRuleDraft(repoId) {
      return (
        await orm
          .select({
            id: ruleDraftItem.id,
            type: ruleDraftItem.type,
            scope: ruleDraftItem.scope,
            statement: ruleDraftItem.statement,
            origin: ruleDraftItem.origin,
          })
          .from(ruleDraftItem)
          .where(eq(ruleDraftItem.repoId, repoId))
          .orderBy(asc(ruleDraftItem.id))
      ).map((row) => ({ ...row, type: row.type as KnowledgeType }));
    },

    async appendRuleDraftItems(repoId, items, at) {
      if (!(await repoExists(repoId))) return [];
      const ids: number[] = [];
      // 逐条插:返回的标识要与 `items` 同序,而多行 INSERT 的 RETURNING 顺序没有保证。
      for (const item of items) {
        const [inserted] = await orm
          .insert(ruleDraftItem)
          .values({
            repoId,
            type: item.type,
            scope: item.scope,
            statement: item.statement,
            layer: "",
            origin: MANUAL_PROPOSAL_RULE_ORIGIN,
            createdAt: at,
          })
          .returning({ id: ruleDraftItem.id });
        ids.push(inserted!.id);
      }
      return ids;
    },

    async updateRuleDraftItem(repoId, itemId, input) {
      // 出处沿用旧值,不碰 origin 这一列。
      const changed = await orm
        .update(ruleDraftItem)
        .set({ type: input.type, scope: input.scope, statement: input.statement })
        .where(and(eq(ruleDraftItem.id, itemId), eq(ruleDraftItem.repoId, repoId)))
        .returning({ id: ruleDraftItem.id });
      return changed.length > 0;
    },

    async deleteRuleDraftItem(repoId, itemId) {
      const deleted = await orm
        .delete(ruleDraftItem)
        .where(and(eq(ruleDraftItem.id, itemId), eq(ruleDraftItem.repoId, repoId)))
        .returning({ id: ruleDraftItem.id });
      return deleted.length > 0;
    },

    async confirmRuleDraft(repoId, itemIds) {
      if (!(await repoExists(repoId))) return undefined;
      const draft = await store().getRuleDraft(repoId);
      // 勾选里有一条不在草案里就整次不做:一份过期的勾选不该悄悄确认成另一组条目。
      const selected =
        itemIds === undefined ? draft : itemIds.map((id) => draft.find((item) => item.id === id));
      if (selected.some((item) => item === undefined)) return undefined;
      // 空知识集是合法状态(issue #200):还没确认过的仓库确认空草案就是在说「这个仓库
      // 没有知识条目」,照样生成一个版本,门禁随之放行。已确认的仓库拿空的一组再确认只会
      // 白推一版,那时回 undefined。
      if (selected.length === 0 && (await store().getRuleSet(repoId))?.version !== null) {
        return undefined;
      }
      return await inRuleSetVersion(repoId, async (version, at) => {
        for (const item of selected) {
          await insertReviewRule(repoId, item!, item!.origin, version, at);
        }
        // 没勾选的随草案一并丢弃:草案是一次性的那一份,确认完就不剩什么了。
        await orm.delete(ruleDraftItem).where(eq(ruleDraftItem.repoId, repoId));
        return version;
      });
    },

    async getRuleProposals(repoId) {
      // 附注一次查完再按提案分组:队列一屏几十条,逐条再查一次附注就是几十次往返。
      // Finding 的阶段标识在这一句里算出来(与评审记录同一个字面形状),面板据此开侧滑。
      const sources = new Map<number, RuleProposalSource[]>();
      const sourceRows = await orm
        .select({
          id: ruleProposalSource.id,
          proposalId: ruleProposalSource.proposalId,
          origin: ruleProposalSource.origin,
          note: ruleProposalSource.note,
          evidence: ruleProposalSource.evidence,
          findingId: ruleProposalSource.findingId,
          traceTaskId: ruleProposalSource.traceTaskId,
          createdAt: ruleProposalSource.createdAt,
          findingStageId: stageIdFromRun,
        })
        .from(ruleProposalSource)
        .innerJoin(ruleProposal, eq(ruleProposal.id, ruleProposalSource.proposalId))
        .leftJoin(finding, eq(finding.id, ruleProposalSource.findingId))
        .leftJoin(reviewRun, eq(reviewRun.id, finding.runId))
        .where(eq(ruleProposal.repoId, repoId))
        .orderBy(asc(ruleProposalSource.id));
      for (const row of sourceRows) {
        const list = sources.get(row.proposalId) ?? [];
        list.push({
          id: row.id,
          origin: row.origin as RuleProposalOrigin,
          note: row.note,
          evidence: row.evidence,
          findingId: row.findingId,
          findingStageId: row.findingStageId,
          traceTaskId: row.traceTaskId,
          createdAt: row.createdAt,
        });
        sources.set(row.proposalId, list);
      }
      return (
        await orm
          .select({
            id: ruleProposal.id,
            type: ruleProposal.type,
            change: ruleProposal.change,
            targetRuleIds: ruleProposal.targetRuleIds,
            scope: ruleProposal.scope,
            statement: ruleProposal.statement,
            state: ruleProposal.state,
            createdAt: ruleProposal.createdAt,
            decidedAt: ruleProposal.decidedAt,
          })
          .from(ruleProposal)
          .where(eq(ruleProposal.repoId, repoId))
          .orderBy(asc(ruleProposal.id))
      ).map((row) => ({
        id: row.id,
        type: row.type as KnowledgeType,
        change: row.change as RuleProposalChange,
        targetRuleIds: JSON.parse(row.targetRuleIds) as number[],
        scope: row.scope,
        statement: row.statement,
        sources: sources.get(row.id) ?? [],
        state: row.state as RuleProposal["state"],
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
      }));
    },

    async addRuleProposal(repoId, input) {
      if (!(await repoExists(repoId))) return undefined;
      return await insertRuleProposal(repoId, input, new Date().toISOString());
    },

    async mergeIntoRuleProposal(repoId, proposalId, merge) {
      const at = new Date().toISOString();
      return await transaction(async () => {
        // 已裁决的、不在这个仓库的、根本不存在的都并不进去:那一条退回按新增处理。判据
        // 在同一笔事务里锁着那一行读——不锁的话判完到写下之间它可能刚被人裁决,并入就
        // 落在一条已经作数的提案上,人再也没有机会看这次改写。
        const queued = await lockPendingProposal(repoId, proposalId);
        if (queued === undefined) return false;
        // 型规则(CONTEXT.md 修订提案,issue #295):修改型要换型即改成指向同一条目标的
        // 单目标合并——修改那一档不许翻型,而改型正是这一次改写的意图。新增型与合并型的
        // 变更类型不动,型直接换。
        const change =
          merge.type !== undefined && merge.type !== queued.type && queued.change === "modify"
            ? "merge"
            : queued.change;
        // 陈述与附注必须一起落:换了陈述没留下附注,队列里那一条就说不出它是被哪两次
        // 备注合起来的。
        await orm
          .update(ruleProposal)
          .set({
            statement: merge.statement,
            scope: merge.scope ?? queued.scope,
            type: merge.type ?? queued.type,
            change,
          })
          .where(eq(ruleProposal.id, proposalId));
        await insertRuleProposalSource(proposalId, merge.source, at);
        return true;
      });
    },

    async acceptRuleProposal(repoId, proposalId) {
      const planned = await plannedAcceptance(repoId, proposalId);
      if (planned === undefined) return undefined;
      return await inRuleSetVersion(repoId, async (version, at) => {
        await applyAcceptance(repoId, planned, version, at);
        return version;
      });
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
      return await inRuleSetVersion(repoId, async (version, at) => {
        // 全组共用同一个版本号(issue #223):逐条各推一版会让一次裁决在版本轴上散成上百格。
        for (const entry of planned) await applyAcceptance(repoId, entry!, version, at);
        return version;
      });
    },

    async rejectRuleProposal(repoId, proposalId) {
      if ((await pendingProposal(repoId, proposalId)) === undefined) return false;
      await rejectProposalRow(proposalId, new Date().toISOString());
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
      await transaction(async () => {
        for (const id of proposalIds) await rejectProposalRow(id, at);
      });
      return true;
    },

    async startRuleTrace(repoId, source, payload) {
      // 任务标识由 identity 列发号(ADR 0036):不给它,PostgreSQL 自己取下一个。自己在
      // INSERT 里算 `MAX(task_id) + 1` 的话,并发起头的两条会拿到同一个号。
      const [inserted] = await orm
        .insert(ruleTrace)
        .values({
          repoId,
          source,
          seq: 1,
          at: new Date().toISOString(),
          kind: "rule_agent_started",
          payload: JSON.stringify(payload ?? null),
        })
        .returning({ taskId: ruleTrace.taskId });
      return inserted!.taskId;
    },

    async appendRuleTrace(taskId, event) {
      const at = new Date().toISOString();
      const payload = JSON.stringify(event.payload ?? null);
      // repo_id 与 source 从这条轨迹的头一行抄:它们描述的是整条轨迹,逐行重复只是
      // 为了让可见性与级联删除各只读一张表。那一行同时是这条轨迹的父行,事务里先锁住
      // 它再取 `MAX(seq) + 1`(ADR 0036):不锁的话并发的两条会拿到同一个号。
      const seq = await transaction(async () => {
        const [head] = await orm
          .select({ repoId: ruleTrace.repoId, source: ruleTrace.source })
          .from(ruleTrace)
          .where(eq(ruleTrace.taskId, taskId))
          .orderBy(asc(ruleTrace.seq))
          .limit(1)
          .for("update");
        // 这条轨迹根本没起来时一行都不写,与旧的 INSERT ... SELECT 读到空集同样。
        if (head === undefined) return Number.NaN;
        const [current] = await orm
          .select({ seq: max(ruleTrace.seq) })
          .from(ruleTrace)
          .where(eq(ruleTrace.taskId, taskId));
        const next = (current?.seq ?? 0) + 1;
        await orm.insert(ruleTrace).values({
          taskId,
          repoId: head.repoId,
          source: head.source,
          seq: next,
          at,
          kind: event.kind,
          payload,
        });
        return next;
      });
      return { seq, taskId, at, kind: event.kind, payload: event.payload };
    },

    async listRuleTrace(taskId, afterSeq) {
      return (
        await orm
          .select({
            seq: ruleTrace.seq,
            at: ruleTrace.at,
            kind: ruleTrace.kind,
            payload: ruleTrace.payload,
          })
          .from(ruleTrace)
          .where(and(eq(ruleTrace.taskId, taskId), sql`${ruleTrace.seq} > ${afterSeq ?? 0}`))
          .orderBy(asc(ruleTrace.seq))
      ).map((row) => ({
        seq: row.seq,
        taskId,
        at: row.at,
        kind: row.kind as RuleTraceKind,
        payload: JSON.parse(row.payload) as unknown,
      }));
    },

    async ruleTraceRepo(taskId) {
      const [row] = await orm
        .select({ repoId: ruleTrace.repoId })
        .from(ruleTrace)
        .where(eq(ruleTrace.taskId, taskId))
        .limit(1);
      return row?.repoId;
    },

    async setRuleExplorationTrace(repoId, taskId) {
      await orm
        .update(ruleExploration)
        .set({ traceTaskId: taskId })
        .where(eq(ruleExploration.repoId, repoId));
    },

    async setRuleConsolidationTrace(repoId, taskId) {
      await orm
        .update(ruleConsolidation)
        .set({ traceTaskId: taskId })
        .where(eq(ruleConsolidation.repoId, repoId));
    },
  };
}
