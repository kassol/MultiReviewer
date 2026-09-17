import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CommitIcon,
  CopyIcon,
  CounterClockwiseClockIcon,
  Cross2Icon,
  CrossCircledIcon,
  DotsHorizontalIcon,
  ExclamationTriangleIcon,
  FileTextIcon,
  GearIcon,
  ImageIcon,
  InfoCircledIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PaperPlaneIcon,
  QuestionMarkCircledIcon,
  ReaderIcon,
  StopIcon,
  TrashIcon,
  UpdateIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  CheckboxGroup,
  DropdownMenu,
  IconButton,
  Popover,
  RadioGroup,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { CardShell } from "@/components/card-shell";
import { CommitChip } from "@/components/commit-chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { PageBody } from "@/components/page-body";
import { ReplyReader } from "@/components/reply-reader";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus } from "@/components/use-dialog-return-focus";
import {
  currentFinalization,
  requirementBreakdownMarkdown,
  type AgentSessionOutput,
  type AgentSessionOutputFinalization,
} from "@/lib/agent-session-outputs";
import {
  conversation,
  describeTool,
  groupConversation,
  summarizeTools,
  type AgentSessionRecord,
  type ToolCallItem,
  type ToolKind,
  type ToolStep,
  type ConversationGroup,
} from "@/lib/agent-session-records";
import { roundAnswerText } from "@/lib/session-question-round";
import {
  agentSessionQueryKey,
  PURPOSE_LABEL,
  sessionsQueryKey,
  type AgentSession,
  type AgentSessionBaseline,
  type AgentSessionPurpose,
} from "@/lib/agent-sessions";
import { localMinute, localSecond } from "@/lib/time";

import { api, apiUrl, errorText, fetchJson, send } from "./api.ts";
import { ProductRail, useProductDetail } from "./product-rail.tsx";
import { StreamStatus, useTrace } from "./run-trace.tsx";

/**
 * 这个用途有没有产出类型(CONTEXT.md 会话用途)。开放对话只聊、交不出产出,右栏产出区因此
 * 整块不渲染——留一个永远空着的空态,只会让人等一份不会来的东西。
 */
const PURPOSE_HAS_OUTPUT: Record<AgentSessionPurpose, boolean> = {
  "requirement-breakdown": true,
  "open-conversation": false,
  // 产品梳理交的是产品知识提案,它们在产品页上确认,不是这一页的会话产出(issue #345)。
  "product-survey": false,
};

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
        <ul className="flex basis-full flex-wrap gap-2 pb-1" aria-label="待发送的图片">
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
        <span className="inline-flex">
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            size="2"
            disabled={!imageInput || full || busy}
            aria-label={hint}
            onClick={() => picker.current?.click()}
          >
            <ImageIcon aria-hidden />
          </IconButton>
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

/** 滚动位置距底不超过这个数就算「在看最新」,新条目来了跟着滚。 */
const FOLLOW_THRESHOLD = 80;

/**
 * 中栏的对话流(issue #333、#334)。记录打开时一次取全,之后经 SSE 追加——两条来源写同一份
 * 查询缓存,与审查轨迹同一套路(`useTrace`)。记录行是 Pi 的条目原样 JSON,投影成对话的那
 * 一步在 `lib/agent-session-records.ts`,连续的工具调用再折成一组。
 *
 * 滚动容器是它自己的:对话占满中栏,输入框钉在下面。新条目来时人在底部就跟着滚,翻上去看
 * 旧消息时不打扰,右下角浮一颗「最新」送回底部。
 *
 * 不带 `seq` 的瞬时帧(流式 delta 与在跑的工具)不进那份数组:文字渲染成末尾一条临时的 agent
 * 消息,工具名挂在最后一组工具调用的末尾,落库条目一到就清掉——那一段此刻已经是记录里的一条。
 */
function Conversation({
  sessionId,
  running,
  onOpenOutput,
  onAnswerRound,
  canSend,
  hasBaselines,
}: {
  sessionId: number;
  running: boolean;
  /** 点一条产出:把右栏切到那一版(issue #337)。 */
  onOpenOutput: (version: number) => void;
  /** 交一轮提问的答案(issue #359):合成的那条用户消息走与输入区同一条发消息路径。 */
  onAnswerRound: (text: string) => Promise<void>;
  /** 空态教学文案只对发得出消息的人说;发不了的人看到的是一句陈述。答不答得了提问也按它。 */
  canSend: boolean;
  hasBaselines: boolean;
}) {
  const [live, setLive] = useState<LiveStream | null>(null);
  /** 摊开了的长回复,按 `seq` 记。长回复默认收起,展开只是内容高度变化,不是
      新消息,不进「最新」跟随判定。 */
  const [expandedReplies, setExpandedReplies] = useState<Set<number>>(new Set());
  const toggleReplyExpanded = (seq: number): void => {
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };
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
  const groups = groupConversation(conversation(events));
  // 落库条目到了就把临时块清掉:它说的那段话已经在对话流里。
  useEffect(() => setLive(null), [events.length]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const { earlier, loadingEarlier } = useEarlierRecords(sessionId, recordsKey, events, scroller);
  const [away, setAway] = useState(false);
  const toBottom = (): void => {
    const el = scroller.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  };
  // 首屏滚到底;之后只在人还在底部时跟着新内容滚。
  const settled = useRef(false);
  useLayoutEffect(() => {
    if (!settled.current) {
      if (events.length === 0) return;
      settled.current = true;
      toBottom();
      return;
    }
    if (!away) toBottom();
  }, [events.length, live?.text, live?.tool, away]);

  const lastGroup = groups.at(-1);
  const liveTool = running ? live?.tool : undefined;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        // relative:行里的 sr-only 是绝对定位,容器不定位的话它会落到容器外,把整页撑出一段滚动。
        className="relative flex h-full flex-col gap-3 overflow-y-auto overscroll-contain py-3"
        onScroll={(event) => {
          const el = event.currentTarget;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_THRESHOLD);
        }}
      >
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
              size="1"
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
        ) : groups.length === 0 && live === null ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              align="center"
              title="还没有消息"
              description={
                canSend
                  ? hasBaselines
                    ? "发第一条消息开始。agent 按上面列出的提交读代码。"
                    : "发第一条消息开始。"
                  : "这个会话还没人说过话。"
              }
            />
          </div>
        ) : (
          <ol className="flex min-w-0 flex-col gap-3" aria-label="对话">
            {groups.map((item, index) => (
              <li key={`${item.seq}-${item.kind}`} className="min-w-0">
                <ConversationRow
                  item={item}
                  sessionId={sessionId}
                  onOpenOutput={onOpenOutput}
                  canAnswerRound={canSend}
                  onAnswerRound={onAnswerRound}
                  // 最后一组工具调用在跑时摊开着,正在跑的那一个挂在它末尾。
                  {...(item.kind === "tools" && index === groups.length - 1
                    ? { liveTool, open: running }
                    : {})}
                  // 长回复的展开状态按 `seq` 记在 `Conversation` 里,折叠/展开不重挂这一行。
                  {...(item.kind === "assistant"
                    ? {
                        expanded: expandedReplies.has(item.seq),
                        onToggleExpand: () => toggleReplyExpanded(item.seq),
                      }
                    : {})}
                />
              </li>
            ))}
          </ol>
        )}

        {/* 正在跑的工具还没有落库的组可挂:自己成一组。 */}
        {liveTool === undefined || lastGroup?.kind === "tools" ? null : (
          <ToolGroup calls={[]} liveTool={liveTool} open />
        )}
        {live === null || live.text === "" ? null : (
          <div className="flex min-w-0 items-end gap-1">
            <span className="sr-only">agent 正在回</span>
            <Markdown text={live.text} />
            <span
              aria-hidden
              className="mb-1 ml-0.5 inline-block h-[1em] w-0.5 shrink-0 animate-pulse bg-current"
            />
          </div>
        )}
        {running ? (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 px-1 text-sm text-text-muted" aria-live="polite">
              <Spinner size="1" />
              agent 在跑
            </p>
            <StreamStatus stream={stream} />
          </div>
        ) : null}
      </div>
      {away ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute right-3 bottom-3 flex items-center gap-1 rounded-full border border-card-line bg-surface px-3 py-1.5 text-md font-medium text-text-secondary shadow-card transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <ArrowDownIcon aria-hidden />
          最新
        </button>
      ) : null}
    </div>
  );
}

