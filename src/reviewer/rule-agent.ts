/**
 * 规则 agent 的注入边界(issue #205,ADR 0019)。
 *
 * 基点探索与日后的处置反哺共用这一个接口:输入一份工作副本、它停在的那个基点 commit、
 * 本次要用的模型运行参数与该仓库现有的知识集,输出一批结构化的评审规则条目。测试注入
 * 脚本化实现(对齐脚本化 Reviewer 先例),真实实现走与 Reviewer 同一套 Pi 子进程基建。
 */
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "../config.ts";
import type { KnowledgeEntry, KnowledgeType, ReviewerEvent } from "../review/finding.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { runWorkerChild } from "./subprocess.ts";

const WORKER_PATH = fileURLToPath(new URL("./rule-worker.ts", import.meta.url));

/**
 * 一次探索最多留下几条(ADR 0019)。上限的本质是人一次确认得完、不麻木;宁缺勿滥,缺
 * 的靠反哺补。模型多报的由服务端截断,不指望它自己数得准。
 */
export const RULE_LIMIT = 30;

/**
 * agent 推导出的一条知识条目,形状与人手填的那几样相同(CONTEXT.md 知识条目)。
 * 探索与反哺两条链路共用它,`type` 两值由 agent 自己判(issue #222)。
 */
export type RuleAgentItem = {
  /** 这一条是评审规则还是项目事实(ADR 0020)。 */
  type: KnowledgeType;
  /** 作用范围,glob;空串即全仓库。 */
  scope: string;
  /** 那一句陈述:规则型是规范陈述,事实型是可核查的现状陈述。 */
  statement: string;
  /** 自由文本层标签。属规则型,事实型是空串。 */
  layer: string;
  /**
   * 这一条针对的现有知识条目标识(issue #207)。知识集非空时 agent 提的是对照现有知识
   * 集的变更,认得出目标即修改或废止,认不出即新增;知识集为空时恒缺席。
   */
  targetRuleId?: number;
  /** 这一条要废止 `targetRuleId` 那条条目。没有目标的废止不成其为一条变更。 */
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

/**
 * 规则 agent 跑的过程里逐条冒出来的事件(CONTEXT.md 知识轨迹,issue #214)。前两档是
 * Pi 的会话事件,与 Reviewer 那侧同一个转换的产物;`rule_proposed` 是它经 `propose_rule`
 * 提出的一条规则,与最终产出的那一条是同一个对象——事件流回答「什么时候提的」,产出
 * 回答「提了什么」。
 */
export type RuleAgentEvent = ReviewerEvent | { kind: "rule_proposed"; item: RuleAgentItem };

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
   * 这个仓库现有的知识集,两型都在、各带标识与自己的 type(issue #222)。首次基点探索时
   * 是空的;反哺与重探索要它才知道哪些标准与事实已经在集里(issue #207、#208)。
   */
  existingKnowledge: readonly KnowledgeEntry[];
  /**
   * 过程事件的回调(issue #214)。逐条给,调用方落成知识轨迹。不进 IPC 消息:它是一个
   * 函数,跨不了进程边界,子进程那边由 `RuleWorkerMessage` 回传。
   */
  onEvent?: (event: RuleAgentEvent) => void;
};

/** 一次探索的产出。`failure` 有值即这一次没跑成,条目按空处理。 */
export type RuleAgentResult = {
  items: RuleAgentItem[];
  failure?: string;
};

export type RuleAgent = (request: RuleAgentRequest) => Promise<RuleAgentResult>;

/** 子进程收到的任务。凭据走环境变量,不进 IPC 消息(与 Reviewer 同一条口径)。 */
export type RuleWorkerRequest = Omit<RuleAgentRequest, "apiKey" | "onEvent">;

/** 子进程回传的消息:每条规则一发,过程事件一条一发,收尾一发。 */
export type RuleWorkerMessage =
  | { kind: "rule"; item: RuleAgentItem }
  | { kind: "event"; event: ReviewerEvent }
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
    existingKnowledge: request.existingKnowledge,
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
      if (message.kind === "event") {
        request.onEvent?.(message.event);
        return;
      }
      if (message.kind !== "rule") return;
      items.push(message.item);
      // 条目与事件一起给:轨迹要按发生顺序记下这一条是在哪两次工具调用之间提出来的。
      request.onEvent?.({ kind: "rule_proposed", item: message.item });
    },
  });

  return { items, ...(failure === undefined ? {} : { failure }) };
}
