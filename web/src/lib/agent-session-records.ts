/**
 * Agent 会话记录的对话投影(ADR 0031,issue #333)。
 *
 * 记录表里一行是一条 Pi 会话条目原样的 JSON(`GET /api/agent-sessions/<id>/records`),而中栏
 * 要的是一条条对话:人说的话、agent 回的话、它调了哪个工具。条目类型与内容形状是 Pi 的,
 * 认不出来的一律跳过——后端多落一种条目不该让页面崩,也不该在对话流里摊出一段 JSON。
 *
 * 工具结果不进对话流:人要知道的是「它在读哪个文件」,整段输出属于过程,不属于对话。
 * 系统消息(issue #334 起的 custom 条目)另成一档:它不进模型上下文,但人要看得见。
 * 产出卡片与定稿那一句(issue #337)同理各成一档。
 */

/** 记录表里的一行。`entry` 的形状由 Pi 定,这里只按需要往里看。 */
export type AgentSessionRecord = {
  seq: number;
  type: string;
  at: string;
  entry: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
};

/**
 * 系统消息的 custom 条目类型(ADR 0031,issue #334):人点停止、被排空中止、静默判死与模型
 * 切换都落这一种,不进模型上下文。字面量与 `src/reviewer/session-worker.ts` 那一份相同。
 */
export const SYSTEM_MESSAGE_ENTRY = "multireviewer_system_message";

/**
 * 主进程落的那两种条目的 `customType`(issue #337),与服务端那一份同值:`custom` 是交出一版
 * 产出,`custom_message` 是人做的定稿或换版(它进模型上下文)。
 */
export const AGENT_SESSION_OUTPUT_CUSTOM_TYPE = "multireviewer-session-output";

/** 对话流里的一项。 */
export type ConversationItem =
  | { kind: "user"; seq: number; at: string; text: string }
  | { kind: "assistant"; seq: number; at: string; text: string }
  | { kind: "system"; seq: number; at: string; text: string }
  | { kind: "tool"; seq: number; at: string; name: string; summary: string }
  /** agent 交出了一版产出。点开把右栏切到这一版。 */
  | { kind: "output"; seq: number; at: string; version: number }
  /** 定稿与换版那一句。进了模型上下文,所以它也该在对话里看得见。 */
  | { kind: "note"; seq: number; at: string; text: string };

/** 一条消息的正文:Pi 的 content 既可以是裸字符串,也可以是分块数组。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: unknown) => (part as { type?: unknown } | null)?.type === "text")
    .map((part: unknown) => String((part as { text?: unknown }).text ?? ""))
    .join("")
    .trim();
}

/**
 * 工具调用的参数摘要。一行放得下才有用:超出就截断,完整参数在会话记录里可查。
 */
export function toolSummary(args: unknown): string {
  if (args === undefined || args === null) return "";
  const text =
    typeof args === "string"
      ? args
      : Object.entries(args as Record<string, unknown>)
          .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
          .join(" ");
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
}

/** 系统消息那一条的正文。不是这一种 custom 条目、或者没有正文,都回空串。 */
function systemText(entry: unknown): string {
  const row = entry as { customType?: unknown; data?: { text?: unknown } } | null;
  if (row?.customType !== SYSTEM_MESSAGE_ENTRY) return "";
  return typeof row.data?.text === "string" ? row.data.text.trim() : "";
}

export function conversation(records: readonly AgentSessionRecord[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const record of records) {
    if (record.type === "custom") {
      // 产出卡片(issue #337)与系统消息灰底一行(spec #329)共用 custom 这一档,按 customType
      // 分。认不出 customType 或缺版本号的一律跳过:后端多落一种 custom 条目不该在对话流里
      // 摊出一段 JSON。
      const entry = record.entry as { customType?: unknown; data?: { version?: unknown } } | null;
      if (
        entry?.customType === AGENT_SESSION_OUTPUT_CUSTOM_TYPE &&
        typeof entry.data?.version === "number"
      ) {
        items.push({ kind: "output", seq: record.seq, at: record.at, version: entry.data.version });
        continue;
      }
      const text = systemText(record.entry);
      if (text !== "") items.push({ kind: "system", seq: record.seq, at: record.at, text });
      continue;
    }
    if (record.type === "custom_message") {
      const text = textOf((record.entry as { content?: unknown } | null)?.content);
      if (text !== "") items.push({ kind: "note", seq: record.seq, at: record.at, text });
      continue;
    }
    if (record.type !== "message") continue;
    const message = (record.entry as { message?: { role?: unknown; content?: unknown } } | null)
      ?.message;
    if (message === undefined || message === null) continue;
    const at = record.at;
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text !== "") items.push({ kind: "user", seq: record.seq, at, text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text !== "") items.push({ kind: "assistant", seq: record.seq, at, text });
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      const call = part as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall") continue;
      items.push({
        kind: "tool",
        seq: record.seq,
        at,
        name: String(call.name ?? ""),
        summary: toolSummary(call.arguments),
      });
    }
  }
  return items;
}
