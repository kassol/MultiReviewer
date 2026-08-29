import { useState } from "react";

import { CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Dialog, Skeleton } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/theme-button";
import { num, str } from "@/lib/payload";

import { EventTime, StreamStatus, ToolCall, UnknownEvent, useTrace } from "./run-trace.tsx";

/**
 * 规则轨迹里的一条事件(CONTEXT.md 规则轨迹,issue #214)。与审查轨迹同源,少了轮次与
 * Reviewer 那两格:一条规则轨迹只有一个 agent。`kind` 是开放的字符串,认不出的那条按原样
 * 摊出 payload。
 */
type RuleTraceEvent = {
  seq: number;
  taskId: number;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
};

/** 规则轨迹与修订提案共用的出处文案。同一个二元只有这一份字面量。 */
export const SOURCE_LABEL: Record<string, string> = {
  "baseline-exploration": "基点探索",
  "disposition-feedback": "处置反哺",
};

/** 一条事件的正文。工具调用与认不出的那两档直接用审查轨迹的构件。 */
function RuleEventBody({ event }: { event: RuleTraceEvent }) {
  const payload = event.payload;
  switch (event.kind) {
    case "rule_agent_started": {
      const source = str(payload, "source");
      const baseline = str(payload, "baselineSha");
      const note = str(payload, "note");
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-base text-text">
              {source === null ? "开始" : `${SOURCE_LABEL[source] ?? source}开始`}
            </span>
            {baseline === null ? null : <CommitChip sha={baseline} />}
            {str(payload, "model") === null ? null : (
              <Badge color="gray" variant="soft" radius="full">
                {str(payload, "model")}
              </Badge>
            )}
          </span>
          {note === null ? null : (
            <p className="min-w-0 text-sm break-words text-text-secondary">处置备注：{note}</p>
          )}
        </div>
      );
    }
    case "assistant_message":
      // 整条文本摊开,不截断:这就是「它当时在想什么」的唯一记录。
      return (
        <p className="min-w-0 text-base leading-relaxed break-words whitespace-pre-wrap text-text-secondary">
          {str(payload, "text") ?? "(空文本)"}
        </p>
      );
    case "tool_call":
      return <ToolCall event={event} />;
    case "rule_proposed": {
      const item =
        typeof payload["item"] === "object" && payload["item"] !== null
          ? (payload["item"] as Record<string, unknown>)
          : {};
      const scope = str(item, "scope");
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="min-w-0 text-base break-words text-text">
            {str(item, "statement") ?? "(空陈述)"}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <Badge color="gray" variant="soft" radius="full">提出一条</Badge>
            {str(item, "layer") === null ? null : (
              <Badge color="gray" variant="soft" radius="full">{str(item, "layer")}</Badge>
            )}
            <Badge color="gray" variant="soft" radius="full">{scope ?? "全仓库"}</Badge>
            {item["retire"] === true ? (
              <Badge color="gray" variant="soft" radius="full">废止</Badge>
            ) : null}
          </span>
        </div>
      );
    }
    case "rule_agent_failed":
      return (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>失败：{str(payload, "failure") ?? "未记录原因"}</Callout.Text>
        </Callout.Root>
      );
    case "rule_agent_finished":
      return (
        <span className="text-base text-text">
          完成 · 留下 <span className="font-mono tabular-nums">{num(payload, "items") ?? 0}</span> 条
        </span>
      );
    default:
      return <UnknownEvent event={event} />;
  }
}

/**
 * 一条规则轨迹(issue #214)。历史一次取全,还在跑的接 SSE 实时追加,两者共用审查轨迹
 * 那一份读取(`useTrace`)。
 *
 * 一律接流,不先判「还在不在跑」:跑完的那些服务端回放完就发结束信号,判据因此在服务端
 * 只有一处,面板不必再猜一次。
 */
export function RuleTrace({ repoId, taskId }: { repoId: number; taskId: number }) {
  const { events, query, stream } = useTrace<RuleTraceEvent>({
    queryKey: ["rule-trace", repoId, taskId],
    path: `/repos/${repoId}/rule-traces/${taskId}`,
    live: true,
    // 轨迹跑完的同时产出也落库了,回头重读这个仓库的规则集。
    invalidateOnEnd: [["repo-rules", repoId]],
  });

  return (
    <div className="flex flex-col gap-3">
      {query.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(query.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {stream === "ended" ? null : <StreamStatus stream={stream} />}

      {query.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在加载这一次的规则轨迹</span>
          {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-12" />)}
        </div>
      ) : null}

      {events.length === 0 ? null : (
        <ul className="flex flex-col overflow-hidden rounded-lg border border-overlay-line bg-surface">
          {events.map((event) => (
            <li
              key={event.seq}
              className="flex items-start gap-2 border-t border-overlay-line px-3 py-2 first:border-t-0"
            >
              <EventTime at={event.at} />
              <div className="min-w-0 flex-1"><RuleEventBody event={event} /></div>
            </li>
          ))}
        </ul>
      )}

      {query.data !== undefined && events.length === 0 ? (
        <EmptyState title="这一次没有过程记录" className="py-2" />
      ) : null}
    </div>
  );
}

/**
 * 进入一条规则轨迹的入口:规则集弹窗里的一个按钮加它自己的弹窗(issue #214)。
 *
 * 不新建顶级导航:轨迹回答的是「这个仓库的规则是怎么来的」,与规则集是同一件事的两半。
 */
export function RuleTraceButton({
  repoId,
  taskId,
  label = "查看轨迹",
}: {
  repoId: number;
  taskId: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="ghost" color="gray" size={{ initial: "3", sm: "1" }}>
          {label}
        </Button>
      </Dialog.Trigger>
      {open ? (
        <Dialog.Content
          aria-describedby={undefined}
          maxWidth="680px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
        >
          <Dialog.Title size="4" mb="3" className="pr-9">规则轨迹</Dialog.Title>
          <RuleTrace repoId={repoId} taskId={taskId} />
          <div className="mt-3 flex justify-end">
            <Dialog.Close>
              <Button variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>关闭</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      ) : null}
    </Dialog.Root>
  );
}
