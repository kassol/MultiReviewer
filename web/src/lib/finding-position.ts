/**
 * 一条 Finding 的当前位置属于哪一轮(CONTEXT.md Finding,issue #368)。
 *
 * 行号只有对着算出它的那个 head 才成立:代码差异侧滑因此画 `lastRunId` 那一轮的 diff,
 * 而不是这个阶段最新一轮的。那一轮不是最新一轮时侧滑要说出来——不说的话读者看到的是
 * 「行号漂了」,而不是「这一处的代码差异停在更早的那个 commit 上」。
 */
import { roundNumbers } from "./stage-rounds.ts";

/** 侧滑要画哪一轮的 diff,以及要不要标「已过期」。 */
export type FindingDiffSource = {
  runId: number;
  /**
   * 位置落在更早那一轮时的标记:那一轮在这个阶段时间线里排第几(从 1 起,与阶段页
   * 其余处的轮次编号同一套)、它的 head commit。位置就在最新一轮上时为 null,不标。
   */
  stale: { round: number; headSha: string } | null;
};

/**
 * 时间线按轮次先后排,最后一项就是这个阶段最新的那一轮。一轮都还没跑过、或者这条
 * Finding 已经不在这个阶段的汇总里时给不出 diff 来源,返回 null,由调用方摆空状态。
 */
export function findingDiffSource(
  lastRunId: number,
  timeline: readonly { runId: number; headSha: string }[],
): FindingDiffSource | null {
  const index = timeline.findIndex((entry) => entry.runId === lastRunId);
  if (index === -1) return null;
  return {
    runId: lastRunId,
    stale:
      index === timeline.length - 1
        ? null
        : { round: roundNumbers(timeline).get(lastRunId)!, headSha: timeline[index]!.headSha },
  };
}
