/**
 * 数据库 schema 的单一来源(ADR 0036)。按域一个文件,这里汇总给 drizzle-kit 与运行时用。
 * 改这里就是改 schema:改完跑 `pnpm drizzle-kit generate` 生成一份进版本库的迁移 SQL,
 * 服务启动时在监听之前执行它。不再有开库时的全量 DDL 与按列补齐的升级路径。
 */
export * from "./accounts.ts";
export * from "./knowledge.ts";
export * from "./products.ts";
export * from "./repos.ts";
export * from "./runs.ts";
export * from "./sessions.ts";
export * from "./stages.ts";
