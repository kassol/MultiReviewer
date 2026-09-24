import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  Cross2Icon,
  CrossCircledIcon,
  DotsHorizontalIcon,
  MagnifyingGlassIcon,
  Pencil1Icon,
  TrashIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  Skeleton,
  Tabs,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { FeedbackCallout, type Feedback } from "@/components/feedback-callout";
import { HelpTooltip } from "@/components/help-tooltip";
import { PageBody } from "@/components/page-body";
import {
  pickedBaselines,
  RepoBaselineRows,
  useBaselinePicks,
  type SessionBaseline,
} from "@/components/repo-baseline-rows";
import { Statement } from "@/components/statement";
import { TAB_TRIGGER } from "@/components/tab-trigger";
import { Button } from "@/components/theme-button";
import type { AgentSession } from "@/lib/agent-sessions";
import {
  currentProduct,
  filterKnowledge,
  groupedTerms,
  openTicketIds,
  pickableTickets,
  PRODUCTS_QUERY_KEY,
  productQueryKey,
  type Product,
  type ProductKnowledge,
  type ProductRepo,
} from "@/lib/products";
import { productListQuery } from "@/lib/product-queries";
import { localMinute } from "@/lib/time";

import { send } from "./api.ts";
import { NameDialog, ProductRail, useEnterSession, useProductDetail, useProductSessions } from "./product-rail.tsx";
import { TrackerSection, type TrackerView } from "./product-tracker.tsx";

/** 主区停在哪一页。缺省是产品知识——读它的人比动 tracker 的人多。 */
type ProductTab = "knowledge" | "tracker";

/**
 * 产品页(CONTEXT.md 产品,issue #331)。左栏是产品页与会话页共用的那一份(`ProductRail`:
 * 产品列表、当前产品的仓库、会话),右栏是当前产品的概览,与分两页的产品知识、产品
 * tracker(issue #361)。当前产品写在地址上(`/products/$productId`),从会话页回来选的还是
 * 同一个产品。
 *
 * 可见的产品由服务端按仓库分配给出(ADR 0018),前端不自己判:一个仓库都没分到的人
 * 拿到的是空列表,落在「还没有产品」那一档空态上。
 */
