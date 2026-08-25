/*
 * 本地时区的时间格式化,全站只有这一份。分天与时分一律按浏览器本地时区:UTC 日在
 * 东八区会把 16:00 之后的时刻归到前一天。不用 `toLocaleString()`——它给的是
 * `8/14/2026, 6:25:21 PM`,与全站的 ISO 风格对不上。
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localClock(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 「年-月-日 时:分」一整串。日期与时分同时要显示的地方用它。 */
export function localMinute(iso: string): string {
  return `${localDay(iso)} ${localClock(iso)}`;
}
