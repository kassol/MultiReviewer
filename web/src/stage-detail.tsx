import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type MouseEventHandler } from "react";

import {
  ArrowLeftIcon,
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExternalLinkIcon,
  ReaderIcon,
} from "@radix-ui/react-icons";
import {
  Callout,
  Dialog as ThemedDialog,
  IconButton,
  Skeleton,
  Text,
  TextArea,
  Tooltip,
} from "@radix-ui/themes";
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
import { rerunRequest, RUN_DIRECTIVE_PLACEHOLDER } from "./repo-actions.tsx";
import { FilePatch } from "./run-diff.tsx";
import { RunTrace } from "./run-trace.tsx";
import {
  rerunRangeReviewRequest,
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
  // 关掉侧滑之后按查询参数找回同一条入口。路由更新会重建 Link,不能只保存旧 DOM 节点。
  const lastDrawer = useRef(location.drawer);
  if (location.drawer !== null) lastDrawer.current = location.drawer;
  const drawerFocusFallback = useCallback((): HTMLElement | null => {
    const drawer = lastDrawer.current;
    if (drawer !== null) {
      const parameter = drawer.kind === "finding" ? "finding" : "trace";
      const target = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find((candidate) =>
        new URL(candidate.href).searchParams.get(parameter) === String(drawer.id) &&
        candidate.getClientRects().length > 0
      );
      if (target !== undefined) return target;
    }
    return visibleNavCurrentItem();
  }, []);
  const returnFocus = useDialogReturnFocus(drawerFocusFallback);

  const body = detail.data;
  return (
    <PageBody width="wide">
      <div>
        <Link
          to="/"
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
          <div>
            <StageSummaryView
              scope={scopeOf(body.stage)}
              canDispose={canDispose}
              onDrawerTrigger={returnFocus.captureTrigger}
              timeline={() => (
                <StageTimeline
                  stageId={stageId}
                  groups={body.groups}
                  stage={body.stage}
                  onDrawerTrigger={returnFocus.captureTrigger}
                />
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
  /*
   * 已经审查完成的范围审查没有可动的容器 PR:比较项不再推进,也不再开新一轮。发起失败
   * 那一档同理。记录还没到手时先按不可用,免得点下去撞一个 409。
   */
  const frozen = stage.source === "range-review" && rangeReview?.state !== "in-progress";

  return (
    <>
      {canRerun ? (
        <RerunAction
          stage={stage}
          disabled={frozen}
          onFeedback={onFeedback}
          onTriggered={onTriggered}
        />
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
 * 重跑(issue #176)加本轮指令(issue #225)。
 *
 * 走弹窗而不是在动作行里常驻一个输入框:指令是选填的,大多数重跑不带它,常驻一个空框
 * 会把「这一栏要填什么」的问题摆在每个人面前。与推进比较项同一形状——同一行上的两个
 * 动作,一个点开弹窗一个直接跑,人得先记住哪个是哪个。
 */
function RerunAction({
  stage,
  disabled,
  onFeedback,
  onTriggered,
}: {
  stage: StageItem;
  disabled: boolean;
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
  onTriggered: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [directive, setDirective] = useState("");
  const rerun = useMutation({
    mutationFn: (text: string | undefined) =>
      stage.source === "range-review"
        ? rerunRangeReviewRequest(stage.rangeReviewId!, text)
        : rerunRequest({
            owner: stage.owner,
            repo: stage.repo,
            pullNumber: stage.pullNumber!,
            ...(text === undefined ? {} : { directive: text }),
          }),
    onSuccess: (text) => {
      setOpen(false);
      // 指令只属于刚发出去的那一轮,留在框里下次会被顺手带上。
      setDirective("");
      onFeedback({ text, isError: false });
      onTriggered();
      void queryClient.invalidateQueries({ queryKey: ["stage-detail"] });
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  return (
    <ThemedDialog.Root open={open} onOpenChange={setOpen}>
      <ThemedDialog.Trigger>
        <Button variant="soft" color="gray" size={{ initial: "3", sm: "2" }} disabled={disabled}>
          重跑
        </Button>
      </ThemedDialog.Trigger>
      <ThemedDialog.Content maxWidth="520px" size={{ initial: "2", sm: "3" }}>
        <ThemedDialog.Title size="4" mb="1">
          再跑一轮
        </ThemedDialog.Title>
        <ThemedDialog.Description size="2" color="gray" mb="3">
          本轮指令只作用于这一轮,下一轮不带。要长期生效的要求请录进知识集。
        </ThemedDialog.Description>
        <form
          aria-busy={rerun.isPending}
          onSubmit={(event) => {
            event.preventDefault();
            onFeedback(null);
            const trimmed = directive.trim();
            rerun.mutate(trimmed === "" ? undefined : trimmed);
          }}
        >
          <Text as="label" htmlFor="stage-rerun-directive" className="sr-only">
            本轮指令
          </Text>
          <TextArea
            id="stage-rerun-directive"
            size="2"
            rows={3}
            maxLength={500}
            placeholder={RUN_DIRECTIVE_PLACEHOLDER}
            value={directive}
            onChange={(event) => setDirective(event.target.value)}
          />
          <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <ThemedDialog.Close>
              <Button
                type="button"
                variant="soft"
                color="gray"
                size={{ initial: "3", sm: "2" }}
                className="min-h-11 w-full sm:min-h-0 sm:w-auto"
              >
                取消
              </Button>
            </ThemedDialog.Close>
            <Button
              type="submit"
              variant="solid"
              size={{ initial: "3", sm: "2" }}
              className="min-h-11 w-full shadow-accent sm:min-h-0 sm:w-auto"
              disabled={rerun.isPending}
            >
              {rerun.isPending ? "触发中…" : "重跑"}
            </Button>
          </div>
        </form>
      </ThemedDialog.Content>
    </ThemedDialog.Root>
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
  onDrawerTrigger,
}: {
  stageId: string;
  stage: StageItem;
  groups: StageRunGroup[];
  onDrawerTrigger: MouseEventHandler<HTMLAnchorElement>;
}) {
  if (groups.length === 0) {
    return <EmptyState title="该审查阶段尚无 Review Run" className="py-2" />;
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.sha} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-1.5 text-base text-text-secondary">
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
            <p className="rounded-lg border border-dashed border-card-line px-4 py-3 text-base text-text-secondary">
              {stage.source === "range-review" ? "该比较项尚未运行审查" : "该 commit 尚未运行审查"}
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
                onClick={onDrawerTrigger}
                aria-label={`查看 ${localMinute(entry.startedAt)} 的审查轨迹`}
                className="group flex flex-col gap-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="flex items-center justify-between gap-3 text-base text-text-secondary">
                  <span className="tabular-nums">{localMinute(entry.startedAt)}</span>
                  <span className="inline-flex items-center gap-1 font-medium text-primary">
                    <ReaderIcon aria-hidden />
                    审查轨迹
                  </span>
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
 * 从底部升起并保留阶段上下文。Esc、遮罩与关闭按钮三种关法都由 Radix 的对话框原语给,焦点回到触发它的
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
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalHost(document.getElementById("panel-portal"));
  }, []);
  if (portalHost === null) return null;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal container={portalHost}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          style={{ backdropFilter: "var(--v8-drawer-blur)" }}
          className="fixed inset-x-0 bottom-0 z-50 flex h-[86dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-[color:var(--v8-drawer-bg)] shadow-overlay outline-none md:inset-y-3.5 md:right-3.5 md:left-auto md:h-auto md:w-[min(920px,calc(100vw-28px))] md:rounded-3xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-overlay-line px-4 py-3 sm:px-5 sm:py-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="min-w-0 break-all text-3xl font-semibold">
                {title}
              </Dialog.Title>
              {headline}
            </div>
            <Dialog.Close asChild>
              <IconButton
                variant="ghost"
                color="gray"
                size="2"
                className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
                aria-label={`关闭${title}`}
              >
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4 md:pb-4">
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
      title="代码差异"
      {...(finding === undefined
        ? {}
        : {
            headline: (
              <span className="break-all font-mono text-base text-text-secondary">
                {finding.file}:{finding.line}
              </span>
            ),
          })}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {summary.isPending ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">正在加载 Finding</span>
          <Skeleton className="h-40" />
        </div>
      ) : summary.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(summary.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : finding === undefined || latestRunId === null ? (
        <EmptyState
          title="该 Finding 已不在当前审查阶段的汇总中"
          titleAs="h2"
          description="该 Finding 可能已延续至新位置。请返回列表查看承接记录。"
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
        <div role="status" aria-label="正在加载本轮 Review Run" aria-busy="true">
          <Skeleton aria-hidden className="h-56 w-full" />
        </div>
      ) : null}

      {run.data === undefined ? null : (
        <div className="flex flex-col gap-3">
          {/* 发起这一轮时附的本轮指令(issue #225):这一轮为什么这么跑,答案只在这里。 */}
          {run.data.run.directive === null ? null : (
            <section
              aria-label="本轮指令"
              className="rounded-lg bg-accent-tint px-3 py-2 text-base text-text"
            >
              <span className="text-sm text-primary">本轮指令</span>
              <p className="mt-0.5 break-words whitespace-pre-wrap">{run.data.run.directive}</p>
            </section>
          )}
          {/* 失败原因决定要不要重跑(区域封禁重跑也没用,超时重跑就好),所以整段摊开。 */}
          {run.data.run.models
            .filter((entry) => entry.failure !== null)
            .map((entry) => (
              <Callout.Root key={entry.model} role="alert" color="red" size="1">
                <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
                <Callout.Text>
                  <span className="break-all font-mono">{entry.model}</span> 本轮运行失败：{entry.failure}
                </Callout.Text>
              </Callout.Root>
            ))}
          {/* 这一轮的 token 用量:运行诊断信息,不折算金额(issue #188)。 */}
          {run.data.run.usage === undefined ? null : (
            <section
              aria-label="Token 用量"
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-sunken px-3 py-2 text-sm text-text-secondary tabular-nums"
            >
              <span className="font-semibold text-text">
                总计 {run.data.run.usage.totalTokens.toLocaleString("zh-CN")}
              </span>
              <span>输入 {run.data.run.usage.inputTokens.toLocaleString("zh-CN")}</span>
              <span>输出 {run.data.run.usage.outputTokens.toLocaleString("zh-CN")}</span>
              <span>缓存读 {run.data.run.usage.cacheReadTokens.toLocaleString("zh-CN")}</span>
              <span>缓存写 {run.data.run.usage.cacheWriteTokens.toLocaleString("zh-CN")}</span>
            </section>
          )}
          <RunTrace run={run.data.run} />
          {pullUrl === null ? null : (
            <div>
              <Button
                asChild
                variant="soft"
                color="gray"
                size={{ initial: "3", sm: "2" }}
                className="min-h-11 sm:min-h-0"
              >
                <a href={pullUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  在 Forge 查看 pull request
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
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-base text-text-secondary">
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
      content={failureSummary}
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