export function ProductsPage({
  productId,
  canWrite,
  canChat,
  canWriteKnowledge,
}: {
  /** 地址上的产品。`/products` 不带它,当前项落在列表第一个上。 */
  productId?: number | undefined;
  canWrite: boolean;
  canChat: boolean;
  canWriteKnowledge: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [dialog, setDialog] = useState<"rename" | "survey" | null>(null);
  const [confirming, setConfirming] = useState(false);
  /*
   * 主区停在哪一页、打开的是哪一条 spec,都记在地址上(`?tab=` 与 `?spec=`),与阶段详情
   * 那两个参数同一写法:会话页右栏那几行链过来时带的就是 `?spec=`,刷新与分享链接打开的
   * 也是同一条。开关与切 tab 都走 replace——它们是这一页里的一次下钻与一次翻页,不该往
   * 浏览器历史里塞一条。
   */
  const location = useRouterState({
    select: (state) => {
      const search = state.location.search as Record<string, unknown>;
      const raw = search.spec;
      const id = typeof raw === "number" ? raw : Number(raw);
      const spec = Number.isSafeInteger(id) && id > 0 ? id : null;
      // 带着 `?spec=` 进来的那一次不必另写 `tab=tracker`:那条 spec 就在 tracker 里。
      const tab: ProductTab = spec !== null || search.tab === "tracker" ? "tracker" : "knowledge";
      const view: TrackerView = search.view === "board" ? "board" : "list";
      return { spec, tab, view };
    },
  });
  // 地址带不带产品那一段要原样留着:`/products` 与 `/products/$productId` 是两条路由。
  const replaceSearch = (
    search: (prev: Record<string, unknown>) => Record<string, unknown>,
  ): void => {
    void navigate(
      productId === undefined
        ? { to: "/products", search, replace: true }
        : {
            to: "/products/$productId",
            params: { productId: String(productId) },
            search,
            replace: true,
          },
    );
  };
  const openSpec = (specId: number | null): void => {
    replaceSearch((prev) => ({
      ...prev,
      spec: specId ?? undefined,
      // 裸 `?spec=` 深链接进来时 tab 只由那条 spec 兜底判出;清掉它之前把 tracker 写实,
      // 否则关掉弹窗主区就翻回产品知识。
      tab: prev.tab ?? "tracker",
    }));
  };
  // 缺省的列表视图不写进地址。
  const selectView = (next: TrackerView): void =>
    replaceSearch((prev) => ({ ...prev, view: next === "list" ? undefined : next }));
  // 缺省的产品知识页不写进地址。
  const selectTab = (next: ProductTab): void =>
    replaceSearch((prev) => ({ ...prev, tab: next === "knowledge" ? undefined : next }));

  const productsQuery = useQuery(productListQuery());

  const products = productsQuery.data ?? [];
  const selected = currentProduct(products, productId);
  const loadError = productsQuery.error;
  // 当前产品下「会话」。会话只属于创建者,可见多少由服务端按创建者给出。
  const sessionsQuery = useProductSessions(selected?.id);
  const sessions = sessionsQuery.data ?? [];

  // 当前产品的产品知识(CONTEXT.md 产品知识,issue #343、#360)。产品列表那一份不带它,
  // 因此另读一次产品详情;读不需要权限格,谁看得到产品就看得到这一段。
  const knowledgeQuery = useProductDetail(selected?.id);
  const knowledge = knowledgeQuery.data?.knowledge ?? [];

  const overviewFacts = ((): string[] => {
    if (selected === undefined) return [];
    const tickets = (knowledgeQuery.data?.tracker.specs ?? []).flatMap((spec) => spec.tickets);
    const open = tickets.filter((ticket) => ticket.state === "open").length;
    const pickable = pickableTickets(knowledgeQuery.data?.tracker.specs ?? []).size;
    const lastSurvey = sessions
      .filter((row) => row.purpose === "product-survey" && row.completedAt !== null)
      .map((row) => row.completedAt!)
      .sort()
      .at(-1);
    return [
      `${selected.repos.length} 个仓库`,
      ...(knowledgeQuery.data === undefined
        ? []
        : [
            `${knowledge.length} 条产品知识`,
            open === 0 ? "没有开着的票" : `${open} 张票开着，${pickable} 张可开工`,
          ]),
      ...(lastSurvey === undefined ? [] : [`上一场梳理 ${localMinute(lastSurvey)} 谈完`]),
      `建于 ${localMinute(selected.createdAt)}`,
    ];
  })();

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
  const refreshKnowledge = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: productQueryKey(selected?.id) });

  /** 改名的成功收尾:关弹窗、报一句、重读列表。 */
  const settled = (text: string): void => {
    setDialog(null);
    setFeedback({ text, error: false });
    void refresh();
  };
  const failed = (error: Error): void => setFeedback({ text: error.message, error: true });

  const rename = useMutation({
    mutationFn: (input: { product: Product; name: string }) =>
      send(`/products/${input.product.id}`, "PUT", { name: input.name }),
    onSuccess: (_value, { name }) => settled(`已改名为 ${name}。`),
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (product: Product) =>
      send<{ cascade: { sessions: number } }>(`/products/${product.id}`, "DELETE"),
    onSuccess: (result, product) => {
      setConfirming(false);
      setFeedback({
        text:
          result.cascade.sessions === 0
            ? `已删产品 ${product.name}。`
            : `已删产品 ${product.name}，连同 ${result.cascade.sessions} 个 Agent 会话。`,
        error: false,
      });
      void refresh();
      // 地址上那个产品已经没了,回不带产品的产品页:当前项落到列表第一个上。
      void navigate({ to: "/products" });
    },
    onError: failed,
  });

  /**
   * 梳理(CONTEXT.md 产品梳理,issue #365):开一场产品梳理会话,并跳进去——这一场是一次
   * 访谈,agent 读完仓库就会抛第一轮题给开它的人,留在产品页上没人答它。
   *
   * `baselines` 是人在梳理弹窗里动过的那几行(issue #353);一行都没动就不带它,每个仓库
   * 读生效默认分支此刻的最新提交。
   */
  const enterSession = useEnterSession();
  const survey = useMutation({
    mutationFn: (input: { product: Product; baselines: SessionBaseline[] }) =>
      send<{ session: AgentSession }>(
        `/products/${input.product.id}/survey`,
        "POST",
        input.baselines.length === 0 ? undefined : { baselines: input.baselines },
      ),
    onSuccess: ({ session }) => {
      setDialog(null);
      void refreshKnowledge();
      return enterSession(session);
    },
    // 回绝那一句在页顶的 Callout 里,弹窗开着就挡住它:先关弹窗再报(issue #353 的选错 sha
    // 是这一条唯一能触发的新回绝)。
    onError: (error: Error) => {
      setDialog(null);
      failed(error);
    },
  });

  const busy = rename.isPending || remove.isPending || survey.isPending;

  function openDialog(next: "rename" | "survey"): void {
    setFeedback(null);
    rename.reset();
    setDialog(next);
  }

  const specs = knowledgeQuery.data?.tracker.specs ?? [];
  const openTicketCount = openTicketIds(specs).size;

  /*
   * 右栏:概览那一行,与分两页的产品知识、产品 tracker。概览留在 tab 之外——产品名与
   * 「…」菜单在哪一页都要够得着;tracker 是个操作面,与知识并排之后不必先滚过几千像素的
   * 术语表才点得到一张票。
   */
  const rightColumn =
    selected === undefined ? null : (
      <>
        {/* 名字与事实在左、产品操作在右:`lg` 以下名字让位给页顶那一行,「…」仍贴在事实那一行
            右端,不在左边单独悬一行。 */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {/* `lg` 以下这一份让位给页顶那一行:主区排在左栏三张卡之后,名字摆在这里要滚过
                三张卡才读得到。 */}
            <h2 className="min-w-0 break-all text-2xl font-bold tracking-[-0.015em] max-lg:hidden">
              {selected.name}
            </h2>
            {/* 这个产品此刻的几件事实,一行读完:知识写了多少、tracker 上还开着几张票、其中几张
                现在就能接、上一场梳理什么时候谈完。数都来自已经读到的那两份(产品详情与会话列表),
                还没读到的那一截先不画。分隔点挂在每一项前面、整排左移一个点的宽度再裁掉:折行后
                落在行首的那个点被裁在外面,窄屏上不会有一行以「·」起头。 */}
            <p className="overflow-hidden text-base text-text-muted">
              <span className="-ml-5 flex flex-wrap">
                {overviewFacts.map((fact) => (
                  <span key={fact} className="whitespace-nowrap">
                    <span aria-hidden className="inline-block w-5 text-center text-text-faint">
                      ·
                    </span>
                    {fact}
                  </span>
                ))}
              </span>
            </p>
          </div>
          {canWrite ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton
                  type="button"
                  variant="ghost"
                  color="gray"
                  size={{ initial: "3", sm: "2" }}
                  disabled={busy}
                  aria-label="产品操作"
                >
                  <DotsHorizontalIcon aria-hidden />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item onSelect={() => openDialog("rename")}>
                  <Pencil1Icon aria-hidden />
                  改名
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  color="red"
                  onSelect={() => {
                    setFeedback(null);
                    setConfirming(true);
                  }}
                >
                  <TrashIcon aria-hidden />
                  删除
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          ) : null}
        </div>

        <Tabs.Root value={location.tab} onValueChange={(next) => selectTab(next as ProductTab)}>
          {/* 与阶段详情、知识集弹窗同一套 tab 语法:3px 圆头指示条,底线通栏。 */}
          <Tabs.List size="2" className="shadow-[inset_0_-1px_0_0_var(--v8-border-chrome)]">
            <Tabs.Trigger value="knowledge" className={TAB_TRIGGER}>
              产品知识
              {knowledge.length === 0 ? null : (
                <Badge
                  color={location.tab === "knowledge" ? "blue" : "gray"}
                  variant="soft"
                  radius="full"
                  size="1"
                  className="ml-1.5 tabular-nums"
                >
                  {knowledge.length}
                </Badge>
              )}
            </Tabs.Trigger>
            <Tabs.Trigger value="tracker" className={TAB_TRIGGER}>
              产品 tracker
              {/* 数的是开着的票,与 GitHub 的 Issues 计数同一口径:它说的是还剩多少活。 */}
              {openTicketCount === 0 ? null : (
                <Badge
                  color={location.tab === "tracker" ? "blue" : "gray"}
                  variant="soft"
                  radius="full"
                  size="1"
                  className="ml-1.5 tabular-nums"
                >
                  {openTicketCount}
                </Badge>
              )}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="knowledge" className="pt-3">
            <KnowledgeSection
              key={`knowledge-${selected.id}`}
              product={selected}
              knowledge={knowledge}
              pending={knowledgeQuery.isPending}
              canWrite={canWriteKnowledge}
              busy={busy}
              onSurvey={() => openDialog("survey")}
            />
          </Tabs.Content>
          <Tabs.Content value="tracker" className="pt-3">
            <TrackerSection
              key={`tracker-${selected.id}`}
              product={selected}
              specs={specs}
              pending={knowledgeQuery.isPending}
              canChat={canChat}
              openSpecId={location.spec}
              onOpenSpec={openSpec}
              view={location.view}
              onView={selectView}
            />
          </Tabs.Content>
        </Tabs.Root>
      </>
    );

  return (
    <PageBody className="lg:pb-4">
      <h1 className="sr-only">产品</h1>
      {/*
        当前产品名。`lg` 起顶栏面包屑与概览卡都说着它,这一行只在 `lg` 以下画:那一档面包屑
        收起、主区又排在左栏三张卡之后,人在 390px 上看不出自己正在哪个产品里。
      */}
      {selected === undefined ? null : (
        <h2 className="min-w-0 break-all text-2xl font-bold tracking-[-0.015em] lg:hidden">
          {selected.name}
        </h2>
      )}
      <FeedbackCallout feedback={feedback} />
      {loadError === null ? null : (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon>
            <CrossCircledIcon aria-hidden />
          </Callout.Icon>
          <Callout.Text>{(loadError as Error).message}</Callout.Text>
        </Callout.Root>
      )}

      {/*
        左栏与会话页是同一个组件、同一个位置(spec #349)。产品页整页在 `#panel-main-scroll`
        里滚,左栏因此 sticky 在顶栏之下自己滚:跳到会话页时它停在同一处,不跟着主区走。
        `lg` 以下左栏让出自己的盒子,它那三张卡与这一列主区同为这个 flex 容器的直接子项,靠
        `max-lg:order-*` 排成 产品列表 → 会话 → 仓库 → 概览 + 产品知识(issue #383)。
        左栏最大高度 = 视口 − 顶栏 − `PageBody` 的顶部留白 `pt-6`(24px)− 底部留白:左栏还没
        吸顶时从顶栏下 24px 起,这样它的底边落在视口底边之上 16px,与会话页左栏的底边同一处,
        两页来回跳时左栏不再一长一短;吸顶之后底边再高出 24px,滚到最底也不会被这一行的底边
        顶进顶栏底下(issue #444)。这一页在 `lg` 起把底部留白收到 `pb-4`(16px),改留白要连
        这里的 40px 一起改。
      */}
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:gap-[18px]">
        <ProductRail
          {...(productId === undefined ? {} : { productId })}
          canWrite={canWrite}
          canChat={canChat}
          busy={busy}
          onFeedback={setFeedback}
          className="lg:sticky lg:top-[var(--v8-top-chrome)] lg:max-h-[calc(100vh_-_var(--v8-top-chrome)_-_40px)] lg:self-start lg:overflow-y-auto lg:overscroll-y-contain"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3 max-lg:order-4">
          {productsQuery.isPending ? (
            <div className="flex flex-col gap-3" role="status" aria-label="正在读取产品" aria-busy="true">
              <Skeleton aria-hidden className="h-28" />
              <Skeleton aria-hidden className="h-56" />
            </div>
          ) : products.length === 0 ? (
            <CardShell className="px-5 py-4">
              <EmptyState
                title="还没有产品"
                titleAs="h2"
                description={
                  canWrite
                    ? "把已注册的仓库归到一个产品下，Agent 会话就挂在它上面。左栏的「建产品」开第一个。"
                    : "产品的可见范围由仓库分配决定。请联系系统管理员为该账号分配负责的仓库。"
                }
              />
            </CardShell>
          ) : (
            rightColumn
          )}
        </div>
      </div>

      {selected === undefined ? null : (
        <>
          <NameDialog
            open={dialog === "rename"}
            title="改名"
            description="改名只改这个产品的名字，它的仓库一个不动。"
            label="产品名"
            submitLabel="保存"
            initial={selected.name}
            busy={rename.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(name) => {
              setFeedback(null);
              rename.mutate({ product: selected, name });
            }}
          />
          <SurveyDialog
            open={dialog === "survey"}
            productName={selected.name}
            repos={selected.repos}
            busy={survey.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(baselines) => {
              setFeedback(null);
              survey.mutate({ product: selected, baselines });
            }}
          />
          <ConfirmDialog
            open={confirming}
            onOpenChange={(open) => {
              if (!open) setConfirming(false);
            }}
            title={`删除产品 ${selected.name}?`}
            titleSize="4"
            // 条数取当前产品下这一份会话列表(系统管理员读到的是所有人的),真正删掉
            // 多少由接口回的 `cascade.sessions` 说,成功那句照它写。
            description={`产品下的 ${sessions.length} 个 Agent 会话连记录与图片一并删除，不可撤销。仓库只是从产品里摘出，注册表不动。`}
            cancelLabel="取消"
            cancelVariant="outline"
            cancelDisabled={remove.isPending}
            confirm={{
              label: remove.isPending ? "删除中…" : "删除",
              color: "red",
              disabled: remove.isPending,
              onClick: () => {
                setFeedback(null);
                remove.mutate(selected);
              },
            }}
          />
        </>
      )}
    </PageBody>
  );
}

