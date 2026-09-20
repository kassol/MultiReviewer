/**
 * Pi 的会话事件到 Reviewer 事件的转换(issue #171,ADR 0017)。
 *
 * 子进程只订阅并转发,不做判断:哪些事件有用、怎么呈现由编排层与面板决定。事件的形状
 * 由本项目定义,Pi 升级只影响这一个文件里认的类型名。
 *
 * 所有进轨迹的文本先过 `redactModelCredential`:失败原文与工具参数都可能回显请求头。
 */
import type { ReviewerEvent, TurnContent, TurnUsage } from "../review/finding.ts";
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

/**
 * 一条 assistant 消息的内容构成(issue #407)。思考只数块数与字数,正文不带出去
 * (ADR 0017)。认不出的块型既不是文本也不是思考也不是工具调用,不计。
 */
export function turnContent(content: unknown): TurnContent {
  const blocks = Array.isArray(content) ? (content as { type?: unknown; thinking?: unknown }[]) : [];
  const tally: TurnContent = { text: 0, thinking: 0, toolCalls: 0, thinkingChars: 0 };
  for (const block of blocks) {
    if (block?.type === "text") tally.text += 1;
    else if (block?.type === "toolCall") tally.toolCalls += 1;
    else if (block?.type === "thinking") {
      tally.thinking += 1;
      if (typeof block.thinking === "string") tally.thinkingChars += block.thinking.length;
    }
  }
  return tally;
}

/** Pi 的 `Usage` 转成轨迹里那四格。缺席即这条消息没带用量。 */
export function turnUsage(usage: unknown): TurnUsage | undefined {
  const record = usage as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null) return undefined;
  const value = (key: string): number =>
    typeof record[key] === "number" ? (record[key] as number) : 0;
  return {
    inputTokens: value("input"),
    outputTokens: value("output"),
    cacheReadTokens: value("cacheRead"),
    cacheWriteTokens: value("cacheWrite"),
  };
}

/** 一条 assistant 消息里说的话。thinking 与 toolCall 块不在其中。 */
function assistantText(content: unknown): string {
  return textBlocks(content).join("\n");
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
  /**
   * 这次调用是不是锚定打回的(issue #187)。打回走正常工具返回而非工具错误,Pi 因此报
   * `isError=false`;不在这里标出来的话,一次被丢掉位置的调用在面板上与一次正常调用
   * 长得一模一样。判断仍在 worker 那边,这一层只按名单标记。
   */
  anchorRejected: (toolCallId: string) => boolean = () => false,
  /**
   * 这次调用派出的子会话自己的事件(issue #227)。取证是唯一会有的一档:子代理跑在另一个
   * 进程里,它的过程只有从这里嵌进来才进得了审查轨迹。取不到就回空数组,那次调用照常记。
   *
   * 与本层其余部分同律,这一层不做判断——从哪里读、怎么读由调用方给。
   */
  nested: (toolName: string, result: unknown) => readonly ReviewerEvent[] = () => [],
): (event: PiSessionEvent) => void {
  const pending = new Map<string, PendingCall>();

  return (event) => {
    if (event.type === "message_end") {
      // 每个回合都落一条,空回合也落(issue #407):一批读完工具结果就无声结束的会话,
      // 轨迹里此前一条痕迹都没有。用户消息与工具返回走的是同一个事件,按 role 挡掉。
      const message = (event as { message: unknown }).message as {
        role?: unknown;
        content?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
        usage?: unknown;
      } | null;
      if (message?.role !== "assistant") return;
      const usage = turnUsage(message.usage);
      emit({
        kind: "assistant_message",
        text: redactModelCredential(assistantText(message.content), credential),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" && message.errorMessage !== ""
          ? { error: redactModelCredential(message.errorMessage, credential) }
          : {}),
        content: turnContent(message.content),
        ...(usage === undefined ? {} : { usage }),
      });
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
    const isError = ended.isError || anchorRejected(ended.toolCallId);
    // 嵌套事件与本层的正文同一道脱敏:子会话的失败原文同样可能回显请求头。
    const children = nested(ended.toolName, ended.result);
    emit({
      kind: "tool_call",
      tool: ended.toolName,
      args: redactedJson(call?.args, credential),
      durationMs: call === undefined ? 0 : now() - call.startedAt,
      isError,
      error: isError ? redactModelCredential(content.join("\n"), credential) : null,
      resultLength,
      ...(children.length === 0
        ? {}
        : { nested: redactedJson(children, credential) as readonly ReviewerEvent[] }),
    });
  };
}
