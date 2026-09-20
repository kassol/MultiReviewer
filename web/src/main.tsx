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
  BarChartIcon,
  CounterClockwiseClockIcon,
  CubeIcon,
  LightningBoltIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import { Fragment, lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { CommandPalette, useCommandPalette } from "@/components/command-palette";
import { Mark } from "@/components/mark";
import { PageBody } from "@/components/page-body";
import { PanelTheme } from "@/components/panel-theme";
import { DropdownMenu, Skeleton } from "@radix-ui/themes";

import {
  agentSessionQueryKey,
  PURPOSE_LABEL,
  sessionTitle,
  type AgentSession,
} from "@/lib/agent-sessions";
import { productQueryKey, type ProductDetail } from "@/lib/products";

import { api, fetchJson } from "./api.ts";
import type { ModelServiceTab } from "./credentials.tsx";
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
const AgentSessionPage = lazy(async () => ({ default: (await import("./agent-session.tsx")).AgentSessionPage }));
const LoginPage = lazy(async () => ({ default: (await import("./login.tsx")).LoginPage }));
const PasswordPage = lazy(async () => ({ default: (await import("./password.tsx")).PasswordPage }));
const ProductsPage = lazy(async () => ({ default: (await import("./products.tsx")).ProductsPage }));
const RunsPage = lazy(async () => ({ default: (await import("./runs.tsx")).RunsPage }));
const StageDetailPage = lazy(async () => ({ default: (await import("./stage-detail.tsx")).StageDetailPage }));
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

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/** 骨架与正文占同一条内容轨:换页时不跳。 */
function PageLoading() {
  return (
    <PageBody role="status" aria-label="正在加载页面" aria-busy="true">
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
    | "/products"
    | "/stats"
    | "/credentials"
    | "/settings"
    | "/access"
    | "/password";
  label: string;
  /** 移动端底部 Tab 栏用。桌面 underline 导航只有文字,不挂图标。 */
  icon: typeof CounterClockwiseClockIcon;
  /** 省略即登录就看得见:读范围由仓库分配决定,不由权限格门控(ADR 0018)。 */
  permission?: PagePermission;
  admin?: true;
};

/**
 * 顺序即导航顺序:评审记录打头——它就是首页(issue #194),账户项收尾。收尾的「修改
 * 密码」在桌面端走头像菜单,不占 underline 导航的位置。
 */
const NAV: readonly NavigationItem[] = [
  { to: "/", label: "评审记录", icon: CounterClockwiseClockIcon },
  // 产品是 Agent 会话的入口(spec #329),不另加「会话」导航项。
  { to: "/products", label: "产品", icon: CubeIcon },
  { to: "/stats", label: "处置率", icon: BarChartIcon },
  { to: "/credentials", label: "模型服务", icon: LightningBoltIcon, permission: ["model:read", "model:write", "credential:read", "credential:write"] },
  { to: "/settings", label: "审查策略", icon: MixerHorizontalIcon, permission: "model:read" },
  { to: "/access", label: "访问控制", icon: PersonIcon, admin: true },
  { to: "/password", label: "修改密码", icon: LockClosedIcon },
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
  return NAV.filter((item) =>
    item.admin === true
      ? session.isSystemAdmin
      : item.permission === undefined || hasPagePermission(session, item.permission),
  );
}

/** 登录就落首页;还没改过密码的先去改密页。 */
function homeFor(session: PanelSession): string {
  return session.mustChangePassword ? "/password" : "/";
}

function Shell() {
  const router = useRouter();
  const { session } = shellRoute.useRouteContext();
  const nav = session.mustChangePassword ? [] : primaryNav(session);
  const palette = useCommandPalette();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Agent 会话页是占满视口的工作台(DESIGN.md 7.5):它自己滚,外壳的 main 要把高度限在
  // 剩余空间里(min-h-0),它的 h-full 才有定值可撑。别的页面照旧由 main 随内容长高、
  // 整体在 #panel-main-scroll 里滚——对它们加 min-h-0 会让 sticky 的 Tab 栏跟着滚走。
  const fillsViewport = /^\/products\/\d+\/sessions\/\d+$/.test(pathname);

  useEffect(() => {
    const page = pathname.startsWith("/stages")
      ? "审查阶段"
      : NAV.find((item) => item.to === "/" ? pathname === "/" : pathname.startsWith(item.to))?.label;
    document.title = page === undefined ? "MultiReviewer" : `${page} · MultiReviewer`;
  }, [pathname]);

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
        <TopBar
          nav={nav}
          session={session}
          searchButtonRef={palette.triggerRef}
          onSearch={palette.open}
          onLogout={logout}
        />
        <main className={fillsViewport ? "min-h-0 min-w-0 flex-1" : "min-w-0 flex-1"}>
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
  searchButtonRef,
  onSearch,
  onLogout,
}: {
  nav: readonly NavigationItem[];
  session: PanelSession;
  searchButtonRef: React.RefObject<HTMLButtonElement | null>;
  onSearch: () => void;
  onLogout: () => Promise<void>;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // 阶段页不是一张并列的页,它是从评审记录点进去的一个阶段:面包屑因此与它页顶那个
  // 返回一致,都指着评审记录——也就是首页(issue #189、#194)。
  const located = pathname.startsWith("/stages") ? "/" : pathname;
  const current = nav.find((item) => item.to === "/" ? located === "/" : located.startsWith(item.to));
  const deeper = useProductCrumbs(pathname);
  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-chrome-line bg-chrome backdrop-blur-[30px]">
      <div className="flex items-center justify-between gap-3 px-4 pt-[11px] pb-2 sm:px-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-sm bg-[image:var(--v8-mark-gradient)] shadow-mark">
            <Mark className="size-4 text-white" />
          </span>
          <span className="shrink-0 text-xl font-bold tracking-[-0.015em]">MultiReviewer</span>
          {current === undefined ? null : (
            <>
              <span className="text-text-faint max-sm:hidden" aria-hidden>/</span>
              <span className="truncate text-xl font-semibold max-sm:hidden">{current.label}</span>
            </>
          )}
          {deeper.map((crumb) => (
            <Fragment key={crumb}>
              <span className="text-text-faint max-lg:hidden" aria-hidden>/</span>
              <span className="max-w-[40ch] truncate text-xl font-semibold max-lg:hidden">{crumb}</span>
            </Fragment>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            ref={searchButtonRef}
            type="button"
            onClick={onSearch}
            aria-label="搜索或跳转"
            aria-keyshortcuts="Meta+K Control+K"
            // `min-w-11` 是布局宽度不是命中面积:`sm` 以下这颗只剩放大镜图标、内边距为 0,
            // 宽度只能由它给,去掉就塌成 14px 的图标宽。
            className="flex min-w-11 items-center justify-center gap-[7px] rounded-md bg-fill px-0 py-1.5 text-md text-text-muted outline-none transition-colors pointer-coarse:min-h-11 hover:bg-fill/80 focus-visible:ring-2 focus-visible:ring-ring/40 sm:w-[300px] sm:justify-between sm:px-3"
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
        <nav
          aria-label="面板导航"
          className="flex items-center gap-0.5 overflow-x-auto overscroll-x-contain px-5 max-sm:hidden"
        >
          {nav.map((item) => (
            <NavLink key={item.to} item={item} />
          ))}
        </nav>
      )}
    </header>
  );
}

/**
 * 产品之下那两段面包屑:产品名与会话用途(DESIGN.md 2.4「面包屑层级按真实路由层级」)。
 * 读的是产品页与会话页那两份缓存键,不另开端点;还没读到的那一段先不画,不用占位符冒充。
 */
function useProductCrumbs(pathname: string): string[] {
  const matched = /^\/products\/(\d+)(?:\/sessions\/(\d+))?$/.exec(pathname);
  const productId = matched === null ? undefined : Number(matched[1]);
  const sessionId = matched?.[2] === undefined ? undefined : Number(matched[2]);
  const product = useQuery({
    queryKey: productQueryKey(productId),
    queryFn: () => fetchJson<ProductDetail>(`/products/${productId!}`),
    enabled: productId !== undefined,
  });
  const session = useQuery({
    queryKey: agentSessionQueryKey(sessionId ?? 0),
    queryFn: () => fetchJson<{ session: AgentSession }>(`/agent-sessions/${sessionId!}`),
    enabled: sessionId !== undefined,
  });
  const data = session.data?.session;
  // 会话标题(`title`,服务端从首条用户消息派生)优先于用途名,与头部标题同一读法。
  const sessionCrumb =
    data === undefined ? undefined : sessionTitle(data.title, PURPOSE_LABEL[data.purpose]);
  return [product.data?.product.name, sessionCrumb].filter((crumb) => crumb !== undefined);
}

/**
 * underline 导航项。激活态是 3px 蓝色圆头指示条 + 字重提到 650,底部 padding 相应
 * 减去指示条的高度,所以激活与未激活的文字基线对齐,切换页面时文字不会上下跳。
 */
function NavLink({ item }: { item: NavigationItem }) {
  const alert = useNavAlert(item);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const stageUnderRecords = item.to === "/" && pathname.startsWith("/stages");
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === "/", includeSearch: false }}
      aria-current={stageUnderRecords ? "page" : undefined}
      className="flex shrink-0 flex-col items-stretch justify-end outline-none pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {({ isActive }) => {
        const active = isActive || stageUnderRecords;
        return (
          <>
            <span
              className={`flex items-center gap-[7px] px-3 pt-[7px] whitespace-nowrap transition-colors ${
                active ? "pb-[9px] font-bold text-text" : "pb-3 text-text-secondary hover:text-text"
              }`}
            >
              {item.label}
              {alert ? (
                <span className="size-[7px] rounded-full bg-warning-icon" role="img" aria-label="模型服务需要处理" />
              ) : null}
            </span>
            {active ? <span className="h-[3px] rounded-t-[3px] bg-primary mx-3" aria-hidden /> : null}
          </>
        );
      }}
    </Link>
  );
}

