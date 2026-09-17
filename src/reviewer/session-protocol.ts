/**
 * Agent 会话的常驻子进程与主进程之间的 IPC 形状(issue #333)。
 *
 * 与 Reviewer 那份协议(`protocol.ts`)分开:那是「投一个任务、收一批产出、进程退出」,
 * 这是「开一次会话、之后一问一答到进程被回收」。消息因此分两向各几档,子进程起来之后
 * 一直活着。
 */
import type { ThinkingLevel } from "../config.ts";
import type {
  SessionKnowledgeEntries,
  SessionKnowledgeQuery,
  SessionProductKnowledge,
} from "../review/finding.ts";
import type { RepoFinding, RepoFindingQuery } from "../review/store.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import type { AgentSessionImageRef } from "./session-images.ts";
import type { SessionSubagentRun } from "./session-subagent.ts";

/**
 * 基点更新(CONTEXT.md 基点更新,issue #356)的 `custom_message` 类型。放在这份共享协议里:
 * 两侧写的是同一张记录表,面板按这个取值把它渲染成「仓库 旧 sha → 新 sha」那一行,而不是
 * 一句提示。只有主进程写它。
 */
export const AGENT_SESSION_BASELINE_UPDATE_CUSTOM_TYPE = "multireviewer-session-baseline-update";
/**
 * 提问轮次(CONTEXT.md 提问轮次,issue #359)的 `custom` 条目类型。只有子进程写它:这一轮
 * 要接在抛出它的那次工具调用后面。`data` 就是那一轮题(`session-question-tool.ts` 的
 * `QuestionRound`),面板按它渲染选择卡片。
 */
export const AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE = "multireviewer-session-question-round";

/**
 * 系统消息的 `custom` 条目类型(ADR 0031,issue #334、#335)。人点停止、执行中静默判死、
 * 被排空中止与辅助模型切换都落这一种,不进模型上下文。
 *
 * 两侧都写它:人点停止由子进程落(会话还活着),判死、排空中止与模型切换由主进程落
 * (那几下的子进程正要没了)。面板按这个取值把它渲染成对话流里灰底一行。
 */
export const SYSTEM_MESSAGE_ENTRY = "multireviewer_system_message";

/**
 * 一次会话子代理派单的 `custom` 条目类型(CONTEXT.md 会话子代理,issue #358)。只有子进程
 * 写它:子会话的过程只在它那一侧读得到,而 transcript 文件随临时目录消失,派单跑完当场
 * 落成条目,重建时面板从这一条重画那张嵌套卡片。不进模型上下文——过程模型自己刚经历过,
 * 它拿到的是工具返回里的报告。
 */
export const AGENT_SESSION_SUBAGENT_ENTRY = "multireviewer-session-subagent";

/** 会话根下的一个仓库:它的工作树目录名就是 `<owner>/<repo>`,知识集只报条数。 */
export type SessionRepoInput = {
  owner: string;
  repo: string;
  /**
   * 仓库职责(CONTEXT.md 仓库职责,issue #341)。进系统提示里这个仓库那一行的破折号后面:
   * agent 凭它决定先读哪个仓库。没写过即 null,那一行就只有仓库名。
   */
  role: string | null;
  /**
   * 这棵工作树检出的 commit(issue #351)。进系统提示里这个仓库那一行:人问起「你看的是哪份
   * 代码」时 agent 指得出来。
   */
  headSha: string;
  /**
   * 这个仓库生效知识集里的评审规则条数(issue #344)。**只给条数,不给条目**:知识改走
   * `query_knowledge` 按需取,提示里只留一份目录,子进程因此也不该拿到这些陈述。
   */
  ruleCount: number;
  /** 这个仓库生效知识集里的项目事实条数。同上,只进提示的目录那一行。 */
  factCount: number;
};

/**
 * 两层知识的查询与回应形状定在 `review/finding.ts`(issue #362):Agent 会话与 Reviewer
 * 两条链路读的是同一份库,形状因此只有一处。这里原样转出,本目录的 import 一行不动。
 */
export type {
  SessionKnowledgeEntries,
  SessionKnowledgeQuery,
  SessionProductKnowledge,
} from "../review/finding.ts";

/**
 * 写一条产品知识要给的那几格(issue #360)。校验在子进程那一侧判完(`session-knowledge-tool.ts`),
 * 这条协议只把判过的那一份带过去。
 */
export type SessionKnowledgeWrite = {
  kind: "term" | "relationship" | "decision";
  name: string;
  body: string;
  topic: string | null;
  avoided: readonly string[];
  options: string | null;
  consequences: string | null;
  annotations: readonly { location: string; reason: string }[];
  /** 改写这一条而不是新写一条。 */
  id?: number;
  /** 这条决策取代的那一条。 */
  supersedes?: number;
};

