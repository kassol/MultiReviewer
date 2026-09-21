import type { ThinkingLevel } from "../config.ts";
import type {
  RawVerdict,
  ReviewerEvent,
  ReviewerInput,
  ReviewerUsage,
  SessionKnowledgeEntries,
  SessionKnowledgeQuery,
} from "../review/finding.ts";
import type { RawFinding } from "./normalize.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";

/**
 * 主进程交给 Reviewer 子进程的任务:注入边界那份输入,去掉两处跨不了进程的回调
 * (`onEvent` 的事件与 `queryKnowledge` 的查询都走消息来回),加上本轮固定的完整运行模型。
 *
 * 空知识集不带 `rules` 这一项,prompt 因此与没有知识集时逐字一致。
 */
export type ReviewerRequest = Omit<ReviewerInput, "onEvent" | "queryKnowledge"> & {
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
  /**
   * 一次产品知识查询(issue #362)。库在主进程,子进程没有库连接(ADR 0017 同律),因此
   * 与会话那条同形:主进程带同一个 `requestId` 回一条 `knowledge-query-result`,恒回一条。
   */
  | { kind: "knowledge-query"; requestId: string; query: SessionKnowledgeQuery }
  /**
   * 会话还活着,别的什么都不说明(`streamHeartbeat`)。父进程只用它重置静默闸,不读内容。
   */
  | { kind: "heartbeat" }
  | {
      kind: "done";
      /** 被 Pi 校验拒绝的工具调用次数。不为零而 Finding 为零即契约失配。 */
      rejectedToolCalls: number;
      /** snippet 锚不上而被打回的 report_finding 次数,与上一项各记各的。 */
      anchorRejections: number;
      /** 会话内可见的失败原因,来自 errorMessage 或最后一条消息的 stopReason。 */
      failure?: string;
      /**
       * 末条 assistant 消息的停止原因(issue #408)。会话无声收工时它是唯一的线索:
       * 读完一次工具结果就结束的那种回合不报错、不留文本。
       * 会话没建起来、或一条 assistant 消息都没有时取不到。
       */
      stopReason?: string;
      /**
       * 这次会话的回合数,即 assistant 消息条数(issue #408)。取自会话自己的消息列表,
       * 不依赖事件流。
       */
      turns?: number;
      /** Pi 会话统计出的用量。会话没建起来时取不到。 */
      usage?: ReviewerUsage;
    };

/**
 * 主进程在任务之后还会投给 Reviewer 子进程的消息(issue #362)。只有一档:一次知识查询的
 * 回应。子进程按 `kind` 认出它——任务本身没有这一格,两者因此分得开。
 */
export type ReviewerCommand = {
  kind: "knowledge-query-result";
  requestId: string;
  entries: SessionKnowledgeEntries;
  /** 查不动时的原因。带它时两个数组都是空的。 */
  failure?: string;
};
