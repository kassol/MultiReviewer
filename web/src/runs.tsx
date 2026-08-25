import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Badge, Callout, Dialog, SegmentedControl, Skeleton, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { DetailPanel } from "@/components/detail-panel";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localClock, localDay } from "@/lib/time";

import { api, errorText, fetchJson } from "./api.ts";
import { RunDiff } from "./run-diff.tsx";
import { loadPanelSession, pullRequestUrl } from "./session.ts";
import { StageSummaryView } from "./stage-summary.tsx";
import { SummaryRate } from "./stats.tsx";
import { costPresentation, type UsageSummary } from "./usage-cost.ts";

export type RunItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  /** 手动重新运行的调用者用户名快照；null 表示自动触发。 */
  triggeredBy: string | null;
  /** 这一轮归属的范围审查；null 即由 pull request 触发。 */
  rangeReviewId: number | null;
  finishedAt: string | null;
  failed: boolean;
  /** 一行一个参与本轮的模型。`failure` 非 null 即这个模型这轮失败了(节选文本)。 */
  models: {
    model: string;
    findings: number;
    failure: string | null;
    usage?: UsageSummary;
  }[];
  /** 会话没有产生统计时省略。 */
  usage?: UsageSummary;
  /** 本轮落库的每一条 Finding。详情的 diff 视图把它们锚在对应文件行上。 */
  findings: RunFinding[];
  /** 人工处置掉的 Finding 条数。 */
  resolved: number;
  /** 「已修复」自动处置掉的 Finding 条数。 */
  fixed: number;
  total: number;
};

/** 已处置的 Finding 条数:人工与自动都算。进度与状态一律按它判。 */
export function disposedCount(run: { resolved: number; fixed: number }): number {
  return run.resolved + run.fixed;
}

/**
 * 一条落库的 Finding。`commentId` 为 null 的那些只活在 review 正文里(fallback),
 * 没有可处置的载体,行内不给处置动作。
 */
export type RunFinding = {
  id: number;
  /** 报出它的全部模型,按首报先后(ADR 0015)。 */
  models: string[];
  file: string;
  line: number;
  severity: "P0" | "P1" | "P2";
  category: string;
  description: string;
  /**
   * `fixed` 是「已修复」自动处置,处置人为空;`continued` 是「已延续」——这处代码已改写,
   * 同一条 Finding 由新一轮在新位置那条承接,这一行只剩交接的记录,不是处置。
   */
  disposition: "resolved" | "unresolved" | "unknown" | "fixed" | "continued";
  placement: "inline" | "body";
  commentId: string | null;
  /** Forge 上那条原评论的地址。 */
  commentHtmlUrl: string | null;
  /** 在面板上处置的人与时刻;在 Gitea 上处置的两项为 null。 */
  disposedBy: string | null;
  disposedAt: string | null;
  /** 处置备注,只存面板。 */
  note: string | null;
  /** 承接来的那条旧评论的地址(CONTEXT.md 已延续);不是延续来的为 null。 */
  continuedFrom: string | null;
};

type RunsPage = { runs: RunItem[]; nextBefore: number | null };

