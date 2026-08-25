import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Badge, Callout, Dialog, SegmentedControl, Skeleton, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { DetailPanel } from "@/components/detail-panel";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localClock, localDay } from "@/lib/time";

import { api, errorText, fetchJson } from "./api.ts";
import { RunDiff } from "./run-diff.tsx";
import { RunTrace } from "./run-trace.tsx";
import { loadPanelSession, pullRequestUrl } from "./session.ts";
import { StageSummaryView } from "./stage-summary.tsx";
import { SummaryRate } from "./stats.tsx";
import { costPresentation, type UsageSummary } from "./usage-cost.ts";

export type RunItem = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** 被审 pull request 的标题快照;null 即范围审查那一档或升级前的旧行。 */
  title: string | null;
  startedAt: string;
  /** 手动重新运行的调用者用户名快照；null 表示自动触发。 */
  triggeredBy: string | null;
  /** 这一轮归属的范围审查；null 即由 pull request 触发。 */
  rangeReviewId: number | null;
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
  /** 本轮落库的每一条 Finding。详情的 diff 视图把它们锚在对应文件行上。 */
  findings: RunFinding[];
  /** 人工处置掉的 Finding 条数。 */
  resolved: number;
  /** 「已修复」自动处置掉的 Finding 条数。 */
  fixed: number;
  total: number;
};

/** 已处置的 Finding 条数:人工与自动都算。进度与状态一律按它判。 */
export function disposedCount(run: { resolved: number; fixed: number }): number {
  return run.resolved + run.fixed;
}

/**
 * 一条落库的 Finding。`commentId` 为 null 的那些只活在 review 正文里(fallback),
 * 没有可处置的载体,行内不给处置动作。
 */
export type RunFinding = {
  id: number;
  /** 报出它的全部模型,按首报先后(ADR 0015)。 */
  models: string[];
  file: string;
  line: number;
  severity: "P0" | "P1" | "P2";
  category: string;
  description: string;
  /**
   * `fixed` 是「已修复」自动处置,处置人为空;`continued` 是「已延续」——这处代码已改写,
   * 同一条 Finding 由新一轮在新位置那条承接,这一行只剩交接的记录,不是处置。
   */
  disposition: "resolved" | "unresolved" | "unknown" | "fixed" | "continued";
  placement: "inline" | "body";
  commentId: string | null;
  /** Forge 上那条原评论的地址。 */
  commentHtmlUrl: string | null;
  /** 在面板上处置的人与时刻;在 Gitea 上处置的两项为 null。 */
  disposedBy: string | null;
  disposedAt: string | null;
  /** 处置备注,只存面板。 */
  note: string | null;
  /** 承接来的那条旧评论的地址(CONTEXT.md 已延续);不是延续来的为 null。 */
  continuedFrom: string | null;
};

/**
 * 评审记录里的一行(issue #174):一个审查阶段,不是一轮 Review Run。同一 pull request
 * 推多少次、同一范围审查推进多少次,列表里都只有这一行。
 *
 * `stageId` 由来源与键合成(`pr:<owner>/<repo>/<number>` 与 `range:<id>`),阶段详情
 * 的地址用它作路径参数。容器 PR 的序号不在这里:它对面板用户透明(CONTEXT.md 容器 PR)。
 */
export type StageItem = {
  stageId: string;
  source: "pull-request" | "range-review";
  owner: string;
  repo: string;
  /** pull request 阶段的 PR 号;范围审查阶段为 null。 */
  pullNumber: number | null;
  /** 范围审查阶段的标识;pull request 阶段为 null。 */
  rangeReviewId: number | null;
  /** pull request 的标题快照;没有标题的旧行与范围审查都是 null。 */
  title: string | null;
  status: "active" | "closed";
  /** 最新一轮 Review Run;范围审查刚发起、一轮都还没跑时为 null。 */
  latestRunId: number | null;
  latestRunAt: string | null;
  /** 最新一轮跑完的时刻;还在跑时为 null,列表据此决定要不要续查。 */
  latestRunFinishedAt: string | null;
  /** 阶段汇总的三个数,与 `GET /stage-summary` 同一口径。 */
  counts: { pending: number; resolved: number; fixed: number };
};

