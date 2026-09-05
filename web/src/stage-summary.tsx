import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type MouseEventHandler } from "react";

import { CheckIcon, ChevronDownIcon, CrossCircledIcon, FileTextIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Popover, Select, Skeleton, Tabs } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/theme-button";
import { TAB_TRIGGER } from "@/components/tab-trigger";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { localMinute } from "@/lib/time";

import { fetchJson } from "./api.ts";
import { type RerunMode } from "./repo-actions.tsx";
import { FindingRow } from "./run-diff.tsx";
import type { RunFinding } from "./runs.tsx";

/**
 * 一个审查阶段(CONTEXT.md 审查阶段):范围审查那条按它自己的 id 取,pull request
 * 那条按 owner / repo / 序号取。两条链路读同一个接口、显示成同一个样子。
 */
export type StageScope =
  | { kind: "range-review"; rangeReviewId: number }
  | { kind: "pull-request"; owner: string; repo: string; pullNumber: number };

/**
 * 阶段汇总里的一条 Finding。字段与 `GET /api/stage-summary` 逐字对应:它是轮次
 * 那份 Finding 投影再加「这条活了多久」——同一条 Finding 在两处显示成同一个样子,
 * 行内处置也走同一个组件。
 */
export type StageFinding = RunFinding & {
  title: string;
  firstRunId: number;
  firstReportedAt: string;
  lastRunId: number;
  lastReportedAt: string;
};

/** 时间线里的一轮:这一轮对这个阶段做了什么。 */
export type StageTimelineEntry = {
  runId: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  /** 轮次级的失败原因(issue #256),与 `RunItem.failure` 同一格;null 即收尾正常。 */
  failure: string | null;
  /** 这一轮的模式(issue #242)。只复核那一轮在时间线上带标记。 */
  mode: RerunMode;
  /** 本轮新报出。 */
  reported: number;
  /** 折叠到本阶段已有的那条上。 */
  folded: number;
  /** 复核判已修、自动记「已修复」。 */
  fixed: number;
  /** 复核判仍在而代码已改写,交接到新位置。 */
  continued: number;
  /** 注入了历史却没给结论的「Reviewer × 历史 Finding」对数。 */
  missedVerdicts: number;
};

