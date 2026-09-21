# 持久化迁到 PostgreSQL,经 Drizzle 读写,SQLite 不保留

持久化此前用 Node 内置的 `node:sqlite`(同步 `DatabaseSync`),库是容器卷里的一个文件,服务每次开库自己跑全量 DDL 加补列,并发正确性靠 SQLite 的单写者锁。三个动机推动换库:公司要把数据库纳入统一的运维体系(实例、备份、监控),将来要跑多个服务副本共写一份库,以及要用 SQL 客户端直接查线上数据。调研(`docs/research/db-migration-2026-09-22.md`)量出的事实:两家都没有维护中的同步 Node 驱动,异步化是硬成本;现有 SQL 在 PostgreSQL 上大多原样可用,在 MySQL 上要改写七类几十处、约 30 个 TEXT 键列改长度,且默认排序规则大小写不敏感会改变等值匹配与唯一约束的语义。

选定的做法:**目标库 PostgreSQL,只接外部实例;ORM 用 Drizzle(底下驱动 `pg`),schema 用 TS 写、迁移文件由 drizzle-kit 生成进版本库、服务启动时执行;列类型换成 PG 原生(`timestamptz` / `boolean` / `jsonb`);多连接下的原子性用事务内 `SELECT … FOR UPDATE` 锁父行,全局 id 用 identity 列;SQLite 不保留为任何后端,测试跑真 PG。**顺序是先把 Store 异步化(签名与事务接口改成回调式,SQL 不动,仍跑 `node:sqlite`),再换 Drizzle 与 PG,两层问题分开验。

## Considered Options

- **MySQL 8。**只在公司只有 MySQL 实例时成立。改写面与语义风险都更大:没有 `RETURNING`、没有部分索引、子查询不能读被写的同表、DDL 隐式提交,存量搬迁也没有一手工具。
- **手写 SQL 加 `pg`,不引 ORM。**改写面最小,延续「运行时依赖最少」的既有取向。放弃它是因为迁库要的正是 ORM 给的三样:schema 单一来源、可审可回滚的迁移文件、行类型从 schema 推导而不靠 181 个方法各自手抄。Drizzle 的 builder 与 SQL 一一对应,CTE、`ON CONFLICT`、`RETURNING`、部分索引都是一等 API,复杂语句仍可用 `sql` 模板内嵌,与现有代码的距离最短。Prisma 的查询 API 离 SQL 远、复杂查询要走 TypedSQL 另生成一套;Kysely 只是查询构建器,不管 schema 与迁移。
- **保留 SQLite 作测试或本机后端。**代价是一层方言适配加两套 SQL 字面量长期并存,而 Drizzle 没有 `node:sqlite` 驱动、`sqlite-proxy` 入口也是异步的,「先在 SQLite 上改成 Drizzle 写法」这条中间路不存在。测试改跑真 PG,每个测试文件建一个库;PGlite 是单连接,验不出连接池与行锁,而多写者正是动机之一。
- **Serializable 加重试,或 advisory lock。**前者要求每个事务块都可重跑,事务里的 JS 逻辑很多;后者的锁键是约定不是约束。锁父行的行为与现在的单写者最同形,不重试。
- **compose 内置 PostgreSQL 服务。**与运维标准化的动机相悖;实例由部署方提供,服务只读一条连接串。

## Consequences

- 运行时第三方依赖从三个变成五个(加 `drizzle-orm` 与 `pg`),`drizzle-kit` 是开发依赖。`src/AGENTS.md` 里「不为持久化再引入驱动」那条规范作废。
- `MULTIREVIEWER_DB` 废弃,设了拒绝启动并指向 `MULTIREVIEWER_DATABASE_URL`;会话图片附件的位置改由 `MULTIREVIEWER_DATA_DIR` 给,不再从库文件路径推出。备份规程从「备份库文件所在目录」变成「`pg_dump` 加图片目录」。
- 开库时的全量 DDL、`PRAGMA user_version` 骨架判断与按 `pragma_table_info` 补列的升级路径全部退役,由迁移文件与 Drizzle 的迁移表取代;此后每次 schema 变更都是一份进版本库的 SQL 文件。
- 每请求开关库的 `withStore` 改成启动时建一个连接池;事务必须绑定在同一个连接上,因此事务接口是回调式的。
- 现役实例的存量数据由一次性脚本从 SQLite 搬到 PG,逐表核行数,旧库文件归档;脚本用完即删。
- 这个决定只保证数据库层在多连接下正确。多实例部署还牵涉定时检查、排空、Agent 会话子进程名额、工作副本缓存与图片目录,另开 spec。
- ADR 0031「SQLite 是唯一真相」里的「SQLite」从此读作「数据库」,其余决策不变。
