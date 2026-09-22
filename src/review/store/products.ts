/**
 * 产品域的持久化(spec #445 第二段):产品、仓库归属与职责、产品知识(术语、仓库关系、
 * 决策)与产品 tracker(spec、票、阻塞边、评论、认领)。
 *
 * 读写用 builder,行类型从 schema 推导,不再有手抄的列名字符串。写法见 `src/AGENTS.md`
 * 的「域文件的分工与写法」。
 */
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import {
  product,
  productKnowledgeEntry,
  productRepo,
  productSpec,
  productTicket,
  productTicketBlock,
  productTicketComment,
} from "../schema/products.ts";
import { repo } from "../schema/repos.ts";
import { agentSession } from "../schema/sessions.ts";
import type {
  ProductKnowledgeAnnotation,
  ProductKnowledgeEntry,
  ProductKnowledgeKind,
  ProductRecord,
  ProductSpecRecord,
  ProductTicketCommentRecord,
  ProductTicketLabel,
  ProductTicketRecord,
  ProductTrackerState,
  Store,
} from "./index.ts";
import { deleteAgentSessionRows } from "./sessions.ts";
import type { StoreContext } from "./shared.ts";

/**
 * 产品连同它的仓库集合的那几列。一个产品没有仓库也要读得出来(刚建的产品就是这样),所以
 * 两次 LEFT JOIN;`repo` 那一张也 LEFT JOIN 是为了不让一行归属把整个产品藏起来。
 */
const PRODUCT_COLUMNS = {
  id: product.id,
  name: product.name,
  createdAt: product.createdAt,
  repoId: productRepo.repoId,
  role: productRepo.role,
  owner: repo.owner,
  repo: repo.repo,
};

/** 归属与仓库那几格是 LEFT JOIN 来的:没有仓库的产品那一行是 NULL。 */
type ProductRow = {
  id: number;
  name: string;
  createdAt: string;
  repoId: number | null;
  role: string | null;
  owner: string | null;
  repo: string | null;
};

/** 把一产品多行折成每个产品一条记录,顺序按查询给的顺序。 */
function foldProducts(rows: readonly ProductRow[]): ProductRecord[] {
  const products = new Map<number, ProductRecord>();
  for (const row of rows) {
    let entry = products.get(row.id);
    if (entry === undefined) {
      entry = { id: row.id, name: row.name, createdAt: row.createdAt, repos: [] };
      products.set(row.id, entry);
    }
    if (row.repoId !== null && row.owner !== null) {
      entry.repos.push({
        repoId: row.repoId,
        owner: row.owner,
        repo: row.repo!,
        role: row.role,
      });
    }
  }
  return [...products.values()];
}

type KnowledgeRow = typeof productKnowledgeEntry.$inferSelect;

/** 产品知识表里的一行。两处 JSON 都是这张表自己写下的,形状由写入口保证。 */
function knowledgeEntry(row: KnowledgeRow): ProductKnowledgeEntry {
  return {
    id: row.id,
    productId: row.productId,
    kind: row.kind as ProductKnowledgeKind,
    name: row.name,
    body: row.body,
    topic: row.topic,
    avoided: JSON.parse(row.avoided) as string[],
    options: row.options,
    consequences: row.consequences,
    supersededBy: row.supersededBy,
    annotations: JSON.parse(row.annotations) as ProductKnowledgeAnnotation[],
    writtenAt: row.writtenAt,
    writtenBySessionId: row.writtenBySessionId,
  };
}

/** spec 表里的一行。 */
function specRecord(row: typeof productSpec.$inferSelect): ProductSpecRecord {
  return {
    id: row.id,
    productId: row.productId,
    title: row.title,
    body: row.body,
    state: row.state as ProductTrackerState,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    stateChangedAt: row.stateChangedAt,
  };
}

/** 票连同它所属 spec 的产品:票不存 product_id,产品经 spec 推出来。 */
const TICKET_COLUMNS = {
  id: productTicket.id,
  specId: productTicket.specId,
  productId: productSpec.productId,
  title: productTicket.title,
  body: productTicket.body,
  label: productTicket.label,
  state: productTicket.state,
  claimedBy: productTicket.claimedBy,
  sessionId: productTicket.sessionId,
  createdAt: productTicket.createdAt,
  stateChangedAt: productTicket.stateChangedAt,
};

