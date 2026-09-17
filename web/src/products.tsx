import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircledIcon,
  ChevronDownIcon,
  CrossCircledIcon,
  DotsHorizontalIcon,
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
  Text,
  Tooltip,
} from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { Fragment, useEffect, useState, type FormEvent } from "react";

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
import { Button } from "@/components/theme-button";
import type { CommitSelection } from "@/commit-picker";
import { sessionsQueryKey, type AgentSession } from "@/lib/agent-sessions";
import {
  currentProduct,
  groupedTerms,
  PRODUCTS_QUERY_KEY,
  productQueryKey,
  specQueryKey,
  type Product,
  type ProductKnowledge,
  type ProductRepo,
  type SpecDetail,
  type TicketLabel,
  type TrackerSpec,
  type TrackerTicket,
} from "@/lib/products";
import { localMinute } from "@/lib/time";

import { apiUrl, fetchJson, send } from "./api.ts";
import { NameDialog, ProductRail, useProductDetail, useProductSessions } from "./product-rail.tsx";

/**
 * 产品页(CONTEXT.md 产品,issue #331)。左栏是产品页与会话页共用的那一份(`ProductRail`:
 * 产品列表、当前产品的仓库、会话),右栏是当前产品的概览、产品知识与产品 tracker(issue
 * #361)。当前产品写在地址上(`/products/$productId`),从会话页回来选的还是同一个产品。
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
            : `已删产品 ${product.name},连同 ${result.cascade.sessions} 个 Agent 会话。`,
        error: false,
      });
      void refresh();
      // 地址上那个产品已经没了,回不带产品的产品页:当前项落到列表第一个上。
      void navigate({ to: "/products" });
    },
    onError: failed,
  });

  /**
   * 重梳(CONTEXT.md 产品梳理,issue #345):开一个产品梳理会话。它由系统建,因此不跳进去
   * ——人要看的是它随后写下的那几条,会话在左栏列着,想看过程再点进去。
   *
   * `baselines` 是人在重梳弹窗里动过的那几行(issue #353);一行都没动就不带它,与这一票
   * 之前直接按下重梳一字不差。
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
      setFeedback({ text: "已开一个产品梳理会话,它写下的条目会出现在这里。", error: false });
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(session.productId) });
      void refreshKnowledge();
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

  /* 右栏:概览卡与产品知识。 */
  const rightColumn = (
    <>
      {selected === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 className="min-w-0 break-all text-2xl font-bold tracking-[-0.015em]">
              {selected.name}
            </h2>
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
          {/* 仓库数、知识数、会话数左栏都有,这里不重复。 */}
          <p className="text-base text-text-muted">建于 {localMinute(selected.createdAt)}</p>
        </div>
      )}
      {selected === undefined ? null : (
        <KnowledgeSection
          key={selected.id}
          product={selected}
          knowledge={knowledge}
          pending={knowledgeQuery.isPending}
          canWrite={canWriteKnowledge}
          busy={busy}
          onSurvey={() => openDialog("survey")}
        />
      )}
      {selected === undefined ? null : (
        <TrackerSection
          key={selected.id}
          product={selected}
          specs={knowledgeQuery.data?.tracker.specs ?? []}
          pending={knowledgeQuery.isPending}
        />
      )}
    </>
  );

  return (
    <PageBody>
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
        `max-lg:order-*` 排成 产品列表 → 概览 + 产品知识 → 仓库 → 会话。
      */}
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:gap-[18px]">
        <ProductRail
          {...(productId === undefined ? {} : { productId })}
          canWrite={canWrite}
          canChat={canChat}
          busy={busy}
          onFeedback={setFeedback}
          className="lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-112px)] lg:self-start lg:overflow-y-auto lg:overscroll-y-contain"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3 max-lg:order-2">
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
                    ? "把已注册的仓库归到一个产品下,Agent 会话就挂在它上面。左栏的「建产品」开第一个。"
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
            description="改名只改这个产品的名字,它的仓库一个不动。"
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
            description={`产品下的 ${sessions.length} 个 Agent 会话连记录、产出与图片一并删除,不可撤销。仓库只是从产品里摘出,注册表不动。`}
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
 * 重梳弹窗(CONTEXT.md 产品梳理,issue #353)。一个仓库一行的基点行组与建会话弹窗共用一份,
 * 预选每个仓库生效默认分支此刻的最新提交:一行都不动就按确认,与这一票之前直接按下重梳一字
 * 不差;要梳发布线或某条特性分支时只改那几行。
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
              重梳
            </Dialog.Title>
            <Dialog.Description size="2" color="gray">
              让 agent 读一遍 {productName} 的全部仓库,把它们之间的关系写下来。
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
              {busy ? "重梳中…" : "重梳"}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * 一条陈述的正文。agent 与人写的陈述里常拿反引号圈住标识符(`account.balance -= amount`),
 * 原样摊出反引号读起来是源码;按 Markdown 的行内代码渲染,与会话页同一种样子。只认反引号,
 * 不跑整套 Markdown:陈述是一句话,不该有标题与列表。
 */
function Statement({ text }: { text: string }) {
  const parts = text.split("`");
  // 反引号没配对(偶数段)就原样给出,不猜哪半是代码。
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded-chip bg-fill px-1 py-0.5 font-mono text-xs">
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
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
          className="flex min-h-9 items-center gap-1 text-sm text-text-muted max-sm:min-h-11 hover:text-text-secondary"
        >
          出处 <span className="tabular-nums">{entry.annotations.length}</span> 处
          <ChevronDownIcon
            aria-hidden
            className="transition-transform group-data-[state=open]/notes:rotate-180"
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul className="flex flex-col gap-1 border-l border-line pl-3">
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

/** 区块小标题:标题加条数,三段共用一份。 */
function SectionHeading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <h3 id={id} className="flex items-center gap-1.5 text-lg font-semibold">
      {title}
      <span className="font-mono text-xs font-normal text-text-muted tabular-nums">{count}</span>
    </h3>
  );
}

