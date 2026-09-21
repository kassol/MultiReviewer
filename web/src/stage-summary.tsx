import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type MouseEventHandler } from "react";

import { ChevronDownIcon, CrossCircledIcon, FileTextIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Select, Skeleton, Tabs, Text, TextArea } from "@radix-ui/themes";
import { Collapsible } from "radix-ui";

import { CommitChip } from "@/components/commit-chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { FilePath } from "@/components/file-path";
import { Button } from "@/components/theme-button";
import { TAB_TRIGGER } from "@/components/tab-trigger";
import { disposableInGroup, foldByRootCause } from "@/lib/root-cause";
import { firstReportedFrom, roundFilterOptions, roundNumbers } from "@/lib/stage-rounds";
import { localMinute } from "@/lib/time";

import { fetchJson, send } from "./api.ts";
import { FindingBadges, FindingRow } from "./run-diff.tsx";

/**
 * 一个审查阶段(CONTEXT.md 审查阶段):范围审查那条按它自己的 id 取,pull request
 * 那条按 owner / repo / 序号取。两条链路读同一个接口、显示成同一个样子。
 */
export type StageScope =
  | { kind: "range-review"; rangeReviewId: number }
  | { kind: "pull-request"; owner: string; repo: string; pullNumber: number };

/*
 * 阶段汇总整份响应与时间线那一轮都是契约(issue #426、#429),从 `src/contracts/` 引来
 * 再导出:面板读的与服务端投影出去的是同一个符号。汇总里的那条 Finding 在这一页沿用
 * `StageFinding` 这个名字,来源沿用 `TriggerSource`。
 */
import type {
  ReviewTriggerSource as TriggerSource,
  StageTimelineEntry,
} from "../../src/contracts/stages.ts";
import type {
  StageSummary as StageSummaryBody,
  StageSummaryFinding as StageFinding,
} from "../../src/contracts/stage-summary.ts";

export type { StageFinding, StageSummaryBody, StageTimelineEntry, TriggerSource };

/** 时间线上每一轮的来源标签。三档都标:只标其中一档,另外两档就得靠人猜。 */
const TRIGGER_SOURCE_LABEL: Record<TriggerSource, string> = {
  delivery: "投递",
  panel: "面板",
  scheduled: "定时检查",
};

/**
 * 阶段详情地址上的那个标识(issue #175),与 `GET /stages` 行上的 `stageId` 同一格式:
 * 一个阶段在列表、地址与接口三处是同一个名字。
 */
export function stageIdOf(scope: StageScope): string {
  return scope.kind === "range-review"
    ? `range:${scope.rangeReviewId}`
    : `pr:${scope.owner}/${scope.repo}/${scope.pullNumber}`;
}

