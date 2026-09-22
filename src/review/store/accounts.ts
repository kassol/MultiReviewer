/**
 * 面板账号域的持久化(spec #445 第二段):角色、用户、会话与仓库分配。
 *
 * 这一域已经迁到 Drizzle:读写用 builder,行类型从 schema 推导,不再有手抄的列名字符串。
 * 其余各域仍走 `store/pg.ts` 的方言 shim(旧 SQL 原样跑在 PostgreSQL 上),迁法见
 * `src/AGENTS.md` 的「各域迁 Drizzle 的施工指南」。
 */
import { and, asc, count, eq, ne, sql } from "drizzle-orm";

import { isPanelPermission, type PanelPermission } from "../../panel/permissions.ts";
import {
  panelRole,
  panelRolePermission,
  panelSession,
  panelUser,
  panelUserRepo,
} from "../schema/accounts.ts";
import { reviewRun } from "../schema/runs.ts";
import type { PanelRoleRecord, PanelSessionRecord, PanelUserRecord, Store } from "./index.ts";
import type { StoreContext } from "./shared.ts";

type UserRow = typeof panelUser.$inferSelect;

function userRecord(row: UserRow): PanelUserRecord {
  return {
    username: row.username,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    isSystemAdmin: row.isSystemAdmin,
    roleId: row.roleId,
  };
}

type AccountsMethods = Pick<
  Store,
  | "listPanelRoles"
  | "createPanelRole"
  | "updatePanelRole"
  | "removePanelRole"
  | "listPanelUsers"
  | "setPanelUserAssignment"
  | "updatePanelUser"
  | "resetPanelPassword"
  | "countPanelUsers"
  | "getPanelUser"
  | "hasHistoricalRunTrigger"
  | "registerFirstPanelUser"
  | "createPanelUser"
  | "createPanelSession"
  | "getPanelSession"
  | "renewPanelSession"
  | "removePanelSession"
  | "removePanelSessions"
  | "updatePanelPassword"
  | "removePanelUser"
>;

