import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  Pencil1Icon,
  PlusIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Checkbox,
  Dialog,
  Flex,
  IconButton,
  Select,
  Skeleton,
  Text,
  TextArea,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { RailCard } from "@/components/rail-card";
import { Button } from "@/components/theme-button";
import { unassignedRepos } from "@/lib/products";
import { localMinute } from "@/lib/time";

import {
  CreateSessionDialog,
  SessionRail,
  sessionsQueryKey,
  useProductSessions,
  type AgentSession,
  type AgentSessionPurpose,
} from "./agent-session.tsx";
import { fetchJson, send } from "./api.ts";

/** `role` 是仓库职责(CONTEXT.md 仓库职责,issue #341)。没写过即 null。 */
type ProductRepo = { repoId: number; owner: string; repo: string; role: string | null };
type Product = { id: number; name: string; createdAt: string; repos: ProductRepo[] };
/** `GET /repos` 那一份里归属弹窗要的三列。它已经按仓库分配收窄过。 */
type RegisteredRepo = { repoId: number; owner: string; repo: string };
/** 一条生效的产品知识(CONTEXT.md 产品知识,issue #343)。`repoIds` 是它涉及的仓库集合。 */
type ProductKnowledge = { id: number; statement: string; repoIds: number[] };
/**
 * 一条待确认的提案(CONTEXT.md 产品知识,issue #345、#346)。`retiresId` 不为空即退役提案,
 * 那一条的陈述是退役的理由,确认它退役的是它指向的那条生效条目。
 */
type ProductProposal = ProductKnowledge & { retiresId: number | null };

const PRODUCTS_QUERY_KEY = ["products"] as const;

/** 一个产品的产品知识那一份读缓存的键。产品换了就是另一份。 */
function knowledgeQueryKey(productId: number | undefined): readonly unknown[] {
  return ["product-knowledge", productId];
}

/** 产品知识的陈述上限,与服务端那一道同一个数(`AGENT_STATEMENT_LIMIT`)。 */
const KNOWLEDGE_STATEMENT_MAX = 100;

function repoPath(row: ProductRepo | RegisteredRepo): string {
  return `${row.owner}/${row.repo}`;
}

/** 移出确认框的说明:涉及这个仓库的产品知识会退役(issue #347),条数按生效列表算。 */
function detachConsequence(repo: ProductRepo | null, knowledge: readonly ProductKnowledge[]): string {
  const retiring =
    repo === null ? 0 : knowledge.filter((entry) => entry.repoIds.includes(repo.repoId)).length;
  const tail = "仓库集变了,系统可能自动开一场产品梳理。仓库本身留在注册表里。";
  return retiring === 0 ? tail : `涉及它的 ${retiring} 条产品知识会退役,不可恢复。${tail}`;
}

/**
 * 产品页(CONTEXT.md 产品,issue #331)。左栏按原型 A 的三段:产品列表、当前产品的仓库、
 * 我的会话;「建产品」「归属仓库」与每行的「移出」、改名、删除都按 `repo:write` 显隐。
 *
 * 可见的产品由服务端按仓库分配给出(ADR 0018),前端不自己判:一个仓库都没分到的人
 * 拿到的是空列表,落在「还没有产品」那一档空态上。
 */
