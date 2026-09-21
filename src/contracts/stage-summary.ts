/**
 * 阶段汇总(`GET /stage-summary`)的响应契约(issue #429)。
 *
 * 与 `stages.ts` 同一个理由:服务端投影出去的与面板读的是**同一个符号**,此前两边各写
 * 一份,而 `fetchJson<T>` 是断言不是校验(面板那一份至今没声明过 `rootCauseGroups`)。
 * 这个文件同样只有类型,一行运行时代码都不许有。
 */

import type {
  CarriedAttribution,
  Category,
  Disposition,
  FindingPlacement,
  RecordedFindingAttribution,
  RecordedLineAuthor,
  Severity,
} from "./finding.ts";
import type { StageListItem, StageTimelineEntry } from "./stages.ts";

/**
 * 阶段汇总里的一条 Finding(issue #168):一个审查阶段按 Finding Identity 折叠之后的
 * 一条,取它最新一轮那一行——只有那一行带着当前的处置状态、备注与承载它的评论。
 *
 * `id` 是那一行的落库 id,面板按它走既有的处置接口。`firstRunId` / `lastRunId` 说的是
 * 这条活了多久:延续过的那些首见轮次跟着 Identity 走,不从交接那一轮重新算。
 *
 * 「已延续」的整条不在这里:那处 Finding 已经交接到新位置,新位置那条自己在列表里。
 */
export type StageSummaryFinding = {
  id: number;
  file: string;
  /**
   * 这条 Finding 此刻指着的那一行(issue #368):每一轮开跑时按内容指纹重定位一次,
   * 解析不到就停在上一次定下的位置上。它属于 `placedRunId` 那一轮的 head。
   */
  line: number;
  /**
   * `line` 属于哪一轮(issue #368):重定位过就是定下它的那一轮,没重定位过就是报出
   * 它的那一轮。面板的代码差异侧滑按它取 diff——行号只有对着算出它的那个 head 才成立。
   */
  placedRunId: number;
  /** 它被报出来时的那一行。归属与首次报出按这一份算;面板不展示它。 */
  reportedLine: number;
  /** 代表段那条归属给的标题:与 `description` 同一条来源;升级前的行没有它,占位为空。 */
  title: string;
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
  /** 报出它的全部模型,按首报先后(ADR 0015)。 */
  models: string[];
  /** 每个归属自己的说法,按首报先后(issue #266),取最新那一轮落的那几条。 */
  attributions: RecordedFindingAttribution[];
  /** 延续承接来的历史说法(issue #267),取最新那一轮那一行带的;没有延续过即空。 */
  carried: CarriedAttribution[];
  disposition: Exclude<Disposition, "continued">;
  placement: FindingPlacement;
  commentId: string | null;
  commentHtmlUrl: string | null;
  disposedBy: string | null;
  disposedAt: string | null;
  note: string | null;
  /** 承接来的那条旧评论的地址(CONTEXT.md 已延续);不是延续来的为 null。 */
  continuedFrom: string | null;
  /**
   * 交接未完成(ADR 0025):这条 Identity 承接过来的那条旧评论还没在 Forge 上关掉。
   * 旧行自己不在汇总里,标记因此挂在承接它的这一条上,面板据此标「旧评论待关闭」。
   */
  handoffPending: boolean;
  /** 行作者(CONTEXT.md),取最新那一轮判定的结果;未判定为 null,面板显示「无法追溯」。 */
  lineAuthor: RecordedLineAuthor | null;
  firstRunId: number;
  firstReportedAt: string;
  lastRunId: number;
  lastReportedAt: string;
  /** 这条属于哪个同根因组(issue #309);未入组即 null。 */
  rootCause: StageRootCauseRef | null;
};

/**
 * 阶段汇总里一条 Finding 的同根因组引用(CONTEXT.md 同根因组,ADR 0030,issue #309)。
 * 面板按它把入组的条目折到组卡下面,`memberCount` 与 `position` 说的是折过去之后的那
 * 一组:成员映到当前行、映不过去的丢掉之后才数,与组列表里那一组逐字对得上。
 */
export type StageRootCauseRef = {
  id: number;
  reason: string;
  memberCount: number;
  /** 组内次序,从 0 起,与落库的 `position` 同源。 */
  position: number;
};

/**
 * 阶段汇总里的一个同根因组(issue #309)。组属于轮次(ADR 0030),这里取的是这个阶段
 * 最新一轮的那一批;成员是当前列表里的那几行,已被更后轮次延续掉的沿延续链指向新位置。
 */
export type StageRootCauseGroup = {
  id: number;
  reason: string;
  findingIds: number[];
};

/**
 * 一个审查阶段的当前状态(issue #168)。三个计数与列表同一口径:待处置 + 人工已处置 +
 * 已修复 恰好等于列表长度,「已延续」两边都不占——计数的形状因此直接取行上那一格。
 */
export type StageSummary = {
  findings: StageSummaryFinding[];
  counts: StageListItem["counts"];
  timeline: StageTimelineEntry[];
  /** 最新一轮的同根因组(issue #309)。合并 agent 缺席的那一轮没有组,这里就是空数组。 */
  rootCauseGroups: StageRootCauseGroup[];
};
