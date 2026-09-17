/**
 * Agent 会话的常驻子进程与主进程之间的 IPC 形状(issue #333)。
 *
 * 与 Reviewer 那份协议(`protocol.ts`)分开:那是「投一个任务、收一批产出、进程退出」,
 * 这是「开一次会话、之后一问一答到进程被回收」。消息因此分两向各几档,子进程起来之后
 * 一直活着。
 */
import type { ThinkingLevel } from "../config.ts";
import type {
  AgentSessionOutputKind,
  RepoFinding,
  RepoFindingQuery,
} from "../review/store.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import type { AgentSessionImageRef } from "./session-images.ts";
import type { SessionSubagentRun } from "./session-subagent.ts";

/**
 * 主进程与子进程各自往会话记录里放的那两种 Pi 条目的 `customType`(issue #337)。放在这份
 * 共享协议里:两侧写的是同一张记录表,面板按这两个取值认出它们(`custom` 的产出卡片与
 * `custom_message` 的定稿 / 换版那一行)。
 */
export const AGENT_SESSION_OUTPUT_CUSTOM_TYPE = "multireviewer-session-output";
export const AGENT_SESSION_NOTE_CUSTOM_TYPE = "multireviewer-session-note";
/**
 * 基点更新(CONTEXT.md 基点更新,issue #356)的 `custom_message` 类型。与定稿那一句分开取值:
 * 面板要把它渲染成「仓库 旧 sha → 新 sha」那一行,而不是一句提示。只有主进程写它。
 */
export const AGENT_SESSION_BASELINE_UPDATE_CUSTOM_TYPE = "multireviewer-session-baseline-update";

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
 * `query_knowledge` 的一次查询(issue #344):任务落在会话根里的哪几个仓库,以及可选的
 * 路径 glob。仓库在不在会话根内由子进程判(它手里就是那份清单),这里只带它问的那几个。
 */
export type SessionKnowledgeQuery = {
  /** `<owner>/<repo>` 形式,都是会话根下的仓库。 */
  repos: readonly string[];
  /** 仓库相对的路径 glob。省略即整个仓库。 */
  pathGlob?: string;
};

/** 一次查询回的两层条目(issue #344)。层由它在哪个数组里定,渲染时写成文字。 */
export type SessionKnowledgeEntries = {
  /** 产品层:涉及的仓库集合(`<owner>/<repo>`)与那一句陈述。 */
  product: readonly { repos: readonly string[]; statement: string }[];
  /** 仓库层:哪个仓库的、哪一型、作用范围(空串即全仓库)与那一句陈述。 */
  repo: readonly {
    repo: string;
    type: "rule" | "fact";
    scope: string;
    statement: string;
  }[];
};

/**
 * 一条生效的产品知识,交给子进程那一侧的形态(CONTEXT.md 产品知识,issue #345)。仓库集合
 * 在这里已经是 `<owner>/<repo>`:子进程手上只有这种形式的仓库名,repo id 它认不出来。
 */
export type SessionProductKnowledge = {
  id: number;
  statement: string;
  repos: readonly string[];
};

/** 开一个会话要给的那几样。凭据不进 IPC,走环境变量(`env.ts`)。 */
export type OpenSessionRequest = {
  /** 会话根目录。cwd 是它,只读工具圈在它里面,工作树挂在它下面。 */
  sessionRoot: string;
  /** 这个会话挂在哪个产品上(CONTEXT.md 产品,issue #341)。进系统提示一行。 */
  productName: string;
  /** 会话用途(CONTEXT.md 会话用途)。进系统提示一行。 */
  purpose: string;
  /**
   * 这个产品生效的产品知识条数(CONTEXT.md 产品知识,issue #344)。与仓库那两个计数一样
   * 只进提示的目录那一段:陈述本身走 `query_knowledge` 取。
   */
  productKnowledgeCount: number;
  repos: readonly SessionRepoInput[];
  /**
   * 这个产品此刻生效的产品知识(issue #345)。产品梳理那一段提示按它列出「已经成立的是哪些」,
   * 产出工具的退役目标也按它判。空数组即这个产品还没有产品知识。
   */
  productKnowledge: readonly SessionProductKnowledge[];
  /**
   * 这个产品被人驳回过的陈述(issue #346 的 US 24)。产品梳理那一段提示逐条列出来让它
   * 换个措辞也别再提;别的用途用不上。空数组即还没有人驳回过。
   */
  rejectedStatements: readonly string[];
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
 * 一份交上来的会话产出(CONTEXT.md 会话产出,issue #337)。`payload` 的形状由产出类型自己
 * 定(需求拆分那一份在 `session-output-tools.ts`),这条协议只把它原样带过去。
 */
export type SessionOutput = {
  kind: AgentSessionOutputKind;
  /** 产生它的那次工具调用。 */
  toolCallId: string;
  payload: unknown;
};

/**
 * 产品梳理交上来的一批提案(CONTEXT.md 产品梳理,issue #345)。与会话产出分成两档:产出是
 * 人要读的一份文档,这一批是要落进产品知识表的提案行,交出来就等人确认。
 *
 * 形状与校验都在子进程那一侧判完(`session-output-tools.ts`):陈述的仓库集合是
 * `<owner>/<repo>`,退役指向的是提示里列过的那条生效条目的 id。
 */
export type ProductSurveyProposals = {
  statements: readonly { statement: string; repos: readonly string[] }[];
  retirements: readonly { id: number; reason: string }[];
};

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
  /**
   * 往会话里放一条进模型上下文的自定义消息,不开新回合(issue #337)。定稿与换版走它:
   * 那是人做的动作,agent 下一轮要知道哪一版定了。落库由镜像那条路完成,与别的条目同形。
   */
  | { kind: "custom-message"; text: string }
  /**
   * 往会话里放一条不进模型上下文的 `custom` 条目(issue #337 的产出卡片标记)。要经子进程
   * 放:Pi 会话在它的内存里,主进程直接落库的那一条接不上链——下一条回复仍挂在它前面那条
   * 上,这一条就成了旁支,重建时被算成「不在上下文」。落库由镜像那条路完成。
   */
  | { kind: "custom-entry"; customType: string; data: unknown }
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
   * agent 经产出工具交出的一份会话产出(issue #337)。一次调用一条消息,与 Finding 回传
   * 同形:子进程只把归一化与打回判完的那一份交上来,落产出表与广播都在主进程。
   */
  | { kind: "output"; output: SessionOutput }
  /**
   * 产品梳理经它的产出工具交的那一批提案(issue #345)。与产出回传同形:子进程只把校验过的
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
  /** 会话还活着,别的什么都不说明(`streamHeartbeat`)。 */
  | { kind: "heartbeat" };
