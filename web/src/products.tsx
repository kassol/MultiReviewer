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
  TextArea,
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
  pickableTickets,
  PRODUCTS_QUERY_KEY,
  productQueryKey,
  specQueryKey,
  statementParts,
  type Product,
  type ProductKnowledge,
  type ProductRepo,
  type SpecDetail,
  type TicketLabel,
  type TrackerSpec,
  type TrackerState,
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
          canChat={canChat}
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
        `max-lg:order-*` 排成 产品列表 → 会话 → 仓库 → 概览 + 产品知识(issue #383)。
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
            description={`产品下的 ${sessions.length} 个 Agent 会话连记录与图片一并删除,不可撤销。仓库只是从产品里摘出,注册表不动。`}
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
              让 agent 读一遍 {productName} 的全部仓库,再按轮问你,把谈定的写进产品知识。
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
 * 一条陈述的正文。拆段在 `lib/products.ts` 的 `statementParts`(反引号圈住的那几段按行内
 * 代码渲染,与会话页同一种样子),这里只画。
 */
function Statement({ text }: { text: string }) {
  return (
    <>
      {statementParts(text).map((part, index) =>
        part.code ? (
          <code key={index} className="rounded-chip bg-fill px-1 py-0.5 font-mono text-xs">
            {part.text}
          </code>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
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
          className="flex min-h-9 items-center gap-1 text-sm text-text-muted pointer-coarse:min-h-11 hover:text-text-secondary"
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
      梳理
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
                  : "开一场产品梳理:agent 读一遍全部仓库,再按轮问你"
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
              ? "还没有产品知识。点「梳理」跟 agent 谈一遍,或在一个 Agent 会话里聊出来。"
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
 * 可开工的那一枚标记(CONTEXT.md 票,issue #363)。不另起一枚 Badge:标签那一格已经占着
 * 颜色,再来一枚绿的会与 `ready-for-agent` 撞脸。一行主色小字说完即可。
 */
function PickableMark() {
  return <span className="shrink-0 text-sm font-medium text-primary">可开工</span>;
}

/**
 * 产品页右栏的产品 tracker 区(CONTEXT.md 产品 tracker,issue #361、#363)。排在产品知识区
 * 下面:知识说这个产品是什么,tracker 说它接下来要做什么。
 *
 * **正文只读**:spec 与票的正文只由会话经工具写。人在这里读、导出,并做认领、改标签、开关
 * 与评论——那几个动作在 spec 全文弹窗里,一张票的上下文全在那儿。列表这一层只多一件事:
 * 把可开工的票标出来。读随产品可见性,动作按 `agent:chat` 显隐。
 */
function TrackerSection({
  product,
  specs,
  pending,
  canChat,
}: {
  product: Product;
  specs: readonly TrackerSpec[];
  pending: boolean;
  canChat: boolean;
}) {
  const [openSpec, setOpenSpec] = useState<TrackerSpec | null>(null);
  const ticketCount = specs.reduce((total, spec) => total + spec.tickets.length, 0);
  const pickable = pickableTickets(specs);

  return (
    <CardShell className="min-w-0 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">产品 tracker</h2>
          <HelpTooltip
            label="产品 tracker 说明"
            content="需求拆分会话谈定之后把 spec 写进来,再拆成带阻塞边的票。正文只由会话写;认领、改标签、开关与评论打开一条 spec 就能做。"
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
                  {/* `shrink`:Themes 的 Button 自带 `flex-shrink: 0`,只给 `min-w-0` 挡不住
                      它按标题全长撑开,窄屏上标题会顶出卡片右沿。 */}
                  <Button
                    variant="ghost"
                    color="gray"
                    size="2"
                    className="min-w-0 shrink justify-start text-left"
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
                        // 标签、状态那几格宽度固定,390px 下把标题挤成一行一个字。让这一行
                        // 可折行,标题留一道 12rem 的下限:窄屏里它自己占一行,宽屏照旧一行排完。
                        <li
                          key={ticket.id}
                          className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1"
                        >
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
                                ? "min-w-[12rem] flex-1 break-words text-text-muted line-through"
                                : "min-w-[12rem] flex-1 break-words"
                            }
                          >
                            {ticket.title}
                          </Text>
                          {notes === "" ? null : (
                            <span className="shrink-0 text-sm text-text-muted">{notes}</span>
                          )}
                          {pickable.has(ticket.id) ? <PickableMark /> : null}
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
      <SpecDialog
        productId={product.id}
        spec={openSpec}
        canChat={canChat}
        pickable={pickable}
        onClose={() => setOpenSpec(null)}
      />
    </CardShell>
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
  onClose,
}: {
  productId: number;
  spec: TrackerSpec | null;
  /** 有 `agent:chat` 且分到了这个产品里的仓库时才显示那几个控件。 */
  canChat: boolean;
  /** 可开工的票号,与产品页那一列同一份。 */
  pickable: ReadonlySet<number>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
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

  return (
    <Dialog.Root
      open={spec !== null}
      onOpenChange={(next) => {
        if (!next) {
          setFailure(null);
          onClose();
        }
      }}
    >
      <Dialog.Content maxWidth="820px" size={{ initial: "2", sm: "3" }}>
        <Dialog.Title size="4" mb="2">
          {spec?.title ?? ""}
        </Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          spec 与票的正文由会话写,这里读它,并认领、改标签、开关与评论。
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
          <div className="flex max-h-[min(70vh,720px)] min-w-0 flex-col gap-4 overflow-y-auto">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {detail.data.spec.state === "closed" ? (
                <Badge color="gray" variant="soft" size="1">
                  已关
                </Badge>
              ) : null}
              {canChat ? (
                <Button
                  size="1"
                  variant="soft"
                  color="gray"
                  disabled={busy}
                  onClick={() =>
                    act.mutate({
                      path: `/products/${productId}/specs/${detail.data.spec.id}`,
                      method: "PUT",
                      payload: {
                        state: detail.data.spec.state === "open" ? "closed" : "open",
                      },
                    })
                  }
                >
                  {detail.data.spec.state === "open" ? "关掉这条 spec" : "重新打开这条 spec"}
                </Button>
              ) : null}
            </div>
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
                  {pickable.has(ticket.id) ? <PickableMark /> : null}
                </div>
                <Markdown text={ticket.body} />
                {canChat ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="1"
                      variant="soft"
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
                        <Button size="1" variant="soft" color="gray" disabled={busy}>
                          改标签
                          <ChevronDownIcon aria-hidden />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="start">
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
                      variant="soft"
                      color="gray"
                      disabled={busy}
                      onClick={() =>
                        ticketAction(ticket.id, {
                          state: ticket.state === "open" ? "closed" : "open",
                        })
                      }
                    >
                      {ticket.state === "open" ? "关掉" : "重新打开"}
                    </Button>
                  </div>
                ) : null}
                {/* 评论整段显示,不折叠:一张票上的来龙去脉就这几条。 */}
                {ticket.comments.map((comment) => (
                  <Text as="p" key={comment.id} size="2" color="gray" className="break-words">
                    {comment.author ?? "会话"}:{comment.body}
                  </Text>
                ))}
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
              </section>
            ))}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
