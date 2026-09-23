/**
 * 待上屏的那条用户消息(乐观显示)。人在会话空闲时点发送,这条消息要等服务端备好工作树、
 * 起子进程、Pi 把它记成条目落库再经 SSE 推回来才出现在对话流里;这之间面板先画一个待定
 * 气泡顶着,真实记录一到就由它接替。
 *
 * 执行中发的消息不走这里:它们进排队块,已经看得见。
 */
import { conversation, type AgentSessionRecord } from "./agent-session-records.ts";

export type PendingMessage = {
  /** 这条消息的正文,与服务端落库前同一道 trim。 */
  text: string;
  images: string[];
  /** 发送那一刻对话流里最大的 seq:只有它之后到的记录才可能是这一条。 */
  afterSeq: number;
  /** POST 已经回了 202 并重读过会话状态。在那之前 `running` 还是发送前的旧值,不作数。 */
  accepted: boolean;
};

/** 待定气泡此刻怎么画:不画、画且在准备(一条记录都还没回来)、画但已有记录回来。 */
export type PendingView = "hidden" | "preparing" | "waiting";

/**
 * 配对按正文:`afterSeq` 之后第一条正文相同的用户消息就是它。不按「之后第一条用户消息」:
 * 会话被回收时留存的排队消息排在这一条**前面**投递(issue #335、#406),先到的那条用户
 * 消息可能是它们。
 *
 * 一轮已经跑完(会话空闲)而这条仍没落库,说明它没投出去——子进程起不来那一路只留一条
 * 系统消息说原因,气泡不再挂着。
 */
export function pendingView(
  pending: PendingMessage | null,
  records: readonly AgentSessionRecord[],
  running: boolean,
): PendingView {
  if (pending === null) return "hidden";
  const after = records.filter((record) => record.seq > pending.afterSeq);
  if (after.length === 0) return "preparing";
  const landed = conversation(after).some(
    (item) => item.kind === "user" && item.text === pending.text,
  );
  if (landed || (pending.accepted && !running)) return "hidden";
  return "waiting";
}

/** 对话流此刻最大的 seq。发送那一刻取它作 `afterSeq`。 */
export function lastSeq(records: readonly AgentSessionRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.seq), 0);
}
