/**
 * 阶段汇总的轮次筛选(issue #369):每天一轮地跑下去,列表只会变长,而看的人昨天已经
 * 看过一遍。「首次报出在第 N 轮或之后」就是「这几天新出的」,选项、编号与判据收在一处,
 * 筛出来的那批与 Finding 卡上写的「第 N 轮首次报出」永远是同一个口径。
 */
import { localDay } from "./time.ts";

/** 时间线上一轮里这个筛选用到的那几格,与 `StageTimelineEntry` 逐字同名。 */
export type StageRound = {
  runId: number;
  startedAt: string;
  /** 本轮新报出,写进选项文案的「新增 M」。 */
  reported: number;
};

/** runId → 这个阶段自己数的第几轮:一条 Finding「第几轮首次报出」比一个库 id 有意义。 */
export function roundNumbers(entries: readonly { runId: number }[]): Map<number, number> {
  return new Map(entries.map((entry, index) => [entry.runId, index + 1]));
}

/**
 * 轮次筛选的选项,新到旧——要找的是最近那几轮,它们排在最前面。本轮一条没新报的那一轮
 * 照样列出来:少一行会让人以为那一天没跑。
 */
export function roundFilterOptions(
  entries: readonly StageRound[],
): { value: string; label: string }[] {
  return entries
    .map((entry, index) => ({
      value: String(index + 1),
      label: `第 ${index + 1} 轮 · ${localDay(entry.startedAt)} · 新增 ${entry.reported}`,
    }))
    .reverse();
}

/**
 * 这条 Finding 的首次报出是否落在选中的那一轮或之后。判据取首次报出那一轮,重报与延续
 * 都不改它:已经看过的那条再报一次仍然不是「新出的」。
 *
 * 首次报出那一轮不在时间线上(不该发生)时,「全部轮次」留着它,选定某一轮一律筛掉——
 * 它排在第几轮都答不上来,更答不上来「是不是第 N 轮之后的」。
 */
export function firstReportedFrom(
  round: string,
  firstRunId: number,
  rounds: ReadonlyMap<number, number>,
): boolean {
  if (round === "all") return true;
  const first = rounds.get(firstRunId);
  return first !== undefined && first >= Number(round);
}
