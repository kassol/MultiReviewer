import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
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
  PersonIcon,
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
  conversation,
  describeTool,
  groupConversation,
  subagentTaskLabel,
  summarizeTools,
  type AgentSessionRecord,
  type ToolCallItem,
  type ToolKind,
  type SubagentRun,
  type ToolStep,
  type ConversationGroup,
} from "@/lib/agent-session-records";
import { productQueryKey } from "@/lib/products";
import { roundAnswerText } from "@/lib/session-question-round";
import {
  agentSessionQueryKey,
  PURPOSE_LABEL,
  sessionsQueryKey,
  sessionTitle,
  type AgentSession,
  type AgentSessionBaseline,
} from "@/lib/agent-sessions";
import { localMinute, localSecond } from "@/lib/time";

import { api, apiUrl, errorText, fetchJson, send } from "./api.ts";
import { ProductRail, useProductDetail } from "./product-rail.tsx";
import { StreamStatus, useTrace } from "./run-trace.tsx";

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
type LiveStream = { text: string; tool?: string; subagent?: SubagentRun[] };

/** 滚动位置距底不超过这个数就算「在看最新」,新条目来了跟着滚。 */
const FOLLOW_THRESHOLD = 80;

/**
 * 对话流与输入区共用的居中限宽列。限宽加在滚动容器**里面**的内容上、不加在滚动容器上:
 * 滚动条因此落在中栏卡片的边上,不贴着消息卡片。
 */
const CHAT_TRACK = "mx-auto w-full max-w-[920px]";

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
  onAnswerRound,
  canSend,
  hasBaselines,
}: {
  sessionId: number;
  running: boolean;
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
      const payload = frame.payload as {
        text?: unknown;
        tool?: unknown;
        subagent?: unknown;
      } | null;
      const text = typeof payload?.text === "string" ? payload.text : "";
      const tool = typeof payload?.tool === "string" ? payload.tool : undefined;
      // 在跑的子代理是现状而不是增量(issue #358):后一帧整份盖掉前一帧。
      const subagent = Array.isArray(payload?.subagent)
        ? (payload.subagent as SubagentRun[])
        : undefined;
      setLive((prev) => {
        const tracked = tool ?? prev?.tool;
        const running = subagent ?? prev?.subagent;
        return {
          text: (prev?.text ?? "") + text,
          ...(tracked === undefined ? {} : { tool: tracked }),
          ...(running === undefined ? {} : { subagent: running }),
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
  const liveSubagents = running ? live?.subagent : undefined;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        // relative:行里的 sr-only 是绝对定位,容器不定位的话它会落到容器外,把整页撑出一段滚动。
        // 「最新」浮标现身时末尾多留一段:浮标是绝对定位的,不留这一段它就盖在最后一条消息上
        // (issue #384)。留白加在内容末尾、人此刻看的那一段之下,`scrollTop` 不动,视野不跳。
        // 留多少:浮标在离底 `FOLLOW_THRESHOLD`(80px)时就现身,自己占底部 56px(12px 边距 +
        // 44px 高),最后一条消息要躲开它,末尾至少要留 80 + 56 = 136px,取 `pb-36`(144px)。
        className={`relative h-full overflow-y-auto overscroll-contain pt-3 ${away ? "pb-36" : "pb-3"}`}
        onScroll={(event) => {
          const el = event.currentTarget;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_THRESHOLD);
        }}
      >
        <div className={`flex min-h-full flex-col gap-3 ${CHAT_TRACK}`}>
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
              // 一轮对话从一条用户消息起。轮内保持原来的密度,轮与轮之间多留一档:一屏里
              // 二三十条消息连着排时,看不出一次提问带出的那几条回复到哪里为止。
              <li
                key={`${item.seq}-${item.kind}`}
                className={item.kind === "user" && index > 0 ? "mt-3 min-w-0" : "min-w-0"}
              >
                <ConversationRow
                  item={item}
                  sessionId={sessionId}
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
        {/* 在跑的子代理(issue #358):跑完那一版由条目接手,这里只画还没落库的这一刻。 */}
        {liveSubagents === undefined ? null : <SubagentCards runs={liveSubagents} />}
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
      </div>
      {away ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute right-5 bottom-3 flex min-h-11 items-center gap-1 rounded-full border border-card-line bg-surface px-4 text-md font-medium text-text-secondary shadow-card transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <ArrowDownIcon aria-hidden />
          最新
        </button>
      ) : null}
    </div>
  );
}