function scopePath(scope: StageScope): string {
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
function stageSummaryKey(scope: StageScope): (string | number)[] {
  return scope.kind === "range-review"
    ? ["stage-summary", "range-review", scope.rangeReviewId]
    : ["stage-summary", "pull-request", scope.owner, scope.repo, scope.pullNumber];
}

/**
 * 一个审查阶段的当前状态。阶段页的正文与 Finding 侧滑读的是同一份(issue #189):
 * 侧滑要的「这条 Finding 在哪个文件、同文件还有哪几条」就在这份里,查询键相同,
 * React Query 因此只发一次请求,两处看到的也永远是同一批行。
 */
export function useStageSummary(scope: StageScope) {
  return useQuery({
    queryKey: stageSummaryKey(scope),
    queryFn: () => fetchJson<StageSummaryBody>(scopePath(scope)),
    // 还有轮次没跑完就每 10 秒续查,全部结束即停:人最想看结果的正是这几分钟。
    refetchInterval: (query) =>
      (query.state.data?.timeline ?? []).some((entry) => entry.finishedAt === null)
        ? 10_000
        : false,
  });
}

/** 阶段详情正文的两页(issue #236):Finding 列表与时间线。 */
export type StageTab = "findings" | "timeline";

type DispositionFilter = "all" | "pending" | "resolved" | "fixed";

const DISPOSITION_LABEL: Record<Exclude<DispositionFilter, "all">, string> = {
  pending: "待处置",
  resolved: "人工已处置",
  fixed: "已修复",
};

/** 三个计数前的状态点:待处置是要人动手的那一档,已修复是成了的那一档。 */
const COUNT_DOT: Record<Exclude<DispositionFilter, "all">, string> = {
  pending: "bg-warning-icon",
  resolved: "bg-neutral-dot",
  fixed: "bg-success-icon",
};

type SeverityFilter = "all" | "P0" | "P1" | "P2";

/** 行作者筛选里 `lineAuthor` 为 null 的那一档:与 `run-diff.tsx` 的「无法追溯」同一件事。 */
const UNKNOWN_AUTHOR = "未知";

/** 一条 Finding 现在落在三档里的哪一档。已延续不会出现在汇总里,那不是处置。 */
function bucketOf(finding: StageFinding): Exclude<DispositionFilter, "all"> {
  if (finding.disposition === "fixed") return "fixed";
  if (finding.disposition === "resolved") return "resolved";
  return "pending";
}

/**
 * 列表里的一条 Finding:卡头是侧滑入口,卡身是与轮次页共用的那张 Finding 卡。
 * 组卡里的成员用的是同一个组件——入组不改变一条 Finding 的任何事实(ADR 0030)。
 */
function FindingCard({
  finding,
  scope,
  canDispose,
  roundOf,
  onDrawerTrigger,
}: {
  finding: StageFinding;
  scope: StageScope;
  canDispose: boolean;
  roundOf: Map<number, number>;
  onDrawerTrigger?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    // 几百张卡一次全渲染:屏幕外的由浏览器跳过布局与绘制,预留高度渲染过一次后改用实测值。
    <section className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control [contain-intrinsic-size:auto_320px] [content-visibility:auto]">
      {/*
        点一条 Finding 就在侧滑里看它的 diff(issue #189):卡头整块是那个入口,
        地址上多一个 `finding=`,关掉侧滑就回到这一页本身。
      */}
      <Link
        to="/stages/$stageId"
        params={{ stageId: stageIdOf(scope) }}
        search={(prev: Record<string, unknown>) => ({
          ...prev,
          finding: finding.id,
          trace: undefined,
        })}
        replace
        onClick={onDrawerTrigger}
        aria-label={`查看 ${finding.file}:${finding.line} 对应的代码差异`}
        className="group block px-4 pt-3 pb-2.5 outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {/* 等级排在最前:几百条里往下扫,先看到的是轻重,再是哪个文件。窄屏上路径独占第二
            行(order 调到入口之后),不被徽章与入口夹成三行。 */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex shrink-0 items-center gap-1.5">
            <FindingBadges finding={finding} />
          </span>
          <FilePath
            file={finding.file}
            line={finding.line}
            className="order-3 basis-full text-sm sm:order-none sm:flex-1 sm:basis-0"
          />
          {/* 入口写出名字:光一颗图标看不出点了是开侧滑。窄屏只留图标。 */}
          <span
            className="ml-auto inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md bg-accent-tint-strong px-1.5 text-sm font-medium text-primary transition-colors group-hover:bg-accent-track"
            aria-hidden
          >
            <FileTextIcon />
            <span className="hidden sm:inline">代码差异</span>
          </span>
        </span>
        {finding.title === "" ? null : (
          <span
            className={`block pt-1.5 text-lg font-semibold break-words ${
              bucketOf(finding) === "pending" ? "" : "text-text-secondary line-through"
            }`}
          >
            {finding.title}
          </span>
        )}
        <span className="block pt-1 text-sm text-text-secondary tabular-nums">
          第 {roundOf.get(finding.firstRunId) ?? "?"} 轮首次报出 · 第{" "}
          {roundOf.get(finding.lastRunId) ?? "?"} 轮最近一次 ·{" "}
          {localMinute(finding.lastReportedAt)}
        </span>
      </Link>
      <FindingRow finding={finding} canDispose={canDispose} heading={false} />
    </section>
  );
}

/**
 * 「处置整组」(CONTEXT.md 同根因组,issue #309):对组内当前未处置的成员写同一处置与
 * 备注。走 AlertDialog 与按阈值批量处置同一套弹窗与输入——一次点下去改的是几十条
 * Finding 的处置状态,而两处要人填的东西本来就是同一件(一句处置备注)。
 *
 * 已处置的成员由服务端跳过,不覆盖人已经做过的决定;组内一条未处置都没有时按钮点不动。
 */
function DisposeRootCauseGroupAction({
  scope,
  groupId,
  memberCount,
  pending,
  onFeedback,
}: {
  scope: StageScope;
  groupId: number;
  memberCount: number;
  /** 组内还有未处置成员时才点得动。 */
  pending: boolean;
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const dispose = useMutation({
    mutationFn: async (text: string | undefined) =>
      send<{ disposed: number[]; skipped: number[]; failed: number[] }>(
        `/stages/${encodeURIComponent(stageIdOf(scope))}/root-cause-groups/${groupId}/dispose`,
        "POST",
        text === undefined ? {} : { note: text },
      ),
    onSuccess: (result) => {
      setOpen(false);
      // 备注只属于刚发出去的这一组,留在框里下次会被顺手带上。
      setNote("");
      onFeedback({
        text:
          result.failed.length === 0
            ? `已处置 ${result.disposed.length} 条，跳过已处置的 ${result.skipped.length} 条。`
            : `已处置 ${result.disposed.length} 条，${result.failed.length} 条失败，可以再点一次重试。`,
        isError: result.failed.length > 0,
      });
      // 处置完的那些立刻从待处置里退出去:计数在详情上,列表在汇总里,两份都失效。
      void queryClient.invalidateQueries({ queryKey: ["stage-detail"] });
      void queryClient.invalidateQueries({ queryKey: ["stage-summary"] });
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="soft"
          color="gray"
          size={{ initial: "3", sm: "2" }}
          disabled={!pending || dispose.isPending}
        >
          处置整组
        </Button>
      }
      title="把这个同根因组里未处置的成员一次处置掉？"
      titleSize="4"
      titleMb="2"
      maxWidth="480px"
      description={
        <>
          这一组有 {memberCount} 处。组内未处置的成员将逐条标记为人工已处置，Forge
          上对应的评论同步 resolve；已处置的成员不动。
        </>
      }
      direction={{ initial: "column-reverse", sm: "row" }}
      cancelLabel="取消"
      cancelVariant="soft"
      confirm={{
        label: dispose.isPending ? "处置中…" : "处置",
        disabled: dispose.isPending,
        onClick: () => {
          onFeedback(null);
          const trimmed = note.trim();
          dispose.mutate(trimmed === "" ? undefined : trimmed);
        },
      }}
    >
      <Text as="label" htmlFor={`root-cause-note-${groupId}`} className="sr-only">
        处置备注
      </Text>
      <TextArea
        id={`root-cause-note-${groupId}`}
        size="2"
        rows={2}
        maxLength={500}
        className="mt-3"
        placeholder="只写为什么不用改（可选，只存面板）；代码已改的留给下一轮评审自动处置"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </ConfirmDialog>
  );
}

/**
 * 一个同根因组的卡片(CONTEXT.md 同根因组,issue #309):标题就是合并 agent 写的那句根因
 * 说明,成员收在里面,默认折起——列表变短而信息不丢。展开之后成员用与组外条目完全相同
 * 的那张卡,入组不改变一条 Finding 的任何呈现。
 *
 * Forge 评论尾行链进来时地址上带 `?rootCause=`(issue #308):那一组开着,并滚到视野正中。
 */
function RootCauseGroupCard({
  scope,
  group,
  defaultOpen,
  focused,
  canDispose,
  canDisposeBatch,
  pending,
  roundOf,
  onFeedback,
  onDrawerTrigger,
}: {
  scope: StageScope;
  group: { id: number; reason: string; memberCount: number; members: StageFinding[] };
  defaultOpen: boolean;
  /** 地址指的正是这一组:首次渲染滚到它。 */
  focused: boolean;
  canDispose: boolean;
  canDisposeBatch: boolean;
  pending: boolean;
  roundOf: Map<number, number>;
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
  onDrawerTrigger?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    // 卡片比视口高,居中会把根因说明与「处置整组」滚出视野,落点要停在卡头。
    if (focused) card.current?.scrollIntoView({ block: "start" });
  }, [focused]);

  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      // 背景是模板字符串拼接、未经 cn/twMerge 去重:两个 bg-* 都写进类名时由编译后 CSS 的顺序决定胜负,
      // 因此每种状态只留一个背景类,写法与下面 counts 按钮那处二选一分支一致。
      className={`group/root-cause overflow-hidden rounded-lg border shadow-control ${
        focused ? "border-primary bg-accent-tint" : "border-overlay-line bg-surface"
      }`}
      asChild
    >
      <section
        ref={card}
        aria-label={`同根因组：${group.reason}`}
        // 顶栏是 sticky 叠在滚动容器上方的两行毛玻璃(main.tsx 的 TopBar),`block: "start"`
        // 会把卡头贴到视口 y=0,正好钻进顶栏底下。scroll-mt 补出顶栏实际高度,贴顶落点让到它下面。
        className="scroll-mt-[88px]"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5">
          <Collapsible.Trigger
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronDownIcon
              aria-hidden
              className="mt-1 size-4 shrink-0 text-text-secondary transition-transform group-data-[state=open]/root-cause:rotate-180"
            />
            <span className="min-w-0">
              <span className="block text-lg font-semibold break-words">{group.reason}</span>
              <span className="block pt-1 text-sm text-text-secondary tabular-nums">
                同一根因 {group.memberCount} 处
                {group.members.length === group.memberCount
                  ? null
                  : ` · 当前筛选下 ${group.members.length} 处`}
              </span>
            </span>
          </Collapsible.Trigger>
          {canDisposeBatch ? (
            <DisposeRootCauseGroupAction
              scope={scope}
              groupId={group.id}
              memberCount={group.memberCount}
              pending={pending}
              onFeedback={onFeedback}
            />
          ) : null}
        </div>
        <Collapsible.Content className="flex flex-col gap-2 px-2 pb-2">
          {group.members.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              scope={scope}
              canDispose={canDispose}
              roundOf={roundOf}
              {...(onDrawerTrigger === undefined ? {} : { onDrawerTrigger })}
            />
          ))}
        </Collapsible.Content>
      </section>
    </Collapsible.Root>
  );
}