/** 开一个会话要给的那几样。凭据不进 IPC,走环境变量(`env.ts`)。 */
export type OpenSessionRequest = {
  /** 会话根目录。cwd 是它,只读工具圈在它里面,工作树挂在它下面。 */
  sessionRoot: string;
  /** 这个会话挂在哪个产品上(CONTEXT.md 产品,issue #341)。进系统提示一行。 */
  productName: string;
  /** 会话用途(CONTEXT.md 会话用途)。进系统提示一行。 */
  purpose: string;
  repos: readonly SessionRepoInput[];
  /**
   * 这个产品此刻的产品知识(issue #345、#360、#362)。系统提示按它渲染一份目录——定位、
   * 术语名、生效决策标题,正文由 `query_knowledge` 按名字取;产品梳理那一段另按它列出
   * 「已经写下的是哪些」,产出工具的退役目标也按它判。空数组即这个产品还没有产品知识。
   */
  productKnowledge: readonly SessionProductKnowledge[];
  runtimeModel: RuntimeModel;
  /** 这一处模型引用的思考档位。缺席即 `off`。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * 这个会话此前的全部记录条目,原样喂回 Pi 的内存会话管理器(ADR 0031,issue #335)。
   * 缺席即新会话。重建前的链完整性自检在主进程做:缺条目 Pi 只静默截断,不报错。
   */
  entries?: readonly unknown[];
};

/**
 * 产品梳理交上来的一批(CONTEXT.md 产品梳理,issue #345、#360)。与会话产出分成两档:产出是
 * 人要读的一份文档,这一批是要落进产品知识的仓库关系条目,写下即生效。
 *
 * 形状与校验都在子进程那一侧判完(`session-output-tools.ts`):陈述的仓库集合是
 * `<owner>/<repo>`,退役指向的是提示里列过的那条生效条目的 id。
 */
export type ProductSurveyProposals = {
  statements: readonly { statement: string; repos: readonly string[] }[];
  retirements: readonly { id: number; reason: string }[];
};

/** 一次 tracker 读写指向的是一条 spec 还是一张票(CONTEXT.md 产品 tracker,issue #361)。 */
export type TrackerTarget = { kind: "spec" | "ticket"; id: number };

/**
 * agent 对产品 tracker 的一次读写(CONTEXT.md 产品 tracker,issue #361)。库在主进程,因此
 * 与知识查询同律走请求-回应:子进程只把形状归一化过的这一份交上去,判定、落库与措辞都在
 * 主进程(`product-tracker.ts`),回来的是工具原样返回的那一段文字。
 */
export type TrackerRequest =
  | { kind: "create-spec"; title: string; body: string }
  | {
      kind: "create-ticket";
      specId: number;
      title: string;
      body: string;
      /** 五个 triage 标签之一,原样带过去:认不认得由主进程判,它要说出打回的理由。 */
      label: string;
    }
  | { kind: "list" }
  | { kind: "read"; target: TrackerTarget }
  | { kind: "update-body"; target: TrackerTarget; body: string }
  | { kind: "close"; target: TrackerTarget }
  | { kind: "comment"; ticketId: number; body: string }
  | { kind: "block"; ticketId: number; blockedById: number }
  | { kind: "unblock"; ticketId: number; blockedById: number };

/**
 * 发一条消息的模式(spec #329,issue #334):`followUp` 是排队——等这一轮跑完再按顺序投递;
 * `steer` 是插话——在下一个回合边界投递,不打断正在跑的工具批次。字面量就是 Pi 的
 * `streamingBehavior` 取值,两边不必再转一次。会话空闲时两种模式都等同直接开跑。
 */
export type AgentSessionMessageMode = "followUp" | "steer";

