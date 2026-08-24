import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";

import { CircleAlert, CircleCheck, CircleX } from "lucide-react";

import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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
      <Badge variant="destructive">
        <CircleX aria-hidden />
        失败
      </Badge>
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
        <CircleAlert className="size-4" aria-hidden />
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
      <CircleX className="size-4 text-destructive" aria-label="失败" />
    );
  }
  if (runHasModelFailure(run)) {
    return (
      <CircleAlert className="size-4 text-warning" aria-label="部分失败" />
    );
  }
  return <CircleCheck className="size-4 text-success" aria-label="完成" />;
}

function runBadge(run: RunItem) {
  // total 只计行级承载的合并组:纯正文 Finding 的 Run 也落在这一档——正文没有
  // resolve 载体,本来就无从处置。
  if (run.total === 0) {
    return (
      <Badge variant="secondary">
        <CircleCheck aria-hidden />
        无可处置项
      </Badge>
    );
  }
  const done = run.resolved === run.total;
  return (
    <Badge
      className={done ? "bg-success/12 text-success" : "bg-warning/12 text-warning"}
    >
      {done ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
      {run.resolved}/{run.total} 已处置
    </Badge>
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
        <details className="mt-2 rounded-sm border border-destructive/25 bg-background/70 text-xs text-destructive">
          <summary className="flex min-h-11 cursor-pointer items-center px-2 py-1.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 xl:min-h-8">
            查看 {failures.length} 条失败原因
          </summary>
          <ul className="space-y-2 border-t border-destructive/20 px-2 py-2">
            {failures.map((entry) => (
              <li key={`${entry.model}-why`} className="break-words leading-relaxed">
                <span className="break-all font-mono font-medium">{entry.model}</span>
                <span aria-hidden> · </span>
                {entry.failure}
              </li>
            ))}
          </ul>
        </details>
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
              <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            )}
            <span>{feedback.text}</span>
          </div>
        )}
        {runs.isError ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
          >
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{(runs.error as Error).message}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="按结论过滤">
          {(
            [
              ["all", "全部", counts.all],
              ["failed", "失败", counts.failed],
              ["pending", "待处置", counts.pending],
              ["done", "已处置", counts.done],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`min-h-11 rounded-full px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 xl:min-h-7 xl:px-2.5 ${
                filter === id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              <span className="ml-1 tabular-nums">{count}</span>
            </button>
          ))}
        </div>

        {runs.isPending
          ? [0, 1, 2, 3].map((slot) => <Skeleton key={slot} className="h-14" />)
          : null}

        {visible.length > 0 ? (
          <div className="hidden overflow-hidden rounded-md border border-border xl:block">
            <table className="w-full table-fixed text-left">
              <caption className="sr-only">审查记录列表</caption>
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="w-11 px-2 py-2 font-medium">
                    状态
                  </th>
                  <th scope="col" className="w-[17%] px-2 py-2 font-medium">
                    仓库 / PR
                  </th>
                  <th scope="col" className="w-[31%] px-2 py-2 font-medium">
                    模型
                  </th>
                  <th scope="col" className="w-[13%] px-2 py-2 font-medium">
                    处置
                  </th>
                  <th scope="col" className="w-[15%] px-2 py-2 font-medium">
                    用量 / 费用
                  </th>
                  <th scope="col" className="w-[12%] px-2 py-2 font-medium">
                    时间
                  </th>
                  {canRerun ? (
                    <th scope="col" className="w-16 px-2 py-2 font-medium">
                      动作
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map((group) => (
                  <Fragment key={group.day}>
                        <tr className="border-t border-border bg-muted/60">
                          <th
                            colSpan={canRerun ? 7 : 6}
                            className="px-3 py-1.5 font-mono text-xs font-semibold text-muted-foreground"
                          >
                            {group.day}
                          </th>
                        </tr>
                    {group.runs.map((run) => {
                      const failedRow = runBucket(run) === "failed";
                      return (
                      <tr
                        key={run.id}
                        className={
                          failedRow
                            ? "border-t border-border bg-destructive/10"
                            : "border-t border-border transition-colors hover:bg-muted/40"
                        }
                      >
                        <td className="px-2 py-2.5 align-top">
                          <RunStatus run={run} />
                        </td>
                        <td className="min-w-0 px-2 py-2.5 align-top">
                          <div className="break-all">
                            <span className="font-mono text-xs text-muted-foreground">
                              {run.owner}/{run.repo}
                            </span>{" "}
                            <span className="font-mono font-medium">#{run.pullNumber}</span>
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {run.headSha.slice(0, 7)}
                          </div>
                        </td>
                        <td className="min-w-0 px-2 py-2.5 align-top">
                          <RunModels run={run} />
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <RunPill run={run} />
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <RunUsage run={run} />
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <RunTime run={run} />
                        </td>
                        {canRerun ? (
                          <td className="px-2 py-2.5 align-top">
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={rerun.isPending}
                              onClick={() => rerun.mutate(run)}
                            >
                              {rerun.isPending ? "重新运行中…" : "重新运行"}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
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
                              size="sm"
                              className="min-h-11"
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
          <Card className="items-start gap-1.5 px-4">
            <h2 className="text-base font-semibold">暂无审查记录</h2>
            <p className="text-muted-foreground">
              向已注册仓库提交 pull request 后，系统会自动运行审查。
              {canRerun ? "如需对已有 pull request 重新运行审查，请到仓库页选择仓库并输入 PR 编号。" : null}
            </p>
            {canRerun ? (
              <Button variant="outline" size="sm" asChild>
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
