import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { ArrowLeftIcon, CheckCircledIcon, CrossCircledIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { Callout, SegmentedControl, Skeleton, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localClock, localDay, localMinute } from "@/lib/time";

import { fetchJson } from "./api.ts";
import { AdvanceAction, CompleteAction, type RangeReview } from "./range-review-actions.tsx";
import { RunDiff } from "./run-diff.tsx";
import { RunTrace } from "./run-trace.tsx";
import {
  disposedCount,
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
import { StageRound, StageSummaryView, type StageScope, type StageTimelineEntry } from "./stage-summary.tsx";

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

/**
 * 审查阶段的详情页(issue #175)。一个阶段有自己的地址,两种来源共用这一页。
 *
 * 默认是阶段汇总(`stage-summary.tsx`):这个阶段此刻还剩什么没处置。轮次降为其中的
 * 时间线,按代码推进分组;点某一轮切到那一轮的完整 diff 与审查轨迹,那一轮记在地址上
 * (`?run=`),刷新仍停在它,收起即回到汇总。
 */
export function StageDetailPage({
  stageId,
  canDispose,
  canCreate,
  canRerun,
}: {
  stageId: string;
  /** 有 `finding:dispose` 权限时,汇总与 diff 里都出现行内处置动作,页头出现审查完成。 */
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
   * 打开哪一轮记在地址里:链接能指到具体一轮,刷新之后仍停在它,浏览器后退键能回到
   * 阶段汇总。`file` 是阶段汇总跳过来时带的落点文件,回到汇总时跟着清掉。
   */
  const opened = useRouterState({
    select: (state) => {
      const search = state.location.search as { run?: unknown; file?: unknown };
      const id = typeof search.run === "number" ? search.run : Number(search.run);
      return {
        runId: Number.isSafeInteger(id) && id > 0 ? id : null,
        file: typeof search.file === "string" && search.file !== "" ? search.file : undefined,
      };
    },
  });
  const backToSummary = (): void => {
    // 只清这一轮与它的落点文件,地址上其余的格子不动。
    void navigate({
      to: "/stages/$stageId",
      params: { stageId },
      search: (prev: Record<string, unknown>) => ({ ...prev, run: undefined, file: undefined }),
    });
  };

  const body = detail.data;
  return (
    <PageBody width="wide">
      <div>
        <Link
          to="/runs"
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

          {opened.runId === null ? (
            <StageSummaryView
              scope={scopeOf(body.stage)}
              canDispose={canDispose}
              timeline={() => (
                <StageTimeline stageId={stageId} groups={body.groups} stage={body.stage} />
              )}
            />
          ) : (
            <StageRunView
              key={opened.runId}
              runId={opened.runId}
              canDispose={canDispose}
              {...(opened.file === undefined ? {} : { diffFile: opened.file })}
              onBack={backToSummary}
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
 * commit,范围审查是一个比较项。点一轮进那一轮的 diff。
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
                search={{ run: entry.runId }}
                className="flex flex-col gap-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="flex items-center justify-between gap-3 text-base text-text-muted">
                  <span className="tabular-nums">{localMinute(entry.startedAt)}</span>
                  <span className="text-primary">看这一轮的 diff</span>
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
 * 一轮的完整视图:本轮 diff 与审查轨迹。处置在 diff 的 Finding 卡片里行内做,
 * 与阶段汇总用的是同一个组件、同一个接口。
 */
function StageRunView({
  runId,
  canDispose,
  diffFile,
  onBack,
}: {
  runId: number;
  canDispose: boolean;
  /** 打开时先把 diff 筛到这个文件;阶段汇总跳过来时带着它。 */
  diffFile?: string;
  onBack: () => void;
}) {
  // 只为拿 Forge 基址,好把这一轮指回它的 pull request。与壳共用同一份会话缓存。
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchJson<{ run: RunItem }>(`/runs/${runId}`),
    // 还在跑的那一轮每 10 秒续查,跑完就停:人打开它正是想看它跑出什么。
    refetchInterval: (query) => (query.state.data?.run.finishedAt === null ? 10_000 : false),
  });
  const [view, setView] = useState<"diff" | "trace">("diff");

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="soft" color="gray" size={{ initial: "3", sm: "2" }} onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
          回到阶段汇总
        </Button>
      </div>

      {run.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(run.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}
      {run.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label="正在加载这一轮" aria-busy="true">
          <Skeleton aria-hidden className="h-8 w-64 max-w-full" />
          <Skeleton aria-hidden className="h-56 w-full" />
        </div>
      ) : null}

      {run.data === undefined ? null : (
        <RunBody
          run={run.data.run}
          canDispose={canDispose}
          view={view}
          onView={setView}
          {...(diffFile === undefined ? {} : { diffFile })}
          pullUrl={
            session.data === undefined || session.data === null
              ? null
              : pullRequestUrl(session.data, run.data.run)
          }
        />
      )}
    </div>
  );
}

function RunBody({
  run,
  canDispose,
  view,
  diffFile,
  pullUrl,
  onView,
}: {
  run: RunItem;
  canDispose: boolean;
  view: "diff" | "trace";
  diffFile?: string;
  /** pull request 地址;没有配 Forge 基址时是 null,那一格不渲染。 */
  pullUrl: string | null;
  onView: (next: "diff" | "trace") => void;
}) {
  const duration = runDuration(run);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-base text-text-muted">
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
      </div>

      {run.total === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-base text-text-secondary">
            <span>处置进度</span>
            <span className="font-bold tabular-nums text-text">
              {disposedCount(run)} / {run.total}
            </span>
          </div>
          {/* 两段一条:人工在前,自动接在后面。两者都是已处置,只是来路不同。 */}
          <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-accent-track">
            <div className="h-full bg-primary" style={{ width: `${(run.resolved / run.total) * 100}%` }} />
            <div className="h-full bg-primary/40" style={{ width: `${(run.fixed / run.total) * 100}%` }} />
          </div>
          {run.fixed === 0 ? null : (
            <p className="text-sm text-text-muted tabular-nums">
              人工 {run.resolved} · 自动 {run.fixed}
            </p>
          )}
        </div>
      )}

      <SegmentedControl.Root
        value={view}
        onValueChange={(next) => {
          if (next === "diff" || next === "trace") onView(next);
        }}
        size="1"
        aria-label="轮次视图"
        className="w-fit"
      >
        <SegmentedControl.Item value="diff">本轮 diff</SegmentedControl.Item>
        <SegmentedControl.Item value="trace">审查轨迹</SegmentedControl.Item>
      </SegmentedControl.Root>

      {view === "trace" ? (
        <RunTrace run={run} />
      ) : (
        <RunDiff
          run={run}
          canDispose={canDispose}
          {...(diffFile === undefined ? {} : { initialFile: diffFile })}
        />
      )}

      {run.usage === undefined ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-sm text-text-muted">
          <span className="tabular-nums">
            用量 输入 {run.usage.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
            {run.usage.outputTokens.toLocaleString("zh-CN")} tokens
          </span>
        </div>
      )}

      {/*
        处置在 diff 里行内做,这一格留给「去看原版」:整轮 review 的上下文、别人的讨论
        与代码本身都在那边,单条 Finding 的链接给不出这些。
      */}
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
    </>
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
