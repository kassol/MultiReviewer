/**
 * 一条 Finding 在响应里的词汇表(issue #429):严重度、分类、处置结论、来源类型、行作者
 * 与两种逐模型说法。它们自己不是某一个端点的响应,而是好几份 Finding 形状的响应共用的
 * 叶子类型——阶段汇总(`stage-summary.ts`)先用上,轮次详情迁过来时也是这一批。
 *
 * 住在这里而不在 `src/review/finding.ts` 或 `store.ts`:那两个文件有运行时代码
 * (`DEFAULT_MIN_REPORT_SEVERITY`、`pg`),契约文件一行都不能有(见 `stages.ts`
 * 的文件头)。服务端照旧从原来那几处引,它们从这里再导出,调用点一处没动。
 */

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

/** Finding 的来源类型:进了行级评论,还是只进了 review 正文(fallback 与正文匹配)。 */
export type FindingPlacement = "inline" | "body";

/** 一行代码的行作者(CONTEXT.md):最后改动它的那个 git author 与那次提交。 */
export type LineAuthor = {
  /** 那次提交的完整 sha。 */
  sha: string;
  /** git author 的姓名,原样。 */
  name: string;
  /** git author 的邮箱,原样。 */
  email: string;
  /** authored 时间,ISO 字符串。 */
  authoredAt: string;
};

/**
 * 落到一条 Finding 上的行作者(CONTEXT.md):git 作者与那次提交,外加相邻改动标记
 * (issue #241)。
 */
export type RecordedLineAuthor = LineAuthor & {
  /**
   * 落点是 hunk 内的上下文行、作者取自同 hunk 内最近的那处改动时为 true。面板据此在
   * 行作者之后写「相邻改动」:这一行本身这一轮没改。
   */
  adjacent: boolean;
};

/**
 * 读回来的一个归属(issue #266):面板按它逐模型展示问题、影响与建议。`impact` 与
 * `suggestion` 为 null 即升级前落的行,当时没存;空串是模型没给。
 */
export type RecordedFindingAttribution = {
  model: string;
  severity: Severity;
  category: Category;
  description: string;
  impact: string | null;
  suggestion: string | null;
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
