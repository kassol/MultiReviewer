import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { Callout, Card, Progress, Skeleton, Table } from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { useState } from "react";

import { DateRangePicker } from "@/components/date-range-picker";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

import { api, fetchJson } from "./api.ts";
import type { UsageSummary } from "./runs.tsx";

/** 处置率矩阵的一格:仓库 × category(ADR 0015)。 */
export type Cell = {
  owner: string;
  repo: string;
  category: string;
  /** 分子的人工那一列:人在面板或 Gitea 上 resolve 的。 */
  resolved: number;
  /** 分子的自动那一列:「已修复」自动处置。 */
  fixed: number;
  unresolved: number;
  unknownClosed: number;
  unknownOpen: number;
};

/**
 * 一个模型报出过的 Finding 条数。模型这一维只剩这一个数:一条 Finding 由几个模型合报
 * 时它们各加一,而处置由人决定,拿处置率给模型打分读不出意义(ADR 0015)。
 */
export type ModelParticipation = {
  model: string;
  findings: number;
};

/** 时间窗里的用量:落了用量的 Review Run 数与它们的 token 之和。一轮都没有时 null。 */
type UsageStats = UsageSummary & { runs: number };

type StatsResponse = {
  from: string;
  to: string;
  cells: Cell[];
  models: ModelParticipation[];
  usage: UsageStats | null;
  database: { fileBytes: number; tables: { name: string; rows: number }[] };
};

/** 矩阵那一维的显示名,也是行键。 */
function repoName(cell: Cell): string {
  return `${cell.owner}/${cell.repo}`;
}

/** 分母 = 已处置(人工 + 自动)+ 看过未 resolve + 已关闭 PR 上无人处置(ADR 0006)。 */
function denominator(cell: Cell): number {
  return cell.resolved + cell.fixed + cell.unresolved + cell.unknownClosed;
}

