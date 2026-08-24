import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Progress, Skeleton } from "@radix-ui/themes";
import { useMemo, type ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { cn } from "@/lib/utils";

import { fetchJson } from "./api.ts";
import { useModelServices, type ModelServiceHealth } from "./model-services.ts";
import type { RunItem } from "./runs.tsx";
import { hasPermission, loadPanelSession } from "./session.ts";
import type { Cell } from "./stats.tsx";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `/runs` 的一页。评审记录页持有同一形状,这里只读第一页,所以本地声明一份。 */
type RunsPageResponse = { runs: RunItem[]; nextBefore: number | null };

/** `/stats` 回包里总览用得上的部分:分类矩阵。用量与库体量归处置率页。 */
type StatsResponse = { cells: Cell[] };

/**
 * 分母 = 已处置 + 看过未 resolve + 已关闭 PR 上无人处置(ADR 0006),与 `stats.tsx`
 * 的 `denominator` 同一口径。这里复制一行而不 import:处置率页那个模块连着日期选择器
 * 与 react-day-picker,import 进来会把那一整块拽进总览的首屏分块。
 */
function denominator(cell: Cell): number {
  return cell.resolved + cell.unresolved + cell.unknownClosed;
}

function rate(cells: readonly Cell[]): { resolved: number; total: number } {
  return cells.reduce(
    (acc, cell) => ({ resolved: acc.resolved + cell.resolved, total: acc.total + denominator(cell) }),
    { resolved: 0, total: 0 },
  );
}

function percent(part: { resolved: number; total: number }): number {
  return part.total === 0 ? 0 : Math.round((part.resolved / part.total) * 100);
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时区的日键。UTC 日在东八区会把 16:00 之后的 Run 归到前一天。 */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 处置率页的窗口键用 UTC 日,这里照抄,两页才落在同一个查询缓存上。 */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const HEALTH: Record<ModelServiceHealth, { label: string; dot: string }> = {
  healthy: { label: "正常", dot: "bg-success" },
  attention: { label: "需关注", dot: "bg-warning-icon" },
  disabled: { label: "已停用", dot: "bg-neutral-dot" },
};

/** 与评审记录页 `runBucket` 同一判据:整轮失败 → 模型失败 → 待处置 → 完成。 */
function runStatus(run: RunItem): { tone: StatusTone; label: string } {
  if (run.failed) return { tone: "error", label: "运行失败" };
  if (run.models.some((entry) => entry.failure !== null)) return { tone: "warning", label: "部分失败" };
  if (run.total === 0) return { tone: "neutral", label: "无可处置项" };
  return run.resolved === run.total
    ? { tone: "success", label: "已完成" }
    : { tone: "warning", label: "待处置" };
}

/**
 * 卡壳。Themes 的 Card 把圆角画在伪元素上,而这套设计的圆角随视口在 14 / 12 之间换档,
 * 只改根元素的话边框与底色的圆角会错开;列表卡还要求零内边距加逐行分隔。所以卡壳走
 * utility + 令牌,卡内的通用件(徽章、骨架、进度条、按钮)仍是 Themes 组件。
 */
function CardShell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-card-line bg-surface shadow-card sm:rounded-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}

function KpiCard({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <CardShell className={cn("gap-[3px] px-[17px] py-[15px] sm:gap-[5px] sm:px-[19px] sm:py-[17px]", className)}>
      <span className="text-sm font-semibold text-text-muted sm:text-base">{label}</span>
      {children}
    </CardShell>
  );
}

function KpiNumber({ children }: { children: ReactNode }) {
  return (
    <span className="font-display text-5xl font-extrabold tracking-[-0.03em] tabular-nums sm:text-6xl">
      {children}
    </span>
  );
}

function KpiNote({ tone = "muted", children }: { tone?: "muted" | "warning"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "truncate text-sm font-medium sm:text-base",
        tone === "warning" ? "text-warning" : "text-text-muted",
      )}
    >
      {children}
    </span>
  );
}

