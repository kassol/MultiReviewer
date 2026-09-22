/**
 * 各域共用的库层构件(spec #445 第二段):跨域的 SQL 片段、行读法,与开库时建出来的那一批
 * 闭包。
 *
 * **它存在是为了让 #451–#457 六票并行**:各域把自己的方法搬进 `store/<域>.ts` 时,共用件从
 * 这里引,不各抽一份;`store/index.ts` 上每票只加自己那一行 `...xMethods(ctx)`。
 * 只被一个域用到的东西不在这里——它跟着那一域的方法一起搬走。
 *
 * 这个文件**不引 `./index.ts` 的运行时值**(只 `import type`):两边互引运行时值会成环。
 */
import { createHash } from "node:crypto";

import { assertReviewerSpecs, type ReviewerSpec } from "../../config.ts";
import type {
  CarriedAttribution,
  Category,
  KnowledgeType,
  ReviewerUsage,
  ReviewTriggerSource,
  Severity,
} from "../finding.ts";
import type { RecordedFindingAttribution } from "../../contracts/finding.ts";
import { normalizeModelServiceBaseUrl } from "../../reviewer/model-service-runtime.ts";
import type { Db, Orm, StoreTransaction, TransactionMode } from "./pg.ts";
import type {
  AgentSessionEntryRecord,
  ModelSupplementSource,
  AgentSessionPendingMessage,
  ModelServiceVersionCommit,
  ReviewRuleInput,
  RuleProposal,
  RuleProposalInput,
  RuleProposalSourceInput,
  StageScope,
  Store,
} from "./index.ts";

export const MIN_REPORT_SEVERITIES: readonly Severity[] = ["P0", "P1", "P2"];

/** 库里读回的一格最低报告等级。认不出即当作没配。 */
export function readMinReportSeverity(stored: string | undefined): Severity | null {
  return MIN_REPORT_SEVERITIES.includes(stored as Severity) ? (stored as Severity) : null;
}

/**
 * 一行 `review_run.trigger_source` 读成触发来源(issue #312)。`openStore` 已经把旧行回填
 * 过,认不出的一格仍读作投递——一行坏数据不该让整张时间线读不出来。
 */
export function readTriggerSource(stored: unknown): ReviewTriggerSource {
  return stored === "panel" || stored === "scheduled" ? stored : "delivery";
}

/** 「同一个 pull request 名下的历史 finding」。回填与自动处置都按它限定范围。 */
export const PULL_REQUEST_SCOPE = `run_id IN (SELECT id FROM review_run
                                        WHERE owner = ? AND repo = ? AND pull_number = ?)`;

/**
 * 还能自动处置的那些行(ADR 0016):当前处置是 unknown 或未处置,且从来没有被显式
 * 处置过。`disposed_at` 就是那个标记——面板处置写它,自动处置也写它(处置人留空),
 * 于是一行至多被自动处置一次:人把「已修复」改回未处置之后,自动规则不再碰它。
 */
export const AUTO_DISPOSABLE = "disposition IN ('unknown', 'unresolved') AND disposed_at IS NULL";

/**
 * 一行 finding 属于哪条 Finding Identity(CONTEXT.md Finding Identity,ADR 0030)。
 *
 * 键是承载它的那条 Forge 评论:处置写在评论上(ADR 0006),折叠到历史评论的本轮报出
 * 记的就是那条评论的 id,同一条评论名下的各轮次行因此正是同一条 Finding。不按「文件 +
 * 指纹」:同一处未改动代码上可以有两个不同的问题(issue #307),它们指纹相同而各有各的
 * 评论,按指纹归并会把两条压成一条,一条的驳回于是盖住另一条。
 *
 * 没有评论载体的行(review 正文那一档,以及平台读不回评论标识的那一轮)退回「文件 +
 * 指纹」,指纹也算不出时用自己的 id 兜底成独立键——它们本来就没有可分辨的载体,口径
 * 与这一票之前逐字一致。
 */
export function identityKey(prefix: string): string {
  return `COALESCE(${prefix}comment_id,
                   ${prefix}file || chr(10) || COALESCE(${prefix}fingerprint, 'row:' || ${prefix}id))`;
}

