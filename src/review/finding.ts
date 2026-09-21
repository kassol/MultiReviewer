import type { DiffRanges } from "./position.ts";

/**
 * Finding 的优先级,P0 最高。
 *
 * 用 P 级而非 high / medium / low:审查结果是给人排活儿用的,P 级在评论列表里一眼
 * 看得出轻重,形容词做不到。归一化层仍接受形容词——模型偶尔会不照约定报(ADR 0004)。
 */
export type Severity = "P0" | "P1" | "P2";

/**
 * 最低报告等级的系统默认:全报。缺行、旧轮次的空列都读成它,「P2 即全报」这一句判据
 * 因此只写在这里。
 *
 * 住在 `Severity` 旁边而不在 `store.ts`:判据的读者除了库,还有编排层与 Reviewer 子
 * 进程,后两者不能引 `store.ts`——那会把 `node:sqlite` 拖进 Reviewer 进程。
 */
export const DEFAULT_MIN_REPORT_SEVERITY: Severity = "P2";

export type Category = "security" | "bug" | "maintainability" | "design";

/**
 * 一条 Finding 的处置结论,取自 Forge 上对应 review 评论的 resolve 状态。
 * 本轮没有匹配到既有评论时无从得知,记 `unknown`。
 *
 * `resolved` 是人工处置,人在面板或 Gitea 上点的都算;`fixed` 是「已修复」自动处置,
 * MultiReviewer 自己 resolve 的那一档。两者在 Forge 上是同一个 resolve 状态,分开只在
 * 本地库与处置率统计里。
 *
 * `fixed` 这一档的判据是 ADR 0016 的复核结论:本轮全部 Reviewer 都判这条历史 Finding
 * 已修。指纹变没变都不参与——在上游加判空这类修法指纹不变,同样是修好了。
 *
 * `continued` 是「已延续」(CONTEXT.md),不是处置:复核判仍在而所指代码已改写时,旧
 * 位置的那一行进这一档,同一条 Finding Identity 由新位置那条承接。它在 Forge 上同样是
 * 一个 resolve,但不计入处置率的分子分母。
 */
export type Disposition = "resolved" | "unresolved" | "unknown" | "fixed" | "continued";

/**
 * 一条历史 Finding 的复核结论(CONTEXT.md 复核,ADR 0016):仍在 / 已修 / 无法判断。
 * 漏给结论按 `unclear` 计——沉默不是证据。
 */
export type ReviewVerdict = "present" | "fixed" | "unclear";

/**
 * 注入 Reviewer 的一条历史 Finding:本审查阶段(范围审查名下全部轮次,或 pull request
 * 名下全部轮次)里按 Finding Identity 汇总出的当前状态(ADR 0016)。
 *
 * 未处置的带全文——模型要据此判断这个问题还在不在;已处置的只占一行,是阶段很长时
 * 唯一的体积控制。两档都不带操作人:人名不进模型输入(issue #163 的用户故事 16)。
 */
export type HistoryFinding = {
  /** 该 Identity 最新一行的落库 id。Reviewer 回复核结论时原样带回它。 */
  id: number;
  file: string;
  line: number;
  title: string;
  /** 处置状态。`resolved` / `fixed` 即已处置,只给这一行。 */
  disposition: Disposition;
  /** 处置备注,没有就不带。备注只存面板,注入不改变它的可见范围。 */
  note?: string;
  /** 以下三项只有未处置的条目才有。 */
  severity?: Severity;
  category?: Category;
  description?: string;
};

/**
 * 延续承接来的一段历史说法(issue #267):历史 Finding 经复核仍在、代码位置已变而本轮
 * 没有重新报出时,合成的延续 Finding 把历史各归属的问题、影响与建议原样带过来,每段记
 * 最初说出它的模型与那一轮(那一轮的 head 即这段建议适用的代码版本)。它不是本轮的归属
 * ——本轮归属只有给出新位置的那个模型,统计与参与条数都不读它;连续多轮延续原样再带
 * 一遍,出处仍是最初那一轮,不层层嵌套。`impact` / `suggestion` 为 null 即源头本身没存
 * (升级前落的行),如实缺失,不凭空补。
 */
