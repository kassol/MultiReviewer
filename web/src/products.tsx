import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import {
  Callout,
  Dialog,
  Flex,
  IconButton,
  Select,
  Skeleton,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { RailCard } from "@/components/rail-card";
import { Button } from "@/components/theme-button";
import { unassignedRepos } from "@/lib/products";

import {
  CreateSessionDialog,
  SessionRail,
  sessionsQueryKey,
  useProductSessions,
  type AgentSession,
  type AgentSessionPurpose,
} from "./agent-session.tsx";
import { fetchJson, send } from "./api.ts";

type ProductRepo = { repoId: number; owner: string; repo: string };
type Product = { id: number; name: string; createdAt: string; repos: ProductRepo[] };
/** `GET /repos` 那一份里归属弹窗要的三列。它已经按仓库分配收窄过。 */
type RegisteredRepo = { repoId: number; owner: string; repo: string };

const PRODUCTS_QUERY_KEY = ["products"] as const;

function repoPath(row: ProductRepo | RegisteredRepo): string {
  return `${row.owner}/${row.repo}`;
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
}: {
  canWrite: boolean;
  canChat: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [dialog, setDialog] = useState<"create" | "rename" | "attach" | "session" | null>(null);
  const [confirming, setConfirming] = useState(false);

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

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });

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
    mutationFn: (input: { product: Product; repo: RegisteredRepo }) =>
      send(`/products/${input.product.id}/repos/${input.repo.repoId}`, "PUT"),
    onSuccess: (_value, { product, repo }) =>
      settled(`已把 ${repoPath(repo)} 归入 ${product.name}。`),
    onError: failed,
  });

  const detach = useMutation({
    mutationFn: (input: { product: Product; repo: ProductRepo }) =>
      send(`/products/${input.product.id}/repos/${input.repo.repoId}`, "DELETE"),
    onSuccess: (_value, { repo }) => settled(`已把 ${repoPath(repo)} 移出产品。`),
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
    detach.isPending ||
    remove.isPending;

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
            className="flex w-full shrink-0 flex-col gap-2.5 lg:w-[272px]"
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
                        className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5"
                      >
                        <span className="min-w-0 break-all font-mono text-base">
                          {repoPath(repo)}
                        </span>
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
                              detach.mutate({ product: selected, repo });
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
              <CardShell className="min-w-0 px-5 py-4">
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
                {sessions.length > 0 ? null : (
                  <EmptyState
                    title="这个产品还没有 Agent 会话"
                    description={
                      canChat
                        ? "在左栏「我的会话」里建一个会话,选定用途后就能和 agent 对话。"
                        : "建会话要「会话对话」权限。请联系系统管理员为该账号的角色勾上它。"
                    }
                    {...(canChat
                      ? {
                          action: (
                            <Button
                              variant="solid"
                              size="2"
                              disabled={busy}
                              onClick={() => openDialog("session")}
                            >
                              <PlusIcon aria-hidden />
                              建会话
                            </Button>
                          ),
                        }
                      : {})}
                  />
                )}
              </CardShell>
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
            onSubmit={(repo) => {
              setFeedback(null);
              attach.mutate({ product: selected, repo });
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
  onSubmit: (repo: RegisteredRepo) => void;
}) {
  const [repoId, setRepoId] = useState<string>("");
  useEffect(() => {
    if (open) setRepoId("");
  }, [open]);

  const chosen = repos.find((row) => String(row.repoId) === repoId);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (chosen !== undefined) onSubmit(chosen);
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
