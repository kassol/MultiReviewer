/*
 * 会话记录的对话投影单测(issue #333)。记录行是 Pi 的条目原样 JSON,对话流要从里面认出
 * 三样东西:人说的话、agent 回的话、它调了哪个工具。认不出来的条目跳过,而不是摊成一段
 * JSON——后端多落一种条目(model_change、compaction、custom)是常态。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversation,
  toolSummary,
  type AgentSessionRecord,
} from "./agent-session-records.ts";

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

function record(seq: number, type: string, entry: unknown): AgentSessionRecord {
  return { seq, type, at: "2026-09-12T00:00:00.000Z", entry, usage: ZERO };
}

function message(role: string, content: unknown): unknown {
  return { type: "message", message: { role, content } };
}

test("一个回合投影成用户消息、agent 回复与工具行,工具结果不进对话流", () => {
  const items = conversation([
    record(1, "model_change", { type: "model_change", provider: "test", modelId: "m" }),
    record(2, "message", message("user", "把这个需求拆一下")),
    record(
      3,
      "message",
      message("assistant", [
        { type: "text", text: "先看看仓库" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "acme/widgets/a.ts" } },
      ]),
    ),
    record(4, "message", message("toolResult", [{ type: "text", text: "1: export const a = 1;" }])),
    record(5, "message", message("assistant", [{ type: "text", text: "拆成两条" }])),
  ]);
  assert.deepEqual(
    items.map((item) => [item.kind, item.kind === "tool" ? item.name : item.text]),
    [
      ["user", "把这个需求拆一下"],
      ["assistant", "先看看仓库"],
      ["tool", "read"],
      ["assistant", "拆成两条"],
    ],
  );
  assert.equal(items[2]!.kind === "tool" ? items[2]!.summary : "", "path=acme/widgets/a.ts");
});

test("只有工具调用、没有正文的助手消息只出工具行", () => {
  const items = conversation([
    record(
      1,
      "message",
      message("assistant", [
        { type: "thinking", thinking: "想一下" },
        { type: "toolCall", id: "c1", name: "git", arguments: { args: ["log", "--oneline"] } },
      ]),
    ),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["tool"]);
  assert.equal(items[0]!.kind === "tool" ? items[0]!.summary : "", 'args=["log","--oneline"]');
});

test("认不出来的条目与空消息一律跳过", () => {
  const items = conversation([
    record(1, "custom", { type: "custom", customType: "x", data: { a: 1 } }),
    record(2, "compaction", { type: "compaction", summary: "压缩过的历史" }),
    record(3, "message", { type: "message" }),
    record(4, "message", message("user", [])),
    record(5, "message", message("assistant", "   ")),
  ]);
  assert.deepEqual(items, []);
});

test("参数摘要一行放得下:超出就截断", () => {
  assert.equal(toolSummary({ path: "a.ts", limit: 20 }), "path=a.ts limit=20");
  assert.equal(toolSummary(undefined), "");
  const long = toolSummary({ pattern: "x".repeat(300) });
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});