export type CarriedAttribution = {
  model: string;
  runId: number;
  headSha: string;
  description: string;
  impact: string | null;
  suggestion: string | null;
};

/** Reviewer 对一条历史 Finding 给出的复核结论。 */
export type FindingVerdict = {
  /** 对应 `HistoryFinding.id`。 */
  findingId: number;
  verdict: ReviewVerdict;
  /**
   * 仍在时这个问题此刻所在的行(issue #170)。模型给了新位置,编排层就据此在新位置合成
   * 本轮的一条 Finding 去承接同一条 Identity,不再等它自己重报一遍。只有 `present`
   * 这一档带它,且已经过 snippet 锚定核对。
   */
  line?: number;
};

/**
 * Reviewer 经复核工具报出的、尚未归一化的结论。`verdict` 是宽松字符串,理由同
 * `RawFinding` 的枚举字段:收窄会让模型自造词汇、调用被拒(ADR 0004)。
 */
export type RawVerdict = {
  id: number;
  verdict: string;
  /** 仍在时的新位置(issue #170)。子进程先用 snippet 锚定核对过才回传,对不上不带。 */
  line?: number;
};

/**
 * 一条被提出的代码问题。归属于提出它的 Reviewer,并指向 Review Range 内的具体位置。
 *
 * `line` 是 head commit 中该文件的 1-indexed 行号。
 */
export type Finding = {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  /** 一句话标题,中文。评论列表里扫一眼用的。 */
  title: string;
  /** 问题是什么、为什么错,中文。 */
  description: string;
  /** 影响面:什么场景下坏、坏成什么样,中文。 */
  impact: string;
  /** 建议的修改方式,中文。 */
  suggestion: string;
  /** 提出它的 Reviewer 所绑定的模型标识。 */
  model: string;
  /**
   * 模型自报命中的那条评审规则(issue #204),已经过服务端校验:只有本轮注入过的标识
   * 留得下来。它只落库,不进内容指纹,不参与 Finding Identity 与合并去重。
   */
  ruleId?: number;
};

/**
 * 一轮 Review Run 的模式(CONTEXT.md 只复核,issue #242)。
 *
 * `full` 是完整审查:照常报出新问题,顺带复核历史。`verdict-only` 是只复核:这一轮只对
 * 有未处置历史的文件跑,Reviewer 不注册报出工具,只能给复核结论——清历史与找新问题是
 * 两个目标,整段范围每重跑一轮就多几十条新报,一次重跑不该被迫两件事一起做。
 */
export type ReviewRunMode = "full" | "verdict-only";

/**
 * 一轮 Review Run 是被谁开出来的(issue #312)。
 *
 * `delivery` 是 Forge 投递,`panel` 是人在面板上的重跑、发起范围审查与推进比较项,
 * `scheduled` 是每日增量的定时检查(spec #310;本票只定义这一档,写入由那张票做)。
 * 它与调用者用户名快照分开:定时开出的那一轮没有调用者,「没有用户名」从此不再等于
 * 「投递」。升级前的旧行按用户名回填(有即 `panel`,否则 `delivery`)。
 */
export type ReviewTriggerSource = "delivery" | "panel" | "scheduled";

/** 一次 Review Run 覆盖的代码范围。`baseSha` 是 merge-base,不是 base 分支尖端。 */
export type ReviewRange = {
  baseSha: string;
  headSha: string;
  files: string[];
};

/**
 * 这一轮声称要做的事(issue #201)。Reviewer 据此在正确性之外判断规格保真度:声称的
 * 行为缺失、未声称的行为混入。
 *
 * 两个来源各给自己那份:pull request 触发的轮次带那个 PR 的标题与正文,范围审查的轮次
 * 只有发起时人给的标题——容器 PR 的标题与正文由本工具自己拼出(`range-review.ts`),
 * 不是意图来源。commit 列表两档同一口径:Review Range 内的那些。
 */
export type ReviewIntent = {
  /** pull request 标题,或范围审查标题。读不到时为空串。 */
  title: string;
  /** pull request 正文,过长时保头部截断。范围审查与空正文都不带。 */
  body?: string;
  /** Review Range 内的 commit message 全文,新的在前,按条数截断。 */
  commits: readonly string[];
  /** 按条数截断掉的 commit 条数。截断过的列表要让模型知道自己没看全。 */
  omittedCommits: number;
};

