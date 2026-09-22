/**
 * 仓库域的持久化(spec #445 第二段,issue #451):仓库注册表与它的 Key、仓库配置、审查策略,
 * 以及模型服务、凭据、目录快照、模型补录与模型状态。
 *
 * 读写用 builder,builder 写不出来的(相关子查询、jsonb 函数)用 `sql` 模板并引 schema
 * 的列对象。写法见 `src/AGENTS.md` 的「域文件的分工与写法」。
 */
import { and, asc, count, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  assertReviewerSpecs,
  GLOBAL_REVIEWERS_CONTEXT,
  modelIdentity,
  type ReviewerSpec,
} from "../../config.ts";
import {
  type DiscoveredModel,
  type TrustedModelFields,
  type TrustedModelFieldSource,
  type TrustedModelFieldSources,
} from "../../reviewer/model-service-runtime.ts";
import type { ProjectFact, ReviewRule } from "../finding.ts";
import { panelUserRepo } from "../schema/accounts.ts";
import {
  ruleConsolidation,
  ruleDraftItem,
  ruleExploration,
  ruleProposal,
  ruleProposalSource,
  ruleSetVersion,
  ruleTrace,
  reviewRule,
} from "../schema/knowledge.ts";
import { productRepo } from "../schema/products.ts";
import {
  globalSetting,
  modelDirectory,
  modelDirectoryModel,
  modelService,
  modelServiceCredential,
  modelServiceModelState,
  modelSupplement,
  repo as repoTable,
  repoKey,
  webhookDelivery,
} from "../schema/repos.ts";
import { finding, reviewRun } from "../schema/runs.ts";
import type {
  ModelCredentialState,
  ModelDirectoryState,
  ModelReference,
  ModelServiceRecord,
  ModelServiceVersionCommit,
  ModelSupplementSource,
  ModelVerificationSource,
  RepoRecord,
  ReviewRuleRecord,
  Store,
} from "./index.ts";
import {
  boundTargetForModel,
  modelServiceTargetSetFingerprint,
  normalizeModelServiceTargets,
  readMinReportSeverity,
  type ModelServiceBoundTarget,
  type StoreContext,
} from "./shared.ts";

/** `global_setting` 里各项设置值的键。 */
const GLOBAL_REVIEWERS_KEY = "reviewers";

/**
 * 最低报告等级(CONTEXT.md,issue #271)的设置键。与四项上限同形,只是取值是严重度枚举
 * 而不是正整数;缺行即默认 P2(全报)。
 */
const GLOBAL_MIN_REPORT_SEVERITY_KEY = "min_report_severity";

/**
 * 辅助模型(CONTEXT.md 辅助模型,issue #303)的设置键。存的是一处模型引用的 JSON,缺行
 * 即没设——那时解析退回这个仓库生效模型组合的第一个。
 */
const GLOBAL_AUXILIARY_MODEL_KEY = "auxiliary_model";

/**
 * 审查策略整页共用的版本键(issue #301)。整页一次全量替换,版本因此只有一个;缺行读作
 * 1,写成功推一版。
 */
const GLOBAL_SETTINGS_VERSION_KEY = "settings_version";

/**
 * 分批上限、批次并发数(issue #230)与每批每模型取证上限(issue #258)各自的设置键。四项
 * 同形,读写只写一份;版本与整页共用一个(issue #301)。
 */
const BATCH_LIMIT_KEYS = {
  maxChangedLinesPerBatch: "max_changed_lines_per_batch",
  maxParallelBatches: "max_parallel_batches",
  maxFilesPerBatch: "max_files_per_batch",
  maxEvidenceCallsPerBatch: "max_evidence_calls_per_batch",
} as const;

/** 审查策略里按正整数各自保存的哪一项。 */
export type BatchLimitField = keyof typeof BATCH_LIMIT_KEYS;