export function ProductsPage({
  canWrite,
  canChat,
  canWriteKnowledge,
}: {
  canWrite: boolean;
  canChat: boolean;
  canWriteKnowledge: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [dialog, setDialog] = useState<"create" | "rename" | "attach" | "session" | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** 正要移出的仓库:移出会退役涉及它的产品知识,先过一道确认。 */
  const [detaching, setDetaching] = useState<ProductRepo | null>(null);
  /** 产品知识那一段表单的挂载标识:写成功一次就加一,表单因此重挂成空的。 */
  const [knowledgeFormKey, setKnowledgeFormKey] = useState(0);

  const productsQuery = useQuery({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: async () => (await fetchJson<{ products: Product[] }>("/products")).products,
  });
  // 归属弹窗的候选只在有写权限时才读:没有这一格的人看不到那个按钮。
  const reposQuery = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RegisteredRepo[]>("/repos"),
    enabled: canWrite,
  });

  const products = productsQuery.data ?? [];
  const selected = products.find((row) => row.id === selectedId) ?? products[0];
  const loadError = productsQuery.error;
  // 当前产品下「我的会话」。会话只属于创建者,可见多少由服务端按创建者给出。
  const sessionsQuery = useProductSessions(selected?.id);
  const sessions = sessionsQuery.data ?? [];

  // 当前产品生效的产品知识(CONTEXT.md 产品知识,issue #343)。产品列表那一份不带它,
  // 因此另读一次产品详情;读不需要权限格,谁看得到产品就看得到这一段。
  const knowledgeQuery = useQuery({
    queryKey: knowledgeQueryKey(selected?.id),
    queryFn: () =>
      fetchJson<{ knowledge: ProductKnowledge[]; proposals: ProductProposal[] }>(
        `/products/${selected!.id}`,
      ),
    enabled: selected !== undefined,
  });
  const knowledge = knowledgeQuery.data?.knowledge ?? [];
  const proposals = knowledgeQuery.data?.proposals ?? [];

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
  const refreshKnowledge = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: knowledgeQueryKey(selected?.id) });

  /** 改名、归属与移出共用的成功收尾:关弹窗、报一句、重读列表。 */
  const settled = (text: string): void => {
    setDialog(null);
    setFeedback({ text, error: false });
    void refresh();
  };
  const failed = (error: Error): void => setFeedback({ text: error.message, error: true });

  const create = useMutation({
    mutationFn: (name: string) => send<{ product: Product }>("/products", "POST", { name }),
    onSuccess: ({ product }) => {
      setDialog(null);
      // 新建的产品立刻成为当前项:下一步就是给它归属仓库,不让人再找一遍。
      setSelectedId(product.id);
      setFeedback({ text: `已建产品 ${product.name}。`, error: false });
      void refresh();
    },
    onError: failed,
  });

  const rename = useMutation({
    mutationFn: (input: { product: Product; name: string }) =>
      send(`/products/${input.product.id}`, "PUT", { name: input.name }),
    onSuccess: (_value, { name }) => settled(`已改名为 ${name}。`),
    onError: failed,
  });

  const attach = useMutation({
    mutationFn: (input: { product: Product; repo: RegisteredRepo; role: string }) =>
      send(`/products/${input.product.id}/repos/${input.repo.repoId}`, "PUT", {
        role: input.role,
      }),
    onSuccess: (_value, { product, repo }) => {
      settled(`已把 ${repoPath(repo)} 归入 ${product.name}。`);
      // 仓库集变了,系统可能自己开了一场梳理(issue #347):不重读会话列表,它要等下一次
      // 刷新才出现在左栏。
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(product.id) });
    },
    onError: failed,
  });

  /**
   * 改一行的仓库职责(CONTEXT.md 仓库职责,issue #341)。走的是归属那个端点:已经归属的
   * 那一次就是改职责,整格覆盖,空串即清掉。
   */
  const setRole = useMutation({
    mutationFn: (input: { product: Product; repo: ProductRepo; role: string }) =>
      send(`/products/${input.product.id}/repos/${input.repo.repoId}`, "PUT", {
        role: input.role,
      }),
    onSuccess: (_value, { repo, role }) =>
      settled(role === "" ? `已清掉 ${repoPath(repo)} 的职责。` : `已记下 ${repoPath(repo)} 的职责。`),
    onError: failed,
  });

  const detach = useMutation({
    mutationFn: (input: { product: Product; repo: ProductRepo }) =>
      send(`/products/${input.product.id}/repos/${input.repo.repoId}`, "DELETE"),
    onSuccess: (_value, { product, repo }) => {
      setDetaching(null);
      settled(`已把 ${repoPath(repo)} 移出产品。`);
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(product.id) });
      // 移出会退役涉及这个仓库的产品知识(issue #347),生效列表那一份缓存跟着重读。
      void queryClient.invalidateQueries({ queryKey: knowledgeQueryKey(product.id) });
    },
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (product: Product) =>
      send<{ cascade: { sessions: number } }>(`/products/${product.id}`, "DELETE"),
    onSuccess: (result, product) => {
      setConfirming(false);
      setSelectedId(null);
      setFeedback({
        text:
          result.cascade.sessions === 0
            ? `已删产品 ${product.name}。`
            : `已删产品 ${product.name},连同 ${result.cascade.sessions} 个 Agent 会话。`,
        error: false,
      });
      void refresh();
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
   */
  const survey = useMutation({
    mutationFn: (input: { product: Product }) =>
      send<{ session: AgentSession }>(`/products/${input.product.id}/survey`, "POST"),
    onSuccess: async ({ session }) => {
      setFeedback({ text: "已开一个产品梳理会话,它交出提案后在这里确认。", error: false });
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(session.productId) });
      void refreshKnowledge();
    },
    onError: failed,
  });

  /** 建会话。建完直接进那个会话:下一步就是在里面说话,不让人再点一次。 */
  const createSession = useMutation({
    mutationFn: (input: { product: Product; purpose: AgentSessionPurpose }) =>
      send<{ session: AgentSession }>(`/products/${input.product.id}/sessions`, "POST", {
        purpose: input.purpose,
      }),
    onSuccess: async ({ session }) => {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(session.productId) });
      void navigate({
        to: "/products/$productId/sessions/$sessionId",
        params: { productId: String(session.productId), sessionId: String(session.id) },
      });
    },
    onError: failed,
  });

  const busy =
    create.isPending ||
    rename.isPending ||
    attach.isPending ||
    setRole.isPending ||
    detach.isPending ||
    remove.isPending ||
    writeKnowledge.isPending ||
    retireKnowledge.isPending ||
    decideProposal.isPending ||
    survey.isPending;

  /** 还没归入任何产品、且在这个账号分配内的仓库。归入第二个产品服务端会回 409。 */
  const attachable = unassignedRepos(reposQuery.data ?? [], products);

  function openDialog(next: "create" | "rename" | "attach" | "session"): void {
    setFeedback(null);
    create.reset();
    rename.reset();
    attach.reset();
    createSession.reset();
    setDialog(next);
  }

  return (
    <PageBody>
      <PageHeader
        title="产品"
        actions={
          canWrite ? (
            <Button
              variant="solid"
              size={{ initial: "4", sm: "2" }}
              onClick={() => openDialog("create")}
            >
              <PlusIcon aria-hidden />
              建产品
            </Button>
          ) : undefined
        }
      />
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
                ? "把已注册的仓库归到一个产品下,Agent 会话就挂在它上面。"
                : "产品的可见范围由仓库分配决定。请联系系统管理员为该账号分配负责的仓库。"
            }
            {...(canWrite
              ? {
                  action: (
                    <Button variant="solid" size="2" onClick={() => openDialog("create")}>
                      <PlusIcon aria-hidden />
                      建产品
                    </Button>
                  ),
                }
              : {})}
          />
        </CardShell>
      ) : (
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:gap-[18px]">
          <aside
            aria-label="产品"
            className="flex w-full shrink-0 flex-col gap-2.5 lg:w-[264px]"
          >
            <RailCard title="产品" count={products.length}>
              <ul>
                {products.map((product) => (
                  <li key={product.id} className="border-t border-line first:border-t-0">
                    <MasterListItem
                      selected={selected?.id === product.id}
                      className="block px-4 py-3 data-[selected=false]:font-medium"
                      onClick={() => setSelectedId(product.id)}
                    >
                      <span className="block break-all text-lg">{product.name}</span>
                      <MasterListItemText className="mt-px block text-sm font-normal">
                        <span className="font-mono tabular-nums">{product.repos.length}</span> 个仓库
                      </MasterListItemText>
                    </MasterListItem>
                  </li>
                ))}
              </ul>
            </RailCard>

            {selected === undefined ? null : (
              <RailCard
                title={`${selected.name} 的仓库`}
                action={
                  canWrite ? (
                    <Button
                      variant="soft"
                      color="gray"
                      size="1"
                      disabled={busy}
                      onClick={() => openDialog("attach")}
                    >
                      归属仓库
                    </Button>
                  ) : undefined
                }
              >
                {selected.repos.length === 0 ? (
                  <Text as="p" size="2" color="gray" className="px-4 pb-3">
                    还没有归入仓库。
                  </Text>
                ) : (
                  <ul>
                    {selected.repos.map((repo) => (
                      <li
                        key={repo.repoId}
                        className="flex items-start justify-between gap-2 border-t border-line px-4 py-2.5"
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="min-w-0 break-all font-mono text-base">
                            {repoPath(repo)}
                          </span>
                          {canWrite ? (
                            <RoleField
                              repo={repo}
                              busy={busy}
                              onSave={(role) => {
                                setFeedback(null);
                                setRole.mutate({ product: selected, repo, role });
                              }}
                            />
                          ) : repo.role === null ? null : (
                            <Text as="span" size="1" color="gray" className="break-all">
                              {repo.role}
                            </Text>
                          )}
                        </div>
                        {canWrite ? (
                          <IconButton
                            variant="ghost"
                            color="gray"
                            size={{ initial: "3", sm: "1" }}
                            className="shrink-0 max-sm:min-h-11 max-sm:min-w-11"
                            aria-label={`把 ${repoPath(repo)} 移出 ${selected.name}`}
                            disabled={busy}
                            onClick={() => {
                              setFeedback(null);
                              setDetaching(repo);
                            }}
                          >
                            <Cross2Icon aria-hidden />
                          </IconButton>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </RailCard>
            )}

            {selected === undefined ? null : (
              <SessionRail
                productId={selected.id}
                sessions={sessions}
                pending={sessionsQuery.isPending}
                canChat={canChat}
                onCreate={() => openDialog("session")}
              />
            )}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
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
                onSurvey={() => {
                  setFeedback(null);
                  survey.mutate({ product: selected });
                }}
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
          </div>
        </div>
      )}

      <NameDialog
        open={dialog === "create"}
        title="建产品"
        description="产品是若干已注册仓库的命名集合,名称不可重复。"
        label="产品名"
        submitLabel="创建"
        busy={create.isPending}
        onClose={() => setDialog(null)}
        onSubmit={(name) => {
          setFeedback(null);
          create.mutate(name);
        }}
      />
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
          <AttachDialog
            open={dialog === "attach"}
            product={selected}
            repos={attachable}
            busy={attach.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(repo, role) => {
              setFeedback(null);
              attach.mutate({ product: selected, repo, role });
            }}
          />
          <CreateSessionDialog
            open={dialog === "session"}
            productName={selected.name}
            busy={createSession.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(purpose) => {
              setFeedback(null);
              createSession.mutate({ product: selected, purpose });
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
            open={detaching !== null}
            onOpenChange={(open) => {
              if (!open) setDetaching(null);
            }}
            title={detaching === null ? "" : `把 ${repoPath(detaching)} 移出 ${selected.name}?`}
            titleSize="4"
            description={detachConsequence(detaching, knowledge)}
            cancelLabel="取消"
            cancelVariant="outline"
            cancelDisabled={detach.isPending}
            confirm={{
              label: detach.isPending ? "移出中…" : "移出",
              color: "red",
              disabled: detach.isPending || detaching === null,
              onClick: () => {
                if (detaching === null) return;
                setFeedback(null);
                detach.mutate({ product: selected, repo: detaching });
              },
            }}
          />
        </>
      )}
    </PageBody>
  );
}

/** 建产品与改名共用的一格文本弹窗。关闭即清空,下次打开不带上一次的残值。 */
function NameDialog({
  open,
  title,
  description,
  label,
  submitLabel,
  initial = "",
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  initial?: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(name.trim());
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content maxWidth="440px" size={{ initial: "2", sm: "3" }}>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          <div>
            <Dialog.Title size="4" mb="2">
              {title}
            </Dialog.Title>
            <Dialog.Description size="2" color="gray">
              {description}
            </Dialog.Description>
          </div>
          <div className="flex flex-col gap-1.5">
            <Text as="label" htmlFor="product-name" size="2" weight="medium">
              {label}
            </Text>
            <TextField.Root
              id="product-name"
              size={{ initial: "3", sm: "2" }}
              className="min-w-0 w-full max-sm:min-h-11"
              autoFocus
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Flex gap="3" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <Dialog.Close>
              <Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
                取消
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              variant="solid"
              size={{ initial: "4", sm: "2" }}
              disabled={busy || name.trim() === ""}
            >
              {busy ? "提交中…" : submitLabel}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * 一行仓库的职责(CONTEXT.md 仓库职责,issue #341)。平时是一段可换行的文本,点它进编辑:
 * Enter 或失焦保存并退出,Escape 放回原值并退出;与库里那一份相同时一律不发请求,失焦不该
 * 变成一次空写。
 */
function RoleField({
  repo,
  busy,
  onSave,
}: {
  repo: ProductRepo;
  busy: boolean;
  onSave: (role: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(repo.role ?? "");
  useEffect(() => setText(repo.role ?? ""), [repo.role]);
  // Escape 之后输入框卸载,浏览器可能还补一次 blur;那一次不能把改了一半的文字存下去。
  const cancelled = useRef(false);
  // 职责最长 64 字,264px 的栏里一行装不下;编辑框随内容长高,不让开头滚出视野。
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.overflow = "hidden";
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={`改 ${repoPath(repo)} 的职责`}
        disabled={busy}
        onClick={() => setEditing(true)}
        className="-mx-1 flex min-w-0 items-start gap-1 rounded-sm px-1 py-0.5 text-left text-base transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 max-sm:min-h-11"
      >
        <span className={repo.role === null ? "min-w-0 break-words text-text-disabled" : "min-w-0 break-words"}>
          {repo.role ?? "填写职责"}
        </span>
        <Pencil1Icon aria-hidden className="mt-0.5 shrink-0 text-text-faint" />
      </button>
    );
  }

  const finish = (): void => {
    setEditing(false);
    if (cancelled.current) return;
    if (text.trim() !== (repo.role ?? "")) onSave(text.trim());
  };

  return (
    <TextArea
      ref={area}
      size="1"
      rows={1}
      resize="none"
      className="min-h-0 min-w-0 w-full"
      aria-label={`${repoPath(repo)} 的职责`}
      placeholder="职责(选填)"
      maxLength={64}
      autoFocus
      disabled={busy}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => {
        cancelled.current = false;
      }}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // 职责是一行文本,回车即保存,不进换行。
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelled.current = true;
          setText(repo.role ?? "");
          setEditing(false);
        }
      }}
    />
  );
}

/** 归属仓库:候选只有还没归入任何产品的那些,一仓库至多属一个产品。 */
function AttachDialog({
  open,
  product,
  repos,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  product: Product;
  repos: readonly RegisteredRepo[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (repo: RegisteredRepo, role: string) => void;
}) {
  const [repoId, setRepoId] = useState<string>("");
  const [role, setRole] = useState("");
  useEffect(() => {
    if (open) {
      setRepoId("");
      setRole("");
    }
  }, [open]);

  const chosen = repos.find((row) => String(row.repoId) === repoId);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (chosen !== undefined) onSubmit(chosen, role.trim());
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content maxWidth="440px" size={{ initial: "2", sm: "3" }}>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          <div>
            <Dialog.Title size="4" mb="2">
              归属仓库
            </Dialog.Title>
            <Dialog.Description size="2" color="gray">
              把一个已注册仓库归入 {product.name}。一个仓库至多属于一个产品。
            </Dialog.Description>
          </div>
          {repos.length === 0 ? (
            <Text as="p" size="2" color="gray">
              没有可归入的仓库:分配内的仓库都已经归在某个产品下了。
            </Text>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Text as="span" id="attach-repo-label" size="2" weight="medium">
                仓库
              </Text>
              <Select.Root size="3" value={repoId} onValueChange={setRepoId}>
                <Select.Trigger
                  aria-labelledby="attach-repo-label"
                  placeholder="选一个仓库"
                  className="min-w-0 w-full"
                />
                <Select.Content position="popper">
                  {repos.map((row) => (
                    <Select.Item key={row.repoId} value={String(row.repoId)}>
                      {repoPath(row)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <Text as="label" htmlFor="attach-repo-role" size="2" weight="medium" mt="2">
                职责
              </Text>
              <TextField.Root
                id="attach-repo-role"
                size={{ initial: "3", sm: "2" }}
                className="min-w-0 w-full max-sm:min-h-11"
                placeholder="选填,例如:后端 API(Node)"
                maxLength={64}
                value={role}
                onChange={(event) => setRole(event.target.value)}
              />
              <Text as="p" size="1" color="gray">
                这个仓库在这个产品里干什么。Agent 会话的系统提示会把它写给 agent。
              </Text>
            </div>
          )}
          <Flex gap="3" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <Dialog.Close>
              <Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
                取消
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              variant="solid"
              size={{ initial: "4", sm: "2" }}
              disabled={busy || chosen === undefined}
            >
              {busy ? "归属中…" : "归属"}
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
            <div
              role="group"
              aria-labelledby="product-knowledge-repos"
              className="flex flex-col gap-0.5 rounded-lg border border-line p-1.5"
            >
              {product.repos.map((repo) => (
                <Text
                  as="label"
                  key={repo.repoId}
                  size="2"
                  className="flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 max-sm:min-h-11 hover:bg-sunken has-disabled:cursor-not-allowed has-disabled:opacity-70"
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
