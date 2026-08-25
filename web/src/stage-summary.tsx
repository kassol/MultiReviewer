import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { CrossCircledIcon, FileTextIcon } from "@radix-ui/react-icons";
import { Callout, Select, Skeleton } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { localMinute } from "@/lib/time";

import { fetchJson } from "./api.ts";
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
 * 阶段汇总里的一条 Finding。字段与 `GET <前缀>/api/stage-summary` 逐字对应:它是轮次
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
 * 一轮 Review Run 落在哪个阶段上:属于范围审查的按它的标识,其余按自己的 pull request。
 */
export function runScope(run: {
  owner: string;
  repo: string;
  pullNumber: number;
  rangeReviewId: number | null;
}): StageScope {
  return run.rangeReviewId === null
    ? { kind: "pull-request", owner: run.owner, repo: run.repo, pullNumber: run.pullNumber }
    : { kind: "range-review", rangeReviewId: run.rangeReviewId };
}

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
 * 处置完的那一条立刻从待处置里退出去(与轮次那三份查询同一个理由)。
 */
function stageSummaryKey(scope: StageScope): (string | number)[] {
  return scope.kind === "range-review"
    ? ["stage-summary", "range-review", scope.rangeReviewId]
    : ["stage-summary", "pull-request", scope.owner, scope.repo, scope.pullNumber];
}

type DispositionFilter = "all" | "pending" | "resolved" | "fixed";

const DISPOSITION_LABEL: Record<Exclude<DispositionFilter, "all">, string> = {
  pending: "待处置",
  resolved: "人工已处置",
  fixed: "已修复",
};

/** 一条 Finding 现在落在三档里的哪一档。已延续不会出现在汇总里,那不是处置。 */
function bucketOf(finding: StageFinding): Exclude<DispositionFilter, "all"> {
  if (finding.disposition === "fixed") return "fixed";
  if (finding.disposition === "resolved") return "resolved";
  return "pending";
}

/**
 * 一个审查阶段的主视图(issue #168):按 Finding Identity 汇总的列表、顶部三个计数,
 * 加这个阶段的时间线。
 *
 * 范围审查阶段与 pull request 阶段共用这一份——「这个阶段还剩什么没处置」是同一个
 * 问题,两条链路不该显示成两个样子。
 */