/**
 * 一个审查阶段的主视图(issue #168):顶部三个计数,正文分成 Finding 与时间线两页
 * (issue #236)——一个阶段跑到几百条待处置之后,时间线不该被压在列表底下。
 *
 * 范围审查阶段与 pull request 阶段共用这一份——「这个阶段还剩什么没处置」是同一个
 * 问题,两条链路不该显示成两个样子。
 */
export function StageSummaryView({
  scope,
  canDispose,
  canDisposeBatch,
  focusRootCause,
  tab,
  onTabChange,
  timeline,
  onFeedback,
  onDrawerTrigger,
  onVisibleOrder,
}: {
  scope: StageScope;
  /** 有 `finding:dispose` 权限时行内出现处置动作。 */
  canDispose: boolean;
  /** 有 `finding:dispose-batch` 权限时组卡上出现「处置整组」(issue #309)。 */
  canDisposeBatch: boolean;
  /** 地址上 `?rootCause=` 指的那个组:进来时展开并滚到它。没有即 null。 */
  focusRootCause: number | null;
  /** 组级处置的结果写到页头的那条提示上,与按阈值批量处置同一处。 */
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
  /** 当前在哪一页。tab 记在地址上,由阶段页读写(issue #236)。 */
  tab: StageTab;
  onTabChange: (tab: StageTab) => void;
  /** 时间线怎么摆由页面定:范围审查按比较项分组,PR 那条直接一列。 */
  timeline?: (entries: StageTimelineEntry[]) => React.ReactNode;
  /** 侧滑打开前记录触发链接,关闭后恢复焦点。 */
  onDrawerTrigger?: MouseEventHandler<HTMLAnchorElement>;
  /** 列表此刻从上到下的 Finding id(筛选与同根因折叠之后):侧滑的上一条 / 下一条按它走。 */
  onVisibleOrder?: (ids: number[]) => void;
}) {
  const summary = useStageSummary(scope);
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  const [round, setRound] = useState("all");
  const [lineAuthor, setLineAuthor] = useState("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");

  const findings = summary.data?.findings ?? [];
  const entries = summary.data?.timeline ?? [];
  const authors = [
    ...new Set(findings.map((finding) => finding.lineAuthor?.name ?? UNKNOWN_AUTHOR)),
  ].sort();
  // 轮次序号按这个阶段自己数:一条 Finding「第几轮首次报出」比一个库 id 有意义。
  const roundOf = roundNumbers(entries);
  const visible = findings.filter(
    (finding) =>
      (disposition === "all" || bucketOf(finding) === disposition) &&
      firstReportedFrom(round, finding.firstRunId, roundOf) &&
      (lineAuthor === "all" || (finding.lineAuthor?.name ?? UNKNOWN_AUTHOR) === lineAuthor) &&
      (severity === "all" || finding.severity === severity),
  );
  // 「处置整组」按整组算,不按筛选后看得见的那几条:筛掉的成员照样会被写进去。判据用
  // 服务端跳过的那一份,没有评论载体的成员不算待处置——否则按钮点得动而一条都写不进去。
  const pendingGroups = new Set(
    findings.flatMap((finding) =>
      finding.rootCause !== null && disposableInGroup(finding) ? [finding.rootCause.id] : [],
    ),
  );
  const counts = summary.data?.counts ?? { pending: 0, resolved: 0, fixed: 0 };
  const rows = foldByRootCause(visible);
  // 拼成一个串当依赖:数组每次渲染都是新的,按它报会每次渲染都往上报一遍。
  const order = rows
    .flatMap((row) => (row.kind === "finding" ? [row.finding.id] : row.members.map((m) => m.id)))
    .join(",");
  useEffect(() => {
    onVisibleOrder?.(order === "" ? [] : order.split(",").map(Number));
  }, [order, onVisibleOrder]);

  return (
    <div className="flex flex-col gap-3">
      {summary.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(summary.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {/* 三个计数是这个阶段的进度:待处置在最前,人看的就是它。 */}
      <div className="grid grid-cols-3 gap-2 sm:flex">
        {(
          [
            ["pending", counts.pending],
            ["resolved", counts.resolved],
            ["fixed", counts.fixed],
          ] as const
        ).map(([id, value]) => (
          <button
            key={id}
            type="button"
            aria-pressed={disposition === id}
            // 计数兼任处置状态筛选,筛选只在 Finding 页可见:停在时间线页时点它先切回去,
            // 否则改的是一个看不见的筛选(issue #236)。
            onClick={() => {
              setDisposition(disposition === id ? "all" : id);
              if (tab !== "findings") onTabChange("findings");
            }}
            className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 sm:min-w-40 ${
              disposition === id
                ? "border-primary bg-accent-tint"
                : "border-card-line bg-surface hover:bg-sunken"
            }`}
          >
            <span className="flex items-center gap-1.5 text-sm text-text-secondary">
              <span aria-hidden className={`size-1.5 rounded-full ${COUNT_DOT[id]}`} />
              {DISPOSITION_LABEL[id]}
            </span>
            <span className="font-mono text-3xl font-bold tabular-nums">{value}</span>
          </button>
        ))}
      </div>

      <Tabs.Root value={tab} onValueChange={(next) => onTabChange(next as StageTab)}>
        {/* 与知识集弹窗同一套 tab 语法:3px 圆头指示条,底线通栏。 */}
        <Tabs.List size="2" className="shadow-[inset_0_-1px_0_0_var(--v8-border-chrome)]">
          <Tabs.Trigger value="findings" className={TAB_TRIGGER}>Finding</Tabs.Trigger>
          <Tabs.Trigger value="timeline" className={TAB_TRIGGER}>
            时间线
            <Badge
              color={tab === "timeline" ? "blue" : "gray"}
              variant="soft"
              radius="full"
              size="1"
              className="ml-1.5 tabular-nums"
            >
              {entries.length}
            </Badge>
          </Tabs.Trigger>
        </Tabs.List>

        {/* 三个筛选只属于 Finding 页;筛选值是组件内状态,切到时间线再切回来仍在。 */}
        <Tabs.Content value="findings" className="flex flex-col gap-3 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {/*
              轮次筛选(issue #369):选中第 N 轮即「首次报出在第 N 轮或之后」。每天看一次
              的人要的是这几天新出的那批,与「待处置」叠起来就是当天的工作集。
            */}
            <Select.Root value={round} onValueChange={setRound} size="1">
              <Select.Trigger aria-label="按首次报出轮次筛选" />
              <Select.Content>
                <Select.Item value="all">全部轮次</Select.Item>
                {roundFilterOptions(entries).map((option) => (
                  <Select.Item key={option.value} value={option.value}>{option.label}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Select.Root value={lineAuthor} onValueChange={setLineAuthor} size="1">
              <Select.Trigger aria-label="按行作者筛选" />
              <Select.Content>
                <Select.Item value="all">全部行作者</Select.Item>
                {authors.map((name) => (
                  <Select.Item key={name} value={name}>{name}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Select.Root value={severity} onValueChange={(next) => setSeverity(next as SeverityFilter)} size="1">
              <Select.Trigger aria-label="按问题等级筛选" />
              <Select.Content>
                <Select.Item value="all">全部等级</Select.Item>
                <Select.Item value="P0">P0</Select.Item>
                <Select.Item value="P1">P1</Select.Item>
                <Select.Item value="P2">P2</Select.Item>
              </Select.Content>
            </Select.Root>
            {summary.data === undefined ? null : (
              <span className="text-sm text-text-secondary">
                <span className="font-mono tabular-nums">{visible.length}</span> / {findings.length} 条
              </span>
            )}
            {/* 处置状态由上面三个计数键筛,不在这一排重复一个下拉;四个筛选一处清。 */}
            {disposition === "all" && round === "all" && lineAuthor === "all" && severity === "all" ? null : (
              <Button
                variant="ghost"
                color="gray"
                size={{ initial: "3", sm: "1" }}
                onClick={() => {
                  setDisposition("all");
                  setRound("all");
                  setLineAuthor("all");
                  setSeverity("all");
                }}
              >
                清除筛选
              </Button>
            )}
          </div>

          {summary.isPending ? (
            <div className="flex flex-col gap-2" role="status" aria-live="polite">
              <span className="sr-only">正在加载审查阶段汇总</span>
              {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-16" />)}
            </div>
          ) : null}

          {summary.data !== undefined && findings.length === 0 ? (
            <EmptyState title="当前审查阶段暂无 Finding" className="py-2" />
          ) : null}
          {summary.data !== undefined && findings.length > 0 && visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-card-line px-4 py-6 text-center text-text-secondary">
              没有符合筛选条件的 Finding。
            </p>
          ) : null}

          {rows.map((row) =>
            row.kind === "finding" ? (
              <FindingCard
                key={row.finding.id}
                finding={row.finding}
                scope={scope}
                canDispose={canDispose}
                roundOf={roundOf}
                {...(onDrawerTrigger === undefined ? {} : { onDrawerTrigger })}
              />
            ) : (
              <RootCauseGroupCard
                key={`group-${row.id}`}
                scope={scope}
                group={row}
                defaultOpen={row.id === focusRootCause}
                focused={row.id === focusRootCause}
                canDispose={canDispose}
                canDisposeBatch={canDisposeBatch}
                pending={pendingGroups.has(row.id)}
                roundOf={roundOf}
                onFeedback={onFeedback}
                {...(onDrawerTrigger === undefined ? {} : { onDrawerTrigger })}
              />
            ),
          )}
        </Tabs.Content>

        <Tabs.Content value="timeline" className="flex flex-col gap-3 pt-3">
          {timeline === undefined ? (
            entries.length === 0 ? (
              <EmptyState title="该审查阶段尚无 Review Run" className="py-2" />
            ) : (
              [...entries].reverse().map((entry) => (
                <div key={entry.runId} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 text-base text-text-secondary">
                    <CommitChip sha={entry.headSha} />
                    <span className="tabular-nums">{localMinute(entry.startedAt)}</span>
                  </div>
                  <div className="rounded-lg border border-overlay-line bg-surface px-4 py-2.5 shadow-control">
                    <StageRound entry={entry} />
                  </div>
                </div>
              ))
            )
          ) : (
            timeline(entries)
          )}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

/**
 * 时间线里一轮的几个数(issue #168)。轮次降为历史之后,一轮要说的只剩「它做了什么」:
 * 报出了几条新的、折叠了几条旧的、自动修掉几条、交接几条,以及有几条没拿到结论。
 *
 * 没拿到结论的分三档说(issue #412、#413):模型跑了那一批却没给、那一批没跑成、本轮
 * 没有哪一批读到它那个文件。排障方向不同——头一档看模型,后两档分别看模型服务与覆盖缺口。
 * 升级前的轮次说不出由来,整份落在头一档,与升级前那个总数一致。
 *
 * 为零的不列——读者要的是这一轮做了什么,一排零只让人多数几个零。全零的那一轮
 * 显式写一句,免得看起来像还没渲染出来。
 *
 * 只画内容不画容器:阶段页把它嵌进时间线的行里,平铺那版自己包一张卡。
 */
export function StageRound({ entry }: { entry: StageTimelineEntry }) {
  const cells = (
    [
      ["新报出", entry.reported, "text-text"],
      ["折叠", entry.folded, "text-text-secondary"],
      ["已修复", entry.fixed, "text-success"],
      ["已延续", entry.continued, "text-text-secondary"],
      ["漏复核", entry.missedVerdicts, "text-warning"],
      ["批次没跑成", entry.batchFailedVerdicts, "text-warning"],
      ["本轮没审到", entry.uncoveredVerdicts, "text-warning"],
    ] as const
  ).filter(([, value]) => value > 0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
      {/* 来源(issue #312):这一轮是投递带来的、人点的,还是每日增量自己跑的。 */}
      <Badge color="gray" variant="outline" radius="full">
        {TRIGGER_SOURCE_LABEL[entry.triggerSource]}
      </Badge>
      {/* 只复核那一轮标出来(issue #242):看到「新报 0」时那不是审查空跑。 */}
      {entry.mode !== "verdict-only" ? null : (
        <Badge color="gray" variant="soft" radius="full">
          只复核
        </Badge>
      )}
      {entry.finishedAt === null && !entry.failed ? (
        <span className="text-text-secondary">运行中…</span>
      ) : entry.failed ? (
        <span className="text-danger">本轮 Review Run 失败</span>
      ) : (
        <>
          {/* 收尾失败(issue #256):Reviewer 都跑通了,五个数是真的,只是这一轮没有正常
              收场——与「Reviewer 失败」分开写,读的人才知道 Finding 还在不在。 */}
          {entry.failure === null ? null : <span className="text-danger">本轮收尾失败</span>}
          {cells.length === 0 ? (
            <span className="text-text-secondary">本轮未产生 Finding 状态变化</span>
          ) : (
            cells.map(([label, value, tone]) => (
              <span key={label} className={tone}>
                {label} <span className="font-mono font-bold tabular-nums">{value}</span>
              </span>
            ))
          )}
          {/* 「批次没跑成」与审查轨迹上那一批的「复核结论 N/M」对不上是有意的(issue #420):
              失败的批次在倒下之前给过的结论一律丢掉,库里这几条因此记成没复核,而轨迹如实
              记它给过几条。差额不当面说清会被当成其中一个数算错(issue #425)。写成可见的
              一句而不是 title:触屏上悬停读不到,而这正是排障时要读的那句。 */}
          {entry.batchFailedVerdicts === 0 ? null : (
            <span className="basis-full text-sm text-text-secondary">
              「批次没跑成」的那几条所在的批次半路倒下，那一批即便给过复核结论也不作数，这一轮按没复核记。
            </span>
          )}
        </>
      )}
      {/* 原因整句摊开,列表上就看得到为什么;改判的那一轮与收尾失败的那一轮同一个位置。 */}
      {entry.failure === null ? null : (
        <span className="basis-full break-words text-sm text-text-secondary">{entry.failure}</span>
      )}
    </div>
  );
}
