import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { api, errorText, fetchJson } from "./api.ts";
import { SummaryRate } from "./stats.tsx";

export type RunItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  /** 一行一个参与本轮的模型。`failure` 非 null 即这个模型这轮失败了(节选文本)。 */
  models: { model: string; findings: number; failure: string | null }[];
  resolved: number;
  total: number;
};

type RunsPage = { runs: RunItem[]; nextBefore: number | null };

/** 手动重跑。两个入口(时间流逐条、仓库页输 PR 号)共用这一个请求。 */
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
  return `已触发 ${run.owner}/${run.repo} #${run.pullNumber} 的新一轮 Review Run`;
}

/**
 * 时间流卡片上的处置进度。与处置率同一口径:只算行级承载的合并组。
 *
 * 「状态到颜色」的映射留在这里:它同时被仓库页与评审记录页用,拆掉这层包装会把
 * 这条规则散到两个调用点。失败与待处置分成两色——一个去重跑,一个去处置。
 *
 * 部分模型失败不占这个位置:那一轮跑通的模型报出的 Finding 是真的、可处置的,
 * 处置进度得留着。失败只加一颗红点提示「这一轮的结论不完整」,原因看卡片上的模型行。
 */
export function RunPill({ run }: { run: RunItem }) {
  if (run.failed) {
    return (
      <Badge variant="destructive">
        <span className="size-1.5 rounded-full bg-current" />
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
        className="inline-flex size-4 shrink-0 items-center justify-center"
        title={[
          `${down.length}/${run.models.length} 个模型失败,这一轮的覆盖面不全`,
          ...down.map((entry) => `${entry.model}: ${entry.failure}`),
        ].join("\n")}
      >
        <span className="size-1.5 rounded-full bg-destructive" />
        {/* title 只对鼠标成立。这句话让屏幕阅读器与触屏也读得到这颗点的含义。 */}
        <span className="sr-only">
          {down.length}/{run.models.length} 个模型失败,这一轮的覆盖面不全
        </span>
      </span>
      {badge}
    </span>
  );
}

function runBadge(run: RunItem) {
  // total 只计行级承载的合并组:纯正文 Finding 的 Run 也落在这一档——正文没有
  // resolve 载体,本来就无从处置。
  if (run.total === 0) {
    return <Badge variant="secondary">无可处置项</Badge>;
  }
  const done = run.resolved === run.total;
  return (
    <Badge
      className={done ? "bg-success/12 text-success" : "bg-warning/12 text-warning"}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {run.resolved}/{run.total} 已处置
    </Badge>
  );
}

export function RunsPage() {
  const runs = useInfiniteQuery({
    queryKey: ["runs"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchJson<RunsPage>(pageParam === null ? "/runs" : `/runs?before=${pageParam}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
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
  let lastDay = "";
  // 按浏览器本地时区分天与显示时分:UTC 日在东八区会把 16:00 后的 run 归到前一天。
  const localDay = (iso: string): string => {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const localTime = (iso: string): string => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <>
      <PageHeader
        title="评审记录"
        description="每一轮 Review Run 按时间倒序。一行一个参与的模型,后面的数字是它这轮报出的 Finding 数。"
        actions={<SummaryRate />}
      />
      <div className="flex max-w-[1060px] flex-col gap-2.5 p-5 pb-24">
        {feedback === null ? null : (
          <p className={feedback.isError ? "text-destructive" : "text-muted-foreground"}>
            {feedback.text}
          </p>
        )}
        {runs.isError ? (
          <p className="text-destructive">{(runs.error as Error).message}</p>
        ) : null}
        {runs.isPending
          ? [0, 1, 2, 3].map((slot) => <Skeleton key={slot} className="h-[86px]" />)
          : null}

        {flat.map((run) => {
          const day = localDay(run.startedAt);
          const header =
            day !== lastDay ? (
              <div className="px-0.5 pt-3 pb-1 font-mono text-xs font-semibold tracking-[0.07em] text-muted-foreground">
                {(lastDay = day)}
              </div>
            ) : null;
          return (
            <div key={run.id}>
              {header}
              <Card className="gap-2.5 px-4">
                  {/* 上一行是「哪个 PR、什么时候、哪个 commit」,下一行才是结论与动作。 */}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono text-muted-foreground">
                      {run.owner}/{run.repo}
                    </span>
                    <span className="font-mono font-medium">#{run.pullNumber}</span>
                    <span className="ml-auto flex items-baseline gap-2 font-mono text-xs text-muted-foreground">
                      <span>{run.headSha.slice(0, 7)}</span>
                      <span className="tabular-nums">{localTime(run.startedAt)}</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
                      {run.models.length === 0 ? (
                        <span className="text-muted-foreground">没有模型记录</span>
                      ) : (
                        run.models.map((entry) =>
                          entry.failure === null ? (
                            <span key={entry.model} className="font-mono text-muted-foreground">
                              {entry.model}{" "}
                              <b className="font-semibold tabular-nums text-foreground">
                                {entry.findings}
                              </b>
                            </span>
                          ) : (
                            <span key={entry.model} className="font-mono text-destructive">
                              {entry.model} <b className="font-semibold">失败</b>
                            </span>
                          ),
                        )
                      )}
                    </div>
                    <RunPill run={run} />
                    <Button
                      variant="outline"
                      size="xs"
                      className="ml-auto"
                      disabled={rerun.isPending}
                      onClick={() => rerun.mutate(run)}
                    >
                      重跑
                    </Button>
                  </div>
                  {run.models
                    .filter((entry) => entry.failure !== null)
                    .map((entry) => (
                      // 失败原因就写在卡片上:要不要重跑取决于这句话(区域封禁重跑也没用,
                      // 超时重跑就好),藏进 tooltip 等于让人先猜。
                      <p key={entry.model} className="text-xs break-words text-destructive">
                        {/* 分隔符不用冒号:模型标识本身就是 `provider:model`,再加一个冒号读不出边界。 */}
                        <span className="font-mono">{entry.model}</span> · {entry.failure}
                      </p>
                    ))}
              </Card>
            </div>
          );
        })}

        {flat.length === 0 && !runs.isPending ? (
          <Card className="items-start gap-1.5 px-4">
            <h2 className="text-base font-semibold">还没有 Review Run</h2>
            <p className="text-muted-foreground">
              给已注册的仓库开一个 PR 就会自动跑一轮。要对已有的 PR 补一轮,去仓库页选中那个
              仓库,在「评审记录」里输 PR 号点重跑。
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link to="/repos">去仓库页</Link>
            </Button>
          </Card>
        ) : null}
        <div ref={sentinel} />
        <p className="pt-2 text-center text-xs text-muted-foreground">
          {runs.isFetchingNextPage
            ? "加载更早的 Review Run…"
            : runs.hasNextPage
              ? "往下滚加载更早的 Review Run"
              : flat.length > 0
                ? "到底了"
                : ""}
        </p>
      </div>
    </>
  );
}
