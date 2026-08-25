import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { CheckCircledIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, SegmentedControl, Skeleton } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { MasterListItem } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localClock, localDay } from "@/lib/time";

import { api, errorText, fetchJson } from "./api.ts";
import { RangeReviewLaunch } from "./range-review-launch.tsx";
import { SummaryRate } from "./stats.tsx";
import { type UsageSummary } from "./usage-cost.ts";

export type RunItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** 被审 pull request 的标题快照;null 即范围审查那一档或升级前的旧行。 */
  title: string | null;
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

/**
 * 评审记录里的一行(issue #174):一个审查阶段,不是一轮 Review Run。同一 pull request
 * 推多少次、同一范围审查推进多少次,列表里都只有这一行。
 *
 * `stageId` 由来源与键合成(`pr:<owner>/<repo>/<number>` 与 `range:<id>`),阶段详情
 * 的地址用它作路径参数。容器 PR 的序号不在这里:它对面板用户透明(CONTEXT.md 容器 PR)。
 */
export type StageItem = {
  stageId: string;
  source: "pull-request" | "range-review";
  owner: string;
  repo: string;
  /** pull request 阶段的 PR 号;范围审查阶段为 null。 */
  pullNumber: number | null;
  /** 范围审查阶段的标识;pull request 阶段为 null。 */
  rangeReviewId: number | null;
  /** pull request 的标题快照;没有标题的旧行与范围审查都是 null。 */
  title: string | null;
  status: "active" | "closed";
  /** 最新一轮 Review Run;范围审查刚发起、一轮都还没跑时为 null。 */
  latestRunId: number | null;
  latestRunAt: string | null;
  /** 最新一轮跑完的时刻;还在跑时为 null,列表据此决定要不要续查。 */
  latestRunFinishedAt: string | null;
  /** 阶段汇总的三个数,与 `GET /stage-summary` 同一口径。 */
  counts: { pending: number; resolved: number; fixed: number };
};

type StagesPage = { stages: StageItem[]; nextOffset: number | null };

/** 列表可按状态与来源筛选,两项默认都是全部(issue #174)。 */
export type StageStatusFilter = "all" | "active" | "closed";
export type StageSourceFilter = "all" | "pull-request" | "range-review";

/**
 * 一行审查阶段的名字:有标题就用标题,没有的显示 `#编号`(issue #173、#174)。
 * pull request 的编号是它的 PR 号,范围审查用它自己的标识——容器 PR 的序号不露面。
 */
export function stageLabel(stage: StageItem): string {
  return stage.title ?? `#${stage.pullNumber ?? stage.rangeReviewId}`;
}

/** 阶段来源。两种来源同列同形,只由这枚标记区分(CONTEXT.md 评审记录)。 */
export function StageSourceBadge({ stage }: { stage: StageItem }) {
  return (
    <Badge color="gray" variant="soft" radius="full">
      {stage.source === "range-review" ? "范围审查" : "pull request"}
    </Badge>
  );
}

/** 阶段只有进行中与已结束两种状态(CONTEXT.md 审查阶段)。 */
export function StageStatusBadge({ stage }: { stage: StageItem }) {
  return stage.status === "active" ? (
    <StatusBadge tone="running">进行中</StatusBadge>
  ) : (
    <StatusBadge tone="neutral" icon={CheckCircledIcon}>已结束</StatusBadge>
  );
}

/**
 * 行上的阶段汇总:待处置 / 人工已处置 / 已修复。三个数一起显示,不打开详情就能判断
 * 优先级;为零的也留着位置,否则三个数的位置会随内容前后错开。
 */
