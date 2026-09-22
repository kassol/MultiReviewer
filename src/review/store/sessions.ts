/**
 * Agent 会话域的持久化(spec #445 第二段):会话本身、会话记录、受理过的客户端消息 id、
 * 图片与排队消息。
 *
 * 这一域已经迁到 Drizzle:读写用 builder,行类型从 schema 推导,不再走 `store/pg.ts` 的
 * 方言 shim。迁法见 `src/AGENTS.md` 的「各域迁 Drizzle 的施工指南」。
 *
 * 两处并发点按 ADR 0036 锁会话那一行:记录的会话内序号是 `MAX(seq) + 1`,排队消息的取走
 * 是「先读后删」——不锁的话两个连接会算出同一个序号、或者把同一条排队消息各取走一遍。
 */
import { and, asc, desc, eq, getTableColumns, gt, gte, lte, lt, max, sql, sum } from "drizzle-orm";

import {
  agentSession,
  agentSessionEntry,
  agentSessionImage,
  agentSessionMessage,
  agentSessionPendingMessage,
} from "../schema/sessions.ts";
import type {
  AgentSessionBaseline,
  AgentSessionEntryRecord,
  AgentSessionPendingMessage,
  AgentSessionPurpose,
  AgentSessionRecord,
  AgentSessionStatus,
  Store,
} from "./index.ts";
import type { StoreContext } from "./shared.ts";

/** 库里那一列的形状:记来源种类之前落下的行没有 `kind`,读的时候补成分支。 */
type StoredAgentSessionBaseline = Omit<AgentSessionBaseline, "kind"> & {
  kind?: AgentSessionBaseline["kind"];
};

type SessionRow = typeof agentSession.$inferSelect & {
  titleRaw: string | null;
  lastActiveAt: string;
};

type EntryRow = typeof agentSessionEntry.$inferSelect;

/**
 * 会话列表按用途分不清是哪一个(面板只显示「开放对话」),标题与最后动静都是读时从记录表
 * 派生、不落库的两列(不必迁移):
 *
 * - `title_raw` 是这个会话第一条用户消息的正文——`agent_session_entry.type = 'message'`
 *   且 `entry.message.role = 'user'`,按 `seq` 取最早那一条。正文是纯字符串时直接读;是分块
 *   数组时(带图的消息,ADR 0031 的图片例外)取第一个 `type: "text"` 的块,不能假定它在
 *   下标 0——图片块可能排在文字前面。折成面板要的那一档在 JS 侧的 `agentSessionTitle` 做。
 * - `last_active_at` 是这个会话记录表的 `MAX(at)`;还没有记录(刚建、或种子消息还没落下)
 *   时落 `created_at`。
 */
const TITLE_RAW = sql<string | null>`(
  SELECT CASE
    WHEN jsonb_typeof(e.entry->'message'->'content') = 'array' THEN (
      SELECT part.value->>'text'
        FROM jsonb_array_elements(e.entry->'message'->'content')
             WITH ORDINALITY AS part(value, ord)
       WHERE part.value->>'type' = 'text'
       ORDER BY part.ord
       LIMIT 1
    )
    ELSE e.entry->'message'->>'content'
  END
    FROM ${agentSessionEntry} e
   WHERE e.session_id = ${agentSession.id}
     AND e.type = 'message'
     AND e.entry->'message'->>'role' = 'user'
   ORDER BY e.seq
   LIMIT 1
)`;

// `mapWith` 接的是时刻列自己的读法(`schema/columns.ts`):`sql` 模板绕过了列类型,不接
// 这一句读回来的是 PostgreSQL 的原文(`2026-09-12 00:20:00+00`)而不是 ISO。
const LAST_ACTIVE_AT = sql<string>`COALESCE(
  (SELECT MAX(${agentSessionEntry.at}) FROM ${agentSessionEntry}
    WHERE ${agentSessionEntry.sessionId} = ${agentSession.id}),
  ${agentSession.createdAt}
)`.mapWith(agentSession.createdAt);

/**
 * `titleRaw`(上面那条查询抠出来的第一条用户消息文本)收成面板要的那一档:去首尾空白、
 * 连续空白折成一个、截到 80 字——不加省略号,视觉上的截断由面板做。没有这条消息、或文本
 * 折下来是空串时都算 null——空标题不该占位。
 */
function agentSessionTitle(raw: string | null): string | null {
  if (raw === null) return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return collapsed === "" ? null : collapsed.slice(0, 80);
}

