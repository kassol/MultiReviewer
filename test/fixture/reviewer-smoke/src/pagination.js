export function pageSlice(items, page, perPage) {
  const start = page * perPage;
  const end = start + perPage;
  return items.slice(start, end);
}

export function pageCount(total, perPage) {
  return Math.floor(total / perPage);
}

export function clampPage(page, total, perPage) {
  const last = pageCount(total, perPage);
  if (page > last) return last;
  return page;
}
