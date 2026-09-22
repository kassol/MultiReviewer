import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import type * as schema from "../schema/index.ts";

const { Pool, types } = pg;

export type PgPool = pg.Pool;

/** Drizzle 的句柄。与 shim 共用同一条连接(事务里由 `activeClient` 决定是哪一条)。 */
export type Orm = NodePgDatabase<typeof schema>;

/**
 * 读取解析器(ADR 0036)。列类型换成 PG 原生之后,驱动默认会把 `timestamptz` 读成 `Date`、
 * 把 `jsonb` 读成已解析的对象、把 `bigint` 读成字符串——三样都与项目里三百多处调用点的既有
 * 读法对不上。这里把它们调回 JS 侧原来的形状:
 *
 * - `timestamptz` → ISO 字符串。写入侧全项目都是 `new Date().toISOString()`,读回同形。
 * - `jsonb` / `json` → 原文。读写两侧全是 `JSON.parse` / `JSON.stringify`,原文还要原样进
 *   prompt 与响应。要在 SQL 里查内容的仍然查得动,列本身是 `jsonb`。
 * - `int8`(`COUNT(*)`、`SUM(整数列)` 的结果类型)与 `numeric` → number。本项目的计数与用量
 *   都在 2^53 以内,读成字符串只会让每一处 `Number(...)` 之外的算术静默变成字符串拼接。
 *
 * 装在模块加载时,进程内只装一次。Drizzle 的列类型不受影响:它拿到的值再经列自己的
 * `fromDriver`(见 `schema/columns.ts`,两头都是恒等)。
 */
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => new Date(value).toISOString());
types.setTypeParser(types.builtins.JSONB, (value) => value);
types.setTypeParser(types.builtins.JSON, (value) => value);
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

export type Row = Record<string, unknown>;

export type RunResult = {
  /** 这一句改到的行数。乐观并发按它判(不命中即回 409)。 */
  changes: number;
  /**
   * 新插入那一行的主键。PostgreSQL 没有 `lastInsertRowid`,值来自 `RETURNING id`——
   * 往一张有 `id` 列的表里插时由 `prepare` 自动补上这一句(见 `withReturningId`)。
   * 表没有 `id` 列,或这一句压根不是 INSERT 时,读它当场抛。
   */
  readonly lastInsertRowid: number;
};

/** 一句备好的 SQL。参数用 `?` 占位,由 `toPgSql` 换成 `$n`。 */
export type PreparedSql = {
  get(...params: unknown[]): Promise<Row | undefined>;
  all(...params: unknown[]): Promise<Row[]>;
  run(...params: unknown[]): Promise<RunResult>;
};

export type Db = {
  prepare(sql: string): PreparedSql;
  exec(sql: string): Promise<void>;
};

/**
 * `?` 换 `$n`。跳过单引号字符串、双引号标识符与 `--` 行注释里的问号——PG 里 `?` 本身不是
 * 占位符,漏跳一个就会把字面量里的问号当成参数。
 */
