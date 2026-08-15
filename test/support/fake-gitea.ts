/**
 * 内存里的假 Gitea:起一个真实的 node:http 服务,只实现面板流程用到的端点。
 *
 * 注册 / 移除流程的测试打在这条缝上(issue #26 的测试决策「假 Gitea HTTP server」):
 * 面板经真实 HTTP 建 hook,测试从这里读回 hook 的 secret 与 `?k=` 代次再签投递,
 * 证明「面板写进 hook 的 Key」与「准入认的 Key」是同一把——不是两段各自碰巧通过。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeHook = {
  id: number;
  config: { url?: string; content_type?: string; secret?: string };
  /** 读回形态的事件集:哨兵 `pull_request_only` 已按真实 Gitea 的行为落回裸 `pull_request`。 */
  events: string[];
  /** 建 hook 请求里的原始 events,供「载荷逐项正确」类断言用。真实 Gitea 不回显这一项。 */
  requestedEvents: string[];
  active: boolean;
};

export type FakeGitea = {
  url: string;
  /** 当前存在的 hook,测试直接读。 */
  hooks: FakeHook[];
  control: {
    /** 置 true 让 POST hook 回 500,验证「建 hook 失败注册回滚」。 */
    failCreate: boolean;
    /** 置 true 让 DELETE hook 回 500,验证「删不掉不放行移除」。 */
    failDelete: boolean;
    /** bot 对仓库是否 admin。 */
    admin: boolean;
    /** 置 true 模拟仓库在 Gitea 上被删除:一切仓库相关路由 404,含按 id 解析。 */
    deleted: boolean;
  };
  /** 仓库改名 / 转移 owner:id 不变,路径全换。旧路径从此 404,与真实 Gitea 一致。 */
  rename(owner: string, repo: string): void;
  close(): void;
};

export async function startFakeGitea(repo: {
  id: number;
  owner: string;
  repo: string;
}): Promise<FakeGitea> {
  const hooks: FakeHook[] = [];
  const control = { failCreate: false, failDelete: false, admin: true, deleted: false };
  const current = { owner: repo.owner, repo: repo.repo };
  let nextId = 1;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const repoBase = `/api/v1/repos/${current.owner}/${current.repo}`;

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // 目标实例要求登录后才能调用,连读取类也是——没带凭据就当真实例一样拒掉。
    if (req.headers.authorization === undefined) {
      return json(401, { message: "token is required" });
    }
    if (control.deleted) return json(404, { message: "not found" });

    // 按数值 id 解析仓库,改名后拿到现名(routers/api/v1/api.go:1202 的 GetByID)。
    if (req.method === "GET" && path === `/api/v1/repositories/${repo.id}`) {
      return json(200, {
        id: repo.id,
        owner: { login: current.owner },
        name: current.repo,
      });
    }
    if (req.method === "GET" && path === repoBase) {
      return json(200, {
        id: repo.id,
        permissions: { admin: control.admin, push: true, pull: true },
      });
    }
    if (req.method === "GET" && path === `${repoBase}/hooks`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(200, page === 1 ? hooks : []);
    }
    if (req.method === "POST" && path === `${repoBase}/hooks`) {
      if (control.failCreate) return json(500, { message: "boom" });
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { config?: FakeHook["config"]; events?: string[]; active?: boolean };
        const requested = parsed.events ?? [];
        const hook: FakeHook = {
          id: nextId,
          config: parsed.config ?? {},
          // 模拟真实 Gitea 的回显:哨兵 pull_request_only 落回裸 pull_request
          // (docs/research/gitea-webhook-api.md 第 3 节)。
          events: requested.map((event) =>
            event === "pull_request_only" ? "pull_request" : event,
          ),
          requestedEvents: requested,
          active: parsed.active ?? false,
        };
        nextId += 1;
        hooks.push(hook);
        json(201, hook);
      });
      return;
    }
    const hookRoute = path.startsWith(`${repoBase}/hooks/`)
      ? /^(\d+)$/.exec(path.slice(`${repoBase}/hooks/`.length))
      : null;
    if (req.method === "DELETE" && hookRoute !== null) {
      if (control.failDelete) return json(500, { message: "boom" });
      const index = hooks.findIndex((hook) => hook.id === Number(hookRoute[1]));
      if (index === -1) return json(404, { message: "not found" });
      hooks.splice(index, 1);
      res.writeHead(204);
      return res.end();
    }

    return json(404, { message: "not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hooks,
    control,
    rename: (owner, repoName) => {
      current.owner = owner;
      current.repo = repoName;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
