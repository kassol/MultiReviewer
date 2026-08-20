export type CostUsage = {
  costUsd: number | null;
  knownCostUsd: number;
  costIncomplete: boolean;
  unknownCostReviewers: number;
};

export type UsageSummary = CostUsage & {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costSource: "trusted" | "unknown" | "legacy" | "mixed";
};

export type CostPresentation = { amount: string; note: string | null };

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Product cost wording shared by the Review Run and disposition-rate surfaces. */
export function costPresentation(
  usage: CostUsage | null | undefined,
): CostPresentation {
  if (usage === null || usage === undefined) {
    return { amount: "费用未记录", note: null };
  }
  if (
    !usage.costIncomplete &&
    usage.costUsd !== null &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
  ) {
    return { amount: usd(usage.costUsd), note: null };
  }

  const knownCostUsd =
    Number.isFinite(usage.knownCostUsd) && usage.knownCostUsd >= 0
      ? usage.knownCostUsd
      : 0;
  return {
    amount: `已知小计 ${usd(knownCostUsd)}`,
    note:
      usage.unknownCostReviewers > 0
        ? `${usage.unknownCostReviewers} 个 Reviewer 费用未知`
        : "费用未知",
  };
}
