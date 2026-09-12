import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CheckCircledIcon,
  CrossCircledIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Dialog,
  Flex,
  SegmentedControl,
  Select,
  Skeleton,
  Text,
  TextArea,
} from "@radix-ui/themes";
import { useEffect, useState, type FormEvent } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { RailCard } from "@/components/rail-card";
import { Button } from "@/components/theme-button";
import {
  conversation,
  type AgentSessionRecord,
} from "@/lib/agent-session-records";
import { localMinute, localSecond } from "@/lib/time";

import { fetchJson, send } from "./api.ts";
import { StreamStatus, useTrace } from "./run-trace.tsx";

/** 会话用途(CONTEXT.md 会话用途)。这一版只有需求拆分,与服务端同一份取值。 */
export const AGENT_SESSION_PURPOSES = ["requirement-breakdown"] as const;

export type AgentSessionPurpose = (typeof AGENT_SESSION_PURPOSES)[number];

export const PURPOSE_LABEL: Record<AgentSessionPurpose, string> = {
  "requirement-breakdown": "需求拆分",
};

export type AgentSession = {
  id: number;
  productId: number;
  createdBy: string;
  purpose: AgentSessionPurpose;
  /** 「在跑」是进程内的事实,服务端每次读会话时按会话运行时覆盖这一格(issue #333)。 */
  status: "idle" | "running";
  createdAt: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
};

type Product = {
  id: number;
  name: string;
  createdAt: string;
  repos: { repoId: number; owner: string; repo: string }[];
};

/** 一个产品下「我的会话」那一份。产品页左栏与会话详情页左栏读的是同一个查询键。 */
export function sessionsQueryKey(productId: number): readonly unknown[] {
  return ["products", productId, "sessions"];
}

export function useProductSessions(productId: number | undefined) {
  return useQuery({
    queryKey: sessionsQueryKey(productId ?? 0),
    queryFn: async () =>
      (await fetchJson<{ sessions: AgentSession[] }>(`/products/${productId!}/sessions`)).sessions,
    enabled: productId !== undefined,
  });
}

/**
 * 左栏的「我的会话」卡(原型 A 的第三段)。产品页与会话详情页共用:列的都是当前产品下
 * 这个账号自己的会话(系统管理员读到的是所有人的,由服务端决定,前端不自己判)。
 */
