/**
 * Agent 会话记录的对话投影(ADR 0031,issue #333)。
 *
 * 记录表里一行是一条 Pi 会话条目原样的 JSON(`GET /api/agent-sessions/<id>/records`),而中栏
 * 要的是一条条对话:人说的话、agent 回的话、它调了哪个工具。条目类型与内容形状是 Pi 的,
 * 认不出来的一律跳过——后端多落一种条目不该让页面崩,也不该在对话流里摊出一段 JSON。
 *
 * 工具结果不进对话流:人要知道的是「它在读哪个文件」,整段输出属于过程,不属于对话。
 * 系统消息(issue #334 起的 custom 条目)另成一档:它不进模型上下文,但人要看得见。
 * 产出卡片与定稿那一句(issue #337)同理各成一档,提问轮次的选择卡片(issue #359)也是。
 */
import {
  parseQuestionRound,
  roundAnswersFrom,
  type QuestionRound,
} from "./session-question-round.ts";

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

/** 基点更新那一条 `custom_message` 的类型(issue #356),与服务端同值。 */
export const AGENT_SESSION_BASELINE_UPDATE_CUSTOM_TYPE = "multireviewer-session-baseline-update";

/**
 * 一次会话子代理派单那条 `custom` 条目的类型(issue #358),与服务端同值。子会话的过程只在
 * 子进程那一侧读得到,跑完当场落成这一条;面板的嵌套卡片从它重画。
 */
export const AGENT_SESSION_SUBAGENT_ENTRY = "multireviewer-session-subagent";

/** 一次派单里一个子代理跑的那一趟。字段与 `src/reviewer/session-subagent.ts` 那一份同形。 */
export type SubagentRun = {
  task: string;
  status: "running" | "done" | "failed";
  steps: number;
  calls: { name: string; args: unknown; error?: string }[];
  conclusion: string;
};

/** 提问轮次那一条 `custom` 的类型(CONTEXT.md 提问轮次,issue #359),与服务端同值。 */
export const AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE = "multireviewer-session-question-round";

/** 对话流里的一项。 */
export type ConversationItem =
  /** `images` 是这条消息带的图片 id(issue #336),按它取缩略图。没带图即空数组。 */
  | { kind: "user"; seq: number; at: string; text: string; images: string[] }
  | { kind: "assistant"; seq: number; at: string; text: string }
  | { kind: "system"; seq: number; at: string; text: string }
  /**
   * 一次工具调用。`step` 是人读的「动词 + 对象」(读取 a.ts、git log …),`error` 是这次调用
   * 失败时结果的第一行——结果全文仍不进对话流,人只需要知道它没成。
   */
  | { kind: "tool"; seq: number; at: string; id: string; name: string; step: ToolStep; error?: string }
  /** agent 交出了一版产出。点开把右栏切到这一版。 */
  | { kind: "output"; seq: number; at: string; version: number }
  /**
   * 一次会话子代理派单(issue #358)。一次调用可以并行派几趟,因此是数组:面板把它们并排
   * 成几张嵌套卡片。
   */
  | { kind: "subagent"; seq: number; at: string; runs: SubagentRun[] }
  /** 定稿与换版那一句。进了模型上下文,所以它也该在对话里看得见。 */
  | { kind: "note"; seq: number; at: string; text: string }
  /**
   * agent 抛出的一轮提问(CONTEXT.md 提问轮次,issue #359)。三态由它后面那条用户消息定:
   * 还没有即可答(两格都缺席),是这一轮的答案即已答(`answers`),是别的话即过期(`expired`)。
   */
  | {
      kind: "round";
      seq: number;
      at: string;
      round: QuestionRound;
      answers?: string[][];
      expired?: true;
    };

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
 * 这条消息带的图片 id(issue #336)。记录里的图片块只存文件引用(`image-ref`),base64 不落库
 * ——面板按 id 去 `GET /agent-sessions/<id>/images/<图片 id>` 取文件。
 */
function imageIdsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: unknown) => (part as { type?: unknown } | null)?.type === "image-ref")
    .map((part: unknown) => String((part as { imageId?: unknown }).imageId ?? ""))
    .filter((imageId) => imageId !== "");
}

/** 工具调用的类别:图标与组头计数按它分。会话注册的工具见 `src/reviewer/session-worker.ts`。 */
export type ToolKind =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "git"
  | "findings"
  | "knowledge"
  | "subagent"
  | "submit"
  | "round"
  | "other";

