import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cross2Icon, Pencil1Icon, PlusIcon } from "@radix-ui/react-icons";
import {
  Dialog,
  Flex,
  IconButton,
  Select,
  Skeleton,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { RailCard } from "@/components/rail-card";
import {
  baselineRepoKey,
  pickedBaselines,
  RepoBaselineRows,
  type BaselineRepo,
  type SessionBaseline,
} from "@/components/repo-baseline-rows";
import { Button } from "@/components/theme-button";
import type { CommitSelection } from "@/commit-picker";
import {
  AGENT_SESSION_PURPOSES,
  PURPOSE_LABEL,
  sessionsQueryKey,
  type AgentSession,
  type AgentSessionPurpose,
} from "@/lib/agent-sessions";
import {
  currentProduct,
  PRODUCTS_QUERY_KEY,
  productQueryKey,
  repoPath,
  unassignedRepos,
  type Product,
  type ProductDetail,
  type ProductKnowledge,
  type ProductRepo,
  type RegisteredRepo,
} from "@/lib/products";
import { localMinute } from "@/lib/time";
import { cn } from "@/lib/utils";

import { fetchJson, send } from "./api.ts";

/**
 * 建会话弹窗提供的用途(issue #345)。产品梳理不在这一份里:那一种只有系统开得了,人点的是
 * 产品页产品知识区里的「重梳」。
 */
const CREATABLE_PURPOSES = AGENT_SESSION_PURPOSES.filter(
  (purpose) => purpose !== "product-survey",
);

/** 建会话时默认选中的用途:现有行为的延续。 */
const DEFAULT_PURPOSE: AgentSessionPurpose = "requirement-breakdown";

export function useProductSessions(productId: number | undefined) {
  return useQuery({
    queryKey: sessionsQueryKey(productId ?? 0),
    queryFn: async () =>
      (await fetchJson<{ sessions: AgentSession[] }>(`/products/${productId!}/sessions`)).sessions,
    enabled: productId !== undefined,
  });
}

/** 产品页右栏与会话页头部共用的产品详情。知识与提案也在这一份里。 */
export function useProductDetail(productId: number | undefined) {
  return useQuery({
    queryKey: productQueryKey(productId),
    queryFn: () => fetchJson<ProductDetail>(`/products/${productId!}`),
    enabled: productId !== undefined,
  });
}

/** 移出确认框的说明:涉及这个仓库的产品知识会退役(issue #347),条数按生效列表算。 */
function detachConsequence(repo: ProductRepo | null, knowledge: readonly ProductKnowledge[]): string {
  const retiring =
    repo === null ? 0 : knowledge.filter((entry) => entry.repoIds.includes(repo.repoId)).length;
  const tail = "仓库集变了,系统可能自动开一场产品梳理。仓库本身留在注册表里。";
  return retiring === 0 ? tail : `涉及它的 ${retiring} 条产品知识会退役,不可恢复。${tail}`;
}

/**
 * 产品页与会话页共用的左栏(spec #349 的收口):产品列表、当前产品的仓库、会话。两页
 * 同一个组件、同一个 264px 宽、同一套卡片与选中态——跳过去只换主区,不像换了个应用。
 *
 * 当前产品写在地址上(`/products/$productId` 与会话页路径的第一段),因此从会话页回产品页
 * 选的还是同一个产品。左栏自己读产品、仓库与会话三份查询,调用页读的是同一批缓存键。
 *
 * 写动作四个:「建产品」按 `repo:write`(产品卡)、「归属仓库」与每行的移出、改职责按
 * `repo:write`(仓库卡)、「建会话」按 `agent:chat`(会话卡)。回执交给调用页顶部那条
 * Callout——两页各有一条,左栏不再自带第三种报法。
 */
export function ProductRail({
  productId,
  activeSessionId,
  canWrite,
  canChat,
  busy = false,
  className,
  onFeedback,
}: {
  /** 地址上的产品。`undefined` 即地址没带(`/products`),落在列表第一个上。 */
  productId?: number | undefined;
  /** 会话页当前这个会话,「会话」里高亮它。 */
  activeSessionId?: number | undefined;
  canWrite: boolean;
  canChat: boolean;
  /** 调用页自己的写动作也让左栏的按钮一起置灰。 */
  busy?: boolean;
  className?: string;
  /** 回执交给调用页那条 Callout;`null` 即动手前先把上一条清掉。 */
  onFeedback: (feedback: { text: string; error: boolean } | null) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"create" | "attach" | "session" | null>(null);
  /** 正要移出的仓库:移出会退役涉及它的产品知识,先过一道确认。 */
  const [detaching, setDetaching] = useState<ProductRepo | null>(null);

  const productsQuery = useQuery({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: async () => (await fetchJson<{ products: Product[] }>("/products")).products,
  });
  const products = productsQuery.data ?? [];
  const current = currentProduct(products, productId);
  // 归属弹窗的候选只在有写权限时才读:没有这一格的人看不到那个按钮。
  const reposQuery = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RegisteredRepo[]>("/repos"),
    enabled: canWrite,
  });
  const sessionsQuery = useProductSessions(current?.id);
  const sessions = sessionsQuery.data ?? [];
  // 移出那句话要数涉及这个仓库的产品知识,读的是产品详情那一份(与产品页右栏同一个缓存键)。
  const knowledge = useProductDetail(current?.id).data?.knowledge ?? [];

  /**
   * 重读产品列表。详情与会话列表的缓存键排在它之下,一次失效三份都跟着重读——仓库集一变,
   * 知识与会话都可能不是原来那一份了。
   */
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });

  /** 归属、改职责与移出共用的成功收尾:关弹窗、报一句、重读。 */
  const settled = (text: string): void => {
    setDialog(null);
    onFeedback({ text, error: false });
    void refresh();
  };
  const failed = (error: Error): void => onFeedback({ text: error.message, error: true });

  const create = useMutation({
    mutationFn: (name: string) => send<{ product: Product }>("/products", "POST", { name }),
    onSuccess: async ({ product }) => {
      setDialog(null);
      onFeedback({ text: `已建产品 ${product.name}。`, error: false });
      await refresh();
      // 新建的产品立刻成为当前项:下一步就是给它归属仓库,不让人再找一遍。
      void navigate({ to: "/products/$productId", params: { productId: String(product.id) } });
    },
    onError: failed,
  });

  const attach = useMutation({
    mutationFn: (input: { product: Product; repo: RegisteredRepo; role: string }) =>
      send(`/products/${input.product.id}/repos/${input.repo.repoId}`, "PUT", {
        role: input.role,
      }),
    onSuccess: (_value, { product, repo }) =>
      settled(`已把 ${repoPath(repo)} 归入 ${product.name}。`),
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
    onSuccess: (_value, { repo }) => {
      setDetaching(null);
      settled(`已把 ${repoPath(repo)} 移出产品。`);
    },
    onError: failed,
  });

  /** 建会话。建完直接进那个会话:下一步就是在里面说话,不让人再点一次。 */
  const createSession = useMutation({
    mutationFn: (input: {
      product: Product;
      purpose: AgentSessionPurpose;
      /** 人在弹窗里动过的那几行(issue #352);没动过的仓库由服务端回落。 */
      baselines: SessionBaseline[];
    }) =>
      send<{ session: AgentSession }>(`/products/${input.product.id}/sessions`, "POST", {
        purpose: input.purpose,
        ...(input.baselines.length === 0 ? {} : { baselines: input.baselines }),
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

  const working =
    busy ||
    create.isPending ||
    attach.isPending ||
    setRole.isPending ||
    detach.isPending ||
    createSession.isPending;

  /** 还没归入任何产品、且在这个账号分配内的仓库。归入第二个产品服务端会回 409。 */
  const attachable = unassignedRepos(reposQuery.data ?? [], products);

  /**
   * 建会话弹窗里要列出基点的仓库(issue #352):这个产品的仓库 ∩ 这个账号的仓库分配——与服务端
   * 给 agent 的那一份同律,`GET /repos` 已经按分配收窄过。分配外的仓库连行都不出现:它的提交
   * 这个会话读不到。
   */
  const assignedRepoIds = new Set((reposQuery.data ?? []).map((row) => row.repoId));
  const sessionRepos = (current?.repos ?? []).filter((repo) =>
    assignedRepoIds.has(repo.repoId));

  function openDialog(next: "create" | "attach" | "session"): void {
    onFeedback(null);
    create.reset();
    attach.reset();
    createSession.reset();
    setDialog(next);
  }

  return (
    <>
      {/*
        `lg` 以下这个 `aside` 让出自己的盒子(`contents`),三张卡因此与调用页的主列成为同一个
        flex 容器的直接子项,由各自的 `max-lg:order-*` 排成 产品列表 → 主列 → 仓库 → 会话
        ——手机上先选产品、再看它是什么,仓库与会话排在后面。`lg` 起它恢复成 264px 的一列。
      */}
      <aside
        aria-label="产品、仓库与会话"
        className={cn("flex w-full shrink-0 flex-col gap-2.5 max-lg:contents lg:w-[264px]", className)}
      >
        <div className="min-w-0 max-lg:order-1">
        <RailCard
          title="产品"
          {...(productsQuery.isPending ? {} : { count: products.length })}
          action={
            canWrite ? (
              <Button
                variant="soft"
                color="gray"
                size="1"
                disabled={working}
                onClick={() => openDialog("create")}
              >
                <PlusIcon aria-hidden />
                建产品
              </Button>
            ) : undefined
          }
        >
          {productsQuery.isPending ? (
            <Skeleton aria-hidden className="mx-4 mb-3 h-10" />
          ) : products.length === 0 ? (
            <Text as="p" size="2" color="gray" className="px-4 pb-3">
              还没有产品。
            </Text>
          ) : (
            <ul>
              {products.map((product) => (
                <li key={product.id} className="border-t border-line first:border-t-0">
                  <MasterListItem
                    asChild
                    selected={current?.id === product.id}
                    className="block px-4 py-3 data-[selected=false]:font-medium"
                  >
                    <Link to="/products/$productId" params={{ productId: String(product.id) }}>
                      <span className="block break-all text-lg">{product.name}</span>
                      <MasterListItemText className="mt-px block text-sm font-normal">
                        <span className="font-mono tabular-nums">{product.repos.length}</span> 个仓库
                      </MasterListItemText>
                    </Link>
                  </MasterListItem>
                </li>
              ))}
            </ul>
          )}
        </RailCard>
        </div>

        {current === undefined ? null : (
          <>
            <div className="min-w-0 max-lg:order-3">
            <RailCard
              title={`${current.name} 的仓库`}
              action={
                canWrite ? (
                  <Button
                    variant="soft"
                    color="gray"
                    size="1"
                    disabled={working}
                    onClick={() => openDialog("attach")}
                  >
                    归属仓库
                  </Button>
                ) : undefined
              }
            >
              {current.repos.length === 0 ? (
                <Text as="p" size="2" color="gray" className="px-4 pb-3">
                  还没有归入仓库。
                </Text>
              ) : (
                <ul>
                  {current.repos.map((repo) => (
                    <li
                      key={repo.repoId}
                      className="group/repo flex items-start justify-between gap-2 border-t border-line px-4 py-2.5"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="min-w-0 break-all font-mono text-base">
                          {repoPath(repo)}
                        </span>
                        {canWrite ? (
                          <RoleField
                            repo={repo}
                            busy={working}
                            onSave={(role) => {
                              onFeedback(null);
                              setRole.mutate({ product: current, repo, role });
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
                          className="shrink-0 max-sm:min-h-11 max-sm:min-w-11 transition-opacity md:opacity-0 md:group-hover/repo:opacity-100 md:group-focus-within/repo:opacity-100 md:focus-visible:opacity-100"
                          aria-label={`把 ${repoPath(repo)} 移出 ${current.name}`}
                          disabled={working}
                          onClick={() => {
                            onFeedback(null);
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
            </div>

            <div className="min-w-0 max-lg:order-4">
            <SessionRail
              productId={current.id}
              sessions={sessions}
              pending={sessionsQuery.isPending}
              {...(activeSessionId === undefined ? {} : { activeSessionId })}
              canChat={canChat}
              busy={working}
              onCreate={() => openDialog("session")}
            />
            </div>
          </>
        )}
      </aside>

      <NameDialog
        open={dialog === "create"}
        title="建产品"
        description="产品是若干已注册仓库的命名集合,名称不可重复。"
        label="产品名"
        submitLabel="创建"
        busy={create.isPending}
        onClose={() => setDialog(null)}
        onSubmit={(name) => create.mutate(name)}
      />
      {current === undefined ? null : (
        <>
          <AttachDialog
            open={dialog === "attach"}
            product={current}
            repos={attachable}
            busy={attach.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(repo, role) => attach.mutate({ product: current, repo, role })}
          />
          <CreateSessionDialog
            open={dialog === "session"}
            productName={current.name}
            repos={sessionRepos}
            busy={createSession.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(purpose, baselines) =>
              createSession.mutate({ product: current, purpose, baselines })}
          />
          <ConfirmDialog
            open={detaching !== null}
            onOpenChange={(open) => {
              if (!open) setDetaching(null);
            }}
            title={detaching === null ? "" : `把 ${repoPath(detaching)} 移出 ${current.name}?`}
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
                onFeedback(null);
                detach.mutate({ product: current, repo: detaching });
              },
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * 左栏的「会话」卡。列的是当前产品下的会话——多数账号看到的是自己的,系统管理员看到的是
 * 所有人的,由服务端按权限决定,前端不自己判;标题不写「我的」,因为对后者不成立。
 */
function SessionRail({
  productId,
  sessions,
  pending,
  activeSessionId,
  canChat,
  busy,
  onCreate,
}: {
  productId: number;
  sessions: readonly AgentSession[];
  pending: boolean;
  activeSessionId?: number;
  canChat: boolean;
  busy: boolean;
  onCreate: () => void;
}) {
  // 会话按最近活动降序排,刚说过话的会话浮上来,而不是固定按创建时间。sort 是稳定排序,
  // lastActiveAt 并列时落回服务端原有的 id desc 顺序。
  const sorted = [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return (
    <RailCard
      title="会话"
      {...(pending ? {} : { count: sessions.length })}
      action={
        canChat ? (
          <Button variant="soft" color="gray" size="1" disabled={busy} onClick={onCreate}>
            <PlusIcon aria-hidden />
            建会话
          </Button>
        ) : undefined
      }
    >
      {pending ? (
        <Skeleton aria-hidden className="mx-4 mb-3 h-10" />
      ) : sessions.length === 0 ? (
        <Text as="p" size="2" color="gray" className="px-4 pb-3">
          {canChat ? "还没有会话。" : "还没有会话。建会话要「会话对话」权限。"}
        </Text>
      ) : (
        <ul>
          {sorted.map((session) => (
            <li key={session.id} className="border-t border-line first:border-t-0">
              <MasterListItem
                asChild
                selected={session.id === activeSessionId}
                className="block px-4 py-2.5"
              >
                <Link
                  to="/products/$productId/sessions/$sessionId"
                  params={{ productId: String(productId), sessionId: String(session.id) }}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-base">
                      {session.title ?? PURPOSE_LABEL[session.purpose]}
                    </span>
                    {session.status === "running" ? (
                      <span
                        aria-label="在跑"
                        role="img"
                        className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse"
                      />
                    ) : null}
                  </span>
                  <MasterListItemText className="mt-px block truncate text-sm font-normal">
                    {session.title === null
                      ? `${localMinute(session.lastActiveAt)} · ${session.createdBy}`
                      : `${PURPOSE_LABEL[session.purpose]} · ${localMinute(session.lastActiveAt)} · ${session.createdBy}`}
                  </MasterListItemText>
                </Link>
              </MasterListItem>
            </li>
          ))}
        </ul>
      )}
    </RailCard>
  );
}

/** 建产品与改名共用的一格文本弹窗。关闭即清空,下次打开不带上一次的残值。 */
export function NameDialog({
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
        <Pencil1Icon
          aria-hidden
          className="mt-0.5 shrink-0 text-text-faint transition-opacity md:opacity-0 md:group-hover/repo:opacity-100 md:group-focus-within/repo:opacity-100"
        />
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
 * 建会话弹窗。用途建时必填、之后不变,所以它只在这里出现一次;下拉当前只有需求拆分与开放
 * 对话两项,仍是下拉而不是一句说明——写代码类用途接入时这里多一项就够。
 *
 * 用途之下是按仓库选基点的行组(issue #352):每个仓库一行,预选它生效的默认分支当前 head。
 * 只提交人动过的那几行——没动过的行由服务端回落到同一个 head,两侧说的是同一件事。
 */
function CreateSessionDialog({
  open,
  productName,
  repos,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  productName: string;
  /** 这个会话读得到的仓库:产品的仓库 ∩ 这个账号的仓库分配。 */
  repos: readonly BaselineRepo[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (purpose: AgentSessionPurpose, baselines: SessionBaseline[]) => void;
}) {
  const [purpose, setPurpose] = useState<string>(DEFAULT_PURPOSE);
  const [picked, setPicked] = useState<Record<string, CommitSelection>>({});
  useEffect(() => {
    if (open) {
      setPurpose(DEFAULT_PURPOSE);
      setPicked({});
    }
  }, [open]);

  const chosen = CREATABLE_PURPOSES.find((value) => value === purpose);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (chosen !== undefined) onSubmit(chosen, pickedBaselines(picked));
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
              建会话
            </Dialog.Title>
            <Dialog.Description size="2" color="gray">
              在 {productName} 下开一个 Agent 会话。用途决定它的工具面与产出类型,建后不可更改。
            </Dialog.Description>
          </div>
          <div className="flex flex-col gap-1.5">
            <Text as="span" id="session-purpose-label" size="2" weight="medium">
              会话用途
            </Text>
            <Select.Root size="3" value={purpose} onValueChange={setPurpose}>
              <Select.Trigger
                aria-labelledby="session-purpose-label"
                placeholder="选一个用途"
                className="min-w-0 w-full"
              />
              <Select.Content position="popper">
                {CREATABLE_PURPOSES.map((value) => (
                  <Select.Item key={value} value={value}>
                    {PURPOSE_LABEL[value]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>
          {repos.length === 0 ? null : (
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
              {busy ? "创建中…" : "创建"}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
