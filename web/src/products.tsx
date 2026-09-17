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
  Checkbox,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  Skeleton,
  Text,
  TextArea,
  Tooltip,
} from "@radix-ui/themes";
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
  PRODUCTS_QUERY_KEY,
  productQueryKey,
  repoPath,
  specQueryKey,
  type Product,
  type ProductKnowledge,
  type ProductRepo,
  type ProductProposal,
  type SpecDetail,
  type TicketLabel,
  type TrackerSpec,
  type TrackerTicket,
} from "@/lib/products";
import { localMinute } from "@/lib/time";

import { apiUrl, fetchJson, send } from "./api.ts";
import { NameDialog, ProductRail, useProductDetail, useProductSessions } from "./product-rail.tsx";

/** 产品知识的陈述上限,与服务端那一道同一个数(`AGENT_STATEMENT_LIMIT`)。 */
const KNOWLEDGE_STATEMENT_MAX = 100;

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
  /** 正要退役的产品知识条目:退役不可恢复,先过一道确认(与删除产品同一套 ConfirmDialog)。 */
  const [retiring, setRetiring] = useState<ProductKnowledge | null>(null);
  /** 产品知识那一段表单的挂载标识:写成功一次就加一,表单因此重挂成空的。 */
  const [knowledgeFormKey, setKnowledgeFormKey] = useState(0);

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

  // 当前产品生效的产品知识(CONTEXT.md 产品知识,issue #343)。产品列表那一份不带它,
  // 因此另读一次产品详情;读不需要权限格,谁看得到产品就看得到这一段。
  const knowledgeQuery = useProductDetail(selected?.id);
  const knowledge = knowledgeQuery.data?.knowledge ?? [];
  const proposals = knowledgeQuery.data?.proposals ?? [];

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
   * 手写一条产品知识(issue #343)。成功之后把表单那一段重挂一次清空它:陈述与勾选的仓库
   * 只属于刚写完的那一条,留在框里下一条就会带着它。
   */
  const writeKnowledge = useMutation({
    mutationFn: (input: { product: Product; statement: string; repoIds: readonly number[] }) =>
      send<{ entry: ProductKnowledge }>(`/products/${input.product.id}/knowledge`, "POST", {
        statement: input.statement,
        repoIds: input.repoIds,
      }),
    onSuccess: () => {
      setKnowledgeFormKey((key) => key + 1);
      setFeedback({ text: "已记下一条产品知识。", error: false });
      void refreshKnowledge();
    },
    onError: failed,
  });

  const retireKnowledge = useMutation({
    mutationFn: (input: { product: Product; entry: ProductKnowledge }) =>
      send(`/products/${input.product.id}/knowledge/${input.entry.id}`, "DELETE"),
    onSuccess: () => {
      setRetiring(null);
      setFeedback({ text: "已退役一条产品知识。", error: false });
      void refreshKnowledge();
    },
    onError: failed,
  });

  /**
   * 确认与驳回一条待确认的提案(issue #346)。两个动作共用这一个 mutation:端点只差最后
   * 一段,成功文案按提案的型别与动作分开说——确认一条退役提案是退役,不是记下一条新知识。
   */
  const decideProposal = useMutation({
    mutationFn: (input: { product: Product; entry: ProductProposal; accept: boolean }) =>
      send(
        `/products/${input.product.id}/knowledge/${input.entry.id}/${input.accept ? "accept" : "reject"}`,
        "POST",
      ),
    onSuccess: (_data, input) => {
      setFeedback({
        text: !input.accept
          ? "已驳回一条提案,同一句话下次梳理不会再提。"
          : input.entry.retiresId === null
            ? "已确认一条产品知识。"
            : "已确认退役,那条产品知识不再生效。",
        error: false,
      });
      void refreshKnowledge();
    },
    onError: failed,
  });

  /**
   * 重梳(CONTEXT.md 产品梳理,issue #345):开一个产品梳理会话。它由系统建,因此不跳进去
   * ——人要看的是它随后交上来的提案,会话在左栏列着,想看过程再点进去。
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
      setFeedback({ text: "已开一个产品梳理会话,它交出提案后在这里确认。", error: false });
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

  const busy =
    rename.isPending ||
    remove.isPending ||
    writeKnowledge.isPending ||
    retireKnowledge.isPending ||
    decideProposal.isPending ||
    survey.isPending;

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
          {/* 仓库数、知识数、会话数左栏都有,这里不重复;产品知识那一份还没读到时先不提待确认提案。 */}
          <p className="text-base text-text-muted">
            {knowledgeQuery.isPending || proposals.length === 0 ? null : (
              <>
                <span className="text-warning">
                  <span className="tabular-nums">{proposals.length}</span> 条待确认提案
                </span>
                {" · "}
              </>
            )}
            建于 {localMinute(selected.createdAt)}
          </p>
        </div>
      )}
      {selected === undefined ? null : (
        <KnowledgeSection
          key={`${selected.id}-${knowledgeFormKey}`}
          product={selected}
          knowledge={knowledge}
          proposals={proposals}
          pending={knowledgeQuery.isPending}
          canWrite={canWriteKnowledge}
          busy={busy}
          onSurvey={() => openDialog("survey")}
          onWrite={(statement, repoIds) => {
            setFeedback(null);
            writeKnowledge.mutate({ product: selected, statement, repoIds });
          }}
          onRetire={(entry) => {
            setFeedback(null);
            setRetiring(entry);
          }}
          onDecide={(entry, accept) => {
            setFeedback(null);
            decideProposal.mutate({ product: selected, entry, accept });
          }}
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
          <ConfirmDialog
            open={retiring !== null}
            onOpenChange={(open) => {
              if (!open) setRetiring(null);
            }}
            title="退役这条产品知识?"
            titleSize="4"
            description={
              retiring === null
                ? ""
                : `「${retiring.statement.length > 80 ? `${retiring.statement.slice(0, 80)}…` : retiring.statement}」退役后不再生效,不可恢复。`
            }
            cancelLabel="取消"
            cancelVariant="outline"
            cancelDisabled={retireKnowledge.isPending}
            confirm={{
              label: retireKnowledge.isPending ? "退役中…" : "退役",
              color: "red",
              disabled: retireKnowledge.isPending || retiring === null,
              onClick: () => {
                if (retiring === null) return;
                setFeedback(null);
                retireKnowledge.mutate({ product: selected, entry: retiring });
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
              让 agent 读一遍 {productName} 的全部仓库再交提案。
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
 * 产品页右栏的产品知识区(CONTEXT.md 产品知识,issue #343、#345、#346)。四样东西:生效列表、
 * 待确认的提案(每行「确认」「驳回」)、手写表单、每行的「退役」,加标题旁的「重梳」。没有
 * `knowledge:write` 的人只看到两份列表——维护这一层知识的人与维护知识集的是同一批人。
 *
 * 仓库不足两个的产品写不出条目(一条产品知识至少说到两个仓库),那一档把表单换成一句话说清
 * 下一步、并把「重梳」置灰,而不是给一个必定被服务端回绝的按钮。
 */
function KnowledgeSection({
  product,
  knowledge,
  proposals,
  pending,
  canWrite,
  busy,
  onWrite,
  onRetire,
  onDecide,
  onSurvey,
}: {
  product: Product;
  knowledge: readonly ProductKnowledge[];
  proposals: readonly ProductProposal[];
  pending: boolean;
  canWrite: boolean;
  busy: boolean;
  onWrite: (statement: string, repoIds: readonly number[]) => void;
  onRetire: (entry: ProductKnowledge) => void;
  onDecide: (entry: ProductProposal, accept: boolean) => void;
  onSurvey: () => void;
}) {
  const [statement, setStatement] = useState("");
  const [repoIds, setRepoIds] = useState<readonly number[]>([]);

  /**
   * 一条条目涉及的仓库写成一行。产品里已经没有的仓库只剩 id 说得出来。产品只有两个仓库时
   * 这一行说不出任何事(一条产品知识至少说到两个仓库),每条都重复同一对名字,因此不渲染;
   * 条目里带着已不在产品里的仓库时仍要渲染,那正是它快要退役的信号。
   */
  const involved = (entry: ProductKnowledge): string | null => {
    const rows = entry.repoIds.map((repoId) => product.repos.find((repo) => repo.repoId === repoId));
    if (product.repos.length <= 2 && rows.every((row) => row !== undefined)) return null;
    return rows
      .map((row, index) => (row === undefined ? `repo ${entry.repoIds[index]}` : repoPath(row)))
      .join("、");
  };
  const involvedLine = (entry: ProductKnowledge) => {
    const line = involved(entry);
    return line === null ? null : <span className="break-all text-sm text-text-muted">{line}</span>;
  };
  // 待确认的提案默认只露前 8 条,其余折起来;换产品这个 section 整体重挂,回到折起。
  const [proposalsExpanded, setProposalsExpanded] = useState(false);
  const visibleProposals = proposalsExpanded ? proposals : proposals.slice(0, 8);
  const hiddenProposalCount = proposals.length - visibleProposals.length;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onWrite(statement.trim(), repoIds);
  };

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

  return (
    <CardShell className="min-w-0 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="text-2xl font-bold tracking-[-0.015em]">产品知识</h2>
            <HelpTooltip
              label="产品知识说明"
              content="一条产品知识说的是仓库之间的事:谁调谁的什么、跨仓库都成立的约定、某类改动牵动哪些仓库。一个仓库内部的事属于那个仓库的知识集。"
            />
          </div>
          {canWrite ? (
            <Tooltip
              content={
                product.repos.length < 2
                  ? "产品梳理要这个产品至少有两个仓库"
                  : "开一个产品梳理会话,让 agent 读一遍全部仓库再交提案"
              }
            >
              {/* disabled 按钮不冒泡指针事件,套一层 span 让提示仍能弹出。 */}
              <span className="inline-flex shrink-0" tabIndex={product.repos.length < 2 ? 0 : -1}>
                {surveyButton}
              </span>
            </Tooltip>
          ) : null}
        </div>

        {proposals.length === 0 ? null : (
          <section aria-labelledby="product-proposals-title" className="flex min-w-0 flex-col gap-1.5">
            <h3 id="product-proposals-title" className="flex items-center gap-1.5 text-lg font-semibold">
              待确认的提案
              <span className="font-mono text-xs font-normal text-warning tabular-nums">
                {proposals.length}
              </span>
            </h3>
            <ul>
              {visibleProposals.map((entry) => {
                const target =
                  entry.retiresId === null
                    ? undefined
                    : knowledge.find((row) => row.id === entry.retiresId);
                return (
                  <li
                    key={entry.id}
                    className="flex items-start justify-between gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {entry.retiresId === null ? (
                        <Text as="span" size="2" className="break-words">
                          <Statement text={entry.statement} />
                        </Text>
                      ) : (
                        <>
                          <Text as="span" size="2" className="flex min-w-0 items-start gap-2">
                            <Badge color="amber" variant="soft" size="1" className="mt-0.5 shrink-0">
                              退役
                            </Badge>
                            <span className="min-w-0 break-words">
                              {target === undefined ? `条目 ${entry.retiresId}` : <Statement text={target.statement} />}
                            </span>
                          </Text>
                          <Text as="span" size="2" color="gray" className="break-words">
                            理由:<Statement text={entry.statement} />
                          </Text>
                        </>
                      )}
                      {involvedLine(entry)}
                    </div>
                    {canWrite ? (
                      <Flex gap="2" className="shrink-0">
                        <Button
                          variant="soft"
                          size="1"
                          disabled={busy}
                          onClick={() => onDecide(entry, true)}
                        >
                          确认
                        </Button>
                        <Button
                          variant="ghost"
                          color="gray"
                          size="1"
                          disabled={busy}
                          onClick={() => onDecide(entry, false)}
                        >
                          驳回
                        </Button>
                      </Flex>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {hiddenProposalCount <= 0 ? null : (
              <Button
                type="button"
                variant="ghost"
                color="gray"
                size="1"
                className="self-start"
                onClick={() => setProposalsExpanded(true)}
              >
                还有 {hiddenProposalCount} 条,展开
                <ChevronDownIcon aria-hidden />
              </Button>
            )}
          </section>
        )}

        <section
          aria-labelledby="product-knowledge-title"
          className={proposals.length === 0 ? "flex min-w-0 flex-col gap-1.5" : "flex min-w-0 flex-col gap-1.5 border-t border-line pt-3"}
        >
          <h3 id="product-knowledge-title" className="flex items-center gap-1.5 text-lg font-semibold">
            生效的产品知识
            {pending ? null : (
              <span className="font-mono text-xs font-normal text-text-muted tabular-nums">
                {knowledge.length}
              </span>
            )}
          </h3>
          {pending ? (
            <Skeleton aria-hidden className="h-16" />
          ) : knowledge.length === 0 ? (
            <Text as="p" size="2" color="gray">
              {canWrite && product.repos.length >= 2
                ? "还没有产品知识。点「重梳」让 agent 读一遍仓库交提案,或在下面手写一条。"
                : "还没有产品知识。"}
            </Text>
          ) : (
            <ul>
              {knowledge.map((entry) => (
                <li
                  key={entry.id}
                  className="group/entry flex items-start justify-between gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Text as="span" size="2" className="break-words">
                      <Statement text={entry.statement} />
                    </Text>
                    {involvedLine(entry)}
                  </div>
                  {/* 十几行各带一个「退役」是噪音:桌面上指到那一行才显出来,触屏没有 hover 就一直在。 */}
                  {canWrite ? (
                    <Button
                      variant="ghost"
                      color="gray"
                      size="1"
                      className="shrink-0 transition-opacity md:opacity-0 md:group-hover/entry:opacity-100 md:group-focus-within/entry:opacity-100 md:focus-visible:opacity-100"
                      disabled={busy}
                      onClick={() => onRetire(entry)}
                    >
                      退役
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {!canWrite ? null : product.repos.length < 2 ? (
          <Text as="p" size="2" color="gray" className="border-t border-line pt-3">
            产品知识至少要说到这个产品里的两个仓库。先把第二个仓库归入这个产品。
          </Text>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-1.5 border-t border-line pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <Text as="label" htmlFor="product-knowledge-statement" size="2" weight="medium">
                手写一条
              </Text>
              <span className="text-sm text-text-muted tabular-nums">
                {statement.length}/{KNOWLEDGE_STATEMENT_MAX}
              </span>
            </div>
            <TextArea
              id="product-knowledge-statement"
              size="2"
              rows={2}
              maxLength={KNOWLEDGE_STATEMENT_MAX}
              placeholder="一句话"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
            />
            <Text as="span" id="product-knowledge-repos" size="2" weight="medium" mt="2">
              涉及的仓库(至少两个)
            </Text>
            {/* 勾选项横排成一行、放不下就换行:两三个仓库名不值一个带框的列表。 */}
            <div
              role="group"
              aria-labelledby="product-knowledge-repos"
              className="flex flex-wrap gap-x-4 gap-y-1"
            >
              {product.repos.map((repo) => (
                <Text
                  as="label"
                  key={repo.repoId}
                  size="2"
                  className="flex min-h-9 cursor-pointer items-center gap-2 max-sm:min-h-11 has-disabled:cursor-not-allowed has-disabled:opacity-70"
                >
                  <Checkbox
                    size="2"
                    checked={repoIds.includes(repo.repoId)}
                    disabled={busy}
                    onCheckedChange={() =>
                      setRepoIds((current) =>
                        current.includes(repo.repoId)
                          ? current.filter((id) => id !== repo.repoId)
                          : [...current, repo.repoId],
                      )
                    }
                  />
                  <span className="min-w-0 truncate font-mono">{repoPath(repo)}</span>
                </Text>
              ))}
            </div>
            <Flex justify="end" mt="2">
              <Button
                type="submit"
                variant="solid"
                size={{ initial: "3", sm: "2" }}
                disabled={busy || statement.trim() === "" || repoIds.length < 2}
              >
                {busy ? "提交中…" : "记下"}
              </Button>
            </Flex>
          </form>
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
