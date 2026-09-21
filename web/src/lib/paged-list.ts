/**
 * 逐段渲染的渲染范围(issue #434)。阶段详情的 Finding 列表先渲染一段,滚到底再追加一段;
 * 而深链接指的那一项可能落在已渲染的那几段之外——不先把范围扩到包含它,它那张卡根本不在
 * DOM 里,「滚到它」那一步就永远不会发生,点进来看着像什么都没做。
 *
 * 抽成纯函数是为了让它被 `node --test` 跑到:这条规则只在长列表上才看得出来,手上那份几条
 * Finding 的样例首段就装得下全部条目,扩少一段与扩对了在那里没有区别。
 */

/**
 * 要渲染到第几项,才装得下下标为 `targetIndex` 的那一项。
 *
 * 目标已经在范围内(含 `targetIndex` 为 -1 的「没有目标」)就原样返回:范围只增不减,一次
 * 定位不该把滚出来的那几段缩回去。扩也按整段扩,与滚到底追加的步长同一个数。
 */
export function renderedCovering(rendered: number, targetIndex: number, chunk: number): number {
  if (targetIndex < rendered) return rendered;
  return Math.ceil((targetIndex + 1) / chunk) * chunk;
}
