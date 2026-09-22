import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 的配置(ADR 0036)。只做一件事:按 `src/review/schema/` 生成进版本库的迁移
 * SQL。迁移的执行在服务启动时(`src/main.ts`),不用 `drizzle-kit migrate` / `push`。
 *
 *   pnpm drizzle-kit generate
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/review/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
});
