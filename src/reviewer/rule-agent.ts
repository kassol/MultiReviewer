/**
 * 规则 agent 的注入边界(issue #205,ADR 0019)。
 *
 * 基点探索与日后的处置反哺共用这一个接口:输入一份工作副本、它停在的那个基点 commit、
 * 本次要用的模型运行参数与该仓库现有的规则集,输出一批结构化的评审规则条目。测试注入
 * 脚本化实现(对齐脚本化 Reviewer 先例),真实实现走与 Reviewer 同一套 Pi 子进程基建。
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "./env.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";

const WORKER_PATH = fileURLToPath(new URL("./rule-worker.ts", import.meta.url));

/**
 * 一次探索最多留下几条(ADR 0019)。上限的本质是人一次确认得完、不麻木;宁缺勿滥,缺
 * 的靠反哺补。模型多报的由服务端截断,不指望它自己数得准。
 */
export const RULE_LIMIT = 30;

/** 一个卡住的 agent 不是失败,是永远不返回。取值与 Reviewer 那道闸同一量级。 */
const TIMEOUT_MS = 20 * 60 * 1000;

/** 回报结果之后留给子进程收尾的时间。超过就当它退不掉,强杀并按已收到的结果结束。 */
const EXIT_GRACE_MS = 5000;

/** agent 推导出的一条评审规则,形状与人手填的那三样相同(CONTEXT.md 评审规则)。 */
export type RuleAgentItem = {
  /** 作用范围,glob;空串即全仓库。 */
  scope: string;
  /** 那一句规范陈述。 */
  statement: string;
  /** 自由文本层标签。 */
  layer: string;
  /**
   * 这一条针对的现有规则标识(issue #207)。规则集非空时 agent 提的是对照现有规则的
   * 变更,认得出目标即修改或废止,认不出即新增;规则集为空时恒缺席。
   */
  targetRuleId?: number;
  /** 这一条要废止 `targetRuleId` 那条规则。没有目标的废止不成其为一条变更。 */
  retire?: boolean;
};

/** 交给规则 agent 的一次任务。 */
export type RuleAgentRequest = {
  /** 已经 checkout 到基点 commit 的工作副本。 */
  worktreePath: string;
  /** 基点 commit(CONTEXT.md 基点探索)。 */
  baselineSha: string;
  /** 本次固定的完整运行模型;不含凭据。 */
  runtimeModel: RuntimeModel;
  /** 该模型绑定厂商的模型凭据。子进程的环境里只会有这一份。 */
  apiKey: string;
  /**
   * 这个仓库现有的规则集。首次基点探索时是空的;反哺与重探索要它才知道哪些标准已经
   * 在集里(issue #207、#208)。
   */
  existingRules: readonly ReviewRule[];
};

/** 一次探索的产出。`failure` 有值即这一次没跑成,条目按空处理。 */
export type RuleAgentResult = {
  items: RuleAgentItem[];
  failure?: string;
};

export type RuleAgent = (request: RuleAgentRequest) => Promise<RuleAgentResult>;

/** 子进程收到的任务。凭据走环境变量,不进 IPC 消息(与 Reviewer 同一条口径)。 */
export type RuleWorkerRequest = Omit<RuleAgentRequest, "apiKey">;

/** 子进程回传的消息:每条规则一发,收尾一发。 */
export type RuleWorkerMessage =
  | { kind: "rule"; item: RuleAgentItem }
  | { kind: "done"; failure?: string };

/** 基于 Pi SDK 的规则 agent。每次探索 fork 一个子进程,环境只含自家厂商凭据。 */
export function createPiRuleAgent(): RuleAgent {
  return (request) => runRuleAgentChild(WORKER_PATH, request);
}

/**
 * 子进程的生命周期管理与结果收集。`workerPath` 是参数而非常量,使失败路径(未回报即
 * 退出、被信号终止)能用受控的 worker 脚本驱动测试。
 */
export function runRuleAgentChild(
  workerPath: string,
  request: RuleAgentRequest,
): Promise<RuleAgentResult> {
  return new Promise((resolve) => {
    const items: RuleAgentItem[] = [];
    let done: { failure?: string } | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = fork(workerPath, {
        cwd: request.worktreePath,
        env: reviewerEnv(process.env, { [MODEL_API_KEY_ENV]: request.apiKey }),
        // 不继承父进程的 execArgv:在 `node --test` 下跑时 worker 会被当成测试文件启动。
        execArgv: [],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      resolve({
        items: [],
        failure: `子进程无法启动: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const finish = (failure: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      child.removeAllListeners();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({ items, ...(failure === undefined ? {} : { failure }) });
    };

    const timer = setTimeout(
      () => finish(`基点探索超时,超过 ${TIMEOUT_MS / 60_000} 分钟未结束`),
      TIMEOUT_MS,
    );

    child.on("message", (message: RuleWorkerMessage) => {
      if (message.kind === "rule") {
        items.push(message.item);
        return;
      }
      done = message;
      clearTimeout(timer);
      graceTimer = setTimeout(() => finish(message.failure), EXIT_GRACE_MS);
    });

    child.on("error", (error) => finish(`子进程无法启动: ${error.message}`));

    child.on("exit", (code, signal) => {
      // 退出码优先于会话状态:异常终止时 `done` 根本没发出来。
      if (done === undefined) {
        finish(
          signal === null
            ? `子进程未回报结果即退出,退出码 ${code}`
            : `子进程被信号 ${signal} 终止`,
        );
        return;
      }
      if (code !== 0) {
        finish(done.failure ?? `子进程退出码 ${code}`);
        return;
      }
      finish(done.failure);
    });

    const payload: RuleWorkerRequest = {
      worktreePath: request.worktreePath,
      baselineSha: request.baselineSha,
      runtimeModel: request.runtimeModel,
      existingRules: request.existingRules,
    };
    child.send(payload, (error) => {
      if (error !== null) finish(`无法向子进程投递任务: ${error.message}`);
    });
  });
}
