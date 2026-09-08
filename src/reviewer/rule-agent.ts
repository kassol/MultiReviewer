/**
 * 规则 agent 的注入边界(issue #205,ADR 0019)。
 *
 * 三条链路共用这一个接口:基点探索与处置反哺输入一份工作副本、它停在的那个 commit、
 * 本次要用的模型运行参数与该仓库现有的知识集,输出一批结构化的知识条目;知识整理
 * (issue #284)输入现集与待裁决队列,输出对队列的直改动作。测试注入脚本化实现(对齐
 * 脚本化 Reviewer 先例),真实实现走与 Reviewer 同一套 Pi 子进程基建。
 */
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "../config.ts";
import type {
  KnowledgeEntry,
  KnowledgeType,
  PendingProposal,
  ReviewerEvent,
  RuleProposalChange,
} from "../review/finding.ts";
import type { RuleProposalOrigin } from "../review/store.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { runWorkerChild } from "./subprocess.ts";

const WORKER_PATH = fileURLToPath(new URL("./rule-worker.ts", import.meta.url));

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
  /**
   * 这一条针对的现有知识条目标识(issue #207、#282)。知识集非空时 agent 提的是对照
   * 现有知识集的变更,认得出一个目标即修改或废止、认得出两个以上即合并、一个都认不出
   * 即新增;知识集为空时恒缺席。
   */
  targetRuleIds?: number[];
  /** 这一条要废止那条目标条目。没有目标、或目标不止一条的废止不成其为一条变更。 */
  retire?: boolean;
  /**
   * 这一条要并入的那条待裁决提案的标识(issue #283)。agent 认出这次备注说的是队列里
   * 已有的一件事时给它,`statement` 那时是合成两次说法之后的新陈述。指向的提案已裁决
   * 或不存在时这一条退回按新增处理;缺陈述的并入整条丢掉。
   */
  proposalId?: number;
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
 * 交给整理 agent 的一条待裁决提案(CONTEXT.md 知识整理,issue #284)。它要认得出队列里
 * 哪两条说的是同一件事,因此标识、变更类型、目标条目、陈述与出处附注都在。
 */
export type ConsolidationProposal = {
  id: number;
  type: KnowledgeType;
  change: RuleProposalChange;
  /** 修改与废止指向的现有条目,合并指向两条以上;新增没有目标,为空数组(issue #282)。 */
  targetRuleIds: readonly number[];
  scope: string;
  statement: string;
  /** 它的出处附注:每条说的是这一条被哪一次任务、凭什么提出来的。 */
  sources: readonly { origin: RuleProposalOrigin; note: string | null }[];
};

/**
 * 整理 agent 对待裁决队列的一次直改(CONTEXT.md 知识整理,issue #284)。两个动作:
 * 把几条重复的提案合成一条,或把一条与现集重复的新增型提案改写成指向那条条目的修改型。
 */
export type RuleConsolidationAction =
  | {
      kind: "merge";
      /** agent 挑的保留行。落地按 id 最小的那一行保留,这一项与被并的一并去重。 */
      keepId: number;
      mergedIds: number[];
      /** 合成后的那一句,覆盖保留行的陈述。 */
      statement: string;
    }
  | { kind: "retarget"; proposalId: number; targetRuleId: number };

/**
 * 规则 agent 跑的过程里逐条冒出来的事件(CONTEXT.md 知识轨迹,issue #214)。前两档是
 * Pi 的会话事件,与 Reviewer 那侧同一个转换的产物;`rule_proposed` 是它经 `propose_rule`
 * 提出的一条规则,与最终产出的那一条是同一个对象——事件流回答「什么时候提的」,产出
 * 回答「提了什么」。
 */
export type RuleAgentEvent = ReviewerEvent | { kind: "rule_proposed"; item: RuleAgentItem };

/** 交给规则 agent 的一次任务。 */
export type RuleAgentRequest = {
  /**
   * 会话的工作目录。基点探索与处置反哺给的是已经 checkout 好的工作副本;知识整理给的是
   * 一个空临时目录——它整理的是队列里的文本,不读代码(issue #284)。
   */
  worktreePath: string;
  /** 基点 commit(CONTEXT.md 基点探索)。知识整理没有基点,缺席。 */
  baselineSha?: string;
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
   * 知识整理的输入(CONTEXT.md 知识整理,issue #284)。有值即这一次整理的是这份待裁决
   * 队列,产出是对它的直改动作而不是知识条目。
   */
  consolidation?: { proposals: readonly ConsolidationProposal[] };
  /**
   * 这个仓库现有的知识集,两型都在、各带标识与自己的 type(issue #222)。首次基点探索时
   * 是空的;反哺与重探索要它才知道哪些标准与事实已经在集里(issue #207、#208)。
   */
  existingKnowledge: readonly KnowledgeEntry[];
  /**
   * 这个仓库此刻的待裁决队列(CONTEXT.md 修订提案,issue #283)。只有处置反哺给:认出
   * 新备注说的是队列里已有的一件事就并入那一条,而不是再排一条说同一件事的提案。基点
   * 探索缺席——它的产出整批取代上一次的,重复本来就不会在队列里堆起来。
   */
  pendingProposals?: readonly PendingProposal[];
  /**
   * 过程事件的回调(issue #214)。逐条给,调用方落成知识轨迹。不进 IPC 消息:它是一个
   * 函数,跨不了进程边界,子进程那边由 `RuleWorkerMessage` 回传。
   */
  onEvent?: (event: RuleAgentEvent) => void;
};

/** 一次探索的产出。`failure` 有值即这一次没跑成,条目按空处理。 */
export type RuleAgentResult = {
  items: RuleAgentItem[];
  /** 知识整理那一档对队列的直改动作,按 agent 报出的先后。别的链路缺席。 */
  actions?: RuleConsolidationAction[];
  failure?: string;
};

export type RuleAgent = (request: RuleAgentRequest) => Promise<RuleAgentResult>;

/** 子进程收到的任务。凭据走环境变量,不进 IPC 消息(与 Reviewer 同一条口径)。 */
export type RuleWorkerRequest = Omit<RuleAgentRequest, "apiKey" | "onEvent">;

/** 子进程回传的消息:每条规则、每个整理动作与每条过程事件各一发,收尾一发。 */
export type RuleWorkerMessage =
  | { kind: "rule"; item: RuleAgentItem }
  | { kind: "action"; action: RuleConsolidationAction }
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
  const actions: RuleConsolidationAction[] = [];

  const payload: RuleWorkerRequest = {
    worktreePath: request.worktreePath,
    runtimeModel: request.runtimeModel,
    existingKnowledge: request.existingKnowledge,
    ...(request.baselineSha === undefined ? {} : { baselineSha: request.baselineSha }),
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
    ...(request.consolidation === undefined ? {} : { consolidation: request.consolidation }),
    ...(request.pendingProposals === undefined
      ? {}
      : { pendingProposals: request.pendingProposals }),
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
      // 整理动作不进事件流:它落没落地要到落地那一步才知道,轨迹里那一条由编排层写
      // (issue #284),一个动作只留一条事件。
      if (message.kind === "action") {
        actions.push(message.action);
        return;
      }
      if (message.kind !== "rule") return;
      items.push(message.item);
      // 条目与事件一起给:轨迹要按发生顺序记下这一条是在哪两次工具调用之间提出来的。
      request.onEvent?.({ kind: "rule_proposed", item: message.item });
    },
  });

  return { items, actions, ...(failure === undefined ? {} : { failure }) };
}