type StagesPage = { stages: StageItem[]; nextOffset: number | null };

/** 列表可按状态与来源筛选,两项默认都是全部(issue #174)。 */
export type StageStatusFilter = "all" | "active" | "closed";
export type StageSourceFilter = "all" | "pull-request" | "range-review";

/**
 * 一行审查阶段的名字:有标题就用标题,没有的显示 `#编号`(issue #173、#174)。
 * pull request 的编号是它的 PR 号,范围审查用它自己的标识——容器 PR 的序号不露面。
 */
export function stageLabel(stage: StageItem): string {
  return stage.title ?? `#${stage.pullNumber ?? stage.rangeReviewId}`;
}

/** 阶段来源。两种来源同列同形,只由这枚标记区分(CONTEXT.md 评审记录)。 */
function StageSourceBadge({ stage }: { stage: StageItem }) {
  return (
    <Badge color="gray" variant="soft" radius="full">
      {stage.source === "range-review" ? "范围审查" : "pull request"}
    </Badge>
  );
}

/** 阶段只有进行中与已结束两种状态(CONTEXT.md 审查阶段)。 */
export function StageStatusBadge({ stage }: { stage: StageItem }) {
  return stage.status === "active" ? (
    <StatusBadge tone="running">进行中</StatusBadge>
  ) : (
    <StatusBadge tone="neutral" icon={CheckCircledIcon}>已结束</StatusBadge>
  );
}

/**
 * 行上的阶段汇总:待处置 / 人工已处置 / 已修复。三个数一起显示,不打开详情就能判断
 * 优先级;为零的也留着位置,否则三个数的位置会随内容前后错开。
 */
export function StageCounts({ stage }: { stage: StageItem }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-base tabular-nums text-text-muted">
      <span className={stage.counts.pending > 0 ? "text-warning" : undefined}>
        待处置 {stage.counts.pending}
      </span>
      <span aria-hidden>·</span>
      <span>已处置 {stage.counts.resolved}</span>
      <span aria-hidden>·</span>
      <span>已修复 {stage.counts.fixed}</span>
    </span>
  );
}

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
 * 轮次详情头部的处置进度。与处置率同一口径:只算行级承载的合并组。
 *
 * 「状态到颜色」的映射留在这里:它同时被仓库页与评审记录页用,拆掉这层包装会把
 * 这条规则散到两个调用点。失败与待处置分成两色——一个去重新运行,一个去处置。
 *
 * 部分模型失败不占这个位置:那一轮跑通的模型报出的 Finding 是真的、可处置的,
 * 处置进度得留着。失败只加一颗红点提示「这一轮的结论不完整」,原因看卡片上的模型行。
 */
function RunPill({ run }: { run: RunItem }) {
  const badge = runBadge(run);
  const down = run.models.filter((entry) => entry.failure !== null);
  if (down.length === 0) return badge;
  const failureSummary = `${down.length}/${run.models.length} 个模型失败，本轮审查结果不完整`;
  return (
    <Tooltip
      maxWidth="32rem"
      content={(
        <span className="block space-y-1">
          <span className="block font-medium">{failureSummary}</span>
          {down.map((entry) => (
            <span key={entry.model} className="block break-words">
              <span className="break-all font-mono">{entry.model}</span>：{entry.failure}
            </span>
          ))}
        </span>
      )}
    >
      <span
        tabIndex={0}
        className="inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {badge}
        <span className="sr-only">{failureSummary}</span>
      </span>
    </Tooltip>
  );
}

/**
 * 一轮审查的结论。总览、评审记录与仓库页共用这一份映射——同一轮在三处显示成不同
 * 的词,读的人得先确认那是不是同一件事。
 *
 * 徽章只说结论,分数由各页自己那一格显示:两边都写就是同一个数字说两遍。
 *
 * total 只计行级承载的合并组:纯正文 Finding 的 Run 落在「无可处置项」——正文没有
 * resolve 载体,本来就无从处置。
 */
