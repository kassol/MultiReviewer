import { useQuery } from "@tanstack/react-query";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { api } from "./api.ts";

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

/** 进度条:两个 div 的事,不引组件。 */
function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-[3px] overflow-hidden rounded-sm bg-border">
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
    <div className="flex flex-col gap-0.5">
      <b className="font-mono text-[13px] font-semibold tabular-nums">
        {resolved}/{total} ({pct}%)
      </b>
      <Bar pct={pct} />
    </div>
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
    cells
      .filter((cell) => cell.model === model)
      .reduce(
        (acc, cell) => ({
          resolved: acc.resolved + cell.resolved,
          total: acc.total + denominator(cell),
        }),
        { resolved: 0, total: 0 },
      );

  return (
    <div className="flex max-w-[1060px] flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[19px] font-semibold tracking-tight">处置率</h1>
          <p className="text-muted-foreground">
            人看过并做了结论的 Finding 占比。同一处 Finding 只算一次,进不了行级评论的不计入。
          </p>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="lg" className="ml-auto font-mono text-xs">
              <CalendarIcon />
              {from === "" ? "起始不限" : from}
              <span className="text-muted-foreground">→</span>
              {to === "" ? "至今" : to}
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
      </div>

      {stats.isError ? (
        <p className="text-destructive">{(stats.error as Error).message}</p>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {models.map((model) => {
          const total = modelTotal(model);
          const pct = total.total === 0 ? 0 : Math.round((total.resolved / total.total) * 100);
          return (
            <Card key={model} className="gap-2 px-4">
              <span className="font-mono text-xs text-muted-foreground">{model}</span>
              <span className="font-mono text-[30px] leading-none font-semibold tracking-tight tabular-nums">
                {pct}%
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {total.resolved}/{total.total} 条已处置
              </span>
              <Bar pct={pct} />
            </Card>
          );
        })}
        {models.length === 0 && !stats.isPending ? (
          <p className="text-muted-foreground">这个时间窗里没有可统计的 Finding。</p>
        ) : null}
      </div>

      {models.length > 0 ? (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                {categories.map((category) => (
                  <TableHead key={category}>{category}</TableHead>
                ))}
                <TableHead>合计</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => {
                const total = modelTotal(model);
                return (
                  <TableRow key={model}>
                    <TableCell className="font-mono whitespace-nowrap">{model}</TableCell>
                    {categories.map((category) => {
                      const cell = byKey.get(`${model}\n${category}`);
                      return (
                        <TableCell key={category} className="min-w-[104px]">
                          {cell === undefined ? (
                            <span className="font-mono text-xs tabular-nums text-muted-foreground">
                              —
                            </span>
                          ) : (
                            <Rate resolved={cell.resolved} total={denominator(cell)} />
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell>
                      <Rate resolved={total.resolved} total={total.total} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {stats.data === undefined ? null : (
        <Card className="gap-2 px-4">
          <h2 className="font-semibold">库体量</h2>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">库文件</span>
            <span className="font-mono tabular-nums">
              {humanBytes(stats.data.database.fileBytes)}
            </span>
          </div>
          {stats.data.database.tables.map((table) => (
            <div className="flex justify-between gap-3" key={table.name}>
              <span className="font-mono text-muted-foreground">{table.name}</span>
              <span className="font-mono tabular-nums">{table.rows} 行</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            评审记录只写不清:处置率算在历史行上,删行即删样本。
          </p>
        </Card>
      )}
    </div>
  );
}
