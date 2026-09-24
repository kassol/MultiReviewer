import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "@radix-ui/react-icons";
import {
  Dialog,
  Flex,
  Select,
  Skeleton,
  Text,
  TextField,
} from "@radix-ui/themes";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import type { Feedback } from "@/components/feedback-callout";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { RailCard } from "@/components/rail-card";
import {
  pickedBaselines,
  RepoBaselineRows,
  useBaselinePicks,
  type BaselineRepo,
  type SessionBaseline,
} from "@/components/repo-baseline-rows";
import { Button } from "@/components/theme-button";
import {
  AGENT_SESSION_PURPOSES,
  PURPOSE_LABEL,
  RAIL_SESSION_LIMIT,
  railSessions,
  sessionsQueryKey,
  sessionTitle,
  type AgentSession,
  type AgentSessionPurpose,
} from "@/lib/agent-sessions";
import {
  currentProduct,
  PRODUCTS_QUERY_KEY,
  repoPath,
  type Product,
  type RegisteredRepo,
} from "@/lib/products";
import { productDetailQuery, productListQuery, productSessionsQuery } from "@/lib/product-queries";
import { localMinute } from "@/lib/time";
import { cn } from "@/lib/utils";

import { fetchJson, send } from "./api.ts";

/**
 * 建会话弹窗提供的用途(issue #365)。产品梳理不在这一份里:那一种从产品页产品知识区里的
 * 「梳理」开,它还要判仓库数与有没有一场没谈完的。
 */
const CREATABLE_PURPOSES = AGENT_SESSION_PURPOSES.filter(
  (purpose) => purpose !== "product-survey",
);

/** 建会话时默认选中的用途:现有行为的延续。 */
const DEFAULT_PURPOSE: AgentSessionPurpose = "requirement-breakdown";

export function useProductSessions(productId: number | undefined) {
  return useQuery(productSessionsQuery(productId));
}

/** 产品页右栏与会话页头部共用的产品详情。产品知识也在这一份里。 */
export function useProductDetail(productId: number | undefined) {
  return useQuery(productDetailQuery(productId));
}

/**
 * 刚开起来的会话:先失效这个产品的会话列表,再跳进去——左栏那一行跳过去时就已经在。建会话与
 * 梳理共用这一段,两处都是「开了就进去说话」。
 */
export function useEnterSession(): (session: AgentSession) => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (session) => {
    await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(session.productId) });
    void navigate({
      to: "/products/$productId/sessions/$sessionId",
      params: { productId: String(session.productId), sessionId: String(session.id) },
    });
  };
}

/**
 * 产品页与会话页共用的左栏(spec #349 的收口):产品列表、当前产品的仓库、会话。两页
 * 同一个组件、同一个 264px 宽、同一套卡片与选中态——跳过去只换主区,不像换了个应用。
 *
 * 当前产品写在地址上(`/products/$productId` 与会话页路径的第一段),因此从会话页回产品页
 * 选的还是同一个产品。左栏自己读产品、仓库与会话三份查询,调用页读的是同一批缓存键。
 *
 * 写动作两个:「建产品」按 `repo:write`(产品卡)、「建会话」按 `agent:chat`(会话卡)。仓库卡
 * 只读(仓库名与职责):归入、改职责与移出改的是整个产品,在产品页页头「…」下的「管理仓库」里
 * 做,会话页上不出现。回执交给调用页顶部那条 Callout——两页各有一条,左栏不再自带第三种报法。
 */