export function SessionRail({
  productId,
  sessions,
  pending,
  activeSessionId,
  canChat,
  onCreate,
}: {
  productId: number;
  sessions: readonly AgentSession[];
  pending: boolean;
  activeSessionId?: number;
  canChat: boolean;
  onCreate?: () => void;
}) {
  return (
    <RailCard
      title="我的会话"
      {...(pending ? {} : { count: sessions.length })}
      action={
        canChat && onCreate !== undefined ? (
          <Button variant="soft" color="gray" size="1" onClick={onCreate}>
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
          还没有会话。
        </Text>
      ) : (
        <ul>
          {sessions.map((session) => (
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
                  <span className="block truncate text-base">
                    {PURPOSE_LABEL[session.purpose]}
                  </span>
                  <MasterListItemText className="mt-px block text-sm font-normal">
                    {localMinute(session.createdAt)} · {session.createdBy}
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

/**
 * 建会话弹窗。用途建时必填、之后不变,所以它只在这里出现一次;下拉当前只有需求拆分一项,
 * 仍是下拉而不是一句说明——写代码类用途接入时这里多一项就够。
 */
export function CreateSessionDialog({
  open,
  productName,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  productName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (purpose: AgentSessionPurpose) => void;
}) {
  const [purpose, setPurpose] = useState<string>("");
  useEffect(() => {
    if (open) setPurpose("");
  }, [open]);

  const chosen = AGENT_SESSION_PURPOSES.find((value) => value === purpose);
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
                {AGENT_SESSION_PURPOSES.map((value) => (
                  <Select.Item key={value} value={value}>
                    {PURPOSE_LABEL[value]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
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

/** 排队中的一条消息(issue #334)。Pi 不支持单条撤回,所以它没有标识,也没有单条动作。 */
export type QueuedMessage = { mode: "followUp" | "steer"; text: string };

/** 两种模式的文案。界面上只说中文那一半,括号里的英文是 Pi 的说法,留着好对上文档。 */
const MODE_LABEL: Record<QueuedMessage["mode"], string> = {
  followUp: "排队",
  steer: "插话",
};

/** 正在生成的那一截:文字是累加的,工具是最近开跑的那一个。两样都不落库。 */
type LiveStream = { text: string; tool?: string };

/**
 * 中栏的对话流(issue #333、#334)。记录打开时一次取全,之后经 SSE 追加——两条来源写同一份
 * 查询缓存,与审查轨迹同一套路(`useTrace`)。记录行是 Pi 的条目原样 JSON,投影成对话的那
 * 一步在 `lib/agent-session-records.ts`。
 *
 * 不带 `seq` 的瞬时帧(流式 delta 与在跑的工具)不进那份数组:它们渲染成对话流末尾一个临时
 * 区块,落库条目一到就清掉——那一段文字此刻已经是记录里的一条了。
 */
function Conversation({ sessionId, running }: { sessionId: number; running: boolean }) {
  const [live, setLive] = useState<LiveStream | null>(null);
  const { events, query, stream } = useTrace<AgentSessionRecord>({
    queryKey: ["agent-session-records", sessionId],
    path: `/agent-sessions/${sessionId}/records`,
    streamPath: `/agent-sessions/${sessionId}/stream`,
    field: "records",
    // 会话没有「结束」那一刻:空闲着仍然续得上,流一直挂着等下一条。
    live: true,
    onTransient: (frame) => {
      const payload = frame.payload as { text?: unknown; tool?: unknown } | null;
      const text = typeof payload?.text === "string" ? payload.text : "";
      const tool = typeof payload?.tool === "string" ? payload.tool : undefined;
      setLive((prev) => {
        const tracked = tool ?? prev?.tool;
        return {
          text: (prev?.text ?? "") + text,
          ...(tracked === undefined ? {} : { tool: tracked }),
        };
      });
    },
  });
  const items = conversation(events);
  // 落库条目到了就把临时块清掉:它说的那段话已经在对话流里。
  useEffect(() => setLive(null), [events.length]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {query.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon>
            <CrossCircledIcon aria-hidden />
          </Callout.Icon>
          <Callout.Text>{(query.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {query.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在加载这个会话的对话</span>
          {[0, 1].map((slot) => (
            <Skeleton key={slot} aria-hidden className="h-16" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="还没有消息" description="发一条消息,agent 就在这里回你。" />
      ) : (
        <ol className="flex min-w-0 flex-col gap-3" aria-label="对话">
          {items.map((item) => (
            <li
              key={`${item.seq}-${item.kind}-${item.kind === "tool" ? item.name : "text"}`}
              className="min-w-0"
            >
              {item.kind === "tool" ? (
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-1">
                  <span className="font-mono text-base text-text">{item.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                    {item.summary}
                  </span>
                </div>
              ) : item.kind === "system" ? (
                /* 系统消息灰底一行:它不进模型上下文,但人要看得见(ADR 0031)。 */
                <div className="min-w-0 rounded-lg bg-fill px-4 py-2">
                  <span className="text-base text-text-secondary">
                    系统 · {localSecond(item.at)} · {item.text}
                  </span>
                </div>
              ) : (
                <div
                  className={`flex min-w-0 flex-col gap-1 rounded-lg px-4 py-3 ${
                    item.kind === "user"
                      ? "bg-accent-tint"
                      : "border border-card-line bg-surface"
                  }`}
                >
                  <span className="text-base text-text-muted">
                    {item.kind === "user" ? "我" : "agent"} · {localSecond(item.at)}
                  </span>
                  <p className="min-w-0 whitespace-pre-wrap break-words text-lg">{item.text}</p>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* 正在跑的工具一行与正在生成的文字:瞬时帧的去处,落库条目一到就换成真条目。 */}
      {live?.tool === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-1">
          <span className="font-mono text-base text-text">{live.tool}</span>
          <span className="text-xs text-text-secondary">在跑</span>
        </div>
      )}
      {live === null || live.text === "" ? null : (
        <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-card-line bg-surface px-4 py-3">
          <span className="text-base text-text-muted">agent · 正在回</span>
          <p className="min-w-0 whitespace-pre-wrap break-words text-lg">
            {live.text}
            <span className="ml-0.5 inline-block animate-pulse font-bold">▍</span>
          </p>
        </div>
      )}

      {running ? (
        <>
          {/* 「在跑」状态行:工具名在上面那一行,这里只说这个会话此刻在跑。 */}
          <p className="px-1 text-sm text-text-secondary" aria-live="polite">
            agent 在跑
          </p>
          <StreamStatus stream={stream} />
        </>
      ) : null}
    </div>
  );
}

/**
 * 排队块(原型 A)。**只有「清空队列」一个动作**:Pi 不支持单条撤回,给一个假的单条删除按钮
 * 只会让人以为撤得回来。一条都没排着时不渲染。
 */
function QueueBlock({
  queue,
  busy,
  onClear,
}: {
  queue: readonly QueuedMessage[];
  busy: boolean;
  onClear: () => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Text as="span" size="2" weight="medium">
          排队消息 {queue.length} 条
        </Text>
        <Button variant="soft" color="gray" size="1" disabled={busy} onClick={onClear}>
          <TrashIcon aria-hidden />
          清空队列
        </Button>
      </div>
      <ol className="flex min-w-0 flex-col gap-1.5" aria-label="排队消息">
        {queue.map((message, index) => (
          <li key={`${index}-${message.text}`} className="flex min-w-0 items-start gap-2">
            <Badge color={message.mode === "steer" ? "orange" : "gray"} variant="soft">
              {MODE_LABEL[message.mode]}
            </Badge>
            <span className="min-w-0 flex-1 break-words text-base">{message.text}</span>
          </li>
        ))}
      </ol>
      <Text as="p" size="2" color="gray">
        不支持单条撤回,只能整队清空。
      </Text>
    </div>
  );
}

/**
 * 一个 Agent 会话的详情页(原型 A 的三栏工作台,issue #332、#333、#334)。左栏产品与我的
 * 会话、中栏对话流与输入区、右栏产出(issue #336)。
 *
 * 执行中输入框照样能写:发出去的那一条按所选模式排队或插话,停止只中止当前这一步。空闲时
 * 两种模式等同直接开跑,切换因此只在执行中才有分别——文案把这件事说出来,而不是把切换藏起来。
 */
export function AgentSessionPage({
  productId,
  sessionId,
  username,
}: {
  productId: number;
  sessionId: number;
  username: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<QueuedMessage["mode"]>("followUp");

  const sessionQuery = useQuery({
    queryKey: ["agent-sessions", sessionId],
    queryFn: () =>
      fetchJson<{ session: AgentSession; queue: QueuedMessage[] }>(`/agent-sessions/${sessionId}`),
    // 在跑时轮询:回合结束与队列变动都没有单独的事件,状态与排队列表是会话自己那两格
    // (issue #333、#334)。
    refetchInterval: (query) => (query.state.data?.session.status === "running" ? 2000 : false),
  });
  const productQuery = useQuery({
    queryKey: ["products", productId],
    queryFn: async () => (await fetchJson<{ product: Product }>(`/products/${productId}`)).product,
  });
  const sessionsQuery = useProductSessions(productId);

  const session = sessionQuery.data?.session;
  const queue = sessionQuery.data?.queue ?? [];
  const running = session?.status === "running";
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["agent-sessions", sessionId] });
  const post = useMutation({
    mutationFn: (text: string) =>
      send(`/agent-sessions/${sessionId}/messages`, "POST", {
        // 一次发送一个 id:同一个 id 重发服务端不会再入队,回的是第一次的受理结果。
        clientMessageId: crypto.randomUUID(),
        text,
        mode,
      }),
    onSuccess: async () => {
      setDraft("");
      setFeedback(null);
      await refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });
  const stop = useMutation({
    mutationFn: () => send(`/agent-sessions/${sessionId}/stop`, "POST"),
    onSuccess: async () => {
      setFeedback(null);
      await refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });
  const clearQueue = useMutation({
    mutationFn: () => send(`/agent-sessions/${sessionId}/queue`, "DELETE"),
    onSuccess: async () => {
      setFeedback(null);
      await refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });
  const remove = useMutation({
    mutationFn: () => send(`/agent-sessions/${sessionId}`, "DELETE"),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(productId) });
      // 这一条已经不在了,回产品页;留在这里只会看到一句 404。
      void navigate({ to: "/products" });
    },
    onError: (error: Error) => {
      setConfirming(false);
      setFeedback({ text: error.message, error: true });
    },
  });

  const loadError = sessionQuery.error;
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

      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:gap-[18px]">
        <aside
          aria-label="产品与我的会话"
          className="flex w-full shrink-0 flex-col gap-2.5 lg:w-[272px]"
        >
          <RailCard title="产品">
            {productQuery.data === undefined ? (
              <Skeleton aria-hidden className="mx-4 mb-3 h-10" />
            ) : (
              <div className="px-4 pb-3">
                <Link to="/products" className="block break-all text-lg font-medium">
                  {productQuery.data.name}
                </Link>
                <ul className="mt-1">
                  {productQuery.data.repos.map((repo) => (
                    <li key={repo.repoId} className="break-all font-mono text-sm text-text-muted">
                      {repo.owner}/{repo.repo}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </RailCard>
          <SessionRail
            productId={productId}
            sessions={sessionsQuery.data ?? []}
            pending={sessionsQuery.isPending}
            activeSessionId={sessionId}
            canChat={false}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <CardShell className="flex min-w-0 flex-col gap-3 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <h1 className="min-w-0 break-all text-2xl font-bold tracking-[-0.015em]">
                {session === undefined ? "Agent 会话" : PURPOSE_LABEL[session.purpose]}
              </h1>
              {/* 删会话按钮只有创建者看得到:系统管理员读得到别人的会话,删不了。 */}
              {session !== undefined && session.createdBy === username ? (
                <Button
                  variant="soft"
                  color="red"
                  size={{ initial: "3", sm: "2" }}
                  disabled={remove.isPending}
                  onClick={() => {
                    setFeedback(null);
                    setConfirming(true);
                  }}
                >
                  删会话
                </Button>
              ) : null}
            </div>
            {session === undefined ? (
              <Skeleton aria-hidden className="h-40" />
            ) : (
              <>
                <Text as="p" size="2" color="gray">
                  {localMinute(session.createdAt)} 由 {session.createdBy} 建立
                  {running ? " · 在跑" : ""}
                </Text>
                <Conversation sessionId={sessionId} running={running} />
                {/* 发消息只有创建者能做:别人读得到这个会话,发不了。 */}
                {session.createdBy === username ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const text = draft.trim();
                      if (text !== "") post.mutate(text);
                    }}
                  >
                    <QueueBlock
                      queue={queue}
                      busy={clearQueue.isPending}
                      onClear={() => clearQueue.mutate()}
                    />
                    <TextArea
                      aria-label="发消息"
                      rows={3}
                      value={draft}
                      disabled={post.isPending}
                      placeholder={
                        running ? "在跑:这一条按下面选的模式投。" : "说一句话,回车换行。"
                      }
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <SegmentedControl.Root
                        size="1"
                        value={mode}
                        onValueChange={(next) => setMode(next as QueuedMessage["mode"])}
                        aria-label="发消息的模式"
                      >
                        <SegmentedControl.Item value="followUp">排队</SegmentedControl.Item>
                        <SegmentedControl.Item value="steer">插话</SegmentedControl.Item>
                      </SegmentedControl.Root>
                      <div className="flex-1" />
                      <Button
                        type="button"
                        variant="soft"
                        color="red"
                        size={{ initial: "3", sm: "2" }}
                        disabled={!running || stop.isPending}
                        onClick={() => stop.mutate()}
                      >
                        <StopIcon aria-hidden />
                        停止
                      </Button>
                      <Button
                        type="submit"
                        variant="solid"
                        size={{ initial: "3", sm: "2" }}
                        disabled={post.isPending || draft.trim() === ""}
                      >
                        {post.isPending
                          ? "发送中…"
                          : running
                            ? MODE_LABEL[mode]
                            : "发送"}
                      </Button>
                    </div>
                    <Text as="p" size="2" color="gray">
                      {running
                        ? mode === "steer"
                          ? "插话在下一个回合边界生效,不会打断正在跑的工具调用。"
                          : "排队的消息等这一轮跑完按顺序投递。"
                        : "空闲时两种模式一样:发出去就直接开跑。"}
                      {running ? " 停止只中止当前这一步,排队的消息保留。" : ""}
                    </Text>
                  </form>
                ) : null}
                {/* 页脚一行会话用量。 */}
                <Text as="p" size="2" color="gray" className="border-t border-line pt-2">
                  会话用量{" "}
                  <span className="font-mono tabular-nums">
                    {session.usage.totalTokens.toLocaleString("zh-CN")}
                  </span>{" "}
                  token · 输入{" "}
                  <span className="font-mono tabular-nums">
                    {session.usage.inputTokens.toLocaleString("zh-CN")}
                  </span>{" "}
                  · 输出{" "}
                  <span className="font-mono tabular-nums">
                    {session.usage.outputTokens.toLocaleString("zh-CN")}
                  </span>{" "}
                  · 缓存读{" "}
                  <span className="font-mono tabular-nums">
                    {session.usage.cacheReadTokens.toLocaleString("zh-CN")}
                  </span>{" "}
                  · 缓存写{" "}
                  <span className="font-mono tabular-nums">
                    {session.usage.cacheWriteTokens.toLocaleString("zh-CN")}
                  </span>
                </Text>
              </>
            )}
          </CardShell>
        </div>

        <aside
          aria-label="会话产出"
          className="flex w-full shrink-0 flex-col gap-2.5 xl:w-[336px]"
        >
          <CardShell className="px-5 py-4">
            <EmptyState
              title="还没有会话产出"
              titleAs="h2"
              description="agent 交出的结构化产出会出现在这里。"
            />
          </CardShell>
        </aside>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title="删除这个 Agent 会话?"
        titleSize="4"
        description="会话的记录、产出与图片一并删除,不可撤销。"
        cancelLabel="取消"
        cancelVariant="outline"
        cancelDisabled={remove.isPending}
        confirm={{
          label: remove.isPending ? "删除中…" : "删除",
          color: "red",
          disabled: remove.isPending,
          onClick: () => remove.mutate(),
        }}
      />
    </PageBody>
  );
}