export function StageSummaryView({
  scope,
  canDispose,
  timeline,
  onJumpToRun,
}: {
  scope: StageScope;
  /** 有 `finding:dispose` 权限时行内出现处置动作。 */
  canDispose: boolean;
  /** 时间线怎么摆由页面定:范围审查按比较项分组,PR 那条直接一列。 */
  timeline?: (entries: StageTimelineEntry[]) => React.ReactNode;
  /**
   * 点了「去最新一轮 diff」之后调用方还要做的事。PR 那条链路的汇总就摆在轮次详情
   * 面板里,不切回 diff 的话地址变了而人看到的还是汇总;范围审查那条是跨页跳转,
   * 不必给。
   */
  onJumpToRun?: () => void;
}) {
  const summary = useQuery({
    queryKey: stageSummaryKey(scope),
    queryFn: () => fetchJson<StageSummaryBody>(scopePath(scope)),
    // 还有轮次没跑完就每 10 秒续查,全部结束即停:人最想看结果的正是这几分钟。
    refetchInterval: (query) =>
      (query.state.data?.timeline ?? []).some((entry) => entry.finishedAt === null)
        ? 10_000
        : false,
  });
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  const [filePath, setFilePath] = useState("all");

  const findings = summary.data?.findings ?? [];
  const entries = summary.data?.timeline ?? [];
  const files = [...new Set(findings.map((finding) => finding.file))].sort();
  const visible = findings.filter(
    (finding) =>
      (disposition === "all" || bucketOf(finding) === disposition) &&
      (filePath === "all" || finding.file === filePath),
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
            onClick={() => setDisposition(disposition === id ? "all" : id)}
            className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left ${
              disposition === id
                ? "border-primary bg-accent-tint"
                : "border-card-line bg-surface"
            }`}
          >
            <span className="text-sm text-text-muted">{DISPOSITION_LABEL[id]}</span>
            <span className="text-4xl font-bold tabular-nums">{value}</span>
          </button>
        ))}
      </div>

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
        <Select.Root value={filePath} onValueChange={setFilePath} size="1">
          <Select.Trigger aria-label="按文件筛选" />
          <Select.Content>
            <Select.Item value="all">全部文件</Select.Item>
            {files.map((file) => (
              <Select.Item key={file} value={file}>{file}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {summary.data === undefined ? null : (
          <span className="text-sm text-text-muted">
            <span className="font-mono tabular-nums">{visible.length}</span> / {findings.length} 条
          </span>
        )}
      </div>

      {summary.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在加载这个阶段的汇总</span>
          {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-16" />)}
        </div>
      ) : null}

      {summary.data !== undefined && findings.length === 0 ? (
        <EmptyState title="这个阶段还没有 Finding" className="py-2" />
      ) : null}
      {summary.data !== undefined && findings.length > 0 && visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-card-line px-4 py-6 text-center text-text-muted">
          没有符合筛选条件的 Finding。
        </p>
      ) : null}

      {visible.map((finding) => (
        <section
          key={finding.id}
          className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-2.5">
            <span className="min-w-0 font-mono text-sm break-all text-text-muted">
              {finding.file}:{finding.line}
            </span>
            {/* 最新一轮的 diff 位置:处置不必先翻轮次,点过去就是那一轮那个文件。 */}
            <Link
              to="/stages/$stageId"
              params={{ stageId: stageIdOf(scope) }}
              search={{ run: finding.lastRunId, file: finding.file }}
              onClick={() => onJumpToRun?.()}
              className="inline-flex shrink-0 items-center gap-1 text-sm text-primary underline underline-offset-4"
            >
              <FileTextIcon aria-hidden />
              去最新一轮 diff
            </Link>
          </div>
          {finding.title === "" ? null : (
            <p className="px-4 pt-1 text-lg font-semibold break-words">{finding.title}</p>
          )}
          <p className="px-4 pt-1 text-sm text-text-muted tabular-nums">
            第 {roundOf.get(finding.firstRunId) ?? "?"} 轮首次报出 · 第{" "}
            {roundOf.get(finding.lastRunId) ?? "?"} 轮最近一次 ·{" "}
            {localMinute(finding.lastReportedAt)}
          </p>
          <FindingRow finding={finding} canDispose={canDispose} />
        </section>
      ))}

      <h3 className="pt-1 text-2xl font-semibold">
        时间线
        <span className="ml-1.5 font-mono tabular-nums text-text-muted">{entries.length}</span>
      </h3>
      {timeline === undefined ? (
        entries.length === 0 ? (
          <EmptyState title="这个阶段还没有跑过 Review Run" className="py-2" />
        ) : (
          [...entries].reverse().map((entry) => (
            <div key={entry.runId} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-1.5 text-base text-text-muted">
                <CommitChip sha={entry.headSha} />
                <span className="tabular-nums">{localMinute(entry.startedAt)}</span>
              </div>
              <StageRound entry={entry} />
            </div>
          ))
        )
      ) : (
        timeline(entries)
      )}
    </div>
  );
}

/**
 * 时间线里一轮的五个数(issue #168)。轮次降为历史之后,一轮要说的只剩「它做了什么」:
 * 报出了几条新的、折叠了几条旧的、自动修掉几条、交接几条,以及有几条根本没复核。
 *
 * 为零的不列——读者要的是这一轮做了什么,一排零只让人多数几个零。全零的那一轮
 * 显式写一句,免得看起来像还没渲染出来。
 */
export function StageRound({ entry }: { entry: StageTimelineEntry }) {
  const cells = (
    [
      ["新报出", entry.reported, "text-text"],
      ["折叠", entry.folded, "text-text-muted"],
      ["已修复", entry.fixed, "text-success"],
      ["已延续", entry.continued, "text-text-muted"],
      ["漏复核", entry.missedVerdicts, "text-warning"],
    ] as const
  ).filter(([, value]) => value > 0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-overlay-line bg-surface px-4 py-2.5 text-base shadow-control">
      {entry.finishedAt === null && !entry.failed ? (
        <span className="text-text-muted">运行中…</span>
      ) : entry.failed ? (
        <span className="text-danger">这一轮失败了</span>
      ) : cells.length === 0 ? (
        <span className="text-text-muted">这一轮没有变化</span>
      ) : (
        cells.map(([label, value, tone]) => (
          <span key={label} className={tone}>
            {label} <span className="font-mono font-bold tabular-nums">{value}</span>
          </span>
        ))
      )}
    </div>
  );
}
