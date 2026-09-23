import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Cross2Icon,
  CrossCircledIcon,
  DotsHorizontalIcon,
  MagnifyingGlassIcon,
  Pencil1Icon,
  RadiobuttonIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  Text,
  TextArea,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { Markdown } from "@/components/markdown";
import { PageBody } from "@/components/page-body";
import {
  baselineRepoKey,
  pickedBaselines,
  RepoBaselineRows,
  type SessionBaseline,
} from "@/components/repo-baseline-rows";
import { Statement } from "@/components/statement";
import { TAB_TRIGGER } from "@/components/tab-trigger";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus } from "@/components/use-dialog-return-focus";
import type { CommitSelection } from "@/commit-picker";
import { sessionsQueryKey, type AgentSession } from "@/lib/agent-sessions";
import {
  currentProduct,
  filterKnowledge,
  groupedTerms,
  isTrackerFiltering,
  matchesTrackerFilter,
  NO_TRACKER_FILTER,
  openTicketIds,
  pickableTickets,
  PRODUCTS_QUERY_KEY,
  productQueryKey,
  specQueryKey,
  ticketNotes,
  ticketStatuses,
  TICKET_STATUSES,
  trackerCloseConfirm,
  trackerListGroups,
  type Product,
  type ProductKnowledge,
  type ProductRepo,
  type SpecDetail,
  type TicketLabel,
  type TicketStatus,
  type TrackerCloseTarget,
  type TrackerFilter,
  type TrackerTicket,
  type TrackerSpec,
  type TrackerState,
} from "@/lib/products";
import { localMinute } from "@/lib/time";
import { cn } from "@/lib/utils";

