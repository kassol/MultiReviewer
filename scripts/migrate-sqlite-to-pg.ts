/**
 * 存量搬迁:把旧的 SQLite 库按新 schema 写进 PostgreSQL(ADR 0036,issue #457)。
 *
 * 一次性脚本,搬完即删(issue #458)。跑在镜像里:
 *
 *   node scripts/migrate-sqlite-to-pg.ts /data/multireviewer.db postgres://…/multireviewer
 *
 * 表、列与列类型全部从 `src/review/schema/` 现问一遍,不另抄一张对照表——抄一份迟早与
 * schema 漂开。两边的表名与列名逐字相同(新 schema 是照着旧那份 SQLite DDL 翻的),要转的
 * 只有列类型:ISO 字符串 → `timestamptz`、0/1 → `boolean`、JSON 文本 → `jsonb`。前两样与
 * JSON 那样由 `schema/columns.ts` 的自定义列类型接住(两头都是恒等,PostgreSQL 自己认 ISO
 * 文本与 JSON 文本),真正要动手的只有布尔。
 *
 * 整笔是一个事务:逐表行数对不上就回滚,目标库保持空。
 */
import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import pg from "pg";

import * as schema from "../src/review/schema/index.ts";

/** 一次 INSERT 带多少行。PostgreSQL 的参数上限是 65535,列最多的表也塞得下这个数。 */
const CHUNK = 500;

type TableCount = { table: string; source: number; target: number };

export type MigrationReport = {
  counts: readonly TableCount[];
  /** 逐表行数全部相等。false 时整笔已回滚。 */
  ok: boolean;
};

function allTables(): PgTable[] {
  const values: unknown[] = Object.values(schema);
  return values.filter(
    (value) =>
      typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value,
  ) as PgTable[];
}

/**
 * 按外键依赖排插入序:被引用的表先插。外键没声明成 deferrable,只能靠顺序。
 * 自引用(产品知识条目的 `superseded_by`)排不出来,由 `selfColumns` 那一路补。
 */
function insertionOrder(tables: readonly PgTable[]): PgTable[] {
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  const deps = new Map<string, Set<string>>();
  for (const table of tables) {
    const config = getTableConfig(table);
    const names = config.foreignKeys
      .map((fk) => getTableConfig(fk.reference().foreignTable).name)
      .filter((name) => name !== config.name && byName.has(name));
    deps.set(config.name, new Set(names));
  }
  const ordered: PgTable[] = [];
  const done = new Set<string>();
  while (ordered.length < tables.length) {
    const next = [...deps].filter(
      ([name, on]) => !done.has(name) && [...on].every((dep) => done.has(dep)),
    );
    if (next.length === 0) {
      const left = [...deps.keys()].filter((name) => !done.has(name));
      throw new Error(`外键成环,排不出插入序:${left.join(", ")}`);
    }
    for (const [name] of next) {
      ordered.push(byName.get(name)!);
      done.add(name);
    }
  }
  return ordered;
}

/** 自引用的那几列:先插 NULL,整表插完再补回去。 */
function selfColumns(table: PgTable): string[] {
  const config = getTableConfig(table);
  return config.foreignKeys
    .filter((fk) => getTableConfig(fk.reference().foreignTable).name === config.name)
    .flatMap((fk) => fk.reference().columns.map((column) => column.name));
}

/** 一行 SQLite 行换成 Drizzle 的 values 对象。键是列在 schema 里的属性名,不是列名。 */
function toValues(
  row: Record<string, unknown>,
  columns: Record<string, { name: string; getSQLType(): string }>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [property, column] of Object.entries(columns)) {
    const value = row[column.name];
    // 旧库里没有这一列:整个不给,让 PostgreSQL 用列自己的默认值。
    if (value === undefined) continue;
    // 时刻与 JSON 两类由自定义列类型原样交给驱动,PostgreSQL 认 ISO 文本与 JSON 文本;
    // 布尔在 SQLite 里是 0/1,得自己翻。
    values[property] =
      column.getSQLType() === "boolean" && value !== null ? value !== 0 : value;
  }
  return values;
}

