import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  CheckCircledIcon,
  ChevronDownIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";
import { Card, SegmentedControl, Skeleton, Table } from "@radix-ui/themes";
import { Collapsible } from "radix-ui";

import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
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
  resolved: number;
  total: number;
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
  if (run.failed) {
    return (
      <StatusBadge tone="error">
        失败
      </StatusBadge>
    );
  }
  const badge = runBadge(run);
  const down = run.models.filter((entry) => entry.failure !== null);
  if (down.length === 0) return badge;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-flex shrink-0 items-center text-warning"
        title={[
          `${down.length}/${run.models.length} 个模型失败，本轮审查结果不完整`,
          ...down.map((entry) => `${entry.model}: ${entry.failure}`),
        ].join("\n")}
      >
        <ExclamationTriangleIcon className="size-4" aria-hidden />
        {/* title 只对鼠标成立。这句话让屏幕阅读器与触屏也读得到图标的含义。 */}
        <span className="sr-only">
          {down.length}/{run.models.length} 个模型失败，本轮审查结果不完整
        </span>
      </span>
      {badge}
    </span>
  );
}

type RunFilter = "all" | "failed" | "pending" | "done";

function runHasModelFailure(run: RunItem): boolean {
  return run.models.some((entry) => entry.failure !== null);
}

function runBucket(run: RunItem): Exclude<RunFilter, "all"> {
  if (run.failed || runHasModelFailure(run)) return "failed";
  if (run.total > 0 && run.resolved < run.total) return "pending";
  return "done";
}

function RunStatus({ run }: { run: RunItem }) {
  if (run.failed) {
    return (
      <CrossCircledIcon className="size-4 text-destructive" aria-label="失败" />
    );
  }
  if (runHasModelFailure(run)) {
    return (
      <ExclamationTriangleIcon className="size-4 text-warning" aria-label="部分失败" />
    );
  }
  return <CheckCircledIcon className="size-4 text-success" aria-label="完成" />;
}

function runBadge(run: RunItem) {
  // total 只计行级承载的合并组:纯正文 Finding 的 Run 也落在这一档——正文没有
  // resolve 载体,本来就无从处置。
  if (run.total === 0) {
    return (
      <StatusBadge tone="neutral" icon={CheckCircledIcon}>
        无可处置项
      </StatusBadge>
    );
  }
  const done = run.resolved === run.total;
  return (
    <StatusBadge tone={done ? "success" : "warning"}>
      {run.resolved}/{run.total} 已处置
    </StatusBadge>
  );
}

function RunModels({ run }: { run: RunItem }) {
  const failures = run.models.filter((entry) => entry.failure !== null);

  return (
    <div className="min-w-0">
      {run.models.length === 0 ? (
        <span className="text-muted-foreground">没有模型记录</span>
      ) : (
        <ul className="flex min-w-0 flex-col gap-0.5">
          {run.models.map((entry) => (
            <li
              key={entry.model}
              className={`min-w-0 break-all font-mono text-xs ${
                entry.failure === null ? "text-muted-foreground" : "text-destructive"
              }`}
            >
              {entry.model}{" "}
              {entry.failure === null ? (
                <b className="font-semibold tabular-nums text-foreground">{entry.findings}</b>
              ) : (
                <b className="font-semibold">失败</b>
              )}
            </li>
          ))}
        </ul>
      )}
      {failures.length > 0 ? (
        <Collapsible.Root className="group/failure mt-2">
          <Collapsible.Trigger asChild>
            <Button variant="ghost" color="red" size={{ initial: "3", sm: "1" }}>
              查看 {failures.length} 条失败原因
              <ChevronDownIcon
                className="size-3.5 transition-transform group-data-[state=open]/failure:rotate-180"
                aria-hidden
              />
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <ul className="mt-1 flex flex-col gap-2 border-l border-destructive/25 py-1 pl-3 text-xs text-destructive">
              {failures.map((entry) => (
                <li key={`${entry.model}-why`} className="break-words leading-relaxed">
                  <span className="break-all font-mono font-medium">{entry.model}</span>
                  <span aria-hidden> · </span>
                  {entry.failure}
                </li>
              ))}
            </ul>
          </Collapsible.Content>
        </Collapsible.Root>
      ) : null}
    </div>
  );
}

function RunUsage({ run }: { run: RunItem }) {
  const cost = costPresentation(run.usage);
  return (
    <div className="text-xs">
      {run.usage === undefined ? null : (
        <div className="font-mono tabular-nums text-muted-foreground">
          {run.usage.totalTokens.toLocaleString("zh-CN")} tokens
        </div>
      )}
      <div className="font-mono tabular-nums">{cost.amount}</div>
      {cost.note === null ? null : <div className="break-words text-warning">{cost.note}</div>}
    </div>
  );
}

