import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { CheckCircledIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, SegmentedControl, Select, Skeleton } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localClock, localDay } from "@/lib/time";
import { cn } from "@/lib/utils";

import { api, errorText, fetchJson } from "./api.ts";
import { RangeReviewLaunch } from "./range-review-launch.tsx";
import {
  RegisterRepo,
  RepoRowMenu,
  RerunPullRequest,
  type RepoRow,
} from "./repo-actions.tsx";
import { RepoRules } from "./repo-rules.tsx";
import { clearPanelSession } from "./session.ts";
import { SummaryRate } from "./stats.tsx";

/** 一轮或一个 Reviewer 的 token 用量。运行诊断信息,不折算金额(issue #188)。 */
export type UsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

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
  /** 发起这一轮时附的本轮指令(issue #225);null 即没有附。只属于这一轮。 */
  directive: string | null;
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
  /** 人工处置掉的 Finding 条数。 */
  resolved: number;
  /** 「已修复」自动处置掉的 Finding 条数。 */
  fixed: number;
  total: number;
};

/** 已处置的 Finding 条数:人工与自动都算。进度与状态一律按它判。 */
function disposedCount(run: { resolved: number; fixed: number }): number {
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
  /**
   * 行作者(CONTEXT.md):这条 Finding 所在行在它那一轮的 head 上最后一次改动的 git
   * author 与那次提交。判不出来为 null,面板显示「无法追溯」。
   *
   * `adjacent` 即相邻改动(issue #241):落点这一行本身这一轮没改,作者取自同一个 hunk
   * 内离它最近的那处改动。
   */
  lineAuthor: {
    sha: string;
    name: string;
    email: string;
    authoredAt: string;
    adjacent: boolean;
  } | null;
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
      <span className={`whitespace-nowrap ${stage.counts.pending > 0 ? "text-warning" : ""}`}>
        待处置 {stage.counts.pending}
      </span>
      <span aria-hidden>·</span>
      <span className="whitespace-nowrap">已处置 {stage.counts.resolved}</span>
      <span aria-hidden>·</span>
      <span className="whitespace-nowrap">已修复 {stage.counts.fixed}</span>
    </span>
  );
}

/**
 * 范围审查阶段的重跑(issue #176):在这个阶段当前的比较项上再跑一轮,与 pull request
 * 那条走同一个端点,比较项由服务端从记录里取。
 */