/**
 * 回填一条更新时它该落在哪些行上(issue #307)。绑三个参数:承载它的评论 id、文件、指纹。
 *
 * 先认评论:一条评论的 resolve 状态只说得了它自己承载的那条 Finding,同一处的另一条
 * Identity 各有各的评论(ADR 0030)。没有评论载体的行才退回「文件 + 指纹」,与 `identityKey`
 * 的兜底同一档——那些行本来就没有可分辨的载体。评论 id 传 NULL 时前一档恒不成立,整个
 * 条件就只剩后一档,正文锚点那一档因此走同一句 SQL。
 */
export const BACKFILL_TARGET =
  "(comment_id = ? OR (comment_id IS NULL AND file = ? AND fingerprint = ?))";

/**
 * 统计口径的共同前半段:`src` 把参与统计的 finding 行摊平(fallback 在最内层就排除),
 * `identity` 按 Finding Identity 折叠(键见 `identityKey`)。处置率与参与条数共用它,
 * 两个数才落在同一批 Identity 上;补的那半段各自接在后面。
 */
export const STATS_IDENTITY_CTE = `WITH src AS (
             SELECT f.id, f.category, f.file, f.disposition,
                    ${identityKey("f.")} AS fp,
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

/**
 * 一组 owner/repo 对的过滤条件(CONTEXT.md 仓库分配)。省略即不限,空数组即一个都不
 * 给;`prefix` 是这两列在查询里的表别名前缀。
 */
export function repoPairCondition(
  pairs: readonly { owner: string; repo: string }[] | undefined,
  prefix: string,
): { sql: string; params: string[] } {
  if (pairs === undefined) return { sql: "true", params: [] };
  if (pairs.length === 0) return { sql: "false", params: [] };
  return {
    sql: `(${pairs.map(() => `(${prefix}owner = ? AND ${prefix}repo = ?)`).join(" OR ")})`,
    params: pairs.flatMap((pair) => [pair.owner, pair.repo]),
  };
}

export function usageColumns(usage: ReviewerUsage | undefined): (number | null)[] {
  if (usage === undefined) return Array.from({ length: 5 }, () => null);
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
  ];
}

/** 一行 finding_attribution 读成面板要的归属(issue #266)。两段的 NULL 原样透出。 */
export function recordedAttribution(row: Record<string, unknown>): RecordedFindingAttribution {
  return {
    model: String(row["model"]),
    severity: String(row["severity"]) as Severity,
    category: String(row["category"]) as Category,
    description: String(row["description"]),
    impact: row["impact"] === null ? null : String(row["impact"]),
    suggestion: row["suggestion"] === null ? null : String(row["suggestion"]),
  };
}

/**
 * 一条 Finding 的代表段(issue #278):正文那一份标题、问题、影响与建议。
 *
 * `impact` 与 `suggestion` 两列同为 NULL 即升级前落的行——那时只有前两段落库,而它们
 * 取的是严重度最高那条归属,与现在的规则不同。这一档按现在的规则从归属现算:取描述最长
 * 的那条,四段同出一条归属。四段一起换,不只补后两段:混着两条归属的说法会拼出一份没人
 * 说过的正文。没有归属可算的(升级前连归属行都没有)照原样透出前两段,后两段为 null。
 *
 * 归属表不存标题,所以存量 NULL 行的标题只能沿用 finding 行上按旧规则落的那一份:标题
 * 与其余三段因此可能来自两条归属。这是升级前数据的已知局限,不回填。
 */
export function representativeSegment(
  row: Record<string, unknown>,
  attributions: readonly RecordedFindingAttribution[],
): { title: string; description: string; impact: string | null; suggestion: string | null } {
  const stored = {
    title: row["title"] === null || row["title"] === undefined ? "" : String(row["title"]),
    description: String(row["description"]),
    impact: row["impact"] === null ? null : String(row["impact"]),
    suggestion: row["suggestion"] === null ? null : String(row["suggestion"]),
  };
  if (stored.impact !== null || stored.suggestion !== null) return stored;
  const longest = attributions.reduce<RecordedFindingAttribution | undefined>(
    (best, said) =>
      best === undefined || said.description.length > best.description.length ? said : best,
    undefined,
  );
  if (longest === undefined) return stored;
  return {
    // 升级前的归属行不存标题,标题只在 finding 行上:那一份沿用。
    title: stored.title,
    description: longest.description,
    impact: longest.impact,
    suggestion: longest.suggestion,
  };
}

export function carriedAttribution(row: Record<string, unknown>): CarriedAttribution {
  return {
    model: String(row["model"]),
    runId: Number(row["run_id"]),
    headSha: String(row["head_sha"]),
    description: String(row["description"]),
    impact: row["impact"] === null ? null : String(row["impact"]),
    suggestion: row["suggestion"] === null ? null : String(row["suggestion"]),
  };
}

/** 这几个会话底下的全部行。调用方自己开事务:两处都要与删会话行本身同进同退。 */
export async function deleteAgentSessionRows(db: Db, sessionIds: readonly number[]): Promise<void> {
  for (const table of AGENT_SESSION_CHILD_TABLES) {
    const statement = db.prepare(`DELETE FROM ${table} WHERE session_id = ?`);
    for (const sessionId of sessionIds) await statement.run(sessionId);
  }
}

/** 这个会话落库的排队消息,按当初写下的顺序。只读与「取出即删」共用这一句查询。 */
export async function agentSessionPendingMessages(
  db: Db,
  sessionId: number,
): Promise<AgentSessionPendingMessage[]> {
  return (await db
    .prepare(
      `SELECT mode, text, images FROM agent_session_pending_message
        WHERE session_id = ? ORDER BY seq`,
    )
    .all(sessionId))
    .map((row) => ({
      mode: String(row["mode"]),
      text: String(row["text"]),
      ...(typeof row["images"] === "string" ? { images: row["images"] } : {}),
    }));
}

/** 这些 Finding 各自承接来的历史说法(issue #267),按 finding id 归组、段内按落库顺序。 */
export async function carriedByFinding(
  db: Db,
  findingSql: string,
  params: readonly (string | number)[],
): Promise<Map<number, CarriedAttribution[]>> {
  const rows = await db
    .prepare(
      `SELECT c.finding_id AS finding_id, c.model AS model, c.run_id AS run_id,
              c.description AS description, c.impact AS impact, c.suggestion AS suggestion,
              origin.head_sha AS head_sha
         FROM finding_carried_attribution c
         JOIN review_run origin ON origin.id = c.run_id
        WHERE c.finding_id IN (${findingSql})
        ORDER BY c.finding_id, c.position`,
    )
    .all(...params);
  const grouped = Map.groupBy(rows, (row) => Number(row["finding_id"]));
  return new Map([...grouped].map(([id, group]) => [id, group.map(carriedAttribution)]));
}

export function recordedUsage(row: Record<string, unknown>): ReviewerUsage | undefined {
  if (row["total_tokens"] === null || row["total_tokens"] === undefined) return undefined;
  return {
    inputTokens: Number(row["input_tokens"] ?? 0),
    outputTokens: Number(row["output_tokens"] ?? 0),
    cacheReadTokens: Number(row["cache_read_tokens"] ?? 0),
    cacheWriteTokens: Number(row["cache_write_tokens"] ?? 0),
    totalTokens: Number(row["total_tokens"]),
  };
}

export function agentSessionEntry(row: Record<string, unknown>): AgentSessionEntryRecord {
  return {
    sessionId: Number(row["session_id"]),
    seq: Number(row["seq"]),
    type: String(row["type"]),
    at: String(row["at"]),
    entry: JSON.parse(String(row["entry"])) as unknown,
    usage: {
      inputTokens: Number(row["input_tokens"]),
      outputTokens: Number(row["output_tokens"]),
      cacheReadTokens: Number(row["cache_read_tokens"]),
      cacheWriteTokens: Number(row["cache_write_tokens"]),
      totalTokens: Number(row["total_tokens"]),
    },
  };
}

export function stageScope(scope: StageScope): [string, (string | number)[]] {
  return "rangeReviewId" in scope
    ? ["run.range_review_id = ?", [scope.rangeReviewId]]
    : [
        `run.owner = ? AND run.repo = ? AND run.pull_number = ?
           AND run.range_review_id IS NULL`,
        [scope.owner, scope.repo, scope.pullNumber],
      ];
}

/**
 * 一行轮次 → 它所在阶段的标识(issue #296)。`run` 这个别名下的一行,`range:` 与 `pr:` 两个
 * 字面形状与评审记录那一侧逐字相同;两处查询共用,抄第二遍就会在其中一处漂移。轮次是
 * LEFT JOIN 进来的那一档回 NULL。
 */
export const STAGE_ID_FROM_RUN = `CASE
                             WHEN run.id IS NULL THEN NULL
                             WHEN run.range_review_id IS NOT NULL
                               THEN 'range:' || run.range_review_id
                             ELSE 'pr:' || run.owner || '/' || run.repo || '/' || run.pull_number
                           END`;

/**
 * 各域方法拿到的装配件。`openStore` 建一份传给每个域的工厂:
 *
 * ```ts
 * export function runsMethods(ctx: StoreContext): Pick<Store, "startRun" | …> { … }
 * ```
 *
 * `index.ts` 里接进去的是一行 `...runsMethods(ctx)`,六票各改各的那一行。
 *
 * - `db` 是旧 SQL 的通道(`store/pg.ts` 的方言 shim),`orm` 是 Drizzle;两者在事务里落在
 *   同一条连接上,混用没有问题。
 * - `transaction(mode, async tx => …)` 见 `store/pg.ts`。
 * - `store()` 惰性取整份 store:方法之间互相调用时用它(装配那一刻 store 还没拼好)。
 * - 其余是开库时建出来的共用闭包。**只被一个域用到的那些**(知识域的 13 个、仓库域的 6 个、
 *   阶段域的 1 个)也在这里:它们本来长在 `openStore` 里,留在那儿会让六票都去改同一段。
 *   哪一票把自己那一域搬走,就顺手把它那几个也搬走。
 */
export type StoreContext = StoreHelpers & {
  db: Db;
  orm: Orm;
  transaction<T>(mode: TransactionMode, run: (tx: StoreTransaction) => Promise<T>): Promise<T>;
  store: () => Store;
};

export type StoreHelpers = ReturnType<typeof storeHelpers>;

/** 开库时建出这一批闭包。它们闭在 `db` 上,因此不能是模块级函数。 */
/**
 * 挂在一个 Agent 会话上的那几张表(issue #333、#336)。删会话与删产品级联都照这一份
 * 清单删:两处当初各写一份逐字相同的清单,新增一张挂会话的表会漏掉一处。
 */
export const AGENT_SESSION_CHILD_TABLES = [
  "agent_session_entry",
  "agent_session_message",
  "agent_session_image",
  "agent_session_pending_message",
] as const;

/**
 * 模型服务目标(地址 + 协议)的指纹。手动补录绑定它:只轮换凭据时可沿用,地址或协议
 * 变了就是另一个目标,补录必须逐项重录。
 */
export function modelServiceTargetFingerprint(baseUrl: string, api: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  return createHash("sha256")
    .update(normalizedBaseUrl, "utf8")
    .update("\0")
    .update(api.trim(), "utf8")
    .digest("hex");
}

/**
 * 内置模型服务一个版本绑定的调用目标(ADR 0027):去重、稳定排序后的 api/baseUrl 集合,
 * 每一项带自己的单目标指纹——模型补录绑的是其中一项,可用性判定按指纹对得上。
 */
export type ModelServiceBoundTarget = {
  api: string;
  baseUrl: string;
  fingerprint: string;
};

/** 去重(按协议加去掉尾部斜杠的地址)并按协议、地址稳定排序,顺序不随目录排序变。 */
export function normalizeModelServiceTargets(
  targets: readonly { api: string; baseUrl: string }[],
): ModelServiceBoundTarget[] {
  const byKey = new Map<string, ModelServiceBoundTarget>();
  for (const target of targets) {
    const api = target.api.trim();
    // 地址按与 `distinctBuiltinTargets` 同一条规则归一(评审复核):两处规则不同时,同一个
    // 目标会在集合指纹与逐模型解析里算出两个不同的键。
    const baseUrl = normalizeModelServiceBaseUrl(target.baseUrl);
    if (api === "" || baseUrl === undefined) continue;
    const key = `${api}\0${baseUrl}`;
    if (!byKey.has(key)) {
      byKey.set(key, { api, baseUrl, fingerprint: modelServiceTargetFingerprint(baseUrl, api) });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.api < right.api ? -1 : left.api > right.api ? 1 : left.baseUrl < right.baseUrl ? -1 : left.baseUrl > right.baseUrl ? 1 : 0,
  );
}

/**
 * 目标集合的指纹:只有一项时就是那一项的单目标指纹——升级前只绑一个目标的内置版本
 * 与升级后单协议 provider 的版本因此指纹一致,不会仅因为记法变化而被判成目标已变;
 * 多项时对排序后的各项指纹再取一次摘要。空集合没有指纹。
 */
export function modelServiceTargetSetFingerprint(
  targets: readonly { api: string; baseUrl: string }[],
): string | null {
  const normalized = normalizeModelServiceTargets(targets);
  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0]!.fingerprint;
  const hash = createHash("sha256");
  for (const target of normalized) hash.update(target.fingerprint, "utf8").update("\n");
  return hash.digest("hex");
}

/**
 * 绑了目标集合的版本里,一个模型解析到集合里的哪一个目标(ADR 0027)。目录行按自己保存的
 * api/baseUrl 对集合(来源即 Pi 目录);模型补录按指纹对集合;目录行没带目标、以及迁移保留
 * 这两种不知道自己目标的来源,只在集合恰好一项时沿用它。目录行对不上时再看补录——补录是
 * 显式验证过的。解析不到即这个模型的目标未经验证,不猜。`availableModel` 的 SQL 是同一条
 * 规则的另一份写法,改一处要同时改另一处。
 */
export function boundTargetForModel(
  targets: readonly ModelServiceBoundTarget[],
  automatic: { fields: { api?: string; baseUrl?: string } } | undefined,
  supplement: { source: ModelSupplementSource; targetFingerprint: string | null } | undefined,
): { target: ModelServiceBoundTarget; source: "pi-catalog" | "service-target" } | undefined {
  const sole = targets.length === 1 ? targets[0] : undefined;
  if (automatic !== undefined) {
    const api = automatic.fields.api?.trim() ?? "";
    const baseUrl = automatic.fields.baseUrl?.trim().replace(/\/+$/, "") ?? "";
    if (api !== "" && baseUrl !== "") {
      const own = targets.find((target) => target.api === api && target.baseUrl === baseUrl);
      if (own !== undefined) return { target: own, source: "pi-catalog" };
    } else if (sole !== undefined) {
      return { target: sole, source: "service-target" };
    }
  }
  if (supplement === undefined) return undefined;
  if (supplement.source === "migration-retention") {
    return sole === undefined ? undefined : { target: sole, source: "service-target" };
  }
  const bound = targets.find((target) => target.fingerprint === supplement.targetFingerprint);
  return bound === undefined ? undefined : { target: bound, source: "service-target" };
}

/**
 * 一条提案采纳前算得出来的全部东西:队列里那一条、实际要落的内容、以及修改与废止的
 * 目标条目此刻的出处。单条与批量共用它,判据因此只有一份;算不出来即这一条采纳不了。
 */
export type PlannedAcceptance = {
  queued: RuleProposal;
  content: ReviewRuleInput;
  targetOrigin: string | undefined;
};

export function storeHelpers(base: {
  db: Db;
  orm: Orm;
  transaction<T>(mode: TransactionMode, run: (tx: StoreTransaction) => Promise<T>): Promise<T>;
  store: () => Store;
}) {
  const { db, transaction } = base;
  // 惰性取 store:`storeHelpers` 跑在装配那一刻,那时 store 还没拼好。
  const store = (): Store => base.store();
  const parseStoredReviewers = (reviewersJson: string, context: string): ReviewerSpec[] =>
    assertReviewerSpecs(JSON.parse(reviewersJson), context, { allowEmpty: true });

  /**
   * 读库里存着的一处辅助模型引用(issue #303)。写入口已经校验过形状,读回认不出的一份
   * 即当作没设——一行坏数据不该让知识任务与合并 agent 整个跑不起来,退路照旧走组合第一个。
   */
  const parseAuxiliaryModel = (json: string | null): ReviewerSpec | null => {
    if (json === null) return null;
    try {
      const value = JSON.parse(json) as ReviewerSpec;
      return typeof value?.provider === "string" && typeof value?.model === "string" ? value : null;
    } catch {
      return null;
    }
  };

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
            AND state.enabled = false
       )
       AND (
         EXISTS (
           SELECT 1 FROM model_directory_model automatic
            WHERE automatic.provider = service.provider
              AND automatic.model = ?
              AND automatic.service_version = service.version
              -- 绑了目标集合的内置版本(ADR 0027):目录行按自己的 api/baseUrl 对集合,
              -- 对不上的行(刷新拉进来、还没经验证的目标)不算可用。
              AND (
                service.targets_json IS NULL
                OR (automatic.api IS NOT NULL AND automatic.base_url IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements(service.targets_json) bound
                       WHERE bound.value->>'api' = automatic.api
                         AND bound.value->>'baseUrl' = rtrim(automatic.base_url, '/')
                    ))
                OR ((automatic.api IS NULL OR automatic.base_url IS NULL)
                    AND jsonb_array_length(service.targets_json) = 1)
              )
         )
         OR EXISTS (
           SELECT 1 FROM model_supplement supplement
            WHERE supplement.provider = service.provider
              AND supplement.model = ?
              AND (
                (supplement.source = 'migration-retention'
                  AND (service.targets_json IS NULL
                       OR jsonb_array_length(service.targets_json) = 1))
                OR (supplement.source = 'manual'
                    AND (
                      (service.targets_json IS NULL
                        AND supplement.target_fingerprint = service.target_fingerprint)
                      OR EXISTS (
                        SELECT 1 FROM jsonb_array_elements(service.targets_json) bound
                         WHERE bound.value->>'fingerprint' = supplement.target_fingerprint
                      )
                    ))
              )
         )
       )
  `);
  const specAvailable = async (spec: ReviewerSpec): Promise<boolean> =>
    (await availableModel.get(spec.provider, spec.model, spec.model, spec.model)) !== undefined;
  const modelCombinationAvailable = async (reviewersJson: string, context: string): Promise<boolean> => {
    const reviewers = parseStoredReviewers(reviewersJson, context);
    return reviewers.length > 0 && reviewers.every(specAvailable);
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
  const recordSupportsCurrentReferences = async (record: ModelServiceVersionCommit): Promise<boolean> => {
    const references = new Set<string>();
    for (const model of await referencedModels(record.provider)) {
      const row = await availableModel.get(record.provider, model, model, model);
      if (row !== undefined) references.add(model);
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

  const repoExists = async (repoId: number): Promise<boolean> =>
    (await db.prepare("SELECT 1 FROM repo WHERE id = ?").get(repoId)) !== undefined;

  /**
   * 这条知识条目还生效吗:生效即回它的出处与两型之一(改一条要沿用出处、废止一条要
   * 说得出它是规则还是事实),否则回 undefined。
   */
  const activeRule = async (
    repoId: number,
    ruleId: number,
  ): Promise<{ origin: string; type: KnowledgeType } | undefined> => {
    const row = (await db
      .prepare(
        "SELECT origin, type FROM review_rule WHERE id = ? AND repo_id = ? AND retired_version IS NULL",
      )
      .get(ruleId, repoId));
    return row === undefined
      ? undefined
      : { origin: String(row["origin"]), type: String(row["type"]) as KnowledgeType };
  };

  const insertReviewRule = async (
    repoId: number,
    input: ReviewRuleInput,
    origin: string,
    version: number,
    at: string,
  ): Promise<void> => {
    // layer 是退役的层标签,列还在(NOT NULL)但没人读:新行一律写空串。
    (await db.prepare(
      `INSERT INTO review_rule
         (repo_id, type, scope, statement, layer, state, origin, effective_version, retired_version, created_at)
       VALUES (?, ?, ?, ?, '', 'active', ?, ?, NULL, ?)`,
    ).run(repoId, input.type, input.scope, input.statement, origin, version, at));
  };

  /**
   * 这个仓库此刻有没有规则 agent 任务在跑(issue #284)。「同仓库同时只跑一个」跨基点
   * 探索与知识整理两张表:两者都要读这个仓库的知识集与队列,同时跑会互相看着对方的
   * 中间态。判据只有这一份,两个发起口共用。
   */
  const ruleTaskRunning = async (repoId: number): Promise<boolean> =>
    (await db
      .prepare(
        `SELECT 1 FROM rule_exploration WHERE repo_id = ? AND state = 'running'
         UNION ALL
         SELECT 1 FROM rule_consolidation WHERE repo_id = ? AND state = 'running'`,
      )
      .get(repoId, repoId)) !== undefined;

  const completeRuleExploration = async (repoId: number, at: string): Promise<void> => {
    (await db.prepare(
      "UPDATE rule_exploration SET state = 'completed', failure = NULL, finished_at = ? WHERE repo_id = ?",
    ).run(at, repoId));
  };

  /** 往一条提案上追加一条出处附注(issue #281)。入队与之后的每一次来源共用它。 */
  const insertRuleProposalSource = async (
    proposalId: number,
    source: RuleProposalSourceInput,
    at: string,
  ): Promise<void> => {
    (await db.prepare(
      `INSERT INTO rule_proposal_source
         (proposal_id, origin, note, evidence, finding_id, trace_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposalId,
      source.origin,
      source.note,
      source.evidence,
      source.findingId,
      source.traceTaskId,
      at,
    ));
  };

  const insertRuleProposal = async (repoId: number, input: RuleProposalInput, at: string): Promise<number> => {
    const inserted = (await db
      .prepare(
        `INSERT INTO rule_proposal
           (repo_id, type, change, target_rule_ids, scope, statement, layer, state, created_at,
            decided_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 'pending', ?, NULL)`,
      )
      .run(
        repoId,
        input.type,
        input.change,
        JSON.stringify(input.targetRuleIds),
        input.scope,
        input.statement,
        at,
      ));
    const proposalId = Number(inserted.lastInsertRowid);
    for (const source of input.sources) (await insertRuleProposalSource(proposalId, source, at));
    return proposalId;
  };

  /** 这条提案还等着裁决吗:是即回它自己,否则回 undefined(裁决过的裁不了第二次)。 */
  const pendingProposal = async (repoId: number, proposalId: number): Promise<RuleProposal | undefined> =>
    (await store().getRuleProposals(repoId))
      .find((row) => row.id === proposalId && row.state === "pending");

  const plannedAcceptance = async (
    repoId: number,
    proposalId: number,
  ): Promise<PlannedAcceptance | undefined> => {
    const queued = (await pendingProposal(repoId, proposalId));
    if (queued === undefined) return undefined;
    const content = {
      type: queued.type,
      scope: queued.scope,
      statement: queued.statement,
    };
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
      (await insertReviewRule(repoId, content, queued.sources[0]!.origin, version, at));
    } else {
      for (const targetId of queued.targetRuleIds) (await retireRuleRow(targetId, version));
      // 修改沿用旧行的出处:改文字不改变这条条目当初从哪来(issue #203 同一条口径)。
      if (queued.change === "modify") {
        (await insertReviewRule(repoId, content, targetOrigin!, version, at));
      }
      // 合并的那一条是新写的一句,不是哪一条目标的延续:出处与新增同一条口径,取提案
      // 第一条附注的来源(issue #282)。几条目标的出处各不相同时也没有一份可沿用。
      if (queued.change === "merge") {
        (await insertReviewRule(repoId, content, queued.sources[0]!.origin, version, at));
      }
    }
    (await db.prepare(
      `UPDATE rule_proposal
          SET state = 'accepted', type = ?, scope = ?, statement = ?, decided_at = ?
        WHERE id = ?`,
    ).run(content.type, content.scope, content.statement, at, queued.id));
  };

  const rejectProposalRow = async (proposalId: number, at: string): Promise<void> => {
    (await db.prepare("UPDATE rule_proposal SET state = 'rejected', decided_at = ? WHERE id = ?").run(
      at,
      proposalId,
    ));
  };

  const retireRuleRow = async (ruleId: number, version: number): Promise<void> => {
    (await db.prepare(
      "UPDATE review_rule SET state = 'retired', retired_version = ? WHERE id = ?",
    ).run(version, ruleId));
  };

  /**
   * 推进一版知识集版本,在同一个写事务里跑规则那几行改动。知识集版本与它带来的规则
   * 变更必须一起落:落了版本没落规则,那一版的快照就是错的。
   */
  const inRuleSetVersion = async <T>(
    repoId: number,
    write: (version: number, at: string) => Promise<T>,
  ): Promise<T> => {
    return transaction("deferred", async () => {
      // 先锁住这个仓库那一行(ADR 0036):版本号是 `MAX + 1`,不锁的话两次并发的确认会算出
      // 同一个号,主键当场撞上。SQLite 那一版靠的是单写者锁。
      (await db.prepare("SELECT 1 FROM repo WHERE id = ? FOR UPDATE").get(repoId));
      const current = (await db
        .prepare("SELECT MAX(version) AS version FROM rule_set_version WHERE repo_id = ?")
        .get(repoId))?.["version"];
      const version = (current === null || current === undefined ? 0 : Number(current)) + 1;
      const at = new Date().toISOString();
      (await db.prepare(
        "INSERT INTO rule_set_version (repo_id, version, created_at) VALUES (?, ?, ?)",
      ).run(repoId, version, at));
      const result = write(version, at);
      return result;
    });
  };
  return {
    parseStoredReviewers,
    parseAuxiliaryModel,
    availableModel,
    specAvailable,
    modelCombinationAvailable,
    auxiliaryModelAvailable,
    referencedModels,
    recordSupportsCurrentReferences,
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
  };
}