/** 分子:人工与自动都算。两者的拆分在「按仓库统计」那一段单列。 */
function disposed(cell: Cell): number {
  return cell.resolved + cell.fixed;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function Bar({ pct }: { pct: number }) {
  return <Progress aria-hidden value={pct} size="1" />;
}

/** 比率永远带原始分子分母,读者自己判断样本够不够(ADR 0006)。 */
function Rate({ resolved, total }: { resolved: number; total: number }) {
  if (total === 0) {
    return <span className="font-mono text-xs tabular-nums text-text-muted">0/0</span>;
  }
  const pct = Math.round((resolved / total) * 100);
  return (
    <div className="flex flex-col gap-1">
      <b className="font-mono font-semibold tabular-nums">
        {resolved}/{total} ({pct}%)
      </b>
      <Bar pct={pct} />
    </div>
  );
}

/**
 * 矩阵表单元格的纯文本呈现(§7.8):不带进度条,分子分母永远同框,百分比压弱一档。
 * 分母为 0 时用「0/0 (—)」而不是空白——这一格确实有分类归属,只是这段时间没有样本,
 * 与「这个仓库 × 分类组合从未出现过」(单元格整体缺失,上层直接渲染「—」)是两回事。
 */
function RateText({
  resolved,
  total,
  emphasis = false,
}: {
  resolved: number;
  total: number;
  emphasis?: boolean;
}) {
  if (total === 0) {
    return (
      <span className="font-mono tabular-nums text-text-disabled">
        0/0 <span>(—)</span>
      </span>
    );
  }
  const pct = Math.round((resolved / total) * 100);
  return (
    <span className={cn("font-mono tabular-nums", emphasis ? "font-bold text-primary" : undefined)}>
      {resolved}/{total}{" "}
      <span className={emphasis ? undefined : "text-text-muted"}>({pct}%)</span>
    </span>
  );
}

/**
 * 一组 cell 求和。总处置率与逐仓库处置率是同一个口径,只差过滤条件。
 *
 * `resolved` 是分子合计(人工 + 自动),`manual` 与 `auto` 是它的两列拆分。
 */
function sum(cells: Cell[]): {
  resolved: number;
  manual: number;
  auto: number;
  total: number;
} {
  return cells.reduce(
    (acc, cell) => ({
      resolved: acc.resolved + disposed(cell),
      manual: acc.manual + cell.resolved,
      auto: acc.auto + cell.fixed,
      total: acc.total + denominator(cell),
    }),
    { resolved: 0, manual: 0, auto: 0, total: 0 },
  );
}

function percent(part: { resolved: number; total: number }): number {
  return part.total === 0 ? 0 : Math.round((part.resolved / part.total) * 100);
}

/**
 * 总处置率一枚,给评审记录页的页头用。点进去就是本页的完整拆解——数字自己带路,
 * 不用人先记住它在哪一页。
 *
 * 窗口是服务端的默认窗口(近 30 天),与本页可调的时间窗互不影响,所以查询键分开。
 */
export function SummaryRate() {
  const stats = useQuery({
    queryKey: ["stats", "band"],
    queryFn: () => fetchJson<{ cells: Cell[] }>("/stats"),
  });
  if (stats.isError) {
    return (
      <Link
        to="/stats"
        className="flex items-center gap-1.5 rounded-sm border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ExclamationTriangleIcon className="size-4" aria-hidden />
        <span className="text-xs font-medium">处置率读取失败</span>
      </Link>
    );
  }
  if (stats.data === undefined) return (
    <span role="status" aria-label="正在读取处置率摘要" aria-busy="true">
      <Skeleton aria-hidden className="h-8 w-44" />
    </span>
  );
  const all = sum(stats.data.cells);
  return (
    <Link
      to="/stats"
      className="flex items-baseline gap-1.5 rounded-sm border border-border bg-card px-2.5 py-1.5 outline-none transition-colors hover:border-primary/50 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <b className="font-mono text-base font-semibold tabular-nums">{percent(all)}%</b>
      <span className="text-xs text-muted-foreground">
        近 30 天处置率 {all.resolved}/{all.total}
      </span>
    </Link>
  );
}

export function StatsPage() {
  const [from, setFrom] = useState(() => isoDay(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const [to, setTo] = useState(() => isoDay(Date.now()));

  const stats = useQuery({
    queryKey: ["stats", from, to],
    queryFn: async () => {
      // 日期框被清空时不发空串——漏掉的那头由服务端默认窗口兜底。
      const params = new URLSearchParams();
      if (from) params.set("from", `${from}T00:00:00.000Z`);
      if (to) params.set("to", `${to}T23:59:59.999Z`);
      const response = await api(`/stats?${params}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `请求失败(${response.status})`);
      }
      return (await response.json()) as StatsResponse;
    },
  });

  const cells = stats.data?.cells ?? [];
  const repos = [...new Set(cells.map(repoName))].sort();
  const categories = [...new Set(cells.map((cell) => cell.category))].sort();
  const byKey = new Map(cells.map((cell) => [`${repoName(cell)}\n${cell.category}`, cell]));
  const repoTotal = (repo: string) => sum(cells.filter((cell) => repoName(cell) === repo));
  // 矩阵合计行(全部仓库)的总计,与逐仓库合计同一口径,只是不按仓库过滤。
  const grandTotal = sum(cells);
  const participation = stats.data?.models ?? [];

  return (
    <>
      <PageBody width="form" className="gap-4 pb-5 sm:pb-5">
        <PageHeader
          title={
            <span className="inline-flex items-center gap-2">
              处置率
              <HelpTooltip
                label="处置率计算方式"
                content="处置率 = 已处置 Finding ÷ 可处置 Finding，按仓库与分类分列。已处置分人工与自动两列：人工是人点的 resolve，自动是系统判定已修复时处置的。同一处 Finding 只统计一次，不论几个模型报出；无法关联到行级评论的 Finding 与已延续的都不计入。"
              />
            </span>
          }
          actions={
            <DateRangePicker
              value={{ from, to }}
              onChange={(value) => {
                setFrom(value.from);
                setTo(value.to);
              }}
            />
          }
        />
        {stats.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>{(stats.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        {stats.isPending ? (
          <div className="space-y-5" role="status" aria-label="正在读取处置率统计" aria-busy="true">
            <Skeleton aria-hidden className="h-20" />
            <Skeleton aria-hidden className="h-40" />
            <Skeleton aria-hidden className="h-64" />
          </div>
        ) : null}

        {stats.data === undefined ? null : (
          // KPI 卡同款读数(§7.6):token 是本页主读数走 29px,运行次数与明细压小一档。
          <section
            aria-label="时间窗用量"
            className="flex flex-col gap-4 rounded-lg border border-card-line bg-surface px-[19px] py-[17px] shadow-card sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-[5px]">
              <span className="text-base font-semibold text-text-muted">Token 用量</span>
              <b className="font-mono text-6xl font-extrabold leading-[1.15] tracking-[-0.03em] tabular-nums">
                {stats.data.usage === null
                  ? "—"
                  : stats.data.usage.totalTokens.toLocaleString("zh-CN")}
              </b>
              {stats.data.usage === null ? null : (
                <span className="text-base text-text-muted tabular-nums">
                  输入 {stats.data.usage.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
                  {stats.data.usage.outputTokens.toLocaleString("zh-CN")} · 缓存读{" "}
                  {stats.data.usage.cacheReadTokens.toLocaleString("zh-CN")} · 缓存写{" "}
                  {stats.data.usage.cacheWriteTokens.toLocaleString("zh-CN")}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-[5px] sm:items-end sm:text-right">
              <span className="text-base font-semibold text-text-muted">运行次数</span>
              <div className="font-mono text-2xl font-bold tabular-nums">
                {stats.data.usage === null ? "—" : stats.data.usage.runs.toLocaleString("zh-CN")}
              </div>
            </div>
          </section>
        )}

        {repos.length > 0 ? (
          <section
            aria-labelledby="repo-rate-heading"
            className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card"
          >
            <div className="border-b border-line px-5 py-3.5">
              <h2 id="repo-rate-heading" className="text-2xl font-bold tracking-[-0.015em]">
                按仓库统计
              </h2>
            </div>
            <div className="divide-y divide-line">
              {repos.map((repo) => {
                const total = repoTotal(repo);
                const pct = percent(total);
                return (
                  <div
                    key={repo}
                    className="grid gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(10rem,1fr)] sm:items-center sm:gap-4"
                  >
                    <span className="break-all font-mono text-xs text-text-muted">{repo}</span>
                    <span className="font-mono text-6xl font-bold leading-[1.15] tracking-[-0.03em] tabular-nums">
                      {pct}%
                    </span>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-xs text-text-muted">
                        <span className="font-mono tabular-nums">
                          {total.resolved}/{total.total}
                        </span>{" "}
                        条已处置
                      </span>
                      <Bar pct={pct} />
                      {/* 人工与自动分列(ADR 0016):resolve 衡量「人看过」的口径只对
                          人工那一列成立,合成一个数字会把两件事读成一件。 */}
                      <span className="text-xs text-text-muted">
                        人工 <span className="font-mono tabular-nums">{total.manual}</span>
                        {" · "}自动 <span className="font-mono tabular-nums">{total.auto}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {repos.length === 0 && !stats.isPending && !stats.isError ? (
          <EmptyState
            title="当前时间范围暂无可统计的 Finding"
            titleAs="h2"
            description="统计只包含带行级评论的 Finding。当前时间范围可能没有评审记录，或 Finding 无法关联到变更行。请扩大时间范围后重试。"
            className="rounded-lg border border-card-line bg-surface p-4 shadow-card"
          />
        ) : null}

        {repos.length > 0 ? (
          <section aria-labelledby="rate-matrix-heading" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rate-matrix-heading" className="text-2xl font-bold tracking-[-0.015em]">
                仓库与分类
              </h2>
              <p className="text-xs text-text-muted">每格显示已处置数量 / 分母（百分比）</p>
            </div>
            <div className="flex flex-col gap-2 lg:hidden">
              {repos.map((repo) => {
                const total = repoTotal(repo);
                return (
                  <Collapsible.Root
                    key={repo}
                    className="group/repo-rate overflow-hidden rounded-lg border border-card-line bg-surface shadow-card"
                  >
                    <Collapsible.Trigger
                      type="button"
                      className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="break-all font-mono text-xs font-medium">{repo}</p>
                        <p className="mt-0.5 text-xs text-text-muted">展开查看全部分类</p>
                      </div>
                      <div className="w-32 shrink-0">
                        <span className="mb-1 block text-xs text-text-muted">合计</span>
                        <Rate resolved={total.resolved} total={total.total} />
                      </div>
                      <ChevronDownIcon
                        aria-hidden
                        className="size-4 shrink-0 text-text-muted transition-transform group-data-[state=open]/repo-rate:rotate-180"
                      />
                    </Collapsible.Trigger>
                    <Collapsible.Content>
                      <dl className="divide-y divide-line border-t border-line">
                        {categories.map((category) => {
                          const cell = byKey.get(`${repo}\n${category}`);
                          return (
                            <div key={category} className="grid grid-cols-[minmax(0,1fr)_8rem] items-start gap-3 px-3 py-2.5">
                              <dt className="break-words text-text-muted">{category}</dt>
                              <dd>
                                {cell === undefined ? (
                                  <span className="font-mono text-xs tabular-nums text-text-muted">—</span>
                                ) : (
                                  <Rate resolved={disposed(cell)} total={denominator(cell)} />
                                )}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    </Collapsible.Content>
                  </Collapsible.Root>
                );
              })}
            </div>
            {/* 桌面矩阵表(§7.8):首列 220px 粘性,「合计」列走 accent tint,合计行(全部仓库)走次级面。 */}
            <Card size="1" className="hidden min-w-0 max-w-full overflow-hidden lg:block">
              <div className="-m-3">
                <Table.Root size="2">
                  <caption className="sr-only">
                    逐仓库、逐类别的处置率。单元格内容为「已处置 / 可处置（处置率）」，末尾一行是全部仓库的合计。
                  </caption>
                  <Table.Header className="bg-sunken text-sm font-bold text-text-muted">
                    <Table.Row>
                      <Table.ColumnHeaderCell className="sticky left-0 z-20 w-[220px] min-w-[220px] border-r border-line bg-sunken">
                        仓库
                      </Table.ColumnHeaderCell>
                      {categories.map((category) => (
                        <Table.ColumnHeaderCell key={category} className="text-right">
                          {category}
                        </Table.ColumnHeaderCell>
                      ))}
                      <Table.ColumnHeaderCell className="w-[130px] min-w-[130px] bg-accent-tint text-right">
                        合计
                      </Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {repos.map((repo) => {
                      const total = repoTotal(repo);
                      return (
                        <Table.Row key={repo} className="group">
                          {/* 行首是这一行的表头:屏幕阅读器念单元格时会带上仓库名。 */}
                          <Table.RowHeaderCell
                            className="sticky left-0 z-10 border-r border-line bg-card font-mono font-bold whitespace-nowrap group-hover:bg-sunken"
                          >
                            {repo}
                          </Table.RowHeaderCell>
                          {categories.map((category) => {
                            const cell = byKey.get(`${repo}\n${category}`);
                            return (
                              <Table.Cell key={category} className="min-w-32 text-right text-base">
                                {cell === undefined ? (
                                  <span className="font-mono text-xs tabular-nums text-text-muted">
                                    —
                                  </span>
                                ) : (
                                  <RateText resolved={disposed(cell)} total={denominator(cell)} />
                                )}
                              </Table.Cell>
                            );
                          })}
                          <Table.Cell className="min-w-32 bg-accent-tint text-right text-base font-bold">
                            <RateText resolved={total.resolved} total={total.total} />
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                    {/* 合计行(全部仓库):按分类对全部仓库求和,数据直接派生自已加载的 cells,不发新请求。 */}
                    <Table.Row className="bg-sunken">
                      <Table.RowHeaderCell className="sticky left-0 z-10 border-r border-line bg-sunken font-bold">
                        全部仓库
                      </Table.RowHeaderCell>
                      {categories.map((category) => {
                        const categoryTotal = sum(cells.filter((cell) => cell.category === category));
                        return (
                          <Table.Cell key={category} className="min-w-32 text-right text-base font-semibold">
                            <RateText resolved={categoryTotal.resolved} total={categoryTotal.total} />
                          </Table.Cell>
                        );
                      })}
                      <Table.Cell className="min-w-32 bg-accent-tint text-right text-md">
                        <RateText resolved={grandTotal.resolved} total={grandTotal.total} emphasis />
                      </Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table.Root>
              </div>
            </Card>
          </section>
        ) : null}

        {/* 模型这一维只剩参与条数(ADR 0015):它回答「这个模型有没有在干活」,不回答
            「它报的问题值不值」——处置由人决定,拿处置率给模型打分读不出意义。 */}
        {participation.length > 0 ? (
          <section
            aria-labelledby="model-participation-heading"
            className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3.5">
              <h2
                id="model-participation-heading"
                className="text-2xl font-bold tracking-[-0.015em]"
              >
                模型参与条数
              </h2>
              <p className="text-xs text-text-muted">该模型的参与条数；同一处 Finding 仅统计一次</p>
            </div>
            <dl className="divide-y divide-line">
              {participation.map((entry) => (
                <div
                  key={entry.model}
                  className="flex items-baseline justify-between gap-4 px-5 py-2.5"
                >
                  <dt className="min-w-0 break-all font-mono text-xs text-text-muted">
                    {entry.model}
                  </dt>
                  <dd className="shrink-0 font-mono text-base font-bold tabular-nums">
                    {entry.findings}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

      </PageBody>
    </>
  );
}
