import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckCircledIcon, CrossCircledIcon, PlusIcon } from "@radix-ui/react-icons";
import { Callout, Dialog, Flex, Select, Skeleton, Text, TextArea } from "@radix-ui/themes";
import { useEffect, useState, type FormEvent } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { RailCard } from "@/components/rail-card";
import { Button } from "@/components/theme-button";
import { localMinute } from "@/lib/time";

import { fetchJson, send } from "./api.ts";

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
  status: "idle";
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

/**
 * 一个 Agent 会话的详情页(原型 A 的三栏工作台,issue #332)。左栏产品与我的会话、中栏
 * 对话流与输入框、右栏产出。发消息、产出与实时流随后面的票接入,这一票只立骨架:中栏的
 * 输入框置灰,右栏是空产出区。
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

  const sessionQuery = useQuery({
    queryKey: ["agent-sessions", sessionId],
    queryFn: async () =>
      (await fetchJson<{ session: AgentSession }>(`/agent-sessions/${sessionId}`)).session,
  });
  const productQuery = useQuery({
    queryKey: ["products", productId],
    queryFn: async () => (await fetchJson<{ product: Product }>(`/products/${productId}`)).product,
  });
  const sessionsQuery = useProductSessions(productId);

  const session = sessionQuery.data;
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
                  {localMinute(session.createdAt)} 由 {session.createdBy} 建立 · 累计用量{" "}
                  <span className="font-mono tabular-nums">
                    {session.usage.totalTokens.toLocaleString("zh-CN")}
                  </span>{" "}
                  token
                </Text>
                <EmptyState title="还没有消息" description="这个会话还没有对话记录。" />
                <div className="flex flex-col gap-2">
                  <TextArea
                    aria-label="发消息"
                    rows={3}
                    disabled
                    placeholder="尚未接通:发消息在下一步接入。"
                  />
                  <div className="flex justify-end">
                    <Button variant="solid" size={{ initial: "3", sm: "2" }} disabled>
                      发送
                    </Button>
                  </div>
                </div>
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