export const CUSTOM_PROVIDER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * 一份模型组合的 JSON 是不是空的:没配过(null)或者配过一份空的。**「模型组合首次配置后
 * 非空」那条(spec #300)由它表达**——库里现存的那一份是空的时,这一次照收空组合;配过
 * 非空之后不再收空。`PUT /settings` 与 `replaceGlobalSettings` 认这同一条判据。读不动的
 * 一行当作非空:一行坏数据不该反过来把空组合放行。
 */
export function storedReviewersEmpty(reviewersJson: string | null): boolean {
  if (reviewersJson === null) return true;
  try {
    const parsed: unknown = JSON.parse(reviewersJson);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/** 升级前的 NULL 与任何认不出来的值都按 unknown 读:副本在不在都要人能重新准备。 */
function worktreeState(value: string | null): "unknown" | "preparing" | "ready" | "failed" {
  return value === "preparing" || value === "ready" || value === "failed" ? value : "unknown";
}

const TRUSTED_MODEL_FIELD_KEYS = [
  "name",
  "api",
  "baseUrl",
  "input",
  "reasoning",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
  "compat",
] as const satisfies readonly (keyof TrustedModelFields)[];
const TRUSTED_MODEL_FIELD_SOURCES = new Set<TrustedModelFieldSource>([
  "service-interface",
  "pi-catalog",
  "service-target",
]);

function normalizedTrustedFieldSources(
  fields: TrustedModelFields,
  sources: TrustedModelFieldSources | undefined,
): TrustedModelFieldSources | undefined {
  if (sources === undefined) return undefined;
  const normalized: TrustedModelFieldSources = {};
  for (const key of TRUSTED_MODEL_FIELD_KEYS) {
    const source = sources[key];
    if (
      source !== undefined &&
      TRUSTED_MODEL_FIELD_SOURCES.has(source) &&
      fields[key] !== undefined
    ) normalized[key] = source;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

/**
 * 知识集里的一条 → 交给模型的那一份(issue #204)。只要标识、作用范围与那一句陈述。
 * 启动快照、基点探索与处置反哺三处同一份投影。
 */
export function toReviewRule(rule: ReviewRuleRecord): ReviewRule {
  return { id: rule.id, scope: rule.scope, statement: rule.statement };
}

/**
 * 事实型条目 → 交给模型的那一份(issue #221)。形状与规则的那一份同构:标识虽然不进
 * prompt(事实不作 ruleId 的合法取值),但子进程要凭它认出模型自报的标识指向的是一条
 * 事实,并把这次调用打回。
 */
export function toProjectFact(entry: ReviewRuleRecord): ProjectFact {
  return { id: entry.id, scope: entry.scope, statement: entry.statement };
}

type ReposMethods = Pick<
  Store,
  | "registerRepo"
  | "addRepoKey"
  | "removeRepoKey"
  | "listRepoKeys"
  | "getRepo"
  | "putRepoSettings"
  | "resolveAuxiliaryModel"
  | "removeRepo"
  | "setRepoWorktree"
  | "failInterruptedWorktrees"
  | "listRepos"
  | "findRepoId"
  | "getGlobalSettings"
  | "replaceGlobalSettings"
  | "getReviewRunSnapshot"
  | "commitModelServiceVersion"
  | "renameConflictingCustomModelService"
  | "removeCustomModelService"
  | "getModelService"
  | "listModelServices"
  | "listModelReferences"
  | "listModelServiceModelStates"
  | "updateModelServiceModelStates"
  | "listModelSupplements"
  | "claimDelivery"
>;

export function reposMethods(ctx: StoreContext): ReposMethods {
  const { orm, transaction, store, parseStoredReviewers, parseAuxiliaryModel } = ctx;

  /**
   * 一个模型此刻跑不跑得动:这一家服务有经验证的凭据与已绑的调用目标,这个模型没被停用,
   * 而且它要么在当前版本的目录里、要么是一条补录,并且解析得到集合里的一个目标(ADR 0027)。
   * `boundTargetForModel` 是同一条规则的 JS 写法,改一处要同时改另一处。
   */
  const availableModel = async (provider: string, model: string): Promise<boolean> => {
    const rows = await orm
      .select({ ok: sql<number>`1` })
      .from(modelService)
      .innerJoin(modelServiceCredential, eq(modelServiceCredential.provider, modelService.provider))
      .where(sql`${modelService.provider} = ${provider}
        AND ${modelService.targetFingerprint} IS NOT NULL
        AND ${modelServiceCredential.state} = 'verified'
        AND ${modelServiceCredential.apiKeyEncrypted} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${modelServiceModelState} state
           WHERE state.provider = ${modelService.provider}
             AND state.model = ${model}
             AND state.enabled = false
        )
        AND (
          EXISTS (
            SELECT 1 FROM ${modelDirectoryModel} automatic
             WHERE automatic.provider = ${modelService.provider}
               AND automatic.model = ${model}
               AND automatic.service_version = ${modelService.version}
               -- 绑了目标集合的内置版本(ADR 0027):目录行按自己的 api/baseUrl 对集合,
               -- 对不上的行(刷新拉进来、还没经验证的目标)不算可用。
               AND (
                 ${modelService.targetsJson} IS NULL
                 OR (automatic.api IS NOT NULL AND automatic.base_url IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM jsonb_array_elements(${modelService.targetsJson}) bound
                        WHERE bound.value->>'api' = automatic.api
                          AND bound.value->>'baseUrl' = rtrim(automatic.base_url, '/')
                     ))
                 OR ((automatic.api IS NULL OR automatic.base_url IS NULL)
                     AND jsonb_array_length(${modelService.targetsJson}) = 1)
               )
          )
          OR EXISTS (
            SELECT 1 FROM ${modelSupplement} supplement
             WHERE supplement.provider = ${modelService.provider}
               AND supplement.model = ${model}
               AND (
                 (supplement.source = 'migration-retention'
                   AND (${modelService.targetsJson} IS NULL
                        OR jsonb_array_length(${modelService.targetsJson}) = 1))
                 OR (supplement.source = 'manual'
                     AND (
                       (${modelService.targetsJson} IS NULL
                         AND supplement.target_fingerprint = ${modelService.targetFingerprint})
                       OR EXISTS (
                         SELECT 1 FROM jsonb_array_elements(${modelService.targetsJson}) bound
                          WHERE bound.value->>'fingerprint' = supplement.target_fingerprint
                       )
                     ))
               )
          )
        )`)
      .limit(1);
    return rows.length > 0;
  };

  const specAvailable = async (spec: ReviewerSpec): Promise<boolean> =>
    await availableModel(spec.provider, spec.model);

  const modelCombinationAvailable = async (
    reviewersJson: string,
    context: string,
  ): Promise<boolean> => {
    const reviewers = parseStoredReviewers(reviewersJson, context);
    if (reviewers.length === 0) return false;
    // 逐条 await:`every` 收不了异步判定——回来的 Promise 恒为真值,整组因此一律算可用。
    for (const spec of reviewers) {
      if (!(await specAvailable(spec))) return false;
    }
    return true;
  };

  /** 一处辅助模型引用当前跑不跑得动(issue #303)。判据与组合里的一项逐字相同。 */
  const auxiliaryModelAvailable = async (auxiliaryModelJson: string): Promise<boolean> => {
    const spec = parseAuxiliaryModel(auxiliaryModelJson);
    return spec !== null && (await specAvailable(spec));
  };

  /**
   * 这一家服务此刻被引用着的模型。判据与 `listModelReferences` 是同一份收集逻辑——事务内
   * 的兜底另写一遍就会漏掉位置(issue #303 的辅助模型两处当初就是这么漏的)。
   */
  const referencedModels = async (provider: string): Promise<Set<string>> =>
    new Set(
      (await store().listModelReferences())
        .filter((reference) => reference.provider === provider)
        .map((reference) => reference.model),
    );

  const recordSupportsCurrentReferences = async (
    record: ModelServiceVersionCommit,
  ): Promise<boolean> => {
    const references = new Set<string>();
    for (const model of await referencedModels(record.provider)) {
      if (await availableModel(record.provider, model)) references.add(model);
    }
    if (references.size === 0) return true;
    if (
      record.targetFingerprint === null ||
      record.credential.state !== "verified" ||
      record.credential.apiKeyEncrypted === null
    ) return false;
    const models = new Set<string>();
    if (record.targets != null) {
      // 绑了目标集合的版本按 `boundTargetForModel` 判,与 `availableModel` 同一条规则。
      const targets = normalizeModelServiceTargets(record.targets);
      const supplementByModel = new Map(record.supplements.map((entry) => [entry.model, entry]));
      for (const model of record.automaticModels) {
        if (boundTargetForModel(targets, model, supplementByModel.get(model.id)) !== undefined) {
          models.add(model.id);
        }
      }
      for (const supplement of record.supplements) {
        if (boundTargetForModel(targets, undefined, supplement) !== undefined) {
          models.add(supplement.model);
        }
      }
      return [...references].every((model) => models.has(model));
    }
    for (const model of record.automaticModels) models.add(model.id);
    for (const supplement of record.supplements) {
      if (
        supplement.source === "migration-retention" ||
        supplement.targetFingerprint === record.targetFingerprint
      ) models.add(supplement.model);
    }
    return [...references].every((model) => models.has(model));
  };

  /**
   * 把一份模型引用涉及的那几家服务锁住(ADR 0036)。「先判可用性再写」是读-判-写:不锁的话
   * 切版或删服务会插在两步中间,写进去的组合当场就跑不动了。锁的是父行——模型服务那一行
   * 就是可用性的父行。
   */
  const lockReferencedServices = async (json: string | null, context: string): Promise<void> => {
    if (json === null) return;
    let providers: string[];
    try {
      providers = [...new Set(parseStoredReviewers(json, context).map((spec) => spec.provider))];
    } catch {
      return; // 形状不对的那一份由可用性判定去拒,锁不锁都不影响结论。
    }
    if (providers.length === 0) return;
    // 按名字取锁:两次并发的保存引到同一批服务时,取锁次序一致才不会互相卡住。
    await orm
      .select({ provider: modelService.provider })
      .from(modelService)
      .where(inArray(modelService.provider, providers))
      .orderBy(asc(modelService.provider))
      .for("update");
  };

  /** 一处辅助模型引用同律:它引的那一家也要锁住。 */
  const lockAuxiliaryService = async (json: string | null): Promise<void> => {
    const spec = json === null ? null : parseAuxiliaryModel(json);
    if (spec === null) return;
    await orm
      .select({ provider: modelService.provider })
      .from(modelService)
      .where(eq(modelService.provider, spec.provider))
      .for("update");
  };

  /** 这一家模型服务此刻的版本,顺手把那一行锁住:读-判-写的父行就是它。 */
  const lockService = async (provider: string): Promise<{
    version: number;
    serviceType: string;
    disabledReason: string | null;
  } | undefined> => {
    const [row] = await orm
      .select({
        version: modelService.version,
        serviceType: modelService.serviceType,
        disabledReason: modelService.disabledReason,
      })
      .from(modelService)
      .where(eq(modelService.provider, provider))
      .for("update");
    return row;
  };

  const repoRecord = (row: typeof repoTable.$inferSelect): RepoRecord => ({
    repoId: row.id,
    owner: row.owner,
    repo: row.repo,
    reviewersJson: row.reviewers,
    auxiliaryModelJson: row.auxiliaryModel,
    minReportSeverity: readMinReportSeverity(row.minReportSeverity ?? undefined),
    defaultBranch: row.defaultBranch,
    settingsVersion: row.settingsVersion,
  });

  /** 一份设置值的写入:null 即删掉那一行(「跟随系统默认」就是库里没有这一行)。 */
  const writeSetting = async (key: string, value: string | null): Promise<void> => {
    if (value === null) {
      await orm.delete(globalSetting).where(eq(globalSetting.key, key));
      return;
    }
    await orm
      .insert(globalSetting)
      .values({ key, value })
      .onConflictDoUpdate({ target: globalSetting.key, set: { value } });
  };

  const readSetting = async (key: string): Promise<string | undefined> => {
    const [row] = await orm
      .select({ value: globalSetting.value })
      .from(globalSetting)
      .where(eq(globalSetting.key, key));
    return row?.value;
  };

  return {
    async registerRepo(record) {
      return await transaction(async (tx) => {
        if (record.reviewersJson !== undefined) {
          const context = `仓库 ${record.repoId} 的模型覆盖`;
          await lockReferencedServices(record.reviewersJson, context);
          if (!(await modelCombinationAvailable(record.reviewersJson, context))) {
            return tx.rollback(false);
          }
        }
        await orm.insert(repoTable).values({
          id: record.repoId,
          owner: record.owner,
          repo: record.repo,
          reviewers: record.reviewersJson ?? null,
          registeredAt: new Date().toISOString(),
        });
        await orm
          .insert(repoKey)
          .values({ repoId: record.repoId, generation: record.generation, key: record.key });
        if (record.assignTo !== undefined) {
          await orm
            .insert(panelUserRepo)
            .values({ username: record.assignTo, repoId: record.repoId })
            .onConflictDoNothing();
        }
        return true;
      });
    },

    async addRepoKey(repoId, generation, key) {
      await orm.insert(repoKey).values({ repoId, generation, key });
    },

    async removeRepoKey(repoId, generation) {
      await orm
        .delete(repoKey)
        .where(and(eq(repoKey.repoId, repoId), eq(repoKey.generation, generation)));
    },

    async listRepoKeys(repoId) {
      return await orm
        .select({ generation: repoKey.generation, key: repoKey.key })
        .from(repoKey)
        .where(eq(repoKey.repoId, repoId))
        .orderBy(asc(repoKey.generation));
    },

    async getRepo(repoId) {
      const [row] = await orm.select().from(repoTable).where(eq(repoTable.id, repoId));
      return row === undefined ? undefined : repoRecord(row);
    },

    async resolveAuxiliaryModel(repoId) {
      const repo = await store().getRepo(repoId);
      if (repo === undefined) return null;
      const settings = await store().getGlobalSettings();
      const repoOverride = parseAuxiliaryModel(repo.auxiliaryModelJson);
      if (repoOverride !== null) return { spec: repoOverride, source: "repo" };
      const global = parseAuxiliaryModel(settings.auxiliaryModelJson);
      if (global !== null) return { spec: global, source: "global" };
      // 退路取这个仓库生效组合的第一个:仓库改了模型覆盖,退路跟着换(ADR 0029)。
      const reviewersJson = repo.reviewersJson ?? settings.reviewersJson;
      if (reviewersJson === null) return null;
      const first = parseStoredReviewers(reviewersJson, `仓库 ${repoId} 的生效模型组合`)[0];
      return first === undefined ? null : { spec: first, source: "first-reviewer" };
    },

    async putRepoSettings(repoId, expectedVersion, settings) {
      return await transaction(async (tx) => {
        // 先锁住这个仓库那一行(ADR 0036):版本号读出来就要按它写回去,不锁的话两次并发的
        // 保存会读到同一个版本、各写各的。
        const [row] = await orm
          .select({
            settingsVersion: repoTable.settingsVersion,
            reviewers: repoTable.reviewers,
            auxiliaryModel: repoTable.auxiliaryModel,
          })
          .from(repoTable)
          .where(eq(repoTable.id, repoId))
          .for("update");
        if (row === undefined) {
          return tx.rollback({ ok: false, reason: "missing" });
        }
        if (row.settingsVersion !== expectedVersion) {
          return tx.rollback({ ok: false, reason: "stale" });
        }
        // 可用性在同一事务里再判一次:浏览器里的候选状态与落库那一刻之间,模型服务
        // 可能已经变了。清成跟随全局永远可做。**换了才判**(判据与 `replaceGlobalSettings`
        // 同一条):覆盖里早就有失效模型时,只改等级或辅助模型的那一次不被它连坐。
        const context = `仓库 ${repoId} 的模型覆盖`;
        if (
          settings.reviewersJson !== null &&
          settings.reviewersJson !== row.reviewers
        ) {
          await lockReferencedServices(settings.reviewersJson, context);
          if (!(await modelCombinationAvailable(settings.reviewersJson, context))) {
            return tx.rollback({ ok: false, reason: "unavailable" });
          }
        }
        // 辅助模型覆盖与组合并列同一道兜底(issue #303),同样只在换了的时候判。
        if (
          settings.auxiliaryModelJson !== null &&
          settings.auxiliaryModelJson !== row.auxiliaryModel
        ) {
          await lockAuxiliaryService(settings.auxiliaryModelJson);
          if (!(await auxiliaryModelAvailable(settings.auxiliaryModelJson))) {
            return tx.rollback({ ok: false, reason: "unavailable" });
          }
        }
        const version = expectedVersion + 1;
        await orm
          .update(repoTable)
          .set({
            reviewers: settings.reviewersJson,
            auxiliaryModel: settings.auxiliaryModelJson,
            minReportSeverity: settings.minReportSeverity,
            defaultBranch: settings.defaultBranch,
            settingsVersion: version,
          })
          .where(eq(repoTable.id, repoId));
        return { ok: true, version };
      });
    },

    async removeRepo(repoId) {
      await transaction(async () => {
        await orm.delete(repoKey).where(eq(repoKey.repoId, repoId));
        await orm.delete(panelUserRepo).where(eq(panelUserRepo.repoId, repoId));
        // 产品归属跟着仓库走(issue #331):留下来产品就挂着一个已经不存在的仓库。
        await orm.delete(productRepo).where(eq(productRepo.repoId, repoId));
        // 知识集跟着仓库走:留下来只会在同一个 repo id 重新注册时复活一份没人认过的规则。
        await orm.delete(reviewRule).where(eq(reviewRule.repoId, repoId));
        await orm.delete(ruleSetVersion).where(eq(ruleSetVersion.repoId, repoId));
        await orm.delete(ruleDraftItem).where(eq(ruleDraftItem.repoId, repoId));
        await orm.delete(ruleExploration).where(eq(ruleExploration.repoId, repoId));
        await orm.delete(ruleConsolidation).where(eq(ruleConsolidation.repoId, repoId));
        await orm.delete(ruleProposalSource).where(
          inArray(
            ruleProposalSource.proposalId,
            orm.select({ id: ruleProposal.id }).from(ruleProposal).where(eq(ruleProposal.repoId, repoId)),
          ),
        );
        await orm.delete(ruleProposal).where(eq(ruleProposal.repoId, repoId));
        await orm.delete(ruleTrace).where(eq(ruleTrace.repoId, repoId));
        await orm.delete(repoTable).where(eq(repoTable.id, repoId));
      });
    },

    async setRepoWorktree(repoId, status) {
      await orm
        .update(repoTable)
        .set({
          worktreeState: status.state,
          worktreeFailure: status.failure,
          worktreeCheckedAt: status.checkedAt,
        })
        .where(eq(repoTable.id, repoId));
    },

    async failInterruptedWorktrees(failure, at) {
      await orm
        .update(repoTable)
        .set({ worktreeState: "failed", worktreeFailure: failure, worktreeCheckedAt: at })
        .where(eq(repoTable.worktreeState, "preparing"));
    },

    async listRepos() {
      // 评审记录按注册时的 owner/repo 匹配。仓库在 Forge 上改名后新记录用新名字,
      // 旧名字的记录不再计入——注册表的名字由后续的注册流程更新,这里不猜。
      const run = alias(reviewRun, "run");
      const f = alias(finding, "f");
      const sameRepo = sql`${run.owner} = ${repoTable.owner} AND ${run.repo} = ${repoTable.repo}`;
      // 三段子查询各先拼成自己的 `sql` 再放进投影:`select({...})` 的 SQL 字段在单表查询上
      // 会被 Drizzle 摘掉直接写在里面的列的表限定(它假定单表不必限定),`"f"."run_id"` 因此
      // 会变成裸的 `"run_id"` 而与 `"run"."id"` 撞名。套一层之后里面的列原样渲染。
      const runCount = sql<number>`(SELECT COUNT(*) FROM ${reviewRun} ${run} WHERE ${sameRepo})`;
      const findingCount = sql<number>`(SELECT COUNT(*) FROM ${finding} ${f}
                                          JOIN ${reviewRun} ${run} ON ${f.runId} = ${run.id}
                                         WHERE ${sameRepo})`;
      const lastActivity = sql`(SELECT MAX(${run.startedAt}) FROM ${reviewRun} ${run}
                                 WHERE ${sameRepo})`;
      const rows = await orm
        .select({
          row: repoTable,
          runCount: sql<number>`${runCount}`,
          findingCount: sql<number>`${findingCount}`,
          // 时刻列从原始 SQL 回来的是 PostgreSQL 的原文,`mapWith` 借那一列自己的解析器
          // 换回 ISO,读法因此与 builder 选出来的一样。
          lastActivity: sql<string>`${lastActivity}`.mapWith(reviewRun.startedAt),
        })
        .from(repoTable)
        // 最近有动静的排在前面,没跑过的按注册时刻垫底。
        .orderBy(
          sql`${lastActivity} IS NULL`,
          sql`COALESCE(${lastActivity}, ${repoTable.registeredAt}) DESC`,
        );
      return rows.map(({ row, runCount, findingCount, lastActivity }) => ({
        ...repoRecord(row),
        runCount: Number(runCount),
        findingCount: Number(findingCount),
        lastActivity: lastActivity ?? null,
        worktree: {
          state: worktreeState(row.worktreeState),
          failure: row.worktreeFailure,
          checkedAt: row.worktreeCheckedAt,
        },
      }));
    },

    async findRepoId(owner, repo) {
      const [row] = await orm
        .select({ id: repoTable.id })
        .from(repoTable)
        .where(and(eq(repoTable.owner, owner), eq(repoTable.repo, repo)))
        .orderBy(asc(repoTable.id));
      return row?.id;
    },

    async getGlobalSettings() {
      const rows = await orm
        .select({ key: globalSetting.key, value: globalSetting.value })
        .from(globalSetting);
      const values = new Map(rows.map((row) => [row.key, row.value]));
      const limit = (field: BatchLimitField): number | null => {
        const stored = values.get(BATCH_LIMIT_KEYS[field]);
        return stored === undefined ? null : Number(stored);
      };
      return {
        reviewersJson: values.get(GLOBAL_REVIEWERS_KEY) ?? null,
        auxiliaryModelJson: values.get(GLOBAL_AUXILIARY_MODEL_KEY) ?? null,
        maxChangedLinesPerBatch: limit("maxChangedLinesPerBatch"),
        maxParallelBatches: limit("maxParallelBatches"),
        maxFilesPerBatch: limit("maxFilesPerBatch"),
        maxEvidenceCallsPerBatch: limit("maxEvidenceCallsPerBatch"),
        minReportSeverity: readMinReportSeverity(values.get(GLOBAL_MIN_REPORT_SEVERITY_KEY)),
        version: Number(values.get(GLOBAL_SETTINGS_VERSION_KEY) ?? 1),
      };
    },

    async getReviewRunSnapshot(repoId) {
      return await transaction(async () => {
        const repo = await store().getRepo(repoId);
        if (repo === undefined) throw new Error(`仓库 ${repoId} 不在注册表里`);
        const settings = await store().getGlobalSettings();
        const reviewers = repo.reviewersJson === null
          ? settings.reviewersJson === null
            ? []
            : assertReviewerSpecs(JSON.parse(settings.reviewersJson), GLOBAL_REVIEWERS_CONTEXT, {
                allowEmpty: true,
              })
          : assertReviewerSpecs(JSON.parse(repo.reviewersJson), `仓库 ${repoId} 的模型覆盖`);
        const providers = [...new Set(reviewers.map((reviewer) => reviewer.provider))];
        const modelServices: ModelServiceRecord[] = [];
        for (const provider of providers) {
          const service = await store().getModelService(provider);
          if (service !== undefined) modelServices.push(service);
        }
        const ruleSet = await store().getRuleSet(repoId);
        return {
          reviewers: Object.freeze([...reviewers]),
          maxChangedLinesPerBatch: settings.maxChangedLinesPerBatch,
          maxParallelBatches: settings.maxParallelBatches,
          maxFilesPerBatch: settings.maxFilesPerBatch,
          maxEvidenceCallsPerBatch: settings.maxEvidenceCallsPerBatch,
          modelServices: Object.freeze(modelServices),
          ruleSetVersion: ruleSet?.version ?? null,
          // 两型在同一份快照里按 type 分开(issue #221):注入时各走各的模板,冻结的
          // 版本只有一个。
          rules: Object.freeze(
            (ruleSet?.rules ?? []).filter((entry) => entry.type === "rule").map(toReviewRule),
          ),
          facts: Object.freeze(
            (ruleSet?.rules ?? []).filter((entry) => entry.type === "fact").map(toProjectFact),
          ),
        };
      });
    },

    async replaceGlobalSettings(expectedVersion, next) {
      return await transaction(async (tx) => {
        // 审查策略整页一次全量替换,版本号是读-判-写:整张表锁住再读版本(ADR 0036)。
        // 表上常常连版本那一行都还没有(首次配置之前),锁不到父行,与 bootstrap 同一档。
        await orm.execute(sql`LOCK TABLE ${globalSetting} IN SHARE ROW EXCLUSIVE MODE`);
        const versionRow = await readSetting(GLOBAL_SETTINGS_VERSION_KEY);
        const version = versionRow === undefined ? 1 : Number(versionRow);
        // 组合没换就不重判可用性:这一道是端点那次校验与这次写入之间的兜底(中间有人停用
        // 了模型服务),换的是同一份值就没有引入新的不可用引用。空组合只在库里现存的那一份
        // 也是空的时候放行——首次配置之前库里就是这个样子,配过非空之后不再收空(spec #300,
        // 判据与 `PUT /settings` 同一条)。清成没配(null)是播种与迁移的路,不走这一道。
        const storedReviewers = await readSetting(GLOBAL_REVIEWERS_KEY);
        const stored = storedReviewers === undefined ? null : storedReviewers;
        await lockReferencedServices(next.reviewersJson, GLOBAL_REVIEWERS_CONTEXT);
        await lockAuxiliaryService(next.auxiliaryModelJson);
        const reviewersOk = next.reviewersJson === null ||
          next.reviewersJson === stored ||
          (storedReviewersEmpty(next.reviewersJson)
            ? storedReviewersEmpty(stored)
            : await modelCombinationAvailable(next.reviewersJson, GLOBAL_REVIEWERS_CONTEXT));
        // 辅助模型与组合并列同一道兜底(issue #303),同样只在换了的时候判。
        const storedAuxiliary = await readSetting(GLOBAL_AUXILIARY_MODEL_KEY);
        const auxiliaryOk = next.auxiliaryModelJson === null ||
          next.auxiliaryModelJson === (storedAuxiliary === undefined ? null : storedAuxiliary) ||
          await auxiliaryModelAvailable(next.auxiliaryModelJson);
        if (version !== expectedVersion || !reviewersOk || !auxiliaryOk) {
          return tx.rollback(false);
        }
        await writeSetting(GLOBAL_REVIEWERS_KEY, next.reviewersJson);
        await writeSetting(GLOBAL_AUXILIARY_MODEL_KEY, next.auxiliaryModelJson);
        for (const field of Object.keys(BATCH_LIMIT_KEYS) as BatchLimitField[]) {
          const limit = next[field];
          await writeSetting(BATCH_LIMIT_KEYS[field], limit === null ? null : String(limit));
        }
        await writeSetting(GLOBAL_MIN_REPORT_SEVERITY_KEY, next.minReportSeverity);
        await writeSetting(GLOBAL_SETTINGS_VERSION_KEY, String(version + 1));
        return true;
      });
    },

    async commitModelServiceVersion(expectedVersion, record) {
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
      // 目标集合(ADR 0027)只属于内置服务;指纹由集合算出,调用方给的必须与之一致,
      // 否则集合与指纹各说各话,旧版本的证明规则就没了依据。
      const targets = record.targets == null ? null : normalizeModelServiceTargets(record.targets);
      if (targets !== null) {
        if (record.type !== "builtin") {
          throw new Error(`${record.provider} 是自定义模型服务,目标在地址与协议上,不记目标集合`);
        }
        if (record.targetFingerprint !== modelServiceTargetSetFingerprint(targets)) {
          throw new Error(`${record.provider} 的目标指纹与目标集合不一致`);
        }
      }
      const targetsJson = targets === null ? null : JSON.stringify(targets);

      return await transaction(async (tx) => {
        // 切版是读-判-写:先把这一行锁住(ADR 0036),引用判定与版本推进之间插不进另一次切版。
        const current = await lockService(record.provider);
        if (!(await recordSupportsCurrentReferences(record))) {
          return tx.rollback(undefined);
        }
        let version: number;
        if (expectedVersion === null) {
          if (current !== undefined) {
            return tx.rollback(undefined);
          }
          version = 1;
          await orm.insert(modelService).values({
            provider: record.provider,
            serviceType: record.type,
            version,
            baseUrl: record.baseUrl,
            api: record.api,
            targetFingerprint: record.targetFingerprint,
            targetsJson,
            disabledReason: record.disabledReason,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
        } else {
          const changed = await orm
            .update(modelService)
            .set({
              serviceType: record.type,
              version: sql`${modelService.version} + 1`,
              baseUrl: record.baseUrl,
              api: record.api,
              targetFingerprint: record.targetFingerprint,
              targetsJson,
              disabledReason: record.disabledReason,
              updatedAt: record.updatedAt,
            })
            .where(
              and(eq(modelService.provider, record.provider), eq(modelService.version, expectedVersion)),
            )
            .returning({ provider: modelService.provider });
          if (changed.length === 0) {
            return tx.rollback(undefined);
          }
          version = expectedVersion + 1;
        }

        await orm
          .delete(modelServiceCredential)
          .where(eq(modelServiceCredential.provider, record.provider));
        await orm.insert(modelServiceCredential).values({
          provider: record.provider,
          state: record.credential.state,
          apiKeyEncrypted: record.credential.apiKeyEncrypted,
          updatedAt: record.credential.updatedAt,
          verifiedAt: record.credential.verifiedAt,
          validationModel: record.credential.validationModel,
          verificationSource: record.credential.verificationSource,
        });

        await orm
          .delete(modelDirectoryModel)
          .where(eq(modelDirectoryModel.provider, record.provider));
        await orm.delete(modelDirectory).where(eq(modelDirectory.provider, record.provider));
        await orm.insert(modelDirectory).values({
          provider: record.provider,
          serviceVersion: version,
          state: record.directory.state,
          lastAttemptAt: record.directory.lastAttemptAt,
          lastSuccessAt: record.directory.lastSuccessAt,
          failure: record.directory.failure,
          ignoredModelCount: record.directory.ignoredModelCount,
        });
        for (const model of automaticModels.values()) {
          const fieldSources = normalizedTrustedFieldSources(model.fields, model.fieldSources);
          await orm.insert(modelDirectoryModel).values({
            provider: record.provider,
            model: model.id,
            serviceVersion: version,
            name: model.fields.name ?? null,
            api: model.fields.api ?? null,
            baseUrl: model.fields.baseUrl ?? null,
            inputJson: model.fields.input === undefined ? null : JSON.stringify(model.fields.input),
            reasoning: model.fields.reasoning ?? null,
            contextWindow: model.fields.contextWindow ?? null,
            maxTokens: model.fields.maxTokens ?? null,
            fieldSourcesJson: fieldSources === undefined ? null : JSON.stringify(fieldSources),
            thinkingLevelMapJson:
              model.fields.thinkingLevelMap === undefined
                ? null
                : JSON.stringify(model.fields.thinkingLevelMap),
            compatJson:
              model.fields.compat === undefined ? null : JSON.stringify(model.fields.compat),
          });
        }

        await orm.delete(modelSupplement).where(eq(modelSupplement.provider, record.provider));
        for (const supplement of record.supplements) {
          await orm.insert(modelSupplement).values({
            provider: record.provider,
            model: supplement.model,
            source: supplement.source,
            targetFingerprint: supplement.targetFingerprint,
            createdAt: supplement.createdAt,
          });
        }
        return version;
      });
    },

    async renameConflictingCustomModelService(provider, newProvider, expectedVersion, updatedAt) {
      return await transaction(async (tx) => {
        if (!CUSTOM_PROVIDER_NAME_PATTERN.test(newProvider)) {
          return tx.rollback({ status: "invalid-provider" });
        }
        const current = await lockService(provider);
        if (current === undefined || current.version !== expectedVersion) {
          return tx.rollback({ status: "version-conflict" });
        }
        if (current.serviceType !== "custom" || current.disabledReason !== "name-conflict") {
          return tx.rollback({ status: "not-conflicting" });
        }
        if ((await lockService(newProvider)) !== undefined) {
          return tx.rollback({ status: "provider-conflict" });
        }

        const references = (await store().listModelReferences()).filter(
          (reference) => reference.provider === provider,
        );
        const missing: ModelReference[] = [];
        for (const reference of references) {
          if (!(await availableModel(provider, reference.model))) missing.push(reference);
        }
        if (missing.length > 0) {
          return tx.rollback({ status: "missing-models", references: missing });
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
        // 辅助模型那两处是同一类模型引用(CONTEXT.md 自定义 provider):它们也在这一笔
        // 事务里改名,否则引用会指向一个不再存在的 provider。
        const rewriteAuxiliary = (auxiliaryModelJson: string): string | undefined => {
          const spec = parseAuxiliaryModel(auxiliaryModelJson);
          if (spec === null || spec.provider !== provider) return undefined;
          return JSON.stringify({ ...spec, provider: newProvider });
        };
        let globalChanged = false;
        const globalJson = await readSetting(GLOBAL_REVIEWERS_KEY);
        if (globalJson !== undefined) {
          const nextJson = rewrite(globalJson, GLOBAL_REVIEWERS_CONTEXT, true);
          if (nextJson !== undefined) {
            await writeSetting(GLOBAL_REVIEWERS_KEY, nextJson);
            globalChanged = true;
          }
        }
        const globalAuxiliaryJson = await readSetting(GLOBAL_AUXILIARY_MODEL_KEY);
        if (globalAuxiliaryJson !== undefined) {
          const nextJson = rewriteAuxiliary(globalAuxiliaryJson);
          if (nextJson !== undefined) {
            await writeSetting(GLOBAL_AUXILIARY_MODEL_KEY, nextJson);
            globalChanged = true;
          }
        }
        // 整页一个版本(issue #301):这一页里换了什么都只推一版。
        if (globalChanged) {
          const versionRow = await readSetting(GLOBAL_SETTINGS_VERSION_KEY);
          const version = versionRow === undefined ? 1 : Number(versionRow);
          await writeSetting(GLOBAL_SETTINGS_VERSION_KEY, String(version + 1));
        }
        const overrides = await orm
          .select({
            id: repoTable.id,
            owner: repoTable.owner,
            repo: repoTable.repo,
            reviewers: repoTable.reviewers,
            auxiliaryModel: repoTable.auxiliaryModel,
          })
          .from(repoTable)
          .where(or(isNotNull(repoTable.reviewers), isNotNull(repoTable.auxiliaryModel)));
        for (const row of overrides) {
          if (row.reviewers !== null) {
            const nextJson = rewrite(
              row.reviewers,
              `仓库 ${row.owner}/${row.repo}（id ${row.id}）的模型覆盖`,
              false,
            );
            if (nextJson !== undefined) {
              await orm
                .update(repoTable)
                .set({ reviewers: nextJson })
                .where(eq(repoTable.id, row.id));
            }
          }
          if (row.auxiliaryModel !== null) {
            const nextJson = rewriteAuxiliary(row.auxiliaryModel);
            if (nextJson !== undefined) {
              await orm
                .update(repoTable)
                .set({ auxiliaryModel: nextJson })
                .where(eq(repoTable.id, row.id));
            }
          }
        }

        const nextVersion = expectedVersion + 1;
        await orm
          .update(modelDirectoryModel)
          .set({ provider: newProvider, serviceVersion: nextVersion })
          .where(eq(modelDirectoryModel.provider, provider));
        await orm
          .update(modelDirectory)
          .set({ provider: newProvider, serviceVersion: nextVersion })
          .where(eq(modelDirectory.provider, provider));
        await orm
          .update(modelSupplement)
          .set({ provider: newProvider })
          .where(eq(modelSupplement.provider, provider));
        await orm
          .update(modelServiceModelState)
          .set({ provider: newProvider })
          .where(eq(modelServiceModelState.provider, provider));
        const [credential] = await orm
          .select({ validationModel: modelServiceCredential.validationModel })
          .from(modelServiceCredential)
          .where(eq(modelServiceCredential.provider, provider));
        const validationModel = credential?.validationModel ?? null;
        await orm
          .update(modelServiceCredential)
          .set({
            provider: newProvider,
            validationModel:
              validationModel === null
                ? null
                : `${newProvider}:${validationModel.slice(provider.length + 1)}`,
          })
          .where(eq(modelServiceCredential.provider, provider));
        await orm
          .update(modelService)
          .set({
            provider: newProvider,
            version: nextVersion,
            disabledReason: null,
            updatedAt,
          })
          .where(and(eq(modelService.provider, provider), eq(modelService.version, expectedVersion)));
        return { status: "renamed", version: nextVersion };
      });
    },

    async removeCustomModelService(provider, expectedVersion) {
      return await transaction(async (tx) => {
        const current = await lockService(provider);
        if (
          current === undefined ||
          current.serviceType !== "custom" ||
          current.version !== expectedVersion
        ) {
          return tx.rollback(false);
        }
        if ((await referencedModels(provider)).size > 0) {
          return tx.rollback(false);
        }
        await orm.delete(modelDirectoryModel).where(eq(modelDirectoryModel.provider, provider));
        await orm.delete(modelDirectory).where(eq(modelDirectory.provider, provider));
        await orm.delete(modelSupplement).where(eq(modelSupplement.provider, provider));
        await orm
          .delete(modelServiceModelState)
          .where(eq(modelServiceModelState.provider, provider));
        await orm
          .delete(modelServiceCredential)
          .where(eq(modelServiceCredential.provider, provider));
        const removed = await orm
          .delete(modelService)
          .where(
            and(
              eq(modelService.provider, provider),
              eq(modelService.serviceType, "custom"),
              eq(modelService.version, expectedVersion),
            ),
          )
          .returning({ provider: modelService.provider });
        if (removed.length !== 1) {
          return tx.rollback(false);
        }
        return true;
      });
    },

    async getModelService(provider) {
      const [service] = await orm
        .select()
        .from(modelService)
        .where(eq(modelService.provider, provider));
      if (service === undefined) return undefined;
      const [credential] = await orm
        .select()
        .from(modelServiceCredential)
        .where(eq(modelServiceCredential.provider, provider));
      const [directory] = await orm
        .select()
        .from(modelDirectory)
        .where(eq(modelDirectory.provider, provider));
      if (credential === undefined || directory === undefined) {
        throw new Error(`${provider} 的模型服务当前版本不完整`);
      }
      const version = service.version;
      if (directory.serviceVersion !== version) {
        throw new Error(`${provider} 的模型目录不属于当前服务版本`);
      }
      const automaticModels = (await orm
        .select()
        .from(modelDirectoryModel)
        .where(
          and(
            eq(modelDirectoryModel.provider, provider),
            eq(modelDirectoryModel.serviceVersion, version),
          ),
        )
        .orderBy(asc(modelDirectoryModel.model)))
        .map((row): DiscoveredModel => {
          const fields: TrustedModelFields = {
            ...(row.name === null ? {} : { name: row.name }),
            ...(row.api === null ? {} : { api: row.api }),
            ...(row.baseUrl === null ? {} : { baseUrl: row.baseUrl }),
            ...(row.inputJson === null
              ? {}
              : { input: JSON.parse(row.inputJson) as readonly ("text" | "image")[] }),
            ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
            ...(row.contextWindow === null ? {} : { contextWindow: row.contextWindow }),
            ...(row.maxTokens === null ? {} : { maxTokens: row.maxTokens }),
            ...(row.thinkingLevelMapJson === null
              ? {}
              : {
                  thinkingLevelMap: JSON.parse(
                    row.thinkingLevelMapJson,
                  ) as NonNullable<TrustedModelFields["thinkingLevelMap"]>,
                }),
            ...(row.compatJson === null
              ? {}
              : {
                  compat: JSON.parse(row.compatJson) as NonNullable<TrustedModelFields["compat"]>,
                }),
          };
          const fieldSources = row.fieldSourcesJson === null
            ? undefined
            : normalizedTrustedFieldSources(
                fields,
                JSON.parse(row.fieldSourcesJson) as TrustedModelFieldSources,
              );
          return {
            identity: modelIdentity({ provider, model: row.model }),
            provider,
            id: row.model,
            fields,
            ...(fieldSources === undefined ? {} : { fieldSources }),
          };
        });
      return {
        provider: service.provider,
        type: service.serviceType as "builtin" | "custom",
        version,
        baseUrl: service.baseUrl,
        api: service.api,
        targetFingerprint: service.targetFingerprint,
        targets:
          service.targetsJson === null
            ? null
            : JSON.parse(service.targetsJson) as ModelServiceBoundTarget[],
        disabledReason: service.disabledReason === null ? null : "name-conflict" as const,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        credential: {
          state: credential.state as ModelCredentialState,
          apiKeyEncrypted: credential.apiKeyEncrypted,
          updatedAt: credential.updatedAt,
          verifiedAt: credential.verifiedAt,
          validationModel: credential.validationModel,
          verificationSource: credential.verificationSource as ModelVerificationSource | null,
        },
        directory: {
          state: directory.state as ModelDirectoryState,
          lastAttemptAt: directory.lastAttemptAt,
          lastSuccessAt: directory.lastSuccessAt,
          failure: directory.failure,
          ignoredModelCount: directory.ignoredModelCount,
        },
        automaticModels,
        supplements: await store().listModelSupplements(provider),
      };
    },

    async listModelServices() {
      const providers = await orm
        .select({ provider: modelService.provider })
        .from(modelService)
        .orderBy(asc(modelService.provider));
      const services: ModelServiceRecord[] = [];
      for (const row of providers) {
        services.push((await store().getModelService(row.provider))!);
      }
      return services;
    },

    async listModelReferences() {
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
      const globalJson = await readSetting(GLOBAL_REVIEWERS_KEY);
      const global = globalJson === undefined
        ? []
        : parse(globalJson, GLOBAL_REVIEWERS_CONTEXT, true);
      const [following] = await orm
        .select({ value: count() })
        .from(repoTable)
        .where(isNull(repoTable.reviewers));
      const followingGlobal = following?.value ?? 0;
      for (const spec of global) {
        const reference = referenceFor(spec);
        reference.locations.push({ kind: "global" });
        if (followingGlobal > 0) {
          reference.locations.push({ kind: "following-global", repositoryCount: followingGlobal });
        }
      }
      // 全局那一处辅助模型与模型组合同等(issue #303):它引用的模型一样受这份清单保护。
      const globalAuxiliaryJson = await readSetting(GLOBAL_AUXILIARY_MODEL_KEY);
      const globalAuxiliary = parseAuxiliaryModel(globalAuxiliaryJson ?? null);
      if (globalAuxiliary !== null) {
        referenceFor(globalAuxiliary).locations.push({ kind: "global-auxiliary" });
      }
      const overrides = await orm
        .select({
          id: repoTable.id,
          owner: repoTable.owner,
          repo: repoTable.repo,
          reviewers: repoTable.reviewers,
          auxiliaryModel: repoTable.auxiliaryModel,
        })
        .from(repoTable)
        .where(or(isNotNull(repoTable.reviewers), isNotNull(repoTable.auxiliaryModel)))
        .orderBy(asc(repoTable.id));
      for (const row of overrides) {
        const auxiliary = parseAuxiliaryModel(row.auxiliaryModel);
        if (auxiliary !== null) {
          referenceFor(auxiliary).locations.push({
            kind: "repository-auxiliary",
            repoId: row.id,
            owner: row.owner,
            repo: row.repo,
          });
        }
        for (const spec of row.reviewers === null ? [] : parse(
          row.reviewers,
          `仓库 ${row.owner}/${row.repo}（id ${row.id}）的模型覆盖`,
          false,
        )) {
          referenceFor(spec).locations.push({
            kind: "repository-override",
            repoId: row.id,
            owner: row.owner,
            repo: row.repo,
          });
        }
      }
      return [...references.values()].sort((left, right) =>
        left.identity.localeCompare(right.identity),
      );
    },

    async listModelServiceModelStates(provider) {
      const rows = await orm
        .select()
        .from(modelServiceModelState)
        .where(provider === undefined ? undefined : eq(modelServiceModelState.provider, provider))
        .orderBy(asc(modelServiceModelState.provider), asc(modelServiceModelState.model));
      return rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        enabled: row.enabled,
        updatedAt: row.updatedAt,
      }));
    },

    async updateModelServiceModelStates(provider, expectedVersion, models, enabled, updatedAt) {
      const requested = [...new Set(models.map((model) => model.trim()))];
      if (requested.some((model) => model === "")) {
        throw new Error("模型标识不能为空");
      }
      return await transaction(async (tx) => {
        const service = await lockService(provider);
        if (service === undefined || service.version !== expectedVersion) {
          return tx.rollback({ status: "version-conflict" } as const);
        }
        const knownRows = await orm.execute<{ model: string }>(sql`
          SELECT ${modelDirectoryModel.model} FROM ${modelDirectoryModel}
           WHERE ${modelDirectoryModel.provider} = ${provider}
             AND ${modelDirectoryModel.serviceVersion} = ${expectedVersion}
          UNION SELECT ${modelSupplement.model} FROM ${modelSupplement}
                 WHERE ${modelSupplement.provider} = ${provider}`);
        const known = new Set(knownRows.rows.map((row) => row.model));
        const unknownModels = requested.filter((model) => !known.has(model));
        if (unknownModels.length > 0) {
          return tx.rollback({ status: "unknown-models", models: unknownModels } as const);
        }
        if (!enabled) {
          const blocked = (await store().listModelReferences()).filter(
            (reference) => reference.provider === provider && requested.includes(reference.model),
          );
          if (blocked.length > 0) {
            return tx.rollback({ status: "referenced", references: blocked } as const);
          }
        }
        for (const model of requested) {
          await orm
            .insert(modelServiceModelState)
            .values({ provider, model, enabled, updatedAt })
            .onConflictDoUpdate({
              target: [modelServiceModelState.provider, modelServiceModelState.model],
              set: { enabled, updatedAt },
            });
        }
        return { status: "updated", updated: requested.length } as const;
      });
    },

    async listModelSupplements(provider) {
      const rows = await orm
        .select()
        .from(modelSupplement)
        .where(provider === undefined ? undefined : eq(modelSupplement.provider, provider))
        .orderBy(asc(modelSupplement.provider), asc(modelSupplement.model));
      return rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        source: row.source as ModelSupplementSource,
        targetFingerprint: row.targetFingerprint,
        createdAt: row.createdAt,
      }));
    },

    async claimDelivery(owner, repo, headSha) {
      // 判重靠唯一约束上的插入冲突:插得进即这一次是第一次,插不进即已经领走过。
      const claimed = await orm
        .insert(webhookDelivery)
        .values({ owner, repo, headSha, claimedAt: new Date().toISOString() })
        .onConflictDoNothing()
        .returning({ id: webhookDelivery.id });
      return claimed.length > 0;
    },
  };
}
