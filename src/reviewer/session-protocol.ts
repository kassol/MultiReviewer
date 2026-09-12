/**
 * Agent 会话的常驻子进程与主进程之间的 IPC 形状(issue #333)。
 *
 * 与 Reviewer 那份协议(`protocol.ts`)分开:那是「投一个任务、收一批产出、进程退出」,
 * 这是「开一次会话、之后一问一答到进程被回收」。消息因此分两向各几档,子进程起来之后
 * 一直活着。
 */
import type { ThinkingLevel } from "../config.ts";
import type { ProjectFact, ReviewRule } from "../review/finding.ts";
import type { AgentSessionOutputKind } from "../review/store.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";

/**
 * 主进程与子进程各自往会话记录里放的那两种 Pi 条目的 `customType`(issue #337)。放在这份
 * 共享协议里:两侧写的是同一张记录表,面板按这两个取值认出它们(`custom` 的产出卡片与
 * `custom_message` 的定稿 / 换版那一行)。
 */
export const AGENT_SESSION_OUTPUT_CUSTOM_TYPE = "multireviewer-session-output";
export const AGENT_SESSION_NOTE_CUSTOM_TYPE = "multireviewer-session-note";

/** 会话根下的一个仓库:它的工作树目录名就是 `<owner>/<repo>`,知识集按它分段注入。 */
export type SessionRepoInput = {
  owner: string;
  repo: string;
  /** 这个仓库生效知识集里的评审规则。空数组即不渲染这一段。 */
  rules: readonly ReviewRule[];
  /** 这个仓库生效知识集里的项目事实。空数组即不渲染这一段。 */
  facts: readonly ProjectFact[];
};

/** 开一个会话要给的那几样。凭据不进 IPC,走环境变量(`env.ts`)。 */
export type OpenSessionRequest = {
  /** 会话根目录。cwd 是它,只读工具圈在它里面,工作树挂在它下面。 */
  sessionRoot: string;
  /** 会话用途(CONTEXT.md 会话用途)。进系统提示一行。 */
  purpose: string;
  repos: readonly SessionRepoInput[];
  runtimeModel: RuntimeModel;
  /** 这一处模型引用的思考档位。缺席即 `off`。 */
  thinkingLevel?: ThinkingLevel;
};

/**
 * 一份交上来的会话产出(CONTEXT.md 会话产出,issue #337)。`payload` 的形状由产出类型自己
 * 定(需求拆分那一份在 `session-output-tools.ts`),这条协议只把它原样带过去。
 */
export type SessionOutput = {
  kind: AgentSessionOutputKind;
  /** 产生它的那次工具调用。 */
  toolCallId: string;
  payload: unknown;
};

/** 主进程投给子进程的指令。 */
export type SessionCommand =
  | { kind: "open"; request: OpenSessionRequest }
  /** 跑一次 prompt。会话空闲时立刻开跑。 */
  | { kind: "prompt"; text: string }
  /**
   * 往会话里放一条进模型上下文的自定义消息,不开新回合(issue #337)。定稿与换版走它:
   * 那是人做的动作,agent 下一轮要知道哪一版定了。落库由镜像那条路完成,与别的条目同形。
   */
  | { kind: "custom-message"; text: string };

/** 子进程回传的消息。 */
export type SessionWorkerMessage =
  /** 会话已建好,可以收 prompt 了。 */
  | { kind: "ready" }
  /**
   * 新增的 Pi 会话条目,原样转发(ADR 0031)。一批一条消息,顺序即它们在会话记录里的顺序;
   * 子进程不判断它们是什么,落库与用量累加都在主进程。
   */
  | { kind: "entries"; entries: readonly unknown[] }
  /**
   * agent 经产出工具交出的一份会话产出(issue #337)。一次调用一条消息,与 Finding 回传
   * 同形:子进程只把归一化与打回判完的那一份交上来,落产出表与广播都在主进程。
   */
  | { kind: "output"; output: SessionOutput }
  /** 这一个回合结束,会话回到空闲。`failure` 是这一回合里可见的失败原因。 */
  | { kind: "turn-end"; failure?: string }
  /** 会话建不起来:这个子进程之后什么都做不了。 */
  | { kind: "failed"; failure: string }
  /** 会话还活着,别的什么都不说明(`streamHeartbeat`)。 */
  | { kind: "heartbeat" };
