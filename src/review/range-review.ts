/**
 * 容器 PR 的命名与识别(ADR 0012)。
 *
 * 分支名与标题前缀是 MultiReviewer 与 Forge 之间唯一的约定:仓库里的人凭它认出这不是
 * 人的工作,webhook 凭它把容器 PR 自己产生的投递丢掉。发起端与投递端必须读同一份
 * 常量——两处各写一份,改一处就是「推进比较项跑了两轮」。
 */

/** 容器 PR 两条分支的固定前缀。 */
export const CONTAINER_BRANCH_PREFIX = "multireviewer/";

/** 容器 PR 标题的固定前缀。 */
export const CONTAINER_TITLE_PREFIX = "[MultiReviewer] 范围审查 ";

/**
 * 范围审查的状态。
 *
 * `failed` 是发起时 Forge 写失败留下的档:那样的记录没有容器 PR 可推进,也不该占住
 * 「同一 base 已有进行中」这条提醒,把人挡在重试之外。
 */
export type RangeReviewState = "in-progress" | "completed" | "failed";

/** 分支名由范围审查的 id 推出,库里另存一份供清理与展示读同一个事实。 */
export function containerBranches(rangeReviewId: number): { base: string; head: string } {
  return {
    base: `${CONTAINER_BRANCH_PREFIX}${rangeReviewId}-base`,
    head: `${CONTAINER_BRANCH_PREFIX}${rangeReviewId}-head`,
  };
}

/** 标题里的 sha 取前 7 位,与面板和 Forge 页面上短 sha 的写法一致。 */
const SHORT_SHA = 7;

export function containerPullRequestTitle(baseSha: string, comparisonSha: string): string {
  return (
    `${CONTAINER_TITLE_PREFIX}${baseSha.slice(0, SHORT_SHA)}..` +
    `${comparisonSha.slice(0, SHORT_SHA)}`
  );
}

/** 正文只有两句:这是什么、去哪操作。从 Forge 偶然点进来的人要知道别在这里评论。 */
export function containerPullRequestBody(panelUrl: string): string {
  return [
    "MultiReviewer 为一个范围审查自建的容器 pull request,只承载行内 Finding 与处置状态,永不合并。",
    "",
    `面板:${panelUrl}`,
  ].join("\n");
}

/** 分支名带前缀即容器 PR 的分支。payload 里读不到分支名时按「不是」处理。 */
export function isContainerBranch(branch: unknown): branch is string {
  return typeof branch === "string" && branch.startsWith(CONTAINER_BRANCH_PREFIX);
}