/**
 * 产品页右栏的产品知识区(CONTEXT.md 产品知识,issue #360)。三段:按主题分组的术语表、仓库
 * 关系段、带状态的产品决策列表,每条展开看出处附注。加标题旁的「重梳」。
 *
 * 这一页只读:条目由会话在人的回答下写下即生效,人不手写、不确认也不驳回(ADR 0035)。
 * `knowledge:write` 因此只决定看不看得到「重梳」。
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
  const groups = groupedTerms(knowledge);
  const terms = groups.reduce((count, group) => count + group.terms.length, 0);
  const relationships = knowledge.filter((entry) => entry.kind === "relationship");
  const decisions = knowledge.filter((entry) => entry.kind === "decision");

  const surveyButton = (
    <Button
      variant="soft"
      color="gray"
      size="1"
      className="shrink-0"
      disabled={busy || product.repos.length < 2}
      onClick={onSurvey}
    >
      重梳
    </Button>
  );

  /** 一段之间的分隔:第一段不带上边框,后面每段带。 */
  const sectionClass = (first: boolean): string =>
    first
      ? "flex min-w-0 flex-col gap-1.5"
      : "flex min-w-0 flex-col gap-1.5 border-t border-line pt-3";
  const rowClass = "flex min-w-0 flex-col gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0";

  return (
    <CardShell className="min-w-0 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="text-2xl font-bold tracking-[-0.015em]">产品知识</h2>
            <HelpTooltip
              label="产品知识说明"
              content="产品知识是这个产品的术语表、仓库关系段与产品决策记录:这个产品是什么、它的仓库之间怎么协作、为什么这样定。条目由 Agent 会话在你的回答下写成,写下即生效。"
            />
          </div>
          {canWrite ? (
            <Tooltip
              content={
                product.repos.length < 2
                  ? "产品梳理要这个产品至少有两个仓库"
                  : "开一个产品梳理会话,让 agent 读一遍全部仓库再写下来"
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
          <Text as="p" size="2" color="gray">
            {canWrite && product.repos.length >= 2
              ? "还没有产品知识。点「重梳」让 agent 读一遍仓库,或在一个 Agent 会话里跟它聊出来。"
              : "还没有产品知识。"}
          </Text>
        ) : (
          <>
            {terms === 0 ? null : (
              <section aria-labelledby="product-terms-title" className={sectionClass(true)}>
                <SectionHeading id="product-terms-title" title="术语表" count={terms} />
                {groups.map((group) => (
                  <div key={group.topic ?? ""} className="flex min-w-0 flex-col">
                    {/* 一个分组一行小标题;没分组的那一组不加标题,它就是「其余」。 */}
                    {group.topic === null ? null : (
                      <h4 className="pt-1.5 text-sm font-medium text-text-muted">{group.topic}</h4>
                    )}
                    <ul>
                      {group.terms.map((entry) => (
                        <li key={entry.id} className={rowClass}>
                          <Text as="span" size="2" className="break-words">
                            <span className="font-semibold">{entry.name}</span>
                            {" — "}
                            <Statement text={entry.body} />
                          </Text>
                          {entry.avoided.length === 0 ? null : (
                            <span className="break-words text-sm text-text-muted">
                              不说:{entry.avoided.join("、")}
                            </span>
                          )}
                          <Annotations entry={entry} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
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
                      <Text as="span" size="2" className="break-words">
                        <Statement text={entry.body} />
                      </Text>
                      <Annotations entry={entry} />
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
                      <Text as="span" size="2" className="flex min-w-0 items-start gap-2">
                        <span className="min-w-0 break-words font-semibold">{entry.name}</span>
                        {entry.supersededBy === null ? (
                          <Badge color="green" variant="soft" size="1" className="mt-0.5 shrink-0">
                            生效
                          </Badge>
                        ) : (
                          <Badge color="amber" variant="soft" size="1" className="mt-0.5 shrink-0">
                            被条目 {entry.supersededBy} 取代
                          </Badge>
                        )}
                      </Text>
                      <Text as="span" size="2" className="break-words">
                        <Statement text={entry.body} />
                      </Text>
                      {entry.options === null ? null : (
                        <span className="break-words text-sm text-text-muted">
                          备选:<Statement text={entry.options} />
                        </span>
                      )}
                      {entry.consequences === null ? null : (
                        <span className="break-words text-sm text-text-muted">
                          后果:<Statement text={entry.consequences} />
                        </span>
                      )}
                      <Annotations entry={entry} />
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

/** 五个 triage 标签各自的颜色。同一个标签在哪都是同一色,人扫一眼就认得出哪张票能开工。 */
const LABEL_COLOR: Record<TicketLabel, "gray" | "amber" | "green" | "blue" | "red"> = {
  "needs-triage": "gray",
  "needs-info": "amber",
  "ready-for-agent": "green",
  "ready-for-human": "blue",
  wontfix: "red",
};

/** 一张票那一行右侧的几句:状态、认领人、挡着它的票。没有的那几样不占位置。 */
function ticketNotes(ticket: TrackerTicket): string {
  return [
    ticket.state === "closed" ? "已关" : null,
    ticket.claimedBy === null ? null : `${ticket.claimedBy} 认领`,
    ticket.blockedBy.length === 0 ? null : `等 ${ticket.blockedBy.map((id) => `#${id}`).join("、")}`,
  ]
    .filter((one) => one !== null)
    .join(" · ");
}

/**
 * 产品页右栏的产品 tracker 区(CONTEXT.md 产品 tracker,issue #361)。排在产品知识区下面:
 * 知识说这个产品是什么,tracker 说它接下来要做什么。
 *
 * **整段只读**:spec 与票的正文只由会话经工具写,人在这里读与导出。认领、改标签、开关与
 * 评论是下一票的事,因此这一段一个写动作都没有,也不挂权限格——读随产品可见性。
 */
function TrackerSection({
  product,
  specs,
  pending,
}: {
  product: Product;
  specs: readonly TrackerSpec[];
  pending: boolean;
}) {
  const [openSpec, setOpenSpec] = useState<TrackerSpec | null>(null);
  const ticketCount = specs.reduce((total, spec) => total + spec.tickets.length, 0);

  return (
    <CardShell className="min-w-0 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">产品 tracker</h2>
          <HelpTooltip
            label="产品 tracker 说明"
            content="需求拆分会话谈定之后把 spec 写进来,再拆成带阻塞边的票。正文只由会话写,这里只读与导出。"
          />
          {pending ? null : (
            <span className="ml-1 font-mono text-xs font-normal text-text-muted tabular-nums">
              {specs.length} / {ticketCount}
            </span>
          )}
        </div>

        {pending ? (
          <Skeleton aria-hidden className="h-16" />
        ) : specs.length === 0 ? (
          <Text as="p" size="2" color="gray">
            还没有 spec。在需求拆分会话里谈定一个需求,agent 就把它连同拆出的票写进来。
          </Text>
        ) : (
          <ul>
            {specs.map((spec) => (
              <li
                key={spec.id}
                className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <Button
                    variant="ghost"
                    color="gray"
                    size="2"
                    className="min-w-0 justify-start text-left"
                    onClick={() => setOpenSpec(spec)}
                  >
                    <span className="min-w-0 break-words font-medium">{spec.title}</span>
                  </Button>
                  <Flex gap="2" align="center" className="shrink-0">
                    {spec.state === "closed" ? (
                      <Badge color="gray" variant="soft" size="1">
                        已关
                      </Badge>
                    ) : null}
                    {/* 导出就是那一个 GET:交给浏览器下载,不必先在前端拼一遍 Markdown。 */}
                    <Button asChild variant="ghost" color="gray" size="1">
                      <a
                        href={apiUrl(`/products/${product.id}/specs/${spec.id}/export`)}
                        download={`${spec.title}.md`}
                      >
                        导出
                      </a>
                    </Button>
                  </Flex>
                </div>
                {spec.tickets.length === 0 ? (
                  <Text as="span" size="2" color="gray">
                    还没有拆出票。
                  </Text>
                ) : (
                  <ul className="flex min-w-0 flex-col gap-1">
                    {spec.tickets.map((ticket) => {
                      const notes = ticketNotes(ticket);
                      return (
                        <li key={ticket.id} className="flex min-w-0 items-start gap-2">
                          <span className="mt-0.5 shrink-0 font-mono text-xs text-text-muted tabular-nums">
                            #{ticket.id}
                          </span>
                          <Badge
                            color={LABEL_COLOR[ticket.label]}
                            variant="soft"
                            size="1"
                            className="mt-0.5 shrink-0"
                          >
                            {ticket.label}
                          </Badge>
                          <Text
                            as="span"
                            size="2"
                            className={
                              ticket.state === "closed"
                                ? "min-w-0 break-words text-text-muted line-through"
                                : "min-w-0 break-words"
                            }
                          >
                            {ticket.title}
                          </Text>
                          {notes === "" ? null : (
                            <span className="shrink-0 text-sm text-text-muted">{notes}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <SpecDialog productId={product.id} spec={openSpec} onClose={() => setOpenSpec(null)} />
    </CardShell>
  );
}

/**
 * 一条 spec 的全文(issue #361):它自己的正文,加它那几张票的正文与评论。读的是
 * `GET /products/{id}/specs/{specId}`——产品详情那一份只带列表要显示的那几格。
 */
function SpecDialog({
  productId,
  spec,
  onClose,
}: {
  productId: number;
  spec: TrackerSpec | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: specQueryKey(productId, spec?.id),
    queryFn: () => fetchJson<SpecDetail>(`/products/${productId}/specs/${spec!.id}`),
    enabled: spec !== null,
  });

  return (
    <Dialog.Root
      open={spec !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content maxWidth="820px" size={{ initial: "2", sm: "3" }}>
        <Dialog.Title size="4" mb="2">
          {spec?.title ?? ""}
        </Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          spec 与票的正文由会话写,这里只读。
        </Dialog.Description>
        {detail.isPending ? (
          <Skeleton aria-hidden className="h-64" />
        ) : detail.error !== null ? (
          <Text as="p" size="2" color="red">
            {(detail.error as Error).message}
          </Text>
        ) : (
          <div className="flex max-h-[min(70vh,720px)] min-w-0 flex-col gap-4 overflow-y-auto">
            <Markdown text={detail.data.spec.body} />
            {detail.data.tickets.map((ticket) => (
              <section
                key={ticket.id}
                className="flex min-w-0 flex-col gap-1.5 border-t border-line pt-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-text-muted tabular-nums">
                    #{ticket.id}
                  </span>
                  <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                    {ticket.label}
                  </Badge>
                  <Text as="span" size="3" weight="medium" className="min-w-0 break-words">
                    {ticket.title}
                  </Text>
                  {ticketNotes(ticket) === "" ? null : (
                    <span className="text-sm text-text-muted">{ticketNotes(ticket)}</span>
                  )}
                </div>
                <Markdown text={ticket.body} />
                {ticket.comments.map((comment) => (
                  <Text as="p" key={comment.id} size="2" color="gray" className="break-words">
                    {comment.author ?? "会话"}:{comment.body}
                  </Text>
                ))}
              </section>
            ))}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