export function ProductRail({
  productId,
  activeSessionId,
  canWrite,
  canChat,
  busy = false,
  className,
  onFeedback,
  onPending,
}: {
  /** 地址上的产品。`undefined` 即地址没带(`/products`),落在列表第一个上。 */
  productId?: number | undefined;
  /** 会话页当前这个会话,「会话」里高亮它。 */
  activeSessionId?: number | undefined;
  canWrite: boolean;
  canChat: boolean;
  /** 调用页自己的写动作在跑时,左栏的按钮一起置灰。 */
  busy?: boolean;
  className?: string;
  /** 回执交给调用页那条 Callout;`null` 即动手前先把上一条清掉。 */
  onFeedback: (feedback: Feedback | null) => void;
  /** 左栏自己的写动作在跑时报给调用页,调用页的写动作跟着置灰——两侧互相挡住,不并发写同一个产品。 */
  onPending?: (pending: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"create" | "session" | null>(null);

  const productsQuery = useQuery(productListQuery());
  const products = productsQuery.data ?? [];
  const current = currentProduct(products, productId);
  // 只为建会话弹窗的基点行而读:按它与产品的仓库求交(见下面 `sessionRepos`),建会话要 `agent:chat`。
  const reposQuery = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RegisteredRepo[]>("/repos"),
    enabled: canChat,
  });
  const sessionsQuery = useProductSessions(current?.id);
  const sessions = sessionsQuery.data ?? [];
  /**
   * 重读产品列表。详情与会话列表的缓存键排在它之下,一次失效三份都跟着重读——仓库集一变,
   * 知识与会话都可能不是原来那一份了。
   */
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });

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

  const enterSession = useEnterSession();
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
    onSuccess: ({ session }) => {
      setDialog(null);
      return enterSession(session);
    },
    onError: failed,
  });

  const pending = create.isPending || createSession.isPending;
  const working = busy || pending;
  // 只报自己的那几个:调用页的 `busy` 再报回去就绕成一个圈。
  useEffect(() => onPending?.(pending), [pending, onPending]);

  /**
   * 建会话弹窗里要列出基点的仓库(issue #352):这个产品的仓库 ∩ 这个账号的仓库分配——与服务端
   * 给 agent 的那一份同律,`GET /repos` 已经按分配收窄过。分配外的仓库连行都不出现:它的提交
   * 这个会话读不到。
   */
  const assignedRepoIds = new Set((reposQuery.data ?? []).map((row) => row.repoId));
  const sessionRepos = (current?.repos ?? []).filter((repo) =>
    assignedRepoIds.has(repo.repoId));

  function openDialog(next: "create" | "session"): void {
    onFeedback(null);
    create.reset();
    createSession.reset();
    setDialog(next);
  }

  return (
    <>
      {/*
        `lg` 以下这个 `aside` 让出自己的盒子(`contents`),三张卡因此与调用页的主列成为同一个
        flex 容器的直接子项,由各自的 `max-lg:order-*` 排成 产品列表 → 会话 → 仓库 → 主列
        ——手机上先选产品、再进会话(issue #383:会话是人在手机上要打开的那一样,概览与产品
        知识是读物,排在最后)。`lg` 起它恢复成 264px 的一列。
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
              // 与「产品」「会话」两张卡同一个卡头语法:名词加条数。卡紧贴在选中的产品下面,
              // 不必再把产品名拼进标题(中文名后面跟一个空格再接「的」读着别扭)。
              title="仓库"
              count={current.repos.length}
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
                      className="flex min-w-0 flex-col gap-0.5 border-t border-line px-4 py-2.5"
                    >
                      <span className="min-w-0 break-all font-mono text-base">{repoPath(repo)}</span>
                      {repo.role === null ? null : (
                        <Text as="span" size="1" color="gray" className="break-words">
                          {repo.role}
                        </Text>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </RailCard>
            </div>

            <div className="min-w-0 max-lg:order-2">
            <SessionRail
              // 换产品时收回去:展开是看这一个产品的全部会话,不该带到下一个产品上。
              key={current.id}
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
        description="产品是若干已注册仓库的命名集合，名称不可重复。"
        label="产品名"
        submitLabel="创建"
        busy={create.isPending}
        onClose={() => setDialog(null)}
        onSubmit={(name) => create.mutate(name)}
      />
      {current === undefined ? null : (
        <>
          <CreateSessionDialog
            open={dialog === "session"}
            productName={current.name}
            repos={sessionRepos}
            busy={createSession.isPending}
            onClose={() => setDialog(null)}
            onSubmit={(purpose, baselines) =>
              createSession.mutate({ product: current, purpose, baselines })}
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
  const [expanded, setExpanded] = useState(false);
  const shown = railSessions(sorted, activeSessionId, expanded);
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
          {shown.map((session) => (
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
                  {/*
                    标题走正文基准 15px、两行才截断(issue #383):`title` 是首条用户消息,
                    一行 13px 的 `truncate` 只读得到开头半句,分不出两场会话谈的是不是同一件
                    事。`break-all` 保证没有空格的长串也在栏宽内折行,不把卡撑出横向滚动。
                  */}
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 line-clamp-2 break-all text-lg">
                      {sessionTitle(session.title, PURPOSE_LABEL[session.purpose])}
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
                    {/* 没有标题的那几场(产品梳理)名字都一样,谈没谈完先说,再是时刻。 */}
                    {session.title === null
                      ? `${session.purpose === "product-survey" ? (session.completedAt === null ? "未谈完 · " : "已谈完 · ") : ""}${localMinute(session.lastActiveAt)} · ${session.createdBy}`
                      : `${PURPOSE_LABEL[session.purpose]} · ${localMinute(session.lastActiveAt)} · ${session.createdBy}`}
                  </MasterListItemText>
                </Link>
              </MasterListItem>
            </li>
          ))}
        </ul>
      )}
      {sessions.length <= RAIL_SESSION_LIMIT ? null : (
        <div className="border-t border-line px-2 py-1">
          <Button
            variant="ghost"
            color="gray"
            size="1"
            className="w-full justify-start pointer-coarse:min-h-11"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "收起" : `全部 ${sessions.length} 条`}
          </Button>
        </div>
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
              className="min-w-0 w-full"
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
  const baseline = useBaselinePicks(open);
  useEffect(() => {
    if (open) setPurpose(DEFAULT_PURPOSE);
  }, [open]);

  const chosen = CREATABLE_PURPOSES.find((value) => value === purpose);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (chosen !== undefined) onSubmit(chosen, pickedBaselines(baseline.picked));
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
              在「{productName}」下开一个 Agent 会话。用途决定它的工具面与启用的 skill，建后不可更改。
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
          <RepoBaselineRows repos={repos} {...baseline} />
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
