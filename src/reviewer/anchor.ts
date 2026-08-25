/**
 * 用代码片段核对 Finding 的行号。
 *
 * 模型报的行号不可信,报的代码原文可信——它是从 read 输出里抄的。这里以 snippet
 * 为准校正行号:对得上放行,对不上但能在文件里找到就改成找到的行,找不到整条
 * 打回让模型重报。pr-agent 的 `find_line_number_of_relevant_line_in_file` 是同一
 * 思路,它用 difflib 模糊匹配,这里用 trim 后全等——报出来的行连内容都对不上时,
 * 该打回而非硬猜。
 */

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
 * `report_finding` 一次调用的锚定判定,`message` 是打回时给模型的措辞。
 *
 * 两种成因归到同一个结果里:`lines` 为 undefined 是文件读不出来,锚定不上是 snippet
 * 对不上。它们都是"模型报的位置不可信"这一个信号,调用方据此记一个计数——分成两个数
 * 得不出新的动作,该换模型还是该改 prompt 看的都是这个总数。
 */
export function anchorReport(
  lines: string[] | undefined,
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
  raw: { file: string; line: number; snippet: string | undefined },
): ReportResult {
  const anchored =
    lines === undefined
      ? { ok: false as const, reason: `读不出 ${raw.file}。` }
      : anchorFinding(lines, raw.line, raw.snippet ?? "");
  if (!anchored.ok) {
    return {
      ok: false,
      message: `verdict recorded, new line NOT recorded: ${anchored.reason} Re-read ${raw.file} and call again with the line number copied from the read output.`,
    };
  }
  return { ok: true, line: anchored.line };
}