function KpiSkeleton() {
  return <Skeleton aria-hidden className="h-8 w-16" />;
}

/** 处置率环。设计稿的 r=26 环,周长固定,填充弧长按百分比截取。 */
function DispositionRing({ pct }: { pct: number }) {
  const circumference = 2 * Math.PI * 26;
  return (
    <svg viewBox="0 0 64 64" className="size-11 shrink-0 sm:size-[58px]" aria-hidden>
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="var(--v8-accent-track)"
        className="[stroke-width:9] sm:[stroke-width:8]"
      />
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="var(--v8-accent)"
        strokeLinecap="round"
        strokeDasharray={`${(circumference * pct) / 100} ${circumference}`}
        transform="rotate(-90 32 32)"
        className="[stroke-width:9] sm:[stroke-width:8]"
      />
    </svg>
  );
}

function CardTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-[11px] sm:px-5">
      <h2 className="text-2xl font-bold tracking-[-0.015em]">{title}</h2>
      {action}
    </div>
  );
}

function ErrorNote({ label, message }: { label: string; message: string }) {
  return (
    <Callout.Root role="alert" color="red" size="1" aria-label={label}>
      <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
      <Callout.Text>{message}</Callout.Text>
    </Callout.Root>
  );
}

/**
 * 总览。四张 KPI 卡 + 最近运行 + 右栏(模型服务、各模型处置率),数据全部来自其它页面
 * 已有的四个端点,总览不引入自己的端点,查询键也与各页保持一致以共享缓存。
 *
 * 有两处刻意与设计稿不同,都是「没有数据就不画」:「手动触发评审」按钮需要先选定 PR,
 * 总览上没有这个对象;KPI 的同比信息只在窗口真能覆盖到对照期时才出现。
 */
