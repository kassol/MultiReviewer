/**
 * Pi 的会话事件到 Reviewer 事件的转换(issue #171,ADR 0017)。
 *
 * 子进程只订阅并转发,不做判断:哪些事件有用、怎么呈现由编排层与面板决定。事件的形状
 * 由本项目定义,Pi 升级只影响这一个文件里认的类型名。
 *
 * 所有进轨迹的文本先过 `redactModelCredential`:失败原文与工具参数都可能回显请求头。
 */
import type { ReviewerEvent } from "../review/finding.ts";
import { redactModelCredential } from "./env.ts";

/** 只认这里用到的那几个字段。其余事件类型一律不转。 */
type PiSessionEvent =
  | { type: "message_end"; message: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: string };

/** Pi 的文本内容块。工具返回与 assistant 消息用的是同一种。 */
type TextBlock = { type: string; text?: unknown };

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: TextBlock) =>
    block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** 一条 assistant 消息里说的话。thinking 与 toolCall 块不在其中(当前 thinking 关着)。 */
function assistantText(message: unknown): string | undefined {
  const record = message as { role?: unknown; content?: unknown } | null;
  if (record?.role !== "assistant") return undefined;
  const parts = textBlocks(record.content);
  // 只带工具调用的消息常有一个空文本块;它不是「说了话」,不进轨迹。
  const text = parts.join("\n");
  if (text.trim() === "") return undefined;
  return text;
}

/** JSON 化再脱敏。模型给的工具参数一定是 JSON,不会有环。 */
function redactedJson(value: unknown, credential: string | undefined): unknown {
  return JSON.parse(redactModelCredential(JSON.stringify(value ?? null), credential));
}

/** 一次未结束的工具调用:参数与开始时刻。`tool_execution_end` 不带这两样。 */
type PendingCall = { args: unknown; startedAt: number };

/**
 * 建一个会话事件的订阅函数。
 *
 * 有状态:耗时与参数只有 `tool_execution_start` 知道,`tool_execution_end` 里都没有,
 * 因此按 `toolCallId` 记住,配对时取出来。配不上的(订阅晚于开始)按耗时 0、参数 null
 * 记一条——少一条参数好过丢一次工具调用。
 */
export function reviewerEventStream(
  credential: string | undefined,
  emit: (event: ReviewerEvent) => void,
  now: () => number = Date.now,
): (event: PiSessionEvent) => void {
  const pending = new Map<string, PendingCall>();

  return (event) => {
    if (event.type === "message_end") {
      const text = assistantText((event as { message: unknown }).message);
      if (text === undefined) return;
      emit({ kind: "assistant_message", text: redactModelCredential(text, credential) });
      return;
    }

    if (event.type === "tool_execution_start") {
      const started = event as { toolCallId: string; args: unknown };
      pending.set(started.toolCallId, { args: started.args, startedAt: now() });
      return;
    }

    if (event.type !== "tool_execution_end") return;
    const ended = event as {
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
    const call = pending.get(ended.toolCallId);
    pending.delete(ended.toolCallId);

    // 工具返回的正文不进轨迹,只记长度(ADR 0017):把仓库源码复制进面板不是审查轨迹
    // 要回答的问题。被拒时那段文本就是原因,照记——它说明契约在哪一步没对上。
    const content = textBlocks((ended.result as { content?: unknown } | null)?.content);
    const resultLength = content.reduce((sum, text) => sum + text.length, 0);
    emit({
      kind: "tool_call",
      tool: ended.toolName,
      args: redactedJson(call?.args, credential),
      durationMs: call === undefined ? 0 : now() - call.startedAt,
      isError: ended.isError,
      error: ended.isError
        ? redactModelCredential(content.join("\n"), credential)
        : null,
      resultLength,
    });
  };
}