async function countRows(client: pg.Client, tables: readonly string[]): Promise<Map<string, number>> {
  const union = tables
    .map((name) => `SELECT '${name}' AS t, COUNT(*) AS n FROM "${name}"`)
    .join(" UNION ALL ");
  const { rows } = await client.query<{ t: string; n: string }>(union);
  return new Map(rows.map((row) => [row.t, Number(row.n)]));
}

/**
 * identity 列的序列推到最大 id 之后。原 id 是显式插进去的,序列还停在 1——不推的话下一次
 * 插入会撞上已有主键。
 */
async function advanceSequences(client: pg.Client, tables: readonly string[]): Promise<void> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND is_identity = 'YES'`,
  );
  for (const { table_name, column_name } of rows) {
    if (!tables.includes(table_name)) continue;
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence($1, $2),
         COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 0) + 1,
         false
       )`,
      [table_name, column_name],
    );
  }
}

export async function migrateLegacyDatabase(
  sqlitePath: string,
  databaseUrl: string,
): Promise<MigrationReport> {
  const legacy = new DatabaseSync(sqlitePath, { readOnly: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tables = insertionOrder(allTables());
    const names = tables.map((table) => getTableConfig(table).name);
    const orm = drizzle(client);
    await client.query("BEGIN");
    try {
      const before = await countRows(client, names);
      const occupied = [...before].filter(([, n]) => n > 0).map(([name]) => name);
      if (occupied.length > 0) {
        throw new Error(`目标库不是空的,先清空再搬:${occupied.join(", ")}`);
      }

      const source = new Map<string, number>();
      for (const table of tables) {
        const name = getTableConfig(table).name;
        const columns = getTableColumns(table) as Record<
          string,
          { name: string; getSQLType(): string }
        >;
        const rows = legacy.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
        source.set(name, rows.length);
        const deferred = selfColumns(table);
        const values = rows.map((row) => {
          const mapped = toValues(row, columns);
          for (const [property, column] of Object.entries(columns)) {
            if (deferred.includes(column.name)) mapped[property] = null;
          }
          return mapped;
        });
        for (let at = 0; at < values.length; at += CHUNK) {
          await orm.insert(table).values(values.slice(at, at + CHUNK));
        }
        await fillSelfReferences(client, name, deferred, rows);
      }

      await advanceSequences(client, names);

      const after = await countRows(client, names);
      const counts = names.map((name) => ({
        table: name,
        source: source.get(name) ?? 0,
        target: after.get(name) ?? 0,
      }));
      const ok = counts.every((row) => row.source === row.target);
      if (!ok) {
        await client.query("ROLLBACK");
        return { counts, ok };
      }
      await client.query("COMMIT");
      return { counts, ok };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
    legacy.close();
  }
}

/** 自引用那几列的补写。目标行这时已经全在了,一行一句 UPDATE。 */
async function fillSelfReferences(
  client: pg.Client,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (columns.length === 0) return;
  for (const row of rows) {
    const pending = columns.filter((column) => row[column] !== null && row[column] !== undefined);
    if (pending.length === 0) continue;
    const assignments = pending.map((column, at) => `"${column}" = $${at + 1}`).join(", ");
    await client.query(
      `UPDATE "${table}" SET ${assignments} WHERE id = $${pending.length + 1}`,
      [...pending.map((column) => row[column]), row["id"]],
    );
  }
}

async function main(): Promise<void> {
  const [sqlitePath, databaseUrl] = process.argv.slice(2);
  if (sqlitePath === undefined || databaseUrl === undefined) {
    console.error("用法:node scripts/migrate-sqlite-to-pg.ts <旧库路径> <目标连接串>");
    process.exit(2);
  }
  const report = await migrateLegacyDatabase(sqlitePath, databaseUrl);
  for (const { table, source, target } of report.counts) {
    console.log(`${source === target ? "  " : "!!"} ${table}: 源 ${source} → 目标 ${target}`);
  }
  if (!report.ok) {
    console.error("行数对不上,已回滚,目标库没有改动。");
    process.exit(1);
  }
  const total = report.counts.reduce((sum, row) => sum + row.target, 0);
  console.log(`搬完:${report.counts.length} 张表,${total} 行。`);
}

if (process.argv[1]?.endsWith("migrate-sqlite-to-pg.ts") === true) {
  await main();
}
