/**
 * 产品页、会话页与顶栏面包屑共读的四份查询:产品列表、产品详情、产品下的会话列表、单个会话。
 *
 * 形状照 `lib/stage-queries.ts`:键与请求在一处给出,调用方 `useQuery(xxxQuery(...))`,要加
 * 观察者选项(轮询之类)就在调用点展开再补。四处各写一份时,键与请求任一侧写岔就是两份缓存、
 * 两次请求,而且没有测试会报。键本身仍住在 `lib/products.ts` 与 `lib/agent-sessions.ts`,
 * 失效处照旧引它们。不含 JSX,只引 `api.ts`。
 */
import { fetchJson } from "../api.ts";

import { sessionsQueryKey, agentSessionQueryKey, type AgentSession } from "./agent-sessions.ts";
import { PRODUCTS_QUERY_KEY, productQueryKey, type Product, type ProductDetail } from "./products.ts";

/** `GET /products`:这个账号看得到的产品(服务端按仓库分配收窄,ADR 0018)。 */
export function productListQuery() {
  return {
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: async () => (await fetchJson<{ products: Product[] }>("/products")).products,
  };
}

/** `GET /products/{id}`:产品、它的产品知识与产品 tracker。地址没带产品时不发。 */
export function productDetailQuery(productId: number | undefined) {
  return {
    queryKey: productQueryKey(productId),
    queryFn: () => fetchJson<ProductDetail>(`/products/${productId!}`),
    enabled: productId !== undefined,
  };
}

/** `GET /products/{id}/sessions`:这个产品下的会话,可见多少由服务端按创建者给出。 */
export function productSessionsQuery(productId: number | undefined) {
  return {
    queryKey: sessionsQueryKey(productId ?? 0),
    queryFn: async () =>
      (await fetchJson<{ sessions: AgentSession[] }>(`/products/${productId!}/sessions`)).sessions,
    enabled: productId !== undefined,
  };
}

/**
 * `GET /agent-sessions/{id}`。响应体由调用方给出:会话页读排队、图片能力与写下的 spec 那几格,
 * 面包屑只读 `session`——两处是同一个键、同一个请求,类型各断言各的。`sessionId` 为 undefined
 * 即不发(面包屑在非会话路由上)。
 */
export function agentSessionQuery<T = { session: AgentSession }>(sessionId: number | undefined) {
  return {
    queryKey: agentSessionQueryKey(sessionId ?? 0),
    queryFn: () => fetchJson<T>(`/agent-sessions/${sessionId!}`),
    enabled: sessionId !== undefined,
  };
}
