import { customType } from "drizzle-orm/pg-core";

/**
 * 时刻列(ADR 0036):库里是 `timestamptz`,JS 侧仍是 ISO 字符串。
 *
 * 换成原生时间类型是为了让排序、区间过滤与 `MAX()` 按真正的时间走,而不是靠 ISO 字符串
 * 的字典序碰巧对上。JS 侧不跟着换成 `Date`:全项目写入侧一律 `new Date().toISOString()`,
 * 读出来的值要进 JSON 响应、进 prompt、进比较,换成 `Date` 会把三百多处调用点全牵动一遍。
 *
 * Drizzle 给自己发出的每一条查询都装了一份读取解析器,把时刻原样交到这里,`store/pg.ts`
 * 那份全局解析器在它的查询上不生效(实测见那里)。ISO 因此由这一列的 `fromDriver` 给出。
 */
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => toIso(value),
  toDriver: (value) => value,
});

/**
 * PostgreSQL 的时刻原文换成 ISO。默认 DateStyle 下它长这样:`2026-09-22 03:35:51.705+00`
 * ——空格分日期与时间,时区只有两位,两处都不是合法的 ISO。已经是 ISO 的原样返回。
 *
 * 走 `orm.execute` 的原始查询也要过这一道,那一侧由 `store/shared.ts` 的 `isoTime` 接。
 */
export function toIso(value: string): string {
  if (value.endsWith("Z")) return value;
  const spaced = value.replace(" ", "T");
  const normalized = /[+-]\d\d$/.test(spaced) ? `${spaced}:00` : spaced;
  return new Date(normalized).toISOString();
}

/**
 * JSON 列(ADR 0036):库里是 `jsonb`,JS 侧仍是 JSON 文本。
 *
 * 换成 `jsonb` 是为了让 SQL 里查得动内容(`->>`、`jsonb_array_elements`)。JS 侧仍收发
 * 文本,因为读写两侧全是 `JSON.parse` / `JSON.stringify`,而且原始文本要原样进 prompt
 * 与响应。
 *
 * 同 `isoTimestamp`:`store/pg.ts` 给 `jsonb` 装了「读成原文」的解析器,两头因此都是恒等。
 */
export const jsonText = customType<{ data: string; driverData: string }>({
  dataType: () => "jsonb",
  fromDriver: (value) => value,
  toDriver: (value) => value,
});
