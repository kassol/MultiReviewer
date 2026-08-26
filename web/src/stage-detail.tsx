import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import {
  ArrowLeftIcon,
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Callout, IconButton, Skeleton, Tooltip } from "@radix-ui/themes";
import { Dialog } from "radix-ui";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import {
  useDialogReturnFocus,
  visibleNavCurrentItem,
} from "@/components/use-dialog-return-focus";
import { localClock, localDay, localMinute } from "@/lib/time";

import { fetchJson } from "./api.ts";
import { AdvanceAction, CompleteAction, type RangeReview } from "./range-review-actions.tsx";
import { FilePatch } from "./run-diff.tsx";
import { RunTrace } from "./run-trace.tsx";
import {
  rerunRangeReviewRequest,
  rerunRequest,
  runStatus,
  StageCounts,
  stageLabel,
  StageSourceBadge,
  StageStatusBadge,
  type RunItem,
  type StageItem,
} from "./runs.tsx";
import { loadPanelSession, pullRequestUrl } from "./session.ts";
import {
  StageRound,
  StageSummaryView,
  useStageSummary,
  type StageScope,
  type StageTimelineEntry,
} from "./stage-summary.tsx";

/**
 * 时间线上的一组轮次(issue #175):一组是一次代码推进。pull request 阶段按 head
 * commit 分,范围审查阶段按比较项分;比较项多带推的人与时刻,head commit 那两项是 null。
 */
type StageRunGroup = {
  sha: string;
  recordedBy: string | null;
  recordedAt: string | null;
  /** 这一组里的轮次,新的在前;刚推上去、还没跑过的比较项是空数组。 */
  runs: StageTimelineEntry[];
};

/** 字段与 `GET <前缀>/api/stages/{stageId}` 逐字对应。 */
type StageDetailBody = {
  stage: StageItem;
  groups: StageRunGroup[];
  /** 范围审查阶段自己那条记录;pull request 阶段没有这一格(issue #176)。 */
  rangeReview?: RangeReview;
};

/**
 * 这个阶段的汇总取哪一片:两种来源各一档,与 `GET /stage-summary` 的入参对应。
 * 一行只带自己那一个键(`GET /stages` 的行契约),另一个必为 null。
 */
function scopeOf(stage: StageItem): StageScope {
  return stage.pullNumber === null
    ? { kind: "range-review", rangeReviewId: stage.rangeReviewId! }
    : {
        kind: "pull-request",
        owner: stage.owner,
        repo: stage.repo,
        pullNumber: stage.pullNumber,
      };
}

/** 侧滑打开的是哪一样(issue #189):两者互斥,地址上都在时按 Finding 那一档算。 */
type OpenedDrawer = { kind: "finding"; id: number } | { kind: "trace"; id: number } | null;

function positiveId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * 来时那份评审记录列表的过滤(issue #189)。阶段页自己不读它们,只原样带在地址上再交
 * 还给返回链接:人回到的是自己来的那一片列表,而不是一份无过滤的全量。
 */
const LIST_FILTER_KEYS = ["owner", "repo", "status", "source"] as const;

function listFilters(search: Record<string, unknown>): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const key of LIST_FILTER_KEYS) {
    const value = search[key];
    if (typeof value === "string" && value !== "") carried[key] = value;
  }
  return carried;
}

/**
 * 审查阶段的详情页(issue #175、#189)。一个阶段有自己的地址,两种来源共用这一页,
 * 而且只有一种视图:上半是这个阶段当前状态下仍存在的 Finding,下半是时间线,一轮一行。
 *
 * 下钻只有侧滑一种,在同一路由上由查询参数驱动:`finding=` 是那条 Finding 所在文件的
 * diff,`trace=` 是那一轮的审查轨迹。页顶只有一个返回,回到来时的那份列表。
 */
