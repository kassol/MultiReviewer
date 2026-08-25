/**
 * 审查轨迹(CONTEXT.md):一轮 Review Run 里按时间顺序发生的事件序列。
 *
 * 事件的形状由本项目定义,与 Pi 的会话结构无关(ADR 0017)。一条事件先落库、再广播给
 * 这一轮的进程内订阅者;面板打开时读表补历史,运行中经 SSE 收新增的行。
 *
 * 订阅者只在进程内:服务是单进程单实例(Docker),不引入外部消息通道。
 */
import type { Store } from "./store.ts";

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

type Subscriber = {
  onEvent: (event: TraceEvent) => void;
  onEnd: () => void;
};

/**
 * 正在跑的轮次与它们的订阅者。
 *
 * 「这一轮还会不会有新事件」只有这里知道:SSE 据此决定回放完就发 `end`,还是接着等。
 * 进程重启后这张表是空的,重启前那些跑到一半的轮次因此按已结束处理——它们确实不会再
 * 有新事件了。
 */
const live = new Map<number, Set<Subscriber>>();

/** 这一轮开跑,可以接受订阅。`runReview` 拿到 runId 之后立刻调。 */
export function beginTrace(runId: number): void {
  if (!live.has(runId)) live.set(runId, new Set());
}

/**
 * 订阅这一轮的新增事件。返回退订函数;这一轮不在跑时返回 undefined——调用方据此知道
 * 没有后续事件可等,该直接收尾。
 */
export function subscribeTrace(
  runId: number,
  subscriber: Subscriber,
): (() => void) | undefined {
  const subscribers = live.get(runId);
  if (subscribers === undefined) return undefined;
  subscribers.add(subscriber);
  return () => {
    live.get(runId)?.delete(subscriber);
  };
}

/** 把一条已落库的事件推给订阅者。 */
function publishTrace(event: TraceEvent): void {
  for (const subscriber of [...(live.get(event.runId) ?? [])]) subscriber.onEvent(event);
}

/**
 * 这一轮结束:通知订阅者不再有新事件,并把它从「在跑」里摘掉。成功、失败与中途抛
 * 异常都要走到这里,否则订阅者会一直等下去。
 */
export function endTrace(runId: number): void {
  const subscribers = live.get(runId);
  if (subscribers === undefined) return;
  live.delete(runId);
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
    publishTrace(event);
  };

  return {
    run: (kind, payload) => append({ scope: "run", kind, payload }),
    reviewer: (reviewer, kind, payload) =>
      append({ scope: "reviewer", reviewer, kind, payload }),
  };
}
