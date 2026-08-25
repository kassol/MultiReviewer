/**
 * 子进程里那一层:Pi 的会话事件转成 Reviewer 事件(issue #171,ADR 0017)。
 *
 * 与 `numbered-read`、`reviewer-contract` 同一档——worker 的构件单独测,真实模型那条
 * 契约留给 `reviewer-smoke`。这里钉三件事:哪些事件转、转成什么、凭据不出现在正文里。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewerEvent } from "../src/review/finding.ts";
import { reviewerEventStream } from "../src/reviewer/trace-events.ts";

const CREDENTIAL = "sk-live-trace-credential";

/** 收下转出来的事件,并给一个可控的时钟——耗时要断言得出确定值。 */
function collector(
  credential: string | undefined = CREDENTIAL,
  /** 哪几次调用是锚定打回的,与 worker 里那份名单同一个语义(issue #187)。 */
  anchorRejected: (toolCallId: string) => boolean = () => false,
): {
  events: ReviewerEvent[];
  observe: ReturnType<typeof reviewerEventStream>;
  tick(ms: number): void;
} {
  const events: ReviewerEvent[] = [];
  let clock = 1000;
  return {
    events,
    observe: reviewerEventStream(
      credential,
      (event) => events.push(event),
      () => clock,
      anchorRejected,
    ),
    tick: (ms) => {
      clock += ms;
    },
  };
}

function assistantMessage(text: string): { type: string; message: unknown } {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

test("message_end 转成一条 assistant_message,记整条文本", () => {
  const { events, observe } = collector();
  observe(assistantMessage("我先读 src/db.js 看看查询是怎么拼的"));

  assert.deepEqual(events, [
    { kind: "assistant_message", text: "我先读 src/db.js 看看查询是怎么拼的" },
  ]);
});

test("流式增量与用户消息不进轨迹", () => {
  const { events, observe } = collector();
  observe({ type: "message_update", message: { role: "assistant", content: [] } } as never);
  observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "去审" }] } });
  observe({ type: "agent_end" } as never);
  // 只有工具调用块、没有文本的那条 assistant 消息同样不发:它没有话可记。
  observe({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
  });
  // 模型只调工具时常附一个空文本块,面板上会渲染成「(空文本)」——同样不发。
  observe(assistantMessage(""));
  observe(assistantMessage("  \n"));

  assert.deepEqual(events, []);
});

test("tool_execution_end 转成一条 tool_call:工具名、参数、耗时与返回长度", () => {
  const { events, observe, tick } = collector();
  observe({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "src/db.js", limit: 40 },
  });
  tick(37);
  observe({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "1: const a = 1;" }] },
    isError: false,
  });

  assert.deepEqual(events, [
    {
      kind: "tool_call",
      tool: "read",
      args: { path: "src/db.js", limit: 40 },
      durationMs: 37,
      isError: false,
      error: null,
      resultLength: "1: const a = 1;".length,
    },
  ]);
});

test("工具返回的正文不进轨迹,只留长度", () => {
  const { events, observe } = collector();
  const body = "x".repeat(5000);
  observe({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: {} });
  observe({
    type: "tool_execution_end",
    toolCallId: "c",
    toolName: "read",
    result: { content: [{ type: "text", text: body }] },
    isError: false,
  });

  const event = events[0]!;
  assert.equal(event.kind, "tool_call");
  if (event.kind !== "tool_call") return;
  assert.equal(event.resultLength, 5000);
  assert.equal(JSON.stringify(event).includes(body), false, "正文不该出现在事件里");
});

test("被拒的工具调用带原因,原因就是返回的那段文本", () => {
  const { events, observe } = collector();
  observe({
    type: "tool_execution_start",
    toolCallId: "call-9",
    toolName: "report_finding",
    args: { file: "src/db.js", severity: "critical" },
  });
  observe({
    type: "tool_execution_end",
    toolCallId: "call-9",
    toolName: "report_finding",
    result: { content: [{ type: "text", text: "severity: expected one of P0, P1, P2" }] },
    isError: true,
  });

  const event = events[0]!;
  assert.equal(event.kind, "tool_call");
  if (event.kind !== "tool_call") return;
  assert.equal(event.isError, true);
  assert.equal(event.error, "severity: expected one of P0, P1, P2");
  assert.deepEqual(event.args, { file: "src/db.js", severity: "critical" });
});

test("锚定打回的复核调用按被拒记入轨迹,原因是打回的措辞", () => {
  // 打回走正常工具返回,Pi 因此报 isError=false;名单里那几次由这一层标出来。
  const { events, observe } = collector(CREDENTIAL, (id) => id === "call-7");
  observe({
    type: "tool_execution_start",
    toolCallId: "call-7",
    toolName: "review_prior_finding",
    args: { id: 12, verdict: "present", line: 88, snippet: "return history.slice(count);" },
  });
  observe({
    type: "tool_execution_end",
    toolCallId: "call-7",
    toolName: "review_prior_finding",
    result: {
      content: [
        { type: "text", text: "verdict recorded, new line NOT recorded: 第 88 行的内容对不上。" },
      ],
    },
    isError: false,
  });

  const event = events[0]!;
  assert.equal(event.kind, "tool_call");
  if (event.kind !== "tool_call") return;
  assert.equal(event.isError, true);
  assert.equal(
    event.error,
    "verdict recorded, new line NOT recorded: 第 88 行的内容对不上。",
  );
  // 是哪条历史 Finding、模型给的行号是多少,都在参数里,不另加字段。
  assert.deepEqual(event.args, {
    id: 12,
    verdict: "present",
    line: 88,
    snippet: "return history.slice(count);",
  });
});

test("锚得上的复核调用不算被拒", () => {
  const { events, observe } = collector(CREDENTIAL, (id) => id === "call-7");
  observe({
    type: "tool_execution_start",
    toolCallId: "call-8",
    toolName: "review_prior_finding",
    args: { id: 12, verdict: "present", line: 88 },
  });
  observe({
    type: "tool_execution_end",
    toolCallId: "call-8",
    toolName: "review_prior_finding",
    result: { content: [{ type: "text", text: "recorded" }] },
    isError: false,
  });

  const event = events[0]!;
  assert.equal(event.kind, "tool_call");
  if (event.kind !== "tool_call") return;
  assert.equal(event.isError, false);
  assert.equal(event.error, null);
});

test("凭据不出现在任何事件正文里:说的话、工具参数、被拒的原因都抹掉", () => {
  const { events, observe } = collector();
  observe(assistantMessage(`我用 ${CREDENTIAL} 调了一次`));
  observe({
    type: "tool_execution_start",
    toolCallId: "c",
    toolName: "grep",
    args: { pattern: CREDENTIAL },
  });
  observe({
    type: "tool_execution_end",
    toolCallId: "c",
    toolName: "grep",
    result: { content: [{ type: "text", text: `401 for key ${CREDENTIAL}` }] },
    isError: true,
  });

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(CREDENTIAL), false, "事件正文里不该留下凭据");
  assert.equal(serialized.includes("[REDACTED]"), true);
});
