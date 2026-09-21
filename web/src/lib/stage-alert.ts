/**
 * 阶段行上那枚「最新一轮没跑全」警示的文案(issue #421、#424)。
 *
 * 三档可以任意组合,逐个组合硬编码就是七句话。这里拆成两段拼:两档「没跑成」并成一句
 * (它们问的是同一件事——谁没跑),收尾失败自成一句。加一档只多一个分句,不多一句话。
 */

/** 与服务端 `StageRunAlert` 逐字对应(`GET /stages` 行上的 `latestRunAlert`)。 */
export type StageRunAlert = {
  modelFailed: boolean;
  batchFailed: boolean;
  /** 非空即没有正常收尾,内容是失败原因的第一行。 */
  closingFailure: string | null;
};

/**
 * 徽章上看得见的那句话。三档都在这里说得出来:title 触屏上看不到、读屏也不一定读,
 * 另一档不能只写在 title 上(issue #374)。
 */
export function stageAlertText(alert: StageRunAlert): string {
  const notRun = [alert.modelFailed ? "模型" : null, alert.batchFailed ? "批次" : null].filter(
    (part) => part !== null,
  );
  const clauses = [
    notRun.length === 0 ? null : `有${notRun.join("与")}没跑成`,
    alert.closingFailure === null ? null : "没有正常收尾",
  ].filter((clause) => clause !== null);
  return `上一轮${clauses.join("，")}`;
}

/** 悬停看得到的整句:每一档各自说清后果,收尾失败那一档带上原因第一行。 */
export function stageAlertDetail(alert: StageRunAlert): string {
  return [
    alert.modelFailed ? "有模型整轮没跑成，这一轮少了它的结论。" : null,
    alert.batchFailed ? "有模型的部分批次没跑成，那几批文件上的历史这一轮少了它的复核。" : null,
    alert.closingFailure === null
      ? null
      : `这一轮没有正常收尾，结论可能没能落到 Forge 上：${alert.closingFailure}`,
  ]
    .filter((line) => line !== null)
    .join("");
}
