import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { ExitIcon } from "@radix-ui/react-icons";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { Mark } from "@/components/mark";
import { EmptyState } from "@/components/empty-state";
import { PanelTheme } from "@/components/panel-theme";
import { Card, IconButton, Skeleton, Tooltip } from "@radix-ui/themes";

import { api } from "./api.ts";
import type { ModelServiceTab } from "./credentials.tsx";
import { injected } from "./injected.ts";
import {
  clearPanelSession,
  hasPermission,
  loadPanelSession,
  type PanelPermission,
  type PanelSession,
} from "./session.ts";
import { SETUP_STATUS_QUERY_KEY, SetupChecklist } from "./setup-checklist.tsx";
import "./styles.css";

const AccessControlPage = lazy(async () => ({ default: (await import("./access-control.tsx")).AccessControlPage }));
const LoginPage = lazy(async () => ({ default: (await import("./login.tsx")).LoginPage }));
const PasswordPage = lazy(async () => ({ default: (await import("./password.tsx")).PasswordPage }));
const ReposPage = lazy(async () => ({ default: (await import("./repos.tsx")).ReposPage }));
const RunsPage = lazy(async () => ({ default: (await import("./runs.tsx")).RunsPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./settings.tsx")).SettingsPage }));
const StatsPage = lazy(async () => ({ default: (await import("./stats.tsx")).StatsPage }));
const credentialsModule = () => import("./credentials.tsx");
const BuiltinServiceDiscoverPage = lazy(async () => ({ default: (await credentialsModule()).BuiltinServiceDiscoverPage }));
const BuiltinServiceVerifyPage = lazy(async () => ({ default: (await credentialsModule()).BuiltinServiceVerifyPage }));
const CustomServiceDiscoverPage = lazy(async () => ({ default: (await credentialsModule()).CustomServiceDiscoverPage }));
const CustomServiceVerifyPage = lazy(async () => ({ default: (await credentialsModule()).CustomServiceVerifyPage }));
const ModelServiceSetupLayout = lazy(async () => ({ default: (await credentialsModule()).ModelServiceSetupLayout }));
const ModelServiceSourcePage = lazy(async () => ({ default: (await credentialsModule()).ModelServiceSourcePage }));
const ModelServicesPage = lazy(async () => ({ default: (await credentialsModule()).ModelServicesPage }));

const { prefix } = injected();

const rootRoute = createRootRoute({ component: () => <Outlet /> });

function PageLoading() {
  return (
    <div className="w-full max-w-[760px] p-4 sm:p-5" role="status" aria-label="正在加载页面" aria-busy="true">
      <Card size="2" className="flex flex-col gap-3">
        <Skeleton aria-hidden className="h-6 w-40" />
        <Skeleton aria-hidden className="h-4 w-64 max-w-full" />
        <Skeleton aria-hidden className="h-40 w-full" />
      </Card>
    </div>
  );
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <Suspense fallback={<PageLoading />}><LoginPage /></Suspense>,
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
  { to: "/runs", label: "评审记录", permission: "review:read" },
  { to: "/repos", label: "仓库", permission: "repo:read" },
  { to: "/stats", label: "处置率", permission: "review:read" },
  { to: "/credentials", label: "模型服务", permission: ["model:read", "model:write", "credential:read", "credential:write"] },
  { to: "/settings", label: "审查策略", permission: "model:read" },
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
    <div className="flex h-dvh w-full min-w-0 max-w-full flex-col overflow-x-hidden bg-chrome sm:grid sm:grid-cols-[200px_minmax(0,1fr)]">
      <aside className="flex min-w-0 max-w-full shrink-0 flex-col overflow-hidden border-border bg-chrome max-sm:border-b sm:overflow-visible sm:border-r">
        <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <Mark className="size-5 shrink-0 text-primary" />
          <span className="truncate font-semibold tracking-tight">MultiReviewer</span>
          <div className="ml-auto flex min-w-0 items-center gap-1 sm:hidden">
            <Tooltip content={session.displayName ?? session.username}>
              <span
                tabIndex={0}
                className="max-w-28 truncate rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
              >
                {session.displayName ?? session.username}
              </span>
            </Tooltip>
            <Tooltip content="退出登录">
              <IconButton
                type="button"
                variant="ghost"
                color="gray"
                size="3"
                aria-label={`退出登录 ${session.username}`}
                onClick={() => void logout()}
                className="shrink-0 touch-manipulation max-sm:min-h-11 max-sm:min-w-11"
              >
                <ExitIcon className="size-4" aria-hidden />
              </IconButton>
            </Tooltip>
          </div>
        </div>
        <p className="flex items-center justify-between px-3 pt-2 text-xs text-muted-foreground sm:hidden">
          <span>导航</span>
          <span>横向滑动查看更多</span>
        </p>
        <nav aria-label="面板导航" className="flex min-w-0 max-w-full shrink-0 gap-1 overflow-x-auto px-2 py-2 sm:flex-col sm:overflow-visible">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex h-11 shrink-0 touch-manipulation items-center rounded-sm border px-3 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome sm:h-8 sm:shrink"
              activeProps={{
                "aria-current": "page",
                className: "border-border bg-background font-medium text-foreground",
              }}
              inactiveProps={{
                className: "border-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-border p-2 sm:block">
          <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <Tooltip content={session.displayName ?? session.username}>
                <p
                  tabIndex={0}
                  className="truncate rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
                >
                  {session.displayName ?? session.username}
                </p>
              </Tooltip>
              {session.displayName === null ? null : (
                <Tooltip content={session.username}>
                  <p
                    tabIndex={0}
                    className="truncate rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
                  >
                    {session.username}
                  </p>
                </Tooltip>
              )}
            </div>
            <Tooltip content="退出登录">
              <IconButton
                type="button"
                variant="ghost"
                color="gray"
                size="2"
                aria-label={`退出登录 ${session.username}`}
                onClick={() => void logout()}
                className="shrink-0"
              >
                <ExitIcon className="size-4" aria-hidden />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </aside>
      <main id="panel-main-scroll" className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
        <div className="h-full min-h-0 w-full max-w-7xl">
          <Suspense fallback={<PageLoading />}><Outlet /></Suspense>
        </div>
      </main>
    </div>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    const target = homeFor(context.session);
    if (target !== "/") throw redirect({ to: target });
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
    component: () => <BusinessPage Page={component} />,
  });
}

function BusinessPage({ Page }: { Page: () => React.JSX.Element }) {
  const { session } = shellRoute.useRouteContext();
  return (
    <>
      <SetupChecklist session={session} />
      <Page />
    </>
  );
}

const reposRoute = protectedPage("/repos", "repo:read", () => {
  const { session } = shellRoute.useRouteContext();
  return (
    <ReposPage
      canWrite={hasPermission(session, "repo:write")}
      canReadModels={hasPermission(session, "model:read")}
      canReadReviews={hasPermission(session, "review:read")}
      canRerun={hasPermission(session, "review:rerun")}
    />
  );
});
const runsRoute = protectedPage("/runs", "review:read", () => {
  const { session } = shellRoute.useRouteContext();
  return <RunsPage canRerun={hasPermission(session, "review:rerun")} />;
});
const statsRoute = protectedPage("/stats", "review:read", () => <StatsPage />);
function ModelServicesRoutePage({
  provider,
  tab,
}: {
  provider?: string | undefined;
  tab?: ModelServiceTab | undefined;
}) {
  const { session } = shellRoute.useRouteContext();
  return (
    <ModelServicesPage
      provider={provider}
      tab={tab}
      canReadModels={hasPermission(session, "model:read")}
      canWriteModels={hasPermission(session, "model:write")}
      canReadCredential={hasPermission(session, "credential:read")}
      canWriteCredential={hasPermission(session, "credential:write")}
    />
  );
}

const credentialsRoute = protectedPage(
  "/credentials",
  ["model:read", "model:write", "credential:read", "credential:write"],
  () => <ModelServicesRoutePage />,
);
const modelServiceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/credentials/$provider",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
    if (!hasPagePermission(context.session, ["model:read", "model:write", "credential:read", "credential:write"])) {
      throw redirect({ to: "/" });
    }
  },
  component: () => <BusinessPage Page={() => <ModelServicesRoutePage provider={modelServiceRoute.useParams().provider} tab="overview" />} />,
});
const modelServiceMaintenanceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/credentials/$provider/maintenance",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
    if (!hasPagePermission(context.session, ["model:read", "model:write", "credential:read", "credential:write"])) {
      throw redirect({ to: "/" });
    }
  },
  component: () => <BusinessPage Page={() => (
    <ModelServicesRoutePage provider={modelServiceMaintenanceRoute.useParams().provider} tab="maintenance" />
  )} />,
});
const modelServiceModelsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/credentials/$provider/models",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
    if (!hasPagePermission(context.session, ["model:read", "model:write", "credential:read", "credential:write"])) {
      throw redirect({ to: "/" });
    }
  },
  component: () => <BusinessPage Page={() => <ModelServicesRoutePage provider={modelServiceModelsRoute.useParams().provider} tab="models" />} />,
});
const modelServiceSetupRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/credentials/add",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
    if (!hasPermission(context.session, "credential:write")) throw redirect({ to: "/credentials" });
  },
  component: ModelServiceSetupLayout,
});
const modelServiceSetupSourceRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/",
  component: () => {
    const { session } = shellRoute.useRouteContext();
    return (
      <ModelServiceSourcePage
        canWriteCustom={hasPermission(session, "model:write") && hasPermission(session, "credential:write")}
      />
    );
  },
});
const builtinServiceDiscoverRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/builtin/$provider/discover",
  component: () => (
    <BuiltinServiceDiscoverPage provider={builtinServiceDiscoverRoute.useParams().provider} />
  ),
});
const builtinServiceVerifyRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/builtin/$provider/verify",
  component: () => (
    <BuiltinServiceVerifyPage provider={builtinServiceVerifyRoute.useParams().provider} />
  ),
});
const customServiceCreateDiscoverRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/custom/discover",
  beforeLoad: ({ context }) => {
    if (!hasPermission(context.session, "model:write")) throw redirect({ to: "/credentials" });
  },
  component: () => <CustomServiceDiscoverPage />,
});
const customServiceCreateVerifyRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/custom/verify",
  beforeLoad: ({ context }) => {
    if (!hasPermission(context.session, "model:write")) throw redirect({ to: "/credentials" });
  },
  component: () => <CustomServiceVerifyPage />,
});
const customServiceUpdateDiscoverRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/custom/$provider/discover",
  beforeLoad: ({ context }) => {
    if (!hasPermission(context.session, "model:write")) throw redirect({ to: "/credentials" });
  },
  component: () => (
    <CustomServiceDiscoverPage provider={customServiceUpdateDiscoverRoute.useParams().provider} />
  ),
});
const customServiceUpdateVerifyRoute = createRoute({
  getParentRoute: () => modelServiceSetupRoute,
  path: "/custom/$provider/verify",
  beforeLoad: ({ context }) => {
    if (!hasPermission(context.session, "model:write")) throw redirect({ to: "/credentials" });
  },
  component: () => (
    <CustomServiceVerifyPage provider={customServiceUpdateVerifyRoute.useParams().provider} />
  ),
});
const settingsRoute = protectedPage("/settings", "model:read", () => {
  const { session } = shellRoute.useRouteContext();
  return <SettingsPage canWrite={hasPermission(session, "model:write")} />;
});

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
      <EmptyState
        title="当前账号暂无访问权限"
        titleAs="h1"
        description={(
          <>
            <span className="block">当前账号尚未分配角色。请联系系统管理员完成角色分配，然后刷新页面。</span>
            <span className="mt-1 block">系统管理员：{session.systemAdmins.join("、")}</span>
          </>
        )}
        action={<Link to="/password" className="text-sm underline underline-offset-4">修改密码</Link>}
        className="w-[30rem] max-w-full rounded-md border border-border bg-card p-4"
      />
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
    modelServiceRoute,
    modelServiceMaintenanceRoute,
    modelServiceModelsRoute,
    modelServiceSetupRoute.addChildren([
      modelServiceSetupSourceRoute,
      builtinServiceDiscoverRoute,
      builtinServiceVerifyRoute,
      customServiceCreateDiscoverRoute,
      customServiceCreateVerifyRoute,
      customServiceUpdateDiscoverRoute,
      customServiceUpdateVerifyRoute,
    ]),
    settingsRoute,
    accessRoute,
    passwordRoute,
  ]),
]);

const router = createRouter({ routeTree, basepath: `/${prefix}` });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY });
    },
  }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PanelTheme>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </PanelTheme>
  </StrictMode>,
);
