import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CheckCircledIcon,
  CopyIcon,
  Cross2Icon,
  CrossCircledIcon,
  ImageIcon,
  PlusIcon,
  ReaderIcon,
  StopIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Dialog,
  Flex,
  IconButton,
  SegmentedControl,
  Select,
  Skeleton,
  Text,
  TextArea,
  Tooltip,
} from "@radix-ui/themes";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { RailCard } from "@/components/rail-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import {
  currentFinalization,
  requirementBreakdownMarkdown,
  type AgentSessionOutput,
  type AgentSessionOutputFinalization,
} from "@/lib/agent-session-outputs";
import {
  conversation,
  type AgentSessionRecord,
} from "@/lib/agent-session-records";
import { localMinute, localSecond } from "@/lib/time";

import { api, apiUrl, errorText, fetchJson, send } from "./api.ts";
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

/** 一条消息最多带几张图(spec #329,issue #336)。与服务端同一个数。 */
const MAX_SESSION_IMAGES = 4;

/** 上传接口收得下的图片类型。`accept` 与服务端的白名单同一份。 */
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** 当前辅助模型看不了图时按钮上的那句提示(spec #329 的 US 23)。 */
const NO_IMAGE_INPUT_HINT = "当前辅助模型不支持图片,换一个支持图片的辅助模型";

/** 一张图的地址。对话流的缩略图与输入区的预览都取它。 */
function imageSrc(sessionId: number, imageId: string): string {
  return apiUrl(`/agent-sessions/${sessionId}/images/${imageId}`);
}

/**
 * 传一张图(issue #336)。body 就是文件本身,类型看 `content-type`——接口不收 multipart,
 * 一次一张。
 */
async function uploadImage(sessionId: number, file: File): Promise<string> {
  const response = await api(`/agent-sessions/${sessionId}/images`, {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!response.ok) throw new Error(await errorText(response));
  return ((await response.json()) as { image: { imageId: string } }).image.imageId;
}

/**
 * 输入区的图片按钮与缩略图预览(原型 A 的输入区,issue #336)。
 *
 * `imageInput` 为假即当前辅助模型看不了图:按钮置灰,鼠标悬停说清去换模型——人不会以为
 * 它看了图。满四张时同样置灰。
 */
function ImageComposer({
  sessionId,
  images,
  imageInput,
  busy,
  onPick,
  onRemove,
}: {
  sessionId: number;
  images: readonly string[];
  imageInput: boolean;
  busy: boolean;
  onPick: (files: readonly File[]) => void;
  onRemove: (imageId: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const full = images.length >= MAX_SESSION_IMAGES;
  const hint = !imageInput
    ? NO_IMAGE_INPUT_HINT
    : full
      ? `一条消息最多带 ${MAX_SESSION_IMAGES} 张图`
      : `加图片(最多 ${MAX_SESSION_IMAGES} 张)`;
  return (
    <>
      {images.length === 0 ? null : (
        <ul className="flex basis-full flex-wrap gap-2" aria-label="待发送的图片">
          {images.map((imageId) => (
            <li key={imageId} className="relative">
              <img
                src={imageSrc(sessionId, imageId)}
                alt="待发送的图片"
                className="size-16 rounded-lg border border-line object-cover"
              />
              <IconButton
                type="button"
                size="1"
                variant="solid"
                color="gray"
                aria-label="移除这张图片"
                className="absolute -right-1.5 -top-1.5"
                onClick={() => onRemove(imageId)}
              >
                <Cross2Icon aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={picker}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])].slice(
            0,
            MAX_SESSION_IMAGES - images.length,
          );
          // 同一个文件再选一次也要触发 change:值不清的话第二次选它什么都不会发生。
          event.target.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
      <Tooltip content={hint}>
        <span>
          <Button
            type="button"
            variant="soft"
            color="gray"
            size={{ initial: "3", sm: "2" }}
            disabled={!imageInput || full || busy}
            aria-label={hint}
            onClick={() => picker.current?.click()}
          >
            <ImageIcon aria-hidden />
            图片
          </Button>
        </span>
      </Tooltip>
    </>
  );
}

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
function Conversation({
  sessionId,
  running,
  onOpenOutput,
}: {
  sessionId: number;
  running: boolean;
  /** 点一张产出卡片:把右栏切到那一版(issue #337)。 */
  onOpenOutput: (version: number) => void;
}) {
  const [live, setLive] = useState<LiveStream | null>(null);
  const recordsKey = ["agent-session-records", sessionId];
  const { events, hasMore, query, stream } = useTrace<AgentSessionRecord>({
    queryKey: recordsKey,
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

  const { earlier, loadingEarlier, bottom } = useEarlierRecords(sessionId, recordsKey, events);

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

      {/*
        打开时取的是最后一页(spec #329 的 US 12):长会话不从头翻,顶上这个按钮一页一页往前
        取。取回来前插在最前面,插入前后的 `scrollHeight` 差值补回 `scrollTop`——不补的话
        人正在看的那一段会被新插进来的一页顶下去。
      */}
      {!hasMore || query.isPending ? null : (
        <div className="flex justify-center">
          <Button
            variant="soft"
            color="gray"
            size="2"
            disabled={loadingEarlier}
            onClick={() => void earlier()}
          >
            {loadingEarlier ? "加载中…" : "加载更早"}
          </Button>
        </div>
      )}

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
              ) : item.kind === "output" ? (
                /* 产出以卡片出现在对话流里,点开把右栏切到那一版(issue #337)。 */
                <button
                  type="button"
                  onClick={() => onOpenOutput(item.version)}
                  className="w-full rounded-lg border border-card-line bg-surface px-4 py-3 text-left transition-colors hover:bg-sunken"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <ReaderIcon aria-hidden className="size-4 text-text-muted" />
                    <span className="text-base font-medium">
                      会话产出 · 需求拆分 v{item.version}
                    </span>
                  </span>
                  <span className="mt-px block text-sm text-text-muted">
                    点开看总述与全部条目
                  </span>
                </button>
              ) : item.kind === "note" ? (
                /* 定稿与换版那一句:它进了模型上下文,对话里也该看得见。 */
                <div className="rounded-lg bg-sunken px-4 py-2">
                  <span className="text-base text-text-muted">
                    {localSecond(item.at)} · {item.text}
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
                  {/* 带的图片以缩略图出现在这条消息里(issue #336),点开看原图。 */}
                  {item.kind !== "user" || item.images.length === 0 ? null : (
                    <ul className="flex flex-wrap gap-2" aria-label="这条消息带的图片">
                      {item.images.map((imageId) => (
                        <li key={imageId}>
                          <a href={imageSrc(sessionId, imageId)} target="_blank" rel="noreferrer">
                            <img
                              src={imageSrc(sessionId, imageId)}
                              alt="这条消息带的图片"
                              className="size-20 rounded-lg border border-line object-cover"
                            />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
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
      {/* 打开时滚到这里:人要看的是最新那几条,而不是几天前的开头。 */}
      <div ref={bottom} aria-hidden />
    </div>
  );
}

/**
 * 往前翻更早的记录(spec #329 的 US 12)。
 *
 * 打开时把对话流滚到底部;「加载更早」取 `?before=<最前那条的 seq>` 的上一页前插进同一份查询
 * 缓存。滚动容器是面板那一个(`#panel-main-scroll`),前插前后的 `scrollHeight` 差值补回
 * `scrollTop`:人正在读的那一段因此留在原处。
 */
function useEarlierRecords(
  sessionId: number,
  recordsKey: readonly unknown[],
  events: readonly AgentSessionRecord[],
) {
  const queryClient = useQueryClient();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  // 首屏那一次滚到底,只滚一次:之后人自己滚到哪就是哪。
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || events.length === 0) return;
    settled.current = true;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const earlier = async (): Promise<void> => {
    const first = events[0];
    if (first === undefined || loadingEarlier) return;
    const scroller = document.getElementById("panel-main-scroll");
    const before = scroller?.scrollHeight ?? 0;
    setLoadingEarlier(true);
    try {
      const page = await fetchJson<{ records: AgentSessionRecord[]; hasMore: boolean }>(
        `/agent-sessions/${sessionId}/records?before=${first.seq}`,
      );
      queryClient.setQueryData<{ events: AgentSessionRecord[]; hasMore?: boolean }>(
        recordsKey,
        (prev) => ({
          events: [...page.records, ...(prev?.events ?? [])],
          hasMore: page.hasMore,
        }),
      );
      if (scroller !== null) {
        // 渲染完才量得到新的高度:下一帧再补差值。
        requestAnimationFrame(() => {
          scroller.scrollTop += scroller.scrollHeight - before;
        });
      }
    } finally {
      setLoadingEarlier(false);
    }
  };

  return { earlier, loadingEarlier, bottom };
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

/** 一个会话的产出查询键。右栏与产出卡片读同一份。 */
export function outputsQueryKey(sessionId: number): readonly unknown[] {
  return ["agent-session-outputs", sessionId];
}

type OutputsRead = {
  outputs: AgentSessionOutput[];
  finalizations: AgentSessionOutputFinalization[];
};

/** 总述卡片:需求概要、假设、未决问题三段,空的那一段写「无」。 */
function BreakdownSummary({ output }: { output: AgentSessionOutput }) {
  const sections: [string, string[]][] = [
    ["假设", output.payload.assumptions],
    ["未决问题", output.payload.openQuestions],
  ];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-card-line bg-surface px-4 py-3">
      <Text as="p" size="2" weight="bold">
        总述
      </Text>
      <Text as="p" size="2">
        需求概要:{output.payload.summary}
      </Text>
      {sections.map(([title, values]) => (
        <div key={title}>
          <Text as="p" size="1" weight="bold" color="gray">
            {title}
          </Text>
          {values.length === 0 ? (
            <Text as="p" size="1" color="gray">
              无
            </Text>
          ) : (
            <ul className="ml-4 list-disc">
              {values.map((value) => (
                <li key={value}>
                  <Text size="1" color="gray">
                    {value}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** 条目卡片:标题、所属仓库、描述、落点、依赖条目、验收要点,顺序与复制出来的 Markdown 一致。 */
function BreakdownItems({ output }: { output: AgentSessionOutput }) {
  const items = output.payload.items;
  return (
    <div className="flex flex-col gap-2">
      <Text as="p" size="2" weight="bold">
        拆分条目 {items.length} 条
      </Text>
      {items.map((item, index) => (
        <div
          key={`${index + 1}-${item.title}`}
          className="flex flex-col gap-1 rounded-lg border border-card-line bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Text size="2" weight="bold">
              {index + 1}. {item.title}
            </Text>
            <Badge color="gray" variant="soft">
              {item.repo}
            </Badge>
          </div>
          <Text as="p" size="1" color="gray">
            {item.description}
          </Text>
          <Text as="p" size="1" color="gray">
            落点:
            <span className="font-mono break-all">
              {item.locations.length === 0 ? "无" : item.locations.join(", ")}
            </span>
          </Text>
          <Text as="p" size="1" color="gray">
            依赖条目:{item.dependsOn.length === 0 ? "无" : item.dependsOn.join(", ")}
          </Text>
          <Text as="p" size="1" color="gray">
            验收要点:
          </Text>
          {item.acceptance.length === 0 ? (
            <Text as="p" size="1" color="gray">
              无
            </Text>
          ) : (
            <ul className="ml-4 list-disc">
              {item.acceptance.map((line) => (
                <li key={line}>
                  <Text size="1" color="gray">
                    {line}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 右栏的产出区(原型 A,issue #337):版本下拉、「定稿 / 换版到 vN」、「复制为 Markdown」、
 * 一行定稿信息,下面是总述卡片与条目卡片。
 *
 * 人不编辑产出,所以这里只有两个动作:定稿(换到另一版即换版)与复制。在跑时隔两秒续查
 * 一次:agent 交出新一版没有单独的事件,版本下拉要跟上。
 */
function OutputPanel({
  sessionId,
  canAct,
  running,
  picked,
  onPick,
}: {
  sessionId: number;
  /** 只有创建者定得了稿:别人读得到这个会话,动不了它。 */
  canAct: boolean;
  running: boolean;
  /** 右栏此刻看的是哪一版。null 即看最新那一版。 */
  picked: number | null;
  onPick: (version: number) => void;
}) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: outputsQueryKey(sessionId),
    queryFn: () => fetchJson<OutputsRead>(`/agent-sessions/${sessionId}/outputs`),
    refetchInterval: running ? 2000 : false,
  });
  const finalize = useMutation({
    mutationFn: (version: number) =>
      send(`/agent-sessions/${sessionId}/outputs/${version}/finalize`, "POST"),
    onSuccess: async () => {
      setError(null);
      // 定稿那一条 custom_message 自己从记录流过来,这里只要把产出那一份读新。
      await queryClient.invalidateQueries({ queryKey: outputsQueryKey(sessionId) });
    },
    onError: (failed: Error) => setError(failed.message),
  });

  const outputs = query.data?.outputs ?? [];
  const current = outputs.find((output) => output.version === picked) ?? outputs.at(-1);
  const finalized = currentFinalization(query.data?.finalizations ?? []);
  const isFinalized = current !== undefined && finalized?.toVersion === current.version;

  if (query.isPending) return <Skeleton aria-hidden className="h-40" />;
  if (query.isError) {
    // 读不到产出与「还没有产出」是两件事:报出原因,别让人以为 agent 还没交。
    return (
      <Callout.Root role="alert" color="red" size="1">
        <Callout.Icon>
          <CrossCircledIcon aria-hidden />
        </Callout.Icon>
        <Callout.Text>{(query.error as Error).message}</Callout.Text>
      </Callout.Root>
    );
  }
  if (current === undefined) {
    return (
      <EmptyState
        title="还没有会话产出"
        titleAs="h2"
        description="agent 交出的结构化产出会出现在这里。"
      />
    );
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        requirementBreakdownMarkdown({
          version: current.version,
          finalized: isFinalized,
          breakdown: current.payload,
        }),
      );
      setError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (failed) {
      setError((failed as Error).message);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {error === null ? null : (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon>
            <CrossCircledIcon aria-hidden />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">会话产出 · 需求拆分</h2>
        <Select.Root
          size="1"
          value={String(current.version)}
          onValueChange={(value) => onPick(Number(value))}
        >
          <Select.Trigger aria-label="产出版本" />
          <Select.Content position="popper">
            {outputs.map((output) => (
              <Select.Item key={output.version} value={String(output.version)}>
                v{output.version} · {output.payload.items.length} 条 ·{" "}
                {localMinute(output.createdAt)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {isFinalized ? (
            <StatusBadge tone="success">v{current.version} 已定稿</StatusBadge>
          ) : canAct ? (
            <Button
              size="1"
              disabled={finalize.isPending}
              onClick={() => finalize.mutate(current.version)}
            >
              {finalized === undefined ? `定稿 v${current.version}` : `换版到 v${current.version}`}
            </Button>
          ) : null}
          <Button size="1" variant="soft" color="gray" onClick={() => void copy()}>
            {copied ? <CheckCircledIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copied ? "已复制" : "复制为 Markdown"}
          </Button>
        </div>
        {finalized === undefined ? (
          <Text as="p" size="1" color="gray">
            还没有定稿版。
          </Text>
        ) : (
          <Text as="p" size="1" color="gray">
            定稿 v{finalized.toVersion} · {finalized.finalizedBy} ·{" "}
            {localMinute(finalized.finalizedAt)} · 定稿版不可改,进模型上下文
          </Text>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <BreakdownSummary output={current} />
        <BreakdownItems output={current} />
      </div>
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
  /** 这一条消息带的图片 id(issue #336)。发出去就清空;移除只是不带它,文件留在会话里。 */
  const [images, setImages] = useState<string[]>([]);
  /** 右栏看的是哪一版产出。null 即最新那一版;点对话流里的产出卡片切到那一版(issue #337)。 */
  const [outputVersion, setOutputVersion] = useState<number | null>(null);

  const sessionQuery = useQuery({
    queryKey: ["agent-sessions", sessionId],
    queryFn: () =>
      fetchJson<{
        session: AgentSession;
        queue: QueuedMessage[];
        imageInput: boolean;
        /** 重建之后前几条进不了模型上下文(ADR 0031,issue #335)。0 即记录完整。 */
        droppedFromContext: number;
      }>(`/agent-sessions/${sessionId}`),
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
  /** 当前辅助模型看不看得了图(issue #336)。读不到时按看不了处理:置灰比白发一次好。 */
  const imageInput = sessionQuery.data?.imageInput ?? false;
  const dropped = sessionQuery.data?.droppedFromContext ?? 0;
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
        images,
      }),
    onSuccess: async () => {
      setDraft("");
      setImages([]);
      setFeedback(null);
      await refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });
  /** 选中的图片逐张上传(issue #336)。一张失败就停:剩下的由人再选一次。 */
  const attach = useMutation({
    mutationFn: async (files: readonly File[]) => {
      const ids: string[] = [];
      for (const file of files) ids.push(await uploadImage(sessionId, file));
      return ids;
    },
    onSuccess: (ids) => {
      setFeedback(null);
      setImages((current) => [...current, ...ids].slice(0, MAX_SESSION_IMAGES));
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
          className="flex w-full shrink-0 flex-col gap-2.5 lg:sticky lg:top-[100px] lg:max-h-[calc(100vh-124px)] lg:w-[272px] lg:self-start lg:overflow-y-auto"
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
            <PageHeader
              title={session === undefined ? "Agent 会话" : PURPOSE_LABEL[session.purpose]}
              actions={
                // 删会话按钮只有创建者看得到:系统管理员读得到别人的会话,删不了。
                session !== undefined && session.createdBy === username ? (
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
                ) : undefined
              }
            />
            {/*
              记录有缺损时顶部一道横幅(spec #329 的 US 14):agent 忘了哪一段要让人知道,
              而不是默默丢掉。缺损只在重建那一刻定形,条数由服务端按记录算出来。
            */}
            {dropped > 0 ? (
              <Callout.Root role="status" color="amber" size="1">
                <Callout.Icon>
                  <CrossCircledIcon aria-hidden />
                </Callout.Icon>
                <Callout.Text>
                  这个会话的记录有缺损:最早的 {dropped} 条不在 agent 的上下文里,它看不到那一段。
                </Callout.Text>
              </Callout.Root>
            ) : null}
            {session === undefined ? (
              <Skeleton aria-hidden className="h-40" />
            ) : (
              <>
                <Text as="p" size="2" color="gray">
                  {localMinute(session.createdAt)} 由 {session.createdBy} 建立
                  {running ? " · 在跑" : ""}
                </Text>
                <Conversation
                  sessionId={sessionId}
                  running={running}
                  onOpenOutput={setOutputVersion}
                />
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
                      <ImageComposer
                        sessionId={sessionId}
                        images={images}
                        imageInput={imageInput}
                        busy={post.isPending || attach.isPending}
                        onPick={(files) => attach.mutate(files)}
                        onRemove={(imageId) =>
                          setImages((current) => current.filter((id) => id !== imageId))
                        }
                      />
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
          className="flex w-full shrink-0 flex-col gap-2.5 xl:sticky xl:top-[100px] xl:max-h-[calc(100vh-124px)] xl:w-[336px] xl:self-start xl:overflow-y-auto"
        >
          <CardShell className="px-5 py-4">
            <OutputPanel
              sessionId={sessionId}
              canAct={session !== undefined && session.createdBy === username}
              running={running}
              picked={outputVersion}
              onPick={setOutputVersion}
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