/** 一次工具调用的人读形式:`label` 是动词,`target` 是它作用的对象(路径、模式、git 参数)。 */
export type ToolStep = { kind: ToolKind; label: string; target: string };

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * 把工具名与参数翻成「动词 + 对象」。参数形状由各工具的 schema 定:只读四件套是 Pi 内建
 * (`path` / `pattern` / `glob` / `offset` / `limit`),git 是 `args` 数组,两种查询按仓库,
 * 产出工具的参数是整份产出,一行摊不下也没必要摊——产出卡片自己会出现在对话流里。
 * 认不出的工具退回 `name` 加参数摘要。
 */
export function describeTool(name: string, args: unknown): ToolStep {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read": {
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      const range =
        offset === undefined && limit === undefined
          ? ""
          : ` L${offset ?? 1}${limit === undefined ? "-" : `-${(offset ?? 1) + limit - 1}`}`;
      return { kind: "read", label: "读取", target: `${str(a.path)}${range}` };
    }
    case "grep": {
      const where = [str(a.path), str(a.glob)].filter((part) => part !== "").join(" ");
      return { kind: "grep", label: "搜索", target: where === "" ? str(a.pattern) : `${str(a.pattern)} 于 ${where}` };
    }
    case "find": {
      const path = str(a.path);
      return { kind: "find", label: "查找文件", target: path === "" ? str(a.pattern) : `${str(a.pattern)} 于 ${path}` };
    }
    case "ls":
      return { kind: "ls", label: "列目录", target: str(a.path) || "." };
    case "git":
      return { kind: "git", label: "git", target: Array.isArray(a.args) ? a.args.map(String).join(" ") : "" };
    case "query_findings":
      return { kind: "findings", label: "查历史 Finding", target: str(a.repo) };
    case "query_knowledge":
      return {
        kind: "knowledge",
        label: "查产品知识",
        target: Array.isArray(a.repos) ? a.repos.map(String).join("、") : "",
      };
    case "subagent": {
      // 派单可以是一句 `task`,也可以是 `tasks[]` 几句一起派(issue #358)。过程与结论在
      // 紧跟着的那张嵌套卡片上,这一行只说派了什么。
      const tasks = Array.isArray(a.tasks)
        ? a.tasks.map((task: unknown) => str((task as { task?: unknown } | null)?.task))
        : [str(a.task)];
      return {
        kind: "subagent",
        label: "派子代理",
        target: tasks.filter((task) => task !== "").join("、"),
      };
    }
    case "ask_question_round":
      // 题目本身紧跟着以卡片出现在对话流里,这一行只报「问了几题」(issue #359)。
      return {
        kind: "round",
        label: "提问",
        target: Array.isArray(a.questions) ? `${a.questions.length} 题` : "",
      };
    default:
      if (name.startsWith("submit_")) return { kind: "submit", label: "提交产出", target: "" };
      return { kind: "other", label: name, target: toolSummary(args) };
  }
}

/**
 * 一组工具调用的组头:按动词计数,次数多的在前——「读取 5 个文件、git 3 次、列目录 2 个目录」。
 * 读取与列目录按对象去重,是因为同一个文件读两遍在人眼里仍是一个文件。超过三类只列前
 * 三类,余下折成「等 N 步」,组头一行放得下。
 */
