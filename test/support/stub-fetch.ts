/**
 * 打桩 `globalThis.fetch`,按「方法 + 路径 + 查询串」路由到预置响应。
 *
 * Gitea 适配层与 hook 管理模块的测试共用:只验证外部可观察的行为——发出去的请求
 * 打在哪个端点、带什么头与什么 body,读回来的响应被解释成什么。
 */
export type Route = { status?: number; body?: unknown };

export type StubCall = {
  method: string;
  url: string;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
};

export function stubFetch(routes: Record<string, Route>): {
  calls: StubCall[];
  restore: () => void;
} {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");

    // 指向本机的请求直通,也不计入 calls:测试自己起的真实服务(假 Gitea、面板
    // harness 的 HTTP 缝)也走 fetch,打桩只该拦外部厂商。
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return original(input as Parameters<typeof original>[0], init);
    }

    calls.push({
      method,
      url: url.toString(),
      auth: auth === null ? undefined : auth,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });

    const key = `${method} ${url.pathname}${url.search}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`打桩没有为 ${key} 准备响应`);
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(route.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
