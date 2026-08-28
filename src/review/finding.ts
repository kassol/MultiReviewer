/**
 * Finding 的优先级,P0 最高。
 *
 * 用 P 级而非 high / medium / low:审查结果是给人排活儿用的,P 级在评论列表里一眼
 * 看得出轻重,形容词做不到。归一化层仍接受形容词——模型偶尔会不照约定报(ADR 0004)。
 */
export type Severity = "P0" | "P1" | "P2";

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
 * 规则集版本的快照,按批次路由:作用范围命中该批文件的,加上全仓库规则。
 *
 * `id` 是规则标识,模型报 Finding 时自报命中的就是它;`scope` 一并给出,否则模型无从
 * 知道一条带作用范围的规则只管这一批里的哪些文件。层标签不注入:它是人给规则分组用的
 * 标签,对判代码没有作用。
 */
export type ReviewRule = {
  id: number;
  /** 作用范围,glob;空串即全仓库。 */
  scope: string;
  /** 那一句规范陈述。 */
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
   * snippet 锚不上而被打回的 `report_finding` 次数(文件读不出来与内容对不上合记一个数)。
   * 打回后模型不重报,那条 Finding 就静默消失了;打回多而 findings 少,是该换模型或
   * 改 prompt 的信号。与 `rejectedToolCalls` 分列:一个是契约失配,一个是位置报不准。
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
export type ReviewerEvent =
  /** 模型说完的一整段话。按 Pi 的 `message_end` 记,不记流式增量。 */
  | { kind: "assistant_message"; text: string }
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
    };

/** 绑定了具体模型的审查执行体。 */
export interface Reviewer {
  readonly model: string;
  /**
   * `history` 是本审查阶段已经报过的 Finding(ADR 0016),每一批都给同一份:它说的是
   * 这个阶段的历史,与本批审哪些文件无关。首轮为空数组。
   *
   * `intent` 是这一轮声称要做的事(issue #201),每一批也都给同一份:它说的是整个
   * Review Range 的意图,与本批审哪些文件无关。取不到意图上下文的调用方不传。
   *
   * `rules` 是本轮冻结的规则集版本里、作用范围命中这一批文件的评审规则,加上全仓库
   * 规则(issue #204)。它与 `history`、`intent` 不同,每一批各给各的——规则按作用范围
   * 路由,一条只管某个目录的规则不该进不含那个目录的批次。空规则集给空数组。
   *
   * `onEvent` 收这个 Reviewer 的过程事件(issue #171),编排层一定传,一条即写一条轨迹。
   * 声明成可选是给直接调 `review` 的调用方留的余地:不看过程的地方不必造一个空回调。
   */
  review(
    range: ReviewRange,
    worktreePath: string,
    history: readonly HistoryFinding[],
    intent?: ReviewIntent,
    rules?: readonly ReviewRule[],
    onEvent?: (event: ReviewerEvent) => void,
  ): Promise<ReviewerOutcome>;
}
