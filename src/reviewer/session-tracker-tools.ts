/**
 * Agent 会话的产品 tracker 工具(CONTEXT.md 产品 tracker,ADR 0035,issue #361)。底座工具面
 * 的一组,所有用途都注册——哪个用途启用哪几个 skill 是另一件事,工具本身一律在。
 *
 * 九件工具只有一条共同的做法:把参数原样交给主进程,拿回一段文字原样返回给模型
 * (`ask`)。判定、落库与打回的理由全在主进程(`webhook/product-tracker.ts`):spec 与票都在
 * 库里,而「这张票在不在同一个产品」只有查过 spec 才说得出来。形状与知识查询那一对逐格
 * 对齐:IPC 上一对 `tracker-request` / `tracker-result` 按 `requestId` 配对,主进程恒回一条,
 * 这边因此不设超时。
 */
import { randomUUID } from "node:crypto";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { PRODUCT_TICKET_LABELS } from "../review/store.ts";
import type { SessionWorkerMessage, TrackerRequest } from "./session-protocol.ts";
import { toolText } from "./worker-tools.ts";

export const TRACKER_CREATE_SPEC_TOOL = "tracker_create_spec";
export const TRACKER_CREATE_TICKET_TOOL = "tracker_create_ticket";
export const TRACKER_LIST_TOOL = "tracker_list";
export const TRACKER_READ_TOOL = "tracker_read";
export const TRACKER_UPDATE_BODY_TOOL = "tracker_update_body";
export const TRACKER_CLOSE_TOOL = "tracker_close";
export const TRACKER_COMMENT_TOOL = "tracker_comment";
export const TRACKER_BLOCK_TOOL = "tracker_block";
export const TRACKER_UNBLOCK_TOOL = "tracker_unblock";

/** 这一组工具的名字,注册清单按它写(定义与清单取同一份,两处各写一遍迟早对不上)。 */
export const TRACKER_TOOLS = [
  TRACKER_CREATE_SPEC_TOOL,
  TRACKER_CREATE_TICKET_TOOL,
  TRACKER_LIST_TOOL,
  TRACKER_READ_TOOL,
  TRACKER_UPDATE_BODY_TOOL,
  TRACKER_CLOSE_TOOL,
  TRACKER_COMMENT_TOOL,
  TRACKER_BLOCK_TOOL,
  TRACKER_UNBLOCK_TOOL,
] as const;

/** 还没回应的读写。一进程一会话,模型一次只等一个工具结果,这张表常态只有一条。 */
const pending = new Map<string, (text: string) => void>();

/** 主进程的回应到了:兑现那一次等着的工具调用。认不出的 `requestId` 直接丢掉。 */
export function resolveTrackerRequest(requestId: string, text: string): void {
  const settle = pending.get(requestId);
  pending.delete(requestId);
  settle?.(text);
}

/** 指向一条 spec 还是一张票的两个字段。读、改正文与开关三件工具共用。 */
const targetFields = {
  kind: Type.String({
    description: 'Which one this call is about: exactly "spec" or "ticket"',
  }),
  id: Type.Integer({
    description: "Its number, as tracker_list prints it",
  }),
};

/** 把宽松收下的目标两格归一化:认不出的 kind 当作票,那一档由主进程打回。 */
function target(params: { kind?: unknown; id?: unknown }): { kind: "spec" | "ticket"; id: number } {
  return {
    kind: String(params.kind ?? "").trim() === "spec" ? "spec" : "ticket",
    id: Number(params.id ?? 0),
  };
}

/**
 * 交一次读写给主进程,把它回的那段文字原样返回给模型。工具的返回文字因此只有一处写法。
 */
function ask(
  send: (message: SessionWorkerMessage) => void,
  request: TrackerRequest,
): Promise<{ content: [{ type: "text"; text: string }]; details: object }> {
  const requestId = randomUUID();
  return new Promise<string>((settle) => {
    pending.set(requestId, settle);
    send({ kind: "tracker-request", requestId, request });
  }).then(toolText);
}

/**
 * 产品 tracker 的九件工具(issue #361)。正文只由会话经它们写:面板上人只认领、改标签、
 * 开关与评论(#363),没有编辑正文的地方。
 */
