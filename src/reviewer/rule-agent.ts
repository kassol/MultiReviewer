/**
 * 规则 agent 的注入边界(issue #205,ADR 0019)。
 *
 * 基点探索与日后的处置反哺共用这一个接口:输入一份工作副本、它停在的那个基点 commit、
 * 本次要用的模型运行参数与该仓库现有的规则集,输出一批结构化的评审规则条目。测试注入
 * 脚本化实现(对齐脚本化 Reviewer 先例),真实实现走与 Reviewer 同一套 Pi 子进程基建。
 */
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "../config.ts";
import type { ReviewRule } from "../review/finding.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { runWorkerChild } from "./subprocess.ts";

const WORKER_PATH = fileURLToPath(new URL("./rule-worker.ts", import.meta.url));

/**
 * 一次探索最多留下几条(ADR 0019)。上限的本质是人一次确认得完、不麻木;宁缺勿滥,缺
 * 的靠反哺补。模型多报的由服务端截断,不指望它自己数得准。
 */
export const RULE_LIMIT = 30;

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

/**
 * 触发一次处置反哺的那条处置(CONTEXT.md 处置反哺,issue #208)。备注是解读的输入本身,
 * Finding 的上下文形态从简——位置、标题与描述都从库里取,不另去 Forge 上取原文。
 */
export type DispositionFeedback = {
  /** 处置备注原文。 */
  note: string;
  /** 被处置的那条 Finding。 */
  finding: {
    file: string;
    line: number;
    /** 合并后的标题,升级前落库的历史行没有。 */
    title: string | null;
    description: string;
  };
};

/** 交给规则 agent 的一次任务。 */
export type RuleAgentRequest = {
  /** 已经 checkout 到基点 commit 的工作副本。 */
  worktreePath: string;
  /** 基点 commit(CONTEXT.md 基点探索)。 */
  baselineSha: string;
  /**
   * 处置反哺的输入(issue #208)。缺席即这一次是基点探索;有值即解读这条处置备注,
   * `baselineSha` 那时是这条 Finding 报出时的那个 head commit,工作副本停在它上面。
   */
  feedback?: DispositionFeedback;
  /** 本次固定的完整运行模型;不含凭据。 */
  runtimeModel: RuntimeModel;
  /**
   * 这一处模型引用的思考档位(CONTEXT.md)。缺席即 `off`;基点探索由发起的人选,处置
   * 反哺沿用该仓库最近一次探索的那一档。
   */
  thinkingLevel?: ThinkingLevel;
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
 * 子进程回传条目的收集。进程本身的生命周期在 `subprocess.ts`,与 Reviewer 共用一份;
 * `workerPath` 是参数而非常量,使失败路径(未回报即退出、被信号终止)能用受控的
 * worker 脚本驱动测试。
 */
export async function runRuleAgentChild(
  workerPath: string,
  request: RuleAgentRequest,
): Promise<RuleAgentResult> {
  const items: RuleAgentItem[] = [];

  const payload: RuleWorkerRequest = {
    worktreePath: request.worktreePath,
    baselineSha: request.baselineSha,
    runtimeModel: request.runtimeModel,
    existingRules: request.existingRules,
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
  };

  const { failure } = await runWorkerChild<RuleWorkerMessage>({
    workerPath,
    worktreePath: request.worktreePath,
    apiKey: request.apiKey,
    timeoutSubject: "规则 agent",
    payload,
    onMessage: (message) => {
      if (message.kind === "rule") items.push(message.item);
    },
  });

  return { items, ...(failure === undefined ? {} : { failure }) };
}