/**
 * 注入 Reviewer 的一条评审规则(CONTEXT.md 评审规则,issue #204)。取自本轮冻结的那个
 * 知识集版本的快照,按批次路由:作用范围命中该批文件的,加上全仓库规则。
 *
 * `id` 是规则标识,模型报 Finding 时自报命中的就是它;`scope` 一并给出,否则模型无从
 * 知道一条带作用范围的规则只管这一批里的哪些文件。
 */
export type ReviewRule = {
  id: number;
  /** 作用范围,glob;空串即全仓库。 */
  scope: string;
  /** 那一句规范陈述。 */
  statement: string;
};

/**
 * 一条知识条目是评审规则还是项目事实(CONTEXT.md,ADR 0020)。封闭枚举,新增取值要新
 * 开一份 ADR。落库那一侧、注入那一侧与规则 agent 的产出共用这一个字面量。
 */
export type KnowledgeType = "rule" | "fact";

/**
 * 交给规则 agent 的一条现有知识条目(CONTEXT.md,issue #222)。**带标识也带两型**:
 * agent 提的是对照现有知识集的变更,不知道哪条是哪型就分不清「改一条规则」与「废止一条
 * 过期事实」。Reviewer 那侧的注入不用这个形状——它按型分两段,事实不给标识。
 */
export type KnowledgeEntry = {
  id: number;
  type: KnowledgeType;
  /** 作用范围,glob;空串即全仓库。 */
  scope: string;
  statement: string;
};

/**
 * 一条修订提案的变更类型(CONTEXT.md 修订提案):新增、修改、废止或合并。合并是多条
 * 目标条目换一条新陈述(issue #282),目标因此不止一条。落库那一侧与规则 agent 那一侧
 * 共用这一个字面量(issue #283:反哺 agent 也看得到待裁决队列里每一条是什么变更)。
 */
export type RuleProposalChange = "add" | "modify" | "retire" | "merge";

/**
 * 交给反哺 agent 的一条待裁决提案(CONTEXT.md 修订提案,issue #283)。**带标识**:agent
 * 认出新备注说的是队列里已有的一件事时,要指名并入那一条。变更类型与目标一起给——
 * 「废止某条」与「新增一条」说的不是同一件事,少了它 agent 分不出该不该并。
 */
export type PendingProposal = {
  id: number;
  change: RuleProposalChange;
  /** 这条变更指向的现有条目。新增没有目标,为空。 */
  targetRuleIds: readonly number[];
  statement: string;
};

/**
 * 注入 Reviewer 的一条项目事实(CONTEXT.md 项目事实,issue #221)。与评审规则取自同一个
 * 知识集版本、按同一条作用范围路由,注入时另起一段:它是判断依据,本身不构成 Finding。
 *
 * `id` 不进 prompt——事实不是 `ruleId` 的合法取值,给出标识只会请模型编一个填进来。它仍
 * 随注入一路带到子进程:`report_finding` 要凭它认出指向事实的标识并打回。
 */
export type ProjectFact = {
  id: number;
  /** 作用范围,glob;空串即全仓库。 */
  scope: string;
  /** 那一句可核查的事实陈述。 */
  statement: string;
};

/**
 * Reviewer 经 `report_finding` 报出的、尚未归一化的条目。
 *
 * `severity` 与 `category` 是宽松字符串:用字面量联合强制时模型会自造词汇导致调用
 * 被拒、Finding 全部丢失(prototype 实测,见 ADR 0004)。归一化在服务端做。
 */
export type RawFinding = {
  file: string;
  line: number;
  /**
   * 问题起始行的原文,模型从 read 输出照抄。行号靠它核对与校正(见 `anchor.ts`):
   * 模型数行会数偏,抄下来的代码不会。
   */
  snippet: string;
  severity: string;
  category: string;
  title: string;
  description: string;
  impact: string;
  suggestion: string;
  /** 模型自报命中的那条规则的标识(issue #204)。没有命中任何规则时不给。 */
  ruleId?: number;
};

