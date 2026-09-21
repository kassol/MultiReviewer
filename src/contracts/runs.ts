/**
 * 轮次详情(`GET /runs/{id}`)与时间流(`GET /runs`)的响应契约(issue #433)。两个端点
 * 共用 `store.listRuns` 同一份投影,因此共用这一个文件。
 *
 * 与 `stages.ts` 同一个理由:服务端投影出去的与面板读的是**同一个符号**,此前两边各写
 * 一份,而 `fetchJson<T>` 是断言不是校验——面板那一份把 `category` 写成 `string`、把
 * `severity` 另写一份字面量联合,还给轮次的 Finding 声明了一个 `/runs` 从来不回的
 * `lineAuthor`。这个文件同样只有类型,一行运行时代码都不许有。
 */

import type {
  CarriedAttribution,
  Category,
  Disposition,
  FindingPlacement,
  RecordedFindingAttribution,
  Severity,
} from "./finding.ts";
import type { ReviewRunMode, ReviewTriggerSource } from "./stages.ts";

/**
 * 一个 Reviewer 一次执行的 token 用量。运行诊断信息,不折算金额(issue #188)。
 *
 * 住在这里而不在 `src/review/finding.ts`:那个文件有运行时代码。它同时是统计页那几格
 * 用量的形状(`/stats` 的轮次用量与 Agent 会话用量各在它之上多一个计数),统计那份契约
 * 哪天迁过来就从这里引,不再各写一份。
 */
export type ReviewerUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

/**
 * 本轮落库的一条 Finding,带承载它的 Forge 评论 id 与链接。正文 fallback 没有行级评论,
 * 两项为 null。
 *
 * 它只认本轮:行作者与「这条活了多久」那几格不在这里,那是阶段汇总(`stage-summary.ts`)
 * 按 Identity 折叠之后才有的东西。
 */
export type RunFinding = {
  /** 落库行的 id。 */
  id: number;
  /** 报出它的全部模型,按首报先后(ADR 0015)。 */
  models: string[];
  /** 每个归属自己的说法,按首报先后(issue #266);同一模型的多条各占一项。 */
  attributions: RecordedFindingAttribution[];
  /**
   * 延续承接来的历史说法(issue #267):只有按复核结论合成的延续那一行才有,每段带
   * 原模型、来源轮次与那一轮的 head。它们不是本轮的归属。
   */
  carried: CarriedAttribution[];
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  /** 代表段(issue #278):描述最长的那条归属的问题、影响与建议,三段同出一条。 */
  description: string;
  /**
   * 升级前落的行没有存代表段的这两段,读回是按同一规则从归属现算的;归属本身也没存
   * 的那一档为 null,面板整段不展示。
   */
  impact: string | null;
  suggestion: string | null;
  disposition: Disposition;
  placement: FindingPlacement;
  commentId: string | null;
  commentHtmlUrl: string | null;
  /** 在面板上处置的人与时刻;在 Gitea 上处置的与升级前的历史行为 null。 */
  disposedBy: string | null;
  disposedAt: string | null;
  /** 处置备注,只存面板。 */
  note: string | null;
  /**
   * 这一行承接的那条旧评论的地址(CONTEXT.md 已延续)。面板据此显示「延续自」;
   * 不是延续来的行为 null。
   */
  continuedFrom: string | null;
  /**
   * 交接未完成(ADR 0025):这条「已延续」的旧行,它的旧评论还没在 Forge 上关掉。
   * 只有旧行会为 true;它是处置值之上的待办标记,不是处置。
   */
  handoffPending: boolean;
};

/**
 * 时间流里的一条 Review Run,也是轮次详情读的那一条。
 *
 * 端点在这之上还回一格 `reviewerPins`(本轮固定的模型服务版本与运行模型):它的类型
 * 一路挂到 Pi 的 `ModelRuntime`,搬进来会把 Pi 包拖进面板的类型检查,而面板一个读者都
 * 没有——那一格因此留在 `store.ts` 的 `RunListItem` 上与这份投影交叉,由服务端与用例读。
 */
export type RunProjection = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** 开跑时那个 pull request 的标题;null 即范围审查那一档或升级前的旧行。 */
  title: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 手动重跑的调用者用户名快照;null 即投递触发。 */
  triggeredBy: string | null;
  /** 这一轮是被谁开出来的(issue #312)。升级前的旧行按用户名快照回填。 */
  triggerSource: ReviewTriggerSource;
  /** 这一轮归属的范围审查;null 即 PR 触发。时间流据此区分两类来源。 */
  rangeReviewId: number | null;
  /** 发起这一轮时附的本轮指令(CONTEXT.md,issue #225);null 即没有附。 */
  directive: string | null;
  /** 这一轮的模式(CONTEXT.md 只复核,issue #242)。升级前的旧行是完整审查。 */
  mode: ReviewRunMode;
  failed: boolean;
  /**
   * 轮次级的失败原因(ADR 0026):这一轮为什么没有正常收尾。null 即收尾正常;与 `failed`
   * 分开读——`failed` 说的是全部 Reviewer 失败,这一格说的是收尾。
   */
  failure: string | null;
  /**
   * 一行一个参与本轮的模型,按模型名排序:行的来源是 `reviewer_outcome`(一轮一模型一
   * 行),不是 `finding`——被厂商拒掉的模型产出零条 Finding,按 `finding` 分组会让它从
   * 面板上消失,失败读成没跑。
   */
  models: {
    model: string;
    findings: number;
    failure: string | null;
    usage?: ReviewerUsage;
  }[];
  /** 本轮没有任何会话统计时省略,与失败 / 未运行的既有缺失语义一致。 */
  usage?: ReviewerUsage;
  findings: RunFinding[];
  /** 人工处置掉的 Finding 条数。 */
  resolved: number;
  /** 「已修复」自动处置掉的 Finding 条数。 */
  fixed: number;
  total: number;
};
