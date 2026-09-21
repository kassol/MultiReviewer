/**
 * 超大 Review Range 按文件切成多批。分批只切"要审的改动",工作副本始终是完整的
 * head commit 状态,因此 Reviewer 仍能读到其他批次改动后的代码。
 */
import type { ReviewerOutcome } from "./finding.ts";
import { sumUsage } from "./store.ts";

/**
 * 一批最多多少改动行。规模按增删行数而非文件数衡量:50 个各改 2 行的文件不该被
 * 切碎,3 个各改 800 行的文件才该切。
 */
export const DEFAULT_MAX_CHANGED_LINES_PER_BATCH = 2000;

/**
 * 一批最多多少个文件(issue #230)。改动行数装得下不等于审得动:一批塞进上百个文件时
 * 每个文件平均摊不到一次 read,模型只能扫过去。
 */
export const DEFAULT_MAX_FILES_PER_BATCH = 40;

/** 一轮 Review Run 里同时在跑的批次数上限(issue #230)。 */
export const DEFAULT_MAX_PARALLEL_BATCHES = 3;

/**
 * 按每个文件的改动行数与文件数双重装箱,任一超限即封箱。同一文件的改动绝不跨批,跨批
 * 因此不会出现指向同一处的 Finding。
 *
 * 单个文件本身就超过改动行阈值时它自成一批:超大 Review Range 要被完整审查,不因切不开
 * 而拒审或截断。文件顺序保持原样,同一目录下的文件因此倾向于落在同一批。
 */
export function splitIntoBatches(
  files: readonly string[],
  changedLines: ReadonlyMap<string, number>,
  maxChangedLines: number,
  maxFiles: number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLines = 0;

  for (const file of files) {
    // 二进制文件与纯重命名在 diff 里没有改动行,不占预算。
    const lines = changedLines.get(file) ?? 0;
    if (
      current.length > 0 &&
      (currentLines + lines > maxChangedLines || current.length >= maxFiles)
    ) {
      batches.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(file);
    currentLines += lines;
  }

  // 末批可能为空(本次没有可审的文件),批数因此恒不为零。
  batches.push(current);
  return batches;
}

/**
 * 一个 Reviewer 跑一批的结果、这一批的开始时刻与耗时。批次受限并行之后各批的时间区间
 * 会重叠(issue #232),合并要算墙上时间,只有耗时算不出来。
 */
export type TimedOutcome = { outcome: ReviewerOutcome; startedAt: number; durationMs: number };

/**
 * 若干时间区间的并集长度(issue #415、#422)。批次受限并行(issue #232)下各批的区间会
 * 重叠,相加会把重叠的那段数两遍;续跑轮次里崩溃前那几批的区间来自上一个进程,首个开始到
 * 末个结束那样算又会把两次进程之间的停机计进去——停机那一段没有任何一批盖着它,并集因此
 * 自然不计,重叠的仍只算一次。单模型耗时与轮次级耗时用的是同一份。空列表即 0。
 */
export function spanUnionMs(
  spans: readonly { startedAt: number; durationMs: number }[],
): number {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
  const first = sorted[0];
  if (first === undefined) return 0;
  let total = 0;
  let openedAt = first.startedAt;
  let closedAt = first.startedAt;
  for (const span of sorted) {
    // 与当前这一段接不上就先结算它,新开一段。
    if (span.startedAt > closedAt) {
      total += closedAt - openedAt;
      openedAt = span.startedAt;
    }
    closedAt = Math.max(closedAt, span.startedAt + span.durationMs);
  }
  return total + closedAt - openedAt;
}

/**
 * 把同一个模型在各批次的结果合并成一个。入参按批次序号排,与各批的完成顺序无关
 * (issue #232):失败记的第几批、复核结论谁作数都按这个序。
 *
 * 全部批次都失败才算该模型缺席,其 Finding 一并丢弃;部分批次失败时保留成功批次的
 * Finding——每批是独立的文件集合,成功批次的结果自身是完整的,丢掉等于白花已付出的
 * 成本,只需在 review 正文里标注该模型覆盖不全。
 *
 * 失败批次的产出一律不要,Finding 与复核结论同一口径(issue #420):整体失败的模型一条
 * 结论都不记(`verdictRecords` 按 `failure` 滤掉它),失败批次的 Finding 丢弃,失败批次在
 * 倒下之前给出的结论因此也丢弃——一批跑到一半 429 的模型,它已经给的那几条不该一边作自动
 * 处置与延续的证据、一边让同一批的 Finding 作废。丢掉之后那几条历史落进「批次没跑成」
 * (`verdictRecords` 的 `batch-failed`),时间线上数得出来。
 */
export function mergeBatchOutcomes(results: readonly TimedOutcome[]): TimedOutcome {
  const first = results[0]!;
  // 未分批时原样返回:失败原因不该被套上"第 1 批"的壳子。
  if (results.length === 1) return first;

  const failures = results.flatMap(({ outcome }, index) =>
    outcome.failure === undefined
      ? []
      : [{ batchIndex: index + 1, failure: outcome.failure }],
  );
  const succeeded = results.filter((r) => r.outcome.failure === undefined);
  const usage = sumUsage(results.map((r) => r.outcome));

  const outcome: ReviewerOutcome = {
    model: first.outcome.model,
    // 失败批次报出的 Finding 一律丢弃,与整体失败的口径一致。
    findings: succeeded.flatMap((r) => r.outcome.findings),
    anomalies: results.flatMap((r) => r.outcome.anomalies),
    rejectedToolCalls: results.reduce((n, r) => n + r.outcome.rejectedToolCalls, 0),
    anchorRejections: results.reduce((n, r) => n + r.outcome.anchorRejections, 0),
    // 历史按所在文件路由到批次(issue #235):一条历史只进一批,也就只有一批给得出它的
    // 结论,合并因此只做拼接——没有「哪一批作数」这回事。失败批次的那些与它的 Finding
    // 同批丢弃(issue #420)。
    verdicts: succeeded.flatMap((r) => r.outcome.verdicts ?? []),
    // 一批都没回报用量时保持"取不到",不伪造出一行零用量。
    ...(usage === undefined ? {} : { usage }),
  };

  if (failures.length === results.length) {
    outcome.failure = failures
      .map((f) => `第 ${f.batchIndex} 批:${f.failure}`)
      .join(";");
  } else if (failures.length > 0) {
    outcome.incompleteCoverage = { batchCount: results.length, failures };
  }

  // 耗时取各批时间区间的并集长度(issue #415),理由见 `spanUnionMs`。
  return {
    outcome,
    startedAt: Math.min(...results.map((r) => r.startedAt)),
    durationMs: spanUnionMs(results),
  };
}