/** 一个 Reviewer 一次执行的 token 用量。运行诊断信息,不折算金额。 */
export type ReviewerUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};


/** 一个 Reviewer 跑完之后的全部产出,含失败与异常,而不只是 Finding。 */
export type ReviewerOutcome = {
  model: string;
  findings: Finding[];
  /** 归一化失败的条目。记录下来,不静默丢弃。 */
  anomalies: { raw: RawFinding; reason: string }[];
  /** 被 Pi 校验拒绝的工具调用次数。不为零而 findings 为零即契约失配。 */
  rejectedToolCalls: number;
  /**
   * 被打回的 `report_finding` 次数:snippet 锚不上(文件读不出来与内容对不上)、锚在
   * 本轮 diff 的 hunk 外(issue #224)、拿事实当命中规则(issue #221)、复核工具收到本批
   * 没注入的历史 id(issue #235)合记一个数。
   * 打回后模型不重报,那条 Finding 就静默消失了;打回多而 findings 少,是该换模型或
   * 改 prompt 的信号。与 `rejectedToolCalls` 分列:一个是契约失配,一个是报法不对。
   */
  anchorRejections: number;
  /** 有值即该 Reviewer 失败,其 findings 不代表"代码没问题"。 */
  failure?: string;
  /**
   * 子进程的退出码。只有真实子进程跑完一批且退出码非零时才有,进轨迹的失败事件带上它
   * (issue #171)。分批执行时合并出来的失败原因来自多批,单个退出码说不清是哪一批,
   * 那一档不带。
   */
  exitCode?: number;
  /** 子进程未回报结果即退出时取不到用量。 */
  usage?: ReviewerUsage;
  /**
   * 末回合的停止原因与这一批的回合数(issue #408)。只有真实子进程给得出:它们取自 Pi
   * 会话自己的消息列表,不依赖事件流——收尾事件因此自己说得清这一批是怎么结束的。
   * 脚本化的 Reviewer 不给,批次收尾事件里那两格因此是空的。
   */
  stopReason?: string;
  turns?: number;
  /**
   * 分批执行时部分批次失败,该模型本次覆盖不全,成功批次的 Finding 仍然有效。
   * 全部批次都失败时改记 `failure`,按缺席处理。由编排层合并批次结果时填写。
   */
  incompleteCoverage?: {
    batchCount: number;
    /** `batchIndex` 从 1 起,直接呈现给读 review 的人。 */
    failures: { batchIndex: number; failure: string }[];
  };
  /**
   * 对注入的历史 Finding 逐条给出的复核结论(ADR 0016)。缺省即一条都没给,
   * 编排层按「无法判断」落库——沉默不是证据,但也不能算它没跑过。
   */
  verdicts?: readonly FindingVerdict[];
};

/**
 * Reviewer 执行过程中发出的一条事件,进这一轮的审查轨迹(CONTEXT.md 审查轨迹,
 * issue #171)。两档都由子进程订阅 Pi 的会话事件转发而来,编排层只落库与广播。
 *
 * 事件正文不设长度上限;工具返回的内容只记长度,不记正文(ADR 0017)。
 */
/**
 * 一个模型回合的内容构成(issue #407)。思考正文不入库(ADR 0017),只记块数与总字数——
 * 「这一回合到底产出了什么」不必读正文就答得出,而正文进库等于把推理全文复制进面板。
 */
export type TurnContent = {
  text: number;
  thinking: number;
  toolCalls: number;
  thinkingChars: number;
};

