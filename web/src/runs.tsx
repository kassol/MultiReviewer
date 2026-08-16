import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { api, errorText, fetchJson } from "./api.ts";
import { denominator, type Cell } from "./stats.tsx";

export type RunItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  models: { model: string; findings: number }[];
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

/** 时间流卡片上的处置进度。与处置率同一口径:只算行级承载的合并组。 */
export function RunPill({ run }: { run: RunItem }) {
  if (run.failed) {
    return (
      <span className="pill warn">
        <i className="dot" />
        失败
      </span>
    );
  }
  // total 只计行级承载的合并组:纯正文 Finding 的 Run 也落在这一档——正文没有
  // resolve 载体,本来就无从处置。
  if (run.total === 0) {
    return <span className="pill">无可处置项</span>;
  }
  return (
    <span className={`pill ${run.resolved === run.total ? "ok" : "warn"}`}>
      <i className="dot" />
      {run.resolved}/{run.total} 已处置
    </span>
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
  // 统计带与处置率页同源:同一个 /stats 默认窗口,前端只做求和。
  const stats = useQuery({
    queryKey: ["stats", "band"],
    queryFn: () => fetchJson<{ cells: Cell[] }>("/stats"),
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

  const cells = stats.data?.cells ?? [];
  const all = cells.reduce(
    (acc, cell) => ({
      resolved: acc.resolved + cell.resolved,
      total: acc.total + denominator(cell),
    }),
    { resolved: 0, total: 0 },
  );
  const models = [...new Set(cells.map((cell) => cell.model))].sort();
  const modelPct = (model: string): number => {
    const mine = cells.filter((cell) => cell.model === model);
    const total = mine.reduce((sum, cell) => sum + denominator(cell), 0);
    const resolved = mine.reduce((sum, cell) => sum + cell.resolved, 0);
    return total === 0 ? 0 : Math.round((resolved / total) * 100);
  };

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
    <div>
      <div className="c-top">
        <div className="c-stat">
          <span className="v">
            {all.total === 0 ? 0 : Math.round((all.resolved / all.total) * 100)}%
          </span>
          <span className="l">
            近 30 天处置率 {all.resolved}/{all.total}
          </span>
        </div>
        {models.map((model) => (
          <div className="c-stat" key={model}>
            <span className="v">{modelPct(model)}%</span>
            <span className="l mono">{model}</span>
          </div>
        ))}
      </div>

      <div className="c-feed">
        {feedback === null ? null : (
          <p className={feedback.isError ? "error" : "muted"} style={{ fontSize: 13 }}>
            {feedback.text}
          </p>
        )}
        {runs.isError ? <p className="error">{(runs.error as Error).message}</p> : null}

        {flat.map((run) => {
          const day = localDay(run.startedAt);
          const header = day !== lastDay ? <div className="c-day">{(lastDay = day)}</div> : null;
          return (
            <div key={run.id}>
              {header}
              <article className="card c-run">
                <div className="line1">
                  <span className="repo">
                    {run.owner}/{run.repo}
                  </span>
                  <span className="mono faint">#{run.pullNumber}</span>
                  <span className="faint" style={{ marginLeft: "auto", fontSize: 12 }}>
                    {localTime(run.startedAt)}
                  </span>
                </div>
                <div className="line2">
                  <div className="c-models">
                    {run.models.length === 0 ? (
                      <span className="faint">没有 Finding</span>
                    ) : (
                      run.models.map((entry) => (
                        <span key={entry.model}>
                          {entry.model} <b>{entry.findings}</b>
                        </span>
                      ))
                    )}
                  </div>
                  <RunPill run={run} />
                  <span className="mono faint">{run.headSha.slice(0, 7)}</span>
                  <button
                    className="btn"
                    style={{ marginLeft: "auto", padding: "3px 9px", fontSize: 12 }}
                    disabled={rerun.isPending}
                    onClick={() => rerun.mutate(run)}
                  >
                    重跑
                  </button>
                </div>
              </article>
            </div>
          );
        })}

        {flat.length === 0 && !runs.isPending ? (
          <p className="faint">还没有 Review Run。</p>
        ) : null}
        <div ref={sentinel} />
        <p className="faint" style={{ fontSize: 12, textAlign: "center", paddingTop: 8 }}>
          {runs.isFetchingNextPage
            ? "加载更早的 Review Run…"
            : runs.hasNextPage
              ? "往下滚加载更早的 Review Run"
              : flat.length > 0
                ? "到底了"
                : ""}
        </p>
      </div>
    </div>
  );
}
