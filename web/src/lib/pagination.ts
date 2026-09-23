/**
 * 页码条上要画的格子。首末页与当前页左右各一页总在,其余折成一个省略号;
 * 省略号只替掉两页以上的空隙——只隔一页时直接画那一页,比「…」还省地方。
 * `current` 从 0 起,返回的页码也从 0 起。
 */
export function pageItems(current: number, count: number): (number | "gap")[] {
  const shown = new Set([0, count - 1, current - 1, current, current + 1]);
  const pages = [...shown].filter((page) => page >= 0 && page < count).sort((a, b) => a - b);
  const items: (number | "gap")[] = [];
  for (const page of pages) {
    const last = items.at(-1);
    if (typeof last === "number" && page - last === 2) items.push(page - 1);
    else if (typeof last === "number" && page - last > 2) items.push("gap");
    items.push(page);
  }
  return items;
}