/**
 * 导航项右侧的告警点,只读已有查询的缓存语义:模型服务那一点来自首次配置状态里的
 * 「有没有可用模型服务」。导航上不显示计数——评审记录没有总数端点(`/stages` 按 offset
 * 翻页),拿第一页的条数冒充总数会说谎(issue #195:仓库那一项已经不在导航里了)。
 */
function useNavAlert(item: NavigationItem): boolean {
  const setup = useSetupStatus();
  return item.to === "/credentials" && setup.data?.hasRunnableModelService === false;
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
          className="flex size-[27px] shrink-0 items-center justify-center rounded-full outline-none pointer-coarse:size-11 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex size-[27px] items-center justify-center rounded-full bg-[image:var(--v8-avatar-gradient)] text-base font-medium text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
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
      {tabs.map((item) => {
        const stageUnderRecords = item.to === "/" && pathname.startsWith("/stages");
        return (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.to === "/", includeSearch: false }}
            aria-current={stageUnderRecords ? "page" : undefined}
            className="flex min-h-11 flex-1 flex-col items-center justify-center gap-[3px] py-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {({ isActive }) => {
              const tone = isActive || stageUnderRecords ? "text-primary" : "text-text-muted";
              return (
                <>
                  <item.icon className={`size-[21px] ${tone}`} aria-hidden />
                  <span className={`text-[11px] font-medium ${tone}`}>{item.label}</span>
                </>
              );
            }}
          </Link>
        );
      })}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <button
            type="button"
            {...(inOverflow ? { "aria-current": "page" as const } : {})}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-[3px] py-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              inOverflow ? "text-primary" : "text-text-muted"
            }`}
          >
            <PersonIcon className="size-[21px]" aria-hidden />
            <span className="text-[11px] font-medium">我的</span>
          </button>
        </DropdownMenu.Trigger>
        {/* Radix 默认离触发器 4px。这个菜单贴着 Tab 栏往上开,菜单项在触屏上有 44px 的
            命中区,末项「退出登录」的下沿离 Tab 栏太近,拉到 8px 才不会误点到 Tab。 */}
        <DropdownMenu.Content align="end" size="2" sideOffset={8}>
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
 * 首页就是评审记录(issue #194)。登录就落在这里:左栏是这个账号可见的仓库,右栏是
 * 所选仓库的审查阶段列表,可见多少由仓库分配决定。
 */
const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
  },
  component: () => {
    const { session } = shellRoute.useRouteContext();
    return (
      <BusinessPage
        Page={() => (
          <RunsPage
            canRerun={hasPermission(session, "review:rerun")}
            canCreate={hasPermission(session, "review:create")}
            canWrite={hasPermission(session, "repo:write")}
            canWriteRules={hasPermission(session, "knowledge:write")}
            canReadModels={hasPermission(session, "model:read")}
            // 一个仓库都没分到的普通用户看到的是一段说明,不是一份空列表(issue #194)。
            unassigned={session.repoIds !== null && session.repoIds.length === 0}
          />
        )}
      />
    );
  },
});

/** `permission` 省略即登录就进得去,与导航项同一档判据。 */
function protectedPage(
  path: "/products" | "/stats" | "/credentials" | "/settings",
  permission: PagePermission | undefined,
  component: () => React.JSX.Element,
) {
  return createRoute({
    getParentRoute: () => shellRoute,
    path,
    beforeLoad: ({ context }) => {
      if (context.session.mustChangePassword) throw redirect({ to: "/password" });
      if (permission !== undefined && !hasPagePermission(context.session, permission)) {
        throw redirect({ to: "/" });
      }
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

/**
 * 一个审查阶段的详情页(issue #175)。地址里的阶段标识就是 `GET /stages` 行上的那一个
 * (`pr:<owner>/<repo>/<number>` 与 `range:<id>`),里面的斜杠由路由编码成一段。
 */
const stageDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/stages/$stageId",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
  },
  component: () => <BusinessPage Page={StageDetailRoutePage} />,
});
/**
 * 模块级组件,不在路由 `component` 里内联:内联的箭头函数每次渲染都是一个新类型,地址上
 * 的查询参数一变(开关侧滑、切 tab)整棵 `StageDetailPage` 就被卸了重挂,筛选值与焦点
 * 全丢(issue #236 的手测才暴露出来)。与 `ModelServicesRoutePage` 同一写法。
 */
function StageDetailRoutePage() {
  const { session } = shellRoute.useRouteContext();
  return (
    <StageDetailPage
      stageId={stageDetailRoute.useParams().stageId}
      canDispose={hasPermission(session, "finding:dispose")}
      canDisposeBatch={hasPermission(session, "finding:dispose-batch")}
      canComplete={hasPermission(session, "review:complete")}
      canAdvance={hasPermission(session, "review:advance")}
      canRerun={hasPermission(session, "review:rerun")}
    />
  );
}
const productsRoute = protectedPage("/products", undefined, () => <ProductsRoutePage />);
/**
 * 当前产品写在地址上(产品页与会话页共用左栏的那一轮)。`/products` 不带产品,当前项落在列表第一个上;点左栏
 * 一行就进这一条路由,从会话页回来选的因此还是同一个产品。
 */
const productRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/products/$productId",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
  },
  component: () => <BusinessPage Page={ProductRoutePage} />,
});
/** 模块级组件,不在路由 `component` 里内联,与 `StageDetailRoutePage` 同一理由。 */
function ProductRoutePage() {
  return <ProductsRoutePage productId={Number(productRoute.useParams().productId)} />;
}
function ProductsRoutePage({ productId }: { productId?: number }) {
  const { session } = shellRoute.useRouteContext();
  return (
    <ProductsPage
      {...(productId === undefined ? {} : { productId })}
      canWrite={hasPermission(session, "repo:write")}
      canChat={hasPermission(session, "agent:chat")}
      canWriteKnowledge={hasPermission(session, "knowledge:write")}
    />
  );
}
/**
 * 一个 Agent 会话的详情页(issue #332)。地址带产品与会话两段 id:左栏要列这个产品下的
 * 会话,而会话本身只凭自己的 id 读。读不需要权限格,会话的可见性由服务端按创建者判。
 */
const agentSessionRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/products/$productId/sessions/$sessionId",
  beforeLoad: ({ context }) => {
    if (context.session.mustChangePassword) throw redirect({ to: "/password" });
  },
  component: () => <BusinessPage Page={AgentSessionRoutePage} />,
});
/** 模块级组件,不在路由 `component` 里内联,与 `StageDetailRoutePage` 同一理由。 */
function AgentSessionRoutePage() {
  const { session } = shellRoute.useRouteContext();
  const params = agentSessionRoute.useParams();
  return (
    <AgentSessionPage
      productId={Number(params.productId)}
      sessionId={Number(params.sessionId)}
      username={session.username}
      canWrite={hasPermission(session, "repo:write")}
      canChat={hasPermission(session, "agent:chat")}
    />
  );
}
const statsRoute = protectedPage("/stats", undefined, () => <StatsPage />);
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

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    indexRoute,
    stageDetailRoute,
    productsRoute,
    productRoute,
    agentSessionRoute,
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

const router = createRouter({ routeTree });

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
      <>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
        <div id="panel-portal" />
      </>
    </PanelTheme>
  </StrictMode>,
);
