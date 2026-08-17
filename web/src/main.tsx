import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  RouterProvider,
  useRouter,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { api, fetchJson } from "./api.ts";
import { CredentialsPage } from "./credentials.tsx";
import { injected } from "./injected.ts";
import { LoginPage } from "./login.tsx";
import { ReposPage } from "./repos.tsx";
import { RunsPage } from "./runs.tsx";
import { SettingsPage } from "./settings.tsx";
import { denominator, StatsPage, type Cell } from "./stats.tsx";
import "./styles.css";

// 入口第一件事读注入:缺了就在这里报错,不进任何路由。
const { prefix } = injected();

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/** 所有受保护页面挂在壳(见下方 Shell)下面,未登录一律送去登录页。 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: async () => {
    const response = await api("/session");
    if (response.status !== 204) throw redirect({ to: "/login" });
  },
  component: Shell,
});

const NAV = [
  { to: "/repos", label: "仓库" },
  { to: "/runs", label: "评审记录" },
  { to: "/stats", label: "处置率" },
  { to: "/credentials", label: "模型凭据" },
  { to: "/settings", label: "全局设置" },
] as const;

/**
 * 壳:左侧栏管导航,顶部那条 38px 的信息条管汇总数字。各屏共用同一套骨架,页面之间
 * 切换不必重新找东西在哪。
 */
function Shell() {
  const router = useRouter();

  // 服务端作废 session 并清 cookie,再回登录页。端点回什么都往登录页走:会话已经
  // 不该用了,留在面板上只会在下一次请求撞 401。
  async function logout(): Promise<void> {
    await api("/session", { method: "DELETE" }).catch(() => undefined);
    await router.navigate({ to: "/login" });
  }

  return (
    // 窄视口下侧栏会吃掉一半宽度,所以那一档改成上下堆叠、导航横排。
    <div className="flex h-screen flex-col sm:grid sm:grid-cols-[184px_1fr]">
      <aside className="flex shrink-0 flex-col border-border bg-card max-sm:flex-row max-sm:items-center max-sm:border-b sm:border-r">
        <div className="flex h-[38px] shrink-0 items-center border-border px-4 font-semibold sm:border-b">
          MultiReviewer
        </div>
        <nav className="flex sm:flex-col sm:py-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex h-9 items-center border-transparent px-4 whitespace-nowrap text-muted-foreground hover:bg-muted max-sm:border-b-[3px] sm:border-l-[3px]"
              activeProps={{
                className:
                  "bg-accent text-accent-foreground font-medium max-sm:border-b-primary sm:border-l-primary",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {/* 侧栏底部(窄视口下是导航尾端):登出与导航同列,位置固定不随页面变。 */}
        <button
          type="button"
          onClick={() => void logout()}
          className="flex h-9 items-center px-4 whitespace-nowrap text-muted-foreground hover:bg-muted max-sm:ml-auto sm:mt-auto sm:mb-2"
        >
          登出
        </button>
      </aside>
      <div className="flex min-w-0 flex-col">
        <SummaryBar />
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * 顶部信息条:总处置率与逐模型处置率,与处置率页同源(同一个默认窗口的 /stats),
 * 前端只做求和。进任何一页都看得到当前状态。
 */
function SummaryBar() {
  const stats = useQuery({
    queryKey: ["stats", "band"],
    queryFn: () => fetchJson<{ cells: Cell[] }>("/stats"),
  });
  const cells = stats.data?.cells ?? [];
  const all = cells.reduce(
    (acc, cell) => ({
      resolved: acc.resolved + cell.resolved,
      total: acc.total + denominator(cell),
    }),
    { resolved: 0, total: 0 },
  );
  const models = [...new Set(cells.map((cell) => cell.model))].sort();
  const modelPct = (model: string): number => {
    const mine = cells.filter((cell) => cell.model === model);
    const total = mine.reduce((sum, cell) => sum + denominator(cell), 0);
    const resolved = mine.reduce((sum, cell) => sum + cell.resolved, 0);
    return total === 0 ? 0 : Math.round((resolved / total) * 100);
  };

  return (
    <div className="flex h-[38px] shrink-0 items-center gap-6 overflow-x-auto border-b border-border bg-card px-4">
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <b className="font-mono tabular-nums">
          {all.total === 0 ? 0 : Math.round((all.resolved / all.total) * 100)}%
        </b>
        <span className="text-[11px] text-muted-foreground">
          近 30 天处置率 {all.resolved}/{all.total}
        </span>
      </span>
      {models.map((model) => (
        <span key={model} className="flex items-baseline gap-1.5 whitespace-nowrap">
          <b className="font-mono tabular-nums">{modelPct(model)}%</b>
          <span className="font-mono text-[11px] text-muted-foreground">{model}</span>
        </span>
      ))}
    </div>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/repos" });
  },
});
const reposRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/repos",
  component: ReposPage,
});
const runsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/runs",
  component: RunsPage,
});
const statsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/stats",
  component: StatsPage,
});

const credentialsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/credentials",
  component: CredentialsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    indexRoute,
    reposRoute,
    runsRoute,
    statsRoute,
    credentialsRoute,
    settingsRoute,
  ]),
]);

// 前缀是运行时值,构建产物与它无关:basepath 在这里从注入读入。
const router = createRouter({ routeTree, basepath: `/${prefix}` });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
