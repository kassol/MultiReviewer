/**
 * 一条 Finding 复制给外部 AI 的简报(评审记录 → 阶段详情 → Finding 条目上的「复制给 AI」)。
 *
 * 对面拿到的是一段要拿去改代码的输入,不是面板的另一份排版:只留定位的事实
 * (commit 与文件行)和三段要解决的内容(问题、影响、建议)。仓库名、轮次、处置状态、
 * 同根因、处置备注与末尾的叮嘱都不写——前几样开发者和他的 AI 本来就知道,后几样
 * 不增加「改哪、改什么」的信息,只会把真正要读的几行挤走。
 *
 * 行号属于 `placedRunId` 那一轮的 head,所以 commit 必须写明:用户此刻检出的代码
 * 可能已经往前走了,AI 对不上时要能按这个 hash 取。
 *
 * 取的是阶段汇总里那一条(`StageSummaryFinding`),不是轮次里那一行:面板上的列表与侧滑
 * 用的都是它,两处复制出来的东西必须一样。
 */
import type { StageSummaryFinding } from "../../../src/contracts/stage-summary.ts";

/** 简报里能补上的那一格场景信息。取不到时整行不写。 */
export type FindingBriefContext = {
  /** 这条位置所属那一轮的 head commit,完整 sha。 */
  headSha?: string;
};

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
  const title = finding.title.trim();
  const description = finding.description.trim();
  const impact = finding.impact?.trim() ?? "";
  const suggestion = finding.suggestion?.trim() ?? "";
  const alternatives = suggestion === "" ? fallbackSuggestions(finding) : [];

  const lines: string[] = [
    ...(context.headSha === undefined ? [] : [`commit: ${context.headSha}`]),
    `file: ${finding.file}:${finding.line}`,
    "",
    // 标题是问题的一句概括,没有标题时正文那一句就是概括;两者不重复写。
    `问题（${finding.severity} · ${finding.category}）：${title === "" ? description : title}`,
  ];
  if (title !== "" && description !== "") lines.push("", description);
  if (impact !== "") lines.push("", `影响：${impact}`);
  if (suggestion !== "") {
    lines.push("", `建议：${suggestion}`);
  } else if (alternatives.length > 0) {
    lines.push("", "建议：", ...alternatives);
  }
  return lines.join("\n");
}

/**
 * 从阶段汇总的时间线取这条 Finding 的简报上下文:那一轮的 head。列表与侧滑各算一次,
 * 判据只有这一份。
 */
export function briefContextOf(
  finding: Pick<StageSummaryFinding, "placedRunId">,
  headOf: ReadonlyMap<number, string>,
): FindingBriefContext {
  const headSha = headOf.get(finding.placedRunId);
  return headSha === undefined ? {} : { headSha };
}
