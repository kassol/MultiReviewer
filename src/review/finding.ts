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
 * 这一档的名字来自 ADR 0016(它把处置值定为「已修复」),判据仍是 ADR 0013 的指纹规则
 * ——所指代码已改动且本轮未再报出。换成复核结论由后续票落地,本票只换名。
 */
export type Disposition = "resolved" | "unresolved" | "unknown" | "fixed";

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
};

/**
 * Reviewer 经复核工具报出的、尚未归一化的结论。`verdict` 是宽松字符串,理由同
 * `RawFinding` 的枚举字段:收窄会让模型自造词汇、调用被拒(ADR 0004)。
 */
export type RawVerdict = {
  id: number;
  verdict: string;
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
};

/** 一次 Review Run 覆盖的代码范围。`baseSha` 是 merge-base,不是 base 分支尖端。 */
export type ReviewRange = {
  baseSha: string;
  headSha: string;
  files: string[];
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
};

export type ReviewerCostSource = "trusted" | "unknown";

/** 一个 Reviewer 一次执行的用量与产品费用。 */
export type ReviewerUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** 费用完整时的美元总额；固定模型价格未知时保持 null，不把 Pi 的 0 当成免费。 */
  costUsd: number | null;
  /** 已知金额小计。费用未知时仍保留同一次聚合里其他已知金额。 */
  knownCostUsd: number;
  /** 本轮固定的模型价格能否支持可信金额。 */
  costSource: ReviewerCostSource;
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

/** 绑定了具体模型的审查执行体。 */
export interface Reviewer {
  readonly model: string;
  /**
   * `history` 是本审查阶段已经报过的 Finding(ADR 0016),每一批都给同一份:它说的是
   * 这个阶段的历史,与本批审哪些文件无关。首轮为空数组。
   */
  review(
    range: ReviewRange,
    worktreePath: string,
    history: readonly HistoryFinding[],
  ): Promise<ReviewerOutcome>;
}