export function runStatus(run: RunItem): { tone: StatusTone; label: string } {
  // 未结束的一轮先判:否则它会因为「一条可处置项都还没有」而显示成「无可处置项」。
  if (run.finishedAt === null && !run.failed) return { tone: "running", label: "运行中" };
  if (run.failed) return { tone: "error", label: "运行失败" };
  if (run.models.some((entry) => entry.failure !== null)) return { tone: "warning", label: "部分失败" };
  if (run.total === 0) return { tone: "neutral", label: "无可处置项" };
  return disposedCount(run) === run.total
    ? { tone: "success", label: "已完成" }
    : { tone: "warning", label: "待处置" };
}

function runBadge(run: RunItem) {
  const status = runStatus(run);
  return (
    <StatusBadge tone={status.tone} {...(status.tone === "neutral" ? { icon: CheckCircledIcon } : {})}>
      {status.label}
    </StatusBadge>
  );
}

function triggerLabel(run: RunItem): string {
  return run.triggeredBy === null ? "自动触发" : `手动 · ${run.triggeredBy}`;
}

/**
 * 轮次的来源:pull request 还是范围审查。
 *
 * 两条链路的 `pullNumber` 都指向一个真实 PR(范围审查那条指的是容器 PR),不标出来
 * 的话,列表里一行「acme/widgets #101」看不出这是人开的 PR 还是本工具自建的容器。
 */
function RunSourceBadge({ run }: { run: RunItem }) {
  if (run.rangeReviewId === null) return null;
  return <Badge color="gray" variant="soft" radius="full">范围审查</Badge>;
}

