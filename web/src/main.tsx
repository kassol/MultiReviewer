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
import { LogOut } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Mark } from "@/components/mark";
import { Card } from "@/components/ui/card";

import { AccessControlPage } from "./access-control.tsx";
import { api } from "./api.ts";
import { ModelServicesPage } from "./credentials.tsx";
import { injected } from "./injected.ts";
import { LoginPage } from "./login.tsx";
import { PasswordPage } from "./password.tsx";
import { ReposPage } from "./repos.tsx";
import { RunsPage } from "./runs.tsx";
import {
  clearPanelSession,
  hasPermission,
  loadPanelSession,
  type PanelPermission,
  type PanelSession,
} from "./session.ts";
import { SettingsPage } from "./settings.tsx";
import { StatsPage } from "./stats.tsx";
import "./styles.css";

const { prefix } = injected();

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

type ShellContext = { session: PanelSession };

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: async (): Promise<ShellContext> => {
    const session = await loadPanelSession();
    if (session === null) throw redirect({ to: "/login" });
    return { session };
  },
  component: Shell,
});

type PagePermission = PanelPermission | readonly PanelPermission[];
type NavigationItem = {
  to: "/repos" | "/runs" | "/stats" | "/credentials" | "/settings" | "/access" | "/password";
  label: string;
  permission?: PagePermission;
  admin?: true;
  always?: true;
};

const NAV: readonly NavigationItem[] = [
  { to: "/repos", label: "仓库", permission: "repo:read" },
  { to: "/runs", label: "评审记录", permission: "review:read" },
  { to: "/stats", label: "处置率", permission: "review:read" },
  { to: "/credentials", label: "模型服务", permission: ["model:read", "model:write", "credential:read", "credential:write"] },
  { to: "/settings", label: "全局设置", permission: "model:read" },
  { to: "/access", label: "访问控制", admin: true },
  { to: "/password", label: "修改密码", always: true },
];

function hasPagePermission(session: PanelSession, permission: PagePermission): boolean {
  return typeof permission === "string"
    ? hasPermission(session, permission)
    : permission.some((candidate) => hasPermission(session, candidate));
}

function visibleNav(session: PanelSession) {
  const hasBusinessAccess = session.isSystemAdmin || session.permissions.length > 0;
  return NAV.filter((item) =>
    (item.always === true && hasBusinessAccess) ||
    (item.admin === true
      ? session.isSystemAdmin
      : item.permission !== undefined && hasPagePermission(session, item.permission)),
  );
}

function homeFor(session: PanelSession): string {
  if (session.mustChangePassword) return "/password";
  return visibleNav(session)[0]?.to ?? "/";
}

function Shell() {
  const router = useRouter();
  const { session } = shellRoute.useRouteContext();
  const items = session.mustChangePassword ? [] : visibleNav(session);

  async function logout(): Promise<void> {
    await api("/session", { method: "DELETE" }).catch(() => undefined);
    clearPanelSession();
    await router.navigate({ to: "/login" });
  }

  return (
    <div className="flex h-dvh flex-col bg-chrome sm:grid sm:grid-cols-[200px_minmax(0,1fr)]">
      <aside className="flex shrink-0 flex-col border-border bg-chrome max-sm:border-b sm:border-r">
        <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <Mark className="size-5 shrink-0 text-primary" />
          <span className="truncate font-semibold tracking-tight">MultiReviewer</span>
          <div className="ml-auto flex min-w-0 items-center gap-1 sm:hidden">
            <span className="max-w-28 truncate text-xs text-muted-foreground">
              {session.displayName ?? session.username}
            </span>
            <button
              type="button"
              aria-label={`登出 ${session.username}`}
              title="登出"
              onClick={() => void logout()}
              className="flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
        <nav
          aria-label="面板导航"
          className="flex shrink-0 gap-1 overflow-x-auto px-2 py-2 sm:flex-col sm:overflow-visible"
        >
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex h-10 shrink-0 touch-manipulation items-center rounded-sm border border-transparent px-3 whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome sm:h-8 sm:shrink"
              activeProps={{
                "aria-current": "page",
                className: "border-border bg-background font-medium text-foreground",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-border p-2 sm:block">
          <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{session.displayName ?? session.username}</p>
              {session.displayName === null ? null : (
                <p className="truncate text-xs text-muted-foreground">{session.username}</p>
              )}
            </div>
            <button
              type="button"
              aria-label={`登出 ${session.username}`}
              title="登出"
              onClick={() => void logout()}
              className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
        <div className="min-h-full w-full max-w-7xl"><Outlet /></div>
      </main>
    </div>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
    const target = visibleNav(context.session)[0]?.to;
    if (target !== undefined) throw redirect({ to: target });
  },
  component: ZeroPermissionPage,
});

function protectedPage(
  path: "/repos" | "/runs" | "/stats" | "/credentials" | "/settings",
  permission: PagePermission,
  component: () => React.JSX.Element,
) {
  return createRoute({
    getParentRoute: () => shellRoute,
    path,
    beforeLoad: ({ context }) => {
      if (context.session.mustChangePassword) throw redirect({ to: "/password" });
      if (!hasPagePermission(context.session, permission)) throw redirect({ to: "/" });
    },
    component,
  });
}

const reposRoute = protectedPage("/repos", "repo:read", ReposPage);
const runsRoute = protectedPage("/runs", "review:read", RunsPage);
const statsRoute = protectedPage("/stats", "review:read", StatsPage);
const credentialsRoute = protectedPage(
  "/credentials",
  ["model:read", "model:write", "credential:read", "credential:write"],
  () => {
    const { session } = shellRoute.useRouteContext();
    return (
      <ModelServicesPage
        canReadModels={hasPermission(session, "model:read") || hasPermission(session, "model:write")}
        canWriteModels={hasPermission(session, "model:write")}
        canReadCredential={hasPermission(session, "credential:read") || hasPermission(session, "credential:write")}
        canWriteCredential={hasPermission(session, "credential:write")}
      />
    );
  },
);
const settingsRoute = protectedPage("/settings", "model:read", SettingsPage);

const accessRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/access",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
    if (!context.session.isSystemAdmin) throw redirect({ to: "/" });
  },
  component: AccessControlPage,
});

const passwordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/password",
  beforeLoad: () => {},
  component: () => {
    const { session } = shellRoute.useRouteContext();
    return <PasswordPage session={session} next={homeFor({ ...session, mustChangePassword: false })} />;
  },
});
function ZeroPermissionPage() {
  const { session } = shellRoute.useRouteContext();
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-[30rem] max-w-full items-start gap-2 px-5 py-5">
        <h1 className="text-lg font-semibold">你的账号还没有任何权限</h1>
        <p className="text-muted-foreground">账号已经建好,但还没有角色。请联系系统管理员给你一个角色;刷新后,可用页面会出现在导航里。</p>
        <p className="text-muted-foreground">系统管理员:{session.systemAdmins.join("、")}</p>
        <Link to="/password" className="text-sm underline underline-offset-4">修改密码</Link>
      </Card>
    </div>
  );
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    indexRoute,
    reposRoute,
    runsRoute,
    statsRoute,
    credentialsRoute,
    settingsRoute,
    accessRoute,
    passwordRoute,
  ]),
]);

const router = createRouter({ routeTree, basepath: `/${prefix}` });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