export function StageCounts({ stage }: { stage: StageItem }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-base tabular-nums text-text-muted">
      <span className={stage.counts.pending > 0 ? "text-warning" : undefined}>
        待处置 {stage.counts.pending}
      </span>
      <span aria-hidden>·</span>
      <span>已处置 {stage.counts.resolved}</span>
      <span aria-hidden>·</span>
      <span>已修复 {stage.counts.fixed}</span>
    </span>
  );
}

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
 * 范围审查阶段的重跑(issue #176):在这个阶段当前的比较项上再跑一轮,与 pull request
 * 那条走同一个端点,比较项由服务端从记录里取。
 */
export async function rerunRangeReviewRequest(rangeReviewId: number): Promise<string> {
  const response = await api("/rerun", {
    method: "POST",
    body: JSON.stringify({ rangeReviewId }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return "已在当前比较项上触发新一轮审查";
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

/** 一行的时间:最新一轮什么时候开跑。范围审查刚发起、还没跑过时说清楚是这一档。 */
function latestRunLabel(stage: StageItem): string {
  if (stage.latestRunAt === null) return "还没有跑过";
  return `最新一轮 ${localDay(stage.latestRunAt)} ${localClock(stage.latestRunAt)}`;
}

/** 筛选控件的一档。 */
function FilterControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
}) {
  return (
    <SegmentedControl.Root
      value={value}
      onValueChange={(next) => {
        const hit = options.find(([id]) => id === next);
        if (hit !== undefined) onChange(hit[0]);
      }}
      size={{ initial: "3", sm: "1" }}
      aria-label={label}
      className="w-fit max-sm:w-full"
    >
      {options.map(([id, text]) => (
        <SegmentedControl.Item key={id} value={id}>
          {text}
        </SegmentedControl.Item>
      ))}
    </SegmentedControl.Root>
  );
}

const STATUS_OPTIONS = [
  ["all", "全部"],
  ["active", "进行中"],
  ["closed", "已结束"],
] as const satisfies readonly (readonly [StageStatusFilter, string])[];

const SOURCE_OPTIONS = [
  ["all", "全部来源"],
  ["pull-request", "pull request"],
  ["range-review", "范围审查"],
] as const satisfies readonly (readonly [StageSourceFilter, string])[];

/** 阶段列表的查询串。筛选与分页都在服务端做,这里只负责把它们拼准。 */
export function stagesPath(query: {
  offset: number;
  status?: StageStatusFilter;
  source?: StageSourceFilter;
  owner?: string;
  repo?: string;
}): string {
  const params = new URLSearchParams();
  if (query.offset > 0) params.set("offset", String(query.offset));
  if (query.status !== undefined && query.status !== "all") params.set("status", query.status);
  if (query.source !== undefined && query.source !== "all") params.set("source", query.source);
  if (query.owner !== undefined && query.repo !== undefined) {
    params.set("owner", query.owner);
    params.set("repo", query.repo);
  }
  const search = params.toString();
  return search === "" ? "/stages" : `/stages?${search}`;
}

export function RunsPage({
  canRerun,
  canCreate,
}: {
  canRerun: boolean;
  /** 「评审 · 发起」才看得见页头的发起范围审查入口(issue #177)。 */
  canCreate: boolean;
}) {
  const navigate = useNavigate();
  /*
   * 筛选记在地址里:链接要能指明列表的哪一片。筛选切换用 replace,否则点几下分段控件
   * 就把历史塞满。点开一行是跳到那个阶段自己的地址(issue #175),列表页不再开抽屉。
   */
  const filter = useRouterState({
    select: (state) => {
      const search = state.location.search as { status?: unknown; source?: unknown };
      return {
        status: (search.status === "active" || search.status === "closed"
          ? search.status
          : "all") as StageStatusFilter,
        source: (search.source === "pull-request" || search.source === "range-review"
          ? search.source
          : "all") as StageSourceFilter,
      };
    },
  });
  const setFilter = (next: Partial<{ status: StageStatusFilter; source: StageSourceFilter }>) => {
    void navigate({
      to: "/runs",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(next.status === undefined ? {} : { status: next.status === "all" ? undefined : next.status }),
        ...(next.source === undefined ? {} : { source: next.source === "all" ? undefined : next.source }),
      }),
      replace: true,
    });
  };
  const stages = useInfiniteQuery({
    queryKey: ["stages", filter.status, filter.source],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchJson<StagesPage>(
        stagesPath({ offset: pageParam, status: filter.status, source: filter.source }),
      ),
    getNextPageParam: (last) => last.nextOffset,
    /*
     * 审查是异步的:推一个 pull request 之后要跑上几分钟。还有轮次没跑完时自动续查,
     * 跑完就停——否则人只能盯着页面反复点刷新,而这恰恰是最想看结果的那几分钟。
     */
    refetchInterval: (query) =>
      (query.state.data?.pages ?? []).some((page) =>
        page.stages.some((stage) => stage.latestRunId !== null && stage.latestRunFinishedAt === null),
      )
        ? 10_000
        : false,
  });
  // 发起范围审查的结果就落在页头下面这一条提示里(issue #177)。
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  // 滚到底部附近自动加载下一页。
  const sentinel = useRef<HTMLDivElement>(null);
  const listViewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (
        stages.hasNextPage &&
        !stages.isFetchingNextPage &&
        entries.some((entry) => entry.isIntersecting)
      ) {
        void stages.fetchNextPage();
      }
    }, { root: listViewport.current, rootMargin: "0px 0px 160px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [stages.fetchNextPage, stages.hasNextPage, stages.isFetchingNextPage]);

  const flat = stages.data?.pages.flatMap((page) => page.stages) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBody width="wide" className="min-h-0 flex-1 pb-4 sm:pb-4">
        <PageHeader
          title="评审记录"
          // 读取中不占位说明:计数一到就替换掉,那一行字只会闪一下。
          {...(stages.isPending
            ? {}
            : { description: `已加载 ${flat.length} 个审查阶段` })}
          actions={
            <>
              <SummaryRate />
              {canCreate ? (
                <RangeReviewLaunch
                  onLaunched={(text) => setFeedback({ text, isError: false })}
                />
              ) : null}
            </>
          }
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
        {stages.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(stages.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <FilterControl
            label="按状态过滤"
            value={filter.status}
            options={STATUS_OPTIONS}
            onChange={(status) => setFilter({ status })}
          />
          <FilterControl
            label="按来源过滤"
            value={filter.source}
            options={SOURCE_OPTIONS}
            onChange={(source) => setFilter({ source })}
          />
        </div>

        <div
          ref={listViewport}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
          aria-busy={stages.isPending || stages.isFetchingNextPage}
          aria-label="评审记录列表"
        >
          {stages.isPending ? (
            <div
              className="flex flex-col gap-2 overflow-hidden rounded-lg border border-card-line bg-surface p-2 shadow-card"
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">正在加载评审记录</span>
              {[0, 1, 2, 3].map((slot) => <Skeleton key={slot} className="h-14" />)}
            </div>
          ) : null}

          {flat.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
              {flat.map((stage) => (
                // 点一行是进这个阶段自己的地址(issue #175):详情能直接分享,后退键回到列表。
                <MasterListItem key={stage.stageId} selected={false} asChild>
                  <Link
                    to="/stages/$stageId"
                    params={{ stageId: stage.stageId }}
                    className="group flex items-center gap-3 border-t border-line px-5 py-3 first:border-t-0"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-lg font-semibold">
                          {stage.owner}/{stage.repo} {stageLabel(stage)}
                        </span>
                        <StageSourceBadge stage={stage} />
                      </span>
                      <span className="flex flex-wrap items-center gap-x-1.5 text-base font-normal text-text-muted">
                        <span className="tabular-nums">{latestRunLabel(stage)}</span>
                      </span>
                    </span>
                    {/* 三个数在窄屏让位给状态徽章:390px 下它们会把标题挤成两个字。 */}
                    <span className="max-sm:hidden"><StageCounts stage={stage} /></span>
                    <span className="shrink-0"><StageStatusBadge stage={stage} /></span>
                  </Link>
                </MasterListItem>
              ))}
            </div>
          ) : null}

          {flat.length === 0 && !stages.isPending && !stages.isError ? (
            <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
              <EmptyState
                title={
                  filter.status === "all" && filter.source === "all"
                    ? "暂无审查记录"
                    : "没有符合条件的审查记录"
                }
                titleAs="h2"
                description={
                  filter.status === "all" && filter.source === "all" ? (
                    <>
                      向已注册仓库提交 pull request 后，系统会自动运行审查。
                      {canRerun ? "如需对已有 pull request 重新运行审查，请到仓库页选择仓库并输入 PR 编号。" : null}
                    </>
                  ) : (
                    "换一个状态或来源再看。"
                  )
                }
                action={
                  canRerun && filter.status === "all" && filter.source === "all" ? (
                    <Button variant="outline" color="gray" size={{ initial: "4", sm: "1" }} asChild>
                      <Link to="/repos">去仓库页</Link>
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : null}
          <div ref={sentinel} />
          <p className="pt-3 text-center text-sm text-text-muted" aria-live="polite">
            {stages.isFetchingNextPage
              ? "加载更早的审查记录…"
              : stages.hasNextPage
                ? "继续下滑加载更早的审查记录"
                : flat.length > 0
                  ? "已加载全部记录"
                  : ""}
          </p>
        </div>
      </PageBody>
    </div>
  );
}
