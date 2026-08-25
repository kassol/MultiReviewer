import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { CheckCircledIcon, CrossCircledIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { Callout, Dialog, Skeleton } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { DetailPanel } from "@/components/detail-panel";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localMinute } from "@/lib/time";

import { fetchJson } from "./api.ts";
import {
  AdvanceAction,
  CompleteAction,
  RANGE_REVIEWS_QUERY_KEY,
  type RangeReview,
} from "./range-review-actions.tsx";
import { RangeReviewLaunch } from "./range-review-launch.tsx";
import { runStatus, type RunItem } from "./runs.tsx";
import { loadPanelSession, pullRequestUrl } from "./session.ts";
import { StageRound, StageSummaryView } from "./stage-summary.tsx";

/** 一个范围审查审过的一个比较项,发起时那个也在内。按记录先后返回。 */
export type RangeReviewComparison = {
  id: number;
  sha: string;
  recordedBy: string;
  recordedAt: string;
};

const STATE_LABEL: Record<RangeReview["state"], { tone: StatusTone; label: string }> = {
  "in-progress": { tone: "running", label: "进行中" },
  completed: { tone: "success", label: "审查完成" },
  failed: { tone: "error", label: "发起失败" },
};

export function RangeReviewsPage({
  canCreate,
  canDispose,
}: {
  canCreate: boolean;
  /** 「评审 · 处置」同时管标记审查完成:那是这个阶段的处置结果封口(#152)。 */
  canDispose: boolean;
}) {
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const list = useQuery({
    queryKey: RANGE_REVIEWS_QUERY_KEY,
    queryFn: () => fetchJson<{ rangeReviews: RangeReview[] }>("/range-reviews"),
    /*
     * 发起之后第一轮 Review Run 在后台跑,列表里的容器 PR 序号与轮次都要等它。还有
     * 进行中的就每 10 秒续查,全都进终态即停——人最想看结果的正是这几分钟。
     */
    refetchInterval: (query) =>
      (query.state.data?.rangeReviews ?? []).some((item) => item.state === "in-progress")
        ? 10_000
        : false,
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  // 打开哪一条记在地址里:链接能指到具体一个阶段,浏览器后退键能收起详情。
  const navigate = useNavigate();
  const openedId = useRouterState({
    select: (state) => {
      const value = (state.location.search as { range?: unknown }).range;
      const id = typeof value === "number" ? value : Number(value);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
  });
  const setOpenedId = (id: number | null): void => {
    void navigate({
      to: "/range-reviews",
      search: (prev: Record<string, unknown>) => ({ ...prev, range: id ?? undefined }),
    });
  };

  const rangeReviews = list.data?.rangeReviews ?? [];
  const opened = rangeReviews.find((item) => item.id === openedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBody width="wide" className="min-h-0 flex-1 pb-4 sm:pb-4">
        <PageHeader
          title="范围审查"
          {...(list.isPending
            ? {}
            : {
                description: `${rangeReviews.length} 个 · ${
                  rangeReviews.filter((item) => item.state === "in-progress").length
                } 进行中`,
              })}
          actions={
            canCreate ? (
              <RangeReviewLaunch
                onLaunched={(text) => setFeedback({ text, isError: false })}
              />
            ) : undefined
          }
        />

        {feedback === null ? null : (
          <Callout.Root role={feedback.isError ? "alert" : "status"} color={feedback.isError ? "red" : "green"} size="1">
            <Callout.Icon>
              {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
            </Callout.Icon>
            <Callout.Text>{feedback.text}</Callout.Text>
          </Callout.Root>
        )}
        {list.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(list.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" aria-label="范围审查列表">
          {list.isPending ? (
            <div
              className="flex flex-col gap-2 overflow-hidden rounded-lg border border-card-line bg-surface p-2 shadow-card"
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">正在加载范围审查</span>
              {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-14" />)}
            </div>
          ) : rangeReviews.length === 0 ? (
            <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
              <EmptyState
                title="还没有范围审查"
                titleAs="h2"
                description={
                  canCreate
                    ? "选一个已注册仓库，填标题、base commit 与比较项即可发起，不需要仓库里存在 pull request。"
                    : "发起范围审查需要「评审 · 发起」权限，请联系系统管理员。"
                }
                action={
                  canCreate ? undefined : (
                    <Button variant="outline" color="gray" size={{ initial: "4", sm: "1" }} asChild>
                      <Link to="/runs">去评审记录</Link>
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
              {rangeReviews.map((item) => (
                <MasterListItem
                  key={item.id}
                  selected={item.id === openedId}
                  onClick={() => setOpenedId(item.id)}
                  aria-haspopup="dialog"
                  className="group flex items-center gap-3 border-t border-line px-5 py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    {/* 名字是发起时填的标题,升级前的旧记录没有,显示它自己的编号。 */}
                    <span className="truncate text-lg font-semibold group-data-[selected=true]:font-bold">
                      {item.title ?? `#${item.id}`}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-1.5 text-base font-normal text-text-muted">
                      <span className="break-all">{item.owner}/{item.repo}</span>
                      <span aria-hidden>·</span>
                      <CommitChip sha={item.baseSha} />
                      <span aria-hidden>..</span>
                      <CommitChip sha={item.comparisonSha} />
                      <span aria-hidden>·</span>
                      <span className="break-all">{item.createdBy}</span>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{localMinute(item.createdAt)}</span>
                    </span>
                  </span>
                  <span className="shrink-0">
                    <StatusBadge tone={STATE_LABEL[item.state].tone}>
                      {STATE_LABEL[item.state].label}
                    </StatusBadge>
                  </span>
                </MasterListItem>
              ))}
            </div>
          )}
        </div>
      </PageBody>

      {opened === null ? null : (
        <RangeReviewDetailPanel
          rangeReview={opened}
          canCreate={canCreate}
          canDispose={canDispose}
          containerUrl={
            session.data === undefined ||
            session.data === null ||
            opened.containerPullNumber === null
              ? null
              : pullRequestUrl(session.data, {
                  owner: opened.owner,
                  repo: opened.repo,
                  pullNumber: opened.containerPullNumber,
                })
          }
          onClose={() => setOpenedId(null)}
        />
      )}
    </div>
  );
}

/**
 * 详情面板:base 与当前比较项,加这个阶段按 Finding Identity 汇总的主视图(issue
 * #168)。轮次降为时间线,挂在推出它的那个比较项下面。
 *
 * 与评审记录页同一个形态——主从列表的详情浮在列表上,列表仍然露出来,「我是从哪一条
 * 点进来的」这个上下文不丢。宽度取 wide 那一档:这里装的是 Finding 卡片、筛选与行内
 * 处置,464px 里每张卡片都要折成好几行。
 */
function RangeReviewDetailPanel({
  rangeReview,
  canCreate,
  canDispose,
  containerUrl,
  onClose,
}: {
  rangeReview: RangeReview;
  /** 有「评审 · 发起」权限才出现推进入口。 */
  canCreate: boolean;
  /** 有「评审 · 处置」权限才出现审查完成入口。 */
  canDispose: boolean;
  /** 容器 PR 的地址;没有 Forge 基址或还没建出来时是 null,那一格不渲染。 */
  containerUrl: string | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ["range-review", rangeReview.id],
    queryFn: () =>
      fetchJson<{
        rangeReview: RangeReview;
        comparisons: RangeReviewComparison[];
        runs: RunItem[];
      }>(`/range-reviews/${rangeReview.id}`),
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((run) => run.finishedAt === null) ? 10_000 : false,
  });
  const runs = detail.data?.runs ?? [];
  // 最近推的排在最前,与轮次同序;一个比较项的轮次按 head 归到它名下。
  const comparisons = [...(detail.data?.comparisons ?? [])].reverse();
  const status = STATE_LABEL[rangeReview.state];
  // 已完成与发起失败的都没有可推进的容器 PR,那两档不出现入口。
  const canAdvance = canCreate && rangeReview.state === "in-progress";
  const canComplete = canDispose && rangeReview.state === "in-progress";

  return (
    <DetailPanel
      onClose={onClose}
      header={
        <>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <Dialog.Title className="!mb-0 min-w-0 !text-3xl !font-extrabold !tracking-[-0.02em] break-all">
            {rangeReview.title ?? `#${rangeReview.id}`}
          </Dialog.Title>
          <div className="flex flex-wrap items-center gap-1.5 text-base text-text-muted">
            <span className="break-all">{rangeReview.owner}/{rangeReview.repo}</span>
            <span aria-hidden>·</span>
            <span className="break-all">{rangeReview.createdBy}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{localMinute(rangeReview.createdAt)}</span>
          </div>
        </>
      }
      footer={
        containerUrl === null && !canAdvance && !canComplete ? null : (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-overlay-line px-6 py-3.5">
            {/* 处置在评审记录的详情面板行内做,这一格留给这个阶段自己的三个动作。 */}
            {canComplete ? <CompleteAction rangeReview={rangeReview} /> : null}
            {containerUrl === null ? null : (
              <Button asChild variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
                <a href={containerUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  去 pull request 看原版
                </a>
              </Button>
            )}
            {canAdvance ? <AdvanceAction rangeReview={rangeReview} /> : null}
          </footer>
        )
      }
    >
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-base">
        <dt className="text-text-secondary">base</dt>
        <dd className="min-w-0 break-all font-mono text-base">{rangeReview.baseSha}</dd>
        <dt className="text-text-secondary">当前比较项</dt>
        <dd className="min-w-0 break-all font-mono text-base">{rangeReview.comparisonSha}</dd>
        {rangeReview.completedAt === null ? null : (
          <>
            <dt className="text-text-secondary">审查完成</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              <span className="break-all">{rangeReview.completedBy}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{localMinute(rangeReview.completedAt)}</span>
            </dd>
          </>
        )}
      </dl>

      {rangeReview.lastForgeFailure === null ? null : (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{rangeReview.lastForgeFailure}</Callout.Text>
        </Callout.Root>
      )}

      {/*
        主视图是这个阶段按 Finding Identity 汇总的当前状态(issue #168):最新一轮没
        报出的问题不再藏在旧轮里。轮次降为时间线,挂在推出它的那个比较项下面。
      */}
      <StageSummaryView
        scope={{ kind: "range-review", rangeReviewId: rangeReview.id }}
        canDispose={canDispose}
        timeline={(entries) =>
          detail.isPending ? (
            <Skeleton aria-hidden className="h-14" />
          ) : (
            comparisons.map((comparison) => (
              <section key={comparison.id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-1.5 text-base text-text-muted">
                  <CommitChip sha={comparison.sha} />
                  <span className="break-all">{comparison.recordedBy}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{localMinute(comparison.recordedAt)}</span>
                </div>
                {/* 一个比较项对应它被推上去之后跑的那些轮次,按 head 认。 */}
                {entries
                  .filter((entry) => entry.headSha === comparison.sha)
                  .reverse()
                  .map((entry) => {
                    // 结论徽章仍取评审记录页那一份映射:同一轮在两页显示成同一个词。
                    const run = runs.find((item) => item.id === entry.runId);
                    return (
                      <div key={entry.runId} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-base text-text-muted tabular-nums">
                            {localMinute(entry.startedAt)}
                          </span>
                          {run === undefined ? null : (
                            <StatusBadge tone={runStatus(run).tone}>
                              {runStatus(run).label}
                            </StatusBadge>
                          )}
                        </div>
                        <StageRound entry={entry} />
                      </div>
                    );
                  })}
              </section>
            ))
          )
        }
      />
    </DetailPanel>
  );
}
