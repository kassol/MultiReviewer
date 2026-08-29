/**
 * 审查轨迹(CONTEXT.md):一轮 Review Run 里按时间顺序发生的事件序列。规则轨迹
 * (CONTEXT.md,issue #214)同源:一次基点探索或一次处置反哺是一条,事件形状与广播共用
 * 这一份,只是落在另一张表上。
 *
 * 事件的形状由本项目定义,与 Pi 的会话结构无关(ADR 0017)。一条事件先落库、再广播给
 * 这条轨迹的进程内订阅者;面板打开时读表补历史,运行中经 SSE 收新增的行。
 *
 * 订阅者只在进程内:服务是单进程单实例(Docker),不引入外部消息通道。
 */
import type { RuleProposalSource, Store } from "./store.ts";

/** 事件挂在轮次上还是挂在某个 Reviewer 上。 */
export type TraceScope = "run" | "reviewer";

/** Reviewer 级的事件类型。前两档由子进程转发,后两档由编排层在该模型跑完时补。 */
export type ReviewerTraceKind =
  | "assistant_message"
  | "tool_call"
  | "reviewer_failed"
  | "reviewer_finished";

/** Review Run 级的编排事件类型。 */
export type RunTraceKind =
  | "worktree_ready"
  | "batch_started"
  | "batch_finished"
  | "finding_merged"
  | "review_posted"
  | "run_finished";

export type TraceKind = ReviewerTraceKind | RunTraceKind;

/**
 * 规则轨迹的事件类型(CONTEXT.md 规则轨迹,issue #214)。前三档与 Reviewer 那侧同形,
 * 因为它们来自同一个转换(`reviewer/trace-events.ts`);另外三档由编排层在这次任务开始、
 * 提出条目与收尾时补。
 */
export type RuleTraceKind =
  | "rule_agent_started"
  | "assistant_message"
  | "tool_call"
  | "rule_proposed"
  | "rule_agent_failed"
  | "rule_agent_finished";

/**
 * 轨迹里的一条事件。`seq` 在一轮之内自增,断线续传按它续;`reviewer` 是模型标识,
 * 与 `reviewer_outcome.model` 是同一个值,轮次级事件没有它。
 */
export type TraceEvent = {
  seq: number;
  runId: number;
  at: string;
  scope: TraceScope;
  reviewer?: string;
  kind: TraceKind;
  payload: unknown;
};

/** 待写入的一条事件。`seq` 与 `at` 由落库那一步给。 */
export type TraceEventInput = {
  scope: TraceScope;
  reviewer?: string;
  kind: TraceKind;
  payload: unknown;
};

/** 规则轨迹里的一条事件。`seq` 在一条轨迹之内自增,`taskId` 是这条轨迹的标识。 */
export type RuleTraceEvent = {
  seq: number;
  taskId: number;
  at: string;
  kind: RuleTraceKind;
  payload: unknown;
};

/** 待写入的一条规则轨迹事件。`seq` 与 `at` 由落库那一步给。 */
export type RuleTraceEventInput = { kind: RuleTraceKind; payload: unknown };

type Subscriber = {
  onEvent: (event: TraceEvent | RuleTraceEvent) => void;
  onEnd: () => void;
};

/**
 * 正在跑的轨迹与它们的订阅者。
 *
 * 「这条轨迹还会不会有新事件」只有这里知道:SSE 据此决定回放完就发 `end`,还是接着等。
 * 进程重启后这张表是空的,重启前那些跑到一半的因此按已结束处理——它们确实不会再有新
 * 事件了。
 *
 * 键是频道字符串而非数字:轮次与规则任务各有一套自增标识,同一张表里会撞号。
 */
const live = new Map<string, Set<Subscriber>>();

/** 一轮 Review Run 的轨迹频道。 */
export function runChannel(runId: number): string {
  return `run:${runId}`;
}

/** 一次规则 agent 任务的轨迹频道(issue #214)。 */
export function ruleChannel(taskId: number): string {
  return `rule:${taskId}`;
}

/** 这条轨迹开跑,可以接受订阅。`runReview` 拿到 runId 之后立刻调。 */
export function beginTrace(channel: string): void {
  if (!live.has(channel)) live.set(channel, new Set());
}

