/**
 * 审查轨迹(CONTEXT.md):一轮 Review Run 里按时间顺序发生的事件序列。知识轨迹
 * (CONTEXT.md,issue #214)同源:一次基点探索或一次处置反哺是一条,事件形状与广播共用
 * 这一份,只是落在另一张表上。
 *
 * 事件的形状由本项目定义,与 Pi 的会话结构无关(ADR 0017)。一条事件先落库、再广播给
 * 这条轨迹的进程内订阅者;面板打开时读表补历史,运行中经 SSE 收新增的行。
 *
 * 订阅者只在进程内:服务是单进程单实例(Docker),不引入外部消息通道。
 */
import { EventEmitter } from "node:events";

import type { RuleTraceSource, Store } from "./store.ts";

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
  /** 合并 agent 跑完(issue #228):它给出几组,以及这次会话的 token 用量。 */
  | "merge_agent_finished"
  /** 合并 agent 失败或分组方案没过验收,这一轮的合并退回算法档(issue #228)。 */
  | "merge_fallback"
  /**
   * 某一组的综合说明缺失或标题 / 问题说明空白,那一组的正文退回代表段(issue #279):
   * payload 的 `group` 是组下标(agent 提出这一组的次序),`reason` 是那一句原因。分组
   * 本身照收,整轮退回算法合并走的仍是 `merge_fallback`。
   */
  | "synthesis_fallback"
  /**
   * 一个同根因组没过验收、被丢弃(ADR 0030,issue #308):payload 的 `groups` 是它引用的
   * 那几个合并组(agent 报出它们的次序),`reason` 是丢弃它的那一条原因。分组方案本身
   * 照常生效——一组坏提议不作废整份分组,因此不走 `merge_fallback`。
   */
  | "root_cause_group_rejected"
  /** 落点锚不进本轮 diff、被丢弃的一条 Finding(issue #224)。 */
  | "finding_discarded"
  /**
   * 报在本批之外的文件上、被丢弃的一条 Finding(issue #306):payload 记文件、行、标题、
   * 报出它的模型与批次序号。与 `finding_discarded` 分成两档,是因为拦下它的是两条不同的
   * 规则——那一条锚不进本轮 diff,这一条锚得进但没有本批的 diff 作依据。分批才有这一档。
   */
  | "finding_out_of_batch"
  /**
   * 低于本轮最低报告等级、被合并前那道保底挡掉的 Finding(issue #271):payload 记
   * 丢弃条数与本轮阈值。一条都没挡掉时不发。
   */
  | "findings_filtered"
  /** 本轮一条 Finding 折叠到了历史评论上,带这一次折叠的判据(issue #240)。 */
  | "finding_folded"
  /**
   * 指纹命中了一条历史、合并 agent 却判它不是同一个问题,本轮这条因此没有折叠
   * (ADR 0030,issue #307)。`criteria` 是 `agent_differs` 那一档,带那条历史的落库 id
   * 与 agent 为这一组写的理由。
   */
  | "finding_not_folded"
  /**
   * 本轮一条 Finding 承接了一条历史 Finding Identity,带这一次延续的判据(issue #243)与
   * 交接结果 `handoff`(ADR 0025):`complete` 即旧评论已 resolve,`pending` 即交接未完成。
   */
  | "finding_continued"
  /**
   * 开跑时按「所在文件不在本轮可审文件集」自动处置掉的历史(issue #272)。payload 的
   * `reverted` 与 `deleted` 各是一批 finding id:文件回到 base 状态的一批,文件被删的一批。
   */
  | "history_auto_disposed"
  | "review_posted"
  /** 只复核那一轮零新报,这一轮不向 Forge 发 review(issue #242)。 */
  | "review_skipped"
  /** 服务正在排空,这一轮停在批次边界、没有收尾,由下一次启动续跑(issue #249)。 */
  | "run_aborted"
  /**
   * 这一轮没有正常收尾(ADR 0026,issue #256):payload 的 `reason` 与 `review_run.failure`
   * 是同一句原因。改判中断轮次走这一档;Reviewer 自己的失败仍是 `reviewer_failed`。
   */
  | "run_failed"
  | "run_finished";

export type TraceKind = ReviewerTraceKind | RunTraceKind;

/**
 * 知识轨迹的事件类型(CONTEXT.md 知识轨迹,issue #214)。前三档与 Reviewer 那侧同形,
 * 因为它们来自同一个转换(`reviewer/trace-events.ts`);其余几档由编排层在这次任务开始、
 * 提出条目、整理队列与收尾时补。`rule_consolidated` 是知识整理对队列的一次直改
 * (合并或改写,issue #284)。
 */
