import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { isoTimestamp, jsonText } from "./columns.ts";
import { repo } from "./repos.ts";

/** 产品(issue #331)。名称的唯一性由 UNIQUE 表达,重名由写入口接住约束报错回 409。 */
export const product = pgTable("product", {
  id: integer().generatedByDefaultAsIdentity().primaryKey(),
  name: text().notNull().unique(),
  createdAt: isoTimestamp("created_at").notNull(),
});

/**
 * 产品的仓库集合。主键是 repoId:「一个仓库至多属一个产品」这条由它表达,不靠写入口先查一遍
 * 再插——并发两次归属时应用层那一查挡不住,主键挡得住。
 */
export const productRepo = pgTable(
  "product_repo",
  {
    repoId: integer("repo_id")
      .primaryKey()
      .references(() => repo.id),
    productId: integer("product_id")
      .notNull()
      .references(() => product.id),
    addedAt: isoTimestamp("added_at").notNull(),
    /** 仓库职责(issue #341):挂在归属关系上,摘出时跟着归属行一起消失。 */
    role: text(),
  },
  (t) => [index("product_repo_by_product").on(t.productId)],
);

/**
 * 产品知识(ADR 0032 与 0035,issue #360)。三种条目一张表:kind 说它是术语条目、仓库关系
 * 还是产品决策。逐格的含义按 kind 分,详见 CONTEXT.md。
 */
export const productKnowledgeEntry = pgTable(
  "product_knowledge_entry",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => product.id),
    kind: text().notNull(),
    /** 术语的名称、决策的标题;仓库关系没有名字,落空串。 */
    name: text().notNull(),
    body: text().notNull(),
    topic: text(),
    /** 术语要避免的同义词,JSON 数组;另两种是空数组。 */
    avoided: jsonText().notNull(),
    options: text(),
    consequences: text(),
    supersededBy: integer("superseded_by").references((): AnyPgColumn => productKnowledgeEntry.id),
    /** 出处附注,一段 { location, reason } 的 JSON 数组。只在产品页展示,不进提示。 */
    annotations: jsonText().notNull(),
    writtenAt: isoTimestamp("written_at").notNull(),
    writtenBySessionId: integer("written_by_session_id"),
  },
  (t) => [
    index("product_knowledge_entry_by_product").on(t.productId, t.kind),
    // 一个产品内一个名字只有一条:术语与决策都按名字读整条。仓库关系没有名字(空串),因此
    // 排除在这道唯一性之外。
    uniqueIndex("product_knowledge_entry_by_name")
      .on(t.productId, t.kind, t.name)
      .where(sql`${t.name} <> ''`),
    check("product_knowledge_entry_kind", sql`${t.kind} IN ('term', 'relationship', 'decision')`),
  ],
);

/**
 * 产品 tracker 的一条 spec(issue #361)。正文只由会话经工具写,sessionId 记下是哪一场写的
 * (不设外键:删会话不该把它写下的 spec 一并带走)。
 */
export const productSpec = pgTable(
  "product_spec",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => product.id),
    title: text().notNull(),
    body: text().notNull(),
    state: text().notNull(),
    sessionId: integer("session_id"),
    createdAt: isoTimestamp("created_at").notNull(),
    stateChangedAt: isoTimestamp("state_changed_at").notNull(),
  },
  (t) => [
    index("product_spec_by_product").on(t.productId),
    check("product_spec_state", sql`${t.state} IN ('open', 'closed')`),
  ],
);

/**
 * 一张票(issue #361)。挂在 spec 上,产品经 spec 推出来——票不另存一格 productId:两处存同
 * 一件事就能不一致。五个 triage 标签是固定字段值(ADR 0035),由 CHECK 表达。
 */
export const productTicket = pgTable(
  "product_ticket",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    specId: integer("spec_id")
      .notNull()
      .references(() => productSpec.id),
    title: text().notNull(),
    body: text().notNull(),
    label: text().notNull(),
    state: text().notNull(),
    claimedBy: text("claimed_by"),
    sessionId: integer("session_id"),
    createdAt: isoTimestamp("created_at").notNull(),
    stateChangedAt: isoTimestamp("state_changed_at").notNull(),
  },
  (t) => [
    index("product_ticket_by_spec").on(t.specId),
    check(
      "product_ticket_label",
      sql`${t.label} IN ('needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human',
        'wontfix')`,
    ),
    check("product_ticket_state", sql`${t.state} IN ('open', 'closed')`),
  ],
);

/**
 * 阻塞边:ticketId 这张票被 blockedById 那张票挡着。自指由 CHECK 挡下——一条边只可能来自写
 * 入口,而写入口要说出打回的理由,两处因此各判一次:这里是兜底,理由在那边。
 */
export const productTicketBlock = pgTable(
  "product_ticket_block",
  {
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => productTicket.id),
    blockedById: integer("blocked_by_id")
      .notNull()
      .references(() => productTicket.id),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.blockedById] }),
    check("product_ticket_block_not_self", sql`${t.ticketId} <> ${t.blockedById}`),
  ],
);

/** 票上的一条评论(issue #361)。作者两格恰有一格不空:人写的是用户名,会话写的是 sessionId。 */
export const productTicketComment = pgTable(
  "product_ticket_comment",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => productTicket.id),
    author: text(),
    sessionId: integer("session_id"),
    body: text().notNull(),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [index("product_ticket_comment_by_ticket").on(t.ticketId)],
);
