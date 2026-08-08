import type { ReviewRange, ReviewerUsage } from "../review/finding.ts";
import type { RawFinding } from "./normalize.ts";

/** 主进程交给 Reviewer 子进程的任务。 */
export type ReviewerRequest = {
  provider: string;
  model: string;
  range: ReviewRange;
  worktreePath: string;
};

/**
 * 子进程回传的消息。
 *
 * `done` 承载 Pi 会话内可见的三处失败信号。子进程异常终止时这条消息根本发不出来,
 * 此时退出码是主进程唯一的信号——这正是它必须优先于会话状态的原因。
 */
export type WorkerMessage =
  | { kind: "finding"; raw: RawFinding }
  | {
      kind: "done";
      /** 被 Pi 校验拒绝的工具调用次数。不为零而 Finding 为零即契约失配。 */
      rejectedToolCalls: number;
      /** snippet 锚不上而被打回的 report_finding 次数,与上一项各记各的。 */
      anchorRejections: number;
      /** 会话内可见的失败原因,来自 errorMessage 或最后一条消息的 stopReason。 */
      failure?: string;
      /** Pi 会话统计出的用量与成本。会话没建起来时取不到。 */
      usage?: ReviewerUsage;
    };
