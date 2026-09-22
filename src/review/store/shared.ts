/**
 * 各域共用的库层构件:跨域的 SQL 片段与行读法,加各域方法工厂拿到的那份装配件。
 *
 * 只被一个域用到的东西不在这里——它住在那一域自己的文件里(`store/<域>.ts`)。
 *
 * 这个文件**不引 `./index.ts` 的运行时值**(只 `import type`):两边互引运行时值会成环。
 */
import { createHash } from "node:crypto";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { assertReviewerSpecs, type ReviewerSpec } from "../../config.ts";
import { toIso } from "../schema/columns.ts";
import { finding, reviewRun } from "../schema/runs.ts";
import type {
  CarriedAttribution,
  Category,
  ReviewTriggerSource,
  Severity,
} from "../finding.ts";
import type { RecordedFindingAttribution } from "../../contracts/finding.ts";
import { normalizeModelServiceBaseUrl } from "../../reviewer/model-service-runtime.ts";
import type { Orm, StoreTransaction } from "./pg.ts";
export type { Orm } from "./pg.ts";
import type { ModelSupplementSource, StageScope, Store } from "./index.ts";

/**
 * 一张表在某条查询里的那几列。schema 里的列对象是这个形状,`alias(表, "别名")` 出来的
 * 也是——`sql` 模板里引它们渲染出的是带表限定的写法(`"run"."owner"`),列名因此不必
 * 在查询里手写。
 */
type Columns<K extends string> = Record<K, SQLWrapper>;

/**
 * 一列在 `UPDATE … SET (a, b) = (…)` 的目标列表里的写法。那个位置不收表限定的列名
 * (`"finding"."disposed_by"` 在 PostgreSQL 上是语法错),所以只能写名字——名字仍从列
 * 对象上取,不手打。
 */
export function columnName(column: { name: string }): SQLWrapper {
  return sql.identifier(column.name);
}

export const MIN_REPORT_SEVERITIES: readonly Severity[] = ["P0", "P1", "P2"];

/** 库里读回的一格最低报告等级。认不出即当作没配。 */
export function readMinReportSeverity(stored: string | undefined): Severity | null {
  return MIN_REPORT_SEVERITIES.includes(stored as Severity) ? (stored as Severity) : null;
}

/**
 * 一行 `review_run.trigger_source` 读成触发来源(issue #312)。认不出的一格读作投递——
 * 一行坏数据不该让整张时间线读不出来。
 */
export function readTriggerSource(stored: unknown): ReviewTriggerSource {
  return stored === "panel" || stored === "scheduled" ? stored : "delivery";
}

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
 *
 * `t` 是 finding 表在那条查询里的样子:不起别名就传 `finding`,起了别名传
 * `alias(finding, "f")`,渲染出来的列名跟着走。
 */
export function identityKey(t: Columns<"id" | "commentId" | "file" | "fingerprint">): SQL {
  return sql`COALESCE(${t.commentId},
                      ${t.file} || chr(10) || COALESCE(${t.fingerprint}, 'row:' || ${t.id}))`;
}

/** `STATS_IDENTITY_CTE` 里 finding 与 review_run 的别名。外层查的是它摊出来的 CTE,用不到。 */
const STATS_FINDING = alias(finding, "f");
const STATS_RUN = alias(reviewRun, "run");

/**
 * 统计口径的共同前半段:`src` 把参与统计的 finding 行摊平(fallback 在最内层就排除),
 * `identity` 按 Finding Identity 折叠(键见 `identityKey`)。处置率与参与条数共用它,
 * 两个数才落在同一批 Identity 上;补的那半段各自接在后面。
 *
 * `src` 与 `identity` 是 CTE 不是 schema 里的表,它们自己那几列因此只能写名字——外层
 * 查询引的也是这两个名字,`src s` / `identity i` 那两个别名同理。
 */