function sessionRecord(row: SessionRow): AgentSessionRecord {
  return {
    id: row.id,
    productId: row.productId,
    createdBy: row.createdBy,
    purpose: row.purpose as AgentSessionPurpose,
    status: row.status as AgentSessionStatus,
    createdAt: row.createdAt,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
    },
    // 这一票之前的会话行没有这一列:读作空列表。记来源种类(issue #355)之前落下的行没有
    // `kind`:那时只有分支一种来源,读作分支,不回填。
    baselines:
      row.baselines === null
        ? []
        : (JSON.parse(row.baselines) as StoredAgentSessionBaseline[]).map((one) => ({
            ...one,
            kind: one.kind ?? "branch",
          })),
    completedAt: row.completedAt,
    // 产品梳理的第一条「用户」消息是开场时投的那条访谈指令,不是人说的话,不当标题。
    title: row.purpose === "product-survey" ? null : agentSessionTitle(row.titleRaw),
    lastActiveAt: row.lastActiveAt,
  };
}

function entryRecord(row: EntryRow): AgentSessionEntryRecord {
  return {
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type,
    at: row.at,
    entry: JSON.parse(row.entry) as unknown,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
    },
  };
}

function pendingMessage(row: typeof agentSessionPendingMessage.$inferSelect): AgentSessionPendingMessage {
  return {
    mode: row.mode,
    text: row.text,
    ...(row.images === null ? {} : { images: row.images }),
  };
}

type SessionsMethods = Pick<
  Store,
  | "listAgentSessions"
  | "getAgentSession"
  | "createAgentSession"
  | "completeAgentSession"
  | "setAgentSessionBaselines"
  | "deleteAgentSession"
  | "addAgentSessionImage"
  | "getAgentSessionImage"
  | "appendAgentSessionEntry"
  | "listAgentSessionEntries"
  | "agentSessionEntryPage"
  | "acceptedAgentSessionMessage"
  | "acceptAgentSessionMessage"
  | "putAgentSessionPendingMessages"
  | "takeAgentSessionPendingMessages"
  | "listAgentSessionPendingMessages"
  | "agentSessionEntryLinks"
  | "agentSessionUsageStats"
>;

