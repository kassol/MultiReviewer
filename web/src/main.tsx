import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import { LogOut } from "lucide-react";

import { Mark } from "@/components/mark";

import { api } from "./api.ts";
import { CredentialsPage } from "./credentials.tsx";
import { injected } from "./injected.ts";
import { LoginPage } from "./login.tsx";
import { ReposPage } from "./repos.tsx";
import { RunsPage } from "./runs.tsx";
import { SettingsPage } from "./settings.tsx";
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

/** 所有受保护页面挂在壳(见下方 Shell)下面,未登录一律送去登录页。 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: async () => {
    const response = await api("/session");
    if (response.status !== 200) throw redirect({ to: "/login" });
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
 * 壳:只管导航。侧栏是 --chrome,内容是白。当前项是白底细线盒子,不是一根色条。
 *
 * 汇总数字不常驻顶部:搬进各页自己的页头,哪一页要哪个数字由那一页决定。
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
    <div className="flex h-dvh flex-col sm:grid sm:grid-cols-[200px_1fr]">
      <aside className="flex shrink-0 flex-col border-border bg-chrome max-sm:flex-row max-sm:items-center max-sm:overflow-x-auto max-sm:border-b sm:border-r">
        <div className="flex shrink-0 items-center gap-2 border-border px-3 py-3.5 max-sm:py-2.5 sm:border-b">
          <Mark className="size-4" />
          <span className="font-semibold tracking-tight">MultiReviewer</span>
        </div>
        <nav aria-label="面板导航" className="flex shrink-0 gap-0.5 p-2 sm:flex-col">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex h-10 items-center rounded-md px-3 whitespace-nowrap text-muted-foreground transition-colors hover:bg-background hover:text-foreground sm:h-8"
              // 当前页对屏幕阅读器也要成立:仅靠底色的是视觉读者。
              activeProps={{
                "aria-current": "page",
                className:
                  "bg-background font-medium text-foreground shadow-[0_0_0_1px_var(--border)]",
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
          className="flex h-10 shrink-0 items-center gap-1.5 px-4 whitespace-nowrap text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground max-sm:ml-auto sm:mt-auto sm:mb-2 sm:h-9"
        >
          <LogOut className="size-3.5" />
          登出
        </button>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/runs" });
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
