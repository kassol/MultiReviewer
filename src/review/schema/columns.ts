import { customType } from "drizzle-orm/pg-core";

/**
 * 时刻列(ADR 0036):库里是 `timestamptz`,JS 侧仍是 ISO 字符串。
 *
 * 换成原生时间类型是为了让排序、区间过滤与 `MAX()` 按真正的时间走,而不是靠 ISO 字符串
 * 的字典序碰巧对上。JS 侧不跟着换成 `Date`:全项目写入侧一律 `new Date().toISOString()`,
 * 读出来的值要进 JSON 响应、进 prompt、进比较,换成 `Date` 会把三百多处调用点全牵动一遍。
 *
 * 两头都是恒等函数,因为 `store/pg.ts` 已经给 `timestamptz` 装了全局读取解析器:驱动交上来
 * 的就是 ISO 字符串。写入侧把 ISO 字符串原样交给 PostgreSQL 解析。
 */
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => value,
  toDriver: (value) => value,
});

/**
 * JSON 列(ADR 0036):库里是 `jsonb`,JS 侧仍是 JSON 文本。
 *
 * 换成 `jsonb` 是为了让 SQL 里查得动内容(`->>`、`jsonb_array_elements`),原先那些
 * `json_extract` 是 SQLite 专属写法。JS 侧仍收发文本,因为读写两侧全是
 * `JSON.parse` / `JSON.stringify`,而且原始文本要原样进 prompt 与响应。
 *
 * 同 `isoTimestamp`:`store/pg.ts` 给 `jsonb` 装了「读成原文」的解析器,两头因此都是恒等。
 */
export const jsonText = customType<{ data: string; driverData: string }>({
  dataType: () => "jsonb",
  fromDriver: (value) => value,
  toDriver: (value) => value,
});