type TicketRow = {
  id: number;
  specId: number;
  productId: number;
  title: string;
  body: string;
  label: string;
  state: string;
  claimedBy: string | null;
  sessionId: number | null;
  createdAt: string;
  stateChangedAt: string;
};

/** 票表里的一行。`blockedBy` 另查一次,查询那一侧填。 */
function ticketRecord(row: TicketRow, blockedBy: readonly number[]): ProductTicketRecord {
  return {
    id: row.id,
    specId: row.specId,
    productId: row.productId,
    title: row.title,
    body: row.body,
    label: row.label as ProductTicketLabel,
    state: row.state as ProductTrackerState,
    claimedBy: row.claimedBy,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    stateChangedAt: row.stateChangedAt,
    blockedBy: [...blockedBy],
  };
}

type ProductsMethods = Pick<
  Store,
  | "listProducts"
  | "getProduct"
  | "createProduct"
  | "renameProduct"
  | "attachProductRepo"
  | "detachProductRepo"
  | "deleteProduct"
  | "listProductKnowledge"
  | "writeProductKnowledge"
  | "withdrawProductKnowledge"
  | "listProductSpecs"
  | "getProductSpec"
  | "createProductSpec"
  | "listProductTickets"
  | "getProductTicket"
  | "createProductTicket"
  | "setProductSpecBody"
  | "setProductSpecState"
  | "setProductTicketBody"
  | "setProductTicketState"
  | "setProductTicketLabel"
  | "setProductTicketClaim"
  | "listProductTicketComments"
  | "addProductTicketComment"
  | "addProductTicketBlock"
  | "removeProductTicketBlock"
>;

