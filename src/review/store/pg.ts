import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import type * as schema from "../schema/index.ts";

const { Pool, types } = pg;

export type PgPool = pg.Pool;

/** Drizzle 的句柄。事务里由 `activeClient` 决定落在哪一条连接上。 */
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
 * 装在模块加载时,进程内只装一次。**`jsonb` 与 `int8` 这两项到处都生效**(builder、
 * `orm.execute`、裸驱动三条路读回来的都一样),`timestamptz` 那一项只对**不经 Drizzle**
 * 的读生效(测试里直连库的 `withTestDb`)——Drizzle 给自己发出的每一条查询另装一份解析器,
 * 把时刻原样交给它自己的映射层,全局这一份在它的查询上不生效。因此时刻有两种读法:
 *
 * - 走列对象、或者 `sql` 表达式接 `.mapWith(某个时刻列)` → `schema/columns.ts` 的
 *   `isoTimestamp.fromDriver` 归一,拿到 ISO。
 * - 不接 `.mapWith` 的 `sql` 表达式、以及 `orm.execute` 的结果 → PostgreSQL 的原文
 *   (`2026-08-03 00:00:00+00`),在 JS 侧过一道 `shared.ts` 的 `isoTime`。
 *
 * 2026-09-22 在本机测试实例上逐条实测过这五条路,上面写的是实测结果。
 */
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => new Date(value).toISOString());
types.setTypeParser(types.builtins.JSONB, (value) => value);
types.setTypeParser(types.builtins.JSON, (value) => value);
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

/**
 * 当前事务的连接。事务里跑的每一次查询都要落在同一个连接上,而方法体里到处是直接用 `orm` 的
 * 写法(事务回调里还会再调别的 store 方法)——不接这一层就会悄悄跑到事务外面去。`orm` 因此
 * 每次现问一遍有没有在事务里。
 */
const activeClient = new AsyncLocalStorage<pg.PoolClient>();

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

/** 一次事务的句柄。`rollback` 中途回滚并把给它的值交回去;读写仍走 `orm`。 */
export type StoreTransaction = {
  rollback(value?: unknown): never;
};

export type StoreDb = {
  orm: Orm;
  /**
   * 一次事务。没有取锁方式这个参数:PostgreSQL 没有 `BEGIN IMMEDIATE` 的对应物,
   * 「先读后判再写」一律在事务里对父行 `SELECT … FOR UPDATE`(ADR 0036)。
   */
  transaction<T>(run: (tx: StoreTransaction) => Promise<T>): Promise<T>;
};

export function storeDb(pool: PgPool): StoreDb {
  // 事务里落在那一条连接上,不然一半的写会跑到事务外面去。`drizzle()` 只要一个带
  // `query()` 的东西。
  const routed = {
    query: (...args: unknown[]) =>
      (activeClient.getStore() ?? pool).query(...(args as Parameters<PgPool["query"]>)),
  } as unknown as PgPool;
  const orm = drizzle(routed) as Orm;
  const tx: StoreTransaction = {
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
    orm,
    async transaction(body) {
      // 已经在一个事务里就并进去,不再 BEGIN:PostgreSQL 没有嵌套事务,并进去严格好过报错。
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
 * 连接池。启动时建一个,进程内共用——每请求开关库的写法到此退役(ADR 0036,issue #460)。
 *
 * 池的上限由 `MULTIREVIEWER_DB_POOL_MAX` 给,默认 10。测试要调小它:一个测试文件建好几个库、
 * 好几个池,几路并发跑起来就会把 PostgreSQL 的 `max_connections` 占满(报 too many clients),
 * 而每个测试库上同时在跑的查询本来也只有几条。
 */
export function createPool(databaseUrl: string): PgPool {
  const max = Number(process.env["MULTIREVIEWER_DB_POOL_MAX"] ?? 10);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number.isFinite(max) && max > 0 ? max : 10,
  });
  // 池里**空闲**连接上的错误(PostgreSQL 重启、管理员踢连接、库被删掉)以 `error` 事件抛到
  // 池上,而不是抛给某一次查询。没有监听者时 Node 把它当未捕获异常,整个进程当场倒下——
  // 一次数据库重启不该带走服务。记一行就够:出错的那条连接已经被池丢掉,下次取连接新建一条。
  pool.on("error", (error: Error) => {
    console.error("[db] 连接池里一条空闲连接出错:", error.message);
  });
  return pool;
}
