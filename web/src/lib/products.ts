/** 产品页与会话页共用的形状、查询键与纯投影(issue #331)。 */

export type ProductRepoRef = { repoId: number };

/** `role` 是仓库职责(CONTEXT.md 仓库职责,issue #341)。没写过即 null。 */
export type ProductRepo = { repoId: number; owner: string; repo: string; role: string | null };
export type Product = { id: number; name: string; createdAt: string; repos: ProductRepo[] };
/** `GET /repos` 那一份里归属弹窗要的三列。它已经按仓库分配收窄过。 */
export type RegisteredRepo = { repoId: number; owner: string; repo: string };
/** 一条出处附注(CONTEXT.md 产品知识,issue #360):代码里的位置与一句为什么。 */
export type KnowledgeAnnotation = { location: string; reason: string };

/**
 * 一条产品知识(CONTEXT.md 术语条目、仓库关系、产品决策,issue #360)。三种条目同一个形状,
 * `kind` 说是哪一种:术语用 `name` / `topic` / `avoided`,关系只用 `body`,决策另用
 * `options` / `consequences` 与 `supersededBy`(不为空即被那一条取代)。
 */
export type ProductKnowledge = {
  id: number;
  kind: "term" | "relationship" | "decision";
  name: string;
  body: string;
  topic: string | null;
  avoided: string[];
  options: string | null;
  consequences: string | null;
  supersededBy: number | null;
  annotations: KnowledgeAnnotation[];
  writtenAt: string;
};

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
  /** 认领人(CONTEXT.md 认领)。没人认领即 null。 */
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
  /** 产品 tracker(CONTEXT.md 产品 tracker,issue #361)。正文只由会话写。 */
  tracker: { specs: TrackerSpec[] };
};

/**
 * 可开工的那几张票的票号(CONTEXT.md 票,issue #363):开着、没有未关的阻塞、无人认领。
 *
 * 阻塞边只在同一产品的票之间,但挡着它的那张票可能挂在另一条 spec 下,因此判定跨整份
 * tracker 做,不在单条 spec 里算。认不出的票号当作不挡着——票不会被删,那一档只可能来自
 * 一份还没读全的数据,让它照常显示比整张票消失好。
 */
export function pickableTickets(specs: readonly TrackerSpec[]): Set<number> {
  const byId = new Map(specs.flatMap((spec) => spec.tickets).map((ticket) => [ticket.id, ticket]));
  return new Set(
    [...byId.values()]
      .filter(
        (ticket) =>
          ticket.state === "open" &&
          ticket.claimedBy === null &&
          ticket.blockedBy.every((id) => byId.get(id)?.state !== "open"),
      )
      .map((ticket) => ticket.id),
  );
}

/**
 * 术语表按主题分组(CONTEXT.md 术语条目,issue #360)。分组按条目里第一次出现的主题排,
 * 没分组的那几条排在最后一组(`topic` 为 null)——它们同样要看得见,不该被分组吃掉。
 */
export function groupedTerms(
  knowledge: readonly ProductKnowledge[],
): { topic: string | null; terms: ProductKnowledge[] }[] {
  const groups = new Map<string | null, ProductKnowledge[]>();
  for (const entry of knowledge) {
    if (entry.kind !== "term") continue;
    const group = groups.get(entry.topic);
    if (group === undefined) groups.set(entry.topic, [entry]);
    else group.push(entry);
  }
  const ungrouped = groups.get(null);
  groups.delete(null);
  const ordered = [...groups].map(([topic, terms]) => ({ topic, terms }));
  return ungrouped === undefined ? ordered : [...ordered, { topic: null, terms: ungrouped }];
}

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

/** 要关掉的那一条:一条 spec,或一张票(issue #389)。 */
export type TrackerCloseTarget =
  | { kind: "spec"; id: number; title: string }
  | { kind: "ticket"; id: number; title: string };

/**
 * 关掉一条 spec 或一张票之前,确认弹窗上的标题与说明(issue #389)。关这一下原先点完就写,
 * 而它在弹窗头部,手机上一次滑动误触就把人家的 spec 关了。
 *
 * 文案写清关的是哪一条:spec 报标题,票报票号加标题——一条 spec 下的票标题常常只差几个字。
 * 关掉 spec 不动它下面的票(服务端只改这一行的状态),关掉一张票会把被它挡着的票放开
 * (`pickableTickets` 只看未关的阻塞),两句说明各自照这个写。
 */
export function trackerCloseConfirm(target: TrackerCloseTarget): {
  title: string;
  description: string;
} {
  return target.kind === "spec"
    ? {
        title: `关掉 spec「${target.title}」?`,
        description: "它下面那几张票的开关不动。关错了再点一次「重新打开这条 spec」。",
      }
    : {
        title: `关掉票 #${target.id}「${target.title}」?`,
        description: "它不再算可开工的票,被它挡着的票跟着放开。关错了再点一次「重新打开」。",
      };
}

/** 一条陈述拆出来的一段:`code` 为真即它写在一对反引号之间。 */
export type StatementPart = { code: boolean; text: string };

/**
 * 一条陈述按反引号拆段(CONTEXT.md 产品知识)。agent 与人写的陈述里常拿反引号圈住标识符
 * (`account.balance -= amount`),原样摊出反引号读起来是源码;拆出来的 `code` 段由页面按
 * 行内代码渲染。只认反引号,不跑整套 Markdown:陈述是一句话,不该有标题与列表。
 *
 * **反引号没配对就整句当正文**:只有奇数个反引号时哪半是代码猜不出来,猜错会把一句话的
 * 后半段整段渲染成代码。
 */
export function statementParts(text: string): StatementPart[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return [{ code: false, text }];
  return parts.map((part, index) => ({ code: index % 2 === 1, text: part }));
}
