import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Skeleton } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { localSecond } from "@/lib/time";

import { apiUrl, fetchJson } from "./api.ts";
import { type RunItem } from "./runs.tsx";

/**
 * 审查轨迹里的一条事件(CONTEXT.md 审查轨迹)。`kind` 是开放的字符串:后端加一种事件
 * 不该让面板崩,认不出来的那条按原样摊出 payload。
 */
export type TraceEvent = {
  seq: number;
  /** 事件属于哪一轮。面板是按轮次取的,这一格只在契约里留个位置,渲染不读它。 */
  runId: number;
  at: string;
  scope: "run" | "reviewer";
  /** `scope` 为 `reviewer` 时是模型标识,与 `RunItem.models[].model` 同一个值。 */
  reviewer?: string;
  kind: string;
  payload: Record<string, unknown>;
};

/** `GET /runs/{id}/trace` 的全量事件,按 `seq` 升序。 */
type TraceList = { events: TraceEvent[] };

function traceKey(runId: number): [string, number] {
  return ["run-trace", runId];
}

/**
 * 同一个 seq 只留一条并保持升序:断线重连会把重叠的那几条再回放一遍,而 SSE 的到达
 * 顺序不是契约的一部分。
 */
function appendEvent(prev: TraceList | undefined, event: TraceEvent): TraceList {
  const events = prev?.events ?? [];
  if (events.some((known) => known.seq === event.seq)) return { events };
  const at = events.findIndex((known) => known.seq > event.seq);
  return at === -1
    ? { events: [...events, event] }
    : { events: [...events.slice(0, at), event, ...events.slice(at)] };
}

// payload 是 `Record<string, unknown>`:每个字段读之前先验一次形状,后端改了字段
// 名或类型时那一格显示成缺失,而不是让整个面板白屏。
function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `finding_merged` 的一个成员:哪个 Reviewer、报在哪一行、标题是什么。 */
type MergedMember = { reviewer: string; line: number | null; title: string };

function members(payload: Record<string, unknown>): MergedMember[] {
  const value = payload["members"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const reviewer = str(item, "reviewer");
    if (reviewer === null) return [];
    return [{ reviewer, line: num(item, "line"), title: str(item, "title") ?? "" }];
  });
}

/**
 * 合并判据(ADR 0015):行号相同是硬证据,其余按行距加标题相似度。相似度是 0–1 的
 * Jaccard,按百分比读——阈值 0.05 在界面上就是 5%。
 */
