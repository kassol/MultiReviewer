import { MutationCache, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  RouterProvider,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  ArchiveIcon,
  BarChartIcon,
  CounterClockwiseClockIcon,
  DashboardIcon,
  LayersIcon,
  LightningBoltIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { CommandPalette, useCommandPalette } from "@/components/command-palette";
import { Mark } from "@/components/mark";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { PanelTheme } from "@/components/panel-theme";
import { DropdownMenu, Skeleton } from "@radix-ui/themes";

import { api, fetchJson } from "./api.ts";
import type { ModelServiceTab } from "./credentials.tsx";
import { injected } from "./injected.ts";
import {
  clearPanelSession,
  hasPermission,
  loadPanelSession,
  type PanelPermission,
  type PanelSession,
} from "./session.ts";
import { SETUP_STATUS_QUERY_KEY, SetupChecklist, useSetupStatus } from "./setup-checklist.tsx";
import "./styles.css";

const AccessControlPage = lazy(async () => ({ default: (await import("./access-control.tsx")).AccessControlPage }));
const LoginPage = lazy(async () => ({ default: (await import("./login.tsx")).LoginPage }));
const PasswordPage = lazy(async () => ({ default: (await import("./password.tsx")).PasswordPage }));
const RangeReviewsPage = lazy(async () => ({ default: (await import("./range-reviews.tsx")).RangeReviewsPage }));
const ReposPage = lazy(async () => ({ default: (await import("./repos.tsx")).ReposPage }));
const RunsPage = lazy(async () => ({ default: (await import("./runs.tsx")).RunsPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./settings.tsx")).SettingsPage }));
const StatsPage = lazy(async () => ({ default: (await import("./stats.tsx")).StatsPage }));
const OverviewPage = lazy(async () => ({ default: (await import("./overview.tsx")).OverviewPage }));
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

/** 表单档正文列宽的几页。骨架选错档就会比正文窄一截,页面到了再横跳回来。 */
const FORM_WIDTH_PATHS = ["/stats", "/settings", "/access"] as const;

/** 骨架按正文的列宽和边距摆:换页时它和随后渲染出来的页面占同一条内容轨,不跳。 */
function PageLoading() {
  const path = window.location.pathname;
  const width = FORM_WIDTH_PATHS.some((suffix) => path.endsWith(suffix)) ? "form" : "wide";
  return (
    <PageBody width={width} role="status" aria-label="正在加载页面" aria-busy="true">
      <Skeleton aria-hidden className="h-11 w-56 max-w-full" />
      <Skeleton aria-hidden className="h-5 w-96 max-w-full" />
      <Skeleton aria-hidden className="h-56 w-full" />
    </PageBody>
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
  to:
    | "/"
    | "/repos"
    | "/runs"
    | "/range-reviews"
    | "/stats"
    | "/credentials"
    | "/settings"
    | "/access"
    | "/password";
  label: string;
  /** 移动端底部 Tab 栏用。桌面 underline 导航只有文字,不挂图标。 */
  icon: typeof DashboardIcon;
  permission?: PagePermission;
  admin?: true;
  always?: true;
};

/**
 * 顺序即导航顺序,与设计稿一致:总览打头,账户项收尾。收尾的「修改密码」在桌面端
 * 走头像菜单,不占 underline 导航的位置。
 */
const NAV: readonly NavigationItem[] = [
  { to: "/", label: "总览", icon: DashboardIcon, permission: "review:read" },
  { to: "/runs", label: "评审记录", icon: CounterClockwiseClockIcon, permission: "review:read" },
  { to: "/range-reviews", label: "范围审查", icon: LayersIcon, permission: "review:read" },
  { to: "/repos", label: "仓库", icon: ArchiveIcon, permission: "repo:read" },
  { to: "/stats", label: "处置率", icon: BarChartIcon, permission: "review:read" },
  { to: "/credentials", label: "模型服务", icon: LightningBoltIcon, permission: ["model:read", "model:write", "credential:read", "credential:write"] },
  { to: "/settings", label: "审查策略", icon: MixerHorizontalIcon, permission: "model:read" },
  { to: "/access", label: "访问控制", icon: PersonIcon, admin: true },
  { to: "/password", label: "修改密码", icon: LockClosedIcon, always: true },
];

/** 桌面顶栏的 underline 导航:账户项不在其中。 */
function primaryNav(session: PanelSession): readonly NavigationItem[] {
  return visibleNav(session).filter((item) => item.to !== "/password");
}

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
  const nav = session.mustChangePassword ? [] : primaryNav(session);
  const palette = useCommandPalette();

  async function logout(): Promise<void> {
    await api("/session", { method: "DELETE" }).catch(() => undefined);
    clearPanelSession();
    await router.navigate({ to: "/login" });
  }

  return (
    <div className="flex h-dvh w-full min-w-0 max-w-full flex-col overflow-x-hidden bg-background">
      {/*
        顶栏与移动端 Tab 栏都放进滚动容器里 sticky,而不是当作外面的兄弟节点:毛玻璃
        要有东西可模糊,内容必须从它们底下滚过去。挂在滚动容器外面时,那层 blur 背后
        永远只有页面底色,顶栏就是一块纯白平板。
      */}
      <div id="panel-main-scroll" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <TopBar nav={nav} session={session} onSearch={palette.open} onLogout={logout} />
        <main className="min-w-0 flex-1">
          <Suspense fallback={<PageLoading />}><Outlet /></Suspense>
        </main>
        <MobileTabBar nav={nav} session={session} onLogout={logout} />
      </div>
      <CommandPalette nav={nav} state={palette} />
    </div>
  );
}

/**
 * 双层毛玻璃顶栏。第一行是身份与全局动作,第二行是 underline 导航——两层分开,是
 * 因为导航项会随权限增减,把它和品牌挤在一行会让窄屏下的品牌位置跟着跳。
 * 移动端只保留第一行,导航交给底部 Tab 栏。
 */
function TopBar({
  nav,
  session,
  onSearch,
  onLogout,
}: {
  nav: readonly NavigationItem[];
  session: PanelSession;
  onSearch: () => void;
  onLogout: () => Promise<void>;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = nav.find((item) => item.to === "/" ? pathname === "/" : pathname.startsWith(item.to));
  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-chrome-line bg-chrome backdrop-blur-[30px]">
      <div className="flex items-center justify-between gap-3 px-4 pt-[11px] pb-2 sm:px-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-sm bg-[image:var(--v8-mark-gradient)] shadow-mark">
            <Mark framed={false} className="size-4 text-white" />
          </span>
          <span className="shrink-0 text-xl font-bold tracking-[-0.015em]">MultiReviewer</span>
          {current === undefined ? null : (
            <>
              <span className="text-text-faint max-sm:hidden" aria-hidden>/</span>
              <span className="truncate text-xl font-semibold max-sm:hidden">{current.label}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={onSearch}
            aria-label="搜索或跳转"
            aria-keyshortcuts="Meta+K Control+K"
            className="flex items-center gap-[7px] rounded-md bg-fill px-3 py-1.5 text-md text-text-muted outline-none transition-colors hover:bg-fill/80 focus-visible:ring-2 focus-visible:ring-ring/40 sm:w-[300px] sm:justify-between"
          >
            <span className="flex items-center gap-[7px]">
              <MagnifyingGlassIcon className="size-3.5" aria-hidden />
              <span className="max-sm:hidden">搜索或跳转…</span>
            </span>
            <kbd className="font-mono text-xs text-text-disabled max-sm:hidden">⌘K</kbd>
          </button>
          <UserMenu session={session} onLogout={onLogout} />
        </div>
      </div>
      {nav.length === 0 ? null : (
        <nav aria-label="面板导航" className="flex items-center gap-0.5 px-5 max-sm:hidden">
          {nav.map((item) => (
            <NavLink key={item.to} item={item} session={session} />
          ))}
        </nav>
      )}
    </header>
  );
}

/**
 * underline 导航项。激活态是 3px 蓝色圆头指示条 + 字重提到 650,底部 padding 相应
 * 减去指示条的高度,所以激活与未激活的文字基线对齐,切换页面时文字不会上下跳。
 */
function NavLink({ item, session }: { item: NavigationItem; session: PanelSession }) {
  const badge = useNavBadge(item, session);
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === "/" }}
      className="flex flex-col items-stretch outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {({ isActive }) => (
        <>
          <span
            className={`flex items-center gap-[7px] px-3 pt-[7px] whitespace-nowrap transition-colors ${
              isActive ? "pb-[9px] font-bold text-text" : "pb-3 text-text-secondary hover:text-text"
            }`}
          >
            {item.label}
            {badge.count === undefined ? null : (
              <span
                className={`rounded-full px-[7px] text-sm font-semibold tabular-nums ${
                  isActive ? "bg-accent-tint text-primary" : "bg-fill text-text-secondary"
                }`}
              >
                {badge.count}
              </span>
            )}
            {badge.alert ? (
              <span className="size-[7px] rounded-full bg-warning-icon" role="img" aria-label="需要处理" />
            ) : null}
          </span>
          {isActive ? <span className="h-[3px] rounded-t-[3px] bg-primary mx-3" aria-hidden /> : null}
        </>
      )}
    </Link>
  );
}

/**
 * 导航项右侧的计数与告警点。两者都只读已有查询的缓存语义:
 * - 仓库数直接来自 `/repos` 的数组长度。
 * - 运行数没有对应的总数端点(`/runs` 是游标分页),所以不显示计数,而不是拿第一页
 *   的条数冒充总数。
 * - 模型服务的告警点来自首次配置状态里的「有没有可用模型服务」。
 */
function useNavBadge(item: NavigationItem, session: PanelSession): { count?: number; alert: boolean } {
  const canReadRepos = hasPermission(session, "repo:read");
  const repos = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<unknown[]>("/repos"),
    enabled: item.to === "/repos" && canReadRepos,
  });
  const setup = useSetupStatus();
  if (item.to === "/repos") {
    return repos.data === undefined ? { alert: false } : { count: repos.data.length, alert: false };
  }
  if (item.to === "/credentials") {
    return { alert: setup.data?.hasRunnableModelService === false };
  }
  return { alert: false };
}