export type StageSummaryBody = {
  findings: StageFinding[];
  counts: { pending: number; resolved: number; fixed: number };
  timeline: StageTimelineEntry[];
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
 * 文件筛选:可搜索(输入过滤选项),结构照搬 `commit-picker.tsx` 的 `BranchCombobox`——
 * Popover 里挂 `ui/command`,列表已经整份在内存里,cmdk 自带的过滤就够用,不必再自管
 * 一份 search state。
 */
function FileFilterCombobox({
  value,
  files,
  onChange,
}: {
  value: string;
  files: string[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          type="button"
          variant="surface"
          color="gray"
          highContrast
          size="1"
          className="max-w-56 justify-between gap-1 px-2"
          aria-label="按文件筛选"
        >
          <span className="min-w-0 truncate font-mono">{value === "all" ? "全部文件" : value}</span>
          <ChevronDownIcon aria-hidden className="shrink-0 text-text-muted" />
        </Button>
      </Popover.Trigger>
      <Popover.Content sideOffset={6} align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder="搜索文件" aria-label="搜索文件" />
          <CommandList>
            <CommandEmpty>没有匹配的文件</CommandEmpty>
            <CommandItem
              value="all"
              keywords={["全部文件"]}
              onSelect={() => {
                onChange("all");
                setOpen(false);
              }}
            >
              <CheckIcon aria-hidden className={value === "all" ? "opacity-100" : "opacity-0"} />
              全部文件
            </CommandItem>
            {files.map((file) => (
              <CommandItem
                key={file}
                value={file}
                onSelect={() => {
                  onChange(file);
                  setOpen(false);
                }}
              >
                <CheckIcon aria-hidden className={value === file ? "opacity-100" : "opacity-0"} />
                <span className="min-w-0 truncate break-all font-mono">{file}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </Popover.Content>
    </Popover.Root>
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
  tab,
  onTabChange,
  timeline,
  onDrawerTrigger,
}: {
  scope: StageScope;
  /** 有 `finding:dispose` 权限时行内出现处置动作。 */
  canDispose: boolean;
  /** 当前在哪一页。tab 记在地址上,由阶段页读写(issue #236)。 */
  tab: StageTab;
  onTabChange: (tab: StageTab) => void;
  /** 时间线怎么摆由页面定:范围审查按比较项分组,PR 那条直接一列。 */
  timeline?: (entries: StageTimelineEntry[]) => React.ReactNode;
  /** 侧滑打开前记录触发链接,关闭后恢复焦点。 */
  onDrawerTrigger?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const summary = useStageSummary(scope);
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  const [filePath, setFilePath] = useState("all");
  const [lineAuthor, setLineAuthor] = useState("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");

  const findings = summary.data?.findings ?? [];
  const entries = summary.data?.timeline ?? [];
  const files = [...new Set(findings.map((finding) => finding.file))].sort();
  const authors = [
    ...new Set(findings.map((finding) => finding.lineAuthor?.name ?? UNKNOWN_AUTHOR)),
  ].sort();
  const visible = findings.filter(
    (finding) =>
      (disposition === "all" || bucketOf(finding) === disposition) &&
      (filePath === "all" || finding.file === filePath) &&
      (lineAuthor === "all" || (finding.lineAuthor?.name ?? UNKNOWN_AUTHOR) === lineAuthor) &&
      (severity === "all" || finding.severity === severity),
  );
  // 轮次序号按这个阶段自己数:一条 Finding「第几轮首次报出」比一个库 id 有意义。
  const roundOf = new Map(entries.map((entry, index) => [entry.runId, index + 1]));
  const counts = summary.data?.counts ?? { pending: 0, resolved: 0, fixed: 0 };

  return (
    <div className="flex flex-col gap-3">
      {summary.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(summary.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {/* 三个计数是这个阶段的进度:待处置在最前,人看的就是它。 */}
      <div className="grid grid-cols-3 gap-2">
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
            className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left ${
              disposition === id
                ? "border-primary bg-accent-tint"
                : "border-card-line bg-surface"
            }`}
          >
            <span className="text-sm text-text-secondary">{DISPOSITION_LABEL[id]}</span>
            <span className="text-4xl font-bold tabular-nums">{value}</span>
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

        {/* 四个筛选只属于 Finding 页;筛选值是组件内状态,切到时间线再切回来仍在。 */}
        <Tabs.Content value="findings" className="flex flex-col gap-3 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select.Root
              value={disposition}
              onValueChange={(next) => setDisposition(next as DispositionFilter)}
              size="1"
            >
              <Select.Trigger aria-label="按处置状态筛选" />
              <Select.Content>
                <Select.Item value="all">全部处置状态</Select.Item>
                <Select.Item value="pending">待处置</Select.Item>
                <Select.Item value="resolved">人工已处置</Select.Item>
                <Select.Item value="fixed">已修复</Select.Item>
              </Select.Content>
            </Select.Root>
            <FileFilterCombobox value={filePath} files={files} onChange={setFilePath} />
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

          {visible.map((finding) => (
            <section
              key={finding.id}
              className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control"
            >
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
                className="group block px-4 pt-2.5 outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 font-mono text-sm break-all text-text-secondary">
                    {finding.file}:{finding.line}
                  </span>
                  <span
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-tint-strong text-primary transition-colors group-hover:bg-accent-track"
                    aria-hidden
                  >
                    <FileTextIcon />
                  </span>
                </span>
                {finding.title === "" ? null : (
                  <span className="block pt-1 text-lg font-semibold break-words">{finding.title}</span>
                )}
                <span className="block pt-1 text-sm text-text-secondary tabular-nums">
                  第 {roundOf.get(finding.firstRunId) ?? "?"} 轮首次报出 · 第{" "}
                  {roundOf.get(finding.lastRunId) ?? "?"} 轮最近一次 ·{" "}
                  {localMinute(finding.lastReportedAt)}
                </span>
              </Link>
              <FindingRow finding={finding} canDispose={canDispose} />
            </section>
          ))}
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
 * 时间线里一轮的五个数(issue #168)。轮次降为历史之后,一轮要说的只剩「它做了什么」:
 * 报出了几条新的、折叠了几条旧的、自动修掉几条、交接几条,以及有几条根本没复核。
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
    ] as const
  ).filter(([, value]) => value > 0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
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
        </>
      )}
      {/* 原因整句摊开,列表上就看得到为什么;改判的那一轮与收尾失败的那一轮同一个位置。 */}
      {entry.failure === null ? null : (
        <span className="basis-full break-words text-sm text-text-secondary">{entry.failure}</span>
      )}
    </div>
  );
}