/** 一个模型回合的 token 用量(issue #407)。四格与 `ReviewerUsage` 同名,面板共用一套读法。 */
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ReviewerEvent =
  /**
   * 模型说完的一整段话。按 Pi 的 `message_end` 记,不记流式增量。
   *
   * **每个回合都落一条,一个字都没说的回合也落**(issue #407):线上排障卡在这里——一批
   * 读完工具结果就无声结束的会话在轨迹里一条痕迹都没有,只能从「最后一个事件是什么」
   * 反推。空回合的 `text` 是空串。
   */
  | {
      kind: "assistant_message";
      text: string;
      /**
       * Pi 归一后的停止原因(`stop` / `toolUse` / `length` / `error` / `aborted` 等)。
       * 升级前的轨迹没有这一格。
       */
      stopReason?: string;
      /** 停止原因是出错时的错误原文,与别的事件同一道凭据脱敏。 */
      error?: string;
      content?: TurnContent;
      usage?: TurnUsage;
    }
  /** 一次工具调用跑完。按 Pi 的 `tool_execution_end` 记一条。 */
  | {
      kind: "tool_call";
      tool: string;
      /** 模型给的参数,原样转成 JSON。 */
      args: unknown;
      durationMs: number;
      /** 真即这次调用被拒或抛错,`error` 是原因。 */
      isError: boolean;
      error: string | null;
      /** 返回的文本内容有多长。正文本身不进轨迹。 */
      resultLength: number;
      /**
       * 这次调用派出的子会话自己的事件序列(CONTEXT.md 取证,issue #227)。取证是唯一
       * 会带它的调用:子代理是另一个会话,它说过的话、调过的工具与最后那份报告只有
       * 从这里嵌进来才进得了审查轨迹。事件形状与外层同一套,面板因此用同一个渲染器。
       */
      nested?: readonly ReviewerEvent[];
    }
  /**
   * Pi 的一次自动重试(issue #409)。瞬时的模型服务错误被重试吞掉之后此前不留痕,排障时
   * 分不出「模型自己停了」与「错误重试之后才停」。
   *
   * 排上与落定各一条,不攒到落定再一起发:攒起来的话进程在等待那几秒里死掉就连触发它的
   * 错误都看不到,而那正是要查的东西。`waiting` 是排上那一条,带最多重试几次与等多久;
   * 另两档是这一串重试的结局,Pi 只在这时才知道成没成。
   */
  | {
      kind: "model_retry";
      outcome: "waiting" | "succeeded" | "gave_up";
      /** 这次重试排第几次。 */
      attempt: number;
      maxAttempts?: number;
      delayMs?: number;
      /** 触发它的错误原文,或最终放弃时那一句。已脱敏;成功那一条没有。 */
      error: string | null;
    }
  /**
   * Pi 的一次上下文压缩(issue #409)。压缩改变会话走向,而轨迹里此前完全看不到它发生过。
   * 压缩没成时前后 token 数取不到,`error` 说得出是中止还是出错。
   */
  | {
      kind: "context_compacted";
      /** 手动、到阈值还是上下文溢出。 */
      reason: string;
      tokensBefore: number | null;
      /** Pi 给的是估算值(`estimatedTokensAfter`)。 */
      tokensAfter: number | null;
      error: string | null;
    };

/**
 * `query_knowledge` 的一次查询(issue #344、#360、#362)。两层各有自己的入口:仓库层按
 * 会话根里的仓库加可选的路径 glob 取,产品层按名字取整条(术语条目与产品决策)或整段取
 * 仓库关系。
 *
 * 定在 `review/` 而不是 `reviewer/`:它说的是库里那两层知识长什么样,Agent 会话与
 * Reviewer 两条链路读的是同一份(ADR 0035,issue #362)。`reviewer/session-protocol.ts`
 * 原样转出,那一侧的 import 一行不动。
 */
export type SessionKnowledgeQuery = {
  /** `<owner>/<repo>` 形式。省略即这一次不问仓库层。 */
  repos?: readonly string[];
  /** 仓库相对的路径 glob。省略即整个仓库。 */
  pathGlob?: string;
  /** 要读整条的术语名与决策标题(issue #360)。 */
  names?: readonly string[];
  /** 要不要整段读仓库关系。 */
  relationships?: boolean;
};

/** 一次查询回的两层条目(issue #344)。层由它在哪个数组里定,渲染时写成文字。 */
export type SessionKnowledgeEntries = {
  /** 产品层:整条的术语条目、仓库关系与产品决策(issue #360)。 */
  product: readonly SessionProductKnowledge[];
  /** 仓库层:哪个仓库的、哪一型、作用范围(空串即全仓库)与那一句陈述。 */
  repo: readonly {
    repo: string;
    type: "rule" | "fact";
    scope: string;
    statement: string;
  }[];
};