export function toPgSql(sql: string): string {
  let out = "";
  let index = 0;
  let count = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'" || char === '"') {
      const end = sql.indexOf(char, index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(index, stop);
      index = stop;
      // 连着的同类引号是转义(`''`),接着当字符串读下去。
      while (sql[index] === char) {
        const next = sql.indexOf(char, index + 1);
        const tail = next === -1 ? sql.length : next + 1;
        out += sql.slice(index, tail);
        index = tail;
      }
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "?") {
      count += 1;
      out += `$${count}`;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * 往一张有 `id` 列的表里插入时补上 `RETURNING id`。SQLite 那一版靠 `lastInsertRowid` 取新
 * 主键,PostgreSQL 只有 `RETURNING`;十几处调用点因此不必各自改 SQL,新写的插入也不会
 * 因为忘了这一句而拿不到主键。已经自己写了 `RETURNING` 的原样不动。
 *
 * 表名从 schema 现问一遍,不另维护一张清单——清单会跟着建表漂。
 */
function withReturningId(sql: string, tablesWithId: ReadonlySet<string>): string {
  if (/\bRETURNING\b/i.test(sql)) return sql;
  const target = /^\s*INSERT\s+INTO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  if (target === null || !tablesWithId.has(target[1]!.toLowerCase())) return sql;
  return `${sql.trimEnd()} RETURNING id`;
}

/** 语句文本大多是模块常量,换写一次就够。 */
const translated = new Map<string, string>();

function pgSql(sql: string, tablesWithId: ReadonlySet<string>): string {
  const cached = translated.get(sql);
  if (cached !== undefined) return cached;
  const converted = toPgSql(withReturningId(sql, tablesWithId));
  translated.set(sql, converted);
  return converted;
}

/**
 * 当前事务的连接。事务里跑的每一次查询都要落在同一个连接上,而方法体里到处是直接用 `db` 的
 * 写法(事务回调里还会再调别的 store 方法)——在 SQLite 那一版它们天然在同一个连接上,换成
 * 连接池之后不接这一层就会悄悄跑到事务外面去。`db` 因此每次现问一遍有没有在事务里。
 */
const activeClient = new AsyncLocalStorage<pg.PoolClient>();

function makeDb(pool: PgPool, tablesWithId: ReadonlySet<string>): Db {
  const executor = (): PgPool | pg.PoolClient => activeClient.getStore() ?? pool;
  return {
    prepare(sql) {
      const text = pgSql(sql, tablesWithId);
      return {
        async get(...params) {
          const result = await executor().query(text, params);
          return result.rows[0] as Row | undefined;
        },
        async all(...params) {
          const result = await executor().query(text, params);
          return result.rows as Row[];
        },
        async run(...params) {
          const result = await executor().query(text, params);
          const returned = result.rows[0] as Row | undefined;
          return {
            changes: result.rowCount ?? 0,
            get lastInsertRowid(): number {
              const id = returned?.["id"];
              if (id === undefined) {
                throw new Error(`这一句没有回传主键,SQL 要带 RETURNING id:${text}`);
              }
              return Number(id);
            },
          };
        },
      };
    },
    async exec(sql) {
      await executor().query(sql);
    },
  };
}

/**
 * 事务内按业务判定回滚的内部信号(issue #459):`transaction` 捕获它,回滚之后把 `value` 当作
 * 这次事务的返回值交给调用方。它不是错误,不往方法外抛。
 */
class RollbackSignal {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/** 一次事务的句柄:读写经它进行,`rollback` 中途回滚并把给它的值交回去。 */
export type StoreTransaction = Db & {
  rollback(value?: unknown): never;
};

/**
 * 事务的取锁方式。SQLite 那一版靠 `BEGIN IMMEDIATE` 一开头拿写锁;PostgreSQL 没有对应物,
 * 「先读后判再写」要在事务里对父行 `SELECT … FOR UPDATE`(ADR 0036)。
 *
 * ponytail:这个参数在 PG 上不起作用,留着是因为九处调用点标着「这里要拿写锁」,各域迁 Drizzle
 * 时按它找到该加 `FOR UPDATE` 的那一行。九处都迁完之后连参数一起删。
 */
export type TransactionMode = "deferred" | "immediate";

export type StoreDb = {
  db: Db;
  orm: Orm;
  transaction<T>(mode: TransactionMode, run: (tx: StoreTransaction) => Promise<T>): Promise<T>;
};

export function storeDb(pool: PgPool, tablesWithId: ReadonlySet<string>): StoreDb {
  const db = makeDb(pool, tablesWithId);
  // Drizzle 与 shim 走同一个「当前连接」的判断:事务里两边都落在那一条连接上,不然
  // 一半的写会跑到事务外面去。`drizzle()` 只要一个带 `query()` 的东西。
  const routed = {
    query: (...args: unknown[]) =>
      (activeClient.getStore() ?? pool).query(...(args as Parameters<PgPool["query"]>)),
  } as unknown as PgPool;
  const orm = drizzle(routed) as Orm;
  const tx: StoreTransaction = {
    ...db,
    rollback(value) {
      throw new RollbackSignal(value);
    },
  };

  async function run<T>(body: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    try {
      return await body(tx);
    } catch (error) {
      if (error instanceof RollbackSignal) return error.value as T;
      throw error;
    }
  }

  return {
    db,
    orm,
    async transaction(_mode, body) {
      // 已经在一个事务里就并进去,不再 BEGIN:两家数据库都没有嵌套事务,而 SQLite 那一版
      // 在 `BEGIN` 里再 `BEGIN` 会直接报错,并进去严格好过报错。
      if (activeClient.getStore() !== undefined) return await run(body);
      const client = await pool.connect();
      try {
        return await activeClient.run(client, async () => {
          await client.query("BEGIN");
          try {
            const result = await run(body);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        });
      } finally {
        client.release();
      }
    },
  };
}

/**
 * 连接池。启动时建一个,进程内共用——每请求开关库的 `withStore` 到此退役(ADR 0036)。
 */
export function createPool(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl });
}
