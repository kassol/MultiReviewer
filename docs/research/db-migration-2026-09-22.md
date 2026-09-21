# 持久化从 SQLite 迁到 PostgreSQL / MySQL 的调研(2026-09-22)

范围:只读代码与一手文档,不改源码、不连数据库。代码结论标 `file:line`(行号取自 2026-09-22 `main` 的 `7f41628`);外部结论标一手来源 URL。驱动的版本、发布时间与依赖取自 npm registry 元数据(`https://registry.npmjs.org/<包名>`)与 GitHub REST API(`https://api.github.com/repos/<owner>/<repo>`),查询日期 2026-09-22。本笔记不给推荐。

## 结论摘要

对选型影响最大的是第 1、2、3、5、6 条。

1. `Store` 全部 181 个方法都是同步函数,`store.ts` 内没有一处 `await`;`src/` 里 340 个调用点直接拿返回值用(`src/webhook/server.ts` 占 274 个)。改成异步驱动,这 340 处与它们所在的同步函数链要一起改。见 [二.1](#21-调用面)。
2. 两家都没有维护中、可用于 Node 24 服务端的同步驱动:`pg-native` 有 `querySync` 但依赖 libpq 原生编译,官方 README 自己说在 web 服务里用同步是坏主意;`sync-mysql` 最后发版 2017 年;PGlite 只有 Promise API。见 [二.5](#25-保持同步-api-的路)。
3. 本项目有 6 处序号分配依赖「SQLite 同一时刻只有一个写者」:`MAX(seq)+1` 写在 INSERT 子查询或事务里(`store.ts:8606-8611`、`8652-8656`、`8670-8676`、`5958-5963`、`4962-4965`)。PostgreSQL 默认 Read Committed、MySQL 默认 Repeatable Read,两者的普通读都不锁,这几处在多连接下会撞主键。见 [一.8](#18-事务写法) 与 [三.2](#32-逐类对照)。
4. 9 处 `BEGIN IMMEDIATE` 用「一开头就拿写锁」表达读-判-写的原子性(`store.ts:5174` 等),两家都没有这个语句,需要换成行锁、表锁或 Serializable 加重试。见 [一.8](#18-事务写法)。
5. MySQL 上改写量明显更大:没有 `RETURNING`(3 处)、没有部分索引(1 处)、没有 `CREATE INDEX IF NOT EXISTS`(23 处)、不能在 UPDATE/DELETE/INSERT 的子查询里读同一张表(至少 7 处)、不支持 `SET (a,b) = (SELECT …)`(2 处)、`||` 默认是逻辑 OR(5 处字符串拼接)、TEXT 列进索引要前缀长度(约 30 个键列是 TEXT)。PostgreSQL 上这些写法大多原样可用。见 [三.2](#32-逐类对照)。
6. `openStore` 每次打开都执行全量建表脚本、逐列查补列与删旧键(`store.ts:4525-4588`),而 webhook 层按请求短开短关(`server.ts:668-675`,`withStore` 被调用 196 次;`agent-session.ts` 另有 21 处 `openStore`)。换成服务器型数据库后,这种「每请求一次连接加一次 DDL」的形状要改成连接池加一次性迁移。见 [二.3](#23-依赖同步的语境)。
7. 迁移按「一笔事务、失败整笔回滚」写(`store.ts:4959-4977` 等);PostgreSQL 支持事务性 DDL,MySQL 的 DDL 会隐式提交当前事务。见 [三.2](#32-逐类对照)。
8. SQLite 这边外键实际在生效:`node:sqlite` 的 `enableForeignKeyConstraints` 默认 `true`,本项目没有改它(`store.ts:4526`)。换库后外键行为不变,删除顺序已按外键写好(`store.ts:5516-5527`)。见 [一.12](#112-databasesync-专有-api)。
9. 行数不大的 JSON 读写在两家都有对应函数;本项目 JSON 函数只有 17 处,集中在 3 段 SQL(`store.ts:2873-2897`、`4624-4678`、`6104-6122`、`4352`)。见 [一.1](#11-json-函数)。
10. 测试面:113 个测试文件中 71 个经 `openStore` 用临时库,33 个直接 `new DatabaseSync`,另有 4 个 `test/support/` 夹具直接碰库;测试里有 123 处 `query(` 与 113 处 `.prepare(`。见 [二.4](#24-测试面)。
11. 存量搬迁:pgloader 官方文档支持 SQLite → PostgreSQL,最近一个 release 是 v3.6.9(2022-10-24);MySQL 方向未查到官方的 SQLite 导入工具。见 [三.4](#34-存量数据搬迁)。
12. 部署面要动 `docker-compose.yml:36-39`(卷与服务)、`Dockerfile:81`(`MULTIREVIEWER_DB`)、`scripts/setup.sh` 的数据目录与自检段,以及统计页读库文件大小那一处(`server.ts:8239-8243`)。见 [三.3](#33-部署面)。

## 一、`src/review/store.ts` 里的 SQLite 专属用法

`store.ts` 共 9644 行。结构:`STORE_SCHEMA` 建表脚本(`60-888`)、`MODEL_SERVICE_SCHEMA`(`986-1091`)、类型与 SQL 片段常量(`1093-4523`)、`openStore` 实现(`4525-9644`)。库里的 `store.ts` 之外只有测试直接 `import "node:sqlite"`;`src/` 下其余提到 `node:sqlite` 的只是注释(`src/contracts/finding.ts:7`、`src/contracts/stages.ts:9`、`src/review/finding.ts:24`)。另有两处按库文件路径推导的非 SQL 依赖:`src/reviewer/session-images.ts:51` 把会话图片放在库文件同目录;`src/webhook/server.ts:8241` 用 `statSync(deps.dbPath).size` 报库体量。

每类列出次数、代表位置、PostgreSQL(下称 PG)与 MySQL 8.4(下称 MySQL)的对应写法。对应写法的来源在第三部分逐条标出。

### 1.1 JSON 函数

17 处,出现在 4 段 SQL:`json_type`(`2877`)、`json_extract`(`2878`、`2880`、`2884`、`2889`、`4352`、`4651`、`4652`、`4672`、`6109-6111`)、`json_each`(`2879`、`4650`、`4671`)、`json_array_length`(`4655`、`4665`)。另有大量 TEXT 列存 JSON,由 JS 侧 `JSON.stringify` / `JSON.parse` 读写(例如 `review_run.history_json` 在 `7649` 写、`7839` 读)。

- PG:`jsonb_array_elements`、`jsonb_array_length`、`jsonb_typeof`、`->>`;`json_each` 加 `ORDER BY part.key`(`2881`)可换成 `WITH ORDINALITY`。
- MySQL:`JSON_EXTRACT` / `->>`、`JSON_LENGTH`、`JSON_TYPE`;`json_each` 换 `JSON_TABLE(... COLUMNS (ord FOR ORDINALITY, ...))`。

### 1.2 `ON CONFLICT` / `INSERT OR IGNORE`

- `ON CONFLICT`:8 处。`DO NOTHING` 2 处(`4586`、`5487`);`DO UPDATE SET … = excluded.…` 6 处(`6289`、`6406`、`6888`、`7197`、`7568`、`7786`)。
- `INSERT OR IGNORE`:5 处(`5092`、`5288`、`5835`、`6052`、`9632`)。其中 `6052` 与 `9632` 用 `changes > 0` 判「这一次是不是新插入」(`6055-6057`、`9636`),`5487-5490` 同样按 `changes` 分支。
- PG:两种写法都换成 `ON CONFLICT … DO NOTHING / DO UPDATE SET … = EXCLUDED.…`,语义一致;影响行数照样可读。
- MySQL:`INSERT IGNORE` 与 `ON DUPLICATE KEY UPDATE`。`INSERT IGNORE` 把其它错误也降级为警告;`ON DUPLICATE KEY UPDATE` 在多个唯一键同时冲突时只更新一行,影响行数是 1(插入)/ 2(更新)/ 0(值未变)。依赖 `changes > 0` 的三处要按这套计数重核。

### 1.3 `RETURNING`

3 处,都是序号分配:`appendTrace`(`8604-8614`)、`startRuleTrace`(`8650-8659`)、`appendRuleTrace`(`8668-8677`)。PG 原样支持;MySQL 没有 `RETURNING`,要改成先分配后插入,或插入后再读。

### 1.4 `lastInsertRowid` / `changes`

- `lastInsertRowid`:14 处(`4863`、`5011`、`5465`、`5596`、`5667`、`5723`、`5828`、`5886`、`6492`、`6624`、`7659`、`7943`、`7998`、`9180`),全部包在 `Number(...)` 里。
- `.changes`:25 处(`4583`、`5051`、`5131`、`5470`、`5489` 等),多数用于「这一次改到行没有」的分支判断;`7024`、`7285` 用它做乐观并发(`WHERE version = ?` 不命中即回 409)。
- PG:自增主键靠 `RETURNING id`;影响行数由驱动返回(`pg` 的 `rowCount`)。
- MySQL:`LAST_INSERT_ID()` / 驱动的 `insertId`;影响行数由驱动返回,`ON DUPLICATE KEY UPDATE` 的计数口径见 1.2。

### 1.5 `PRAGMA` 与系统表

- `PRAGMA user_version`:读 1 处(`4528`)、写 1 处(`4543`)。它是骨架版本号:`0` 且库里有表即拒绝启动(`4530-4540`),非 `1` 即拒绝(`4546-4549`)。
- `pragma_table_info(?)`:1 处(`4571`),补列前判列存不存在。
- `sqlite_master`:2 处(`4533`、`9398`),前者判「是不是空库」,后者列出全部表给统计页数行数。
- `journal_mode`、`busy_timeout`、`foreign_keys`:代码里没有 PRAGMA。busy timeout 走构造参数 `{ timeout: BUSY_TIMEOUT_MS }`(`4526`,常量 5000 在 `1245`)。
- PG:`information_schema.columns` / `pg_catalog`;版本号通常放在一张迁移表里。MySQL:`information_schema`。两家都没有 `user_version` 这类库级整数。

### 1.6 自增主键与 rowid

- `INTEGER PRIMARY KEY AUTOINCREMENT`:19 处,例如 `review_run`(`62`)、`finding`(`176`)、`rule_trace` 没有(它的 `task_id` 由 `MAX+1` 分配,见 1.8)。
- 不带 `AUTOINCREMENT` 的 `INTEGER PRIMARY KEY`:4 处。`repo.id`(`409`)由调用方写入 Forge 的数值 id(`5272-5280`);`rule_exploration`、`rule_consolidation`、`product_repo` 三张表拿 `repo_id` 当主键(`483`、`503`、`705`)。
- 没有直接引用 `rowid`,没有 `WITHOUT ROWID`。
- PG:`GENERATED … AS IDENTITY` 或 `bigserial`;显式写 id 的 `repo` 表用普通 `bigint` 主键即可。MySQL:`AUTO_INCREMENT`;CHECK 约束不能引用 `AUTO_INCREMENT` 列(见 1.9)。

### 1.7 类型亲和性

- 布尔存 `INTEGER` 0/1,读侧 `Number(row[…]) === 1` 或 `row[…] === 1`(例如 `5078`、`5081`、`8306`、`8452`、`9038`)。严格等于 `1` 的写法要求驱动把该列读成 JS number。
- 时间全部存 ISO 字符串 `TEXT`(例如 `started_at TEXT NOT NULL`,`81`),写入侧用 `new Date().toISOString()`(例如 `4966`、`5279`);比较与排序按字典序,`6170` 的注释写明「`started_at` 是 ISO 字符串,MAX 按字典序即时间序」,统计按字符串区间过滤(`8736`、`8794`、`6134`)。
- JSON 存 `TEXT`(见 1.1)。
- 聚合结果的数值类型:`COUNT(*)`、`SUM(...)` 结果都包在 `Number(...)` 里(例如 `5110`、`6139-6147`、`8798-8807`)。
- PG:`pg` 把 `int8`(`COUNT(*)` 的结果类型)读成字符串,理由是 JS 放不下 64 位整数;`postgres` 把 bigint 读成字符串(可配成 `BigInt`)。本项目包 `Number()` 的地方不受影响,`=== 1` 那几处取决于列类型选 `integer` 还是 `bigint` / `boolean`。
- MySQL:`mysql2` 把 `DECIMAL` 读成字符串;`SUM(int)` 在 MySQL 的结果类型是否为 DECIMAL 未查到一手依据。

### 1.8 事务写法

- 手写 `BEGIN` / `COMMIT` / `ROLLBACK`:`db.exec("BEGIN")` 27 处,`BEGIN IMMEDIATE` 9 处(`5174`、`5263`、`5364`、`6088`、`6891`、`6974`、`7112`、`7258`、`7537`),`ROLLBACK` 58 处。没有 `SAVEPOINT`,没有嵌套事务。
- 形状统一:`db.exec("BEGIN"); try { …; db.exec("COMMIT") } catch { db.exec("ROLLBACK"); throw }`(例如 `5005-5020`)。58 处 `ROLLBACK` 里 36 处在 `catch` 里,其余 22 处是事务中途按业务判定提前 `ROLLBACK` 再 `return`(例如 `5111-5114`、`5369-5376`、`6914-6917`、`6976-6979`、`7114-7148`)。
- `BEGIN IMMEDIATE` 的用途写在注释里:`takeAgentSessionPendingMessages` 先读后删,延迟 `BEGIN` 在升级写锁时会当场报 `database is locked`,一开头拿写锁才会走 busy timeout(`6085-6088`,issue #401)。`registerFirstPanelUser` 的注释说明查与插是「一个决定」,而并发安全靠 Node 单线程(`5172-5174`)。
- 序号分配(`MAX+1`)的 6 处:`appendTrace` 的 INSERT 子查询(`8606-8611`,注释 `8602-8603` 说「SQLite 不会让两条并发的写拿到同一个号」);`startRuleTrace` 按全表 `MAX(task_id)+1` 分配任务号(`8652-8656`);`appendRuleTrace`(`8670-8676`);`appendAgentSessionEntry` 在 `BEGIN` 里先 `SELECT MAX(seq)` 再 INSERT(`5956-5980`);`inRuleSetVersion` 在 `BEGIN` 里取 `MAX(version)+1`(`4960-4969`);测试夹具 `seedReviewRule` 同样取 `MAX(version)+1`(`test/support/store-seed.ts:31-35`)。
- PG:`BEGIN` / `COMMIT` / `ROLLBACK` 原样可用;没有 `IMMEDIATE`,对应物是 `SELECT … FOR UPDATE`、`LOCK TABLE` 或 Serializable 隔离(失败返回 SQLSTATE 40001,须重试)。默认 Read Committed 下 `MAX+1` 并发会分到同一个号,由主键拦下成错误。
- MySQL:同上,没有 `IMMEDIATE`;默认 Repeatable Read 的普通 SELECT 是快照读,不加锁。

### 1.9 schema 建立与升级

- `CREATE TABLE IF NOT EXISTS`:50 处;`CREATE INDEX IF NOT EXISTS`:22 处,`CREATE UNIQUE INDEX IF NOT EXISTS`:1 处(`746`)。
- 部分索引:1 处,`product_knowledge_entry_by_name … WHERE name <> ''`(`746-747`)。
- `CHECK`:47 处,含跨列布尔等式,例如 `CHECK ((state = 'active') = (retired_version IS NULL))`(`472`)、`CHECK ((change = 'add') = (target_rule_ids = '[]'))`(`588`)、多分支状态机(`1021-1029`、`1042-1051`)。
- `REFERENCES`:44 处;没有 `ON DELETE CASCADE`,级联删除由代码手写(`5422-5446`、`5510-5547`)。
- 没有触发器,没有 `WITHOUT ROWID`。
- 升级方式:`openStore` 每次打开都执行 `db.exec(STORE_SCHEMA)` 与 `db.exec(MODEL_SERVICE_SCHEMA)`(`4550-4551`),再 `DROP TABLE IF EXISTS` 4 张退役表(`4556-4563`),再按 `ADDED_COLUMNS`(`1133-1177`,18 列)逐列查 `pragma_table_info` 并 `ALTER TABLE … ADD COLUMN`,首次补列时跑一次回填(`4568-4576`),再删旧版本键(`4581-4588`)。补列与回填不在同一笔事务里。
- PG:`CREATE TABLE/INDEX IF NOT EXISTS`、部分索引、跨列 CHECK 都原样支持;DDL 可以放在事务里回滚(见 3.2)。
- MySQL:`CREATE INDEX` 语法里没有 `IF NOT EXISTS`;没有部分索引(可用函数索引或生成列替代,是否能表达「空名不参与唯一」未验证);CHECK 不允许子查询、不允许引用 `AUTO_INCREMENT` 列、不允许与外键引用动作同列;DDL 隐式提交。

### 1.10 字符串拼接、比较与排序

- `||` 拼接:5 处(`1272`、`4249`、`4263`、`4477`、`4478`)。其中 `identityKey` 生成的折叠键(`1270-1273`)被 9 段查询复用,是 Finding Identity 的键(见其注释 `1258-1269`)。
- `char(10)`:1 处(`1272`),拼接时用换行作分隔。
- `rtrim(x, '/')`:1 处(`4652`)。
- `LIKE`:2 处,都是 `name NOT LIKE 'sqlite_%'`(`4533`、`9399`)。没有 `GLOB`、`COLLATE`。JS 侧 glob 用 `node:path` 的 `matchesGlob`(`8`、`8177`)。
- 排序依赖:`ORDER BY` 字符串列(`owner`、`repo`、`name`、`model` 等)按 SQLite 默认的 BINARY(按字节)比较;JS 侧还有 3 处 `localeCompare`(`7510`、`8470`、`8951`)。
- PG:`||` 原样可用;默认排序规则取决于建库时的 locale(未查到本项目要用的具体取值)。
- MySQL:`||` 默认是逻辑 OR,须 `CONCAT()` 或开 `PIPES_AS_CONCAT`;服务器默认排序规则 `utf8mb4_0900_ai_ci`(大小写与重音都不敏感),与 SQLite 的 BINARY 比较不同,影响等值匹配(例如 `owner = ? AND repo = ?`)与唯一约束(例如 `product.name UNIQUE`,`695`)。

### 1.11 CTE、窗口函数、分组与其它查询形状

- `WITH`(非递归):6 处(`1291` 的 `STATS_IDENTITY_CTE` 被 `8719`、`8761` 复用,另有 `8067`、`8115`、`8156`、`9418`)。没有 `WITH RECURSIVE`,没有窗口函数。
- 聚合中的裸列:`pullStageQuery` 在 `GROUP BY owner, repo, pull_number` 下直接取 `title`、`pr_state`、`started_at`、`finished_at`,依赖 SQLite 的「与 `MAX()` 同行」规则(`4241-4257`,注释引 `https://sqlite.org/lang_select.html#bareagg`)。PG 与 MySQL 默认的 `ONLY_FULL_GROUP_BY` 都拒绝这种写法。
- 行值赋值 `UPDATE … SET (a, b, c) = (SELECT …)`:2 处(`8013-8027`、`9520-9526`)。PG 支持;MySQL 的赋值语法只有 `col = value`。
- 子查询读被写的同一张表:`finishRun` 的 UPDATE(`8013-8027`)、`recordContinuation` 两句(`9520-9537`)、`completeHandoff`(`9560-9566`)、`finishRuleExplorationAsProposals` 的 DELETE(`6344`)、`appendTrace` 与 `appendRuleTrace` 的 INSERT 子查询(`8606-8611`、`8670-8676`)、`startRuleTrace`(`8652-8656`)。PG 允许;MySQL 对 UPDATE 报 1093,对 INSERT 文档写明「不能在子查询里读同一张表」。
- 布尔表达式排序:`ORDER BY (last_activity IS NULL), …`(`6183`)、`ORDER BY state = 'completed', …`(`6449`)。PG 按 `false < true` 排;MySQL 按 0/1 排,结果一致(两家的具体排序规则未逐一查证)。
- `IS NULL` 40 处、`IS NOT NULL` 31 处,都是标准写法。没有 `IS ?` 这种 SQLite 特有的空值比较。
- `COALESCE` 13 处;`UNION` / `UNION ALL` 7 处(`4348-4360`、`4814`、`7548`、`9108`),均为标准写法。
- `LIMIT` 13 处、`LIMIT ? OFFSET ?` 1 处(`9113`)。PG 与 MySQL 都支持 `LIMIT … OFFSET …`;MySQL 的 `LIMIT` 占位参数经驱动的服务端预处理传入时的类型要求未查证。
- 日期函数:0 处(没有 `datetime`、`strftime`、`julianday`、`unixepoch`)。时间计算都在 JS 侧。
- `VACUUM`、`page_count`、`dbstat`:0 处。库体量取文件大小(`server.ts:8241`)与逐表 `COUNT(*)`(`store.ts:9395-9410`,表名来自 `sqlite_master`,用双引号拼进 SQL)。

### 1.12 `DatabaseSync` 专有 API

- 构造:`new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS })`(`4526`)。未传 `enableForeignKeyConstraints`,Node 文档写明默认 `true`,外键因此在生效。
- `db.prepare(...)` 332 处,`.get(` 124 处,`.all(` 69 处,`.run(` 194 处,`db.exec(` 141 处(多数是 `BEGIN/COMMIT/ROLLBACK`)。没有 `.iterate(`。
- 多语句执行:`db.exec(STORE_SCHEMA)` 一次跑完 70 余条 DDL(`4541`、`4550`)。
- 行对象:注释说 `node:sqlite` 返回 null 原型对象,所以逐字段取出(`8741-8742`);Node 文档没有写明行对象的原型,这一条未查到一手依据。
- 整数:未开 `readBigInts`(默认 `false`),整数读成 JS number;`run()` 返回的 `changes` / `lastInsertRowid` 类型是 `number | bigint`,代码一律 `Number(...)`。
- 备份:代码里没有调用 `sqlite.backup()`(Node 提供这个模块级函数,返回 Promise)。
- 模块稳定性:Node 文档标为 Stability 1.2(Release candidate);`src/AGENTS.md:22` 记录了它会打 `ExperimentalWarning`。

## 二、同步改异步的代价

### 2.1 调用面

- `Store` 类型(`store.ts:3007-4041`)对外 181 个方法,全部同步。统计命令:`sed -n 3007,4042p src/review/store.ts | grep -oE "^  [a-zA-Z0-9_]+[(<?:]" | sort -u | wc -l`。
- `src/` 里(不含 `store.ts`)的调用点。命令:把 181 个方法名拼成正则后 `grep -rnoE "\.(方法名…)\(" src --include='*.ts' | grep -v "^src/review/store.ts:"`。结果 369 条,其中 29 条是 `.close(`(28 条是 `store.close()`,1 条是 `server.close()`)。去掉 `.close(` 后 340 条,按文件:

| 文件 | 调用点 |
|---|---|
| `src/webhook/server.ts` | 274 |
| `src/webhook/agent-session.ts` | 24 |
| `src/review/run.ts` | 24 |
| `src/webhook/product-tracker.ts` | 15 |
| `src/review/trace.ts` | 3 |

  340 条里 324 条在同一行上能认出接收者是 `store` / `resumeStore`,其余 16 条是跨行链式调用。
- `store.ts` 内部方法互相调用 22 次(`grep -cE "store\.(方法名…)\(" src/review/store.ts`),例如 `listStages` 在 `rows.map` 里逐行调 `store.stageSummary`(`9123-9130`),`listModelServices` 在 `.map` 里逐个调 `store.getModelService`(`7425-7430`)。
- `openStore` 在 `src/` 的调用:`server.ts` 3 处(`668` 的 `withStore`、`1822`、`6509`),`agent-session.ts` 21 处,`run.ts` 2 处(`2018`、`2084`)。`withStore(` 在 `server.ts` 里出现 196 次。

### 2.2 依赖「两次同步调用之间不插入别的操作」的地方

- 手写事务块 36 个(27 个 `BEGIN` 加 9 个 `BEGIN IMMEDIATE`,位置见 1.8)。`store.ts` 里没有 `await`,唯一出现 `await` 字样的是 `5172` 的注释;没有 `fetch`、子进程或文件 I/O。因此没有一个事务块里夹着外部 I/O。
- 事务块里夹非 SQL 逻辑的很常见:JSON 解析与改写、`Map` 归并、循环多语句、在事务里调用别的 `store` 方法。例如 `getReviewRunSnapshot` 在只读事务里连调 `getRepo`、`getGlobalSettings`、`getModelService`、`getRuleSet`(`6837-6878`);`commitModelServiceVersion` 在事务里调用 `recordSupportsCurrentReferences`,后者又调 `store.listModelReferences()`(`6974-6979`、`4694-4738`)。
- 最重的 5 个事务块:

| 位置 | 方法 | 做什么 |
|---|---|---|
| `store.ts:7844-8034` | `finishRun` | 更新轮次与用量、删中间态批次结果、循环插入 Reviewer 结果、Finding、归属、承接说法、复核结论、同根因组与成员,最后一句带相关子查询的 UPDATE 继承处置元数据 |
| `store.ts:6974-7108` | `commitModelServiceVersion` | 引用可用性校验(JS 逻辑加 `listModelReferences`)、乐观版本 UPDATE、删插凭据、目录、目录模型(循环)、补录(循环) |
| `store.ts:7112-7254` | `renameConflictingCustomModelService` | 版本与冲突判定、可用性判定、JS 侧解析并改写全局与每个仓库的模型组合 JSON(循环)、推整页版本、改 5 张表的 provider |
| `store.ts:7603-7687` | `startRun` | 查 PR 关闭标记、插入轮次(20 列,含历史快照与批次计划两段 JSON)、循环插入 Reviewer 钉定 |
| `store.ts:5511-5547` | `deleteProduct` | 按外键顺序逐表删除产品知识、票的边与评论、票、spec、会话子表与会话、产品 |

- 事务外、跨多次调用的「查后写」也依赖同步:`attachProductRepo` 先插、不成再查(`5475-5498`);`acceptAgentSessionMessage` 同形(`6046-6065`);`writeProductKnowledge` 在事务外先查两行再开事务(`5562-5572`);`deleteRuleIntent` 先读状态再删(`6522-6528`)。
- 进程内的顺序依赖:Agent 会话子进程回传一批条目时,父进程在 IPC 回调里逐条同步落库(`agent-session.ts:1153-1157`);`appendAgentSessionEntry` 靠 `MAX(seq)+1` 编号(`store.ts:5958-5963`)。改成异步后,同一批条目的落库顺序与编号取决于调用方是否逐条 `await`。

### 2.3 依赖同步的语境

- 同步回调:`withStore<T>(dbPath, fn: (store) => T): T`(`server.ts:667-675`),以及 `startRuleTrace` 接收同样签名的 `withStore`(`trace.ts:323-357`)。
- 返回 `void` 的同步接口:`TraceRecorder.run` / `reviewer` 是同步方法(`trace.ts:274-280`),内部同步调用 `store.appendTrace` 后立即广播(`trace.ts:287-301`)。它被 `run.ts` 在批次回调里调用,紧挨着 `store.recordBatchOutcome`(`run.ts:2446-2449`),两者的先后顺序有注释论证(`run.ts:2442-2445`)。
- IPC 事件回调:`child.on("message", …)` 的 `switch` 里同步落库并同步 `child.send` 回复(`agent-session.ts:1146-1205`)。
- `Array.map` 内调用:`server.ts:2072`(`read.tickets.map((ticket) => store.listProductTicketComments(ticket.id))`),以及 `store.ts` 内部的 `9127`、`7429`。
- 同步辅助函数接收 `Store`:`effectiveMinReportSeverity(store, repoId)`(`run.ts:452-456`)。
- 长持有句柄:`run.ts:2084` 打开的句柄存活整段审查(注释 `2081-2083`,时长无上限);`server.ts:6509` 的句柄跨过 `await disposeAbsentHistory(...)`(`6515`)。
- 构造函数与 getter:`src/` 里没有在 `constructor` 或 `get` 访问器里调用 store(只有两个错误类的构造函数,`forge/gitea.ts:57`、`forge/forge.ts:101`)。
- 定时器:`startScheduledCheckTicks` 在 `setInterval` 里调用异步的 `scheduledCheckTick`(`server.ts:8180-8195`),本身已是异步形状。
- 每次打开都跑 DDL:`openStore` 在每次调用时执行建表脚本、`pragma_table_info` 逐列检查与删旧键(`store.ts:4550-4588`);注释承认「`openStore` 每次请求都跑一遍」(`4566-4567`)。

### 2.4 测试面

- `test/` 下 113 个 `*.test.ts`。
- 直接 `new DatabaseSync` 或 `import "node:sqlite"` 的测试文件 33 个(`grep -rl "DatabaseSync" test --include='*.test.ts'`),另有 4 个夹具:`test/support/batch-run.ts:81`(只读 `query()`)、`test/support/store-seed.ts:28`(直写 `review_rule` 与版本表)、`test/support/panel-harness.ts:292`(直写 `global_setting`)、`test/support/agent-session.ts`。
- 经 `openStore` 用临时库的测试文件 71 个;夹具里 `openStore` 出现在 `git-fixture.ts:372`、`panel-harness.ts:146/279/554/583/629`、`cross-run.ts:95`、`agent-session.ts:133/243`。
- 临时库位置:`makeDbPath()` 在 `mkdtemp` 目录里指一个 `multireviewer.db`(`test/support/git-fixture.ts:355-362`),库文件由第一次打开时创建。
- 测试里 `query(` 123 处、`.prepare(` 113 处(`grep -rhoE "\bquery\(|\.prepare\(" test --include='*.ts'`),这些是写在测试里的 SQL 字面量,换库时同样要按第一部分核一遍。
- 并发类用例:`test/agent-session-pending-contention.test.ts` 直接用 `DatabaseSync` 造锁竞争(对应 `store.ts:6085-6088` 的 issue #401)。

### 2.5 保持同步 API 的路

| 候选 | 同步 API | 维护状态 | 许可证 | 备注 |
|---|---|---|---|---|
| `pg-native` 3.9.0 | 有:`connectSync`、`querySync`、`prepareSync`、`executeSync` | 最新版 2026-08-08;与 `pg` 同仓库,仓库最近推送 2026-09-19 | MIT | 依赖 `libpq`(`node-gyp rebuild` 原生编译,需要 `pg_config`);README 原话:同步在 web 服务这类非阻塞系统里是坏主意。Node 24 兼容性未查到一手依据 |
| `sync-mysql` 3.0.1 | 有(经 `sync-rpc` 起子进程转同步) | 最新版 2017-07-09,仓库最后推送 2019-02-10 | MIT | 依赖 `babel-runtime`、`then-mysql` 等;Node 24 兼容性未查到一手依据 |
| PGlite 0.5.8(`@electric-sql/pglite`) | 没有:`query` / `exec` / `transaction` 都返回 Promise | 最新版 2026-08-26 | npm 元数据写 Apache-2.0;README 写 Apache-2.0 与 PostgreSQL License 双许可 | 支持 Node 与 `memory://` 内存库;README 写明「single user/connection」。可作测试后端的前提是生产代码已改成异步 |

结论只陈述事实:两家都有同步驱动存在,但 PG 一侧唯一在维护的是原生编译的 `pg-native`,MySQL 一侧的 `sync-mysql` 已多年未更新。

## 三、选型事实(MySQL 8.4 与 PostgreSQL 16/17)

### 3.1 Node 驱动

| 驱动 | 版本 / 发布 | 许可证 | 运行时依赖 | 纯 JS | 事务与连接池 API | Node 引擎声明 |
|---|---|---|---|---|---|---|
| `pg`(node-postgres) | 8.23.0 / 2026-08-08 | MIT | 6 个(`pg-pool`、`pg-protocol`、`pg-types`、`pgpass`、`pg-connection-string`、可选 `pg-cloudflare`) | 是(`pg-native` 为可选 peer) | 事务必须在同一个 client 上:`const client = await pool.connect(); await client.query('BEGIN') … client.release()` | `>= 16.0.0` |
| `postgres`(porsager) | 3.4.9 / 2026-04-05 | Unlicense | 0 | 是 | `sql.begin(async sql => …)`,驱动为事务保留一个连接 | `>=12` |
| `mysql2` | 3.24.4 / 2026-09-08 | MIT | 7 个 | 是 | `mysql2/promise` 提供 Promise 包装;池取连接 `getConnection`,连接上 `beginTransaction` / `commit` / `rollback`;多语句需开 `multipleStatements` | `>= 8.0` |

类型映射:`pg` 默认把 `int8` 读成字符串(`https://github.com/brianc/node-pg-types`);`postgres` 把 bigint 读成字符串,可配成 `BigInt`;`mysql2` 把 `DECIMAL` 读成字符串,可用 `decimalNumbers` 等选项调整。三者对 Node 24 的明确声明:未查到一手依据(只有上表的 `engines` 下限)。

来源:`https://registry.npmjs.org/pg`、`/postgres`、`/mysql2`;`https://node-postgres.com/features/transactions`;`https://github.com/porsager/postgres`;`https://sidorares.github.io/node-mysql2/docs/api-and-configurations`;仓库最近推送时间来自 GitHub API(`brianc/node-postgres` 2026-09-19、`porsager/postgres` 2026-09-02、`sidorares/node-mysql2` 2026-09-21,均未归档)。

### 3.2 逐类对照

「原样」指语句基本不改;「改写」指要换语法或换做法。

| 类别(第一部分小节) | 本项目用量 | PostgreSQL | MySQL 8.4 |
|---|---|---|---|
| JSON 函数(1.1) | 17 处 | 改写函数名(`jsonb_array_elements` 等,支持 `WITH ORDINALITY`) | 改写,`json_each` 要换 `JSON_TABLE … FOR ORDINALITY` |
| `ON CONFLICT`(1.2) | 8 处 | 原样(`EXCLUDED`) | 改写为 `ON DUPLICATE KEY UPDATE`;`VALUES()` 已弃用,推荐行别名;多唯一键冲突只更新一行 |
| `INSERT OR IGNORE`(1.2) | 5 处 | 改写为 `ON CONFLICT DO NOTHING` | 改写为 `INSERT IGNORE`(会把其它错误降为警告) |
| `RETURNING`(1.3) | 3 处 | 原样 | 无此子句 |
| `lastInsertRowid` / `changes`(1.4) | 14 / 25 处 | 改为 `RETURNING id` 与驱动的行数 | 改为 `insertId` 与驱动的行数;`ON DUPLICATE KEY UPDATE` 计数为 1/2/0 |
| `PRAGMA` / `sqlite_master`(1.5) | 4 / 2 处 | 改写(`information_schema` 等) | 改写(`information_schema`) |
| 自增主键(1.6) | 19 处 | 改写为 identity / bigserial | 改写为 `AUTO_INCREMENT` |
| 部分索引(1.9) | 1 处 | 原样 | 没有部分索引 |
| `CREATE INDEX IF NOT EXISTS`(1.9) | 23 处 | 原样 | 语法里没有 `IF NOT EXISTS` |
| CHECK 约束(1.9) | 47 处 | 原样 | 可用;禁子查询、禁引用 `AUTO_INCREMENT` 列、禁与外键引用动作同列 |
| 事务性 DDL(1.9) | 迁移按事务写 | DDL 可在事务内回滚 | DDL 隐式提交当前事务 |
| `||` 拼接(1.10) | 5 处 | 原样 | 默认是逻辑 OR,须 `CONCAT()` 或 `PIPES_AS_CONCAT` |
| 默认排序规则(1.10) | 等值匹配与唯一约束遍布 | 取决于建库 locale,未查证 | 服务器默认 `utf8mb4_0900_ai_ci`,大小写不敏感 |
| 聚合裸列(1.11) | 1 处(`4248-4257`) | 拒绝(除非函数依赖于主键) | 默认 `ONLY_FULL_GROUP_BY` 拒绝 |
| 行值赋值 `SET (a,b)=(SELECT…)`(1.11) | 2 处 | 原样 | 不支持 |
| 子查询读被写的同一张表(1.11) | 至少 7 处 | 允许 | UPDATE 报 1093;INSERT 文档写明子查询里不能读同一张表;可改多表 UPDATE 或派生表 |
| `BEGIN IMMEDIATE`(1.8) | 9 处 | 无;用行锁、表锁或 Serializable(失败 SQLSTATE 40001 须重试) | 无;用 `SELECT … FOR UPDATE` 等锁定读 |
| 默认隔离级别与 `MAX+1`(1.8) | 6 处 | 默认 Read Committed | 默认 Repeatable Read,普通 SELECT 为快照读 |
| TEXT 列进索引 | 见下 | 原样 | TEXT 键列必须给前缀长度;InnoDB DYNAMIC 行格式前缀上限 3072 字节 |
| 单个大字段 | 审查轨迹 `payload`、会话条目 `entry` 不设上限(`315`、`776-786`) | 单个字段值上限 1 GB | 单个包上限由 `max_allowed_packet` 决定,服务器默认 64 MB、最大 1 GB |

TEXT 键列(MySQL 须改 `VARCHAR(n)` 或加前缀):主键或唯一约束里的 `global_setting.key`(`646`)、`panel_role.name`(`653`)、`panel_user.username`(`664`)、`panel_session.session_hash`(`677`)、`product.name`(`695`)、`webhook_delivery (owner, repo, head_sha)`(`398`)、`review_run_reviewer_pin (run_id, identity)`(`134`)、`review_run_batch_outcome (…, model)`(`152`)、`finding_verdict (run_id, model, finding_id)`(`288`)、`panel_role_permission (role_id, permission)`(`660`)、`panel_user_repo (username, repo_id)`(`688`)、`agent_session_message (session_id, client_message_id)`(`800`)、`agent_session_image (session_id, image_id)`(`814`)、`model_service.provider`(`988`)、`model_service_credential.provider`(`1010`)、`model_directory.provider`(`1033`)、`model_directory_model (provider, model)`(`1068`)、`model_supplement (provider, model)`(`1077`)、`model_service_model_state (provider, model)`(`1089`)、`product_knowledge_entry (product_id, kind, name)`(`746-747`);普通索引里的 `finding_attribution(model)`(`255`)、`finding(file, fingerprint)`(`330`)、`review_run(owner, repo, pull_number)`(`331`)、`range_review(owner, repo, base_sha)`(`377`)、`panel_session(username)`(`682`)、`agent_session(product_id, created_by)`(`774`)、`product_knowledge_entry(product_id, kind)`(`742-743`)。

事务性 DDL 对本项目的影响:`openStore` 当前的补列与回填不在事务里(`store.ts:4568-4576`),本身不依赖事务性 DDL;根 `AGENTS.md` 的变更日志记录过「旧库在启动时一笔事务内升级,中途失败整笔回滚」的迁移(2026-08-25,issue #164),那种写法在 MySQL 上不成立,在 PG 上成立。

来源:
- MySQL 隐式提交:`https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html`
- MySQL UPDATE(1093、赋值语法):`https://dev.mysql.com/doc/refman/8.4/en/update.html`
- MySQL INSERT … SELECT:`https://dev.mysql.com/doc/refman/8.4/en/insert-select.html`
- MySQL INSERT 语法(无 RETURNING):`https://dev.mysql.com/doc/refman/8.4/en/insert.html`
- MySQL `ON DUPLICATE KEY UPDATE`:`https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html`
- MySQL CREATE INDEX(无 IF NOT EXISTS、TEXT 前缀、前缀上限、函数索引):`https://dev.mysql.com/doc/refman/8.4/en/create-index.html`
- MySQL CHECK:`https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html`
- MySQL JSON_TABLE:`https://dev.mysql.com/doc/refman/8.4/en/json-table-functions.html`
- MySQL 隔离级别:`https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html`
- MySQL SQL 模式(`ONLY_FULL_GROUP_BY`、`PIPES_AS_CONCAT`):`https://dev.mysql.com/doc/refman/8.4/en/sql-mode.html`
- MySQL 字符集与排序规则默认值:`https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html`
- MySQL `max_allowed_packet`:`https://dev.mysql.com/doc/refman/8.4/en/packet-too-large.html`
- PG 隔离级别与 40001:`https://www.postgresql.org/docs/17/transaction-iso.html`
- PG UPDATE(行值赋值、RETURNING):`https://www.postgresql.org/docs/17/sql-update.html`
- PG INSERT(ON CONFLICT、EXCLUDED、RETURNING):`https://www.postgresql.org/docs/current/sql-insert.html`
- PG CREATE INDEX(IF NOT EXISTS、部分索引):`https://www.postgresql.org/docs/current/sql-createindex.html`
- PG SELECT 的 GROUP BY 规则:`https://www.postgresql.org/docs/current/sql-select.html`
- PG JSON 函数:`https://www.postgresql.org/docs/current/functions-json.html`
- PG TOAST 1 GB 上限:`https://www.postgresql.org/docs/17/storage-toast.html`
- PG 事务性 DDL:`https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis`(PostgreSQL 官方 wiki)
- Node `node:sqlite`:`https://nodejs.org/api/sqlite.html`

### 3.3 部署面

镜像(Docker Hub 官方镜像,amd64 压缩体积,取自 `https://hub.docker.com/v2/repositories/library/<名>/tags/<标签>`,2026-09-22):

| 镜像 | 压缩体积 | 最近更新 |
|---|---|---|
| `postgres:17` | 约 161 MB | 2026-09-19 |
| `postgres:17-alpine` | 约 117 MB | 2026-09-21 |
| `postgres:16` | 约 160 MB | 2026-09-19 |
| `mysql:8.4` | 约 239 MB | 2026-09-12 |
| `mysql:8.0` | 约 234 MB | 2026-05-05 |

- `postgres` 镜像:`POSTGRES_PASSWORD` 必填;17 及以下把卷挂在 `/var/lib/postgresql/data`,挂在 `/var/lib/postgresql` 不持久;18 起 `PGDATA` 改为按版本的路径(`https://hub.docker.com/_/postgres`)。健康检查的官方惯用写法:该页未提及 `pg_isready` 或 healthcheck,未查到一手依据。`mysql` 镜像的环境变量与健康检查写法未查证。
- 备份一致性:`pg_dump` 在库被并发使用时也导出一致快照,不阻塞读写者(`https://www.postgresql.org/docs/current/app-pgdump.html`)。`mysqldump --single-transaction` 只对 InnoDB 给出一致快照,导出期间的 `ALTER/CREATE/DROP/RENAME/TRUNCATE TABLE` 会破坏一致性(`https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html`)。
- 当前备份范围:根 `AGENTS.md` 写明备份范围是库文件所在目录(含会话图片 `agent-sessions/`),见「部署」节 `MULTIREVIEWER_DB` 条;图片目录由 `src/reviewer/session-images.ts:51` 从库路径推出。换库后图片目录要另给一个位置。

本项目要跟着改的位置:
- `docker-compose.yml:6-39`:只有一个服务 `multireviewer`,卷 `./data:/data`(`36-39`)同时放 SQLite 与工作副本缓存;多一个数据库服务要加服务定义、卷、依赖顺序与健康检查。`stop_grace_period: 900s`(`29`)与排空上限绑定。
- `Dockerfile:81`:`ENV MULTIREVIEWER_DB=/data/multireviewer.db`。
- `src/main.ts:89`:`const dbPath = process.env["MULTIREVIEWER_DB"] ?? "multireviewer.db"`。
- `scripts/setup.sh`:`140`、`216` 的说明文字,`219-236` 创建 `data/` 并探测容器写权限,`369-392` 的自检段把「读 SQLite」作为验收一环,`492` 给出 `sqlite3 data/multireviewer.db` 的查库命令。
- `src/webhook/server.ts:8239-8243`:统计页的库体量取库文件大小。
- `src/review/store.ts:9395-9410`:逐表行数读 `sqlite_master`。

### 3.4 存量数据搬迁

- PostgreSQL:pgloader 官方文档支持从 SQLite 文件加载,自动发现 schema 并建索引;默认类型转换把整数转 `bigint`、字符类转 `text`、日期时间转 `timestamptz`(`https://pgloader.readthedocs.io/en/latest/ref/sqlite.html`)。本项目的时间列是 TEXT,默认规则不会把它们转成时间类型(推断,未实测)。维护状态:GitHub `dimitri/pgloader` 最近推送 2026-09-14,最近一个 release 是 v3.6.9(2022-10-24),GitHub API 报告的许可证为 `NOASSERTION`。
- MySQL:未查到 MySQL 官方提供的 SQLite 导入工具的一手依据。

## 未查清的点

1. 三个驱动(`pg`、`postgres`、`mysql2`)与 `pg-native`、`sync-mysql` 对 Node 24 的明确兼容声明:只有 `engines` 下限,没有一手的 Node 24 测试或声明。
2. `node:sqlite` 返回的行对象是否为 null 原型:Node 文档未写,只有本项目注释(`store.ts:8741-8742`)。
3. MySQL 上 `SUM(integer)` 的结果类型与 `mysql2` 对它的默认读法。
4. PostgreSQL 建库的默认排序规则(取决于镜像初始化时的 locale),对 `ORDER BY owner, repo` 等字符串排序的影响。
5. MySQL 的函数索引或生成列能否表达 `WHERE name <> ''` 这条部分唯一约束(`store.ts:746-747`)。
6. `postgres` 与 `mysql` 官方镜像的健康检查惯用写法。
7. MySQL 方向从 SQLite 搬存量的一手工具。
8. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 在两家的支持情况(本项目补列逻辑 `store.ts:4568-4576` 用得到):本轮未抓取对应的语法页。
9. PG 的 `rtrim(text, text)` 与 `chr(10)`、MySQL 的 `TRIM(TRAILING … FROM …)` 与 `CHAR(10)` 对应 `store.ts:4652`、`1272` 的等价性:本轮未抓取字符串函数页。
10. MySQL 8.0 起 CHECK 约束开始强制执行的具体小版本:8.4 文档未写引入版本。
11. pgloader 的实际许可证:GitHub API 报 `NOASSERTION`,未读仓库 LICENSE 原文。
