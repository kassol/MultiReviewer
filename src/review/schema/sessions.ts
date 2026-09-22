import { index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { isoTimestamp, jsonText } from "./columns.ts";
import { product } from "./products.ts";

/**
 * Agent 会话(issue #332)。挂在产品上,创建者是唯一能续谈与删除它的人;用途建时定、之后不变。
 * 用量五列与 reviewRun 同口径,按条目累加,所以不可空。删产品级联硬删它下面的会话行。
 */
export const agentSession = pgTable(
  "agent_session",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => product.id),
    createdBy: text("created_by").notNull(),
    purpose: text().notNull(),
    status: text().notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** 这个会话每个仓库开在哪个 commit(issue #351、#352)。NULL 读作空列表。 */
    baselines: jsonText(),
    /** 产品梳理谈完的时刻(issue #365)。别的用途恒为 NULL。 */
    completedAt: isoTimestamp("completed_at"),
  },
  // 列表只有一种查法:一个产品下某个人的会话(系统管理员读同一个产品下的全部)。
  (t) => [index("agent_session_by_product").on(t.productId, t.createdBy)],
);

/**
 * 会话记录(ADR 0031,issue #333)。一行一条 Pi 的 SessionEntry 原样 JSON:条目形状跟着 Pi
 * 走,本项目不另造一套消息表。type / at 与四列用量是索引列,从那份 JSON 里抄出来。
 */
export const agentSessionEntry = pgTable(
  "agent_session_entry",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => agentSession.id),
    seq: integer().notNull(),
    type: text().notNull(),
    at: isoTimestamp().notNull(),
    entry: jsonText().notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/**
 * 发过的客户端消息 id(issue #333)。主键挡住重入队:同一个 id 重发时插入不成立,接口回的是
 * 第一次的受理结果。
 */
export const agentSessionMessage = pgTable(
  "agent_session_message",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => agentSession.id),
    clientMessageId: text("client_message_id").notNull(),
    acceptedAt: isoTimestamp("accepted_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.clientMessageId] })],
);

/**
 * 会话图片(issue #336)。文件在 data 目录下,库里只存路径与 mimeType(base64 一律不进库)。
 * 发消息时按 id 认领这几张图,因此主键是两列。
 */
export const agentSessionImage = pgTable(
  "agent_session_image",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => agentSession.id),
    imageId: text("image_id").notNull(),
    path: text().notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.imageId] })],
);

/**
 * 还没投递出去的排队消息(issue #335)。投递出去就整段删掉——「排着」的定义就是「还没投出
 * 去」,留着就会重复投。
 */
export const agentSessionPendingMessage = pgTable(
  "agent_session_pending_message",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => agentSession.id),
    seq: integer().notNull(),
    mode: text().notNull(),
    text: text().notNull(),
    /** 这一条带的那几张图的文件引用,原样一段 JSON(issue #336)。没带图即 NULL。 */
    images: jsonText(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);