/** 对话流里的一行:人的气泡、agent 的正文、一组工具调用、系统一句、产出一行、提问卡片。 */
function ConversationRow({
  item,
  sessionId,
  onOpenOutput,
  canAnswerRound,
  onAnswerRound,
  liveTool,
  open = false,
  expanded = false,
  onToggleExpand,
}: {
  item: ConversationGroup;
  sessionId: number;
  onOpenOutput: (version: number) => void;
  /** 这一轮提问由谁答:发得出消息的人才答得了(与输入区同一判据)。 */
  canAnswerRound: boolean;
  onAnswerRound: (text: string) => Promise<void>;
  liveTool?: string | undefined;
  open?: boolean;
  /** 长回复此刻是摊开还是收着,只对 `kind === "assistant"` 有意义(`Conversation` 按 `seq` 记)。 */
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  if (item.kind === "tools") {
    return <ToolGroup calls={item.calls} liveTool={liveTool} open={open} />;
  }
  if (item.kind === "system") {
    /* 系统消息(停止、中止、静默死亡、切模型)不是对话的一方,胶囊居中一行,与定稿句区分开
       (ADR 0031、issue #337):定稿是一句平静的旁白,系统消息是需要留意的事件。 */
    return (
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-sm text-text-secondary">
          <InfoCircledIcon aria-hidden />
          {localSecond(item.at)} · {item.text}
        </span>
      </div>
    );
  }
  if (item.kind === "note") {
    /* 定稿那一句居中一行小字:它不是对话的一方(ADR 0031、issue #337)。 */
    return (
      <p className="text-center text-sm text-text-muted">
        {localSecond(item.at)} · {item.text}
      </p>
    );
  }
  if (item.kind === "output") {
    /* 产出以一行出现在对话流里,点开把右栏切到那一版(issue #337)。 */
    return (
      <button
        type="button"
        onClick={() => onOpenOutput(item.version)}
        className="flex w-full items-center gap-2 rounded-lg border border-card-line bg-surface px-3 py-2 text-left transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <ReaderIcon aria-hidden className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 text-base font-medium">会话产出 · 需求拆分 v{item.version}</span>
        <ChevronRightIcon aria-hidden className="shrink-0 text-text-faint" />
      </button>
    );
  }
  if (item.kind === "round") {
    return <QuestionRoundCard item={item} canAnswer={canAnswerRound} onAnswer={onAnswerRound} />;
  }
  if (item.kind === "user") {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent-tint px-4 py-2.5">
          <p className="min-w-0 break-words whitespace-pre-wrap text-lg">{item.text}</p>
          {/* 带的图片以缩略图出现在这条消息里(issue #336),点开看原图。 */}
          {item.images.length === 0 ? null : (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="这条消息带的图片">
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
        <MessageTime at={item.at} />
      </div>
    );
  }
  return <AssistantReply item={item} expanded={expanded} onToggleExpand={onToggleExpand!} />;
}

/** 「其他」那一项的取值。用不可能与选项文字撞上的哨位,选项文字因此不必再做转义。 */
const OTHER_OPTION = " 其他";

/**
 * 一轮提问的选择卡片(CONTEXT.md 提问轮次,issue #359)。材质与 agent 的回复卡同一份
 * (`border-overlay-line` 的内嵌卡):它是 agent 说的一段话,只是这一段要人回答。
 *
 * 推荐项预先选上:一轮的成本该是「几下点击加一次提交」,同意推荐的那几题一下都不必点。
 * 每题末尾多一项「其他」,选中即现一格自填。整轮一次提交,合成一条普通用户消息走既有的发
 * 消息路径(`roundAnswerText`)。
 *
 * 三态由记录投影给出:已答的摊开所选答案,被更新的用户消息顶掉的渲染成过期且交不上去,
 * 其余可答。
 */
function QuestionRoundCard({
  item,
  canAnswer,
  onAnswer,
}: {
  item: Extract<ConversationGroup, { kind: "round" }>;
  canAnswer: boolean;
  onAnswer: (text: string) => Promise<void>;
}) {
  const questions = item.round.questions;
  const settled = item.answers;
  const expired = item.expired === true;
  const [picked, setPicked] = useState<string[][]>(() =>
    questions.map((question) => {
      const recommended = question.options.find((option) => option.recommended);
      return recommended === undefined ? [] : [recommended.text];
    }),
  );
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [sending, setSending] = useState(false);

  /** 此刻每题答的是什么:「其他」换成自填的那一行,空的丢掉。 */
  const answers = picked.map((chosen, index) =>
    chosen
      .map((value) => (value === OTHER_OPTION ? other[index]!.trim() : value))
      .filter((text) => text !== ""),
  );
  const ready = answers.every((one) => one.length > 0);
  const submit = async (): Promise<void> => {
    setSending(true);
    try {
      await onAnswer(roundAnswerText(item.round, answers));
    } finally {
      setSending(false);
    }
  };
  const answerable = settled === undefined && !expired && canAnswer;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-overlay-line bg-surface px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <QuestionMarkCircledIcon aria-hidden />
        <span>提问轮次 · {questions.length} 题</span>
        {settled === undefined ? null : (
          <Badge color="gray" size="1">
            已回答
          </Badge>
        )}
        {expired ? (
          <Badge color="gray" size="1">
            已过期
          </Badge>
        ) : null}
      </div>
      <ol className="flex flex-col gap-4">
        {questions.map((question, index) => {
          /** 选项加末尾的「其他」。单选与多选给的是同一串,只是控件不同。 */
          const choices = [
            ...question.options.map((option) => ({
              value: option.text,
              text: option.text,
              recommended: option.recommended,
            })),
            { value: OTHER_OPTION, text: "其他", recommended: false },
          ];
          const label = (choice: (typeof choices)[number]): ReactNode => (
            <span className="flex flex-wrap items-center gap-1.5">
              {choice.text}
              {choice.recommended ? (
                <Badge color="blue" size="1">
                  推荐
                </Badge>
              ) : null}
            </span>
          );
          return (
            <li key={index} className="flex min-w-0 flex-col gap-1.5">
              <p className="text-base font-medium">
                {index + 1}. {question.title}
                {question.multiple ? (
                  <span className="ml-1.5 text-sm font-normal text-text-muted">多选</span>
                ) : null}
              </p>
              {question.body === "" ? null : (
                <p className="text-md whitespace-pre-wrap text-text-secondary">{question.body}</p>
              )}
              {settled !== undefined ? (
                <ul className="flex flex-col gap-1">
                  {(settled[index] ?? []).map((answer) => (
                    <li key={answer} className="flex items-start gap-1.5 text-md">
                      <CheckCircledIcon aria-hidden className="mt-1 shrink-0 text-primary" />
                      <span className="min-w-0 break-words">{answer}</span>
                    </li>
                  ))}
                </ul>
              ) : !answerable ? (
                <ul className="flex flex-col gap-1 text-md text-text-secondary">
                  {choices.slice(0, -1).map((choice) => (
                    <li key={choice.value}>{label(choice)}</li>
                  ))}
                </ul>
              ) : question.multiple ? (
                <CheckboxGroup.Root
                  value={picked[index]}
                  onValueChange={(value) =>
                    setPicked((prev) => prev.map((one, at) => (at === index ? value : one)))
                  }
                >
                  {choices.map((choice) => (
                    <CheckboxGroup.Item key={choice.value} value={choice.value}>
                      {label(choice)}
                    </CheckboxGroup.Item>
                  ))}
                </CheckboxGroup.Root>
              ) : (
                <RadioGroup.Root
                  value={picked[index]![0] ?? ""}
                  onValueChange={(value) =>
                    setPicked((prev) => prev.map((one, at) => (at === index ? [value] : one)))
                  }
                >
                  {choices.map((choice) => (
                    <RadioGroup.Item key={choice.value} value={choice.value}>
                      {label(choice)}
                    </RadioGroup.Item>
                  ))}
                </RadioGroup.Root>
              )}
              {answerable && picked[index]!.includes(OTHER_OPTION) ? (
                <TextField.Root
                  size="2"
                  className="ml-6"
                  aria-label={`第 ${index + 1} 题的其他答案`}
                  placeholder="写下你的答案"
                  value={other[index] ?? ""}
                  onChange={(event) =>
                    setOther((prev) =>
                      prev.map((one, at) => (at === index ? event.target.value : one)),
                    )
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {settled !== undefined ? null : expired ? (
        <p className="text-sm text-text-muted">这一轮被后来的消息顶掉了,答案交不上去了。</p>
      ) : answerable ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-text-muted">整轮一次提交,提交后 agent 接着这一轮往下走。</p>
          <Button type="button" disabled={!ready || sending} onClick={() => void submit()}>
            {sending ? "提交中" : "提交这一轮"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-text-muted">这一轮由开会话的人回答。</p>
      )}
    </div>
  );
}

/** 超过这个字数或换行数的回复算「长回复」(仿 Craft Agents TurnCard 的折叠阈值):文档长度的
    正文塞进 760px 的聊天列读不动,先收起到一屏内,「展开」或「阅读」再摊开。 */
const LONG_REPLY_CHARS = 800;
const LONG_REPLY_NEWLINES = 12;

function isLongReply(text: string): boolean {
  if (text.length > LONG_REPLY_CHARS) return true;
  return (text.match(/\n/g)?.length ?? 0) > LONG_REPLY_NEWLINES;
}

/**
 * agent 一条完整回复的卡片(仿 Craft Agents 的 TurnCard)。长回复默认收进 320px 高、底部
 * 渐隐;「展开」摊开到全高,「阅读」开单独的阅读视图(`ReplyReader`,字号更大、限宽 72ch),
 * 「复制 Markdown」拿走原文——写法与 `OutputPanel` 的复制按钮同一份(2 秒后 label 复位,
 * 失败照样在这张卡上方弹一条 Callout)。收起时把卡片顶部滚回可见处:展开是内容变高,不是
 * 新消息,不该让人对着一段突然消失在视口上方的文字发懵。
 */
function AssistantReply({
  item,
  expanded,
  onToggleExpand,
}: {
  item: Extract<ConversationGroup, { kind: "assistant" }>;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const long = isLongReply(item.text);
  const cardRef = useRef<HTMLDivElement>(null);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (wasExpanded.current && !expanded) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(item.text);
      setCopyError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (failed) {
      setCopyError((failed as Error).message);
    }
  };

  const [reading, setReading] = useState(false);
  const returnFocus = useDialogReturnFocus();

  return (
    <div
      ref={cardRef}
      className="group flex flex-col rounded-lg border border-overlay-line bg-surface px-4 py-3"
    >
      <span className="sr-only">agent</span>
      {copyError === null ? null : (
        <Callout.Root role="alert" color="red" size="1" className="mb-2">
          <Callout.Icon>
            <CrossCircledIcon aria-hidden />
          </Callout.Icon>
          <Callout.Text>{copyError}</Callout.Text>
        </Callout.Root>
      )}
      {long && !expanded ? (
        <div className="relative max-h-[320px] overflow-hidden">
          <Markdown text={item.text} />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent"
          />
        </div>
      ) : (
        <Markdown text={item.text} />
      )}
      {/* footer 不画分隔线:动作平时藏着,一条线下面空着一行只会像漏了什么。 */}
      <div className="mt-1 flex min-h-6 items-center justify-between gap-2 text-sm text-text-muted">
        <MessageTime at={item.at} />
        {/* ghost 键的 hover 底靠负外边距向四周撑出 8px,相邻两颗要留 gap-5 才不会叠在一起。
            「阅读」「复制 Markdown」与已展开状态下的「收起」只在指到卡片时现,同 `MessageTime`
            的规则;折叠态的「展开」是找回全文的唯一入口,常显不进 hover 组。 */}
        <div className="flex items-center gap-5">
          {long && !expanded ? (
            <Button type="button" variant="ghost" color="gray" size="1" onClick={onToggleExpand}>
              <ChevronDownIcon aria-hidden />
              展开
            </Button>
          ) : null}
          <div className="flex items-center gap-5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            {long && expanded ? (
              <Button type="button" variant="ghost" color="gray" size="1" onClick={onToggleExpand}>
                <ChevronDownIcon aria-hidden />
                收起
              </Button>
            ) : null}
            {long ? (
              <Button
                type="button"
                variant="ghost"
                color="gray"
                size="1"
                onClick={(event) => {
                  returnFocus.captureTrigger(event);
                  setReading(true);
                }}
              >
                <ReaderIcon aria-hidden />
                阅读
              </Button>
            ) : null}
            <Button type="button" variant="ghost" color="gray" size="1" onClick={() => void copy()}>
              {copied ? <CheckCircledIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {copied ? "已复制" : "复制 Markdown"}
            </Button>
          </div>
        </div>
      </div>
      {long ? (
        <ReplyReader
          open={reading}
          onOpenChange={setReading}
          text={item.text}
          at={item.at}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
        />
      ) : null}
    </div>
  );
}

/** 消息下面的时刻。平时不占注意力,指到那条消息才显出来;布局不变,读屏照样读得到。 */
function MessageTime({ at }: { at: string }) {
  return (
    <span className="text-sm text-text-muted transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
      {localSecond(at)}
    </span>
  );
}

/** 每类工具调用的图标:读文件、搜内容、列目录、git、两种查询、交产出。 */
const TOOL_ICONS: Record<ToolKind, typeof FileTextIcon> = {
  read: FileTextIcon,
  grep: MagnifyingGlassIcon,
  find: MagnifyingGlassIcon,
  ls: ListBulletIcon,
  git: CommitIcon,
  findings: CounterClockwiseClockIcon,
  knowledge: ReaderIcon,
  submit: PaperPlaneIcon,
  round: QuestionMarkCircledIcon,
  other: GearIcon,
};

/**
 * 一组连续的工具调用。一个回合几十次读文件逐行摊开会把对话冲散:收成一行「读取 5 个文件、
 * git 3 次」,展开才看逐步明细(动词 + 对象,失败的带原因)。在跑的最后一组默认摊开,
 * 正在跑的那一个带 Spinner 挂在末尾。
 */
function ToolGroup({
  calls,
  liveTool,
  open,
}: {
  calls: ToolCallItem[];
  liveTool?: string | undefined;
  open: boolean;
}) {
  const [expanded, setExpanded] = useState(open);
  // 不再是在跑的那一组了就收起来:回合结束后对话里只剩一行。
  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);
  const summary = summarizeTools(calls.map((call) => call.step));
  const failed = calls.filter((call) => call.error !== undefined).length;
  return (
    <Collapsible.Root open={expanded} onOpenChange={setExpanded} className="group/tools text-base">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex max-w-full items-center gap-1.5 rounded-md py-1 pr-2 pl-1 text-text-secondary transition-colors hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          {liveTool === undefined ? (
            <ChevronRightIcon
              aria-hidden
              className="shrink-0 transition-transform group-data-[state=open]/tools:rotate-90"
            />
          ) : (
            <Spinner size="1" className="shrink-0" />
          )}
          {calls.length === 0 ? null : (
            <span className="rounded-full bg-fill px-1.5 text-xs tabular-nums text-text-secondary">
              {calls.length}
            </span>
          )}
          <span className="truncate">{summary === "" ? "正在调用工具" : summary}</span>
          {failed === 0 ? null : (
            <span className="flex shrink-0 items-center gap-1 text-danger">
              <ExclamationTriangleIcon aria-hidden />
              {failed} 次失败
            </span>
          )}
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ol className="mt-1 ml-2 flex min-w-0 flex-col border-l border-line pl-3" aria-label="工具调用">
          {calls.map((call, index) => (
            <ToolRow key={`${call.seq}-${index}`} step={call.step} error={call.error} />
          ))}
          {liveTool === undefined ? null : <ToolRow step={describeTool(liveTool, undefined)} live />}
        </ol>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** 一次工具调用一行:图标、动词、对象;失败了在下面补一行原因。对象是路径或命令,用等宽。 */
function ToolRow({ step, error, live = false }: { step: ToolStep; error?: string | undefined; live?: boolean }) {
  const Icon = TOOL_ICONS[step.kind];
  return (
    <li className="flex min-w-0 flex-col py-0.5">
      <span className="flex min-w-0 items-center gap-2">
        {live ? <Spinner size="1" className="shrink-0" /> : <Icon aria-hidden className="shrink-0 text-text-muted" />}
        <span className="shrink-0 text-text-secondary">{step.label}</span>
        {step.target === "" ? null : (
          <span className="min-w-0 truncate font-mono text-sm text-text" title={step.target}>
            {step.target}
          </span>
        )}
        {live ? <span className="shrink-0 text-text-muted">在跑</span> : null}
      </span>
      {error === undefined ? null : (
        <span className="flex min-w-0 items-center gap-2 pl-6 text-sm text-danger">
          <ExclamationTriangleIcon aria-hidden className="shrink-0" />
          {/* 短原因直接读得完,展开成多行;长原因还是截断,靠 title 查全文。 */}
          <span
            className={`min-w-0 ${error.length <= 160 ? "break-words" : "truncate"}`}
            title={error}
          >
            {error}
          </span>
        </span>
      )}
    </li>
  );
}

/**
 * 往前翻更早的记录(spec #329 的 US 12)。
 *
 * 「加载更早」取 `?before=<最前那条的 seq>` 的上一页前插进同一份查询缓存。滚动容器是对话流
 * 自己那个,前插前后的 `scrollHeight` 差值补回 `scrollTop`:人正在读的那一段因此留在原处。
 */
function useEarlierRecords(
  sessionId: number,
  recordsKey: readonly unknown[],
  events: readonly AgentSessionRecord[],
  scroller: React.RefObject<HTMLDivElement | null>,
) {
  const queryClient = useQueryClient();
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const earlier = async (): Promise<void> => {
    const first = events[0];
    if (first === undefined || loadingEarlier) return;
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
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
      if (el !== null) {
        // 渲染完才量得到新的高度:下一帧再补差值。
        requestAnimationFrame(() => {
          el.scrollTop += el.scrollHeight - before;
        });
      }
    } finally {
      setLoadingEarlier(false);
    }
  };

  return { earlier, loadingEarlier };
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
 * 输入区(issue #334、#336)。一个框:随内容长高的原生 textarea 在上,下沿一行是图片、在跑时的
 * 排队 / 插话切换、停止与发送。原生 textarea 而不是 Themes TextArea:它要嵌在自己的框里与
 * 下沿那一排共用一道边,与 `ui/command` 的输入同理;框的边、底、焦点环都走 v8 令牌。
 *
 * 回车发送,Shift+回车换行;中文输入法选词那一下 `isComposing` 为真,不发。
 */
function Composer({
  sessionId,
  running,
  mode,
  onMode,
  draft,
  onDraft,
  images,
  imageInput,
  sending,
  attaching,
  stopping,
  onSend,
  onStop,
  onPick,
  onRemove,
}: {
  sessionId: number;
  running: boolean;
  mode: QueuedMessage["mode"];
  onMode: (mode: QueuedMessage["mode"]) => void;
  draft: string;
  onDraft: (draft: string) => void;
  images: readonly string[];
  imageInput: boolean;
  sending: boolean;
  attaching: boolean;
  stopping: boolean;
  onSend: () => void;
  onStop: () => void;
  onPick: (files: readonly File[]) => void;
  onRemove: (imageId: string) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const canSend = !sending && draft.trim() !== "";
  const sendLabel = sending ? "发送中" : running ? MODE_LABEL[mode] : "发送";

  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <div className="flex flex-col rounded-lg border border-input bg-surface shadow-control transition-shadow focus-within:[box-shadow:var(--v8-shadow-focus)]">
        <textarea
          ref={area}
          aria-label="发消息"
          rows={1}
          value={draft}
          placeholder={running ? "在跑:这一条按所选模式投" : "给 agent 发消息"}
          // 发送中不禁用输入框:禁用会丢焦点,发完还得再点一次才能接着打;重复发送由 canSend 挡。
          className="max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3 pt-3 pb-1 text-lg outline-none placeholder:text-text-disabled"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) onSend();
          }}
        />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <ImageComposer
            sessionId={sessionId}
            images={images}
            imageInput={imageInput}
            busy={sending || attaching}
            onPick={onPick}
            onRemove={onRemove}
          />
          {running ? (
            <SegmentedControl.Root
              size="1"
              value={mode}
              onValueChange={(next) => onMode(next as QueuedMessage["mode"])}
              aria-label="发消息的模式"
            >
              <SegmentedControl.Item value="followUp">排队</SegmentedControl.Item>
              <SegmentedControl.Item value="steer">插话</SegmentedControl.Item>
            </SegmentedControl.Root>
          ) : null}
          <div className="flex-1" />
          {running ? (
            <Tooltip content="停止:只中止当前这一步,排队的消息保留">
              <IconButton
                type="button"
                variant="soft"
                color="red"
                size="2"
                aria-label="停止"
                disabled={stopping}
                onClick={onStop}
              >
                <StopIcon aria-hidden />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip content={`${sendLabel}(回车)`}>
            <IconButton type="submit" variant="solid" size="2" aria-label={sendLabel} disabled={!canSend}>
              <PaperPlaneIcon aria-hidden />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      {/* 停止的说明已经在上面的 Tooltip 里,这一行只在空闲时教一次快捷键,在跑时不重复它。 */}
      <p className="text-right text-sm text-text-disabled max-sm:hidden">
        {running
          ? mode === "steer"
            ? "插话在下一个回合边界生效,不会打断正在跑的工具调用。"
            : "排队的消息等这一轮跑完按顺序投递。"
          : "Enter 发送 · Shift+Enter 换行"}
      </p>
    </form>
  );
}

/** 头部那一行用量:总数常显,四个分项在提示里。 */
function UsageLine({ usage }: { usage: AgentSession["usage"] }) {
  const n = (value: number): string => value.toLocaleString("zh-CN");
  return (
    <Tooltip
      content={`输入 ${n(usage.inputTokens)} · 输出 ${n(usage.outputTokens)} · 缓存读 ${n(usage.cacheReadTokens)} · 缓存写 ${n(usage.cacheWriteTokens)}`}
    >
      <span className="font-mono tabular-nums underline decoration-dotted underline-offset-2">
        {n(usage.totalTokens)}
      </span>
    </Tooltip>
  );
}

/** 头部那句基点摘要(issue #351,记的是基点)。一个仓库直说分支名;多个仓库都是分支且
    分支名一样就报这一条共同分支;否则只说「基点」,细节留给点开的 popover。 */
function baselineLabel(baselines: readonly AgentSessionBaseline[]): string {
  const first = baselines[0]!;
  if (baselines.length === 1) return `基于 ${first.owner}/${first.repo} 的 ${first.branch}`;
  const sameBranch = baselines.every(
    (baseline) => baseline.kind === "branch" && baseline.branch === first.branch,
  );
  return sameBranch
    ? `基于 ${baselines.length} 个仓库的 ${first.branch}`
    : `基于 ${baselines.length} 个仓库的基点`;
}

/**
 * 基点摘要 + 详情 popover(issue #351、#355、#356)。原先逐仓库一行摊在头部,吃掉太多
 * 垂直空间;折成一句摘要,点开才看每个仓库的短 sha、分支/Tag 与更新动作。「分支」不再
 * 单独出徽标:它是默认情况,只有 Tag 才需要提醒「这一行不会往前走」。没有基点的会话
 * (这一票之前建的)整块不渲染,摆一行「未知」只会让人以为丢了。
 */
function BaselinesSummary({
  baselines,
  mine,
  baselineBusy,
  updating,
  onUpdate,
}: {
  baselines: readonly AgentSessionBaseline[];
  /** 只有能对它说话的人更新得了基点。 */
  mine: boolean;
  baselineBusy: boolean;
  updating: boolean;
  onUpdate: (baseline: AgentSessionBaseline) => void;
}) {
  const [open, setOpen] = useState(false);
  if (baselines.length === 0) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        {/* ghost 键的负外边距会让它在 flex 列里居中,钉回左边与元信息行对齐。 */}
        <Button type="button" variant="ghost" color="gray" size="1" className="self-start">
          <CommitIcon aria-hidden />
          {baselineLabel(baselines)}
        </Button>
      </Popover.Trigger>
      <Popover.Content size="1" align="start" width="360px">
        <ul className="flex flex-col gap-2" aria-label="这个会话的基点">
          {baselines.map((baseline) => (
            <li
              key={`${baseline.owner}/${baseline.repo}`}
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="break-all font-mono text-sm">
                {baseline.owner}/{baseline.repo}
              </span>
              <CommitChip sha={baseline.sha} />
              {baseline.kind === "tag" ? (
                <Badge color="gray" variant="soft">
                  Tag
                </Badge>
              ) : null}
              <span className="break-all text-sm text-text-muted">{baseline.branch}</span>
              {/* Tag 没有「最新」,不出这个动作(issue #356)。 */}
              {mine && baseline.kind === "branch" ? (
                <Tooltip
                  content={
                    baselineBusy
                      ? "会话在跑或还有排队的消息,空闲后才能更新基点"
                      : "把会话基点换成这条分支此刻的最新提交"
                  }
                >
                  <span className="inline-flex">
                    <IconButton
                      type="button"
                      variant="ghost"
                      color="gray"
                      size="1"
                      aria-label="更新到最新提交"
                      disabled={baselineBusy || updating}
                      onClick={() => {
                        setOpen(false);
                        onUpdate(baseline);
                      }}
                    >
                      <UpdateIcon aria-hidden />
                    </IconButton>
                  </span>
                </Tooltip>
              ) : null}
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * 更新基点的确认弹窗(ADR 0034,issue #356)。新 sha 与建会话时的基点行同一读法:先让
 * `/repo-branches?refresh=1` 同步一次远端,再从 `/repo-commits` 取这条分支的第一条提交——只读
 * 缓存的话,刚推上去的提交还不在,弹窗会误说「已经是最新」。已经是最新时确认置灰;接口自己
 * 还会再判一次,这里只是省人一次白点。
 */
function BaselineUpdateDialog({
  baseline,
  pending,
  onClose,
  onConfirm,
}: {
  baseline: AgentSessionBaseline | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (baseline: AgentSessionBaseline) => void;
}) {
  const owner = baseline?.owner ?? "";
  const repo = baseline?.repo ?? "";
  const branch = baseline?.branch ?? "";
  const repoQuery = `owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`;
  const head = useQuery({
    queryKey: ["agent-session-baseline-head", owner, repo, branch],
    queryFn: async () => {
      await fetchJson(`/repo-branches?${repoQuery}&refresh=1`);
      const page = await fetchJson<{ commits: { sha: string }[] }>(
        `/repo-commits?${repoQuery}&branch=${encodeURIComponent(branch)}&offset=0&limit=1`,
      );
      return page.commits[0]?.sha ?? null;
    },
    enabled: baseline !== null,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const latest = baseline !== null && head.data === baseline.sha;
  return (
    <ConfirmDialog
      open={baseline !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="更新会话基点?"
      titleSize="4"
      description={
        latest
          ? "这个仓库的会话基点已经是这条分支的最新提交。"
          : "会话基点换成这条分支此刻的最新提交,回不到旧提交。下一条消息会重建会话。"
      }
      cancelLabel="取消"
      cancelVariant="outline"
      cancelDisabled={pending}
      confirm={{
        label: pending ? "更新中…" : "更新",
        disabled: pending || latest || head.data === undefined || head.data === null,
        onClick: () => {
          if (baseline !== null) onConfirm(baseline);
        },
      }}
    >
      {baseline === null ? null : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-text-muted">仓库</dt>
          <dd className="break-all font-mono">{owner}/{repo}</dd>
          <dt className="text-text-muted">分支</dt>
          <dd className="break-all">{branch}</dd>
          <dt className="text-text-muted">提交</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <CommitChip sha={baseline.sha} />
            <span aria-hidden>→</span>
            {head.isPending ? (
              <Skeleton className="h-4 w-16" />
            ) : head.isError ? (
              <span className="text-danger">{(head.error as Error).message}</span>
            ) : head.data === null ? (
              <span className="text-text-muted">这条分支上没有提交</span>
            ) : (
              <CommitChip sha={head.data} />
            )}
          </dd>
        </dl>
      )}
    </ConfirmDialog>
  );
}

/**
 * 一个 Agent 会话的详情页(原型 A 的三栏工作台,issue #332、#333、#334)。左栏产品与我的
 * 会话、中栏对话流与输入区、右栏产出(issue #336)。
 *
 * 中栏是一块占满视口的工作台:对话流自己滚,输入框钉在底部,整页不滚。高度由壳的 flex 链
 * 给下来(`PageBody` 撑满 `#panel-main-scroll`),不写视口常量。`lg` 以下左栏不显示——切
 * 会话走底部 Tab「产品」回产品页;`xl` 以下右栏产出不显示,头部的「对话 / 产出」切换把产出
 * 换进中栏。
 *
 * 执行中输入框照样能写:发出去的那一条按所选模式排队或插话,停止只中止当前这一步。空闲时
 * 两种模式等同直接开跑,切换因此只在执行中才出现。
 */
export function AgentSessionPage({
  productId,
  sessionId,
  username,
  isSystemAdmin,
  canWrite,
  canChat,
}: {
  productId: number;
  sessionId: number;
  username: string;
  isSystemAdmin: boolean;
  /** 左栏那几个写动作的权限格,与产品页同一份判据。 */
  canWrite: boolean;
  canChat: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** 正在确认更新基点的那一行(issue #356)。null 即弹窗关着。 */
  const [updating, setUpdating] = useState<AgentSessionBaseline | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<QueuedMessage["mode"]>("followUp");
  /** 这一条消息带的图片 id(issue #336)。发出去就清空;移除只是不带它,文件留在会话里。 */
  const [images, setImages] = useState<string[]>([]);
  /** 右栏看的是哪一版产出。null 即最新那一版;点对话流里的产出行切到那一版(issue #337)。 */
  const [outputVersion, setOutputVersion] = useState<number | null>(null);
  /** `xl` 以下中栏放对话还是产出。 */
  const [pane, setPane] = useState<"chat" | "output">("chat");

  const sessionQuery = useQuery({
    queryKey: agentSessionQueryKey(sessionId),
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
  const product = useProductDetail(productId).data?.product;

  const session = sessionQuery.data?.session;
  const queue = sessionQuery.data?.queue ?? [];
  /** 当前辅助模型看不看得了图(issue #336)。读不到时按看不了处理:置灰比白发一次好。 */
  const imageInput = sessionQuery.data?.imageInput ?? false;
  const dropped = sessionQuery.data?.droppedFromContext ?? 0;
  const running = session?.status === "running";
  const mine = session !== undefined && session.createdBy === username;
  /**
   * 产品梳理会话由系统开,没有创建者可言:停止与删除这两个动作给系统管理员(issue #346),
   * 与服务端那一道同一个判据。发消息那几个续谈动作仍谁都做不了,输入区因此照旧只给创建者;
   * 停止键平时在输入区里,对这个用途就摆在头部。
   */
  const surveyAdmin =
    session !== undefined && session.purpose === "product-survey" && isSystemAdmin;
  const hasOutput = session !== undefined && PURPOSE_HAS_OUTPUT[session.purpose];
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: agentSessionQueryKey(sessionId) });
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
  /**
   * 交一轮提问的答案(issue #359)。走与输入区同一个端点,但不经 `post`:那一份会把草稿与
   * 已选的图片清掉——人没发那条草稿,它不该因为答了一轮题就消失。会话此刻空闲,模式取排队。
   */
  const answerRound = async (text: string): Promise<void> => {
    try {
      await send(`/agent-sessions/${sessionId}/messages`, "POST", {
        clientMessageId: crypto.randomUUID(),
        text,
        mode: "followUp",
        images: [],
      });
      setFeedback(null);
      await refresh();
    } catch (error) {
      setFeedback({ text: (error as Error).message, error: true });
    }
  };
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
  const updateBaseline = useMutation({
    mutationFn: (baseline: AgentSessionBaseline) =>
      send(
        `/agent-sessions/${sessionId}/baselines/${encodeURIComponent(baseline.owner)}/${encodeURIComponent(baseline.repo)}/update`,
        "POST",
      ),
    // 头部换成新 sha 靠读新会话;基点更新那一条自己从记录流过来。
    onSuccess: async () => {
      setUpdating(null);
      setFeedback(null);
      await refresh();
    },
    onError: (error: Error) => {
      setUpdating(null);
      setFeedback({ text: error.message, error: true });
    },
  });
  /** 在跑或排着消息时不更新基点(ADR 0034):子进程正在读的工作区不能换。 */
  const baselineBusy = running || queue.length > 0;
  const remove = useMutation({
    mutationFn: () => send(`/agent-sessions/${sessionId}`, "DELETE"),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(productId) });
      // 这一条已经不在了,回产品页;留在这里只会看到一句 404。
      void navigate({ to: "/products/$productId", params: { productId: String(productId) } });
    },
    onError: (error: Error) => {
      setConfirming(false);
      setFeedback({ text: error.message, error: true });
    },
  });

  const loadError = sessionQuery.error;
  const outputPanel =
    session === undefined ? null : (
      <OutputPanel
        sessionId={sessionId}
        canAct={session.createdBy === username}
        running={running}
        picked={outputVersion}
        onPick={setOutputVersion}
      />
    );
  return (
    <PageBody className="h-full pb-6">
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-[18px]">
        {/* 左栏与产品页是同一个组件、同一个位置(spec #349):整屏不滚,左栏自己滚。 */}
        <ProductRail
          productId={productId}
          activeSessionId={sessionId}
          canWrite={canWrite}
          canChat={canChat}
          onFeedback={setFeedback}
          className="max-lg:hidden lg:h-full lg:overflow-y-auto lg:overscroll-y-contain"
        />

        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line pb-3">
            {/* 标题块占满剩余宽度,动作组才留在同一行;窄屏上动作只剩图标,文字给读屏。 */}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {product === undefined ? (
                <Skeleton aria-hidden className="h-4 w-24" />
              ) : (
                // 顶栏面包屑在 lg 起已经带出产品名(DESIGN.md 7.4),这一行只在窄屏
                // 补一个回产品的入口——那一档左栏不显示,切会话就靠它(DESIGN.md 7.5)。
                <Link
                  to="/products/$productId"
                  params={{ productId: String(productId) }}
                  className="w-fit break-all text-sm text-text-muted transition-colors hover:text-text lg:hidden"
                >
                  {product.name}
                </Link>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {/* 标题优先说这个会话在聊什么(`title`,服务端从首条用户消息派生);没有
                    标题的旧会话与开放对话退回用途名。两行封顶,`title=` 补全文,压掉了原本
                    三行标题区吃掉的高度,给对话流多留屏幕。 */}
                <h1
                  className="min-w-0 line-clamp-2 break-words text-2xl font-bold tracking-[-0.015em]"
                  title={session === undefined ? undefined : (session.title ?? PURPOSE_LABEL[session.purpose])}
                >
                  {session === undefined ? "Agent 会话" : (session.title ?? PURPOSE_LABEL[session.purpose])}
                </h1>
                {running ? <StatusBadge tone="running">在跑</StatusBadge> : null}
              </div>
              {session === undefined ? null : (
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-text-muted">
                  {/* 标题已经把用途说没了,元信息行不重复它;标题缺席时 h1 本身就是用途名。
                      克制成一行素文字,不再用 Badge 强调用途——三行封顶,用途只是其中一项元信息。 */}
                  {session.title === null ? `${PURPOSE_LABEL[session.purpose]} · ` : null}
                  {session.createdBy} · {localMinute(session.createdAt)} ·{" "}
                  <UsageLine usage={session.usage} /> token
                </p>
              )}
              <BaselinesSummary
                baselines={session?.baselines ?? []}
                mine={mine}
                baselineBusy={baselineBusy}
                updating={updateBaseline.isPending}
                onUpdate={(baseline) => {
                  setFeedback(null);
                  setUpdating(baseline);
                }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hasOutput ? (
                <SegmentedControl.Root
                  size="1"
                  value={pane}
                  onValueChange={(next) => setPane(next as "chat" | "output")}
                  aria-label="中栏内容"
                  className="xl:hidden"
                >
                  <SegmentedControl.Item value="chat">对话</SegmentedControl.Item>
                  <SegmentedControl.Item value="output">产出</SegmentedControl.Item>
                </SegmentedControl.Root>
              ) : null}
              {surveyAdmin && running ? (
                <Button
                  variant="soft"
                  color="red"
                  size={{ initial: "3", sm: "2" }}
                  disabled={stop.isPending}
                  onClick={() => stop.mutate()}
                >
                  <StopIcon aria-hidden />
                  <span className="max-sm:sr-only">停止</span>
                </Button>
              ) : null}
              {/* 「删会话」是这一页唯一的破坏性动作,收进溢出菜单让头部只剩常用的两个控件。 */}
              {mine || surveyAdmin ? (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    <IconButton
                      type="button"
                      variant="ghost"
                      color="gray"
                      size={{ initial: "3", sm: "2" }}
                      aria-label="更多操作"
                    >
                      <DotsHorizontalIcon aria-hidden />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    <DropdownMenu.Item
                      color="red"
                      disabled={remove.isPending}
                      onSelect={() => {
                        setFeedback(null);
                        setConfirming(true);
                      }}
                    >
                      <TrashIcon aria-hidden />
                      删会话
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              ) : null}
            </div>
          </div>
          {/*
            记录有缺损时头部下面一道横幅(spec #329 的 US 14):agent 忘了哪一段要让人知道,
            而不是默默丢掉。缺损只在重建那一刻定形,条数由服务端按记录算出来。
          */}
          {dropped > 0 ? (
            <Callout.Root role="status" color="amber" size="1" className="mt-3 shrink-0">
              <Callout.Icon>
                <CrossCircledIcon aria-hidden />
              </Callout.Icon>
              <Callout.Text>
                这个会话的记录有缺损:最早的 {dropped} 条不在 agent 的上下文里,它看不到那一段。
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {session === undefined ? (
            <Skeleton aria-hidden className="mt-3 h-40" />
          ) : pane === "output" && hasOutput ? (
            <div className="min-h-0 flex-1 overflow-y-auto py-3 xl:hidden">{outputPanel}</div>
          ) : null}
          {session === undefined ? null : (
            // 对话流与输入区共一个居中限宽的列:1440 下中栏那张卡约 860px,列取 760px 让正文、
            // 表格、代码块与输入框同宽——原先正文卡在 72ch、输入框却铺满,右侧一片空。
            <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col">
              <div
                className={
                  pane === "output" && hasOutput
                    ? "hidden min-h-0 flex-1 flex-col xl:flex"
                    : "flex min-h-0 flex-1 flex-col"
                }
              >
                <Conversation
                  sessionId={sessionId}
                  running={running}
                  canSend={session.createdBy === username}
                  hasBaselines={session.baselines.length > 0}
                  onOpenOutput={(version) => {
                    setOutputVersion(version);
                    setPane("output");
                  }}
                  onAnswerRound={answerRound}
                />
              </div>
              {/* 发消息只有创建者能做:别人读得到这个会话,发不了。 */}
              {session.createdBy === username ? (
                <>
                  {queue.length === 0 ? null : (
                    <div className="shrink-0 pt-3">
                      <QueueBlock
                        queue={queue}
                        busy={clearQueue.isPending}
                        onClear={() => clearQueue.mutate()}
                      />
                    </div>
                  )}
                  <Composer
                    sessionId={sessionId}
                    running={running}
                    mode={mode}
                    onMode={setMode}
                    draft={draft}
                    onDraft={setDraft}
                    images={images}
                    imageInput={imageInput}
                    sending={post.isPending}
                    attaching={attach.isPending}
                    stopping={stop.isPending}
                    onSend={() => post.mutate(draft.trim())}
                    onStop={() => stop.mutate()}
                    onPick={(files) => attach.mutate(files)}
                    onRemove={(imageId) =>
                      setImages((current) => current.filter((id) => id !== imageId))
                    }
                  />
                </>
              ) : (
                /* 没有输入框的两种情况各说一句,不让人对着空白猜自己能不能写。 */
                <p className="shrink-0 border-t border-line pt-3 text-center text-sm text-text-muted">
                  {session.purpose === "product-survey" ? (
                    <>
                      产品梳理由系统发起,不接续写;它交的提案在
                      <Link
                        to="/products/$productId"
                        params={{ productId: String(productId) }}
                        className="text-primary underline underline-offset-4"
                      >
                        产品页
                      </Link>
                      确认或驳回。
                    </>
                  ) : (
                    "只有建立这个会话的账号能续写。"
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        {/* 没有产出类型的用途不渲染右栏,中栏因此占满(开放对话、产品梳理)。 */}
        {hasOutput ? (
          <aside
            aria-label="会话产出"
            className="flex w-full shrink-0 flex-col gap-2.5 max-xl:hidden xl:h-full xl:w-[336px] xl:overflow-y-auto"
          >
            <CardShell className="px-5 py-4">{outputPanel}</CardShell>
          </aside>
        ) : null}
      </div>

      <BaselineUpdateDialog
        baseline={updating}
        pending={updateBaseline.isPending}
        onClose={() => setUpdating(null)}
        onConfirm={(baseline) => updateBaseline.mutate(baseline)}
      />
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