import { apiUrl, fetchJson, send } from "./api.ts";
import { NameDialog, ProductRail, useProductDetail, useProductSessions } from "./product-rail.tsx";

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
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
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

  const productsQuery = useQuery({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: async () => (await fetchJson<{ products: Product[] }>("/products")).products,
  });

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
  const survey = useMutation({
    mutationFn: (input: { product: Product; baselines: SessionBaseline[] }) =>
      send<{ session: AgentSession }>(
        `/products/${input.product.id}/survey`,
        "POST",
        input.baselines.length === 0 ? undefined : { baselines: input.baselines },
      ),
    onSuccess: async ({ session }) => {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(session.productId) });
      void refreshKnowledge();
      void navigate({
        to: "/products/$productId/sessions/$sessionId",
        params: { productId: String(session.productId), sessionId: String(session.id) },
      });
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
      {feedback === null ? null : (
        <Callout.Root
          role={feedback.error ? "alert" : "status"}
          color={feedback.error ? "red" : "green"}
          size="1"
        >
          <Callout.Icon>
            {feedback.error ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
          </Callout.Icon>
          <Callout.Text>{feedback.text}</Callout.Text>
        </Callout.Root>
      )}
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
  const [picked, setPicked] = useState<Record<string, CommitSelection>>({});
  useEffect(() => {
    if (open) setPicked({});
  }, [open]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(pickedBaselines(picked));
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
              让 agent 读一遍 {productName} 的全部仓库，再按轮问你，把谈定的写进产品知识。
            </Dialog.Description>
          </div>
          <div className="flex flex-col gap-1.5">
            <Text as="span" size="2" weight="medium">
              每个仓库读哪个提交
            </Text>
            <Text as="span" size="1" color="gray">
              不动即读这个仓库生效默认分支此刻的 head。
            </Text>
            <RepoBaselineRows
              repos={repos}
              picked={picked}
              onPick={(repo, selection) =>
                setPicked((current) => ({ ...current, [baselineRepoKey(repo)]: selection }))}
            />
          </div>
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

/** 五个 triage 标签各自的颜色。同一个标签在哪都是同一色,人扫一眼就认得出这是哪一类活。 */
const LABEL_COLOR: Record<TicketLabel, "gray" | "amber" | "green" | "blue" | "red"> = {
  "needs-triage": "gray",
  "needs-info": "amber",
  "ready-for-agent": "green",
  "ready-for-human": "blue",
  wontfix: "red",
};

/** 改标签菜单里的五项。取值就是上面那张表的键,两处不会各写一份。 */
const TICKET_LABELS = Object.keys(LABEL_COLOR) as TicketLabel[];

/**
 * 可开工的那一枚标记(CONTEXT.md 票,issue #363)。不另起一枚 Badge:标签那一格已经占着
 * 颜色,再来一枚绿的会与 `ready-for-agent` 撞脸。一行主色小字说完即可。
 */
function PickableMark() {
  return <span className="shrink-0 text-sm font-medium text-primary">可开工</span>;
}

/** 看板四列各自的状态图标颜色。开着的三档共用一个圆点图形、按颜色分,已关换成对勾。 */
const STATUS_ICON_CLASS: Record<TicketStatus, string> = {
  ready: "text-success-icon",
  blocked: "text-warning-icon",
  claimed: "text-primary",
  closed: "text-text-muted",
};

const STATUS_TITLE = Object.fromEntries(
  TICKET_STATUSES.map(({ status, title }) => [status, title]),
) as Record<TicketStatus, string>;

/** 一张票的状态图标(列表行首、看板列头、弹窗里的票行共用)。读屏读到的是列名。 */
function TicketStatusIcon({ status, className }: { status: TicketStatus; className?: string | undefined }) {
  const Icon = status === "closed" ? CheckCircledIcon : RadiobuttonIcon;
  return (
    <Icon
      role="img"
      aria-label={STATUS_TITLE[status]}
      className={cn("size-4 shrink-0", STATUS_ICON_CLASS[status], className)}
    />
  );
}

/**
 * 一处阻塞边的另一头(issue #363 的阻塞边):票号可点,点了打开它所在的 spec 并展开那一张——
 * 挡着它的票常挂在另一条 spec 下,只写个号人还得自己去翻。
 */
function BlockerLink({
  id,
  closed = false,
  onJump,
}: {
  id: number;
  /** 已关的那一头划掉、退成次要色:它不再挡着谁,但边还在,人要知道当初等过它。 */
  closed?: boolean;
  onJump: (ticketId: number) => void;
}) {
  return (
    <button
      type="button"
      aria-label={closed ? `#${id}（已关）` : undefined}
      className={cn(
        "rounded-sm font-mono tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        closed ? "text-text-muted line-through" : "text-primary",
      )}
      onClick={() => onJump(id)}
    >
      #{id}
    </button>
  );
}

/**
 * 票行标题下那一行小字:`#id · 已关 · 谁认领 · 等 #n · 可开工`。与 `ticketNotes` 同一套
 * 取舍(只列还开着的阻塞),只是把阻塞的票号做成可点的——看板卡片整张是一颗键,里面不能
 * 再套键,那一处仍用 `ticketNotes` 的纯文字。
 */
function TicketMeta({
  ticket,
  openTickets,
  pickable,
  onJump,
  className,
}: {
  ticket: TrackerTicket;
  openTickets: ReadonlySet<number>;
  pickable: boolean;
  onJump: (ticketId: number) => void;
  className?: string | undefined;
}) {
  const blockers = ticket.blockedBy.filter((id) => openTickets.has(id));
  return (
    <span className={cn("text-sm text-text-muted", className)}>
      <span className="font-mono tabular-nums">#{ticket.id}</span>
      {ticket.state === "closed" ? " · 已关" : null}
      {ticket.claimedBy === null ? null : ` · ${ticket.claimedBy} 认领`}
      {blockers.length === 0 ? null : (
        <>
          {" · 等 "}
          {blockers.map((id, index) => (
            <Fragment key={id}>
              {index === 0 ? null : "、"}
              <BlockerLink id={id} onJump={onJump} />
            </Fragment>
          ))}
        </>
      )}
      {pickable ? (
        <>
          {" · "}
          <span className="font-medium text-primary">可开工</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * 弹窗要展开并滚到的那一张票。`at` 是点下去的时刻:同一张票再跳一次时它变了,滚动照样再做
 * 一次——只比票号的话,人滚走之后再点同一个 #n 什么都不会发生。
 */
type TicketFocus = { ticketId: number; at: number };

/** tracker 两种视图(issue 式列表与看板)。缺省是列表,不写进地址。 */
export type TrackerView = "list" | "board";

/** 认领人筛选的 Select 取值:Radix Select 不收空串,「全部」「未认领」用前缀与用户名分开。 */
const CLAIMER_ALL = "all";
const CLAIMER_NONE = "none";
const claimerValue = (claimer: string | null | undefined): string =>
  claimer === undefined ? CLAIMER_ALL : claimer === null ? CLAIMER_NONE : `user:${claimer}`;
const claimerFromValue = (value: string): string | null | undefined =>
  value === CLAIMER_ALL ? undefined : value === CLAIMER_NONE ? null : value.slice("user:".length);

/** 看板「已关」那一列默认只画这么多张:它只会越攒越多,而人来看板找的是还开着的。 */
const CLOSED_COLUMN_LIMIT = 8;

/**
 * 产品页右栏的产品 tracker 区(CONTEXT.md 产品 tracker,issue #361、#363)。
 *
 * 两种视图,形状照 GitHub:**列表**是 issue 式的——「开着 / 已关」两个计数切换,标签与认领人
 * 筛选,一条 spec 一组、组里一张票一行;**看板**按票此刻的工作状态分四列(可开工 / 被阻塞 /
 * 已认领 / 已关),回答「现在能接哪一张」。筛选两种视图共用,视图记在地址的 `?view=` 上。
 *
 * **正文只读**:spec 与票的正文只由会话经工具写。人在这里读、导出,并做认领、改标签、开关
 * 与评论——那几个动作在 spec 全文弹窗里,一张票的上下文全在那儿;点一张票打开它所在的 spec
 * 并展开这一张。读随产品可见性,动作按 `agent:chat` 显隐。
 */
function TrackerSection({
  product,
  specs,
  pending,
  canChat,
  openSpecId,
  onOpenSpec,
  view,
  onView,
}: {
  product: Product;
  specs: readonly TrackerSpec[];
  pending: boolean;
  canChat: boolean;
  /** 地址上 `?spec=` 说的那一条(null 即弹窗关着)。会话页右栏点过来的链接带的就是它。 */
  openSpecId: number | null;
  onOpenSpec: (specId: number | null) => void;
  view: TrackerView;
  onView: (view: TrackerView) => void;
}) {
  const openSpec = specs.find((spec) => spec.id === openSpecId) ?? null;
  const [listState, setListState] = useState<TrackerState>("open");
  const [filter, setFilter] = useState<TrackerFilter>(NO_TRACKER_FILTER);
  const [showAllClosed, setShowAllClosed] = useState(false);
  /** 从一张票点进来时弹窗里展开并滚到这一张;点 spec 标题进来时为 null。 */
  const [focus, setFocus] = useState<TicketFocus | null>(null);
  /** 弹窗是受控的,没有 `Dialog.Trigger`,焦点得自己送回打开它的那颗键;关掉后列表重取、
   *  那颗键被换掉时,按票号或 spec id 找回新渲染的同一颗。带着 `?spec=` 进来的那一次没有
   *  点过任何键,同样照 spec id 找。 */
  const lastTrigger = useRef<string | null>(null);
  if (openSpecId !== null && focus === null) {
    lastTrigger.current = `[data-spec-trigger="${openSpecId}"]`;
  }
  const returnFocus = useDialogReturnFocus(useCallback(
    () => (lastTrigger.current === null ? null : document.querySelector<HTMLElement>(lastTrigger.current)),
    [],
  ));
  const statuses = ticketStatuses(specs);
  const openTickets = openTicketIds(specs);
  const pickable = pickableTickets(specs);
  const tickets = specs.flatMap((spec) => spec.tickets.map((ticket) => ({ spec, ticket })));
  const matching = tickets.filter(({ spec, ticket }) => matchesTrackerFilter(ticket, spec.title, filter));
  const filtering = isTrackerFiltering(filter);
  const specOfTicket = new Map(tickets.map(({ spec, ticket }) => [ticket.id, spec.id]));
  const claimers = [...new Set(tickets.map(({ ticket }) => ticket.claimedBy).filter((one) => one !== null))].sort();

  const openFromSpec = (event: MouseEvent<HTMLElement>, specId: number): void => {
    returnFocus.captureTrigger(event);
    lastTrigger.current = `[data-spec-trigger="${specId}"]`;
    setFocus(null);
    onOpenSpec(specId);
  };
  const openFromTicket = (event: MouseEvent<HTMLElement>, specId: number, ticketId: number): void => {
    returnFocus.captureTrigger(event);
    lastTrigger.current = `[data-ticket-trigger="${ticketId}"]`;
    setFocus({ ticketId, at: Date.now() });
    onOpenSpec(specId);
  };
  /** 跟着一处阻塞边跳到那张票:同一条 spec 里就地展开,别的 spec 就换过去。 */
  const jumpTo = (ticketId: number): void => {
    const specId = specOfTicket.get(ticketId);
    if (specId === undefined) return;
    setFocus({ ticketId, at: Date.now() });
    onOpenSpec(specId);
  };

  const toolbar = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="sr-only">产品 tracker</h2>
      {view === "list" ? (
        // 与 GitHub issue 列表同一形状:两个带数的开关,当前那一个字重压实。数跟着筛选走。
        <div role="group" aria-label="按开关筛选" className="flex items-center gap-4">
          {(["open", "closed"] as const).map((state) => {
            const count = matching.filter(({ ticket }) => ticket.state === state).length;
            const current = listState === state;
            return (
              <Button
                key={state}
                variant="ghost"
                color="gray"
                size="2"
                aria-pressed={current}
                className={cn(
                  "pointer-coarse:min-h-11",
                  current ? "font-semibold text-text" : "text-text-muted",
                )}
                onClick={() => setListState(state)}
              >
                {state === "open" ? (
                  <RadiobuttonIcon aria-hidden />
                ) : (
                  <CheckCircledIcon aria-hidden />
                )}
                <span className="font-mono tabular-nums">{count}</span>
                {state === "open" ? "开着" : "已关"}
              </Button>
            );
          })}
        </div>
      ) : (
        <span className="text-md text-text-secondary">
          <span className="font-mono tabular-nums">{matching.length}</span> 张票
        </span>
      )}
      {/* 说明挂在左边这一组的末尾:窄屏上右边那组整行折下去,挂在它后面会单独落一行。 */}
      <HelpTooltip
        label="产品 tracker 说明"
        content="需求拆分会话谈定之后把 spec 写进来，再拆成带阻塞边的票。正文只由会话写；认领、改标签、开关与评论打开一条 spec 就能做。"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto max-sm:w-full">
        <TextField.Root
          size={{ initial: "3", sm: "1" }}
          className="min-w-[10rem] max-sm:basis-full sm:w-44"
          aria-label="按标题搜索票"
          placeholder="搜索票或 spec 标题"
          value={filter.query}
          onChange={(event) => setFilter((prev) => ({ ...prev, query: event.target.value }))}
        >
          <TextField.Slot side="left">
            <MagnifyingGlassIcon aria-hidden />
          </TextField.Slot>
        </TextField.Root>
        <Select.Root
          size={{ initial: "3", sm: "1" }}
          value={filter.label ?? "all"}
          onValueChange={(value) =>
            setFilter((prev) => ({ ...prev, label: value === "all" ? null : (value as TicketLabel) }))
          }
        >
          <Select.Trigger aria-label="按标签筛选" className="max-sm:flex-1" />
          <Select.Content>
            <Select.Item value="all">全部标签</Select.Item>
            {TICKET_LABELS.map((label) => (
              <Select.Item key={label} value={label}>
                {label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Select.Root
          size={{ initial: "3", sm: "1" }}
          value={claimerValue(filter.claimer)}
          onValueChange={(value) => setFilter((prev) => ({ ...prev, claimer: claimerFromValue(value) }))}
        >
          <Select.Trigger aria-label="按认领人筛选" className="max-sm:flex-1" />
          <Select.Content>
            <Select.Item value={CLAIMER_ALL}>全部认领人</Select.Item>
            <Select.Item value={CLAIMER_NONE}>未认领</Select.Item>
            {claimers.map((name) => (
              <Select.Item key={name} value={claimerValue(name)}>
                {name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <SegmentedControl.Root
          size={{ initial: "3", sm: "1" }}
          value={view}
          onValueChange={(next) => onView(next as TrackerView)}
          aria-label="tracker 视图"
          className="max-sm:w-full"
        >
          <SegmentedControl.Item value="list" className="max-sm:flex-1">列表</SegmentedControl.Item>
          <SegmentedControl.Item value="board" className="max-sm:flex-1">看板</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>
    </div>
  );

  const clearFilter = filtering ? (
    <Button variant="soft" color="gray" size="1" onClick={() => setFilter(NO_TRACKER_FILTER)}>
      清除筛选
    </Button>
  ) : undefined;

  const listBody = (() => {
    const groups = trackerListGroups(specs, listState, filter);
    if (groups.length === 0) {
      return (
        <CardShell className="px-5 py-4">
          <EmptyState
            title={filtering ? "没有符合筛选的票。" : listState === "open" ? "没有开着的票。" : "没有关掉的票。"}
            action={clearFilter}
          />
        </CardShell>
      );
    }
    return (
      <CardShell className="min-w-0 overflow-hidden">
        {groups.map(({ spec, tickets: rows }) => {
          const done = spec.tickets.filter((ticket) => ticket.state === "closed").length;
          return (
            <section key={spec.id} className="min-w-0 border-t border-line first:border-t-0">
              {/* 组头是 spec:标题点开全文,右端是它的票关了几张与导出。底色让它与下面的票行分层。 */}
              <div className="flex min-w-0 items-center justify-between gap-3 bg-sunken px-4 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    data-spec-trigger={spec.id}
                    className="min-w-0 break-words rounded-sm text-left text-md font-semibold text-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-11"
                    onClick={(event) => openFromSpec(event, spec.id)}
                  >
                    {spec.title}
                  </button>
                  {spec.state === "closed" ? (
                    <Badge color="gray" variant="soft" size="1">
                      已关
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {spec.tickets.length === 0 ? null : (
                    <span className="text-sm text-text-muted" title={`${spec.tickets.length} 张票里关了 ${done} 张`}>
                      <span className="font-mono tabular-nums">
                        {done}/{spec.tickets.length}
                      </span>{" "}
                      已关
                    </span>
                  )}
                  {/* 导出就是那一个 GET:交给浏览器下载,不必先在前端拼一遍 Markdown。 */}
                  <Button asChild variant="ghost" color="gray" size="1" className="pointer-coarse:min-h-11">
                    <a
                      href={apiUrl(`/products/${product.id}/specs/${spec.id}/export`)}
                      download={`${spec.title}.md`}
                    >
                      导出
                    </a>
                  </Button>
                </div>
              </div>
              {rows.length === 0 ? (
                <p className="border-t border-line px-4 py-2.5 text-base text-text-muted">还没有拆出票。</p>
              ) : (
                <ul>
                  {rows.map((ticket) => {
                    const status = statuses.get(ticket.id) ?? "ready";
                    return (
                      <li
                        key={ticket.id}
                        className="flex min-w-0 items-start gap-2.5 border-t border-line px-4 py-2.5 transition-colors hover:bg-sunken"
                      >
                        <TicketStatusIcon status={status} className="mt-0.5" />
                        <div className="flex min-w-0 grow flex-col gap-0.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <button
                              type="button"
                              data-ticket-trigger={ticket.id}
                              className={cn(
                                "min-w-0 break-words rounded-sm text-left text-lg font-medium hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                                ticket.state === "closed" ? "text-text-secondary" : "text-text",
                              )}
                              onClick={(event) => openFromTicket(event, spec.id, ticket.id)}
                            >
                              {ticket.title}
                            </button>
                            <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                              {ticket.label}
                            </Badge>
                          </div>
                          <TicketMeta
                            ticket={ticket}
                            openTickets={openTickets}
                            pickable={false}
                            onJump={jumpTo}
                          />
                        </div>
                        {pickable.has(ticket.id) ? <PickableMark /> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </CardShell>
    );
  })();

  const boardBody = (
    // 列不是卡:页面灰底上一道更深一档的槽,白卡浮在里面。窄屏按 2 列、1 列折下来,不横向滚。
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {TICKET_STATUSES.map(({ status, title }) => {
        const all = matching.filter(({ ticket }) => statuses.get(ticket.id) === status);
        // 已关那一列新关的在前:票号越大越晚写下,没有关闭时刻可排,拿它近似。
        const ordered = status === "closed" ? [...all].sort((x, y) => y.ticket.id - x.ticket.id) : all;
        const cut = status === "closed" && !showAllClosed && ordered.length > CLOSED_COLUMN_LIMIT;
        const cards = cut ? ordered.slice(0, CLOSED_COLUMN_LIMIT) : ordered;
        return (
          <section
            key={status}
            aria-label={title}
            className="flex min-w-0 flex-col gap-2 rounded-[var(--v8-radius-card)] bg-sunken p-2"
          >
            <h3 className="flex items-center gap-2 px-1.5 pt-1 text-md font-semibold">
              <TicketStatusIcon status={status} />
              {title}
              <span className="font-mono text-sm font-normal text-text-muted tabular-nums">{all.length}</span>
            </h3>
            {cards.length === 0 ? (
              <p className="px-1.5 pb-1.5 text-base text-text-disabled">没有票</p>
            ) : (
              cards.map(({ spec, ticket }) => {
                const notes = ticketNotes(ticket, openTickets);
                return (
                  <button
                    key={ticket.id}
                    type="button"
                    data-ticket-trigger={ticket.id}
                    className="flex min-w-0 flex-col gap-1.5 rounded-[var(--v8-radius-control)] border border-card-line bg-surface p-3 text-left shadow-[var(--v8-shadow-control)] transition-[box-shadow,border-color] hover:border-input hover:shadow-[var(--v8-shadow-card)] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                    onClick={(event) => openFromTicket(event, spec.id, ticket.id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-text-muted tabular-nums">#{ticket.id}</span>
                      <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                        {ticket.label}
                      </Badge>
                    </span>
                    <span
                      className={cn(
                        "line-clamp-3 break-words text-md font-medium",
                        ticket.state === "closed" ? "text-text-secondary" : "text-text",
                      )}
                    >
                      {ticket.title}
                    </span>
                    <span className="truncate text-sm text-text-muted" title={spec.title}>
                      {spec.title}
                    </span>
                    {/* 已关那一句列头已经说了,卡上只留认领人与还挡着它的票。 */}
                    {notes.replace(/^已关( · )?/, "") === "" ? null : (
                      <span className="text-sm text-text-secondary">{notes.replace(/^已关( · )?/, "")}</span>
                    )}
                  </button>
                );
              })
            )}
            {cut ? (
              <Button variant="ghost" color="gray" size="1" className="mx-1 mb-1 self-start" onClick={() => setShowAllClosed(true)}>
                显示全部 {ordered.length} 张
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {pending ? (
        <Skeleton aria-hidden className="h-24" />
      ) : specs.length === 0 ? (
        <CardShell className="px-5 py-4">
          <h2 className="sr-only">产品 tracker</h2>
          <EmptyState
            title="还没有 spec。"
            description="在需求拆分会话里谈定一个需求，agent 就把它连同拆出的票写进来。"
          />
        </CardShell>
      ) : (
        <>
          {toolbar}
          {view === "list" ? listBody : boardBody}
        </>
      )}
      <SpecDialog
        productId={product.id}
        spec={openSpec}
        canChat={canChat}
        pickable={pickable}
        openTickets={openTickets}
        statuses={statuses}
        focus={focus}
        onJump={jumpTo}
        onClose={() => {
          setFocus(null);
          onOpenSpec(null);
        }}
        onCloseAutoFocus={returnFocus.onCloseAutoFocus}
      />
    </div>
  );
}

/** spec 弹窗侧栏里的一段:小标题加内容,段与段之间一道发丝线。 */
function SidebarBlock({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 一张票底下的评论输入(CONTEXT.md 票,issue #363)。一个 TextArea 加一颗发送,草稿留在
 * 这一张票自己的组件里——弹窗里几张票同时开着,草稿不该互相串。
 */
function CommentBox({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (text === "") return;
        setDraft("");
        onSend(text);
      }}
    >
      <TextArea
        size="2"
        rows={2}
        maxLength={4000}
        aria-label="写一条评论"
        placeholder="写一条评论"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" size="1" variant="soft" disabled={busy || draft.trim() === ""}>
          发送
        </Button>
      </div>
    </form>
  );
}

/**
 * 一条 spec 的全文(issue #361):它自己的正文,加它那几张票的正文与评论。读的是
 * `GET /products/{id}/specs/{specId}`——产品详情那一份只带列表要显示的那几格。
 *
 * 人的那几个动作也在这里(issue #363):开关这条 spec,认领、改标签、开关一张票,在票上
 * 评论。正文与标题没有入口——它们只由会话经工具写(ADR 0035)。做完重读这一份与产品详情:
 * 认领人与状态在产品页那一列上也要跟着变。
 */
function SpecDialog({
  productId,
  spec,
  canChat,
  pickable,
  openTickets,
  statuses,
  focus,
  onJump,
  onClose,
  onCloseAutoFocus,
}: {
  productId: number;
  spec: TrackerSpec | null;
  /** 有 `agent:chat` 且分到了这个产品里的仓库时才显示那几个控件。 */
  canChat: boolean;
  /** 可开工的票号,与产品页那一列同一份。 */
  pickable: ReadonlySet<number>;
  /** 开着的票号:「等 #n」只列还挡着的那几张。 */
  openTickets: ReadonlySet<number>;
  /** 每张票落在看板哪一列,与产品页那一份同一份。 */
  statuses: ReadonlyMap<number, TicketStatus>;
  /** 从一张票点进来、或跟着阻塞边跳过来时,展开并滚到这一张。 */
  focus: TicketFocus | null;
  /** 跟着一处阻塞边跳到那张票(可能在另一条 spec 下)。 */
  onJump: (ticketId: number) => void;
  onClose: () => void;
  /** 关闭后把焦点送回打开它的那颗 spec 标题键。 */
  onCloseAutoFocus: (event: Event) => void;
}) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  /** 等人点头才写的那一下(issue #389):null 即此刻没有要关的东西。 */
  const [closing, setClosing] = useState<TrackerCloseTarget | null>(null);
  const detail = useQuery({
    queryKey: specQueryKey(productId, spec?.id),
    queryFn: () => fetchJson<SpecDetail>(`/products/${productId}/specs/${spec!.id}`),
    enabled: spec !== null,
  });

  /** 动作做完重读两份:这一条 spec 的全文,与产品详情里的那一列。 */
  const reread = async (): Promise<void> => {
    setFailure(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: specQueryKey(productId, spec?.id) }),
      queryClient.invalidateQueries({ queryKey: productQueryKey(productId) }),
    ]);
  };
  const failed = (error: Error): void => setFailure(error.message);

  const act = useMutation({
    mutationFn: (input: { path: string; method: string; payload: unknown }) =>
      send(input.path, input.method, input.payload),
    onSuccess: reread,
    onError: failed,
  });
  const busy = act.isPending;
  /** 一张票上的一个动作:认领、改标签或开关,给哪一格就动哪一格。 */
  const ticketAction = (
    ticketId: number,
    payload: { claimed?: boolean; label?: TicketLabel; state?: TrackerState },
  ): void => {
    act.mutate({ path: `/products/${productId}/tickets/${ticketId}`, method: "PUT", payload });
  };
  /**
   * 确认弹窗关闭带退场动画,`closing` 一清空,还在淡出的那一帧就会渲染出「关掉票 #undefined」
   * (issue #382 在权限页踩过同一脚)。记住最后一个非空值,退场期间照它渲染;点了做什么仍读
   * `closing`。
   */
  const lastClosing = useRef(closing);
  if (closing !== null) lastClosing.current = closing;
  const shownClosing = closing ?? lastClosing.current;
  /** 确认弹窗关掉后焦点回到按下的那颗「关掉」;它被换掉时退到本弹窗的关闭键。 */
  const confirmFocus = useDialogReturnFocus(useCallback(
    () => document.querySelector<HTMLElement>('[role="dialog"] [aria-label="关闭"]'),
    [],
  ));
  const closeConfirm = shownClosing === null ? null : trackerCloseConfirm(shownClosing);
  /** 展开着的票。关掉弹窗即清空,下一次打开从全收起开始。 */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  /** 要去的那一张:内容一到就展开它、把那一行滚进视野。换了 spec 时等新的那一份读到再滚。 */
  const loadedSpecId = detail.data?.spec.id;
  useEffect(() => {
    if (focus === null || loadedSpecId !== spec?.id) return;
    setExpanded((prev) => new Set(prev).add(focus.ticketId));
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-ticket-row="${focus.ticketId}"]`)
        ?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        }),
    );
  }, [focus, loadedSpecId, spec?.id]);

  return (
    <Dialog.Root
      open={spec !== null}
      onOpenChange={(next) => {
        if (!next) {
          setFailure(null);
          setExpanded(new Set());
          onClose();
        }
      }}
    >
      <Dialog.Content
        maxWidth="980px"
        size={{ initial: "2", sm: "3" }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {/* 关闭键在标题行右端(issue #390)。与仓库配置弹窗同一形状。 */}
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title size="5" mb="2" className="min-w-0 break-words">
            {spec?.title ?? ""}
          </Dialog.Title>
          <Dialog.Close>
            <IconButton
              type="button"
              variant="ghost"
              color="gray"
              size={{ initial: "3", sm: "1" }}
              className="shrink-0"
              aria-label="关闭"
            >
              <Cross2Icon aria-hidden />
            </IconButton>
          </Dialog.Close>
        </div>
        {/* 标题下那一行照 GitHub issue 头:状态胶囊,再跟几件事实。 */}
        <Dialog.Description size="2" color="gray" mb="4" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {spec === null ? null : spec.state === "open" ? (
              <Badge color="green" variant="soft" size="2" radius="full">
                <RadiobuttonIcon aria-hidden />
                开着
              </Badge>
            ) : (
              <Badge color="gray" variant="soft" size="2" radius="full">
                <CheckCircledIcon aria-hidden />
                已关
              </Badge>
            )}
            {detail.data === undefined ? null : (
              <span>
                <span className="font-mono tabular-nums">{detail.data.tickets.length}</span> 张票 · 建于{" "}
                {localMinute(detail.data.spec.createdAt)}
              </span>
            )}
        </Dialog.Description>
        {failure === null ? null : (
          <Callout.Root role="alert" color="red" size="1" mb="3">
            <Callout.Icon>
              <CrossCircledIcon aria-hidden />
            </Callout.Icon>
            <Callout.Text>{failure}</Callout.Text>
          </Callout.Root>
        )}
        {detail.isPending ? (
          <Skeleton aria-hidden className="h-64" />
        ) : detail.error !== null ? (
          <Text as="p" size="2" color="red">
            {(detail.error as Error).message}
          </Text>
        ) : (
          // `relative`:里面任何绝对定位的东西都按这一格定位,不漏到弹窗外层去撑它的滚动高度。
          // 横向不滚:ghost 键的负外边距会多出几像素,`-mx-1 px-1` 给焦点环留位置。
          <div className="relative -mx-1 max-h-[min(70vh,720px)] min-w-0 overflow-x-hidden overflow-y-auto px-1 max-sm:max-h-[58dvh]">
            <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_13rem]">
              {/* 侧栏照 GitHub issue 页右侧:进度、看板分布、动作。`md` 以下排到正文之前,
                  动作不必滚过整篇正文才够得着。 */}
              <aside className="flex min-w-0 flex-col gap-4 text-base md:sticky md:top-0 md:order-last md:self-start">
                {detail.data.tickets.length === 0 ? null : (
                  <SidebarBlock title="进度">
                    {(() => {
                      const total = detail.data.tickets.length;
                      const done = detail.data.tickets.filter((ticket) => ticket.state === "closed").length;
                      return (
                        <>
                          <div
                            role="progressbar"
                            aria-label="票的进度"
                            aria-valuemin={0}
                            aria-valuemax={total}
                            aria-valuenow={done}
                            className="h-1.5 overflow-hidden rounded-full bg-accent-track"
                          >
                            <div className="h-full rounded-full bg-primary" style={{ width: `${(done / total) * 100}%` }} />
                          </div>
                          <span className="text-text-secondary">
                            <span className="font-mono tabular-nums">
                              {done}/{total}
                            </span>{" "}
                            张已关
                          </span>
                        </>
                      );
                    })()}
                  </SidebarBlock>
                )}
                {detail.data.tickets.length === 0 ? null : (
                  // `md` 以下侧栏排在正文之前,这一段让位:四个数在票行的图标上都读得到。
                  <SidebarBlock title="票的状态" className="max-md:hidden">
                    <ul className="flex flex-col gap-1">
                      {TICKET_STATUSES.map(({ status, title }) => {
                        const count = detail.data.tickets.filter((ticket) => statuses.get(ticket.id) === status).length;
                        return (
                          <li key={status} className={cn("flex items-center gap-2", count === 0 && "text-text-disabled")}>
                            <TicketStatusIcon status={status} className={count === 0 ? "opacity-40" : undefined} />
                            <span className="grow">{title}</span>
                            <span className="font-mono tabular-nums">{count}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </SidebarBlock>
                )}
                {(() => {
                  // 这条 spec 里被挡过的票,连同挡着它的每一张(关了的也列,划掉)。宽屏才画:
                  // 窄屏侧栏排在正文前,票行上那句「等 #n」已经点得到。
                  const blocked = detail.data.tickets.filter((ticket) => ticket.blockedBy.length > 0);
                  return blocked.length === 0 ? null : (
                    <SidebarBlock title="依赖" className="max-md:hidden">
                      <ul className="flex flex-col gap-1.5">
                        {blocked.map((ticket) => (
                          <li key={ticket.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <BlockerLink id={ticket.id} onJump={onJump} />
                            <span className="text-text-muted">等</span>
                            {ticket.blockedBy.map((id) => (
                              <BlockerLink key={id} id={id} closed={!openTickets.has(id)} onJump={onJump} />
                            ))}
                          </li>
                        ))}
                      </ul>
                    </SidebarBlock>
                  );
                })()}
                <SidebarBlock title="操作">
                  <div className="flex flex-wrap gap-2 md:flex-col md:items-start">
                    <Button asChild variant="soft" color="gray" size="1" className="pointer-coarse:min-h-11">
                      <a
                        href={apiUrl(`/products/${productId}/specs/${detail.data.spec.id}/export`)}
                        download={`${detail.data.spec.title}.md`}
                      >
                        导出 Markdown
                      </a>
                    </Button>
                    {canChat ? (
                      <Button
                        size="1"
                        variant="soft"
                        color="gray"
                        className="pointer-coarse:min-h-11"
                        disabled={busy}
                        onClick={(event) =>
                          // 关要先问一句(issue #389);重新打开照旧点完就写——它把状态放回去,误触没有代价。
                          detail.data.spec.state === "open"
                            ? (confirmFocus.captureTrigger(event), setClosing({
                                kind: "spec",
                                id: detail.data.spec.id,
                                title: detail.data.spec.title,
                              }))
                            : act.mutate({
                                path: `/products/${productId}/specs/${detail.data.spec.id}`,
                                method: "PUT",
                                payload: { state: "open" },
                              })
                        }
                      >
                        {detail.data.spec.state === "open" ? "关掉这条 spec" : "重新打开这条 spec"}
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-sm text-text-muted">正文由会话写，这里只读。</p>
                </SidebarBlock>
              </aside>

              <div className="flex min-w-0 flex-col gap-4">
                <Markdown text={detail.data.spec.body} />
                {/*
                  一张票一行,形状照 GitHub 的子 issue:状态图标、标题、标签,动作贴着标题那一行——
                  收起时也要认领得了、改得了标签;正文与评论点开才展开(一条 spec 常带十来张票,
                  全摊开要滚半天才找得到要动的那一张)。
                */}
                {detail.data.tickets.length === 0 ? null : (
                  <h3 className="flex items-center gap-1.5 border-t border-line pt-4 text-lg font-semibold">
                    票
                    <span className="font-mono text-xs font-normal text-text-muted tabular-nums">
                      {detail.data.tickets.length}
                    </span>
                  </h3>
                )}
                {detail.data.tickets.length === 0 ? null : (
                  <div className="min-w-0 overflow-hidden rounded-[var(--v8-radius-control)] border border-card-line">
                    {detail.data.tickets.map((ticket) => {
                      const status = statuses.get(ticket.id) ?? "ready";
                      return (
                        <section
                          key={ticket.id}
                          data-ticket-row={ticket.id}
                          className="flex min-w-0 scroll-mt-2 flex-col border-t border-line first:border-t-0"
                        >
                          <Collapsible.Root
                            open={expanded.has(ticket.id)}
                            onOpenChange={(open) =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (open) next.add(ticket.id);
                                else next.delete(ticket.id);
                                return next;
                              })
                            }
                            className="group/ticket flex min-w-0 flex-col"
                          >
                            <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2 group-data-[state=open]/ticket:bg-sunken">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <Collapsible.Trigger asChild>
                                {/* 原生 button,触控高度自己给(DESIGN.md 6.1 触控):coarse 块只发给
                                    Radix 类名。 */}
                                <button
                                  type="button"
                                  className="flex min-w-[12rem] grow basis-full items-start gap-2 rounded-md py-0.5 text-left transition-colors pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none sm:basis-0"
                                >
                                  <ChevronRightIcon
                                    aria-hidden
                                    className="mt-0.5 shrink-0 text-text-muted transition-transform group-data-[state=open]/ticket:rotate-90"
                                  />
                                  <TicketStatusIcon status={status} className="mt-0.5" />
                                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                    <Text
                                      as="span"
                                      size="3"
                                      weight="medium"
                                      className={cn(
                                        "min-w-0 break-words",
                                        ticket.state === "closed" && "text-text-secondary",
                                      )}
                                    >
                                      {ticket.title}
                                    </Text>
                                    <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                                      {ticket.label}
                                    </Badge>
                                  </span>
                                </button>
                              </Collapsible.Trigger>
                              {canChat ? (
                                <div className="flex flex-wrap items-center gap-4 pl-1 max-sm:pl-12">
                                  <Button
                                    size="1"
                                    className="pointer-coarse:min-h-11"
                                    variant="ghost"
                                    color="gray"
                                    disabled={busy}
                                    onClick={() =>
                                      ticketAction(ticket.id, { claimed: ticket.claimedBy === null })
                                    }
                                  >
                                    {ticket.claimedBy === null ? "认领" : "取消认领"}
                                  </Button>
                                  <DropdownMenu.Root>
                                    <DropdownMenu.Trigger>
                                      <Button size="1" variant="ghost" color="gray" disabled={busy} className="pointer-coarse:min-h-11">
                                        改标签
                                        <ChevronDownIcon aria-hidden />
                                      </Button>
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Content align="end">
                                      {TICKET_LABELS.map((label) => (
                                        <DropdownMenu.Item
                                          key={label}
                                          disabled={label === ticket.label}
                                          onSelect={() => ticketAction(ticket.id, { label })}
                                        >
                                          {label}
                                        </DropdownMenu.Item>
                                      ))}
                                    </DropdownMenu.Content>
                                  </DropdownMenu.Root>
                                  <Button
                                    size="1"
                                    className="pointer-coarse:min-h-11"
                                    variant="ghost"
                                    color="gray"
                                    disabled={busy}
                                    onClick={(event) =>
                                      ticket.state === "open"
                                        ? (confirmFocus.captureTrigger(event), setClosing({ kind: "ticket", id: ticket.id, title: ticket.title }))
                                        : ticketAction(ticket.id, { state: "open" })
                                    }
                                  >
                                    {ticket.state === "open" ? "关掉" : "重新打开"}
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                            {/* 标题下那一行放在展开键之外:阻塞的票号要能单独点,键里不能再套键。
                                左缩进让开 chevron 与状态图标两格,与标题的字对齐。 */}
                            <TicketMeta
                              ticket={ticket}
                              openTickets={openTickets}
                              pickable={pickable.has(ticket.id)}
                              onJump={onJump}
                              className="pl-[47px]"
                            />
                            </div>
                            <Collapsible.Content className="collapsible-motion">
                              {/* 正文缩进到标题的字下面(让开 chevron 与状态图标两格)。 */}
                              <div className="flex min-w-0 flex-col gap-2 border-t border-line px-3 py-3 sm:pl-[3.25rem]">
                                <Markdown text={ticket.body} />
                                {/* 评论整段显示,不折叠:一张票上的来龙去脉就这几条。 */}
                                {ticket.comments.length === 0 ? null : (
                                  <ul className="flex min-w-0 flex-col gap-2 border-t border-line pt-2">
                                    {ticket.comments.map((comment) => (
                                      <li key={comment.id} className="flex min-w-0 flex-col gap-0.5">
                                        <span className="text-sm text-text-muted">
                                          <span className="font-semibold text-text-secondary">{comment.author ?? "会话"}</span>
                                          {" · "}
                                          {localMinute(comment.createdAt)}
                                        </span>
                                        <Text as="p" size="2" className="break-words whitespace-pre-wrap">
                                          {comment.body}
                                        </Text>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {canChat ? (
                                  <CommentBox
                                    busy={busy}
                                    onSend={(text) =>
                                      act.mutate({
                                        path: `/products/${productId}/tickets/${ticket.id}/comments`,
                                        method: "POST",
                                        payload: { text },
                                      })
                                    }
                                  />
                                ) : null}
                              </div>
                            </Collapsible.Content>
                          </Collapsible.Root>
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <ConfirmDialog
          open={closing !== null}
          onOpenChange={(open) => {
            if (!open) setClosing(null);
          }}
          onCloseAutoFocus={confirmFocus.onCloseAutoFocus}
          maxWidth="440px"
          title={closeConfirm?.title ?? ""}
          titleSize="4"
          titleMb="2"
          description={closeConfirm?.description ?? ""}
          descriptionClassName="break-words"
          direction={{ initial: "column-reverse", sm: "row" }}
          cancelLabel="取消"
          cancelVariant="outline"
          confirm={{
            label: "关掉",
            color: "gray",
            highContrast: true,
            closesDialog: true,
            onClick: () => {
              if (closing === null) return;
              if (closing.kind === "ticket") ticketAction(closing.id, { state: "closed" });
              else {
                act.mutate({
                  path: `/products/${productId}/specs/${closing.id}`,
                  method: "PUT",
                  payload: { state: "closed" },
                });
              }
            },
          }}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}
