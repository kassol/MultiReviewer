/**
 * 一条 Finding 复制给外部 AI 的简报(评审记录 → 阶段详情 → Finding 条目上的「复制给 AI」)。
 *
 * 面板上的一条散在卡片的几处:位置与状态在卡头,问题、影响、建议在正文,同根因与处置
 * 备注在右边一栏。复制出去的那一份要能独立读懂——对方手上没有这个面板,也不认识这里的
 * 术语与上下文,所以先给能定位到代码的那几格(仓库、文件与行、位置属于哪一轮与哪个
 * commit、等级、分类、状态),再给三段正文,最后一句说明要它先读代码确认再动手。
 *
 * 行号属于 `placedRunId` 那一轮的 head,不一定等于用户此刻检出的代码:带上轮次与短 sha,
 * AI 才知道自己看的是哪一版,对不上时能按 commit 取。同根因有才写:这次修复可能不止一处。
 * 处置备注有才写——它是人留下的「为什么不用改」,正是 AI 研判时最该知道的反对意见。
 *
 * 取的是阶段汇总里那一条(`StageSummaryFinding`),不是轮次里那一行:面板上的列表与侧滑
 * 用的都是它,两处复制出来的东西必须一样。
 */
import type { StageSummaryFinding } from "../../../src/contracts/stage-summary.ts";

/** 简报里能补上的那部分场景信息。列表与侧滑手上都有时间线,取不到时整项不写。 */
export type FindingBriefContext = {
  /** 这条 Finding 所属仓库,`owner/repo`。 */
  repo?: string;
  /** 这条位置属于第几轮(1 起),与卡头写的「第 N 轮」同一套编号。 */
  round?: number;
  /** 那一轮的 head commit,完整 sha。 */
  headSha?: string;
};

/** 处置状态的说法,与列表里的三档一一对应:待处置 / 人工已处置 / 已修复。 */
const DISPOSITION_TEXT: Record<StageSummaryFinding["disposition"], string> = {
  unknown: "待处置",
  unresolved: "待处置",
  resolved: "人工已处置",
  fixed: "已修复（自动处置）",
};

/** 一段正文:空白或空串整段不写,不留一个只有标题的空节。 */
function section(title: string, body: string | null): string[] {
  if (body === null || body.trim() === "") return [];
  return [`## ${title}`, "", body.trim(), ""];
}

/**
 * 位置那一格的括号:第几轮与短 sha 有什么写什么。行号只对它所属的那一轮成立,读到简报
 * 的人得知道这一点;两样都取不到时整格不写。
 */
function positionNote(context: FindingBriefContext): string {
  const parts = [
    ...(context.round === undefined ? [] : [`第 ${context.round} 轮`]),
    ...(context.headSha === undefined ? [] : [context.headSha.slice(0, 7)]),
  ];
  return parts.length === 0 ? "" : `（${parts.join(" · ")}）`;
}

/**
 * 代表段没给建议时,退回各模型自己的建议:几个模型看同一处,论证最长的那个未必给了
 * 修法,而另一个给了。逐条署上模型名;沿用自更早轮次的说法另标一句未经新代码验证。
 */
function fallbackSuggestions(finding: StageSummaryFinding): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (model: string, suggestion: string | null, caveat: string): void => {
    const text = suggestion?.trim() ?? "";
    if (text === "" || seen.has(text)) return;
    seen.add(text);
    lines.push(`- ${model}${caveat}：${text}`);
  };
  for (const said of finding.attributions) add(said.model, said.suggestion, "");
  for (const said of finding.carried) {
    add(said.model, said.suggestion, "（沿用更早轮次，尚未针对最新代码重新验证）");
  }
  return lines;
}

export function findingBrief(finding: StageSummaryFinding, context: FindingBriefContext = {}): string {
  const suggestion = finding.suggestion?.trim() ?? "";
  const alternatives = suggestion === "" ? fallbackSuggestions(finding) : [];
  const hasSuggestion = suggestion !== "" || alternatives.length > 0;

  const lines: string[] = [
    `# 代码审查 Finding #${finding.id}（${finding.severity} · ${finding.category}）`,
    "",
    ...(context.repo === undefined ? [] : [`- 仓库：${context.repo}`]),
    `- 位置：\`${finding.file}:${finding.line}\`${positionNote(context)}`,
    `- 状态：${DISPOSITION_TEXT[finding.disposition]}`,
  ];
  if (finding.rootCause !== null) {
    lines.push(`- 同根因：${finding.rootCause.reason}（本组 ${finding.rootCause.memberCount} 处）`);
  }
  lines.push("");

  // 标题并进问题那一节:单给一个「标题」小标题会让问题读成两句,而标题本来就是问题的
  // 一句概括,没有标题时这一段只剩正文。
  lines.push(
    ...section(
      "问题",
      [
        ...(finding.title.trim() === "" ? [] : [`**${finding.title.trim()}**`, ""]),
        finding.description.trim(),
      ].join("\n"),
    ),
  );
  lines.push(...section("影响", finding.impact));
  if (suggestion !== "") {
    lines.push(...section("建议", suggestion));
  } else if (alternatives.length > 0) {
    lines.push("## 建议", "", ...alternatives, "");
  }
  lines.push(...section("处置备注", finding.note));
  lines.push(
    "---",
    "",
    hasSuggestion
      ? `请先读 \`${finding.file}\` 第 ${finding.line} 行附近的代码，确认问题是否成立；成立则按上面的建议修复，不成立则说明原因。`
      : `请先读 \`${finding.file}\` 第 ${finding.line} 行附近的代码，确认问题是否成立；成立则给出修复方案并改掉，不成立则说明原因。`,
  );
  return lines.join("\n");
}

/**
 * 从阶段汇总的时间线取这条 Finding 的简报上下文:第几轮与那一轮的 head。列表与侧滑
 * 各算一次,判据只有这一份。
 */
export function briefContextOf(
  finding: Pick<StageSummaryFinding, "placedRunId">,
  roundOf: ReadonlyMap<number, number>,
  headOf: ReadonlyMap<number, string>,
  repo: string | undefined,
): FindingBriefContext {
  const round = roundOf.get(finding.placedRunId);
  const headSha = headOf.get(finding.placedRunId);
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(round === undefined ? {} : { round }),
    ...(headSha === undefined ? {} : { headSha }),
  };
}
