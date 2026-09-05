/**
 * 用代码片段核对 Finding 的行号,并判它是否落在本轮 diff 的 hunk 内。
 *
 * 模型报的行号不可信,报的代码原文可信——它是从 read 输出里抄的。这里以 snippet
 * 为准校正行号:对得上放行,对不上但能在文件里找到就改成找到的行,找不到整条
 * 打回让模型重报。pr-agent 的 `find_line_number_of_relevant_line_in_file` 是同一
 * 思路,它用 difflib 模糊匹配,这里用 trim 后全等——报出来的行连内容都对不上时,
 * 该打回而非硬猜。
 *
 * 校正之后再判 hunk 成员资格(issue #224):落点必须是本轮改动过的行,否则这条
 * Finding 没有行级评论可挂,也就没有 resolve 载体、不进处置率。取证的阅读半径不受
 * 此限——模型照样可以读全仓库,只是结论要报在变更侧因果末端。
 */
import { isInDiff, type DiffRanges } from "../review/position.ts";

export type AnchorResult =
  | { ok: true; line: number; corrected: boolean }
  | { ok: false; reason: string };

/** `lines` 是文件按 `\n` 切开的行数组,`line` 是模型报的 1-indexed 行号。 */
export function anchorFinding(lines: string[], line: number, snippet: string): AnchorResult {
  const wanted = snippet.trim();
  if (wanted === "") {
    return { ok: false, reason: "snippet 是空白。抄下问题起始行的原文再报一次。" };
  }

  if (line >= 1 && line <= lines.length && lines[line - 1]!.trim() === wanted) {
    return { ok: true, line, corrected: false };
  }

  // ponytail: 多个候选取离报告行最近的——`}` 这类低区分度行可能选错,靠 prompt
  // 要求抄"问题起始行"(通常有实义)压住;误锚仍多时改为要求 snippet 唯一匹配。
  let best: number | undefined;
  for (let n = 1; n <= lines.length; n += 1) {
    if (lines[n - 1]!.trim() !== wanted) continue;
    if (best === undefined || Math.abs(n - line) < Math.abs(best - line)) best = n;
  }
  if (best !== undefined) return { ok: true, line: best, corrected: true };

  const actual = line >= 1 && line <= lines.length ? lines[line - 1]! : undefined;
  return {
    ok: false,
    reason:
      actual === undefined
        ? `文件一共 ${lines.length} 行,没有第 ${line} 行,snippet 也不在文件里。`
        : `第 ${line} 行的内容是 \`${actual.trim()}\`,与 snippet 对不上,文件里也没有这段内容。`,
  };
}

export type ReportResult =
  | { ok: true; line: number }
  | { ok: false; message: string };

/**
 * 落点在本轮 diff 之外时给模型的那句话,没落在外面即 undefined。
 *
 * 只说「换个行号」不够:模型报到变更之外,多半是它顺着调用链走到了根因所在的旧代码。
 * 因此指引说的是往回走——把结论报在这次改动里、依赖那处根因的那一行。
 */
function outsideDiff(ranges: DiffRanges, file: string, line: number): string | undefined {
  if (isInDiff(ranges, file, line)) return undefined;
  return `${file}:${line} is outside the diff under review. Anchor the finding on a line this change actually touches — the end of the causal chain on the changed side. When the root cause sits in unchanged code, report the changed line that depends on it and explain the cause there.`;
}

/**
 * `report_finding` 一次调用的锚定判定,`message` 是打回时给模型的措辞。
 *
 * 三种成因归到同一个结果里:`lines` 为 undefined 是文件读不出来,锚定不上是 snippet
 * 对不上,落在 diff 之外是位置报到了变更之外。它们都是"模型报的位置不可信"这一个信号,
 * 调用方据此记一个计数——分成几个数得不出新的动作,该换模型还是该改 prompt 看的都是
 * 这个总数。
 */
export function anchorReport(
  lines: string[] | undefined,
  ranges: DiffRanges,
  raw: { file: string; line: number; snippet: string },
): ReportResult {
  if (lines === undefined) {
    return {
      ok: false,
      message: `NOT recorded: cannot read ${raw.file}. Check the path and report again.`,
    };
  }
  const anchored = anchorFinding(lines, raw.line, raw.snippet);
  if (!anchored.ok) {
    return {
      ok: false,
      message: `NOT recorded: ${anchored.reason} Re-read the file and report again with the line number copied from the read output.`,
    };
  }
  // 判的是校正后的行:模型把行号抄偏而 snippet 指向 hunk 内时,这条本来就该收下。
  const outside = outsideDiff(ranges, raw.file, anchored.line);
  if (outside !== undefined) return { ok: false, message: `NOT recorded: ${outside}` };
  return { ok: true, line: anchored.line };
}

/**
 * `review_prior_finding` 带新位置那一次调用的锚定判定,`message` 是打回时给模型的措辞。
 *
 * 与 `anchorReport` 同一道核对,区别只在打回的范围:结论本身照收,打回丢掉的只是这个
 * 新位置。打回同样是"模型报的位置不可信",调用方与 `report_finding` 记同一个数
 * (issue #187)——模型一直把新位置抄错时,延续一直触发不了,线上看起来却像模型
 * 根本没给过位置。
 */
export function anchorVerdict(
  lines: string[] | undefined,
  ranges: DiffRanges,
  raw: { file: string; line: number; snippet: string },
): ReportResult {
  const anchored =
    lines === undefined
      ? { ok: false as const, reason: `读不出 ${raw.file}。` }
      : anchorFinding(lines, raw.line, raw.snippet);
  if (!anchored.ok) {
    return {
      ok: false,
      message: `verdict recorded, new line NOT recorded: ${anchored.reason} Re-read ${raw.file} and call again with the line number copied from the read output.`,
    };
  }
  // 延续过去的新位置同样要有行级评论承载,判据与 `report_finding` 那一道是同一个。
  const outside = outsideDiff(ranges, raw.file, anchored.line);
  if (outside !== undefined) {
    return { ok: false, message: `verdict recorded, new line NOT recorded: ${outside}` };
  }
  return { ok: true, line: anchored.line };
}
