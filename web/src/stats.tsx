import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarIcon, ChevronDownIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { useState } from "react";

import { HelpTooltip } from "@/components/help-tooltip";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/theme-button";
import { Calendar } from "@/components/ui/calendar";
import { Card, Skeleton, Table } from "@radix-ui/themes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { api, fetchJson } from "./api.ts";
import { costPresentation, type UsageSummary } from "./usage-cost.ts";

export type Cell = {
  model: string;
  category: string;
  resolved: number;
  unresolved: number;
  unknownClosed: number;
  unknownOpen: number;
};

type StatsResponse = {
  from: string;
  to: string;
  cells: Cell[];
  usage: UsageSummary | null;
  database: { fileBytes: number; tables: { name: string; rows: number }[] };
};

/** 分母 = 已处置 + 看过未 resolve + 已关闭 PR 上无人处置(ADR 0006)。 */
export function denominator(cell: Cell): number {
  return cell.resolved + cell.unresolved + cell.unknownClosed;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 日历给的是 Date,窗口两头存的是 `YYYY-MM-DD`。两个方向都走本地字段,
 * 不经 `toISOString()`——东八区选 8 月 1 日会被 UTC 挪成 7 月 31 日。
 */
function dayString(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayDate(day: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (parts === null) return undefined;
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 进度条:两个 div 的事,不引组件。旁边一定有分子分母的文字,所以对屏幕阅读器隐藏——
 * 念一遍宽度百分比只是把同一个数说两次。
 */
function Bar({ pct }: { pct: number }) {
  return (
    <div aria-hidden className="h-1 overflow-hidden rounded-sm bg-border">
      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 比率永远带原始分子分母,读者自己判断样本够不够(ADR 0006)。 */
function Rate({ resolved, total }: { resolved: number; total: number }) {
  if (total === 0) {
    return <span className="font-mono text-xs tabular-nums text-muted-foreground">0/0</span>;
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

/** 一组 cell 求和。总处置率与逐模型处置率是同一个口径,只差过滤条件。 */
function sum(cells: Cell[]): { resolved: number; total: number } {
  return cells.reduce(
    (acc, cell) => ({
      resolved: acc.resolved + cell.resolved,
      total: acc.total + denominator(cell),
    }),
    { resolved: 0, total: 0 },
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
  if (stats.data === undefined) return <Skeleton className="h-8 w-44" />;
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

  const fromDate = dayDate(from);
  const cells = stats.data?.cells ?? [];
  const models = [...new Set(cells.map((cell) => cell.model))].sort();
  const categories = [...new Set(cells.map((cell) => cell.category))].sort();
  const byKey = new Map(cells.map((cell) => [`${cell.model}\n${cell.category}`, cell]));
  const modelTotal = (model: string): { resolved: number; total: number } =>
    sum(cells.filter((cell) => cell.model === model));
  const usageCost = costPresentation(stats.data?.usage);

  return (
    <>
      <PageHeader
        title="处置率"
        description={
          <span className="inline-flex items-center gap-1.5">
            查看不同模型和问题分类的 Finding 处置率。
            <HelpTooltip
              label="处置率计算方式"
              content="处置率 = 已处置 Finding ÷ 可处置 Finding。同一处 Finding 只统计一次；无法关联到行级评论的 Finding 不计入。"
            />
          </span>
        }
        actions={
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" color="gray" size="3" className="max-w-full text-xs">
                <CalendarIcon />
                <span className={from === "" ? undefined : "font-mono"}>{from === "" ? "起始不限" : from}</span>
                <span className="text-muted-foreground">→</span>
                <span className={to === "" ? undefined : "font-mono"}>{to === "" ? "至今" : to}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-0">
              <Calendar
                mode="range"
                numberOfMonths={2}
                {...(fromDate === undefined ? {} : { defaultMonth: fromDate })}
                selected={{ from: fromDate, to: dayDate(to) }}
                onSelect={(range) => {
                  setFrom(range?.from === undefined ? "" : dayString(range.from));
                  setTo(range?.to === undefined ? "" : dayString(range.to));
                }}
              />
            </PopoverContent>
          </Popover>
        }
      />

      <PageBody width="wide" className="gap-4 pb-5 sm:pb-5">
        {stats.isError ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
          >
            <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{(stats.error as Error).message}</span>
          </p>
        ) : null}

        {stats.isPending ? (
          <>
            <Skeleton className="h-20" />
            <Skeleton className="h-40" />
            <Skeleton className="h-64" />
          </>
        ) : null}

        {stats.data === undefined ? null : (
          <section
            aria-label="时间窗用量"
            className="flex flex-col gap-3 border-y border-border bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">时间范围费用</span>
              <b className="font-mono text-xl font-semibold tabular-nums">{usageCost.amount}</b>
              {usageCost.note === null ? null : (
                <span className="text-xs text-warning">{usageCost.note}</span>
              )}
            </div>
            <div className="sm:text-right">
              <div className="font-mono text-lg font-semibold tabular-nums">
                {stats.data.usage === null
                  ? "—"
                  : stats.data.usage.totalTokens.toLocaleString("zh-CN")}
              </div>
              <span className="text-xs text-muted-foreground">tokens</span>
            </div>
          </section>
        )}

        {models.length > 0 ? (
          <section aria-labelledby="model-rate-heading" className="overflow-hidden rounded-sm border border-border">
            <div className="bg-muted px-3 py-2">
              <h2 id="model-rate-heading" className="text-base font-semibold">
                按模型统计
              </h2>
            </div>
            <div className="divide-y divide-border">
              {models.map((model) => {
                const total = modelTotal(model);
                const pct = percent(total);
                return (
                  <div
                    key={model}
                    className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(10rem,1fr)] sm:items-center sm:gap-4"
                  >
                    <span className="break-all font-mono text-xs text-muted-foreground">{model}</span>
                    <span className="font-mono text-3xl font-semibold tracking-tight tabular-nums">
                      {pct}%
                    </span>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono tabular-nums">
                          {total.resolved}/{total.total}
                        </span>{" "}
                        条已处置
                      </span>
                      <Bar pct={pct} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {models.length === 0 && !stats.isPending && !stats.isError ? (
          <Card size="2" className="flex flex-col items-start gap-1.5">
            <h2 className="text-base font-semibold">当前时间范围暂无可统计的 Finding</h2>
            <p className="text-muted-foreground">
              统计只包含带行级评论的 Finding。当前时间范围可能没有审查记录，或 Finding 无法关联到变更行。
              请扩大时间范围后重试。
            </p>
          </Card>
        ) : null}

        {models.length > 0 ? (
          <section aria-labelledby="rate-matrix-heading" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rate-matrix-heading" className="text-base font-semibold">
                模型与分类
              </h2>
              <p className="text-xs text-muted-foreground">每格显示已处置数量 / 分母（百分比）</p>
            </div>
            <div className="flex flex-col gap-2 lg:hidden">
              {models.map((model) => {
                const total = modelTotal(model);
                return (
                  <details key={model} className="group overflow-hidden rounded-sm border border-border bg-card">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2.5 outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
                      <div className="min-w-0 flex-1">
                        <p className="break-all font-mono text-xs font-medium">{model}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">展开查看全部分类</p>
                      </div>
                      <div className="w-32 shrink-0">
                        <span className="mb-1 block text-xs text-muted-foreground">合计</span>
                        <Rate resolved={total.resolved} total={total.total} />
                      </div>
                      <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                    </summary>
                    <dl className="divide-y divide-border border-t border-border">
                      {categories.map((category) => {
                        const cell = byKey.get(`${model}\n${category}`);
                        return (
                          <div key={category} className="grid grid-cols-[minmax(0,1fr)_8rem] items-start gap-3 px-3 py-2.5">
                            <dt className="break-words text-muted-foreground">{category}</dt>
                            <dd>
                              {cell === undefined ? (
                                <span className="font-mono text-xs tabular-nums text-muted-foreground">—</span>
                              ) : (
                                <Rate resolved={cell.resolved} total={denominator(cell)} />
                              )}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  </details>
                );
              })}
            </div>
            <Card size="1" className="hidden min-w-0 max-w-full overflow-hidden lg:block">
              <div className="-m-3">
                <Table.Root size="2">
                  <caption className="sr-only">
                    逐模型、逐类别的处置率,单元格内容为「已处置/分母(百分比)」。
                  </caption>
                  <Table.Header className="bg-muted text-xs text-muted-foreground">
                    <Table.Row>
                      <Table.ColumnHeaderCell className="sticky left-0 z-20 bg-muted">
                        模型
                      </Table.ColumnHeaderCell>
                      {categories.map((category) => (
                        <Table.ColumnHeaderCell key={category}>
                          {category}
                        </Table.ColumnHeaderCell>
                      ))}
                      <Table.ColumnHeaderCell className="bg-muted/80">
                        合计
                      </Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {models.map((model) => {
                      const total = modelTotal(model);
                      return (
                        <Table.Row key={model} className="group">
                          {/* 行首是这一行的表头:屏幕阅读器念单元格时会带上模型名。 */}
                          <Table.RowHeaderCell
                            className="sticky left-0 z-10 bg-card font-mono whitespace-nowrap group-hover:bg-muted"
                          >
                            {model}
                          </Table.RowHeaderCell>
                          {categories.map((category) => {
                            const cell = byKey.get(`${model}\n${category}`);
                            return (
                              <Table.Cell key={category} className="min-w-32">
                                {cell === undefined ? (
                                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                    —
                                  </span>
                                ) : (
                                  <Rate resolved={cell.resolved} total={denominator(cell)} />
                                )}
                              </Table.Cell>
                            );
                          })}
                          <Table.Cell className="min-w-32 bg-muted/30">
                            <Rate resolved={total.resolved} total={total.total} />
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              </div>
            </Card>
          </section>
        ) : null}

        {stats.data === undefined ? null : (
          <section className="border-t border-border pt-4">
            <h2 className="text-base font-semibold">数据存储</h2>
            <dl className="mt-2 divide-y divide-border border-y border-border">
              <div className="flex justify-between gap-3 py-2">
                <dt className="text-muted-foreground">数据库文件</dt>
                <dd className="font-mono tabular-nums">{humanBytes(stats.data.database.fileBytes)}</dd>
              </div>
              {stats.data.database.tables.map((table) => (
                <div className="flex justify-between gap-3 py-2" key={table.name}>
                  <dt className="break-all font-mono text-muted-foreground">{table.name}</dt>
                  <dd className="shrink-0">
                    <span className="font-mono tabular-nums">{table.rows}</span> 行
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              评审记录会参与历史处置率统计。
            </p>
          </section>
        )}
      </PageBody>
    </>
  );
}