/**
 * 梳理弹窗(CONTEXT.md 产品梳理,issue #353)。一个仓库一行的基点行组与建会话弹窗共用一份,
 * 预选每个仓库生效默认分支此刻的最新提交:一行都不动就按确认;要谈发布线或某条特性分支时
 * 只改那几行。
 *
 * 列的是产品的全部仓库——梳理读的正是这一份。
 */
function SurveyDialog({
  open,
  productName,
  repos,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  productName: string;
  repos: readonly ProductRepo[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (baselines: SessionBaseline[]) => void;
}) {
  const baseline = useBaselinePicks(open);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(pickedBaselines(baseline.picked));
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content maxWidth="520px" size={{ initial: "2", sm: "3" }}>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          <div>
            <Dialog.Title size="4" mb="2">
              梳理
            </Dialog.Title>
            <Dialog.Description size="2" color="gray">
              让 agent 读一遍「{productName}」的全部仓库，再按轮问你，把谈定的写进产品知识。
            </Dialog.Description>
          </div>
          <RepoBaselineRows repos={repos} {...baseline} />
          <Flex gap="3" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <Dialog.Close>
              <Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
                取消
              </Button>
            </Dialog.Close>
            <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} disabled={busy}>
              {busy ? "开场中…" : "开始梳理"}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * 一条条目的出处附注(CONTEXT.md 产品知识,issue #360)。默认折起:附注是核对用的,一条条目
 * 平时读的是它那一句话。没有附注的那一条不渲染这一行——人写的回答本来就没有代码位置。
 */
function Annotations({ entry }: { entry: ProductKnowledge }) {
  if (entry.annotations.length === 0) return null;
  return (
    <Collapsible.Root className="group/notes">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex min-h-9 items-center gap-1 text-sm text-text-muted pointer-coarse:min-h-11 hover:text-text-secondary"
        >
          出处 <span className="tabular-nums">{entry.annotations.length}</span> 处
          <ChevronDownIcon
            aria-hidden
            className="transition-transform group-data-[state=open]/notes:rotate-180"
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="collapsible-motion">
        <ul className="flex flex-col gap-1.5 border-l border-line pb-1 pl-3">
          {entry.annotations.map((note, index) => (
            <li key={index} className="flex min-w-0 flex-col">
              <span className="break-all font-mono text-xs text-text-secondary">
                {note.location}
              </span>
              <span className="break-words text-sm text-text-muted">{note.reason}</span>
            </li>
          ))}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * 区块小标题:标题加条数,三段共用一份。段内锚点跳的就是它,顶栏是 sticky 的两行毛玻璃,
 * `block: "start"` 会把它贴到视口 y=0 钻进底下,因此让开顶栏实高 `--v8-top-chrome`——`sm` 以下
 * 顶栏只剩一行,写死 88px 会多让出一截空白(issue #442)。
 */
function SectionHeading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <h3 id={id} className="flex scroll-mt-[var(--v8-top-chrome)] items-center gap-1.5 text-lg font-semibold">
      {title}
      <span className="font-mono text-xs font-normal text-text-muted tabular-nums">{count}</span>
    </h3>
  );
}

/** 锚点这一排的段名与它要跳到的那个标题 id(下面三段各自的 `SectionHeading` 挂着它)。 */
const KNOWLEDGE_SECTIONS = [
  { id: "product-terms-title", title: "术语表" },
  { id: "product-relationships-title", title: "仓库关系" },
  { id: "product-decisions-title", title: "产品决策" },
] as const;

/**
 * 段内锚点:点了滚到那一段。不改地址——它是这一卡里的一次跳读,不是一处可以分享的位置,
 * 写进地址只会让返回键堵在几次滚动上。
 */
function SectionAnchor({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <Button
      type="button"
      variant="ghost"
      color="gray"
      size="1"
      onClick={() => document.getElementById(id)?.scrollIntoView({ block: "start" })}
    >
      {title}
      <span className="font-mono text-text-muted tabular-nums">{count}</span>
    </Button>
  );
}

/**
 * 知识条目的陈述段落:字号与 Markdown 正文同一档(15px),行宽封在 46em——术语与决策的正文
 * 常常是整段话,铺满全宽的内容轨之后读者的眼睛要横跨整屏才回到行首。徽章行与出处行不限宽,
 * 它们是扫的,不是读的。
 */
const STATEMENT_CLASS = "max-w-[46em] break-words text-lg";

/**
 * 术语表的一个主题分组(issue #360)。组名加条数是一个可折叠段头,默认展开:一个产品谈久了
 * 术语表会长到几十条,按主题收起来才找得到要看的那一组。没分组的那几条挂在「其余」下面
 * ——它们同样要看得见,不该被分组吃掉。
 */
function TermGroup({ topic, children, count }: { topic: string | null; children: ReactNode; count: number }) {
  return (
    <Collapsible.Root defaultOpen className="group/topic flex min-w-0 flex-col">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex min-h-9 items-center gap-1.5 self-start text-sm font-medium text-text-muted pointer-coarse:min-h-11 hover:text-text-secondary"
        >
          <ChevronDownIcon
            aria-hidden
            className="shrink-0 transition-transform group-data-[state=closed]/topic:-rotate-90"
          />
          {topic ?? "其余"}
          <span className="font-mono text-xs font-normal tabular-nums">{count}</span>
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="collapsible-motion">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * 产品页右栏的产品知识区(CONTEXT.md 产品知识,issue #360)。三段:按主题分组的术语表、仓库
 * 关系段、带状态的产品决策列表,每条展开看出处附注。加标题旁的「梳理」。
 *
 * 这一页只读:条目由会话在人的回答下写下即生效,人不手写、不确认也不驳回(ADR 0035)。
 * `knowledge:write` 因此只决定看不看得到「梳理」。
 */
function KnowledgeSection({
  product,
  knowledge,
  pending,
  canWrite,
  busy,
  onSurvey,
}: {
  product: Product;
  knowledge: readonly ProductKnowledge[];
  pending: boolean;
  canWrite: boolean;
  busy: boolean;
  onSurvey: () => void;
}) {
  /*
   * 筛选只留在这一卡里,不写进地址:它是读的时候临时收窄一下,换个产品就该没了(卡按产品
   * id 重挂,状态跟着回到空)。
   */
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const shown = filterKnowledge(knowledge, filter);

  const groups = groupedTerms(shown);
  const terms = groups.reduce((count, group) => count + group.terms.length, 0);
  const relationships = shown.filter((entry) => entry.kind === "relationship");
  const decisions = shown.filter((entry) => entry.kind === "decision");
  const counts = [terms, relationships.length, decisions.length];
  // 为 0 的那段不画锚点;只剩一段时整排都不画——没有第二段可跳。
  const anchors = KNOWLEDGE_SECTIONS.map((section, index) => ({
    ...section,
    count: counts[index] ?? 0,
  })).filter((section) => section.count > 0);
  // 五条以内扫一眼就完了,不必先读一个输入框。
  const filterable = knowledge.length > 5;

  // 还一条知识都没有时,空态那句话指的就是它:升成主按钮,不让人在卡头找一颗灰色小键。
  const firstSurvey = !pending && knowledge.length === 0;
  const surveyButton = (
    <Button
      variant={firstSurvey ? "solid" : "soft"}
      {...(firstSurvey ? {} : { color: "gray" as const })}
      size="1"
      className="shrink-0"
      disabled={busy || product.repos.length < 2}
      onClick={onSurvey}
    >
      梳理
    </Button>
  );

  /** 一段之间的分隔:第一段不带上边框,后面每段带。 */
  const sectionClass = (first: boolean): string =>
    first
      ? "flex min-w-0 flex-col gap-1.5"
      : "flex min-w-0 flex-col gap-1.5 border-t border-line pt-3";
  // 条目按定义列表排:`lg` 起名字一列、正文一列,三段的正文因此落在同一条左缘上——正文限了
  // 行宽,名字挪到左边那一列正好把卡的宽度用掉,一行一条,展开出处也只推自己下面的。
  const rowClass =
    "flex min-w-0 flex-col gap-1 border-t border-line py-3 first:border-t-0 first:pt-0 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-x-8";
  const nameClass = "min-w-0 break-words text-lg font-semibold";
  // 行宽封在正文那一格上(46em × 15px):小字的「不说 / 备选 / 后果」与出处按自己的 em 算会比正文窄一截。
  const bodyClass = "flex min-w-0 max-w-[690px] flex-col gap-1";

  return (
    <CardShell className="min-w-0 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1">
            {/* tab 已经写着「产品知识」,卡头不再把同一个名字用大字再说一遍;标题留给读屏,
                看得见的这一句说这一页装的是什么。 */}
            <h2 className="sr-only">产品知识</h2>
            <span className="text-md text-text-secondary">术语表、仓库关系与产品决策</span>
            <HelpTooltip
              label="产品知识说明"
              content="产品知识是这个产品的术语表、仓库关系段与产品决策记录：这个产品是什么、它的仓库之间怎么协作、为什么这样定。条目由 Agent 会话在你的回答下写成，写下即生效。"
            />
          </div>
          {canWrite ? (
            <Tooltip
              content={
                product.repos.length < 2
                  ? "产品梳理要这个产品至少有两个仓库"
                  : "开一场产品梳理：agent 读一遍全部仓库，再按轮问你"
              }
            >
              {/* disabled 按钮不冒泡指针事件,套一层 span 让提示仍能弹出。 */}
              <span className="inline-flex shrink-0" tabIndex={product.repos.length < 2 ? 0 : -1}>
                {surveyButton}
              </span>
            </Tooltip>
          ) : null}
        </div>

        {pending ? (
          <Skeleton aria-hidden className="h-16" />
        ) : knowledge.length === 0 ? (
          <EmptyState
            title="还没有产品知识。"
            {...(canWrite && product.repos.length >= 2
              ? { description: "点「梳理」跟 agent 谈一遍，或在一个 Agent 会话里聊出来。" }
              : {})}
          />
        ) : (
          <>
            {/* 筛选框在左、段内锚点在右;窄屏上输入框独占一行,锚点折到下一行。 */}
            {!filterable && anchors.length < 2 ? null : (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                {filterable ? (
                  <TextField.Root
                    ref={input}
                    size={{ initial: "3", sm: "2" }}
                    className="min-w-[12rem] grow basis-full sm:max-w-[20rem] sm:basis-0"
                    aria-label="筛选产品知识"
                    placeholder="筛选术语、关系与决策"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <TextField.Slot side="left">
                      <MagnifyingGlassIcon aria-hidden />
                    </TextField.Slot>
                    {filter === "" ? null : (
                      <TextField.Slot side="right">
                        <IconButton
                          type="button"
                          size="1"
                          variant="ghost"
                          color="gray"
                          aria-label="清空筛选"
                          // 清完焦点回输入框:人是要重打一个词,不是要离开这一格。
                          onClick={() => {
                            setFilter("");
                            input.current?.focus();
                          }}
                        >
                          <Cross2Icon aria-hidden />
                        </IconButton>
                      </TextField.Slot>
                    )}
                  </TextField.Root>
                ) : null}
                {anchors.length < 2 ? null : (
                  // 有筛选框时靠右,单独一排时跟着标题靠左。
                  <div
                    className={
                      filterable
                        ? "flex flex-wrap items-center gap-5 px-1 sm:ml-auto"
                        : "flex flex-wrap items-center gap-5 px-1"
                    }
                  >
                    {anchors.map((section) => (
                      <SectionAnchor key={section.id} {...section} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {shown.length === 0 ? (
              <EmptyState title="没有匹配的条目。" description="换个词，或清空筛选。" />
            ) : null}

            {terms === 0 ? null : (
              <section aria-labelledby="product-terms-title" className={sectionClass(true)}>
                <SectionHeading id="product-terms-title" title="术语表" count={terms} />
                {/* 组与组之间比组内两条之间松一档:一眼看得出这几条说的是同一个主题。 */}
                <div className="flex min-w-0 flex-col gap-3">
                  {groups.map((group) => (
                    <TermGroup
                      key={group.topic ?? ""}
                      topic={group.topic}
                      count={group.terms.length}
                    >
                      <ul>
                        {group.terms.map((entry) => (
                          <li key={entry.id} className={rowClass}>
                            <span className={nameClass}>{entry.name}</span>
                            <div className={bodyClass}>
                              <span className={STATEMENT_CLASS}>
                                <Statement text={entry.body} />
                              </span>
                              {entry.avoided.length === 0 ? null : (
                                <span className="break-words text-sm text-text-muted">
                                  <span className="font-medium text-text-secondary">不说</span>　{entry.avoided.join("、")}
                                </span>
                              )}
                              <Annotations entry={entry} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </TermGroup>
                  ))}
                </div>
              </section>
            )}

            {relationships.length === 0 ? null : (
              <section
                aria-labelledby="product-relationships-title"
                className={sectionClass(terms === 0)}
              >
                <SectionHeading
                  id="product-relationships-title"
                  title="仓库关系"
                  count={relationships.length}
                />
                <ul>
                  {relationships.map((entry) => (
                    <li key={entry.id} className={rowClass}>
                      {/* 仓库关系没有名字:正文仍落在第二列,与术语、决策的正文同一条左缘。 */}
                      <div className={`${bodyClass} lg:col-start-2`}>
                        <span className={STATEMENT_CLASS}>
                          <Statement text={entry.body} />
                        </span>
                        <Annotations entry={entry} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {decisions.length === 0 ? null : (
              <section
                aria-labelledby="product-decisions-title"
                className={sectionClass(terms === 0 && relationships.length === 0)}
              >
                <SectionHeading
                  id="product-decisions-title"
                  title="产品决策"
                  count={decisions.length}
                />
                <ul>
                  {decisions.map((entry) => (
                    <li key={entry.id} className={rowClass}>
                      <div className="flex min-w-0 flex-col items-start gap-1.5">
                        <span className={nameClass}>{entry.name}</span>
                        {entry.supersededBy === null ? (
                          <Badge color="green" variant="soft" size="1">
                            生效
                          </Badge>
                        ) : (
                          <Badge color="amber" variant="soft" size="1">
                            被条目 {entry.supersededBy} 取代
                          </Badge>
                        )}
                      </div>
                      {/* 被取代的那一条正文退一档颜色:一列决策里哪几条还算数,扫一眼就看得出。 */}
                      <div
                        className={`${bodyClass} ${entry.supersededBy === null ? "" : "text-text-secondary"}`}
                      >
                        <span className={STATEMENT_CLASS}>
                          <Statement text={entry.body} />
                        </span>
                        {entry.options === null ? null : (
                          <span className="break-words text-sm text-text-muted">
                            <span className="font-medium text-text-secondary">备选</span>　<Statement text={entry.options} />
                          </span>
                        )}
                        {entry.consequences === null ? null : (
                          <span className="break-words text-sm text-text-muted">
                            <span className="font-medium text-text-secondary">后果</span>　<Statement text={entry.consequences} />
                          </span>
                        )}
                        <Annotations entry={entry} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </CardShell>
  );
}