export function sessionsMethods({ orm, transaction }: StoreContext): SessionsMethods {
  const sessionColumns = {
    ...getTableColumns(agentSession),
    titleRaw: TITLE_RAW,
    lastActiveAt: LAST_ACTIVE_AT,
  };

  /**
   * 这个会话下的全部子表行。删会话与删产品级联都要删它们;删产品那一侧在自己的域里,
   * 共用件 `deleteAgentSessionRows` 仍是 shim 的那一份(#455 迁完之后两份收成一份)。
   */
  const deleteChildRows = async (sessionId: number): Promise<void> => {
    await orm.delete(agentSessionEntry).where(eq(agentSessionEntry.sessionId, sessionId));
    await orm.delete(agentSessionMessage).where(eq(agentSessionMessage.sessionId, sessionId));
    await orm.delete(agentSessionImage).where(eq(agentSessionImage.sessionId, sessionId));
    await orm
      .delete(agentSessionPendingMessage)
      .where(eq(agentSessionPendingMessage.sessionId, sessionId));
  };

  /**
   * 事务里先把这个会话那一行锁住(ADR 0036)。序号是 `MAX + 1`、排队消息是「先读后删」,
   * 两处都要在同一条会话上串起来——SQLite 那一版靠的是单写者锁。
   */
  const lockSession = async (sessionId: number): Promise<void> => {
    await orm.execute(
      sql`SELECT 1 FROM ${agentSession} WHERE ${agentSession.id} = ${sessionId} FOR UPDATE`,
    );
  };

  const pendingOf = async (sessionId: number): Promise<AgentSessionPendingMessage[]> =>
    (
      await orm
        .select()
        .from(agentSessionPendingMessage)
        .where(eq(agentSessionPendingMessage.sessionId, sessionId))
        .orderBy(asc(agentSessionPendingMessage.seq))
    ).map(pendingMessage);

  return {
    async listAgentSessions(productId, createdBy) {
      const rows = await orm
        .select(sessionColumns)
        .from(agentSession)
        .where(
          createdBy === null
            ? eq(agentSession.productId, productId)
            : and(eq(agentSession.productId, productId), eq(agentSession.createdBy, createdBy)),
        )
        .orderBy(desc(agentSession.id));
      return rows.map(sessionRecord);
    },

    async getAgentSession(sessionId) {
      const [row] = await orm
        .select(sessionColumns)
        .from(agentSession)
        .where(eq(agentSession.id, sessionId));
      return row === undefined ? undefined : sessionRecord(row);
    },

    async createAgentSession(record) {
      // 建会话时人已经按仓库选好了基点(issue #352):那一份跟着 INSERT 一起落下,工作树
      // 按它检出。不给即这一刻还不知道停在哪,首次备树时再写。
      const baselines = record.baselines ?? [];
      const [inserted] = await orm
        .insert(agentSession)
        .values({
          productId: record.productId,
          createdBy: record.createdBy,
          purpose: record.purpose,
          status: "idle",
          createdAt: record.createdAt,
          baselines: JSON.stringify(baselines),
        })
        .returning({ id: agentSession.id });
      return {
        id: inserted!.id,
        productId: record.productId,
        createdBy: record.createdBy,
        purpose: record.purpose,
        createdAt: record.createdAt,
        status: "idle",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        baselines: [...baselines],
        completedAt: null,
        // 刚建的会话还没有记录:标题没有第一条用户消息可取,最后动静就是建会话那一刻。
        title: null,
        lastActiveAt: record.createdAt,
      };
    },

    async completeAgentSession(sessionId, at) {
      await orm.update(agentSession).set({ completedAt: at }).where(eq(agentSession.id, sessionId));
    },

    async setAgentSessionBaselines(sessionId, baselines) {
      await orm
        .update(agentSession)
        .set({ baselines: JSON.stringify(baselines) })
        .where(eq(agentSession.id, sessionId));
    },

    async deleteAgentSession(sessionId) {
      return transaction("deferred", async () => {
        // 记录、受理过的消息 id、图片与排队消息只属于这个会话,跟着它走(issue #333、#336)。
        await deleteChildRows(sessionId);
        const removed = await orm
          .delete(agentSession)
          .where(eq(agentSession.id, sessionId))
          .returning({ id: agentSession.id });
        return removed.length > 0;
      });
    },

    async addAgentSessionImage(record) {
      await orm.insert(agentSessionImage).values({
        sessionId: record.sessionId,
        imageId: record.imageId,
        path: record.path,
        mimeType: record.mimeType,
        createdAt: record.createdAt,
      });
    },

    async getAgentSessionImage(sessionId, imageId) {
      const [row] = await orm
        .select()
        .from(agentSessionImage)
        .where(
          and(eq(agentSessionImage.sessionId, sessionId), eq(agentSessionImage.imageId, imageId)),
        );
      return row;
    },

    async appendAgentSessionEntry(sessionId, input) {
      return transaction("deferred", async () => {
        // 序号在锁住这一行之后才算:两条并发的落库不锁的话会算出同一个 seq,主键当场撞上。
        await lockSession(sessionId);
        const [top] = await orm
          .select({ seq: max(agentSessionEntry.seq) })
          .from(agentSessionEntry)
          .where(eq(agentSessionEntry.sessionId, sessionId));
        const seq = (top?.seq ?? 0) + 1;
        await orm.insert(agentSessionEntry).values({
          sessionId,
          seq,
          type: input.type,
          at: input.at,
          entry: JSON.stringify(input.entry),
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          totalTokens: input.usage.totalTokens,
        });
        await orm
          .update(agentSession)
          .set({
            inputTokens: sql`${agentSession.inputTokens} + ${input.usage.inputTokens}`,
            outputTokens: sql`${agentSession.outputTokens} + ${input.usage.outputTokens}`,
            cacheReadTokens: sql`${agentSession.cacheReadTokens} + ${input.usage.cacheReadTokens}`,
            cacheWriteTokens: sql`${agentSession.cacheWriteTokens} + ${input.usage.cacheWriteTokens}`,
            totalTokens: sql`${agentSession.totalTokens} + ${input.usage.totalTokens}`,
          })
          .where(eq(agentSession.id, sessionId));
        return { sessionId, seq, type: input.type, at: input.at, entry: input.entry, usage: input.usage };
      });
    },

    async listAgentSessionEntries(sessionId, afterSeq = 0) {
      const rows = await orm
        .select()
        .from(agentSessionEntry)
        .where(and(eq(agentSessionEntry.sessionId, sessionId), gt(agentSessionEntry.seq, afterSeq)))
        .orderBy(asc(agentSessionEntry.seq));
      return rows.map(entryRecord);
    },

    async agentSessionEntryPage(sessionId, before, limit) {
      // 多取一条:它的存在就是「这一页之前还有更早的」,不必再查一次 count。
      const rows = await orm
        .select()
        .from(agentSessionEntry)
        .where(
          before === undefined
            ? eq(agentSessionEntry.sessionId, sessionId)
            : and(eq(agentSessionEntry.sessionId, sessionId), lt(agentSessionEntry.seq, before)),
        )
        .orderBy(desc(agentSessionEntry.seq))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      return { records: rows.slice(0, limit).reverse().map(entryRecord), hasMore };
    },

    async acceptedAgentSessionMessage(sessionId, clientMessageId) {
      const [row] = await orm
        .select({ acceptedAt: agentSessionMessage.acceptedAt })
        .from(agentSessionMessage)
        .where(
          and(
            eq(agentSessionMessage.sessionId, sessionId),
            eq(agentSessionMessage.clientMessageId, clientMessageId),
          ),
        );
      return row?.acceptedAt;
    },

    async acceptAgentSessionMessage(sessionId, clientMessageId, at) {
      // 主键挡重入队:插入不成立即这个 id 已经受理过,回第一次那一刻。先查后插在并发两次
      // 提交时挡不住,主键挡得住。
      const inserted = await orm
        .insert(agentSessionMessage)
        .values({ sessionId, clientMessageId, acceptedAt: at })
        .onConflictDoNothing()
        .returning({ acceptedAt: agentSessionMessage.acceptedAt });
      if (inserted.length > 0) return { acceptedAt: at, fresh: true };
      const [row] = await orm
        .select({ acceptedAt: agentSessionMessage.acceptedAt })
        .from(agentSessionMessage)
        .where(
          and(
            eq(agentSessionMessage.sessionId, sessionId),
            eq(agentSessionMessage.clientMessageId, clientMessageId),
          ),
        );
      return { acceptedAt: row!.acceptedAt, fresh: false };
    },

    async putAgentSessionPendingMessages(sessionId, messages) {
      await transaction("deferred", async () => {
        await lockSession(sessionId);
        await orm
          .delete(agentSessionPendingMessage)
          .where(eq(agentSessionPendingMessage.sessionId, sessionId));
        if (messages.length === 0) return;
        await orm.insert(agentSessionPendingMessage).values(
          messages.map((message, index) => ({
            sessionId,
            seq: index + 1,
            mode: message.mode,
            text: message.text,
            images: message.images ?? null,
          })),
        );
      });
    },

    async takeAgentSessionPendingMessages(sessionId) {
      // 「取出即删」要整段原子:先锁住会话那一行,另一个连接因此排在后面,读到的是空队列
      // ——同一条排队消息不会被两边各投一次(issue #401 在 PG 上的对应物)。
      return transaction("immediate", async () => {
        await lockSession(sessionId);
        const messages = await pendingOf(sessionId);
        await orm
          .delete(agentSessionPendingMessage)
          .where(eq(agentSessionPendingMessage.sessionId, sessionId));
        return messages;
      });
    },

    async listAgentSessionPendingMessages(sessionId) {
      return await pendingOf(sessionId);
    },

    async agentSessionEntryLinks(sessionId) {
      return await orm
        .select({
          id: sql<string | null>`${agentSessionEntry.entry}->>'id'`,
          parentId: sql<string | null>`${agentSessionEntry.entry}->>'parentId'`,
          firstKeptEntryId: sql<string | null>`${agentSessionEntry.entry}->>'firstKeptEntryId'`,
        })
        .from(agentSessionEntry)
        .where(eq(agentSessionEntry.sessionId, sessionId))
        .orderBy(asc(agentSessionEntry.seq));
    },

    async agentSessionUsageStats(from, to, createdBy) {
      const window = and(gte(agentSession.createdAt, from), lte(agentSession.createdAt, to));
      const [row] = await orm
        .select({
          sessions: sql<number>`COUNT(*)`,
          inputTokens: sum(agentSession.inputTokens),
          outputTokens: sum(agentSession.outputTokens),
          cacheReadTokens: sum(agentSession.cacheReadTokens),
          cacheWriteTokens: sum(agentSession.cacheWriteTokens),
          totalTokens: sum(agentSession.totalTokens),
        })
        .from(agentSession)
        .where(createdBy === null ? window : and(window, eq(agentSession.createdBy, createdBy)));
      const sessions = Number(row?.sessions ?? 0);
      if (sessions === 0) return undefined;
      return {
        sessions,
        inputTokens: Number(row!.inputTokens ?? 0),
        outputTokens: Number(row!.outputTokens ?? 0),
        cacheReadTokens: Number(row!.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(row!.cacheWriteTokens ?? 0),
        totalTokens: Number(row!.totalTokens ?? 0),
      };
    },
  };
}