/** 还没跑完的一轮没有耗时可言,返回 null 让调用点整段省掉,而不是显示一个 0。 */
function runDuration(run: RunItem): string | null {
  if (run.finishedAt === null) return null;
  const seconds = Math.round(
    (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

/**
 * 运行详情面板。外壳(定位、材质、头尾结构与关闭)走共用的 `DetailPanel`,这里只组装
 * 这一轮的头部、正文与动作条。
 *
 * 桌面取 wide 那一档:面板里装的是完整 diff,一行代码在窄档里要折三四次才放得下,
 * 而读 diff 的前提是一行就是一行。
 */
export function RunDetailPanel({
  run,
  canRerun,
  canDispose,
  rerunning,
  pullUrl,
  diffFile,
  onRerun,
  onOpenOther,
  onSwitchFilter,
  onClose,
}: {
  run: RunItem;
  canRerun: boolean;
  /** 有 `finding:dispose` 权限时行内出现处置动作。 */
  canDispose: boolean;
  rerunning: boolean;
  /** 打开时先把 diff 筛到这个文件;阶段汇总跳过来时带着它。 */
  diffFile?: string;
  /** pull request 地址;没有配 Forge 基址时是 null,那一格不渲染。 */
  pullUrl: string | null;
  onRerun: () => void;
  /** 点到列表里另一轮时换成它,而不是先关面板。 */
  onOpenOther: (id: number) => void;
  /** 点到筛选控件时切过去,而不是让遮罩把这一下吞掉。 */
  onSwitchFilter: (filter: { kind: string; value: string }) => void;
  onClose: () => void;
}) {
  const cost = costPresentation(run.usage);
  const duration = runDuration(run);
  /*
   * PR 触发的那条链路在这里给出与范围审查详情同一个阶段汇总(issue #168):一个 pull
   * request 从打开到关闭就是一个审查阶段,「这个阶段还剩什么没处置」在两条链路上是
   * 同一个问题。范围审查的轮次不给这个开关——它的阶段汇总就在范围审查详情页上。
   *
   * 审查轨迹(issue #171)两条链路都给:它说的是「这一轮是怎么跑出来的」,与轮次由谁
   * 触发无关。
   */
  const [view, setView] = useState<"diff" | "stage" | "trace">("diff");
  // 阶段汇总只有 PR 触发那条链路有;停在它上面时点开一轮范围审查,退回本轮 diff。
  const active = view === "stage" && run.rangeReviewId !== null ? "diff" : view;
  return (
    <DetailPanel
      onClose={onClose}
      /*
       * 这是主从列表的详情面板。看完一轮接着看下一轮是这一页最常做的事,而模态
       * 对话框把「点下一行」变成「先关掉、再点一次」。点到列表行时改成换那一轮,
       * 点别处仍然照常关闭。
       */
      onPointerDownOutside={(event) => {
        /*
         * 按坐标做几何命中,既不看 event.target,也不用 elementsFromPoint。
         *
         * 面板是模态的,Radix 会把背景整片设成 `pointer-events: none`:target 永远是
         * 遮罩自己,而 elementsFromPoint 做的是命中测试,不返回 pointer-events 为 none
         * 的元素——那一叠里只剩遮罩和 html。两条路都拿不到人真正想点的东西。
         *
         * 逐个比对矩形不依赖命中测试,所以不受这层屏蔽影响。不接住的话,点下一轮、
         * 点筛选都要点两次:第一下被当成「关掉面板」吃掉。
         */
        const { clientX: x, clientY: y } = event.detail.originalEvent;
        const hit = (selector: string): HTMLElement | null => {
          for (const element of document.querySelectorAll<HTMLElement>(selector)) {
            const rect = element.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
              return element;
            }
          }
          return null;
        };

        const id = Number(hit("[data-run-id]")?.dataset.runId);
        if (Number.isSafeInteger(id) && id > 0) {
          event.preventDefault();
          onOpenOther(id);
          return;
        }
        const control = hit("[data-filter-value]");
        const kind = control?.dataset.filterKind;
        const value = control?.dataset.filterValue;
        if (kind !== undefined && value !== undefined) {
          event.preventDefault();
          onSwitchFilter({ kind, value });
          onClose();
        }
      }}
      header={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <RunPill run={run} />
            <RunSourceBadge run={run} />
            {duration === null ? null : (
              <span className="text-base text-text-muted">耗时 {duration}</span>
            )}
          </div>
          <Dialog.Title className="!mb-0 min-w-0 !text-3xl !font-extrabold !tracking-[-0.02em] break-all">
            {run.owner}/{run.repo} #{run.pullNumber}
          </Dialog.Title>
          <div className="flex flex-wrap items-center gap-1.5 text-base text-text-muted">
            <CommitChip sha={run.headSha} />
            <span aria-hidden>·</span>
            <span className="break-all">{triggerLabel(run)}</span>
            <span aria-hidden>·</span>
            <span>{localDay(run.startedAt)} {localClock(run.startedAt)}</span>
          </div>
        </>
      }
      headerBelow={
        run.total === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-base text-text-secondary">
              <span>处置进度</span>
              <span className="font-bold tabular-nums text-text">
                {disposedCount(run)} / {run.total}
              </span>
            </div>
            {/* 两段一条:人工在前,自动接在后面。两者都是已处置,只是来路不同。 */}
            <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-accent-track">
              <div
                className="h-full bg-primary"
                style={{ width: `${(run.resolved / run.total) * 100}%` }}
              />
              <div
                className="h-full bg-primary/40"
                style={{ width: `${(run.fixed / run.total) * 100}%` }}
              />
            </div>
            {run.fixed === 0 ? null : (
              <p className="text-sm text-text-muted tabular-nums">
                人工 {run.resolved} · 自动 {run.fixed}
              </p>
            )}
          </div>
        )
      }
      footer={
        canRerun || pullUrl !== null ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-overlay-line px-6 py-3.5">
            {/*
              处置在面板行内做,这一格留给「去看原版」:整轮 review 的上下文、别人的
              讨论与代码本身都在那边,单条 Finding 的链接给不出这些。
            */}
            {pullUrl === null ? <span /> : (
              <Button asChild variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
                <a href={pullUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  去 pull request 看原版
                </a>
              </Button>
            )}
            {canRerun ? (
              <Button
                variant="solid"
                size={{ initial: "3", sm: "2" }}
                disabled={rerunning}
                onClick={onRerun}
              >
                {rerunning ? "重新运行中…" : "重新运行"}
              </Button>
            ) : null}
          </footer>
        ) : null
      }
    >
      <SegmentedControl.Root
        value={active}
        onValueChange={(value) => {
          if (value === "diff" || value === "stage" || value === "trace") setView(value);
        }}
        size="1"
        aria-label="详情视图"
        className="w-fit"
      >
        <SegmentedControl.Item value="diff">本轮 diff</SegmentedControl.Item>
        {run.rangeReviewId === null ? (
          <SegmentedControl.Item value="stage">阶段汇总</SegmentedControl.Item>
        ) : null}
        <SegmentedControl.Item value="trace">审查轨迹</SegmentedControl.Item>
      </SegmentedControl.Root>

      {/*
        详情默认是这一轮的完整 diff:文件列表加逐文件 diff,Finding 锚在对应行上。
        `key` 换成 run.id,换一轮时筛选与展开状态跟着重置,不把上一轮的筛选带过来。
      */}
      {active === "trace" ? (
        <RunTrace key={run.id} run={run} />
      ) : active === "stage" ? (
        <StageSummaryView
          key={`${run.owner}/${run.repo}#${run.pullNumber}`}
          scope={{
            kind: "pull-request",
            owner: run.owner,
            repo: run.repo,
            pullNumber: run.pullNumber,
          }}
          canDispose={canDispose}
          onJumpToRun={() => setView("diff")}
        />
      ) : (
        <RunDiff
          key={run.id}
          run={run}
          canDispose={canDispose}
          {...(diffFile === undefined ? {} : { initialFile: diffFile })}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-sm text-text-muted">
        {run.usage === undefined ? null : (
          <span className="tabular-nums">
            用量 输入 {run.usage.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
            {run.usage.outputTokens.toLocaleString("zh-CN")} tokens
          </span>
        )}
        <span className="tabular-nums">成本 {cost.amount}</span>
      </div>
      {cost.note === null ? null : (
        <p className="px-1 text-sm break-words text-warning">{cost.note}</p>
      )}
    </DetailPanel>
  );
}

/**
 * 按 id 取一轮,再把它交给详情面板(issue #174)。
 *
 * 评审记录的一行是一个审查阶段,行上只带最新一轮的 id;轮次本身在这里读,评审记录页
 * 与仓库页共用同一条路径,两处点开的是同一份东西。
 */
export function RunDetailPanelById({
  runId,
  canRerun,
  canDispose,
  rerunning,
  diffFile,
  onRerun,
  onOpenOther,
  onSwitchFilter,
  onClose,
}: {
  runId: number;
  canRerun: boolean;
  canDispose: boolean;
  rerunning: boolean;
  diffFile?: string;
  /** 重跑要的是这一轮本身,取回来之后交回给调用页去发请求。 */
  onRerun: (run: RunItem) => void;
  onOpenOther: (id: number) => void;
  onSwitchFilter: (filter: { kind: string; value: string }) => void;
  onClose: () => void;
}) {
  // 只为拿 Forge 基址,好把这一轮指回它的 pull request。与壳共用同一份会话缓存。
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchJson<{ run: RunItem }>(`/runs/${runId}`),
    // 还在跑的那一轮每 10 秒续查,跑完就停:人打开面板正是想看它跑出什么。
    refetchInterval: (query) => (query.state.data?.run.finishedAt === null ? 10_000 : false),
  });
  if (run.isError) {
    return (
      <DetailPanel
        onClose={onClose}
        header={<Dialog.Title className="!mb-0 !text-3xl !font-extrabold">轮次读取失败</Dialog.Title>}
      >
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(run.error as Error).message}</Callout.Text>
        </Callout.Root>
      </DetailPanel>
    );
  }
  // 读取中先不铺面板:内容一到就整块出现,空壳一闪反而更晃眼。
  if (run.data === undefined) return null;
  return (
    <RunDetailPanel
      run={run.data.run}
      canRerun={canRerun}
      canDispose={canDispose}
      rerunning={rerunning}
      pullUrl={
        session.data === undefined || session.data === null
          ? null
          : pullRequestUrl(session.data, run.data.run)
      }
      {...(diffFile === undefined ? {} : { diffFile })}
      onOpenOther={onOpenOther}
      onSwitchFilter={onSwitchFilter}
      onRerun={() => onRerun(run.data.run)}
      onClose={onClose}
    />
  );
}

/** 一行的时间:最新一轮什么时候开跑。范围审查刚发起、还没跑过时说清楚是这一档。 */
function latestRunLabel(stage: StageItem): string {
  if (stage.latestRunAt === null) return "还没有跑过";
  return `最新一轮 ${localDay(stage.latestRunAt)} ${localClock(stage.latestRunAt)}`;
}

/** 筛选控件的一档。`data-filter-*` 让详情面板接住点在它上面的那一下。 */
function FilterControl<T extends string>({
  kind,
  label,
  value,
  options,
  onChange,
}: {
  kind: string;
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
}) {
  return (
    <SegmentedControl.Root
      value={value}
      onValueChange={(next) => {
        const hit = options.find(([id]) => id === next);
        if (hit !== undefined) onChange(hit[0]);
      }}
      size={{ initial: "3", sm: "1" }}
      aria-label={label}
      className="w-fit max-sm:w-full"
    >
      {options.map(([id, text]) => (
        <SegmentedControl.Item key={id} value={id} data-filter-kind={kind} data-filter-value={id}>
          {text}
        </SegmentedControl.Item>
      ))}
    </SegmentedControl.Root>
  );
}

const STATUS_OPTIONS = [
  ["all", "全部"],
  ["active", "进行中"],
  ["closed", "已结束"],
] as const satisfies readonly (readonly [StageStatusFilter, string])[];

const SOURCE_OPTIONS = [
  ["all", "全部来源"],
  ["pull-request", "pull request"],
  ["range-review", "范围审查"],
] as const satisfies readonly (readonly [StageSourceFilter, string])[];

/** 阶段列表的查询串。筛选与分页都在服务端做,这里只负责把它们拼准。 */
export function stagesPath(query: {
  offset: number;
  status?: StageStatusFilter;
  source?: StageSourceFilter;
  owner?: string;
  repo?: string;
}): string {
  const params = new URLSearchParams();
  if (query.offset > 0) params.set("offset", String(query.offset));
  if (query.status !== undefined && query.status !== "all") params.set("status", query.status);
  if (query.source !== undefined && query.source !== "all") params.set("source", query.source);
  if (query.owner !== undefined && query.repo !== undefined) {
    params.set("owner", query.owner);
    params.set("repo", query.repo);
  }
  const search = params.toString();
  return search === "" ? "/stages" : `/stages?${search}`;
}

export function RunsPage({ canRerun, canDispose }: { canRerun: boolean; canDispose: boolean }) {
  const navigate = useNavigate();
  /*
   * 筛选与打开哪一行都记在地址里:链接要能指明列表的哪一片、能直接落到某一个阶段,
   * 浏览器后退键要能收起详情。筛选切换用 replace,否则点几下分段控件就把历史塞满。
   */
  const filter = useRouterState({
    select: (state) => {
      const search = state.location.search as { status?: unknown; source?: unknown };
      return {
        status: (search.status === "active" || search.status === "closed"
          ? search.status
          : "all") as StageStatusFilter,
        source: (search.source === "pull-request" || search.source === "range-review"
          ? search.source
          : "all") as StageSourceFilter,
      };
    },
  });
  const setFilter = (next: Partial<{ status: StageStatusFilter; source: StageSourceFilter }>) => {
    void navigate({
      to: "/runs",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(next.status === undefined ? {} : { status: next.status === "all" ? undefined : next.status }),
        ...(next.source === undefined ? {} : { source: next.source === "all" ? undefined : next.source }),
      }),
      replace: true,
    });
  };
  const stages = useInfiniteQuery({
    queryKey: ["stages", filter.status, filter.source],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchJson<StagesPage>(
        stagesPath({ offset: pageParam, status: filter.status, source: filter.source }),
      ),
    getNextPageParam: (last) => last.nextOffset,
    /*
     * 审查是异步的:推一个 pull request 之后要跑上几分钟。还有轮次没跑完时自动续查,
     * 跑完就停——否则人只能盯着页面反复点刷新,而这恰恰是最想看结果的那几分钟。
     */
    refetchInterval: (query) =>
      (query.state.data?.pages ?? []).some((page) =>
        page.stages.some((stage) => stage.latestRunId !== null && stage.latestRunFinishedAt === null),
      )
        ? 10_000
        : false,
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const openedRunId = useRouterState({
    select: (state) => {
      const value = (state.location.search as { run?: unknown }).run;
      const id = typeof value === "number" ? value : Number(value);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
  });
  const setOpenedRunId = (id: number | null) => {
    // 只动 run 这一格,别把筛选一起清掉;换一行或收起面板时把 file 一并清掉——它说的是
    // 「落地先看哪个文件」,只对跳过来的那一轮成立。开合详情进历史记录(不 replace),
    // 后退键因此能收起面板。
    void navigate({
      to: "/runs",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        run: id ?? undefined,
        file: undefined,
      }),
    });
  };
  // 阶段汇总跳过来时带着文件:那一条 Finding 在哪个文件里,落地就先展开哪个文件。
  const openedFile = useRouterState({
    select: (state) => {
      const value = (state.location.search as { file?: unknown }).file;
      return typeof value === "string" && value !== "" ? value : undefined;
    },
  });
  const rerun = useMutation({
    mutationFn: rerunRequest,
    onSuccess: (text) => setFeedback({ text, isError: false }),
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  // 滚到底部附近自动加载下一页。
  const sentinel = useRef<HTMLDivElement>(null);
  const listViewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (
        stages.hasNextPage &&
        !stages.isFetchingNextPage &&
        entries.some((entry) => entry.isIntersecting)
      ) {
        void stages.fetchNextPage();
      }
    }, { root: listViewport.current, rootMargin: "0px 0px 160px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [stages.fetchNextPage, stages.hasNextPage, stages.isFetchingNextPage]);

  const flat = stages.data?.pages.flatMap((page) => page.stages) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBody width="wide" className="min-h-0 flex-1 pb-4 sm:pb-4">
        <PageHeader
          title="评审记录"
          // 读取中不占位说明:计数一到就替换掉,那一行字只会闪一下。
          {...(stages.isPending
            ? {}
            : { description: `已加载 ${flat.length} 个审查阶段` })}
          actions={<SummaryRate />}
        />

        {feedback === null ? null : (
          <Callout.Root
            role={feedback.isError ? "alert" : "status"}
            color={feedback.isError ? "red" : "green"}
            size="1"
          >
            <Callout.Icon>
              {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
            </Callout.Icon>
            <Callout.Text>{feedback.text}</Callout.Text>
          </Callout.Root>
        )}
        {stages.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(stages.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <FilterControl
            kind="status"
            label="按状态过滤"
            value={filter.status}
            options={STATUS_OPTIONS}
            onChange={(status) => setFilter({ status })}
          />
          <FilterControl
            kind="source"
            label="按来源过滤"
            value={filter.source}
            options={SOURCE_OPTIONS}
            onChange={(source) => setFilter({ source })}
          />
        </div>

        <div
          ref={listViewport}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
          aria-busy={stages.isPending || stages.isFetchingNextPage}
          aria-label="评审记录列表"
        >
          {stages.isPending ? (
            <div
              className="flex flex-col gap-2 overflow-hidden rounded-lg border border-card-line bg-surface p-2 shadow-card"
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">正在加载评审记录</span>
              {[0, 1, 2, 3].map((slot) => <Skeleton key={slot} className="h-14" />)}
            </div>
          ) : null}

          {flat.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
              {flat.map((stage) => (
                <MasterListItem
                  key={stage.stageId}
                  selected={stage.latestRunId !== null && stage.latestRunId === openedRunId}
                  // 一轮都还没跑的阶段没有可打开的轮次:点它不做任何事,而不是打开一个空面板。
                  onClick={() => {
                    if (stage.latestRunId !== null) setOpenedRunId(stage.latestRunId);
                  }}
                  aria-haspopup="dialog"
                  {...(stage.latestRunId === null ? {} : { "data-run-id": stage.latestRunId })}
                  className="group flex items-center gap-3 border-t border-line px-5 py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-lg font-semibold group-data-[selected=true]:font-bold">
                        {stage.owner}/{stage.repo} {stageLabel(stage)}
                      </span>
                      <StageSourceBadge stage={stage} />
                    </span>
                    <span className="flex flex-wrap items-center gap-x-1.5 text-base font-normal text-text-muted">
                      <span className="tabular-nums">{latestRunLabel(stage)}</span>
                    </span>
                  </span>
                  {/* 三个数在窄屏让位给状态徽章:390px 下它们会把标题挤成两个字。 */}
                  <span className="max-sm:hidden"><StageCounts stage={stage} /></span>
                  <span className="shrink-0"><StageStatusBadge stage={stage} /></span>
                </MasterListItem>
              ))}
            </div>
          ) : null}

          {flat.length === 0 && !stages.isPending && !stages.isError ? (
            <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
              <EmptyState
                title={
                  filter.status === "all" && filter.source === "all"
                    ? "暂无审查记录"
                    : "没有符合条件的审查记录"
                }
                titleAs="h2"
                description={
                  filter.status === "all" && filter.source === "all" ? (
                    <>
                      向已注册仓库提交 pull request 后，系统会自动运行审查。
                      {canRerun ? "如需对已有 pull request 重新运行审查，请到仓库页选择仓库并输入 PR 编号。" : null}
                    </>
                  ) : (
                    "换一个状态或来源再看。"
                  )
                }
                action={
                  canRerun && filter.status === "all" && filter.source === "all" ? (
                    <Button variant="outline" color="gray" size={{ initial: "4", sm: "1" }} asChild>
                      <Link to="/repos">去仓库页</Link>
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : null}
          <div ref={sentinel} />
          <p className="pt-3 text-center text-sm text-text-muted" aria-live="polite">
            {stages.isFetchingNextPage
              ? "加载更早的审查记录…"
              : stages.hasNextPage
                ? "继续下滑加载更早的审查记录"
                : flat.length > 0
                  ? "已加载全部记录"
                  : ""}
          </p>
        </div>
      </PageBody>

      {openedRunId === null ? null : (
        <RunDetailPanelById
          runId={openedRunId}
          canRerun={canRerun}
          canDispose={canDispose}
          rerunning={rerun.isPending}
          {...(openedFile === undefined ? {} : { diffFile: openedFile })}
          onOpenOther={setOpenedRunId}
          onSwitchFilter={({ kind, value }) => {
            if (kind === "status" && STATUS_OPTIONS.some(([id]) => id === value)) {
              setFilter({ status: value as StageStatusFilter });
            }
            if (kind === "source" && SOURCE_OPTIONS.some(([id]) => id === value)) {
              setFilter({ source: value as StageSourceFilter });
            }
          }}
          onRerun={(run) => {
            rerun.mutate(run);
            // 结果落在页面顶部的 Callout 上,面板压着它人就看不见,所以触发即收面板。
            setOpenedRunId(null);
          }}
          onClose={() => setOpenedRunId(null)}
        />
      )}
    </div>
  );
}
