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
    <div style={{ fontFamily: "system-ui", margin: "0 auto", maxWidth: "64rem" }}>
      <nav style={{ display: "flex", gap: "1rem", padding: "1rem 0" }}>
        <Link to="/repos">仓库</Link>
        <Link to="/runs">评审记录</Link>
        <Link to="/stats">处置率</Link>
      </nav>
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
  component: () => <p>仓库页(issue #34)</p>,
});
const runsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/runs",
  component: () => <p>评审记录页(issue #37)</p>,
});
const statsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/stats",
  component: () => <p>处置率页(issue #36)</p>,
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
