/*
 * 轨迹事件 payload 的读取守卫,审查轨迹与知识轨迹共用。payload 是
 * `Record<string, unknown>`:每个字段读之前先验一次形状,后端改了字段名或类型时那一格
 * 显示成缺失,而不是让整个面板白屏。
 */

export function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 轨迹里的一条失败 / 丢弃原因,去空白之后再判空(issue #443)。`str()` 只挡得住恰好是
 * `""` 的那一种,升级前落的行与个别写入路径给的可能是只有空白的字符串,不 trim 就会显示
 * 成一段看不见的空白,而不是回落成「未记录原因」。
 */
export function reason(payload: Record<string, unknown>, key: string): string {
  return str(payload, key)?.trim() || "未记录原因";
}
