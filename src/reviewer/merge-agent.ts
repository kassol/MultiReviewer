/**
 * 合并 agent 的真实实现(issue #228,ADR 0022)。
 *
 * 注入边界本身(`MergeAgent`)定在 `review/dedupe.ts`,与 Reviewer 那侧同律:编排层的
 * 领域类型不反过来依赖这个目录。这里只做「怎么跑」——与 Reviewer、规则 agent 同一套
 * Pi 子进程基建。它只回答语义那一半:哪些 Finding 讲的是同一个问题;分组方案的验收与
 * 派生规则留在 `dedupe.ts`,验收不过即整体回退到算法合并。
 */
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "../config.ts";
import type {
  MergeAgent,
  MergeAgentRequest,
  MergeAgentResult,
  MergeGroupProposal,
} from "../review/dedupe.ts";
import type {
  Finding,
  HistoryFinding,
  ReviewerEvent,
  ReviewerUsage,
} from "../review/finding.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { runWorkerChild } from "./subprocess.ts";

const WORKER_PATH = fileURLToPath(new URL("./merge-worker.ts", import.meta.url));

export type PiMergeAgentConfig = {
  /** 本轮固定的完整运行模型:取配置序第一个 Reviewer 的那一份,不新增配置面。 */
  runtimeModel: RuntimeModel;
  /** 同一个 Reviewer 的模型凭据。子进程的环境里只会有这一份。 */
  apiKey: string;
  /** 同一处模型引用的思考档位(CONTEXT.md)。缺席即 `off`。 */
  thinkingLevel?: ThinkingLevel;
};

/** 子进程收到的任务。凭据走环境变量,不进 IPC 消息(与另两条链路同一条口径)。 */
export type MergeWorkerRequest = {
  findings: readonly Finding[];
  /** 同文件的历史 Finding(issue #240)。一条都没有时是空数组,prompt 因此不渲染那一段。 */
  history: readonly HistoryFinding[];
  worktreePath: string;
  runtimeModel: RuntimeModel;
  thinkingLevel?: ThinkingLevel;
};

/** 子进程回传的消息:每组一发,过程事件一条一发,收尾一发。 */
export type MergeWorkerMessage =
  | { kind: "group"; group: MergeGroupProposal }
  | { kind: "event"; event: ReviewerEvent }
  | { kind: "done"; failure?: string; usage?: ReviewerUsage };

/** 基于 Pi SDK 的合并 agent。每轮 fork 一个子进程,环境只含那一家厂商的凭据。 */
export function createPiMergeAgent(config: PiMergeAgentConfig): MergeAgent {
  return (request) => runMergeAgentChild(WORKER_PATH, config, request);
}

/**
 * 子进程回传分组的收集。进程本身的生命周期在 `subprocess.ts`,与另两条链路共用一份;
 * `workerPath` 是参数而非常量,使失败路径能用受控的 worker 脚本驱动测试。
 */
export async function runMergeAgentChild(
  workerPath: string,
  config: PiMergeAgentConfig,
  request: MergeAgentRequest,
): Promise<MergeAgentResult> {
  const groups: MergeGroupProposal[] = [];
  let usage: ReviewerUsage | undefined;

  const payload: MergeWorkerRequest = {
    findings: request.findings,
    history: request.history ?? [],
    worktreePath: request.worktreePath,
    runtimeModel: config.runtimeModel,
    ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
  };

  const { failure } = await runWorkerChild<MergeWorkerMessage>({
    workerPath,
    worktreePath: request.worktreePath,
    apiKey: config.apiKey,
    timeoutSubject: "合并 agent",
    payload,
    onMessage: (message) => {
      if (message.kind === "event") {
        request.onEvent?.(message.event);
        return;
      }
      if (message.kind === "group") {
        groups.push(message.group);
        return;
      }
      usage = message.usage;
    },
  });

  return {
    groups,
    ...(failure === undefined ? {} : { failure }),
    ...(usage === undefined ? {} : { usage }),
  };
}