export function OverviewPage() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  // 模型服务端点要 model:read 或 credential:read,拿不到就整卡不渲染,而不是渲染一张空卡。
  const canReadServices =
    session.data != null &&
    (hasPermission(session.data, "model:read") || hasPermission(session.data, "credential:read"));

  // 窗口在首次渲染时定死:每次渲染重算会让查询键漂移,跨零点也只影响下一次进页面。
  const windows = useMemo(() => {
    const now = Date.now();
    return {
      current: { from: isoDay(now - 6 * DAY_MS), to: isoDay(now) },
      previous: { from: isoDay(now - 13 * DAY_MS), to: isoDay(now - 7 * DAY_MS) },
    };
  }, []);

  const runs = useInfiniteQuery({
    queryKey: ["runs"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchJson<RunsPageResponse>(pageParam === null ? "/runs" : `/runs?before=${pageParam}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  const current = useDispositionWindow(windows.current);
  const previous = useDispositionWindow(windows.previous);
  const services = useModelServices(canReadServices);

  const now = new Date();
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getTime() - DAY_MS));

  // 只读已加载的 Run。总览不额外翻页,所以凡是可能被这一页截断的结论都要自己说清楚。
  const loaded = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const hasMore = (runs.data?.pages.at(-1)?.nextBefore ?? null) !== null;
  const reachesBefore = (day: string): boolean =>
    !hasMore || loaded.some((run) => localDay(new Date(run.startedAt)) < day);
  const todayRuns = loaded.filter((run) => localDay(new Date(run.startedAt)) === today).length;
  const yesterdayRuns = loaded.filter((run) => localDay(new Date(run.startedAt)) === yesterday).length;
  const pendingRuns = loaded.filter((run) => !run.failed && run.total > run.resolved);
  const pendingFindings = pendingRuns.reduce((total, run) => total + (run.total - run.resolved), 0);
  const pendingPulls = new Set(pendingRuns.map((run) => `${run.owner}/${run.repo}#${run.pullNumber}`)).size;

  const currentRate = rate(current.data?.cells ?? []);
  const previousRate = rate(previous.data?.cells ?? []);
  const serviceList = services.data?.services ?? [];
  const healthyServices = serviceList.filter((service) => service.health === "healthy").length;
  const attentionService = serviceList.find((service) => service.health !== "healthy");

  const isRefreshing =
    runs.isFetching || current.isFetching || previous.isFetching || services.isFetching;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["model-services"] });
  }

  return (
    // 页头进内容区:新的 PageHeader 自己不带内边距,也不粘顶,跟着正文一起滚。
    <PageBody width="wide" className="gap-4 sm:gap-[18px]">
      <PageHeader
        title="总览"
        description={`${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日，${WEEKDAY[now.getDay()] ?? ""}`}
        actions={
          <Button
            type="button"
            variant="outline"
            color="gray"
            size={{ initial: "3", sm: "1" }}
            disabled={isRefreshing}
            onClick={refresh}
          >
            {isRefreshing ? "正在刷新…" : "刷新"}
          </Button>
        }
      />

      {runs.isError ? <ErrorNote label="评审记录读取失败" message={runs.error.message} /> : null}
      {current.isError ? <ErrorNote label="处置率读取失败" message={current.error.message} /> : null}
      {services.isError ? <ErrorNote label="模型服务读取失败" message={services.error.message} /> : null}

      <div
        className={cn(
          "grid grid-cols-2 gap-[11px] sm:gap-[14px]",
          canReadServices ? "sm:grid-cols-4" : "sm:grid-cols-3",
        )}
      >
        <KpiCard label="今日运行">
          {runs.isPending ? (
            <KpiSkeleton />
          ) : (
            <KpiNumber>{reachesBefore(today) ? todayRuns : `≥ ${todayRuns}`}</KpiNumber>
          )}
          {runs.isPending ? null : reachesBefore(yesterday) ? (
            <KpiNote>
              {todayRuns === yesterdayRuns
                ? "与昨日持平"
                : `${todayRuns > yesterdayRuns ? "↑" : "↓"} ${Math.abs(todayRuns - yesterdayRuns)} 较昨日`}
            </KpiNote>
          ) : (
            // 昨天的记录还压在下一页里,这时候算同比只会得到一个偏小的差值,改说窗口。
            <KpiNote>取自最近 {loaded.length} 轮</KpiNote>
          )}
        </KpiCard>

        <KpiCard label="待处置发现">
          {runs.isPending ? <KpiSkeleton /> : <KpiNumber>{pendingFindings}</KpiNumber>}
          {runs.isPending ? null : (
            <KpiNote>{`分布在 ${pendingPulls} 个 PR · 最近 ${loaded.length} 轮`}</KpiNote>
          )}
        </KpiCard>

        {/* 环形图卡是唯一的横向变体:标签与数字收成左列,环挂在右边。 */}
        <CardShell className="flex-row items-center justify-between gap-3 px-[17px] py-[15px] sm:px-[19px] sm:py-[17px]">
          <div className="flex min-w-0 flex-col gap-[3px] sm:gap-[5px]">
            <span className="text-sm font-semibold text-text-muted sm:text-base">七日处置率</span>
            {current.isPending ? <KpiSkeleton /> : <KpiNumber>{percent(currentRate)}%</KpiNumber>}
            {current.isPending || previousRate.total === 0 ? null : (
              // 上一个七日窗口有样本才谈同比;没样本时百分点差是拿 0% 当基准,是假的。
              <KpiNote>
                {percent(currentRate) === percent(previousRate)
                  ? "与上周持平"
                  : `${percent(currentRate) > percent(previousRate) ? "↑" : "↓"} ${Math.abs(percent(currentRate) - percent(previousRate))}pt 较上周`}
              </KpiNote>
            )}
          </div>
          {current.isPending ? null : <DispositionRing pct={percent(currentRate)} />}
        </CardShell>

        {canReadServices ? (
          <KpiCard label="模型健康">
            {services.isPending ? (
              <KpiSkeleton />
            ) : (
              <div className="flex items-baseline gap-2.5">
                <KpiNumber>
                  {healthyServices}
                  <span className="text-2xl font-semibold text-text-disabled sm:text-3xl">
                    /{serviceList.length}
                  </span>
                </KpiNumber>
                <div className="flex items-center gap-[5px]">
                  {serviceList.map((service) => (
                    <span
                      key={service.provider}
                      role="img"
                      aria-label={`${service.name} ${HEALTH[service.health].label}`}
                      className={cn("size-[7px] rounded-full sm:size-2", HEALTH[service.health].dot)}
                    />
                  ))}
                </div>
              </div>
            )}
            {services.isPending ? null : attentionService === undefined ? (
              <KpiNote>{serviceList.length === 0 ? "还没有配置模型服务" : "全部正常"}</KpiNote>
            ) : (
              <KpiNote tone="warning">
                {`${attentionService.name}：${attentionService.runCapability.reasonText ?? HEALTH[attentionService.health].label}`}
              </KpiNote>
            )}
          </KpiCard>
        ) : null}
      </div>

      <div className="grid gap-[14px] lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <CardShell className="overflow-hidden">
          <CardTitle
            title="最近运行"
            action={
              <Link
                to="/runs"
                className="shrink-0 rounded-chip text-md font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                查看全部
              </Link>
            }
          />
          {runs.isPending ? (
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5" role="status" aria-label="正在读取最近运行" aria-busy="true">
              {[0, 1, 2, 3, 4].map((row) => (
                <Skeleton key={row} aria-hidden className="h-10" />
              ))}
            </div>
          ) : loaded.length === 0 ? (
            <div className="border-t border-line px-4 sm:px-5">
              <EmptyState
                title="还没有评审记录"
                description="注册仓库并推送 PR 之后，这里会按时间倒序列出每一轮审查。"
              />
            </div>
          ) : (
            loaded.slice(0, 5).map((run, index) => (
              <RunRow
                key={run.id}
                run={run}
                today={today}
                yesterday={yesterday}
                // 第五行只在桌面出现:390px 下列表放四行,再多就把右栏之外的内容也挤出首屏。
                className={index === 4 ? "max-sm:hidden" : undefined}
              />
            ))
          )}
        </CardShell>

        <aside className="flex flex-col gap-[14px] max-sm:hidden">
          {canReadServices ? (
            <CardShell className="overflow-hidden">
              <CardTitle title="模型服务" />
              {services.isPending ? (
                <div className="flex flex-col gap-2 px-5 pb-4" role="status" aria-label="正在读取模型服务" aria-busy="true">
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} aria-hidden className="h-6" />
                  ))}
                </div>
              ) : serviceList.length === 0 ? (
                <div className="border-t border-line px-5">
                  <EmptyState title="还没有模型服务" description="在模型服务页添加第一个服务。" />
                </div>
              ) : (
                serviceList.map((service) => (
                  <div
                    key={service.provider}
                    className="flex items-center justify-between gap-3 border-t border-line px-5 py-[11px]"
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate font-medium",
                        service.health === "disabled" ? "text-text-disabled" : null,
                      )}
                    >
                      {service.name}
                    </span>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 text-base",
                        service.health === "disabled" ? "text-text-disabled" : "text-text-secondary",
                      )}
                    >
                      <span aria-hidden className={cn("size-[7px] rounded-full", HEALTH[service.health].dot)} />
                      {HEALTH[service.health].label}
                    </span>
                  </div>
                ))
              )}
            </CardShell>
          ) : null}

          <CardShell className="overflow-hidden">
            <div className="flex flex-col px-5 pt-3.5">
              <h2 className="text-2xl font-bold tracking-[-0.015em]">各模型处置率</h2>
              <span className="text-base text-text-muted">近 7 日</span>
            </div>
            <ModelRates cells={current.data?.cells ?? []} isPending={current.isPending} />
          </CardShell>
        </aside>
      </div>
    </PageBody>
  );
}