export function productsMethods({ orm, transaction }: StoreContext): ProductsMethods {
  const productQuery = (where: SQL | undefined, order: SQL[]): Promise<ProductRow[]> =>
    orm
      .select(PRODUCT_COLUMNS)
      .from(product)
      .leftJoin(productRepo, eq(productRepo.productId, product.id))
      .leftJoin(repo, eq(repo.id, productRepo.repoId))
      .where(where)
      .orderBy(...order) as Promise<ProductRow[]>;

  /** 这个产品下全部票的 id。删产品与按产品查阻塞边都拿它当子查询。 */
  const ticketIdsOfProduct = (productId: number) =>
    orm
      .select({ id: productTicket.id })
      .from(productTicket)
      .innerJoin(productSpec, eq(productSpec.id, productTicket.specId))
      .where(eq(productSpec.productId, productId));

  /** 这个产品下全部 spec 的 id。删产品按它删票。 */
  const specIdsOfProduct = (productId: number) =>
    orm.select({ id: productSpec.id }).from(productSpec).where(eq(productSpec.productId, productId));

  const ticketQuery = (where: SQL, order: SQL[]): Promise<TicketRow[]> =>
    orm
      .select(TICKET_COLUMNS)
      .from(productTicket)
      .innerJoin(productSpec, eq(productSpec.id, productTicket.specId))
      .where(where)
      .orderBy(...order) as Promise<TicketRow[]>;

  return {
    async listProducts() {
      return foldProducts(
        await productQuery(undefined, [asc(product.name), asc(repo.owner), asc(repo.repo)]),
      );
    },

    async getProduct(productId) {
      return foldProducts(
        await productQuery(eq(product.id, productId), [asc(repo.owner), asc(repo.repo)]),
      )[0];
    },

    async createProduct(record) {
      const [inserted] = await orm
        .insert(product)
        .values({ name: record.name, createdAt: record.createdAt })
        .returning({ id: product.id });
      return { id: inserted!.id, ...record, repos: [] };
    },

    async renameProduct(productId, name) {
      const updated = await orm
        .update(product)
        .set({ name })
        .where(eq(product.id, productId))
        .returning({ id: product.id });
      return updated.length > 0;
    },

    async attachProductRepo(productId, repoId, at, role = null) {
      const products = await orm
        .select({ id: product.id })
        .from(product)
        .where(eq(product.id, productId));
      if (products.length === 0) return "missing-product";
      const repos = await orm.select({ id: repo.id }).from(repo).where(eq(repo.id, repoId));
      if (repos.length === 0) return "missing-repo";
      // 一仓多属由主键挡:插不进去才回头看它归在谁下面,不先查再插——先查的那一档
      // 在并发两次归属时两边都以为自己能插。
      const inserted = await orm
        .insert(productRepo)
        .values({ repoId, productId, addedAt: at, role })
        .onConflictDoNothing({ target: productRepo.repoId })
        .returning({ repoId: productRepo.repoId });
      if (inserted.length > 0) return "attached";
      const [owner] = await orm
        .select({ productId: productRepo.productId })
        .from(productRepo)
        .where(eq(productRepo.repoId, repoId));
      if (owner?.productId !== productId) return "other-product";
      // 已经在这个产品下:这一次改的只有职责,归入时间不动。
      await orm.update(productRepo).set({ role }).where(eq(productRepo.repoId, repoId));
      return "role-updated";
    },

    async detachProductRepo(productId, repoId) {
      const removed = await orm
        .delete(productRepo)
        .where(and(eq(productRepo.productId, productId), eq(productRepo.repoId, repoId)))
        .returning({ repoId: productRepo.repoId });
      return removed.length > 0;
    },

    async deleteProduct(productId) {
      return await transaction("deferred", async () => {
        await orm.delete(productRepo).where(eq(productRepo.productId, productId));
        // 产品知识同样跟着产品走(issue #343):产品是它唯一的挂载点。指向条目的「被取代」
        // 是同一张表内的外键,不必先松开——一句 DELETE 把指过去的与被指的一并删掉时,
        // PostgreSQL 的外键检查在语句结束时才跑,那时两行都已经不在了。
        await orm
          .delete(productKnowledgeEntry)
          .where(eq(productKnowledgeEntry.productId, productId));
        // 产品 tracker 同律(issue #361):spec 挂在产品上,票、边与评论挂在 spec 上,
        // 从下往上删——边与评论的外键指着票,票的外键指着 spec。
        await orm
          .delete(productTicketBlock)
          .where(inArray(productTicketBlock.ticketId, ticketIdsOfProduct(productId)));
        await orm
          .delete(productTicketComment)
          .where(inArray(productTicketComment.ticketId, ticketIdsOfProduct(productId)));
        await orm
          .delete(productTicket)
          .where(inArray(productTicket.specId, specIdsOfProduct(productId)));
        await orm.delete(productSpec).where(eq(productSpec.productId, productId));
        // 会话跟着产品走(issue #332):产品是会话唯一的挂载点,留下来谁都读不到它。记录与
        // 受理过的消息 id 挂在会话上,同一个事务里一并删(issue #333)。
        const sessionIds = (
          await orm
            .select({ id: agentSession.id })
            .from(agentSession)
            .where(eq(agentSession.productId, productId))
        ).map((row) => row.id);
        await deleteAgentSessionRows(orm, sessionIds);
        const sessions = await orm
          .delete(agentSession)
          .where(eq(agentSession.productId, productId))
          .returning({ id: agentSession.id });
        const removed = await orm
          .delete(product)
          .where(eq(product.id, productId))
          .returning({ id: product.id });
        return removed.length > 0 ? { sessions: sessions.length } : undefined;
      });
    },

    async listProductKnowledge(productId) {
      // 顺序就是产品页上的顺序:术语表、仓库关系、产品决策,每一段里先写下的在前。
      const rows = await orm
        .select()
        .from(productKnowledgeEntry)
        .where(eq(productKnowledgeEntry.productId, productId))
        .orderBy(
          sql`CASE ${productKnowledgeEntry.kind}
                WHEN 'term' THEN 0 WHEN 'relationship' THEN 1 ELSE 2 END`,
          asc(productKnowledgeEntry.id),
        );
      return rows.map(knowledgeEntry);
    },

    async writeProductKnowledge(record) {
      return await transaction<ProductKnowledgeEntry | undefined>("deferred", async (tx) => {
        // 改写的目标与被取代的目标都在这一笔事务里先锁住再判:判完到写下之间那一条被撤回的
        // 话,落下去的就是一条指向不存在条目的「被取代」。
        const locked = async (id: number): Promise<boolean> =>
          (
            await orm
              .select({ id: productKnowledgeEntry.id })
              .from(productKnowledgeEntry)
              .where(
                and(
                  eq(productKnowledgeEntry.id, id),
                  eq(productKnowledgeEntry.productId, record.productId),
                ),
              )
              .for("update")
          ).length > 0;
        if (record.id !== undefined && !(await locked(record.id))) return tx.rollback(undefined);
        if (record.supersedes !== undefined && !(await locked(record.supersedes))) {
          return tx.rollback(undefined);
        }
        const content = {
          kind: record.kind,
          name: record.name,
          body: record.body,
          topic: record.topic,
          avoided: JSON.stringify([...record.avoided]),
          options: record.options,
          consequences: record.consequences,
          annotations: JSON.stringify([...record.annotations]),
          writtenAt: record.at,
          writtenBySessionId: record.sessionId,
        };
        let id: number;
        if (record.id === undefined) {
          const [inserted] = await orm
            .insert(productKnowledgeEntry)
            .values({ productId: record.productId, ...content })
            .returning({ id: productKnowledgeEntry.id });
          id = inserted!.id;
        } else {
          id = record.id;
          await orm
            .update(productKnowledgeEntry)
            .set(content)
            .where(eq(productKnowledgeEntry.id, id));
        }
        if (record.supersedes !== undefined) {
          await orm
            .update(productKnowledgeEntry)
            .set({ supersededBy: id })
            .where(eq(productKnowledgeEntry.id, record.supersedes));
        }
        const [written] = await orm
          .select()
          .from(productKnowledgeEntry)
          .where(eq(productKnowledgeEntry.id, id));
        return knowledgeEntry(written!);
      });
    },

    async withdrawProductKnowledge(productId, entryId) {
      // 指向它的「被取代」先松开:留着的话那条决策的状态指向一条不存在的条目。
      await orm
        .update(productKnowledgeEntry)
        .set({ supersededBy: null })
        .where(
          and(
            eq(productKnowledgeEntry.productId, productId),
            eq(productKnowledgeEntry.supersededBy, entryId),
          ),
        );
      const removed = await orm
        .delete(productKnowledgeEntry)
        .where(
          and(
            eq(productKnowledgeEntry.id, entryId),
            eq(productKnowledgeEntry.productId, productId),
          ),
        )
        .returning({ id: productKnowledgeEntry.id });
      return removed.length > 0;
    },

    async listProductSpecs(productId) {
      const rows = await orm
        .select()
        .from(productSpec)
        .where(eq(productSpec.productId, productId))
        .orderBy(asc(productSpec.id));
      return rows.map(specRecord);
    },

    async getProductSpec(specId) {
      const [row] = await orm.select().from(productSpec).where(eq(productSpec.id, specId));
      return row === undefined ? undefined : specRecord(row);
    },

    async createProductSpec({ productId, title, body, sessionId, at }) {
      const [inserted] = await orm
        .insert(productSpec)
        .values({
          productId,
          title,
          body,
          state: "open",
          sessionId,
          createdAt: at,
          stateChangedAt: at,
        })
        .returning({ id: productSpec.id });
      return {
        id: inserted!.id,
        productId,
        title,
        body,
        state: "open",
        sessionId,
        createdAt: at,
        stateChangedAt: at,
      };
    },

    async listProductTickets(productId) {
      // 阻塞边一次查完再按票分组:一张票一次查会让产品页的读随票数线性开销。
      const blocks = new Map<number, number[]>();
      const edges = await orm
        .select({
          ticketId: productTicketBlock.ticketId,
          blockedById: productTicketBlock.blockedById,
        })
        .from(productTicketBlock)
        .where(inArray(productTicketBlock.ticketId, ticketIdsOfProduct(productId)))
        .orderBy(asc(productTicketBlock.blockedById));
      for (const edge of edges) {
        blocks.set(edge.ticketId, [...(blocks.get(edge.ticketId) ?? []), edge.blockedById]);
      }
      const rows = await ticketQuery(eq(productSpec.productId, productId), [asc(productTicket.id)]);
      return rows.map((row) => ticketRecord(row, blocks.get(row.id) ?? []));
    },

    async getProductTicket(ticketId) {
      const [row] = await ticketQuery(eq(productTicket.id, ticketId), []);
      if (row === undefined) return undefined;
      const blockedBy = await orm
        .select({ blockedById: productTicketBlock.blockedById })
        .from(productTicketBlock)
        .where(eq(productTicketBlock.ticketId, ticketId))
        .orderBy(asc(productTicketBlock.blockedById));
      return ticketRecord(
        row,
        blockedBy.map((one) => one.blockedById),
      );
    },

    async createProductTicket({ specId, title, body, label, sessionId, at }) {
      const [inserted] = await orm
        .insert(productTicket)
        .values({
          specId,
          title,
          body,
          label,
          state: "open",
          sessionId,
          createdAt: at,
          stateChangedAt: at,
        })
        .returning({ id: productTicket.id });
      const id = inserted!.id;
      // spec 一定在:票是外键挂上去的,上面那句 INSERT 认不出 spec 就已经抛了。读不回来
      // 只可能是库坏了,那时抛出来比给这张票落一个 0 号产品强——0 号产品谁都看不到。
      const [spec] = await orm
        .select({ productId: productSpec.productId })
        .from(productSpec)
        .where(eq(productSpec.id, specId));
      if (spec === undefined) {
        throw new Error(`product_spec ${specId} 不存在,票 ${id} 归不到产品上`);
      }
      return {
        id,
        specId,
        productId: spec.productId,
        title,
        body,
        label,
        state: "open",
        claimedBy: null,
        sessionId,
        createdAt: at,
        stateChangedAt: at,
        blockedBy: [],
      };
    },

    async setProductSpecBody(specId, body) {
      const updated = await orm
        .update(productSpec)
        .set({ body })
        .where(eq(productSpec.id, specId))
        .returning({ id: productSpec.id });
      return updated.length > 0;
    },

    async setProductSpecState(specId, state, at) {
      const updated = await orm
        .update(productSpec)
        .set({ state, stateChangedAt: at })
        .where(and(eq(productSpec.id, specId), ne(productSpec.state, state)))
        .returning({ id: productSpec.id });
      return updated.length > 0;
    },

    async setProductTicketBody(ticketId, body) {
      const updated = await orm
        .update(productTicket)
        .set({ body })
        .where(eq(productTicket.id, ticketId))
        .returning({ id: productTicket.id });
      return updated.length > 0;
    },

    async setProductTicketState(ticketId, state, at) {
      const updated = await orm
        .update(productTicket)
        .set({ state, stateChangedAt: at })
        .where(and(eq(productTicket.id, ticketId), ne(productTicket.state, state)))
        .returning({ id: productTicket.id });
      return updated.length > 0;
    },

    async setProductTicketLabel(ticketId, label) {
      const updated = await orm
        .update(productTicket)
        .set({ label })
        .where(eq(productTicket.id, ticketId))
        .returning({ id: productTicket.id });
      return updated.length > 0;
    },

    async setProductTicketClaim(ticketId, claimedBy, by) {
      // 认领与取消认领同一句 WHERE:别人的名字在那一格时一行都不匹配,调用方据此说出理由。
      // 两个人同时点认领时后一个匹配不上——条件写在 UPDATE 里,判与写是同一句,不必另锁行。
      const updated = await orm
        .update(productTicket)
        .set({ claimedBy })
        .where(
          and(
            eq(productTicket.id, ticketId),
            or(isNull(productTicket.claimedBy), eq(productTicket.claimedBy, by)),
          ),
        )
        .returning({ id: productTicket.id });
      return updated.length > 0;
    },

    async listProductTicketComments(ticketId) {
      const rows = await orm
        .select()
        .from(productTicketComment)
        .where(eq(productTicketComment.ticketId, ticketId))
        .orderBy(asc(productTicketComment.id));
      return rows.map(
        (row): ProductTicketCommentRecord => ({
          id: row.id,
          ticketId: row.ticketId,
          author: row.author,
          sessionId: row.sessionId,
          body: row.body,
          createdAt: row.createdAt,
        }),
      );
    },

    async addProductTicketComment({ ticketId, author, sessionId, body, at }) {
      const [inserted] = await orm
        .insert(productTicketComment)
        .values({ ticketId, author, sessionId, body, createdAt: at })
        .returning({ id: productTicketComment.id });
      return { id: inserted!.id, ticketId, author, sessionId, body, createdAt: at };
    },

    async addProductTicketBlock(ticketId, blockedById) {
      await orm
        .insert(productTicketBlock)
        .values({ ticketId, blockedById })
        .onConflictDoNothing();
    },

    async removeProductTicketBlock(ticketId, blockedById) {
      const removed = await orm
        .delete(productTicketBlock)
        .where(
          and(
            eq(productTicketBlock.ticketId, ticketId),
            eq(productTicketBlock.blockedById, blockedById),
          ),
        )
        .returning({ ticketId: productTicketBlock.ticketId });
      return removed.length > 0;
    },
  };
}