export function accountsMethods({ orm, transaction, store }: StoreContext): AccountsMethods {
  /** 系统管理员 bootstrap 与普通创建共用同一条用户写入语义。 */
  const writeUser = async (record: Omit<PanelUserRecord, "lastLoginAt">): Promise<void> => {
    await orm.insert(panelUser).values({
      username: record.username,
      displayName: record.displayName,
      passwordHash: record.passwordHash,
      mustChangePassword: record.mustChangePassword,
      createdAt: record.createdAt,
      isSystemAdmin: record.isSystemAdmin,
      roleId: record.roleId,
    });
  };

  const writeRolePermissions = async (
    roleId: number,
    permissions: readonly PanelPermission[],
  ): Promise<void> => {
    if (permissions.length === 0) return;
    await orm
      .insert(panelRolePermission)
      .values(permissions.map((permission) => ({ roleId, permission })));
  };

  return {
    async listPanelRoles() {
      const rows = await orm
        .select({
          id: panelRole.id,
          name: panelRole.name,
          createdAt: panelRole.createdAt,
          permission: panelRolePermission.permission,
        })
        .from(panelRole)
        .leftJoin(panelRolePermission, eq(panelRolePermission.roleId, panelRole.id))
        .orderBy(asc(panelRole.id), asc(panelRolePermission.permission));
      const roles: PanelRoleRecord[] = [];
      for (const row of rows) {
        let role = roles.find((item) => item.id === row.id);
        if (role === undefined) {
          role = { id: row.id, name: row.name, permissions: [], createdAt: row.createdAt };
          roles.push(role);
        }
        if (row.permission !== null && isPanelPermission(row.permission)) {
          role.permissions.push(row.permission);
        }
      }
      return roles;
    },

    async createPanelRole(record) {
      return await transaction("deferred", async () => {
        const [inserted] = await orm
          .insert(panelRole)
          .values({ name: record.name, createdAt: record.createdAt })
          .returning({ id: panelRole.id });
        const id = inserted!.id;
        await writeRolePermissions(id, record.permissions);
        return { id, ...record, permissions: [...record.permissions] };
      });
    },

    async updatePanelRole(id, record) {
      const existing = await orm
        .select({ id: panelRole.id })
        .from(panelRole)
        .where(eq(panelRole.id, id));
      if (existing.length === 0) return undefined;
      await transaction("deferred", async () => {
        await orm.update(panelRole).set({ name: record.name }).where(eq(panelRole.id, id));
        await orm.delete(panelRolePermission).where(eq(panelRolePermission.roleId, id));
        await writeRolePermissions(id, record.permissions);
      });
      return (await store().listPanelRoles()).find((role) => role.id === id);
    },

    async removePanelRole(id) {
      const holders = await orm
        .select({ username: panelUser.username })
        .from(panelUser)
        .where(eq(panelUser.roleId, id))
        .orderBy(asc(panelUser.username));
      const usernames = holders.map((row) => row.username);
      if (usernames.length > 0) return { removed: false, usernames };
      return await transaction("deferred", async () => {
        await orm.delete(panelRolePermission).where(eq(panelRolePermission.roleId, id));
        const removed = await orm
          .delete(panelRole)
          .where(eq(panelRole.id, id))
          .returning({ id: panelRole.id });
        return { removed: removed.length > 0, usernames: [] };
      });
    },

    async listPanelUsers() {
      const assigned = new Map<string, number[]>();
      const rows = await orm
        .select({ username: panelUserRepo.username, repoId: panelUserRepo.repoId })
        .from(panelUserRepo)
        .orderBy(asc(panelUserRepo.repoId));
      for (const row of rows) {
        const repoIds = assigned.get(row.username);
        if (repoIds === undefined) assigned.set(row.username, [row.repoId]);
        else repoIds.push(row.repoId);
      }
      const users = await orm.select().from(panelUser).orderBy(asc(panelUser.username));
      return users.map((row) => ({
        ...userRecord(row),
        repoIds: assigned.get(row.username) ?? [],
      }));
    },

    async setPanelUserAssignment(username, repoIds) {
      await transaction("deferred", async () => {
        await orm.delete(panelUserRepo).where(eq(panelUserRepo.username, username));
        // 重复的 repo id 只落一行:整组覆盖说的是集合,不是列表。
        const unique = [...new Set(repoIds)];
        if (unique.length === 0) return;
        await orm
          .insert(panelUserRepo)
          .values(unique.map((repoId) => ({ username, repoId })))
          .onConflictDoNothing();
      });
    },

    async updatePanelUser(username, record) {
      const prior = await store().getPanelUser(username);
      if (prior === undefined) return "missing";
      return await transaction<"updated" | "missing" | "last-system-admin">(
        "deferred",
        async (tx) => {
          await orm
            .update(panelUser)
            .set({
              displayName: record.displayName,
              roleId: record.roleId,
              isSystemAdmin: record.isSystemAdmin,
            })
            .where(eq(panelUser.username, username));
          const [admins] = await orm
            .select({ value: count() })
            .from(panelUser)
            .where(eq(panelUser.isSystemAdmin, true));
          if ((admins?.value ?? 0) === 0) return tx.rollback("last-system-admin");
          return "updated";
        },
      );
    },

    async resetPanelPassword(username, passwordHash) {
      return await transaction("deferred", async () => {
        const updated = await orm
          .update(panelUser)
          .set({ passwordHash, mustChangePassword: true })
          .where(eq(panelUser.username, username))
          .returning({ username: panelUser.username });
        await orm.delete(panelSession).where(eq(panelSession.username, username));
        return updated.length > 0;
      });
    },

    async countPanelUsers() {
      const [row] = await orm.select({ value: count() }).from(panelUser);
      return row?.value ?? 0;
    },

    async getPanelUser(username) {
      const [row] = await orm.select().from(panelUser).where(eq(panelUser.username, username));
      return row === undefined ? undefined : userRecord(row);
    },

    async hasHistoricalRunTrigger(username) {
      const rows = await orm
        .select({ id: reviewRun.id })
        .from(reviewRun)
        .where(eq(reviewRun.triggeredBy, username))
        .limit(1);
      return rows.length > 0;
    },

    async registerFirstPanelUser(record) {
      // 「查与插是一个决定」:事务里先把用户表锁住再数,两个 bootstrap 请求撞上时后到的
      // 那个数到的是 1。SQLite 那一版靠 `BEGIN IMMEDIATE` 拿写锁,PostgreSQL 在这里显式
      // 锁表——零用户时没有父行可以 `FOR UPDATE`(ADR 0036)。
      return await transaction("immediate", async (tx) => {
        await orm.execute(sql`LOCK TABLE ${panelUser} IN SHARE ROW EXCLUSIVE MODE`);
        const [row] = await orm.select({ value: count() }).from(panelUser);
        if ((row?.value ?? 0) !== 0) return tx.rollback(false);
        await writeUser(record);
        return true;
      });
    },

    async createPanelUser(record) {
      await writeUser(record);
    },

    async createPanelSession(record) {
      await orm.insert(panelSession).values({
        sessionHash: record.sessionHash,
        username: record.username,
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
      });
      await orm
        .update(panelUser)
        .set({ lastLoginAt: record.createdAt })
        .where(eq(panelUser.username, record.username));
    },

    async getPanelSession(hash) {
      const [row] = await orm
        .select({
          username: panelUser.username,
          displayName: panelUser.displayName,
          mustChangePassword: panelUser.mustChangePassword,
          isSystemAdmin: panelUser.isSystemAdmin,
          roleId: panelUser.roleId,
          expiresAt: panelSession.expiresAt,
        })
        .from(panelSession)
        .innerJoin(panelUser, eq(panelUser.username, panelSession.username))
        .where(eq(panelSession.sessionHash, hash));
      return row as PanelSessionRecord | undefined;
    },

    async renewPanelSession(hash, expiresAt) {
      await orm
        .update(panelSession)
        .set({ expiresAt })
        .where(eq(panelSession.sessionHash, hash));
    },

    async removePanelSession(hash) {
      await orm.delete(panelSession).where(eq(panelSession.sessionHash, hash));
    },

    async removePanelSessions(username, exceptHash) {
      await orm
        .delete(panelSession)
        .where(
          exceptHash === undefined
            ? eq(panelSession.username, username)
            : and(
                eq(panelSession.username, username),
                ne(panelSession.sessionHash, exceptHash),
              ),
        );
    },

    async updatePanelPassword(username, passwordHash, mustChangePassword) {
      await orm
        .update(panelUser)
        .set({ passwordHash, mustChangePassword })
        .where(eq(panelUser.username, username));
    },

    async removePanelUser(username) {
      await transaction("deferred", async () => {
        await orm.delete(panelSession).where(eq(panelSession.username, username));
        await orm.delete(panelUserRepo).where(eq(panelUserRepo.username, username));
        await orm.delete(panelUser).where(eq(panelUser.username, username));
      });
    },
  };
}