/**
 * 处置率窗口。查询键与处置率页逐字一致(`["stats", from, to]`),两页看同一个窗口时
 * 走同一份缓存;URL 也照那边拼,缓存未命中时拿到的才是同一个窗口的数据。
 */
function useDispositionWindow(window: { from: string; to: string }) {
  return useQuery({
    queryKey: ["stats", window.from, window.to],
    queryFn: () =>
      fetchJson<StatsResponse>(
        `/stats?from=${window.from}T00%3A00%3A00.000Z&to=${window.to}T23%3A59%3A59.999Z`,
      ),
  });
}

function ModelRates({ cells, isPending }: { cells: readonly Cell[]; isPending: boolean }) {
  if (isPending) {
    return (
      <div className="flex flex-col gap-3 px-5 py-3.5" role="status" aria-label="正在读取各模型处置率" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} aria-hidden className="h-8" />
        ))}
      </div>
    );
  }
  const models = [...new Set(cells.map((cell) => cell.model))]
    .map((model) => ({ model, ...rate(cells.filter((cell) => cell.model === model)) }))
    .filter((entry) => entry.total > 0)
    .sort((left, right) => percent(right) - percent(left));
  if (models.length === 0) {
    return (
      <div className="px-5">
        <EmptyState title="近 7 日没有可统计的处置" description="这个窗口内还没有可处置的 Finding。" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[13px] px-5 pt-3.5 pb-[18px]">
      {models.map((entry) => (
        <div key={entry.model} className="flex flex-col gap-[5px]">
          <div className="flex items-baseline justify-between gap-3 text-base">
            <span className="min-w-0 truncate font-mono">{entry.model}</span>
            <span className="shrink-0 font-bold tabular-nums">
              {percent(entry)}%
              <span className="ml-1 font-normal text-text-muted">
                {entry.resolved}/{entry.total}
              </span>
            </span>
          </div>
          {/* 低分用 soft 变体压一档:一栏里三条同样浓的蓝会把「哪个更差」抹平。 */}
          <Progress aria-hidden value={percent(entry)} size="1" variant={percent(entry) >= 80 ? "surface" : "soft"} />
        </div>
      ))}
    </div>
  );
}