/** 手动重新运行。时间流与仓库详情共用这一个请求。 */
export async function rerunRequest(run: {
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<string> {
  const response = await api("/rerun", {
    method: "POST",
    body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return `已触发 ${run.owner}/${run.repo} #${run.pullNumber} 的新一轮审查`;
}

/**
 * 时间流卡片上的处置进度。与处置率同一口径:只算行级承载的合并组。
 *
 * 「状态到颜色」的映射留在这里:它同时被仓库页与评审记录页用,拆掉这层包装会把
 * 这条规则散到两个调用点。失败与待处置分成两色——一个去重新运行,一个去处置。
 *
 * 部分模型失败不占这个位置:那一轮跑通的模型报出的 Finding 是真的、可处置的,
 * 处置进度得留着。失败只加一颗红点提示「这一轮的结论不完整」,原因看卡片上的模型行。
 */
export function RunPill({ run }: { run: RunItem }) {
  const badge = runBadge(run);
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

type RunFilter = "all" | "failed" | "pending" | "done";

function runHasModelFailure(run: RunItem): boolean {
  return run.models.some((entry) => entry.failure !== null);
}

function runBucket(run: RunItem): Exclude<RunFilter, "all"> {
  if (run.failed || runHasModelFailure(run)) return "failed";
  if (run.total > 0 && disposedCount(run) < run.total) return "pending";
  return "done";
}

function RunStatus({ run }: { run: RunItem }) {
  if (run.failed) {
    return (
      <CrossCircledIcon className="size-4 shrink-0 text-destructive" aria-label="失败" />
    );
  }
  if (runHasModelFailure(run)) {
    return (
      <ExclamationTriangleIcon className="size-4 shrink-0 text-warning" aria-label="部分失败" />
    );
  }
  return <CheckCircledIcon className="size-4 shrink-0 text-success" aria-label="完成" />;
}

/**
 * 一轮审查的结论。总览、评审记录与仓库页共用这一份映射——同一轮在三处显示成不同
 * 的词,读的人得先确认那是不是同一件事。
 *
 * 徽章只说结论,分数由各页自己那一格显示:两边都写就是同一个数字说两遍。
 *
 * total 只计行级承载的合并组:纯正文 Finding 的 Run 落在「无可处置项」——正文没有
 * resolve 载体,本来就无从处置。
 */
export function runStatus(run: RunItem): { tone: StatusTone; label: string } {
  // 未结束的一轮先判:否则它会因为「一条可处置项都还没有」而显示成「无可处置项」。
  if (run.finishedAt === null && !run.failed) return { tone: "running", label: "运行中" };
  if (run.failed) return { tone: "error", label: "运行失败" };
  if (run.models.some((entry) => entry.failure !== null)) return { tone: "warning", label: "部分失败" };
  if (run.total === 0) return { tone: "neutral", label: "无可处置项" };
  return disposedCount(run) === run.total
    ? { tone: "success", label: "已完成" }
    : { tone: "warning", label: "待处置" };
}

function runBadge(run: RunItem) {
  const status = runStatus(run);
  return (
    <StatusBadge tone={status.tone} {...(status.tone === "neutral" ? { icon: CheckCircledIcon } : {})}>
      {status.label}
    </StatusBadge>
  );
}

/**
 * 列表行右侧的结论徽章。与 `RunPill` 的差别只有一处:不带那颗可聚焦的警告图标——
 * 行本身已经是按钮,里面再放一个可聚焦元素会让键盘焦点掉进按钮内部。部分模型失败
 * 由行首的状态图标和红色模型 chip 承担,信息没有丢。
 */
function rowBadge(run: RunItem) {
  return run.failed ? <StatusBadge tone="error">失败</StatusBadge> : runBadge(run);
}

function triggerLabel(run: RunItem): string {
  return run.triggeredBy === null ? "自动触发" : `手动 · ${run.triggeredBy}`;
}

/**
 * 轮次的来源:pull request 还是范围审查。
 *
 * 两条链路的 `pullNumber` 都指向一个真实 PR(范围审查那条指的是容器 PR),不标出来
 * 的话,列表里一行「acme/widgets #101」看不出这是人开的 PR 还是本工具自建的容器。
 */
function RunSourceBadge({ run }: { run: RunItem }) {
  if (run.rangeReviewId === null) return null;
  return <Badge color="gray" variant="soft" radius="full">范围审查</Badge>;
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

/**
 * 行右侧的模型标签组。设计稿把「哪些模型参与、各报了几条」压成一排 chip:失败的那
 * 一个变红,扫一眼就知道这轮结论是否完整,不必展开详情。
 *
 * 只在 lg 以上出现:窄屏这排 chip 会把标题挤成两个字,状态徽章反而是更该留下的信息。
 */
function RunModelChips({ run }: { run: RunItem }) {
  if (run.models.length === 0) return null;
  return (
    <span className="hidden max-w-[38%] shrink-0 flex-wrap justify-end gap-1.5 lg:flex">
      {run.models.map((entry) => (
        <span
          key={entry.model}
          className={`inline-flex max-w-[11rem] items-center gap-1 truncate rounded-full px-2.5 py-0.5 font-mono text-xs font-normal ${
            entry.failure === null ? "bg-fill text-text-secondary" : "bg-danger-tint text-danger"
          }`}
        >
          <span className="truncate">{entry.model}</span>
          <span className="shrink-0 tabular-nums">
            {entry.failure === null ? entry.findings : "失败"}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * 运行详情面板。外壳(定位、材质、头尾结构与关闭)走共用的 `DetailPanel`,这里只组装
 * 这一轮的头部、正文与动作条。
 *
 * 桌面取 wide 那一档:面板里装的是完整 diff,一行代码在窄档里要折三四次才放得下,
 * 而读 diff 的前提是一行就是一行。
 */
export function RunDetailPanel({
  run,
  canRerun,
  canDispose,
  rerunning,
  pullUrl,
  diffFile,
  onRerun,
  onOpenOther,
  onSwitchFilter,
  onClose,
}: {
  run: RunItem;
  canRerun: boolean;
  /** 有 `finding:dispose` 权限时行内出现处置动作。 */
  canDispose: boolean;
  rerunning: boolean;
  /** 打开时先把 diff 筛到这个文件;阶段汇总跳过来时带着它。 */
  diffFile?: string;
  /** pull request 地址;没有配 Forge 基址时是 null,那一格不渲染。 */
  pullUrl: string | null;
  onRerun: () => void;
  /** 点到列表里另一轮时换成它,而不是先关面板。 */
  onOpenOther: (id: number) => void;
  /** 点到筛选控件时切过去,而不是让遮罩把这一下吞掉。 */
  onSwitchFilter: (next: RunFilter) => void;
  onClose: () => void;
}) {
  const cost = costPresentation(run.usage);
  const duration = runDuration(run);
  /*
   * PR 触发的那条链路在这里给出与范围审查详情同一个阶段汇总(issue #168):一个 pull
   * request 从打开到关闭就是一个审查阶段,「这个阶段还剩什么没处置」在两条链路上是
   * 同一个问题。范围审查的轮次不给这个开关——它的阶段汇总就在范围审查详情页上。
   */
  const [view, setView] = useState<"diff" | "stage">("diff");
  const stage = run.rangeReviewId === null && view === "stage";
  return (
    <DetailPanel
      onClose={onClose}
      /*
       * 这是主从列表的详情面板。看完一轮接着看下一轮是这一页最常做的事,而模态
       * 对话框把「点下一行」变成「先关掉、再点一次」。点到列表行时改成换那一轮,
       * 点别处仍然照常关闭。
       */
      onPointerDownOutside={(event) => {
        /*
         * 按坐标做几何命中,既不看 event.target,也不用 elementsFromPoint。
         *
         * 面板是模态的,Radix 会把背景整片设成 `pointer-events: none`:target 永远是
         * 遮罩自己,而 elementsFromPoint 做的是命中测试,不返回 pointer-events 为 none
         * 的元素——那一叠里只剩遮罩和 html。两条路都拿不到人真正想点的东西。
         *
         * 逐个比对矩形不依赖命中测试,所以不受这层屏蔽影响。不接住的话,点下一轮、
         * 点筛选都要点两次:第一下被当成「关掉面板」吃掉。
         */
        const { clientX: x, clientY: y } = event.detail.originalEvent;
        const hit = (selector: string): HTMLElement | null => {
          for (const element of document.querySelectorAll<HTMLElement>(selector)) {
            const rect = element.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
              return element;
            }
          }
          return null;
        };

        const id = Number(hit("[data-run-id]")?.dataset.runId);
        if (Number.isSafeInteger(id) && id > 0) {
          event.preventDefault();
          onOpenOther(id);
          return;
        }
        const next = hit("[data-filter-value]")?.dataset.filterValue;
        if (next === "all" || next === "failed" || next === "pending" || next === "done") {
          event.preventDefault();
          onSwitchFilter(next);
          onClose();
        }
      }}
      header={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <RunPill run={run} />
            <RunSourceBadge run={run} />
            {duration === null ? null : (
              <span className="text-base text-text-muted">耗时 {duration}</span>
            )}
          </div>
          <Dialog.Title className="!mb-0 min-w-0 !text-3xl !font-extrabold !tracking-[-0.02em] break-all">
            {run.owner}/{run.repo} #{run.pullNumber}
          </Dialog.Title>
          <div className="flex flex-wrap items-center gap-1.5 text-base text-text-muted">
            <CommitChip sha={run.headSha} />
            <span aria-hidden>·</span>
            <span className="break-all">{triggerLabel(run)}</span>
            <span aria-hidden>·</span>
            <span>{localDay(run.startedAt)} {localClock(run.startedAt)}</span>
          </div>
        </>
      }
      headerBelow={
        run.total === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-base text-text-secondary">
              <span>处置进度</span>
              <span className="font-bold tabular-nums text-text">
                {disposedCount(run)} / {run.total}
              </span>
            </div>
            {/* 两段一条:人工在前,自动接在后面。两者都是已处置,只是来路不同。 */}
            <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-accent-track">
              <div
                className="h-full bg-primary"
                style={{ width: `${(run.resolved / run.total) * 100}%` }}
              />
              <div
                className="h-full bg-primary/40"
                style={{ width: `${(run.fixed / run.total) * 100}%` }}
              />
            </div>
            {run.fixed === 0 ? null : (
              <p className="text-sm text-text-muted tabular-nums">
                人工 {run.resolved} · 自动 {run.fixed}
              </p>
            )}
          </div>
        )
      }
      footer={
        canRerun || pullUrl !== null ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-overlay-line px-6 py-3.5">
            {/*
              处置在面板行内做,这一格留给「去看原版」:整轮 review 的上下文、别人的
              讨论与代码本身都在那边,单条 Finding 的链接给不出这些。
            */}
            {pullUrl === null ? <span /> : (
              <Button asChild variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
                <a href={pullUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  去 pull request 看原版
                </a>
              </Button>
            )}
            {canRerun ? (
              <Button
                variant="solid"
                size={{ initial: "3", sm: "2" }}
                disabled={rerunning}
                onClick={onRerun}
              >
                {rerunning ? "重新运行中…" : "重新运行"}
              </Button>
            ) : null}
          </footer>
        ) : null
      }
    >
      {run.rangeReviewId === null ? (
        <SegmentedControl.Root
          value={view}
          onValueChange={(value) => setView(value === "stage" ? "stage" : "diff")}
          size="1"
          aria-label="详情视图"
          className="w-fit"
        >
          <SegmentedControl.Item value="diff">本轮 diff</SegmentedControl.Item>
          <SegmentedControl.Item value="stage">阶段汇总</SegmentedControl.Item>
        </SegmentedControl.Root>
      ) : null}

      {/*
        详情默认是这一轮的完整 diff:文件列表加逐文件 diff,Finding 锚在对应行上。
        `key` 换成 run.id,换一轮时筛选与展开状态跟着重置,不把上一轮的筛选带过来。
      */}
      {stage ? (
        <StageSummaryView
          key={`${run.owner}/${run.repo}#${run.pullNumber}`}
          scope={{
            kind: "pull-request",
            owner: run.owner,
            repo: run.repo,
            pullNumber: run.pullNumber,
          }}
          canDispose={canDispose}
          onJumpToRun={() => setView("diff")}
        />
      ) : (
        <RunDiff
          key={run.id}
          run={run}
          canDispose={canDispose}
          {...(diffFile === undefined ? {} : { initialFile: diffFile })}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-sm text-text-muted">
        {run.usage === undefined ? null : (
          <span className="tabular-nums">
            用量 输入 {run.usage.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
            {run.usage.outputTokens.toLocaleString("zh-CN")} tokens
          </span>
        )}
        <span className="tabular-nums">成本 {cost.amount}</span>
      </div>
      {cost.note === null ? null : (
        <p className="px-1 text-sm break-words text-warning">{cost.note}</p>
      )}
    </DetailPanel>
  );
}

export function RunsPage({ canRerun, canDispose }: { canRerun: boolean; canDispose: boolean }) {
  // 只为拿 Forge 基址,好把每一轮指回它的 pull request。与壳共用同一份会话缓存,
  // 不产生额外请求。
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const runs = useInfiniteQuery({
    queryKey: ["runs"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchJson<RunsPage>(pageParam === null ? "/runs" : `/runs?before=${pageParam}`),
    getNextPageParam: (last) => last.nextBefore,
    /*
     * 审查是异步的:推一个 pull request 之后要跑上几分钟。有轮次还没跑完时自动续查,
     * 跑完就停——否则人只能盯着页面反复点刷新,而这恰恰是最想看结果的那几分钟。
     */
    refetchInterval: (query) =>
      (query.state.data?.pages ?? []).some((page) =>
        page.runs.some((item) => item.finishedAt === null),
      )
        ? 10_000
        : false,
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  // 筛选同样记在地址里:总览上的「待处置发现」要能直接落到筛过的列表,而不是把人
  // 丢到全部记录里再自己点一次。
  const filter = useRouterState({
    select: (state) => {
      const value = (state.location.search as { filter?: unknown }).filter;
      return value === "failed" || value === "pending" || value === "done" ? value : "all";
    },
  });
  const setFilter = (next: RunFilter) => {
    void navigate({
      to: "/runs",
      search: (prev: Record<string, unknown>) => ({ ...prev, filter: next === "all" ? undefined : next }),
      replace: true,
    });
  };
  // 详情面板认 id 不认对象:列表每次刷新都是新对象,认对象会在后台刷新时把面板打空。
  /*
   * 打开哪一轮记在地址里,不记在组件状态里:总览上点某一轮要能直接落到它的详情,
   * 而不是落到列表顶上让人再找一遍;地址能分享、浏览器后退键也能收起面板。
   */
  const navigate = useNavigate();
  const openedRunId = useRouterState({
    select: (state) => {
      const value = (state.location.search as { run?: unknown }).run;
      const id = typeof value === "number" ? value : Number(value);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
  });
  const setOpenedRunId = (id: number | null) => {
    // 只动 run 这一格,别把筛选一起清掉;换一轮或收起面板时把 file 一并清掉——它说的是
    // 「落地先看哪个文件」,只对跳过来的那一轮成立。开合详情进历史记录(不 replace),
    // 后退键因此能收起面板;筛选切换则用 replace,否则点几下分段控件就把历史塞满了。
    void navigate({
      to: "/runs",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        run: id ?? undefined,
        file: undefined,
      }),
    });
  };
  // 阶段汇总跳过来时带着文件:那一条 Finding 在哪个文件里,落地就先展开哪个文件。
  const openedFile = useRouterState({
    select: (state) => {
      const value = (state.location.search as { file?: unknown }).file;
      return typeof value === "string" && value !== "" ? value : undefined;
    },
  });
  const rerun = useMutation({
    mutationFn: rerunRequest,
    onSuccess: (text) => setFeedback({ text, isError: false }),
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  // 滚到底部附近自动加载更早的一页。
  const sentinel = useRef<HTMLDivElement>(null);
  const listViewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (
        runs.hasNextPage &&
        !runs.isFetchingNextPage &&
        entries.some((entry) => entry.isIntersecting)
      ) {
        void runs.fetchNextPage();
      }
    }, { root: listViewport.current, rootMargin: "0px 0px 160px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [runs.fetchNextPage, runs.hasNextPage, runs.isFetchingNextPage]);

  const flat = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const counts = {
    all: flat.length,
    failed: flat.filter((run) => runBucket(run) === "failed").length,
    pending: flat.filter((run) => runBucket(run) === "pending").length,
    done: flat.filter((run) => runBucket(run) === "done").length,
  };
  const visible = filter === "all" ? flat : flat.filter((run) => runBucket(run) === filter);
  const visibleGroups = visible.reduce<{ day: string; runs: RunItem[] }[]>((groups, run) => {
    const day = localDay(run.startedAt);
    const current = groups.at(-1);
    if (current?.day === day) current.runs.push(run);
    else groups.push({ day, runs: [run] });
    return groups;
  }, []);
  const openedRun = flat.find((run) => run.id === openedRunId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBody width="wide" className="min-h-0 flex-1 pb-4 sm:pb-4">
        <PageHeader
          title="评审记录"
          // 读取中不占位说明:计数一到就替换掉,那一行字只会闪一下。
          {...(runs.isPending ? {} : { description: `${counts.all} 轮 · ${counts.failed} 失败` })}
          actions={<SummaryRate />}
        />

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
        {runs.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(runs.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        <SegmentedControl.Root
          value={filter}
          onValueChange={(value) => {
            if (
              value === "all" ||
              value === "failed" ||
              value === "pending" ||
              value === "done"
            ) {
              setFilter(value);
            }
          }}
          size={{ initial: "3", sm: "1" }}
          aria-label="按结论过滤"
          className="w-fit max-sm:w-full"
        >
          {(
            [
              ["all", "全部", counts.all],
              ["failed", "失败", counts.failed],
              ["pending", "待处置", counts.pending],
              ["done", "已处置", counts.done],
            ] as const
          ).map(([id, label, count]) => (
            <SegmentedControl.Item key={id} value={id} data-filter-value={id}>
              {label}
              <span className="ml-1 font-mono tabular-nums">{count}</span>
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>

        <div
          ref={listViewport}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
          aria-busy={runs.isPending || runs.isFetchingNextPage}
          aria-label="评审记录列表"
        >
          {runs.isPending ? (
            <div
              className="flex flex-col gap-2 overflow-hidden rounded-lg border border-card-line bg-surface p-2 shadow-card"
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">正在加载评审记录</span>
              {[0, 1, 2, 3].map((slot) => <Skeleton key={slot} className="h-14" />)}
            </div>
          ) : null}

          {visible.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
              {visibleGroups.map((group) => (
                <Fragment key={group.day}>
                  <h2 className="border-t border-line px-5 pt-3 pb-2 text-sm font-bold tracking-[0.03em] text-text-muted first:border-t-0">
                    {group.day}
                  </h2>
                  {group.runs.map((run) => (
                    <MasterListItem
                      key={run.id}
                      selected={run.id === openedRunId}
                      onClick={() => setOpenedRunId(run.id)}
                      aria-haspopup="dialog"
                      data-run-id={run.id}
                      className="group flex items-center gap-3 border-t border-line px-5 py-3"
                    >
                      <RunStatus run={run} />
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-lg font-semibold group-data-[selected=true]:font-bold">
                            {run.owner}/{run.repo} #{run.pullNumber}
                          </span>
                          <RunSourceBadge run={run} />
                        </span>
                        {/* 副标题一行说清「哪个 commit、谁触发、什么时候、处置到哪」,
                            窄屏放开换行:390px 下这四段挤在一行只会各剩两个字。 */}
                        <span className="flex flex-wrap items-center gap-x-1.5 text-base font-normal text-text-muted">
                          <CommitChip sha={run.headSha} />
                          <span aria-hidden>·</span>
                          <span className="break-all">{triggerLabel(run)}</span>
                          <span aria-hidden>·</span>
                          <span className="tabular-nums">{localClock(run.startedAt)}</span>
                        </span>
                      </span>
                      <RunModelChips run={run} />
                      {/* 徽章说结论,这一格说进度:两边都写分数就是同一个数字说两遍。 */}
                      <span className="shrink-0 text-base tabular-nums text-text-muted max-sm:hidden">
                        {run.total === 0 ? "—" : `${disposedCount(run)}/${run.total}`}
                      </span>
                      <span className="shrink-0">{rowBadge(run)}</span>
                    </MasterListItem>
                  ))}
                </Fragment>
              ))}
            </div>
          ) : null}

          {flat.length === 0 && !runs.isPending && !runs.isError ? (
            <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
              <EmptyState
                title="暂无审查记录"
                titleAs="h2"
                description={
                  <>
                    向已注册仓库提交 pull request 后，系统会自动运行审查。
                    {canRerun ? "如需对已有 pull request 重新运行审查，请到仓库页选择仓库并输入 PR 编号。" : null}
                  </>
                }
                action={canRerun ? (
                  <Button variant="outline" color="gray" size={{ initial: "4", sm: "1" }} asChild>
                    <Link to="/repos">去仓库页</Link>
                  </Button>
                ) : undefined}
              />
            </div>
          ) : null}
          {flat.length > 0 && visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-card-line px-4 py-6 text-center text-text-muted">
              {/*
                筛选只作用于已经加载的那几页。还有更早的记录没取回来时,说「没有记录」
                会和总览上的待处置计数对不上——那个数也是按已加载的轮次算的,但人不会
                这么读。
              */}
              {runs.hasNextPage
                ? "已加载的记录里没有符合条件的，继续下滑会取回更早的记录。"
                : "没有符合条件的审查记录。"}
            </p>
          ) : null}
          <div ref={sentinel} />
          <p className="pt-3 text-center text-sm text-text-muted" aria-live="polite">
            {runs.isFetchingNextPage
              ? "加载更早的审查记录…"
              : runs.hasNextPage
                ? "继续下滑加载更早的审查记录"
                : flat.length > 0
                  ? "已加载全部记录"
                  : ""}
          </p>
        </div>
      </PageBody>

      {openedRun === null ? null : (
        <RunDetailPanel
          run={openedRun}
          canRerun={canRerun}
          canDispose={canDispose}
          rerunning={rerun.isPending}
          pullUrl={session.data === undefined || session.data === null ? null : pullRequestUrl(session.data, openedRun)}
          {...(openedFile === undefined ? {} : { diffFile: openedFile })}
          onOpenOther={setOpenedRunId}
          onSwitchFilter={setFilter}
          onRerun={() => {
            rerun.mutate(openedRun);
            // 结果落在页面顶部的 Callout 上,面板压着它人就看不见,所以触发即收面板。
            setOpenedRunId(null);
          }}
          onClose={() => setOpenedRunId(null)}
        />
      )}
    </div>
  );
}
