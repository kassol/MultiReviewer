/** 产品页与会话页共用的形状、查询键与纯投影(issue #331)。 */

export type ProductRepoRef = { repoId: number };

/** `role` 是仓库职责(CONTEXT.md 仓库职责,issue #341)。没写过即 null。 */
export type ProductRepo = { repoId: number; owner: string; repo: string; role: string | null };
export type Product = { id: number; name: string; createdAt: string; repos: ProductRepo[] };
/** `GET /repos` 那一份里归属弹窗要的三列。它已经按仓库分配收窄过。 */
export type RegisteredRepo = { repoId: number; owner: string; repo: string };
/** 一条生效的产品知识(CONTEXT.md 产品知识,issue #343)。`repoIds` 是它涉及的仓库集合。 */
export type ProductKnowledge = { id: number; statement: string; repoIds: number[] };
/**
 * 一条待确认的提案(CONTEXT.md 产品知识,issue #345、#346)。`retiresId` 不为空即退役提案,
 * 那一条的陈述是退役的理由,确认它退役的是它指向的那条生效条目。
 */
export type ProductProposal = ProductKnowledge & { retiresId: number | null };

/** 票的五个 triage 标签(CONTEXT.md 票)。固定字段值,与服务端那一份同一套取值。 */
export type TicketLabel =
  | "needs-triage"
  | "needs-info"
  | "ready-for-agent"
  | "ready-for-human"
  | "wontfix";

/** spec 与票共用的状态。 */
export type TrackerState = "open" | "closed";

/** 产品页列表里的一张票(CONTEXT.md 票,issue #361)。正文另经 spec 全文那一份读。 */
export type TrackerTicket = {
  id: number;
  title: string;
  label: TicketLabel;
  state: TrackerState;
  /** 认领人(CONTEXT.md 认领)。没人认领即 null;认领的入口是下一票。 */
  claimedBy: string | null;
  /** 阻塞它的那几张票的票号。 */
  blockedBy: number[];
};

/** 产品页列表里的一条 spec(CONTEXT.md spec)连它的票。 */
export type TrackerSpec = {
  id: number;
  title: string;
  state: TrackerState;
  tickets: TrackerTicket[];
};

/** `GET /products/{id}/specs/{specId}` 那一份:一条 spec 与它的票,都带正文。 */
export type SpecDetail = {
  spec: { id: number; title: string; body: string; state: TrackerState; createdAt: string };
  tickets: (TrackerTicket & {
    body: string;
    createdAt: string;
    comments: { id: number; author: string | null; body: string; createdAt: string }[];
  })[];
};

/** `GET /products/{id}` 那一份。产品页右栏、会话页头部与左栏共用这一个缓存条目。 */
export type ProductDetail = {
  product: Product;
  knowledge: ProductKnowledge[];
  proposals: ProductProposal[];
  /** 产品 tracker(CONTEXT.md 产品 tracker,issue #361)。只读,正文只由会话写。 */
  tracker: { specs: TrackerSpec[] };
};

/** `GET /products` 那一份读缓存的键。 */
export const PRODUCTS_QUERY_KEY = ["products"] as const;

/**
 * 一个产品详情那一份读缓存的键。它排在 `PRODUCTS_QUERY_KEY` 之下,重读产品列表时这一份
 * 跟着失效——仓库集一变,详情里的知识与会话都可能不是原来那一份了。
 */
export function productQueryKey(productId: number | undefined): readonly unknown[] {
  return ["products", productId];
}

/** 一条 spec 全文那一份读缓存的键。同样排在产品详情之下,重读产品时跟着失效。 */
export function specQueryKey(
  productId: number | undefined,
  specId: number | undefined,
): readonly unknown[] {
  return ["products", productId, "specs", specId];
}

export function repoPath(row: ProductRepo | RegisteredRepo): string {
  return `${row.owner}/${row.repo}`;
}

/**
 * 地址上的那个产品(`/products/$productId`)。地址没带产品(`/products`)或带的产品不在
 * 这个账号看得到的那一份里时落到列表第一个上——左栏与右栏各判一次就会各选各的。
 */
export function currentProduct<T extends { id: number }>(
  products: readonly T[],
  productId: number | undefined,
): T | undefined {
  return products.find((row) => row.id === productId) ?? products[0];
}

/**
 * 还没归入任何产品的仓库。归属弹窗的候选就是它:一个仓库至多属一个产品,已经归过的
 * 仓库再选一次只会换回服务端的 409。入参的仓库列表已经按仓库分配收窄过(ADR 0018),
 * 这里不再判可见性;看不到的产品里的仓库因此仍可能被选中,那一档由服务端回 409。
 */
export function unassignedRepos<T extends ProductRepoRef>(
  repos: readonly T[],
  products: readonly { repos: readonly ProductRepoRef[] }[],
): T[] {
  const taken = new Set(
    products.flatMap((product) => product.repos.map((repo) => repo.repoId)),
  );
  return repos.filter((repo) => !taken.has(repo.repoId));
}