export function StageDetailPage({
  stageId,
  canDispose,
  canCreate,
  canRerun,
}: {
  stageId: string;
  /** 有 `finding:dispose` 权限时,列表与侧滑里都出现行内处置动作,页头出现审查完成。 */
  canDispose: boolean;
  /** 有 `review:create` 权限才出现推进比较项。 */
  canCreate: boolean;
  /** 有 `review:rerun` 权限才出现重跑。 */
  canRerun: boolean;
}) {
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  /*
   * 重跑与推进都是 202 就回:新一轮要等工作副本就绪才落库,那一刻的重取看到的还是
   * 「没有未完成的轮次」。动作成功后先按时间续查一段,轮次一出现就接回按状态续查。
   * ponytail: 固定 90 秒的窗口,大仓库 clone 更久时人得手动刷新一次。
   */
  const [pollUntil, setPollUntil] = useState(0);
  const detail = useQuery({
    queryKey: ["stage-detail", stageId],
    queryFn: () => fetchJson<StageDetailBody>(`/stages/${encodeURIComponent(stageId)}`),
    // 还有轮次没跑完、刚推进的比较项还没有轮次、或刚触发过动作,就每 10 秒续查,
    // 全部结束即停:人最想看结果的正是这几分钟。
    refetchInterval: (query) =>
      (query.state.data?.groups ?? []).some(
        (group) =>
          group.runs.length === 0 ||
          group.runs.some((run) => run.finishedAt === null && !run.failed),
      ) || Date.now() < pollUntil
        ? 10_000
        : false,
  });
  const armPolling = () => setPollUntil(Date.now() + 90_000);
  /*
   * 侧滑开的是哪一条与来时的列表过滤都记在地址里:刷新仍停在同一条,链接发给同事打开
   * 的也是它。旧地址上的 `run=` 不再有读者,带着它进来就是一张普通的阶段页。
   */
  const location = useRouterState({
    select: (state) => {
      const search = state.location.search as Record<string, unknown>;
      const finding = positiveId(search.finding);
      const trace = positiveId(search.trace);
      const drawer: OpenedDrawer =
        finding !== null
          ? { kind: "finding", id: finding }
          : trace !== null
            ? { kind: "trace", id: trace }
            : null;
      return { drawer, filters: listFilters(search) };
    },
  });
  // 开关侧滑都走 replace:它是这一页里的一次下钻,不该往浏览器历史里塞一条。
  const closeDrawer = (): void => {
    void navigate({
      to: "/stages/$stageId",
      params: { stageId },
      search: (prev: Record<string, unknown>) => ({ ...prev, finding: undefined, trace: undefined }),
      replace: true,
    });
  };
  // 关掉侧滑之后焦点回到点开它的那条 Finding 或那一轮;那一行已经不在时退回当前导航项。
  const returnFocus = useDialogReturnFocus(visibleNavCurrentItem);

  const body = detail.data;
  return (
    <PageBody width="wide">
      <div>
        <Link
          to="/runs"
          search={location.filters}
          className="inline-flex items-center gap-1 text-base text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ArrowLeftIcon aria-hidden />
          评审记录
        </Link>
      </div>

      {detail.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(detail.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}
      {detail.isPending ? (
        <div className="flex flex-col gap-3" role="status" aria-label="正在加载审查阶段" aria-busy="true">
          <Skeleton aria-hidden className="h-11 w-72 max-w-full" />
          <Skeleton aria-hidden className="h-56 w-full" />
        </div>
      ) : null}

      {body === undefined ? null : (
        <>
          <PageHeader
            title={stageLabel(body.stage)}
            description={`${body.stage.owner}/${body.stage.repo}`}
            actions={
              <StageActions
                stage={body.stage}
                {...(body.rangeReview === undefined ? {} : { rangeReview: body.rangeReview })}
                canDispose={canDispose}
                canCreate={canCreate}
                canRerun={canRerun}
                onFeedback={setFeedback}
                onTriggered={armPolling}
              />
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <StageSourceBadge stage={body.stage} />
            <StageStatusBadge stage={body.stage} />
            <StageCounts stage={body.stage} />
          </div>

          {feedback === null ? null : (
            <Callout.Root
              role={feedback.isError ? "alert" : "status"}
              color={feedback.isError ? "red" : "green"}
              size="1"
            >
              <Callout.Icon>
                {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
              </Callout.Icon>
              <Callout.Text>{feedback.text}</Callout.Text>
            </Callout.Root>
          )}

          {/* 两个侧滑入口都是这一块里的链接:焦点来源在冒泡到这里时记下来。 */}
          <div onClick={returnFocus.captureBubblingLink}>
            <StageSummaryView
              scope={scopeOf(body.stage)}
              canDispose={canDispose}
              timeline={() => (
                <StageTimeline stageId={stageId} groups={body.groups} stage={body.stage} />
              )}
            />
          </div>

          {location.drawer === null ? null : location.drawer.kind === "finding" ? (
            <FindingDrawer
              key={location.drawer.id}
              scope={scopeOf(body.stage)}
              latestRunId={body.stage.latestRunId}
              findingId={location.drawer.id}
              canDispose={canDispose}
              onClose={closeDrawer}
              onCloseAutoFocus={returnFocus.onCloseAutoFocus}
            />
          ) : (
            <RoundDrawer
              key={location.drawer.id}
              runId={location.drawer.id}
              onClose={closeDrawer}
              onCloseAutoFocus={returnFocus.onCloseAutoFocus}
            />
          )}
        </>
      )}
    </PageBody>
  );
}

/**
 * 一个阶段的动作(issue #176):推进比较项、审查完成与重跑,都在它自己的详情页做。
 *
 * 推进与审查完成只有范围审查阶段有,组件是 `range-review-actions.tsx`。重跑两种来源都
 * 有:pull request 阶段在最新 head 上再跑一轮,范围审查阶段在当前比较项上再跑一轮。
 * 审查完成之后的范围审查三个动作都留在页面上但不可用——服务端也一律拒绝,终态不再动。
 */
function StageActions({
  stage,
  rangeReview,
  canDispose,
  canCreate,
  canRerun,
  onFeedback,
  onTriggered,
}: {
  stage: StageItem;
  rangeReview?: RangeReview;
  canDispose: boolean;
  canCreate: boolean;
  canRerun: boolean;
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
  /** 重跑或推进已被服务端接下:新一轮还要过一会才出现,外层据此续查。 */
  onTriggered: () => void;
}) {
  const queryClient = useQueryClient();
  const rerun = useMutation({
    mutationFn: () =>
      stage.source === "range-review"
        ? rerunRangeReviewRequest(stage.rangeReviewId!)
        : rerunRequest({ owner: stage.owner, repo: stage.repo, pullNumber: stage.pullNumber! }),
    onSuccess: (text) => {
      onFeedback({ text, isError: false });
      onTriggered();
      void queryClient.invalidateQueries({ queryKey: ["stage-detail"] });
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });
  /*
   * 已经审查完成的范围审查没有可动的容器 PR:比较项不再推进,也不再开新一轮。发起失败
   * 那一档同理。记录还没到手时先按不可用,免得点下去撞一个 409。
   */
  const frozen = stage.source === "range-review" && rangeReview?.state !== "in-progress";

  return (
    <>
      {canRerun ? (
        <Button
          variant="soft"
          color="gray"
          size={{ initial: "3", sm: "2" }}
          disabled={frozen || rerun.isPending}
          onClick={() => {
            onFeedback(null);
            rerun.mutate();
          }}
        >
          {rerun.isPending ? "触发中…" : "重跑"}
        </Button>
      ) : null}
      {rangeReview === undefined ? null : (
        <>
          {canDispose ? <CompleteAction rangeReview={rangeReview} disabled={frozen} /> : null}
          {canCreate ? (
            <AdvanceAction rangeReview={rangeReview} disabled={frozen} onAdvanced={onTriggered} />
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * 阶段的时间线:全部轮次按时间排列,一次代码推进一组——pull request 是一个 head
 * commit,范围审查是一个比较项。点一轮在侧滑里看它的审查轨迹(issue #189)。
 */
function StageTimeline({
  stageId,
  stage,
  groups,
}: {
  stageId: string;
  stage: StageItem;
  groups: StageRunGroup[];
}) {
  if (groups.length === 0) {
    return <EmptyState title="这个阶段还没有跑过 Review Run" className="py-2" />;
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.sha} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-1.5 text-base text-text-muted">
            <CommitChip sha={group.sha} />
            {group.recordedBy === null ? null : (
              <>
                <span className="break-all">{group.recordedBy}</span>
                <span aria-hidden>·</span>
              </>
            )}
            {group.recordedAt === null ? null : (
              <span className="tabular-nums">{localMinute(group.recordedAt)}</span>
            )}
          </div>
          {group.runs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-card-line px-4 py-3 text-base text-text-muted">
              {stage.source === "range-review" ? "这个比较项还没有跑过" : "这个 commit 还没有跑过"}
            </p>
          ) : (
            group.runs.map((entry) => (
              <Link
                key={entry.runId}
                to="/stages/$stageId"
                params={{ stageId }}
                search={(prev: Record<string, unknown>) => ({
                  ...prev,
                  trace: entry.runId,
                  finding: undefined,
                })}
                replace
                className="flex flex-col gap-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="flex items-center justify-between gap-3 text-base text-text-muted">
                  <span className="tabular-nums">{localMinute(entry.startedAt)}</span>
                  <span className="text-primary">看这一轮的审查轨迹</span>
                </span>
                <StageRound entry={entry} />
              </Link>
            ))
          )}
        </section>
      ))}
    </>
  );
}

/**
 * 阶段页唯一的下钻表面(issue #189):桌面从右侧滑入、固定宽度、内部独立滚动,窄视口
 * 占满整屏。Esc、遮罩与关闭按钮三种关法都由 Radix 的对话框原语给,焦点回到触发它的
 * 那一行。用原语而不是 Themes 的 Dialog:后者是居中模态,改成侧边抽屉得深度覆写它的
 * 内部 DOM。
 */
function StageDrawer({
  title,
  headline,
  onClose,
  onCloseAutoFocus,
  children,
}: {
  title: string;
  /** 标题下面那一行元信息;还没读到内容时不给。 */
  headline?: React.ReactNode;
  onClose: () => void;
  onCloseAutoFocus: (event: { preventDefault: () => void }) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-card-line bg-surface shadow-overlay outline-none sm:w-[min(920px,92vw)]"
        >
          <div className="flex items-start justify-between gap-3 border-b border-card-line px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="min-w-0 break-all text-3xl font-semibold">
                {title}
              </Dialog.Title>
              {headline}
            </div>
            <Dialog.Close asChild>
              <IconButton variant="ghost" color="gray" size="2" aria-label={`关闭 ${title}`}>
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * 一条 Finding 的侧滑:最新一轮 Review Range 里它所在文件的 diff,滚到并高亮它锚定的
 * 那一行,同文件的其它 Finding 挂在各自行下。处置就在卡片里做,与列表是同一个动作。
 */
function FindingDrawer({
  scope,
  latestRunId,
  findingId,
  canDispose,
  onClose,
  onCloseAutoFocus,
}: {
  scope: StageScope;
  /** 这个阶段最新一轮 Review Run;一轮都还没跑过时为 null,那时也不会有 Finding。 */
  latestRunId: number | null;
  findingId: number;
  canDispose: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: { preventDefault: () => void }) => void;
}) {
  // 与阶段页正文同一份查询:处置之后两处一起变,侧滑也不再多发一次请求。
  const summary = useStageSummary(scope);
  const finding = summary.data?.findings.find((entry) => entry.id === findingId);
  const sameFile =
    finding === undefined
      ? []
      : (summary.data?.findings ?? []).filter((entry) => entry.file === finding.file);

  return (
    <StageDrawer
      title={finding === undefined ? "Finding" : `${finding.file}:${finding.line}`}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {summary.isPending ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">正在加载这条 Finding</span>
          <Skeleton className="h-40" />
        </div>
      ) : summary.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(summary.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : finding === undefined || latestRunId === null ? (
        <EmptyState
          title="这条 Finding 不在这个阶段的当前状态里"
          titleAs="h2"
          description="它可能已经交接到了新位置,回到列表里找承接它的那一条。"
        />
      ) : (
        <FilePatch
          runId={latestRunId}
          path={finding.file}
          findings={sameFile}
          canDispose={canDispose}
          focusFindingId={finding.id}
        />
      )}
    </StageDrawer>
  );
}

/**
 * 一轮的侧滑:这一轮的审查轨迹,运行中的实时刷新。头部是它的结论、commit、触发来源、
 * 开跑时刻与耗时,下面是失败模型的原因与这一轮的 token 用量;末尾留一条去 pull request
 * 看原版的出口。
 */
function RoundDrawer({
  runId,
  onClose,
  onCloseAutoFocus,
}: {
  runId: number;
  onClose: () => void;
  onCloseAutoFocus: (event: { preventDefault: () => void }) => void;
}) {
  // 只为拿 Forge 基址,好把这一轮指回它的 pull request。与壳共用同一份会话缓存。
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchJson<{ run: RunItem }>(`/runs/${runId}`),
    // 还在跑的那一轮每 10 秒续查,跑完就停:人打开它正是想看它跑出什么。
    refetchInterval: (query) => (query.state.data?.run.finishedAt === null ? 10_000 : false),
  });
  const pullUrl =
    run.data === undefined || session.data === undefined || session.data === null
      ? null
      : pullRequestUrl(session.data, run.data.run);

  return (
    <StageDrawer
      title="审查轨迹"
      {...(run.data === undefined ? {} : { headline: <RunHeadline run={run.data.run} /> })}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {run.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(run.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}
      {run.isPending ? (
        <div role="status" aria-label="正在加载这一轮" aria-busy="true">
          <Skeleton aria-hidden className="h-56 w-full" />
        </div>
      ) : null}

      {run.data === undefined ? null : (
        <div className="flex flex-col gap-3">
          {/* 失败原因决定要不要重跑(区域封禁重跑也没用,超时重跑就好),所以整段摊开。 */}
          {run.data.run.models
            .filter((entry) => entry.failure !== null)
            .map((entry) => (
              <Callout.Root key={entry.model} role="alert" color="red" size="1">
                <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
                <Callout.Text>
                  <span className="break-all font-mono">{entry.model}</span> 这一轮失败：{entry.failure}
                </Callout.Text>
              </Callout.Root>
            ))}
          {/* 这一轮的 token 用量:运行诊断信息,不折算金额(issue #188)。 */}
          {run.data.run.usage === undefined ? null : (
            <p className="text-sm text-text-muted tabular-nums">
              用量 输入 {run.data.run.usage.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
              {run.data.run.usage.outputTokens.toLocaleString("zh-CN")} tokens
            </p>
          )}
          <RunTrace run={run.data.run} />
          {pullUrl === null ? null : (
            <div>
              <Button asChild variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
                <a href={pullUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  去 pull request 看原版
                </a>
              </Button>
            </div>
          )}
        </div>
      )}
    </StageDrawer>
  );
}

/** 侧滑头部那一行:这一轮是什么结论、跑的哪个 commit、谁触发的、什么时候跑了多久。 */
function RunHeadline({ run }: { run: RunItem }) {
  const duration = runDuration(run);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-base text-text-muted">
      <RunPill run={run} />
      <CommitChip sha={run.headSha} />
      <span className="break-all">{triggerLabel(run)}</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{localDay(run.startedAt)} {localClock(run.startedAt)}</span>
      {duration === null ? null : (
        <>
          <span aria-hidden>·</span>
          <span>耗时 {duration}</span>
        </>
      )}
    </span>
  );
}

/**
 * 一轮的结论徽章。部分模型失败不占这个位置:那一轮跑通的模型报出的 Finding 是真的、
 * 可处置的,结论得留着。失败挂在徽章的 Tooltip 上,徽章自己已经是警告样式。
 */
function RunPill({ run }: { run: RunItem }) {
  const status = runStatus(run);
  const badge = (
    <StatusBadge tone={status.tone} {...(status.tone === "neutral" ? { icon: CheckCircledIcon } : {})}>
      {status.label}
    </StatusBadge>
  );
  const down = run.models.filter((entry) => entry.failure !== null);
  if (down.length === 0) return badge;
  const failureSummary = `${down.length}/${run.models.length} 个模型失败，本轮审查结果不完整`;
  return (
    <Tooltip
      maxWidth="32rem"
      content={(
        <span className="block space-y-1">
          <span className="block font-medium">{failureSummary}</span>
          {down.map((entry) => (
            <span key={entry.model} className="block break-words">
              <span className="break-all font-mono">{entry.model}</span>：{entry.failure}
            </span>
          ))}
        </span>
      )}
    >
      <span
        tabIndex={0}
        className="inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {badge}
        <span className="sr-only">{failureSummary}</span>
      </span>
    </Tooltip>
  );
}

function triggerLabel(run: RunItem): string {
  return run.triggeredBy === null ? "自动触发" : `手动 · ${run.triggeredBy}`;
}

/** 还没跑完的一轮没有耗时可言,返回 null 让调用点整段省掉,而不是显示一个 0。 */
function runDuration(run: RunItem): string | null {
  if (run.finishedAt === null) return null;
  const seconds = Math.round(
    (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}
