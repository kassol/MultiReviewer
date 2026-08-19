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
import { CredentialsPage } from "./credentials.tsx";
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

const NAV: readonly { to: "/repos" | "/runs" | "/stats" | "/credentials" | "/settings" | "/access" | "/password"; label: string; permission?: PanelPermission; admin?: true; always?: true }[] = [
  { to: "/repos", label: "仓库", permission: "repo:read" },
  { to: "/runs", label: "评审记录", permission: "review:read" },
  { to: "/stats", label: "处置率", permission: "review:read" },
  { to: "/credentials", label: "模型凭据", permission: "credential:read" },
  { to: "/settings", label: "全局设置", permission: "model:read" },
  { to: "/access", label: "访问控制", admin: true },
  { to: "/password", label: "修改密码", always: true },
];

function visibleNav(session: PanelSession) {
  const hasBusinessAccess = session.isSystemAdmin || session.permissions.length > 0;
  return NAV.filter((item) =>
    (item.always === true && hasBusinessAccess) ||
    (item.admin === true ? session.isSystemAdmin : item.permission !== undefined && hasPermission(session, item.permission)),
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
    <div className="flex h-dvh flex-col sm:grid sm:grid-cols-[200px_1fr]">
      <aside className="flex shrink-0 flex-col border-border bg-chrome max-sm:flex-row max-sm:items-center max-sm:overflow-x-auto max-sm:border-b sm:border-r">
        <div className="flex shrink-0 items-center gap-2 border-border px-3 py-3.5 max-sm:py-2.5 sm:border-b">
          <Mark className="size-4" />
          <span className="font-semibold tracking-tight">MultiReviewer</span>
        </div>
        <nav aria-label="面板导航" className="flex shrink-0 gap-0.5 p-2 sm:flex-col">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex h-10 items-center rounded-md px-3 whitespace-nowrap text-muted-foreground transition-colors hover:bg-background hover:text-foreground sm:h-8"
              activeProps={{
                "aria-current": "page",
                className: "bg-background font-medium text-foreground shadow-[0_0_0_1px_var(--border)]",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button type="button" onClick={() => void logout()} className="flex h-10 shrink-0 items-center gap-1.5 px-4 whitespace-nowrap text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground max-sm:ml-auto sm:mt-auto sm:mb-2 sm:h-9">
          <LogOut className="size-3.5" />登出
        </button>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto"><Outlet /></main>
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

function protectedPage(path: "/repos" | "/runs" | "/stats" | "/credentials" | "/settings", permission: PanelPermission, component: () => React.JSX.Element) {
  return createRoute({
    getParentRoute: () => shellRoute,
    path,
    beforeLoad: ({ context }) => {
      if (context.session.mustChangePassword) throw redirect({ to: "/password" });
      if (!hasPermission(context.session, permission)) throw redirect({ to: "/" });
    },
    component,
  });
}

const reposRoute = protectedPage("/repos", "repo:read", ReposPage);
const runsRoute = protectedPage("/runs", "review:read", RunsPage);
const statsRoute = protectedPage("/stats", "review:read", StatsPage);
const credentialsRoute = protectedPage("/credentials", "credential:read", CredentialsPage);
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