export function sessionTrackerTools(options: {
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never>[] {
  const { send } = options;
  const definitions = [
    defineTool({
      name: TRACKER_CREATE_SPEC_TOOL,
      label: "Create Spec",
      description:
        "Write a spec into this product's tracker: the requirement as you and the person have settled it. Call it once you agree on what is to be built, then split it into tickets. The body is Markdown and takes the shape of a spec: problem statement, solution, user stories, implementation decisions, testing decisions, out of scope.",
      parameters: Type.Object({
        title: Type.String({ description: "One line naming what this spec is about, in Chinese" }),
        body: Type.String({ description: "The spec itself, Markdown, in Chinese" }),
      }),
      execute: async (_id, params) => {
        const { title, body } = params as { title?: string; body?: string };
        return ask(send, { kind: "create-spec", title: title ?? "", body: body ?? "" });
      },
    }),
    defineTool({
      name: TRACKER_CREATE_TICKET_TOOL,
      label: "Create Ticket",
      description:
        "Open one ticket under a spec of this product's tracker. One ticket is one piece of work that can be picked up on its own; what it waits for goes in with tracker_block, not in prose.",
      parameters: Type.Object({
        spec: Type.Integer({ description: "The spec this ticket belongs to, by its number" }),
        title: Type.String({ description: "One line naming the piece of work, in Chinese" }),
        body: Type.String({
          description:
            "What has to be built and how it is checked, Markdown, in Chinese: what to build, then the acceptance criteria",
        }),
        label: Type.String({
          description: `One of exactly: ${PRODUCT_TICKET_LABELS.join(", ")}. A ticket you have written whole is ready-for-agent; one still missing an answer from the person is needs-info; one nobody has triaged is needs-triage.`,
        }),
      }),
      execute: async (_id, params) => {
        const { spec, title, body, label } = params as {
          spec?: number;
          title?: string;
          body?: string;
          label?: string;
        };
        return ask(send, {
          kind: "create-ticket",
          specId: Number(spec ?? 0),
          title: title ?? "",
          body: body ?? "",
          label: label ?? "",
        });
      },
    }),
    defineTool({
      name: TRACKER_LIST_TOOL,
      label: "List Tracker",
      description:
        "List this product's tracker: every spec with the tickets under it, each with its label, state, claimant and the tickets blocking it. Read it before you write anything into the tracker — the work may already be there.",
      parameters: Type.Object({}),
      execute: async () => ask(send, { kind: "list" }),
    }),
    defineTool({
      name: TRACKER_READ_TOOL,
      label: "Read Tracker Item",
      description:
        "Read one spec or one ticket of this product's tracker in full: its body, and for a ticket its comments.",
      parameters: Type.Object(targetFields),
      execute: async (_id, params) =>
        ask(send, { kind: "read", target: target(params as Record<string, unknown>) }),
    }),
    defineTool({
      name: TRACKER_UPDATE_BODY_TOOL,
      label: "Update Tracker Body",
      description:
        "Rewrite the body of one spec or one ticket. The new body replaces the old one whole, so pass the complete text, not a patch.",
      parameters: Type.Object({
        ...targetFields,
        body: Type.String({ description: "The complete new body, Markdown, in Chinese" }),
      }),
      execute: async (_id, params) => {
        const { body } = params as { body?: string };
        return ask(send, {
          kind: "update-body",
          target: target(params as Record<string, unknown>),
          body: body ?? "",
        });
      },
    }),
    defineTool({
      name: TRACKER_CLOSE_TOOL,
      label: "Close Tracker Item",
      description:
        "Close one spec or one ticket: the work is done, or it is not going to be done. Closing a spec does not close its tickets.",
      parameters: Type.Object(targetFields),
      execute: async (_id, params) =>
        ask(send, { kind: "close", target: target(params as Record<string, unknown>) }),
    }),
    defineTool({
      name: TRACKER_COMMENT_TOOL,
      label: "Comment On Ticket",
      description:
        "Write a comment on one ticket: what you found out about it, what it is waiting for, what changed. The ticket body says what is to be built; a comment says what has happened around it.",
      parameters: Type.Object({
        ticket: Type.Integer({ description: "The ticket, by its number" }),
        body: Type.String({ description: "The comment, in Chinese" }),
      }),
      execute: async (_id, params) => {
        const { ticket, body } = params as { ticket?: number; body?: string };
        return ask(send, { kind: "comment", ticketId: Number(ticket ?? 0), body: body ?? "" });
      },
    }),
    defineTool({
      name: TRACKER_BLOCK_TOOL,
      label: "Block Ticket",
      description:
        "Record that one ticket waits for another: the first cannot start until the second is done. Both have to be tickets of this product, and a ticket cannot block itself.",
      parameters: Type.Object({
        ticket: Type.Integer({ description: "The ticket that has to wait, by its number" }),
        blockedBy: Type.Integer({ description: "The ticket it waits for, by its number" }),
      }),
      execute: async (_id, params) => {
        const { ticket, blockedBy } = params as { ticket?: number; blockedBy?: number };
        return ask(send, {
          kind: "block",
          ticketId: Number(ticket ?? 0),
          blockedById: Number(blockedBy ?? 0),
        });
      },
    }),
    defineTool({
      name: TRACKER_UNBLOCK_TOOL,
      label: "Unblock Ticket",
      description: "Take back a blocking edge: the first ticket no longer waits for the second.",
      parameters: Type.Object({
        ticket: Type.Integer({ description: "The ticket that was waiting, by its number" }),
        blockedBy: Type.Integer({ description: "The ticket it was waiting for, by its number" }),
      }),
      execute: async (_id, params) => {
        const { ticket, blockedBy } = params as { ticket?: number; blockedBy?: number };
        return ask(send, {
          kind: "unblock",
          ticketId: Number(ticket ?? 0),
          blockedById: Number(blockedBy ?? 0),
        });
      },
    }),
  ];
  return definitions as unknown as ToolDefinition<never, never>[];
}
