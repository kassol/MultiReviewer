/*
 * 轨迹事件 payload 的读取守卫,审查轨迹与规则轨迹共用。payload 是
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