export function summarizeTools(steps: readonly ToolStep[]): string {
  const rows = new Map<ToolKind, { label: string; targets: Set<string>; calls: number }>();
  for (const step of steps) {
    const row = rows.get(step.kind) ?? { label: step.label, targets: new Set<string>(), calls: 0 };
    row.targets.add(step.target);
    row.calls += 1;
    rows.set(step.kind, row);
  }
  // 次数多的排前面:一组几十步里人先要知道的是它主要在干什么,不是它第一步干了什么。
  const entries = [...rows.entries()].sort(([, a], [, b]) => b.calls - a.calls);
  const shown = entries.slice(0, 3).map(([kind, row]) => {
    if (kind === "read") return `${row.label} ${row.targets.size} 个文件`;
    if (kind === "ls") return `${row.label} ${row.targets.size} 个目录`;
    return `${row.label} ${row.calls} 次`;
  });
  const rest = entries.slice(3).reduce((sum, [, row]) => sum + row.calls, 0);
  return rest === 0 ? shown.join("、") : `${shown.join("、")}等 ${rest} 步`;
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

/** 对话流渲染用的一项:连续的工具调用折成一组,其余原样(会话页的工具调用组)。 */
export type ConversationGroup =
  | Exclude<ConversationItem, { kind: "tool" }>
  | { kind: "tools"; seq: number; at: string; calls: Extract<ConversationItem, { kind: "tool" }>[] };

/** 对话流里的一次工具调用。 */
export type ToolCallItem = Extract<ConversationItem, { kind: "tool" }>;

/**
 * 把连续的 `tool` 条目折成一组。一个回合几十次读文件逐行摊开会把对话冲散;一组一行,展开
 * 才看明细。组的 `seq` 与 `at` 取第一次调用的。
 */
export function groupConversation(items: readonly ConversationItem[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (item.kind !== "tool") {
      groups.push(item);
    } else if (last?.kind === "tools") {
      last.calls.push(item);
    } else {
      groups.push({ kind: "tools", seq: item.seq, at: item.at, calls: [item] });
    }
  }
  return groups;
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
      // 会话子代理派单那一条(issue #358):跑过的那几趟原样带出来,面板并排成嵌套卡片。
      // 认不出形状的一律跳过,与别的 custom 条目同律。
      if (entry?.customType === AGENT_SESSION_SUBAGENT_ENTRY) {
        const runs = (entry.data as { runs?: unknown } | undefined)?.runs;
        if (Array.isArray(runs) && runs.length > 0) {
          items.push({
            kind: "subagent",
            seq: record.seq,
            at: record.at,
            runs: runs as SubagentRun[],
          });
        }
        continue;
      }
      if (entry?.customType === AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE) {
        const round = parseQuestionRound(entry.data);
        if (round !== undefined) {
          items.push({ kind: "round", seq: record.seq, at: record.at, round });
        }
        continue;
      }
      const text = systemText(record.entry);
      if (text !== "") items.push({ kind: "system", seq: record.seq, at: record.at, text });
      continue;
    }
    if (record.type === "custom_message") {
      // 基点更新按系统消息那一档渲染(issue #356):它说的是会话读的代码换了,不是谁说的一句话。
      // 摆「仓库 旧 sha → 新 sha」,取 details 而不是那句给模型读的正文。
      const baseline = record.entry as {
        customType?: unknown;
        details?: { repo?: unknown; branch?: unknown; from?: unknown; to?: unknown };
      } | null;
      const details = baseline?.details;
      if (
        baseline?.customType === AGENT_SESSION_BASELINE_UPDATE_CUSTOM_TYPE &&
        typeof details?.repo === "string" &&
        typeof details.from === "string" &&
        typeof details.to === "string"
      ) {
        const branch = typeof details.branch === "string" ? `(${details.branch})` : "";
        items.push({
          kind: "system",
          seq: record.seq,
          at: record.at,
          text: `基点更新 ${details.repo}${branch} ${details.from.slice(0, 7)} → ${details.to.slice(0, 7)}`,
        });
        continue;
      }
      const text = textOf((record.entry as { content?: unknown } | null)?.content);
      if (text !== "") items.push({ kind: "note", seq: record.seq, at: record.at, text });
      continue;
    }
    if (record.type !== "message") continue;
    const message = (record.entry as { message?: { role?: unknown; content?: unknown } } | null)
      ?.message;
    if (message === undefined || message === null) continue;
    const at = record.at;
    if (message.role === "toolResult") {
      // 结果不进对话流,只把失败记到它对应的那次调用上(按 toolCallId 配对)。
      const result = message as { toolCallId?: unknown; isError?: unknown; content?: unknown };
      if (result.isError !== true) continue;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const call = items[index]!;
        if (call.kind !== "tool" || call.id !== result.toolCallId) continue;
        call.error = textOf(result.content).split("\n")[0] ?? "";
        break;
      }
      continue;
    }
    if (message.role === "user") {
      const text = textOf(message.content);
      const images = imageIdsOf(message.content);
      if (text !== "" || images.length > 0) {
        items.push({ kind: "user", seq: record.seq, at, text, images });
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text !== "") items.push({ kind: "assistant", seq: record.seq, at, text });
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall") continue;
      const name = String(call.name ?? "");
      items.push({
        kind: "tool",
        seq: record.seq,
        at,
        id: String(call.id ?? ""),
        name,
        step: describeTool(name, call.arguments),
      });
    }
  }
  settleRounds(items);
  return items;
}

/**
 * 给每张提问卡片定三态(issue #359):它后面第一条用户消息是这一轮的答案即已答,是别的话即
 * 过期,没有下一条用户消息即还可答。
 *
 * 判据只有「下一条用户消息」这一件事,与卡片自身无关:人接着说了别的,这一轮就已经被那句话
 * 顶掉了——答案再提交上去,agent 读到的是一段过时的裁决。
 */
function settleRounds(items: ConversationItem[]): void {
  for (const [index, item] of items.entries()) {
    if (item.kind !== "round") continue;
    const next = items.slice(index + 1).find((one) => one.kind === "user");
    if (next === undefined) continue;
    const answers = roundAnswersFrom(next.text, item.round);
    if (answers === undefined) item.expired = true;
    else item.answers = answers;
  }
}
