import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { isoTimestamp } from "./columns.ts";
import { repo } from "./repos.ts";

export const panelRole = pgTable("panel_role", {
  id: integer().generatedByDefaultAsIdentity().primaryKey(),
  name: text().notNull().unique(),
  createdAt: isoTimestamp("created_at").notNull(),
});

export const panelRolePermission = pgTable(
  "panel_role_permission",
  {
    roleId: integer("role_id")
      .notNull()
      .references(() => panelRole.id),
    permission: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const panelUser = pgTable(
  "panel_user",
  {
    username: text().primaryKey(),
    displayName: text("display_name"),
    passwordHash: text("password_hash").notNull(),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    createdAt: isoTimestamp("created_at").notNull(),
    lastLoginAt: isoTimestamp("last_login_at"),
    isSystemAdmin: boolean("is_system_admin").notNull().default(false),
    roleId: integer("role_id").references(() => panelRole.id),
  },
  // 系统管理员始终全权限,不挂角色(ADR 0018)。原来还有一条 `is_system_admin IN (0, 1)`,
  // 换成 boolean 列之后由类型本身表达,不再需要。
  (t) => [
    check("panel_user_admin_has_no_role", sql`${t.isSystemAdmin} = false OR ${t.roleId} IS NULL`),
  ],
);

export const panelSession = pgTable(
  "panel_session",
  {
    sessionHash: text("session_hash").primaryKey(),
    username: text()
      .notNull()
      .references(() => panelUser.username),
    expiresAt: isoTimestamp("expires_at").notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [index("panel_session_by_user").on(t.username)],
);

/** 仓库分配:一个用户能看见并操作的仓库集合。系统管理员不受限,不在这里留行。 */
export const panelUserRepo = pgTable(
  "panel_user_repo",
  {
    username: text()
      .notNull()
      .references(() => panelUser.username),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
  },
  (t) => [primaryKey({ columns: [t.username, t.repoId] })],
);