export type RuleTraceKind =
  | "rule_agent_started"
  | "assistant_message"
  | "tool_call"
  | "rule_proposed"
  | "rule_consolidated"
  /** 一条并入落不下去,那一条被丢掉(issue #283)。payload 说清是哪条提案、为什么。 */
  | "rule_proposal_dropped"
  | "rule_agent_failed"
  | "rule_agent_finished";

/**
 * 轨迹里的一条事件。`seq` 在一轮之内自增,断线续传按它续;`reviewer` 是模型标识,
 * 与 `reviewer_outcome.model` 是同一个值,轮次级事件没有它。合并 agent 的会话事件也走
 * 这一档,占一个固定名字(`MERGE_AGENT_TRACE_NAME`),与哪个模型跑的它无关(issue #228)。
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

/** 知识轨迹里的一条事件。`seq` 在一条轨迹之内自增,`taskId` 是这条轨迹的标识。 */
export type RuleTraceEvent = {
  seq: number;
  taskId: number;
  at: string;
  kind: RuleTraceKind;
  payload: unknown;
};

/** 待写入的一条知识轨迹事件。`seq` 与 `at` 由落库那一步给。 */
export type RuleTraceEventInput = { kind: RuleTraceKind; payload: unknown };

/**
 * 一条瞬时帧(issue #340):只广播给当前在线的订阅者,不落库,因此没有 `seq`——SSE 帧
 * 不带 `id`,断线续传只补落库的那些事件。流式生成的 delta 是它的用处:过程在眼前有用,
 * 过后没人回看,落库只是往表里灌行。
 */
export type TransientTraceEvent = { kind: string; payload: unknown };

type Subscriber = {
  onEvent: (event: TraceEvent | RuleTraceEvent | TransientTraceEvent) => void;
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
const live = new Map<string, EventEmitter>();

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
  // 订阅数没有上限:一条轨迹开着几十个面板就是几十个订阅者,默认那道 10 个的告警只是噪音。
  if (!live.has(channel)) live.set(channel, new EventEmitter().setMaxListeners(0));
}

/**
 * 订阅这条轨迹的新增事件。返回退订函数;它已经不在跑时返回 undefined——调用方据此知道
 * 没有后续事件可等,该直接收尾。
 */
export function subscribeTrace(
  channel: string,
  subscriber: Subscriber,
): (() => void) | undefined {
  const emitter = live.get(channel);
  if (emitter === undefined) return undefined;
  emitter.on("event", subscriber.onEvent);
  emitter.on("end", subscriber.onEnd);
  return () => {
    emitter.off("event", subscriber.onEvent);
    emitter.off("end", subscriber.onEnd);
  };
}

/** 把一条已落库的事件推给订阅者。 */
function publishTrace(channel: string, event: TraceEvent | RuleTraceEvent): void {
  live.get(channel)?.emit("event", event);
}

/**
 * 把一条瞬时帧推给当前在线的订阅者(issue #340)。不落库,这条轨迹没在跑时是空操作——
 * 没有在线订阅者的瞬时帧本来就没有去处。
 */
export function publishTransientTrace(channel: string, event: TransientTraceEvent): void {
  live.get(channel)?.emit("event", event);
}

/**
 * 这条轨迹结束:通知订阅者不再有新事件,并把它从「在跑」里摘掉。成功、失败与中途抛
 * 异常都要走到这里,否则订阅者会一直等下去。
 */
export function endTrace(channel: string): void {
  const emitter = live.get(channel);
  if (emitter === undefined) return;
  live.delete(channel);
  emitter.emit("end");
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

/** 一条知识轨迹的写入口(issue #214)。`taskId` 为 null 即这条轨迹没起来,写入是空操作。 */
export type RuleTraceRecorder = {
  taskId: number | null;
  record(kind: RuleTraceKind, payload: unknown): void;
  end(): void;
};

/**
 * 起一条知识轨迹并返回它的写入口。第一条 `rule_agent_started` 事件同时是这条轨迹的
 * 标识来源(见 `rule_trace` 表)。
 *
 * 落库失败(起头那一条也算)只记日志:轨迹记的是过程,规则条目与提案不读它,少一条
 * 过程记录不该让一次探索或一次反哺白跑。
 */
export function startRuleTrace(
  /** 开一次库做一件事。规则 agent 的两条链路都跑在后台,没有一份长活的 `Store`。 */
  withStore: <T>(use: (store: Store) => T) => T,
  repoId: number,
  source: RuleTraceSource,
  startedPayload: unknown,
): RuleTraceRecorder {
  const failed = (error: unknown): void => {
    console.error(
      "[review] 知识轨迹落库失败,任务照常:",
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