function RunRow({
  run,
  today,
  yesterday,
  className,
}: {
  run: RunItem;
  today: string;
  yesterday: string;
  className?: string | undefined;
}) {
  const status = runStatus(run);
  const started = new Date(run.startedAt);
  const day = localDay(started);
  const clock = `${pad(started.getHours())}:${pad(started.getMinutes())}`;
  const time = day === today ? clock : day === yesterday ? `昨天 ${clock}` : `${day.slice(5)} ${clock}`;
  return (
    <Link
      to="/runs"
      search={{ run: run.id }}
      aria-label={`${run.owner}/${run.repo} #${run.pullNumber} ${status.label}`}
      className={cn(
        "flex items-center gap-[11px] border-t border-line px-4 py-3 outline-none transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 sm:gap-3 sm:px-5",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-lg font-semibold">
          {run.owner}/{run.repo} <span className="font-normal text-text-muted">#{run.pullNumber}</span>
        </span>
        <span className="truncate text-base text-text-muted">
          <span className="rounded-chip bg-accent-tint-strong px-[5px] font-mono text-xs text-primary">
            {run.headSha.slice(0, 7)}
          </span>
          {` · ${run.triggeredBy === null ? "自动" : "手动"} · ${time}`}
          {/* 窄屏没有右侧的计数列,处置进度并进这一行。 */}
          <span className="sm:hidden">{run.total === 0 ? "" : ` · 处置 ${run.resolved}/${run.total}`}</span>
        </span>
      </span>
      <span className="shrink-0 text-base tabular-nums text-text-muted max-sm:hidden">
        {run.total === 0 ? "—" : `处置 ${run.resolved}/${run.total}`}
      </span>
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      <ChevronRightIcon className="size-3 shrink-0 text-text-faint" aria-hidden />
    </Link>
  );
}
