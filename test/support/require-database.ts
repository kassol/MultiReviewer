/**
 * 测试跑在真的 PostgreSQL 上(ADR 0036)。没设连接串就整套拒跑并说清怎么起一个——
 * 让九十个测试文件各自报一遍「连不上」,人要翻到第一条才看得出差的是什么。
 *
 * `pnpm test` 在 `node --test` 之前跑它;夹具 `makeTestDatabase()` 读的是同一个变量。
 */
export const TEST_DATABASE_URL_ENV = "MULTIREVIEWER_TEST_DATABASE_URL";

const HOW_TO_START = `测试要一个真的 PostgreSQL,环境变量 ${TEST_DATABASE_URL_ENV} 没设。

起一个本机实例(仓库根的 docker-compose.test.yml):
  docker compose -f docker-compose.test.yml up -d

再把连接串交给测试:
  export ${TEST_DATABASE_URL_ENV}=postgres://multireviewer:multireviewer@127.0.0.1:54329/multireviewer

这个账号要有 CREATE DATABASE 权限:夹具按测试文件建库、跑迁移、跑完删库。`;

export function requireTestDatabaseUrl(): string {
  const url = process.env[TEST_DATABASE_URL_ENV];
  if (url === undefined || url === "") throw new Error(HOW_TO_START);
  return url;
}

// 直接被 `node` 跑起来时(`pnpm test` 的第一步)只做这一道闸。
if (process.argv[1]?.endsWith("require-database.ts") === true) {
  const url = process.env[TEST_DATABASE_URL_ENV];
  if (url === undefined || url === "") {
    console.error(HOW_TO_START);
    process.exit(1);
  }
}