/** 对话流里的一行:人的气泡、agent 的正文、一组工具调用、系统一句、子代理卡片、提问卡片。 */
function ConversationRow({
  item,
  sessionId,
  canAnswerRound,
  onAnswerRound,
  liveTool,
  open = false,
  expanded = false,
  onToggleExpand,
}: {
  item: ConversationGroup;
  sessionId: number;
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
    /* 系统消息(停止、中止、静默死亡、切模型)不是对话的一方,胶囊居中一行(ADR 0031)。 */
    return (
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-sm text-text-secondary">
          <InfoCircledIcon aria-hidden />
          {localSecond(item.at)} · {item.text}
        </span>
      </div>
    );
  }
  if (item.kind === "subagent") {
    return <SubagentCards runs={item.runs} />;
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

/**
 * 「其他」那一项的取值。用不可能与选项文字撞上的哨位(一个 NUL),选项文字因此不必再做转义。
 * 哨位写成转义序列:裸 NUL 会让 git 把整份文件判成二进制,从此 diff 看不了。
 */
const OTHER_OPTION = "\0其他";

/**
 * 一轮提问的选择卡片(CONTEXT.md 提问轮次,issue #359)。材质与 agent 的回复卡同一份
 * (`border-overlay-line` 的内嵌卡):它是 agent 说的一段话,只是这一段要人回答。
 *
 * 推荐项只挂一枚 Badge,不先替人选上(评审复核):这一轮是人的裁决,预选会让一整轮点「提交」
 * 就过去,而那几格算不算他答的分不清。每题末尾多一项「其他」,选中即现一格自填。整轮一次
 * 提交,合成一条普通用户消息走既有的发消息路径(`roundAnswerText`)。
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
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
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
            <li
              key={index}
              className="flex min-w-0 flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0"
            >
              {/* 题目标题此前 13px、题干 14px,标题比它要回答的那句话还小。提一档到题干那一档,
                  轻重仍由字重分。 */}
              <p className="text-lg font-semibold">
                {index + 1}. {question.title}
                {question.multiple ? (
                  <span className="ml-1.5 text-sm font-normal text-text-muted">多选</span>
                ) : null}
              </p>
              {question.body === "" ? null : (
                <p className="max-w-[46em] text-md whitespace-pre-wrap text-text-secondary">{question.body}</p>
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
 * 「复制 Markdown」拿走原文(2 秒后 label 复位,失败照样在这张卡上方弹一条 Callout)。收起时
 * 把卡片顶部滚回可见处:展开是内容变高,不是新消息,不该让人对着一段突然消失在视口上方的
 * 文字发懵。
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
      // 回复正文直接落在对话列上,不套卡:一场会话几十条回复,每条一张白卡就是一面卡片墙,
      // 而真正需要容器的是人的气泡、工具行与提问卡。流式那一版本来就没有卡,落库后也不再跳一下。
      // 折叠、展开与阅读视图的逻辑不变。
      className="group relative flex flex-col px-1 py-1"
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
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent"
          />
        </div>
      ) : (
        <Markdown text={item.text} />
      )}
      {/* 时刻与动作 `md` 起浮在卡片右上沿(指到卡片才现),不在卡底占一行:一句话的回复此前
          下面空着半张卡。折叠态例外——「展开」是找回全文的唯一入口,常显,留在卡底那一行。
          `md` 以下没有 hover,照旧在卡底。 */}
      <div
        className={
          long && !expanded
            ? "mt-1 flex min-h-6 items-center justify-between gap-2 text-sm text-text-muted"
            : "mt-1 flex min-h-6 items-center justify-between gap-2 text-sm text-text-muted md:absolute md:-top-3 md:right-0 md:mt-0 md:gap-4 md:rounded-md md:border md:border-overlay-line md:bg-surface md:px-3 md:opacity-0 md:shadow-control md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100"
        }
      >
        <MessageTime at={item.at} />
        {/* ghost 键的 hover 底靠负外边距向四周撑出 8px,相邻两颗要留 gap-5 才不会叠在一起。
            「阅读」「复制 Markdown」与已展开状态下的「收起」只在指到卡片时现,同 `MessageTime`
            的规则;折叠态的「展开」是找回全文的唯一入口,常显不进 hover 组。
            sm 以下三颗带文字要 234px、卡里只有 226px,「复制 Markdown」被切掉一半:那一档
            只留图标,文字用 `sr-only` 留给读屏,键距同步收一档(issue #384)。 */}
        <div className="flex items-center gap-5 max-sm:gap-3">
          {long && !expanded ? (
            <Button type="button" variant="ghost" color="gray" size="1" onClick={onToggleExpand}>
              <ChevronDownIcon aria-hidden />
              <span className="max-sm:sr-only">展开</span>
            </Button>
          ) : null}
          <div className="flex items-center gap-5 transition-opacity max-sm:gap-3 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            {long && expanded ? (
              <Button type="button" variant="ghost" color="gray" size="1" onClick={onToggleExpand}>
                <ChevronDownIcon aria-hidden />
                <span className="max-sm:sr-only">收起</span>
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
                <span className="max-sm:sr-only">阅读</span>
              </Button>
            ) : null}
            <Button type="button" variant="ghost" color="gray" size="1" onClick={() => void copy()}>
              {copied ? <CheckCircledIcon aria-hidden /> : <CopyIcon aria-hidden />}
              <span className="max-sm:sr-only">{copied ? "已复制" : "复制 Markdown"}</span>
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