function RunTime({ run }: { run: RunItem }) {
  const date = new Date(run.startedAt);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return (
    <div className="text-xs text-muted-foreground">
      <div className="font-mono tabular-nums">{time}</div>
      <div className="break-words">{run.triggeredBy === null ? "自动触发" : `手动 · ${run.triggeredBy}`}</div>
    </div>
  );
}

export function RunsPage({ canRerun }: { canRerun: boolean }) {
  const runs = useInfiniteQuery({
    queryKey: ["runs"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchJson<RunsPage>(pageParam === null ? "/runs" : `/runs?before=${pageParam}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [filter, setFilter] = useState<RunFilter>("all");
  const rerun = useMutation({
    mutationFn: rerunRequest,
    onSuccess: (text) => setFeedback({ text, isError: false }),
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  // 滚到底部附近自动加载更早的一页。
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void runs.fetchNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [runs.fetchNextPage, runs.hasNextPage]);

  const flat = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const counts = {
    all: flat.length,
    failed: flat.filter((run) => runBucket(run) === "failed").length,
    pending: flat.filter((run) => runBucket(run) === "pending").length,
    done: flat.filter((run) => runBucket(run) === "done").length,
  };
  const visible = filter === "all" ? flat : flat.filter((run) => runBucket(run) === filter);
  // 按浏览器本地时区分天与显示时分:UTC 日在东八区会把 16:00 后的 run 归到前一天。
  const localDay = (iso: string): string => {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const visibleGroups = visible.reduce<{ day: string; runs: RunItem[] }[]>((groups, run) => {
    const day = localDay(run.startedAt);
    const current = groups.at(-1);
    if (current?.day === day) current.runs.push(run);
    else groups.push({ day, runs: [run] });
    return groups;
  }, []);

  return (
    <>
      <PageHeader
        title="评审记录"
        description={
          runs.isPending
            ? "每一轮审查按时间倒序。"
            : `${counts.all} 轮 · ${counts.failed} 失败`
        }
        actions={<SummaryRate />}
      />
      <PageBody width="wide" className="gap-3 pb-24 sm:pb-24">
        {feedback === null ? null : (
          <div
            role={feedback.isError ? "alert" : "status"}
            className={`flex items-start gap-2 rounded-sm border px-3 py-2 ${
              feedback.isError
                ? "border-destructive/30 bg-destructive/5 text-destructive"
                : "bg-muted text-foreground"
            }`}
          >
            {feedback.isError ? (
              <CrossCircledIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <CheckCircledIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            )}
            <span>{feedback.text}</span>
          </div>
        )}
        {runs.isError ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
          >
            <CrossCircledIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{(runs.error as Error).message}</span>
          </p>
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
        >
          {(
            [
              ["all", "全部", counts.all],
              ["failed", "失败", counts.failed],
              ["pending", "待处置", counts.pending],
              ["done", "已处置", counts.done],
            ] as const
          ).map(([id, label, count]) => (
            <SegmentedControl.Item key={id} value={id}>
              {label}
              <span className="ml-1 font-mono tabular-nums">{count}</span>
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>

        {runs.isPending
          ? [0, 1, 2, 3].map((slot) => <Skeleton key={slot} className="h-14" />)
          : null}

        {visible.length > 0 ? (
          <Table.Root
            size="1"
            variant="surface"
            layout="fixed"
            className="hidden min-w-0 max-w-full xl:block"
          >
            <caption className="sr-only">审查记录列表</caption>
            <Table.Header className="bg-muted text-xs text-muted-foreground">
              <Table.Row>
                <Table.ColumnHeaderCell width="3rem">状态</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="17%">仓库 / PR</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="31%">模型</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="13%">处置</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="15%">用量 / 费用</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="12%">时间</Table.ColumnHeaderCell>
                {canRerun ? (
                  <Table.ColumnHeaderCell width="5rem">动作</Table.ColumnHeaderCell>
                ) : null}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visibleGroups.map((group) => (
                <Fragment key={group.day}>
                  <Table.Row className="bg-muted/60">
                    <Table.Cell
                      colSpan={canRerun ? 7 : 6}
                      className="font-mono text-xs font-semibold text-muted-foreground"
                    >
                      {group.day}
                    </Table.Cell>
                  </Table.Row>
                  {group.runs.map((run) => {
                    const failedRow = runBucket(run) === "failed";
                    return (
                      <Table.Row
                        key={run.id}
                        align="start"
                        className={
                          failedRow
                            ? "bg-destructive/10"
                            : "transition-colors hover:bg-muted/40"
                        }
                      >
                        <Table.Cell>
                          <RunStatus run={run} />
                        </Table.Cell>
                        <Table.Cell className="min-w-0">
                          <div className="break-all">
                            <span className="font-mono text-xs text-muted-foreground">
                              {run.owner}/{run.repo}
                            </span>{" "}
                            <span className="font-mono font-medium">#{run.pullNumber}</span>
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {run.headSha.slice(0, 7)}
                          </div>
                        </Table.Cell>
                        <Table.Cell className="min-w-0">
                          <RunModels run={run} />
                        </Table.Cell>
                        <Table.Cell>
                          <RunPill run={run} />
                        </Table.Cell>
                        <Table.Cell>
                          <RunUsage run={run} />
                        </Table.Cell>
                        <Table.Cell>
                          <RunTime run={run} />
                        </Table.Cell>
                        {canRerun ? (
                          <Table.Cell>
                            <Button
                              variant="outline"
                              color="gray"
                              size="1"
                              disabled={rerun.isPending}
                              onClick={() => rerun.mutate(run)}
                            >
                              {rerun.isPending ? "重新运行中…" : "重新运行"}
                            </Button>
                          </Table.Cell>
                        ) : null}
                      </Table.Row>
                    );
                  })}
                </Fragment>
              ))}
            </Table.Body>
          </Table.Root>
        ) : null}

        {visible.length > 0 ? (
          <div className="space-y-4 xl:hidden" aria-label="审查记录列表">
            {visibleGroups.map((group) => (
              <section key={group.day} aria-labelledby={`run-day-${group.day}`} className="space-y-2">
                <h2 id={`run-day-${group.day}`} className="font-mono text-xs font-semibold text-muted-foreground">
                  {group.day}
                </h2>
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {group.runs.map((run) => {
                    const failedRow = runBucket(run) === "failed";
                    return (
                      <article key={run.id} className={`min-w-0 p-3 ${failedRow ? "bg-destructive/10" : "bg-background"}`}>
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <span className="mt-0.5 shrink-0"><RunStatus run={run} /></span>
                            <div className="min-w-0">
                              <h3 className="break-all font-mono font-medium">
                                {run.owner}/{run.repo} #{run.pullNumber}
                              </h3>
                              <p className="font-mono text-xs text-muted-foreground">{run.headSha.slice(0, 7)}</p>
                            </div>
                          </div>
                          <RunTime run={run} />
                        </div>
                        <div className="mt-3 border-t border-border/80 pt-3">
                          <RunModels run={run} />
                        </div>
                        <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-border/80 pt-3">
                          <div className="flex min-w-0 flex-wrap items-start gap-x-5 gap-y-2">
                            <RunPill run={run} />
                            <RunUsage run={run} />
                          </div>
                          {canRerun ? (
                            <Button
                              variant="outline"
                              color="gray"
                              size={{ initial: "4", sm: "1" }}
                              disabled={rerun.isPending}
                              onClick={() => rerun.mutate(run)}
                            >
                              {rerun.isPending ? "重新运行中…" : "重新运行"}
                            </Button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {flat.length === 0 && !runs.isPending && !runs.isError ? (
          <Card size="2" className="flex flex-col items-start gap-1.5">
            <h2 className="text-base font-semibold">暂无审查记录</h2>
            <p className="text-muted-foreground">
              向已注册仓库提交 pull request 后，系统会自动运行审查。
              {canRerun ? "如需对已有 pull request 重新运行审查，请到仓库页选择仓库并输入 PR 编号。" : null}
            </p>
            {canRerun ? (
              <Button variant="outline" color="gray" size={{ initial: "4", sm: "1" }} asChild>
                <Link to="/repos">去仓库页</Link>
              </Button>
            ) : null}
          </Card>
        ) : null}
        {flat.length > 0 && visible.length === 0 ? (
          <p className="rounded-sm border border-dashed border-border px-4 py-6 text-center text-muted-foreground">
            当前筛选条件下没有审查记录。
          </p>
        ) : null}
        <div ref={sentinel} />
        <p className="pt-2 text-center text-xs text-muted-foreground">
          {runs.isFetchingNextPage
            ? "加载更早的审查记录…"
            : runs.hasNextPage
              ? "继续下滑加载更早的审查记录"
              : flat.length > 0
                ? "已加载全部记录"
                : ""}
        </p>
      </PageBody>
    </>
  );
}