/**
 * 一条产品知识,交给子进程那一侧的形态(CONTEXT.md 产品知识,issue #360)。
 *
 * **不带出处附注**:附注只在产品页展示,一条提示里的条目不带它(ADR 0035)。
 */
export type SessionProductKnowledge = {
  id: number;
  kind: "term" | "relationship" | "decision";
  /** 术语的名称、决策的标题;仓库关系是空串。 */
  name: string;
  body: string;
  topic: string | null;
  avoided: readonly string[];
  options: string | null;
  consequences: string | null;
  /** 取代这条决策的那一条的 id。null 即它生效。 */
  supersededBy: number | null;
};

/**
 * 一个产品知识的目录(CONTEXT.md 产品知识,issue #362)。进 Reviewer 的每批提示与每个
 * 会话提示的就是这三行:一句定位、术语名清单、产品决策标题清单。
 *
 * **只有名字,没有正文**:正文按名字走 `query_knowledge` 取整条。目录是给模型判断
 * 「这一批要不要花一次调用」用的,整份注入会让每一批都为用不上的条目付 token。
 */
export type ProductKnowledgeContents = {
  /** 定位那一条术语的定义原文。产品没写过定位即缺席,那一行不渲染。 */
  positioning?: string;
  /** 术语名,定位那一条除外——它的正文已经在上一行里。 */
  terms: readonly string[];
  /** 生效的产品决策标题。被取代的那些不进目录:目录说的是此刻作数的那几条。 */
  decisions: readonly string[];
};

/** 目录里「定位」那一条:主题分组或名字是这两个字的术语条目。 */
const POSITIONING = "定位";

/**
 * 从一个产品此刻的全部条目算出它的目录(issue #362)。
 *
 * 参数按结构取形,库里那一份(`ProductKnowledgeEntry`)与交给子进程的那一份
 * (`SessionProductKnowledge`)都喂得进来——两边算出的目录必须逐字一样。
 */
export function productKnowledgeContents(
  entries: readonly {
    kind: string;
    name: string;
    body: string;
    topic: string | null;
    supersededBy: number | null;
  }[],
): ProductKnowledgeContents {
  const terms = entries.filter((entry) => entry.kind === "term");
  // 定位既可能写成一条名叫「定位」的术语,也可能是分组名为「定位」的那一条;两种都认。
  const positioning = terms.find(
    (entry) => entry.topic === POSITIONING || entry.name === POSITIONING,
  );
  return {
    ...(positioning === undefined ? {} : { positioning: positioning.body }),
    terms: terms.filter((entry) => entry !== positioning).map((entry) => entry.name),
    decisions: entries
      .filter((entry) => entry.kind === "decision" && entry.supersededBy === null)
      .map((entry) => entry.name),
  };
}

/** 一条目录都没有:没写下过任何术语、定位与生效决策。那时提示不渲染这一段。 */
export function knowledgeContentsEmpty(contents: ProductKnowledgeContents): boolean {
  return (
    contents.positioning === undefined &&
    contents.terms.length === 0 &&
    contents.decisions.length === 0
  );
}

/**
 * 一个 Reviewer 跑一批所需的全部输入(issue #211)。用选项对象而不是位置参数:注入项
 * 已有五项且可选的夹在中间,再添一项就要在调用处数逗号。
 *
 * 字段与 `ReviewerRequest` 同名同义,那边只多一份 `runtimeModel`,并去掉不可跨进程
 * 传递的 `onEvent`。
 */