/**
 * 一次派单里的那几个会话子代理(issue #358)。一趟一张嵌套卡片:卡头是任务、状态与步数,
 * 展开是它逐步调过的工具(与父会话的工具行同一份 `ToolRow`),卡底是它交回来的结论。
 * 跑完的卡片收成结论一句,展开才看过程;并行派出的几趟并排。
 */
function SubagentCards({ runs }: { runs: readonly SubagentRun[] }) {
  return (
    <ul
      className={`grid min-w-0 gap-2 ${runs.length > 1 ? "sm:grid-cols-2" : ""}`}
      aria-label="会话子代理"
    >
      {runs.map((run, index) => (
        <li key={`${index}-${run.task}`} className="min-w-0">
          <SubagentCard run={run} />
        </li>
      ))}
    </ul>
  );
}

function SubagentCard({ run }: { run: SubagentRun }) {
  const [expanded, setExpanded] = useState(false);
  /** 结论也会长成一篇文档。与 agent 回复卡同一道阈值、同一种收法,不另立一套规则。 */
  const [readingAll, setReadingAll] = useState(false);
  const longConclusion = isLongReply(run.conclusion);
  const failed = run.status === "failed";
  return (
    <Collapsible.Root
      open={expanded}
      onOpenChange={setExpanded}
      className="group/subagent flex min-w-0 flex-col rounded-lg border border-card-line bg-surface"
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-4 py-2.5 text-left text-base transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          {run.status === "running" ? (
            <Spinner size="1" className="shrink-0" />
          ) : (
            <ChevronRightIcon
              aria-hidden
              className="shrink-0 text-text-muted transition-transform group-data-[state=open]/subagent:rotate-90"
            />
          )}
          <PersonIcon aria-hidden className="shrink-0 text-text-muted" />
          {/* 卡头一行只装得下一句,派单提示开头那段铺装说明因此裁掉;全文留在 `title` 上。 */}
          <span className="min-w-0 flex-1 truncate text-text" title={run.task}>
            {run.task === "" ? "子代理" : subagentTaskLabel(run.task)}
          </span>
          <span className="shrink-0 text-sm tabular-nums text-text-muted">
            {run.status === "running" ? "在跑 · " : failed ? "失败 · " : ""}
            {run.steps} 步
          </span>
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="collapsible-motion">
        <ol
          className="mx-4 mb-1 flex min-w-0 flex-col border-l border-line pl-3"
          aria-label="子代理的工具调用"
        >
          {run.calls.map((call, index) => (
            <ToolRow
              key={`${index}-${call.name}`}
              step={describeTool(call.name, call.args)}
              error={call.error}
            />
          ))}
        </ol>
      </Collapsible.Content>
      {run.conclusion === "" ? null : (
        <div
          className={`flex min-w-0 flex-col border-t border-card-line px-4 py-3 ${failed ? "text-danger" : ""}`}
        >
          {longConclusion && !readingAll ? (
            <div className="relative max-h-[320px] overflow-hidden">
              <Markdown text={run.conclusion} />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent"
              />
            </div>
          ) : (
            <Markdown text={run.conclusion} />
          )}
          {longConclusion ? (
            <div className="mt-1 flex">
              <Button
                type="button"
                variant="ghost"
                color="gray"
                size="1"
                onClick={() => setReadingAll((open) => !open)}
              >
                <ChevronDownIcon aria-hidden />
                {readingAll ? "收起" : "展开"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Collapsible.Root>
  );
}

/**
 * 每类工具调用的图标:读文件、搜内容、列目录、git、两种查询、产品知识的读写、派子代理、
 * 产品 tracker 的读写、交产出与提问轮次(DESIGN.md 7.5)。
 */
const TOOL_ICONS: Record<ToolKind, typeof FileTextIcon> = {
  read: FileTextIcon,
  grep: MagnifyingGlassIcon,
  find: MagnifyingGlassIcon,
  ls: ListBulletIcon,
  git: CommitIcon,
  findings: CounterClockwiseClockIcon,
  knowledge: ReaderIcon,
  subagent: PersonIcon,
  tracker: PaperPlaneIcon,
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
        {/* 这一行是原生 button,styles.css 的 coarse 块只盖 Radix 控件,命中区在这里自己给:
            26px 高的折叠行在触屏上按不准(issue #384)。判据同 DESIGN.md「触控」,看输入方式
            不看屏宽——细指针上这一行仍是紧凑的一行。 */}
        <button
          type="button"
          className="flex max-w-full items-center gap-1.5 rounded-md py-1 pr-2 pl-1 text-text-secondary transition-colors pointer-coarse:min-h-11 hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
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
      <Collapsible.Content className="collapsible-motion">
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

/** 这个会话写进产品 tracker 的 spec 与票(issue #366)。读会话那一份带着它一起回。 */
type SessionWrote = {
  specs: readonly { id: number; title: string }[];
  tickets: readonly { id: number; title: string }[];
};

const EMPTY_WROTE: SessionWrote = { specs: [], tickets: [] };

/**
 * 右栏:本会话写进产品 tracker 的 spec 与票(CONTEXT.md 产品 tracker,issue #366)。
 *
 * 只列标题,点一条去产品页——正文、认领、改标签、开关与评论都在那里,这里再放一份只会分叉。
 * 不另开查询:读会话那一份带着它回,在跑时的续查因此就是这一栏的刷新。
 */
function WrotePanel({ productId, wrote }: { productId: number; wrote: SessionWrote }) {
  /*
   * spec 那几行链接带上 `?spec=`:产品页落地即展开那一条的全文弹窗,不用人在 tracker 区里
   * 再找一遍。票那几行不带——读会话那一份只给票的 id 与标题,它属于哪条 spec 服务端没回,
   * 点过去落在产品页的 tracker 区上。
   */
  const rows: { key: string; label: string; title: string; spec?: number }[] = [
    ...wrote.specs.map((spec) => ({
      key: `spec-${spec.id}`,
      label: "spec",
      title: spec.title,
      spec: spec.id,
    })),
    ...wrote.tickets.map((ticket) => ({
      key: `ticket-${ticket.id}`,
      label: `#${ticket.id}`,
      title: ticket.title,
    })),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className="text-2xl font-bold tracking-[-0.015em]">本会话写的 spec 与票</h2>
      {/* 行与行之间一根发丝线,不给每行再套一层带边的盒子:这一栏本身已经是一张卡。 */}
      <ul className="-mx-2 flex flex-col">
        {rows.map((row) => (
          <li key={row.key} className="border-t border-line first:border-t-0">
            <Link
              to="/products/$productId"
              params={{ productId: String(productId) }}
              search={row.spec === undefined ? {} : { spec: row.spec }}
              className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <Badge color="gray" variant="soft" className="shrink-0">
                {row.label}
              </Badge>
              <span className="min-w-0 break-words text-base">{row.title}</span>
            </Link>
          </li>
        ))}
      </ul>
      <Text as="p" size="1" color="gray">
        正文、认领、改标签与评论在产品页的产品 tracker 区。
      </Text>
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
            {/* 禁用态换成淡蓝 tint 底加弱文字色:Themes 给实心键的禁用态是 12% 灰底加
                `--v8-text-faint` 的图标,在白底的输入框里几乎看不出还有这么一颗键,空着的
                会话因此像没有发送入口。这是唯一一处覆写 Themes 的禁用态(DESIGN.md 7.5)。 */}
            <IconButton
              type="submit"
              variant="solid"
              size="2"
              aria-label={sendLabel}
              disabled={!canSend}
              className="disabled:bg-accent-tint disabled:text-text-muted"
            >
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
      {/* 宽度不写死:360px 的浮层在 360px 的屏上要出界 10px(issue #384)。给上界,窄屏跟着屏走。 */}
      <Popover.Content size="1" align="start" maxWidth="calc(100vw - 16px)">
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
  canWrite,
  canChat,
}: {
  productId: number;
  sessionId: number;
  username: string;
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
  /** `xl` 以下中栏放对话还是这个会话写下的 spec 与票。 */
  const [pane, setPane] = useState<"chat" | "wrote">("chat");
  /** `sm` 以下头部那几行元信息是否摊开(issue #384)。`sm` 起这一位不起作用,元信息常显。 */
  const [metaOpen, setMetaOpen] = useState(false);

  const sessionQuery = useQuery({
    queryKey: agentSessionQueryKey(sessionId),
    queryFn: () =>
      fetchJson<{
        session: AgentSession;
        queue: QueuedMessage[];
        imageInput: boolean;
        /** 重建之后前几条进不了模型上下文(ADR 0031,issue #335)。0 即记录完整。 */
        droppedFromContext: number;
        /** 这个会话写进产品 tracker 的 spec 与票(issue #366)。 */
        wrote: SessionWrote;
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
  /** 这一场产品梳理已经谈完(CONTEXT.md 产品梳理,issue #365)。会话照旧读得到、续得了。 */
  const surveyDone = session !== undefined && session.completedAt !== null;
  /**
   * 一个回合跑完就让产品详情那一份过期(issue #365)。会话里 agent 把答案当场写成产品知识
   * 条目,而产品详情是左栏与产品页共用的那一份缓存:不失效,人回到产品页看到的还是进来
   * 之前的那几条。用途不分:知识工具在哪个用途都注册着。
   */
  useEffect(() => {
    if (running) return;
    void queryClient.invalidateQueries({ queryKey: productQueryKey(productId) });
  }, [running, productId, queryClient]);
  /**
   * 这个会话写下的 spec 与票(issue #366)。右栏按它列,一条都没写下时整块不渲染——哪些
   * 用途写得出来不另存一张表:写下了就有,没写下就没有,开放对话走同一条流程时一样成立。
   */
  const wrote = sessionQuery.data?.wrote ?? EMPTY_WROTE;
  const hasWrote = wrote.specs.length + wrote.tickets.length > 0;
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
  const wrotePanel = <WrotePanel productId={productId} wrote={wrote} />;
  // sm 以下页头留白收到 16px:390px 上顶栏、输入区与 Tab 栏已固定吃掉 245px,余下的
  // 每一段留白都从对话流里扣(issue #384)。sm 起照常 24px。底部留白也收一档:输入区自己
  // 是这一页的底,`PageBody` 默认那段为滚到底的最后一张卡留的空在这里只是把输入区顶上去。
  return (
    <PageBody className="h-full pt-4 pb-4 sm:pt-6">
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
          <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line pb-2 sm:pb-3">
            {/* 标题块占满剩余宽度,动作组才留在同一行;窄屏上动作只剩图标,文字给读屏。 */}
            <div className="flex min-w-0 flex-1 items-start gap-1.5">
              {product === undefined ? (
                <Skeleton aria-hidden className="h-4 w-24 shrink-0 lg:hidden" />
              ) : (
                // 顶栏面包屑在 lg 起已经带出产品名(DESIGN.md 7.4),这一颗只在窄屏
                // 补一个回产品的入口——那一档左栏不显示,切会话就靠它(DESIGN.md 7.5)。
                // 原先是一行 17px 高的面包屑文字,按不准也占一行;换成头部起始的键,触屏上
                // 由 coarse 块撑到 44px,sm 以下只剩箭头,标题与徽章因此收在同一行(issue #384)。
                <Button
                  asChild
                  variant="ghost"
                  color="gray"
                  size="2"
                  className="shrink-0 lg:hidden"
                  aria-label={`返回产品 ${product.name}`}
                >
                  <Link to="/products/$productId" params={{ productId: String(productId) }}>
                    <ArrowLeftIcon aria-hidden />
                    <span className="break-all max-sm:hidden">{product.name}</span>
                  </Link>
                </Button>
              )}
              {/* sm 以下元信息收进 disclosure:时刻、建立人、用量与基点摊开吃掉三行,390px 上
                  对话流只剩 57% 的屏(issue #384)。sm 起照常摊开,开关不出现。 */}
              <Collapsible.Root
                open={metaOpen}
                onOpenChange={setMetaOpen}
                className="group/meta flex min-w-0 flex-1 flex-col gap-0.5"
              >
                {/* sm 以下这一行不许折:标题、徽章与开关一旦换行,折叠态头部就从 44px
                    涨到 100px 上下。标题让位截断,徽章与开关保持整颗(issue #384)。 */}
                <div className="flex flex-wrap items-center gap-2 max-sm:flex-nowrap">
                  {/* 标题优先说这个会话在聊什么(`title`,服务端从首条用户消息派生);没有
                      标题的旧会话与开放对话退回用途名。sm 以下单行截断,sm 起两行封顶,
                      `title=` 补全文——标题区不再吃掉三行高度,屏幕留给对话流。 */}
                  <h1
                    className="min-w-0 line-clamp-1 break-words text-2xl font-bold tracking-[-0.015em] sm:line-clamp-2"
                    title={
                      session === undefined
                        ? undefined
                        : sessionTitle(session.title, PURPOSE_LABEL[session.purpose])
                    }
                  >
                    {session === undefined
                      ? "Agent 会话"
                      : sessionTitle(session.title, PURPOSE_LABEL[session.purpose])}
                  </h1>
                  {running ? <StatusBadge tone="running">在跑</StatusBadge> : null}
                  {surveyDone ? <StatusBadge tone="success">已谈完</StatusBadge> : null}
                  {/* 还没读到会话时元信息整块是空的,不摆一颗开不出东西的开关。 */}
                  {session === undefined ? null : (
                    <Collapsible.Trigger asChild>
                      <IconButton
                        type="button"
                        variant="ghost"
                        color="gray"
                        size="3"
                        className="shrink-0 sm:hidden"
                        aria-label="会话信息"
                      >
                        <ChevronDownIcon
                          aria-hidden
                          className="transition-transform group-data-[state=open]/meta:rotate-180"
                        />
                      </IconButton>
                    </Collapsible.Trigger>
                  )}
                </div>
                {/* `forceMount` 让这一段一直挂着,显隐交给断点:sm 起不管开合都摊开,sm 以下
                    才听上面那颗开关。用 JS 按屏宽算开合的话,转屏那一下还要再算一次。 */}
                <Collapsible.Content
                  forceMount
                  className="flex min-w-0 flex-col gap-0.5 max-sm:data-[state=closed]:hidden"
                >
                  {session === undefined ? null : (
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-text-muted">
                      {/* 标题已经把用途说没了,元信息行不重复它;标题缺席时 h1 本身就是用途名。
                          克制成一行素文字,不再用 Badge 强调用途——三行封顶,用途只是其中一项元信息。 */}
                      {/* 日志、数据库与 API 都按会话的全局 id 索引,口头排障报的号要在
                          面板上找得到,因此放在元信息的第一项。 */}
                      <span className="font-mono tabular-nums">会话 #{session.id}</span> ·{" "}
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
                </Collapsible.Content>
              </Collapsible.Root>
            </div>
            {/* sm 以下这层壳换成 `contents`:两颗控件升成头部那层 flex 的直接子项,
                分段控件才能凭 `w-full` 自己占一行,「更多操作」留在标题这一行。sm 起壳
                照常是一行(issue #388)。 */}
            <div className="flex shrink-0 items-center gap-2 max-sm:contents">
              {hasWrote ? (
                // sm 以下分段控件让开标题行:162px 的它与返回、更多操作三件挤在一行时,
                // 390px 上标题只剩 27px。`order-last` 把它排到「更多操作」之后,`w-full`
                // 逼它换行,于是成为头部正下方的整行(issue #388)。
                <SegmentedControl.Root
                  size={{ initial: "3", sm: "1" }}
                  value={pane}
                  onValueChange={(next) => setPane(next as "chat" | "wrote")}
                  aria-label="中栏内容"
                  className="max-sm:order-last max-sm:w-full xl:hidden"
                >
                  <SegmentedControl.Item value="chat">对话</SegmentedControl.Item>
                  <SegmentedControl.Item value="wrote">spec 与票</SegmentedControl.Item>
                </SegmentedControl.Root>
              ) : null}
              {/* 「删会话」是这一页唯一的破坏性动作,收进溢出菜单让头部只剩常用的两个控件。 */}
              {mine ? (
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
            <Callout.Root role="status" color="amber" size="1" className="mt-2 shrink-0 sm:mt-3">
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
          ) : pane === "wrote" && hasWrote ? (
            <div className="min-h-0 flex-1 overflow-y-auto py-3 xl:hidden">{wrotePanel}</div>
          ) : null}
          {session === undefined ? null : (
            // 对话流与输入区同宽(`CHAT_TRACK`):正文、表格、代码块与输入框对齐在同一列上。
            <div className="flex min-h-0 flex-1 flex-col">
              <div
                className={
                  pane === "wrote" && hasWrote
                    ? "hidden min-h-0 flex-1 flex-col xl:flex"
                    : "flex min-h-0 flex-1 flex-col"
                }
              >
                <Conversation
                  sessionId={sessionId}
                  running={running}
                  canSend={session.createdBy === username}
                  hasBaselines={session.baselines.length > 0}
                  onAnswerRound={answerRound}
                />
              </div>
              {/* 发消息只有创建者能做:别人读得到这个会话,发不了。 */}
              {session.createdBy === username ? (
                <div className={`shrink-0 ${CHAT_TRACK}`}>
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
                </div>
              ) : (
                /* 没有输入框时说一句,不让人对着空白猜自己能不能写。 */
                <p className="shrink-0 border-t border-line pt-3 text-center text-sm text-text-muted">
                  只有建立这个会话的账号能续写。
                </p>
              )}
            </div>
          )}
        </div>

        {/* 一条 spec 与票都没写下的会话不渲染右栏,中栏因此占满。 */}
        {hasWrote ? (
          <aside
            aria-label="本会话写的 spec 与票"
            className="flex w-full shrink-0 flex-col gap-2.5 max-xl:hidden xl:h-full xl:w-[336px] xl:overflow-y-auto"
          >
            <CardShell className="px-5 py-4">{wrotePanel}</CardShell>
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
        description="会话的记录与图片一并删除,不可撤销。它写下的 spec 与票留在产品 tracker 里。"
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