export const STATS_IDENTITY_CTE: SQL = sql`WITH src AS (
             SELECT ${STATS_FINDING.id}, ${STATS_FINDING.category}, ${STATS_FINDING.file},
                    ${STATS_FINDING.disposition},
                    ${identityKey(STATS_FINDING)} AS fp,
                    ${STATS_RUN.owner}, ${STATS_RUN.repo}, ${STATS_RUN.pullNumber},
                    ${STATS_RUN.startedAt},
                    CASE WHEN ${STATS_RUN.prState} = 'closed' THEN 1 ELSE 0 END AS closed
               FROM ${finding} ${STATS_FINDING}
               JOIN ${reviewRun} ${STATS_RUN} ON ${STATS_FINDING.runId} = ${STATS_RUN.id}
              WHERE ${STATS_FINDING.placement} = 'inline'
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

/**
 * 一个审查阶段的范围(CONTEXT.md 审查阶段):pull request 阶段是「owner + repo + pull number
 * 且不属于任何范围审查」的全部轮次,范围审查阶段是它名下的全部轮次。历史注入与阶段汇总读的
 * 是同一个阶段,判据因此只定这一次。
 *
 * `run` 是 `review_run` 在这条查询里的样子:不起别名就用默认的表本身,`sql` 模板里
 * `JOIN review_run run` 那种写法传 `alias(reviewRun, "run")`。
 */
export function stageScopeFilter(
  scope: StageScope,
  run: Columns<"rangeReviewId" | "owner" | "repo" | "pullNumber"> = reviewRun,
): SQL {
  return "rangeReviewId" in scope
    ? sql`${run.rangeReviewId} = ${scope.rangeReviewId}`
    : sql`${run.owner} = ${scope.owner} AND ${run.repo} = ${scope.repo}
            AND ${run.pullNumber} = ${scope.pullNumber} AND ${run.rangeReviewId} IS NULL`;
}

/**
 * 一组 owner/repo 对的过滤条件(CONTEXT.md 仓库分配)。省略即不限,空数组即一个都不给。
 * `owner` 与 `repo` 是这两列在查询里的引用:表的列对象,或者(CTE 那一档)一段写着
 * 它在 CTE 里叫什么的 `sql`。
 */
export function repoPairFilter(
  pairs: readonly { owner: string; repo: string }[] | undefined,
  owner: SQLWrapper,
  repo: SQLWrapper,
): SQL {
  if (pairs === undefined) return sql`true`;
  if (pairs.length === 0) return sql`false`;
  return sql`(${sql.join(
    pairs.map((pair) => sql`(${owner} = ${pair.owner} AND ${repo} = ${pair.repo})`),
    sql` OR `,
  )})`;
}

/**
 * 走 `orm.execute` 的原始查询取回来的一格时刻(为什么要归一见 `store/pg.ts`)。归一本身
 * 与列类型是同一份实现(`schema/columns.ts` 的 `toIso`),这里只多接一个 NULL。
 */
export function isoTime(value: string | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * 各域方法拿到的装配件。`openStore` 建一份传给每个域的工厂:
 *
 * ```ts
 * export function runsMethods(ctx: StoreContext): Pick<Store, "startRun" | …> { … }
 * ```
 *
 * `index.ts` 里接进去的是一行 `...runsMethods(ctx)`。
 *
 * - `orm` 是 Drizzle 的句柄,读写一律经它。
 * - `transaction(async tx => …)` 见 `store/pg.ts`。
 * - `store()` 惰性取整份 store:方法之间互相调用时用它(装配那一刻 store 还没拼好)。
 * - 其余是开库时建出来的共用闭包。
 */
export type StoreContext = StoreHelpers & {
  orm: Orm;
  transaction<T>(run: (tx: StoreTransaction) => Promise<T>): Promise<T>;
  store: () => Store;
};

export type StoreHelpers = ReturnType<typeof storeHelpers>;

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

export function storeHelpers() {
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

  return {
    parseStoredReviewers,
    parseAuxiliaryModel,
  };
}