export type ReviewerInput = {
  range: ReviewRange;
  worktreePath: string;
  /**
   * 本轮 Review Range 的 diff 在新文件一侧的可评论行区间(issue #224)。Finding 与复核
   * 的新位置都必须锚在其中,锚不进的当场打回让模型重锚。
   *
   * 给的是整个 Review Range 的那一份,不按批次裁剪:落点的判据是「这次改动碰过这一行」,
   * 与这一批分到哪几个文件无关,裁剪只会让跨批次的合法落点被误拒。
   */
  commentable: DiffRanges;
  /**
   * 本审查阶段已经报过的 Finding 里、所在文件在这一批的那些(ADR 0016,issue #235):
   * 一条历史只进一批,复核它的因此是真正审到那个文件的 Reviewer。批内每个 Reviewer
   * 拿到的是同一份,不分批时是整份历史。首轮为空数组。
   */
  history: readonly HistoryFinding[];
  /**
   * 这一轮声称要做的事(issue #201),每一批都给同一份:它说的是整个 Review Range
   * 的意图,与本批审哪些文件无关。取不到意图上下文的调用方不传。
   */
  intent?: ReviewIntent;
  /**
   * 本轮冻结的知识集版本里、作用范围命中这一批文件的评审规则,加上全仓库规则
   * (issue #204)。它与 `history`、`intent` 不同,每一批各给各的——规则按作用范围
   * 路由,一条只管某个目录的规则不该进不含那个目录的批次。空知识集给空数组。
   */
  rules?: readonly ReviewRule[];
  /**
   * 本轮冻结的知识集版本里、作用范围命中这一批文件的项目事实,加上全仓库事实
   * (issue #221)。路由与 `rules` 同一条口径;事实集为空给空数组,prompt 因此不渲染
   * 事实段,与升级前逐字一致。
   */
  facts?: readonly ProjectFact[];
  /**
   * 本轮指令(CONTEXT.md,issue #225):发起重审时评审方附的一次性要求,每一批给同一份
   * ——它说的是这一轮的要求,与本批审哪些文件无关。没有附即不传,prompt 因此不渲染
   * 指令段,与没有这一票时逐字一致。
   */
  directive?: string;
  /**
   * 这一轮的模式(issue #242)。不传即完整审查,请求形状与这一票之前逐字一致;
   * `verdict-only` 时子进程不注册报出工具,模型只能给复核结论。
   */
  mode?: ReviewRunMode;
  /**
   * 每批每模型的取证次数上限(CONTEXT.md 审查策略,issue #258):本轮运行计划开跑时
   * 冻结的那一格,每一批给同一份。不传即 Reviewer 实现自己的系统默认,请求形状与这一票
   * 之前逐字一致。
   */
  maxEvidenceCallsPerBatch?: number;
  /**
   * 本轮的最低报告等级(CONTEXT.md 最低报告等级,issue #271):低于它的问题不要报出。
   * 阈值是 P2(全报)时不传,prompt 因此不渲染阈值段,请求形状与这一票之前逐字一致。
   */
  minReportSeverity?: Severity;
  /**
   * 这一批是整个 Review Range 的一部分(issue #306):`range.files` 之外的文件只作阅读
   * 上下文,报在它们上面的条目由编排层丢弃。分批时才传,任务提示词据此多一句说明;
   * 单批(PR 触发)不传,prompt 与这一票之前逐字一致。
   */
  batched?: true;
  /**
   * 这个仓库所属产品的产品知识目录(CONTEXT.md 产品知识,issue #362)。每一批给同一份
   * ——它说的是这个产品的语言,与本批审哪些文件无关。**仓库不属于任何产品、或产品一条
   * 都没写下时不传**,prompt 因此不渲染这一段,与这一票之前逐字一致。
   */
  productKnowledge?: ProductKnowledgeContents;
  /**
   * 按名字读整条产品知识(issue #362)。库在编排进程,Reviewer 在子进程里,这一格因此
   * 与 `onEvent` 同律跨不了进程:`ReviewerRequest` 里没有它,子进程经 IPC 问回来。
   *
   * 与 `productKnowledge` 同进同出:目录不传时这一格也不传,子进程据此不注册
   * `query_knowledge`——目录里没有名字可抄时那件工具无事可做。
   */
  queryKnowledge?: (query: SessionKnowledgeQuery) => SessionKnowledgeEntries;
  /**
   * 收这个 Reviewer 的过程事件(issue #171),编排层一定传,一条即写一条轨迹。
   * 声明成可选是给直接调 `review` 的调用方留的余地:不看过程的地方不必造一个空回调。
   */
  onEvent?: (event: ReviewerEvent) => void;
};

/** 绑定了具体模型的审查执行体。 */
export interface Reviewer {
  readonly model: string;
  review(input: ReviewerInput): Promise<ReviewerOutcome>;
}
