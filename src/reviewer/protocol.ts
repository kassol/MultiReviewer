import type { ThinkingLevel } from "../config.ts";
import type { RawVerdict, ReviewerEvent, ReviewerInput, ReviewerUsage } from "../review/finding.ts";
import type { RawFinding } from "./normalize.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";

/**
 * 主进程交给 Reviewer 子进程的任务:注入边界那份输入,去掉跨不了进程的 `onEvent`
 * (事件走 `WorkerMessage` 回传),加上本轮固定的完整运行模型。
 *
 * 空规则集不带 `rules` 这一项,prompt 因此与没有规则集时逐字一致。
 */
export type ReviewerRequest = Omit<ReviewerInput, "onEvent"> & {
  /** 本轮固定的完整运行模型；不含凭据。 */
  runtimeModel: RuntimeModel;
  /** 本轮这一处模型引用的思考档位(CONTEXT.md)。缺席即 `off`。 */
  thinkingLevel?: ThinkingLevel;
};

/**
 * 子进程回传的消息。
 *
 * `done` 承载 Pi 会话内可见的三处失败信号。子进程异常终止时这条消息根本发不出来,
 * 此时退出码是主进程唯一的信号——这正是它必须优先于会话状态的原因。
 */
export type WorkerMessage =
  | { kind: "finding"; raw: RawFinding }
  | { kind: "verdict"; raw: RawVerdict }
  /** 一条过程事件,与 Finding 回传并列(issue #171)。子进程只转发,不做判断。 */
  | { kind: "event"; event: ReviewerEvent }
  | {
      kind: "done";
      /** 被 Pi 校验拒绝的工具调用次数。不为零而 Finding 为零即契约失配。 */
      rejectedToolCalls: number;
      /** snippet 锚不上而被打回的 report_finding 次数,与上一项各记各的。 */
      anchorRejections: number;
      /** 会话内可见的失败原因,来自 errorMessage 或最后一条消息的 stopReason。 */
      failure?: string;
      /** Pi 会话统计出的用量。会话没建起来时取不到。 */
      usage?: ReviewerUsage;
    };