/** 顶栏右上角的头像菜单。桌面端的「修改密码」与「退出登录」都收在这里。 */
function UserMenu({ session, onLogout }: { session: PanelSession; onLogout: () => Promise<void> }) {
  const name = session.displayName ?? session.username;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button
          type="button"
          aria-label={`账户 ${name}`}
          className="flex size-[27px] shrink-0 items-center justify-center rounded-full bg-[image:var(--v8-avatar-gradient)] text-base font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {name.slice(0, 1).toUpperCase()}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" size="2">
        <DropdownMenu.Label>{name}</DropdownMenu.Label>
        <DropdownMenu.Item asChild>
          <Link to="/password">修改密码</Link>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item color="red" onSelect={() => void onLogout()}>
          退出登录
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/**
 * 移动端底部 Tab 栏。设计稿画的是固定五项,但导航项随权限增减,所以取前四个有权限
 * 的页面 + 一个「我的」——「我的」收纳装不下的页面与账户动作,不然低权限用户会看到
 * 一排空位,高权限用户会丢掉入口。
 */
function MobileTabBar({
  nav,
  session,
  onLogout,
}: {
  nav: readonly NavigationItem[];
  session: PanelSession;
  onLogout: () => Promise<void>;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (nav.length === 0) return null;
  const tabs = nav.slice(0, 4);
  const overflow = nav.slice(4);
  const name = session.displayName ?? session.username;
  // 当前页收在「我的」里时,这个按钮就是激活项。不点亮的话,窄屏打开审查策略或访问
  // 控制,整条 Tab 栏没有一项是亮的——用户失去"我在哪"的唯一线索。
  const inOverflow =
    overflow.some((item) => pathname.startsWith(item.to)) || pathname.startsWith("/password");
  return (
    <nav
      aria-label="面板导航"
      className="sticky bottom-0 z-30 flex shrink-0 items-stretch border-t border-chrome-line bg-[color:var(--v8-tabbar-bg)] px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-[30px] sm:hidden"
    >
      {tabs.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === "/" }}
          className="flex flex-1 flex-col items-center gap-[3px] py-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          activeProps={{ className: "text-primary", "aria-current": "page" }}
          inactiveProps={{ className: "text-text-muted" }}
        >
          <item.icon className="size-[21px]" aria-hidden />
          <span className="text-[10px] font-medium">{item.label}</span>
        </Link>
      ))}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <button
            type="button"
            {...(inOverflow ? { "aria-current": "page" as const } : {})}
            className={`flex flex-1 flex-col items-center gap-[3px] py-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              inOverflow ? "text-primary" : "text-text-muted"
            }`}
          >
            <PersonIcon className="size-[21px]" aria-hidden />
            <span className="text-[10px] font-medium">我的</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" size="2">
          <DropdownMenu.Label>{name}</DropdownMenu.Label>
          {overflow.map((item) => (
            <DropdownMenu.Item key={item.to} asChild>
              <Link to={item.to}>{item.label}</Link>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item asChild>
            <Link to="/password">修改密码</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item color="red" onSelect={() => void onLogout()}>
            退出登录
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </nav>
  );
}

/**
 * 首页就是总览。看得到评审记录的人落在总览上;只有仓库或模型权限的人落在自己的
 * 第一个页面;一个权限都没有的人看到说明页,而不是一个空的总览。
 */
const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    const target = homeFor(context.session);
    if (target !== "/") throw redirect({ to: target });
  },
  component: IndexPage,
});

function IndexPage() {
  const { session } = shellRoute.useRouteContext();
  if (!hasPermission(session, "review:read")) return <ZeroPermissionPage />;
  return <BusinessPage Page={() => <OverviewPage />} />;
}

function protectedPage(
  path: "/repos" | "/runs" | "/range-reviews" | "/stats" | "/credentials" | "/settings",
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
      canDispose={hasPermission(session, "finding:dispose")}
    />
  );
});
const runsRoute = protectedPage("/runs", "review:read", () => {
  const { session } = shellRoute.useRouteContext();
  return (
    <RunsPage
      canRerun={hasPermission(session, "review:rerun")}
      canDispose={hasPermission(session, "finding:dispose")}
    />
  );
});
const rangeReviewsRoute = protectedPage("/range-reviews", "review:read", () => {
  const { session } = shellRoute.useRouteContext();
  return <RangeReviewsPage canCreate={hasPermission(session, "review:create")} />;
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
    rangeReviewsRoute,
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
