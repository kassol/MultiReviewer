import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { api } from "./api.ts";
import { injected } from "./injected.ts";
import { LoginPage } from "./login.tsx";
import { ReposPage } from "./repos.tsx";
import { StatsPage } from "./stats.tsx";
import "./styles.css";

// 入口第一件事读注入:缺了就在这里报错,不进任何路由。
const { prefix } = injected();

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/** 壳:三页顶部导航。所有受保护页面挂在它下面,未登录一律送去登录页。 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: async () => {
    const response = await api("/session");
    if (response.status !== 204) throw redirect({ to: "/login" });
  },
  component: Shell,
});

function Shell() {
  return (
    <div>
      <div className="top">
        <div className="brand">
          <b>MultiReviewer</b>
        </div>
        <nav className="nav">
          <Link to="/repos" activeProps={{ className: "on" }}>
            仓库
          </Link>
          <Link to="/runs" activeProps={{ className: "on" }}>
            评审记录
          </Link>
          <Link to="/stats" activeProps={{ className: "on" }}>
            处置率
          </Link>
        </nav>
      </div>
      <Outlet />
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
  component: () => <p style={{ padding: 22 }}>评审记录页(issue #37)</p>,
});
const statsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/stats",
  component: StatsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([indexRoute, reposRoute, runsRoute, statsRoute]),
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