/**
 * 订阅这条轨迹的新增事件。返回退订函数;它已经不在跑时返回 undefined——调用方据此知道
 * 没有后续事件可等,该直接收尾。
 */
export function subscribeTrace(
  channel: string,
  subscriber: Subscriber,
): (() => void) | undefined {
  const subscribers = live.get(channel);
  if (subscribers === undefined) return undefined;
  subscribers.add(subscriber);
  return () => {
    live.get(channel)?.delete(subscriber);
  };
}

/** 把一条已落库的事件推给订阅者。 */
function publishTrace(channel: string, event: TraceEvent | RuleTraceEvent): void {
  for (const subscriber of [...(live.get(channel) ?? [])]) subscriber.onEvent(event);
}

/**
 * 这条轨迹结束:通知订阅者不再有新事件,并把它从「在跑」里摘掉。成功、失败与中途抛
 * 异常都要走到这里,否则订阅者会一直等下去。
 */
export function endTrace(channel: string): void {
  const subscribers = live.get(channel);
  if (subscribers === undefined) return;
  live.delete(channel);
  for (const subscriber of [...subscribers]) subscriber.onEnd();
}

/** 一轮的轨迹写入口。落库与广播是同一个动作,不可能只做一半。 */
export type TraceRecorder = {
  /** 轮次级的编排事件。 */
  run(kind: RunTraceKind, payload: unknown): void;
  /** 某个 Reviewer 的事件。`reviewer` 是模型标识。 */
  reviewer(reviewer: string, kind: ReviewerTraceKind, payload: unknown): void;
};

/**
 * 建一轮的轨迹写入口。事件落库失败只记日志:少一条过程记录是小事,一次审查因此白跑
 * 不是——轨迹记的是过程,处置与统计不读它。
 */
export function createTraceRecorder(store: Store, runId: number): TraceRecorder {
  const channel = runChannel(runId);
  const append = (input: TraceEventInput): void => {
    let event: TraceEvent;
    try {
      event = store.appendTrace(runId, input);
    } catch (error) {
      console.error(
        "[review] 审查轨迹落库失败,审查照常:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    publishTrace(channel, event);
  };

  return {
    run: (kind, payload) => append({ scope: "run", kind, payload }),
    reviewer: (reviewer, kind, payload) =>
      append({ scope: "reviewer", reviewer, kind, payload }),
  };
}

/** 一条规则轨迹的写入口(issue #214)。`taskId` 为 null 即这条轨迹没起来,写入是空操作。 */
export type RuleTraceRecorder = {
  taskId: number | null;
  record(kind: RuleTraceKind, payload: unknown): void;
  end(): void;
};

/**
 * 起一条规则轨迹并返回它的写入口。第一条 `rule_agent_started` 事件同时是这条轨迹的
 * 标识来源(见 `rule_trace` 表)。
 *
 * 落库失败(起头那一条也算)只记日志:轨迹记的是过程,规则条目与提案不读它,少一条
 * 过程记录不该让一次探索或一次反哺白跑。
 */
export function startRuleTrace(
  /** 开一次库做一件事。规则 agent 的两条链路都跑在后台,没有一份长活的 `Store`。 */
  withStore: <T>(use: (store: Store) => T) => T,
  repoId: number,
  source: RuleProposalSource,
  startedPayload: unknown,
): RuleTraceRecorder {
  const failed = (error: unknown): void => {
    console.error(
      "[review] 规则轨迹落库失败,任务照常:",
      error instanceof Error ? error.message : String(error),
    );
  };

  let taskId: number | null;
  try {
    taskId = withStore((store) => store.startRuleTrace(repoId, source, startedPayload));
  } catch (error) {
    failed(error);
    taskId = null;
  }
  if (taskId !== null) beginTrace(ruleChannel(taskId));

  return {
    taskId,
    record: (kind, payload) => {
      if (taskId === null) return;
      try {
        publishTrace(
          ruleChannel(taskId),
          withStore((store) => store.appendRuleTrace(taskId!, { kind, payload })),
        );
      } catch (error) {
        failed(error);
      }
    },
    end: () => {
      if (taskId !== null) endTrace(ruleChannel(taskId));
    },
  };
}