export async function rerunRangeReviewRequest(
  rangeReviewId: number,
  /** 本轮指令(issue #225),非必填:留空即不带这一格。 */
  directive?: string,
): Promise<string> {
  const response = await api("/rerun", {
    method: "POST",
    body: JSON.stringify({ rangeReviewId, ...(directive === undefined ? {} : { directive }) }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return "已在当前比较项上触发新一轮审查";
}

/**
 * 一轮审查的结论。评审记录与阶段页共用这一份映射——同一轮在两处显示成不同的词,
 * 读的人得先确认那是不是同一件事。
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
  if (stage.latestRunAt === null) return "尚无 Review Run";
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
function stagesPath(query: {
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

function since(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * 「全部仓库」在窄视口那个 Select 里的取值。不能是空串:Radix 在受控值换档时会用空串
 * 回调一次,那一次要认得出来并且不动地址。取值不带斜杠,也就撞不上任何 `owner/repo`。
 */
const ALL_REPOS = "all";

type Repository = { owner: string; repo: string };

function repositoryValue(row: Repository): string {
  return `${row.owner}/${row.repo}`;
}

/** 左栏每行仓库名下面的那行小字:最近一次审查在什么时候,没跑过就直说没跑过。 */
function repoActivityLabel(row: RepoRow): string {
  return row.lastActivity === null ? "尚无 Review Run" : `最近 ${since(row.lastActivity)}`;
}

/** 行操作菜单与注册按钮共用的一组回调:两处做的都是仓库注册表上的写动作(issue #195)。 */
type RepoAdmin = {
  /** `repo:write`。没有它时注册按钮与行操作菜单都不出现。 */
  canWrite: boolean;
  canReadModels: boolean;
  onFeedback: (feedback: { text: string; isError: boolean }) => void;
  onRegistered: (repo: Repository) => void;
  onRemoved: (repo: Repository) => void;
};

/**
 * 首页左栏:这个账号可见的仓库,首项是「全部仓库」。它是右栏的过滤条件,不是第二份
 * 列表(CONTEXT.md 评审记录),所以选中项只写进地址上的一对 `owner` + `repo`。
 *
 * 顶上是「注册仓库」,每行右上角是「…」行操作(issue #195),两处都按 `repo:write` 出现。
 */
function RepoSidebar({
  repos,
  isPending,
  selected,
  onSelect,
  admin,
}: {
  repos: readonly RepoRow[];
  isPending: boolean;
  selected: Repository | null;
  onSelect: (next: Repository | null) => void;
  admin: RepoAdmin;
}) {
  return (
    <aside
      aria-label="仓库"
      aria-busy={isPending}
      className="flex w-[264px] shrink-0 flex-col gap-2.5 overflow-y-auto overscroll-y-contain max-lg:hidden"
    >
      {admin.canWrite ? (
        <RegisterRepo onRegistered={admin.onRegistered} className="w-full" />
      ) : null}
      <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
        {isPending ? (
          <div className="flex flex-col gap-2 px-4 py-3" role="status" aria-live="polite">
            <span className="sr-only">正在读取仓库</span>
            {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-9" />)}
          </div>
        ) : (
          <ul>
            <li>
              <MasterListItem
                selected={selected === null}
                className="block px-4 py-3 data-[selected=false]:font-medium"
                onClick={() => onSelect(null)}
              >
                <span className="block text-lg">全部仓库</span>
              </MasterListItem>
            </li>
            {repos.map((row) => (
              // 「…」压在行上而不是排进行内容:行本身是一个按钮,按钮里套不了按钮。
              <li key={row.repoId} className="relative border-t border-line">
                <MasterListItem
                  selected={selected !== null && selected.owner === row.owner && selected.repo === row.repo}
                  className={cn(
                    "block px-4 py-3 data-[selected=false]:font-medium",
                    admin.canWrite && "pr-12",
                  )}
                  onClick={() => onSelect({ owner: row.owner, repo: row.repo })}
                >
                  <span className="block break-all text-lg">
                    {row.owner}/{row.repo}
                  </span>
                  <MasterListItemText className="mt-px block text-sm font-normal">
                    {repoActivityLabel(row)}
                  </MasterListItemText>
                  {row.worktree.state === "ready" ? null : (
                    <span className="mt-1.5 block">
                      <StatusBadge tone="warning">工作副本未就绪</StatusBadge>
                    </span>
                  )}
                </MasterListItem>
                {admin.canWrite ? (
                  <RepoRowMenu
                    repo={row}
                    canReadModels={admin.canReadModels}
                    onFeedback={admin.onFeedback}
                    onRemoved={() => admin.onRemoved({ owner: row.owner, repo: row.repo })}
                    className="absolute top-2 right-2"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** 窄视口下左栏折叠成的仓库选择器。切换写的是同一份地址参数。 */
function RepoSelect({
  repos,
  selected,
  onSelect,
}: {
  repos: readonly RepoRow[];
  selected: Repository | null;
  onSelect: (next: Repository | null) => void;
}) {
  return (
    <Select.Root
      size="3"
      value={selected === null ? ALL_REPOS : repositoryValue(selected)}
      onValueChange={(next) => {
        if (next === ALL_REPOS) return onSelect(null);
        // 取值是 `owner/repo`,owner 不含斜杠,所以按第一个斜杠切开。认不出的取值一律
        // 不动地址——Radix 在受控值换档时会多回调一次空串。
        const slash = next.indexOf("/");
        if (slash > 0) onSelect({ owner: next.slice(0, slash), repo: next.slice(slash + 1) });
      }}
    >
      <Select.Trigger aria-label="按仓库过滤" className="min-w-0 flex-1" />
      <Select.Content position="popper">
        <Select.Item value={ALL_REPOS}>全部仓库</Select.Item>
        {repos.map((row) => (
          <Select.Item key={row.repoId} value={repositoryValue(row)}>
            {row.owner}/{row.repo}
            {row.worktree.state === "ready" ? null : " · 工作副本未就绪"}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

export function RunsPage({
  canRerun,
  canCreate,
  canWrite,
  canWriteRules,
  canReadModels,
  unassigned,
}: {
  /** 「评审 · 重跑」才看得见右栏头部的重跑 PR(issue #195)。 */
  canRerun: boolean;
  /** 「评审 · 发起」才看得见右栏头部的发起范围审查入口(issue #177、#195)。 */
  canCreate: boolean;
  /** 「仓库 · 写入」才看得见左栏顶部的注册按钮与每行的行操作菜单(issue #195)。 */
  canWrite: boolean;
  /** 「评审 · 知识治理」才在知识集弹窗里看得见手工增删改(issue #203)。 */
  canWriteRules: boolean;
  /** 配置弹窗里「跟随全局」跟的是审查策略,读它要「模型 · 读取」。 */
  canReadModels: boolean;
  /** 一个仓库都没分到的普通用户:两栏换成一段让他联系管理员的说明(issue #194)。 */
  unassigned: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  /*
   * 三个筛选都记在地址里:链接要能指明列表的哪一片。筛选切换用 replace,否则点几下分段
   * 控件就把历史塞满。点开一行是跳到那个阶段自己的地址(issue #175),列表页不再开抽屉。
   * 仓库那一档是一对 owner + repo(issue #189):只给半个键服务端会 400,所以两个都在
   * 才算数——左栏、窄视口那个 Select 与阶段页的返回写的都是这一对。
   */
  const filter = useRouterState({
    select: (state) => {
      const search = state.location.search as {
        status?: unknown;
        source?: unknown;
        owner?: unknown;
        repo?: unknown;
      };
      const owner = typeof search.owner === "string" && search.owner !== "" ? search.owner : null;
      const repo = typeof search.repo === "string" && search.repo !== "" ? search.repo : null;
      return {
        status: (search.status === "active" || search.status === "closed"
          ? search.status
          : "all") as StageStatusFilter,
        source: (search.source === "pull-request" || search.source === "range-review"
          ? search.source
          : "all") as StageSourceFilter,
        repository: owner === null || repo === null ? null : { owner, repo },
      };
    },
  });
  const setFilter = (next: Partial<{ status: StageStatusFilter; source: StageSourceFilter }>) => {
    void navigate({
      to: "/",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(next.status === undefined ? {} : { status: next.status === "all" ? undefined : next.status }),
        ...(next.source === undefined ? {} : { source: next.source === "all" ? undefined : next.source }),
      }),
      replace: true,
    });
  };
  // 左栏与窄视口 Select 写的是同一份地址参数:「全部仓库」即这两个键都不在。
  const selectRepository = (next: Repository | null) => {
    void navigate({
      to: "/",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        owner: next?.owner,
        repo: next?.repo,
      }),
      replace: true,
    });
  };
  const clearFilters = () => {
    void navigate({
      to: "/",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        status: undefined,
        source: undefined,
        owner: undefined,
        repo: undefined,
      }),
      replace: true,
    });
  };
  // 阶段页的返回要回到这一片列表,所以进去时把当前过滤原样带上(issue #189)。
  const carried: Record<string, string> = {
    ...(filter.status === "all" ? {} : { status: filter.status }),
    ...(filter.source === "all" ? {} : { source: filter.source }),
    ...(filter.repository === null ? {} : filter.repository),
  };
  const stages = useInfiniteQuery({
    queryKey: [
      "stages",
      filter.status,
      filter.source,
      filter.repository?.owner ?? null,
      filter.repository?.repo ?? null,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchJson<StagesPage>(
        stagesPath({
          offset: pageParam,
          status: filter.status,
          source: filter.source,
          ...(filter.repository ?? {}),
        }),
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
  // 左栏读的是 `GET /repos`,它已经按仓库分配收窄、按最近活动倒序(issue #194)。
  const repos = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RepoRow[]>("/repos"),
    enabled: !unassigned,
    // 还有仓库的工作副本在后台备(issue #184)就每 5 秒续查,全部有结果即停。
    refetchInterval: (query) =>
      (query.state.data ?? []).some((row) => row.worktree.state === "preparing")
        ? 5_000
        : false,
  });
  // 发起、重跑与行操作的结果都落在页头下面这一条提示里(issue #177、#195)。
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
  const unfiltered =
    filter.status === "all" && filter.source === "all" && filter.repository === null;
  const rows = repos.data ?? [];
  // 行操作要的是这一行的全部字段(模型覆盖、代次、工作副本),地址上只有 owner 与 repo。
  const selected = filter.repository;
  const selectedRow =
    selected === null
      ? undefined
      : rows.find((row) => row.owner === selected.owner && row.repo === selected.repo);
  const admin: RepoAdmin = {
    canWrite,
    canReadModels,
    onFeedback: setFeedback,
    onRegistered: (repo) => {
      setFeedback({
        text: `已注册 ${repo.owner}/${repo.repo}。先在「知识集」里完成知识确认,该仓库的审查才会开始。`,
        isError: false,
      });
      selectRepository(repo);
      // 自己注册的仓库自动分配给自己(issue #192),而 `repoIds` 是登录时的那一份快照:
      // 不重新探测的话,零分配的仓库维护者注册完仍停在那段空态上。
      if (unassigned) {
        clearPanelSession();
        void router.invalidate();
      }
    },
    // 移除的正是当前选中的那个仓库时退回「全部仓库」:它的过滤条件已经不存在了。
    onRemoved: (repo) => {
      setFeedback({ text: `已移除 ${repo.owner}/${repo.repo}。`, isError: false });
      if (
        filter.repository !== null &&
        filter.repository.owner === repo.owner &&
        filter.repository.repo === repo.repo
      ) {
        selectRepository(null);
      }
    },
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBody width="wide" className="min-h-0 flex-1 pb-4 sm:pb-4">
        <PageHeader
          title="评审记录"
          // 读取中不占位说明:计数一到就替换掉,那一行字只会闪一下。
          {...(stages.isPending
            ? {}
            : { description: `已加载 ${flat.length} 个审查阶段` })}
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
        {stages.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(stages.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        {unassigned ? (
          <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
            <EmptyState
              title="尚未分配仓库"
              titleAs="h2"
              description="评审记录的可见范围由仓库分配决定。请联系系统管理员为该账号分配负责的仓库。"
              // 注册按钮照 `repo:write` 出现:自己注册的仓库自动分配给自己(issue #192),
              // 一个仓库都没分到的仓库维护者靠它走出这个空态(issue #195)。
              action={
                canWrite ? (
                  <RegisterRepo onRegistered={admin.onRegistered} className="w-fit" />
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-[18px]">
            <RepoSidebar
              repos={rows}
              isPending={repos.isPending}
              selected={selected}
              onSelect={selectRepository}
              admin={admin}
            />
            {/* 窄视口下左栏折叠成这一行:选择器加它旁边的行操作菜单(issue #195)。 */}
            <div className="flex items-center gap-2 lg:hidden">
              <RepoSelect repos={rows} selected={selected} onSelect={selectRepository} />
              {canWrite ? (
                <RegisterRepo onRegistered={admin.onRegistered} className="shrink-0" />
              ) : null}
              {canWrite && selectedRow !== undefined ? (
                <RepoRowMenu
                  repo={selectedRow}
                  canReadModels={canReadModels}
                  onFeedback={setFeedback}
                  onRemoved={() => admin.onRemoved(selectedRow)}
                />
              ) : null}
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {/* 右栏头部:左边是两个筛选,右边是这个仓库上的动作。选「全部仓库」时
                  两个动作都不出现——它们要一个具体的仓库(issue #195)。 */}
              <div className="flex flex-wrap items-center gap-2">
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
                {selected !== null && (selectedRow !== undefined || canCreate || canRerun) ? (
                  <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                    {/* 知识集登录加仓库分配即可看(ADR 0019),按钮不跟着写权限出现;
                        弹窗里手工增删改那三个入口按 `knowledge:write` 出现(issue #203)。 */}
                    {selectedRow === undefined ? null : (
                      <RepoRules repo={selectedRow} canWrite={canWriteRules} />
                    )}
                    {canCreate ? (
                      <RangeReviewLaunch
                        repo={selected}
                        onLaunched={(text) => setFeedback({ text, isError: false })}
                      />
                    ) : null}
                    {canRerun ? (
                      <RerunPullRequest repo={selected} onFeedback={setFeedback} />
                    ) : null}
                  </div>
                ) : null}
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
                      // 当前过滤跟着进去,阶段页那个返回才回得到同一片列表(issue #189)。
                      <MasterListItem key={stage.stageId} selected={false} asChild>
                        <Link
                          to="/stages/$stageId"
                          params={{ stageId: stage.stageId }}
                          search={carried}
                          className="group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-t border-line px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-5"
                        >
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="min-w-0 break-all font-mono text-sm text-text-muted">
                                {stage.owner}/{stage.repo}
                              </span>
                              <StageSourceBadge stage={stage} />
                            </span>
                            <span className="break-words text-lg font-semibold">
                              {stageLabel(stage)}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-1.5 text-base font-normal text-text-muted">
                              <span className="tabular-nums">{latestRunLabel(stage)}</span>
                            </span>
                            <span className="mt-0.5 sm:hidden"><StageCounts stage={stage} /></span>
                          </span>
                          <span className="hidden sm:block"><StageCounts stage={stage} /></span>
                          <span className="shrink-0"><StageStatusBadge stage={stage} /></span>
                        </Link>
                      </MasterListItem>
                    ))}
                  </div>
                ) : null}

                {flat.length === 0 && !stages.isPending && !stages.isError ? (
                  <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
                    <EmptyState
                      title={unfiltered ? "暂无评审记录" : "没有符合条件的评审记录"}
                      titleAs="h2"
                      description={
                        unfiltered ? (
                          <>
                            向已注册仓库提交 pull request 后，系统会自动运行审查。
                            {canRerun ? "如需对已有 pull request 重新运行审查，在左栏选中它的仓库后输入 PR 编号。" : null}
                          </>
                        ) : (
                          "请更改仓库、状态或来源筛选条件。"
                        )
                      }
                      action={unfiltered ? undefined : (
                        <Button
                          type="button"
                          variant="outline"
                          color="gray"
                          size={{ initial: "4", sm: "1" }}
                          onClick={clearFilters}
                        >
                          清除筛选
                        </Button>
                      )}
                    />
                  </div>
                ) : null}
                <div ref={sentinel} />
                <p className="pt-3 text-center text-sm text-text-muted" aria-live="polite">
                  {stages.isFetchingNextPage
                    ? "加载更早的评审记录…"
                    : stages.hasNextPage
                      ? "向下滚动以加载更早的评审记录"
                      : flat.length > 0
                        ? "已加载全部评审记录"
                        : ""}
                </p>
              </div>
            </div>
          </div>
        )}
      </PageBody>
    </div>
  );
}
