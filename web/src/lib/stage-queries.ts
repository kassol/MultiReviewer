/**
 * 阶段详情与阶段汇总两份查询的键、请求与保鲜时间(issue #439)。
 *
 * 它们从 `stage-detail.tsx` / `stage-summary.tsx` 搬到这里,是因为**路由要在页面代码到齐
 * 之前就把这两个请求发出去**:阶段详情页按路由懒加载,组件挂载得等它那一批 chunk 到齐,
 * 两个接口原先因此串在 chunk 之后(冷加载实测 660 / 684 ms)。路由引不得那两个页面模块
 * ——静态引一下,整页代码就回到入口包里,懒加载白做;这个模块不含 JSX、只引 `api.ts`,
 * 引它不带任何东西进来。预取与组件读的是**同一份工厂**给出的键与请求,组件挂载时因此
 * 命中同一份缓存,而不是各发各的。
 */
import { fetchJson } from "../api.ts";

import type { StageSummary } from "../../../src/contracts/stage-summary.ts";

/**
 * 一个审查阶段(CONTEXT.md 审查阶段):范围审查那条按它自己的 id 取,pull request
 * 那条按 owner / repo / 序号取。两条链路读同一个接口、显示成同一个样子。
 */
export type StageScope =
  | { kind: "range-review"; rangeReviewId: number }
  | { kind: "pull-request"; owner: string; repo: string; pullNumber: number };

/**
 * 阶段详情地址上的那个标识(issue #175),与 `GET /stages` 行上的 `stageId` 同一格式:
 * 一个阶段在列表、地址与接口三处是同一个名字。
 */
export function stageIdOf(scope: StageScope): string {
  return scope.kind === "range-review"
    ? `range:${scope.rangeReviewId}`
    : `pr:${scope.owner}/${scope.repo}/${scope.pullNumber}`;
}

/**
 * 阶段标识反推它是哪一片(issue #439)。汇总要取哪一片由标识本身说得出,不必等阶段详情
 * 返回那一行——两个请求因此可以并行发。
 *
 * 判据与服务端 `stageRowById` 逐条对齐,末尾同样拼回去比一次:`pr:o/r/007` 解析出的是
 * 7 号,那是另一个标识,服务端按查不到处理,这里也不该拿它去预取 7 号的汇总。认不出的
 * 标识回 null,那一次不预取,由阶段详情自己的 404 说明。
 */
export function scopeFromStageId(stageId: string): StageScope | null {
  let scope: StageScope;
  if (stageId.startsWith("range:")) {
    const rangeReviewId = Number(stageId.slice("range:".length));
    if (!Number.isSafeInteger(rangeReviewId) || rangeReviewId <= 0) return null;
    scope = { kind: "range-review", rangeReviewId };
  } else if (stageId.startsWith("pr:")) {
    const parts = stageId.slice("pr:".length).split("/");
    if (parts.length !== 3) return null;
    const pullNumber = Number(parts[2]);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) return null;
    scope = { kind: "pull-request", owner: parts[0]!, repo: parts[1]!, pullNumber };
  } else {
    return null;
  }
  return stageIdOf(scope) === stageId ? scope : null;
}

/** 这一片汇总的地址,与 `GET /stage-summary` 的入参对应。 */
export function scopePath(scope: StageScope): string {
  return scope.kind === "range-review"
    ? `/stage-summary?rangeReviewId=${scope.rangeReviewId}`
    : `/stage-summary?owner=${encodeURIComponent(scope.owner)}&repo=${encodeURIComponent(
        scope.repo,
      )}&pullNumber=${scope.pullNumber}`;
}

/**
 * 阶段汇总的查询键。首段固定是 `stage-summary`:行内处置成功后按这一段整片失效,
 * 处置完的那一条立刻从待处置里退出去(与轮次那两份查询同一个理由)。
 */
export function stageSummaryKey(scope: StageScope): (string | number)[] {
  return scope.kind === "range-review"
    ? ["stage-summary", "range-review", scope.rangeReviewId]
    : ["stage-summary", "pull-request", scope.owner, scope.repo, scope.pullNumber];
}

/**
 * 预取落地到组件挂载之间的保鲜时间。只为这一段路存在:预取先跑完、缓存里那一份立刻
 * 就算过期的话,组件挂载会再发一次,两个请求变成四个,预取等于没做。懒加载那几个
 * chunk 再慢也到不了这个数。失效(处置、重跑、推进)与续查(`refetchInterval`)都不看
 * 它,那两条路因此一格未变。
 */
const STAGE_QUERY_STALE_TIME = 30_000;

/** 阶段汇总:这个阶段此刻还剩什么没处置。预取与 `useStageSummary` 共用这一份。 */
export function stageSummaryQuery(scope: StageScope) {
  return {
    queryKey: stageSummaryKey(scope),
    queryFn: () => fetchJson<StageSummary>(scopePath(scope)),
    staleTime: STAGE_QUERY_STALE_TIME,
  };
}

/**
 * 阶段详情:评审记录里那一行加它的时间线。响应体由调用方给出——`rangeReview` 与
 * `minReportSeverity` 两格是服务端拼在契约之上的,类型留在阶段详情页那边;预取不读
 * 响应体,按默认的 `unknown` 拿就行。
 */
export function stageDetailQuery<T = unknown>(stageId: string) {
  return {
    queryKey: ["stage-detail", stageId],
    queryFn: () => fetchJson<T>(`/stages/${encodeURIComponent(stageId)}`),
    staleTime: STAGE_QUERY_STALE_TIME,
  };
}