/** 主进程投给子进程的指令。 */
export type SessionCommand =
  | { kind: "open"; request: OpenSessionRequest }
  /**
   * 跑一次 prompt。会话空闲时立刻开跑,执行中按 `mode` 进 Pi 的队列。
   *
   * `images` 是这条消息带的那几张图(issue #336),**只带路径与 mimeType**:base64 不过 IPC,
   * 子进程自己读文件填。空数组即没带图。
   */
  | {
      kind: "prompt";
      text: string;
      mode: AgentSessionMessageMode;
      images?: readonly AgentSessionImageRef[];
      /**
       * 这条 prompt 的序号(评审复核):同一个登记项上从 1 起递增。子进程回 `queue` 时带上它
       * 收到过的最后一个,主进程据此认出晚到的队列现状。
       */
      seq: number;
    }
  /** 整队清空(Pi 的 `clearQueue()`)。Pi 不支持单条撤回,因此没有单条那一档。 */
  | { kind: "clear-queue" }
  /** 中止当前这一步。排队消息保留在主进程的镜像里,下次开跑时投递。 */
  | { kind: "stop" }
  /**
   * 一次历史 Finding 查询的回应(issue #338),`requestId` 与请求那一条配对。主进程恒回
   * 一条:查不动时带 `failure`,`findings` 那时是空的,工具因此不会永远等下去。
   */
  | {
      kind: "finding-query-result";
      requestId: string;
      findings: readonly RepoFinding[];
      failure?: string;
    }
  /**
   * 一次知识查询的回应(issue #344),与历史 Finding 那一对同形:`requestId` 配对,主进程
   * 恒回一条,查不动时带 `failure`(那时两个数组都是空的)。
   */
  | {
      kind: "knowledge-query-result";
      requestId: string;
      entries: SessionKnowledgeEntries;
      failure?: string;
    }
  /**
   * 一次产品知识写入或撤回的回应(issue #360),与上面两对同形:`requestId` 配对,主进程恒回
   * 一条。`entry` 是落库之后的那一条(撤回时不带),`failure` 是一句打回的理由。
   */
  | {
      kind: "knowledge-write-result";
      requestId: string;
      entry?: SessionProductKnowledge;
      failure?: string;
    }
  /**
   * 一次产品 tracker 读写的回应(issue #361)。与上几对同形:`requestId` 配对,主进程恒回
   * 一条,`text` 就是工具原样返回给模型的那一段——落库、判定与打回的理由都在主进程。
   */
  | { kind: "tracker-result"; requestId: string; text: string }
  /**
   * 服务在排空(issue #335):中止当前这一步,跑完收尾就退出。与 `stop` 的差别是它不等
   * 下一条消息——发版时进程要按时退出,「被排空中止」那条系统消息由主进程落库。
   */
  | { kind: "drain" };

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
   * 产品梳理经它的产出工具交的那一批(issue #345)。与产出回传同形:子进程只把校验过的
   * 那一批交上来,落产品知识表在主进程。
   */
  | { kind: "survey"; proposals: ProductSurveyProposals }
  /**
   * Pi 的队列现状(`queue_update`,issue #334)。主进程的排队镜像按它对齐:投递与清空都由
   * Pi 在回合边界做,哪几条还没投出去只有它说得准。
   */
  | {
      kind: "queue";
      steering: readonly string[];
      followUp: readonly string[];
      /**
       * 发出这份现状时子进程收到过的最后一条 prompt 的序号(评审复核):这份现状已含序号不大于
       * 它的全部指令。小于主进程已发出的最后一个即过期——它发出之后还有 prompt 在路上。
       */
      seq: number;
    }
  /** 这 100ms 里新生成的文字(`message_update` 的 `text_delta`)。不落库,只走瞬时帧。 */
  | { kind: "delta"; text: string }
  /** 一个工具开始跑(`tool_execution_start`)。同样只走瞬时帧。 */
  | { kind: "tool"; tool: string }
  /**
   * 正在跑的那几个会话子代理(issue #358)。同样只走瞬时帧:跑完那一版由子进程落成
   * `AGENT_SESSION_SUBAGENT_ENTRY` 条目,经镜像落库。
   */
  | { kind: "subagent"; runs: readonly SessionSubagentRun[] }
  /** 这一个回合结束,会话回到空闲。`failure` 是这一回合里可见的失败原因。 */
  | { kind: "turn-end"; failure?: string }
  /** 会话建不起来:这个子进程之后什么都做不了。 */
  | { kind: "failed"; failure: string }
  /**
   * 一次历史 Finding 查询(issue #338)。子进程没有库连接,查询因此走这一对消息:主进程
   * 查库,带同一个 `requestId` 回一条 `finding-query-result`,执行中的那次工具调用凭它
   * 兑现。知识查询(`knowledge-query`)同形,这两对是这条协议上的请求-回应。
   */
  | { kind: "finding-query"; requestId: string; query: RepoFindingQuery }
  /**
   * 一次知识查询(issue #344)。与历史 Finding 查询同一条理由走请求-回应:两层知识都在库里,
   * 子进程没有库连接。主进程带同一个 `requestId` 回一条 `knowledge-query-result`。
   */
  | { kind: "knowledge-query"; requestId: string; query: SessionKnowledgeQuery }
  /**
   * 写下或改写一条产品知识(issue #360)。与查询同一条理由走请求-回应:条目在库里,子进程
   * 没有库连接。主进程带同一个 `requestId` 回一条 `knowledge-write-result`。
   */
  | { kind: "knowledge-write"; requestId: string; write: SessionKnowledgeWrite }
  /** 撤回一条产品知识(issue #360)。回应与写入同一条消息。 */
  | { kind: "knowledge-withdraw"; requestId: string; entryId: number }
  /**
   * 一次产品 tracker 读写(issue #361)。同一条理由走请求-回应:spec 与票都在库里,而
   * 「这张票在不在同一个产品」只有主进程查得出来。主进程带同一个 `requestId` 回一条
   * `tracker-result`。
   */
  | { kind: "tracker-request"; requestId: string; request: TrackerRequest }
  /** 会话还活着,别的什么都不说明(`streamHeartbeat`)。 */
  | { kind: "heartbeat" };