function criteriaText(payload: Record<string, unknown>): string | null {
  const criteria = record(payload, "criteria");
  if (criteria === null) return null;
  const kind = str(criteria, "kind");
  if (kind === "same_line") return "同一行";
  if (kind !== "distance") return kind;
  const distance = num(criteria, "distance");
  const similarity = num(criteria, "similarity");
  const parts = [
    distance === null ? null : `相距 ${distance} 行`,
    similarity === null ? null : `相似度 ${Math.round(similarity * 100)}%`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "行距与相似度" : parts.join(" · ");
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 一行摘要用的紧凑 JSON,过长时截断——完整参数在展开里给。 */
function summarize(value: unknown, limit = 160): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function EventTime({ at }: { at: string }) {
  return (
    <span className="w-[4.5rem] shrink-0 pt-px font-mono text-xs tabular-nums text-text-faint">
      {localSecond(at)}
    </span>
  );
}

/** 认不出的事件按原样摊开:轨迹的用途是追溯,藏起来等于把一条真实事件抹掉。 */
function UnknownEvent({ event }: { event: TraceEvent }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-base text-text">{event.kind}</span>
      <pre className="overflow-x-auto rounded-lg bg-fill px-2.5 py-1.5 font-mono text-xs text-text-secondary">
        {pretty(event.payload)}
      </pre>
    </div>
  );
}

/** 轮次级的一条编排里程碑。 */
function RunMilestone({ event }: { event: TraceEvent }) {
  const payload = event.payload;
  const body = (): React.ReactNode => {
    switch (event.kind) {
      case "worktree_ready": {
        const base = str(payload, "baseSha");
        const head = str(payload, "headSha");
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-base text-text">工作副本就绪</span>
            {base === null ? null : <CommitChip sha={base} />}
            {base === null || head === null ? null : <span aria-hidden>→</span>}
            {head === null ? null : <CommitChip sha={head} />}
          </span>
        );
      }
      case "batch_started":
      case "batch_finished": {
        const index = num(payload, "index");
        const total = num(payload, "total");
        const files = strings(payload, "files");
        const label = event.kind === "batch_started" ? "开始" : "结束";
        return (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-base text-text">
              第 <span className="font-mono tabular-nums">{index ?? "?"}</span>/
              <span className="font-mono tabular-nums">{total ?? "?"}</span> 批{label}
            </span>
            {files.length === 0 ? null : (
              <span className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs break-all text-text-muted">
                {files.map((file) => <span key={file}>{file}</span>)}
              </span>
            )}
          </div>
        );
      }
      case "finding_merged": {
        const file = str(payload, "file");
        const line = num(payload, "line");
        const criteria = criteriaText(payload);
        const list = members(payload);
        return (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-base text-text">
                合并 <span className="font-mono tabular-nums">{list.length}</span> 条 Finding
              </span>
              {file === null ? null : (
                <span className="font-mono text-xs break-all text-text-muted">
                  {file}
                  {line === null ? "" : `:${line}`}
                </span>
              )}
              {criteria === null ? null : (
                <Badge color="gray" variant="soft" radius="full">{criteria}</Badge>
              )}
            </span>
            {list.length === 0 ? null : (
              <ul className="flex flex-col gap-0.5">
                {list.map((member, index) => (
                  <li key={`${member.reviewer}-${index}`} className="flex flex-wrap items-baseline gap-1.5 text-sm">
                    <span className="font-mono break-all text-text-muted">{member.reviewer}</span>
                    {member.line === null ? null : (
                      <span className="font-mono tabular-nums text-text-faint">第 {member.line} 行</span>
                    )}
                    <span className="min-w-0 break-words text-text-secondary">{member.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }
      case "review_posted": {
        const count = num(payload, "findingCount");
        return (
          <span className="text-base text-text">
            评论已发{count === null ? "" : ` · `}
            {count === null ? null : (
              <>
                <span className="font-mono tabular-nums">{count}</span> 条 Finding
              </>
            )}
          </span>
        );
      }
      case "run_finished":
        return <span className="text-base font-semibold text-text">本轮结束</span>;
      default:
        return <UnknownEvent event={event} />;
    }
  };

  return (
    <li className="flex items-start gap-2 border-t border-overlay-line px-3 py-2 first:border-t-0">
      <EventTime at={event.at} />
      <div className="min-w-0 flex-1">{body()}</div>
    </li>
  );
}

/** 一次工具调用:一行摘要,参数全文按需展开。返回内容只记长度,不入轨迹。 */
function ToolCall({ event }: { event: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const payload = event.payload;
  const tool = str(payload, "tool") ?? "(未命名工具)";
  const args = payload["args"];
  const duration = num(payload, "durationMs");
  const resultLength = num(payload, "resultLength");
  const isError = payload["isError"] === true;
  const error = str(payload, "error");

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`font-mono text-base ${isError ? "text-danger" : "text-text"}`}>{tool}</span>
        {args === undefined ? null : (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="min-w-0 flex-1 truncate text-left font-mono text-xs text-text-muted underline decoration-dotted underline-offset-4 hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            {summarize(args)}
          </button>
        )}
        <span className="shrink-0 font-mono text-xs tabular-nums text-text-faint">
          {duration === null ? null : `${duration}ms`}
          {duration !== null && resultLength !== null ? " · " : null}
          {resultLength === null ? null : `返回 ${resultLength} 字符`}
        </span>
      </div>
      {isError ? (
        <p className="rounded-lg bg-danger-tint px-2.5 py-1.5 text-sm break-words text-danger">
          调用被拒或出错{error === null ? "" : `：${error}`}
        </p>
      ) : null}
      {open && args !== undefined ? (
        <pre className="overflow-x-auto rounded-lg bg-fill px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-text-secondary">
          {pretty(args)}
        </pre>
      ) : null}
    </div>
  );
}

/** Reviewer 级的一条事件。 */
function ReviewerEvent({ event }: { event: TraceEvent }) {
  const payload = event.payload;
  const body = (): React.ReactNode => {
    switch (event.kind) {
      case "assistant_message":
        // 整条文本摊开,不截断:这就是「它当时在想什么」的唯一记录。
        return (
          <p className="min-w-0 text-base leading-relaxed break-words whitespace-pre-wrap text-text-secondary">
            {str(payload, "text") ?? "(空文本)"}
          </p>
        );
      case "tool_call":
        return <ToolCall event={event} />;
      case "reviewer_failed": {
        const exitCode = num(payload, "exitCode");
        return (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>
              这个 Reviewer 失败：{str(payload, "failure") ?? "未记录原因"}
              {exitCode === null ? null : `（退出码 ${exitCode}）`}
            </Callout.Text>
          </Callout.Root>
        );
      }
      case "reviewer_finished": {
        const findings = num(payload, "findings");
        const rejected = num(payload, "rejectedToolCalls");
        const usage = record(payload, "usage");
        const input = usage === null ? null : num(usage, "inputTokens");
        const output = usage === null ? null : num(usage, "outputTokens");
        return (
          <span className="flex flex-wrap items-baseline gap-x-2 text-base text-text">
            <span>
              完成 · 报出 <span className="font-mono tabular-nums">{findings ?? 0}</span> 条 Finding
            </span>
            {rejected === null || rejected === 0 ? null : (
              <span className="text-warning">
                被契约挡下 <span className="font-mono tabular-nums">{rejected}</span> 次
              </span>
            )}
            {input === null && output === null ? null : (
              <span className="text-sm text-text-muted">
                用量 输入 <span className="font-mono tabular-nums">{input ?? 0}</span> · 输出{" "}
                <span className="font-mono tabular-nums">{output ?? 0}</span> tokens
              </span>
            )}
          </span>
        );
      }
      default:
        return <UnknownEvent event={event} />;
    }
  };

  return (
    <li className="flex items-start gap-2 border-t border-overlay-line px-3 py-2">
      <EventTime at={event.at} />
      <div className="min-w-0 flex-1">{body()}</div>
    </li>
  );
}

/**
 * 一个 Reviewer 的轨迹块。默认折叠:一轮里几个模型各自刷几十条事件,全摊开等于让人
 * 先滚过别人的过程才看到要查的那一个。失败的那个默认展开——它是来这一页的理由。
 */
function ReviewerTrace({
  reviewer,
  events,
  failure,
  open,
  onToggle,
}: {
  reviewer: string;
  events: readonly TraceEvent[];
  /** 这一轮这个模型的失败文本;`null` 即没失败。取自轮次投影,不等轨迹里那条。 */
  failure: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const toolCalls = events.filter((event) => event.kind === "tool_call").length;
  const messages = events.filter((event) => event.kind === "assistant_message").length;
  return (
    <section className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-text-faint" aria-hidden />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-text-faint" aria-hidden />
        )}
        <span
          className={`min-w-0 flex-1 break-all font-mono text-base ${failure === null ? "text-text" : "text-danger"}`}
        >
          {reviewer}
        </span>
        {failure === null ? null : <Badge color="red" variant="soft" radius="full">失败</Badge>}
        <span className="shrink-0 text-sm text-text-muted">
          <span className="font-mono tabular-nums">{messages}</span> 段文本 ·{" "}
          <span className="font-mono tabular-nums">{toolCalls}</span> 次工具
        </span>
      </button>

      {open ? (
        <div className="border-t border-overlay-line">
          {events.length === 0 ? (
            <p className="px-3 py-2.5 text-base text-text-muted">
              这个 Reviewer 还没有产生事件。
            </p>
          ) : (
            <ul className="flex flex-col">
              {events.map((event) => <ReviewerEvent key={event.seq} event={event} />)}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

const STREAM_LABEL = {
  idle: "未连接实时轨迹",
  connecting: "正在连接实时轨迹…",
  open: "实时接收中",
  retry: "连接中断，正在重连…",
  ended: "本轮轨迹已结束",
} as const;

/**
 * Review Run 详情的审查轨迹视图(CONTEXT.md 审查轨迹,issue #171)。
 *
 * 历史由 `GET /runs/{id}/trace` 一次取全,进行中的那一轮再接 SSE 把增量追加到同一份
 * 查询缓存里——两条来源写同一个数组,页面就不必区分「这条是取回来的还是推过来的」。
 */
export function RunTrace({ run }: { run: RunItem }) {
  const queryClient = useQueryClient();
  const trace = useQuery({
    queryKey: traceKey(run.id),
    queryFn: () => fetchJson<TraceList>(`/runs/${run.id}/trace`),
    // 事件只增不改,取回来的那一段永远不会变。不设这一条的话,窗口重新聚焦会用一份
    // 旧快照把 SSE 追加进来的增量整片盖掉。
    staleTime: Number.POSITIVE_INFINITY,
  });
  const live = run.finishedAt === null && !run.failed;
  const [stream, setStream] = useState<keyof typeof STREAM_LABEL>("idle");
  // 人手动开合过的 Reviewer 记在这里,其余按默认规则。
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const loaded = trace.isSuccess;

  useEffect(() => {
    if (!live || !loaded) return;
    const key = traceKey(run.id);
    const known = queryClient.getQueryData<TraceList>(key)?.events ?? [];
    /*
     * 原生 `EventSource` 不能给首个请求设 `Last-Event-ID`,用 `?after=` 表达同样的
     * 语义:从这个 seq 之后开始。之后浏览器自动重连时会自己带上 `Last-Event-ID`,
     * 断线那几秒的事件因此不会丢。
     */
    const source = new EventSource(
      apiUrl(`/runs/${run.id}/trace/stream?after=${known.at(-1)?.seq ?? 0}`),
    );
    // 握手成功前只说「正在连接」:`open` 才是服务端真的把头发过来了。
    setStream("connecting");
    source.addEventListener("open", () => setStream("open"));
    source.addEventListener("trace", (event) => {
      const raw = (event as MessageEvent<string>).data;
      let parsed: TraceEvent;
      try {
        parsed = JSON.parse(raw) as TraceEvent;
      } catch {
        return;
      }
      queryClient.setQueryData<TraceList>(key, (prev) => appendEvent(prev, parsed));
    });
    source.addEventListener("end", () => {
      source.close();
      setStream("ended");
      /*
       * 结束信号只说轨迹到头了。这一轮的结论、Finding 与耗时在轮次与阶段投影里,让读
       * 它们的几份查询各刷新一次,面板头部与列表跟着从「运行中」变过来——否则要等下
       * 一次 10 秒轮询才对得上。
       */
      for (const projection of [["stages"], ["stage-detail"], ["run"]]) {
        void queryClient.invalidateQueries({ queryKey: projection });
      }
    });
    source.onerror = () => {
      // 浏览器自己按 `Last-Event-ID` 重连,这里只反映连接状态;彻底关闭才算断开。
      setStream(source.readyState === EventSource.CLOSED ? "idle" : "retry");
    };
    return () => source.close();
  }, [live, loaded, run.id, queryClient]);

  const events = trace.data?.events ?? [];
  const milestones = events.filter((event) => event.scope === "run");
  const byReviewer = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.scope !== "reviewer" || event.reviewer === undefined) continue;
    byReviewer.set(event.reviewer, [...(byReviewer.get(event.reviewer) ?? []), event]);
  }
  // 参与本轮的 Reviewer 按轮次投影的顺序排;轨迹里出现而投影里没有的接在后面——
  // 那说明两处对不上,藏起来等于把它的事件从面板上抹掉。
  const reviewers = [
    ...run.models.map((entry) => ({ name: entry.model, failure: entry.failure })),
    ...[...byReviewer.keys()]
      .filter((name) => !run.models.some((entry) => entry.model === name))
      .map((name) => ({ name, failure: null })),
  ];
  const isOpen = (reviewer: { name: string; failure: string | null }): boolean =>
    toggled[reviewer.name] ?? (reviewer.failure !== null || reviewers.length === 1);

  return (
    <div className="flex flex-col gap-3">
      {trace.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(trace.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {live ? (
        <p className="flex items-center gap-1.5 px-1 text-sm text-text-muted" aria-live="polite">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              stream === "open" ? "bg-primary" : stream === "retry" ? "bg-warning" : "bg-text-faint"
            }`}
            aria-hidden
          />
          {STREAM_LABEL[stream]}
        </p>
      ) : null}

      {trace.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在加载这一轮的审查轨迹</span>
          {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-12" />)}
        </div>
      ) : null}

      {milestones.length === 0 ? null : (
        <section className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
          <h3 className="border-b border-overlay-line px-3 py-2.5 text-2xl font-bold">
            本轮里程碑
            <span className="ml-2 font-mono text-base font-normal tabular-nums text-text-muted">
              {milestones.length}
            </span>
          </h3>
          <ul className="flex flex-col">
            {milestones.map((event) => <RunMilestone key={event.seq} event={event} />)}
          </ul>
        </section>
      )}

      {reviewers.map((reviewer) => (
        <ReviewerTrace
          key={reviewer.name}
          reviewer={reviewer.name}
          events={byReviewer.get(reviewer.name) ?? []}
          failure={reviewer.failure}
          open={isOpen(reviewer)}
          onToggle={() =>
            setToggled((prev) => ({ ...prev, [reviewer.name]: !isOpen(reviewer) }))
          }
        />
      ))}

      {trace.data !== undefined && events.length === 0 && reviewers.length === 0 ? (
        <EmptyState
          title="这一轮没有留下审查轨迹"
          description="它跑在轨迹开始记录之前。"
          className="py-2"
        />
      ) : null}
    </div>
  );
}
