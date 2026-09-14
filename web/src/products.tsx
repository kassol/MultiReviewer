import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Checkbox,
  Dialog,
  Flex,
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
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
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
  type Product,
  type ProductKnowledge,
  type ProductRepo,
  type ProductProposal,
} from "@/lib/products";
import { localMinute } from "@/lib/time";

import { fetchJson, send } from "./api.ts";
import { NameDialog, ProductRail, useProductDetail, useProductSessions } from "./product-rail.tsx";

/** 产品知识的陈述上限,与服务端那一道同一个数(`AGENT_STATEMENT_LIMIT`)。 */
const KNOWLEDGE_STATEMENT_MAX = 100;

/**
 * 产品页(CONTEXT.md 产品,issue #331)。左栏是产品页与会话页共用的那一份(`ProductRail`:
 * 产品列表、当前产品的仓库、我的会话),右栏是当前产品的概览与产品知识。当前产品写在地址上
 * (`/products/$productId`),从会话页回来选的还是同一个产品。
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
  /** 产品知识那一段表单的挂载标识:写成功一次就加一,表单因此重挂成空的。 */
  const [knowledgeFormKey, setKnowledgeFormKey] = useState(0);

  const productsQuery = useQuery({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: async () => (await fetchJson<{ products: Product[] }>("/products")).products,
  });

  const products = productsQuery.data ?? [];
  const selected = currentProduct(products, productId);
  const loadError = productsQuery.error;
  // 当前产品下「我的会话」。会话只属于创建者,可见多少由服务端按创建者给出。
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
        <CardShell className="min-w-0 gap-1 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 className="min-w-0 break-all text-2xl font-bold tracking-[-0.015em]">
              {selected.name}
            </h2>
            {canWrite ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="soft"
                  color="gray"
                  size={{ initial: "3", sm: "2" }}
                  disabled={busy}
                  onClick={() => openDialog("rename")}
                >
                  改名
                </Button>
                <Button
                  variant="soft"
                  color="red"
                  size={{ initial: "3", sm: "2" }}
                  disabled={busy}
                  onClick={() => {
                    setFeedback(null);
                    setConfirming(true);
                  }}
                >
                  删除
                </Button>
              </div>
            ) : null}
          </div>
          {/* 一行元信息。产品知识那一份还没读到时省掉它的两个数,不用占位符冒充。 */}
          <p className="text-base text-text-muted">
            <span className="tabular-nums">{selected.repos.length}</span> 个仓库
            {knowledgeQuery.isPending ? null : (
              <>
                {" · "}
                <span className="tabular-nums">{knowledge.length}</span> 条产品知识
                {" · "}
                <span className={proposals.length > 0 ? "font-semibold text-warning" : undefined}>
                  <span className="tabular-nums">{proposals.length}</span> 条待确认提案
                </span>
              </>
            )}
            {sessionsQuery.isPending ? null : (
              <>
                {" · "}
                <span className="tabular-nums">{sessions.length}</span> 个会话
              </>
            )}
            {" · "}建于 {localMinute(selected.createdAt)}
          </p>
        </CardShell>
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
            retireKnowledge.mutate({ product: selected, entry });
          }}
          onDecide={(entry, accept) => {
            setFeedback(null);
            decideProposal.mutate({ product: selected, entry, accept });
          }}
        />
      )}
    </>
  );

  return (
    <PageBody>
      <PageHeader title="产品" />
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
        <div className="flex min-w-0 flex-1 flex-col gap-3">
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
    return line === null ? null : (
      <Text as="span" size="1" color="gray" className="break-all font-mono">
        {line}
      </Text>
    );
  };

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
              <ExclamationTriangleIcon aria-hidden className="text-warning-icon" />
              待确认的提案
              <span className="font-mono text-xs font-normal text-text-muted tabular-nums">
                {proposals.length}
              </span>
            </h3>
            <ul>
              {proposals.map((entry) => {
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
                          variant="soft"
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
