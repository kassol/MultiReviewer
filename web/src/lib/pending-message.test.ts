/*
 * 待上屏消息的配对单测:真实用户记录到了就接替待定气泡,之前的同文消息与留存的排队消息
 * 不算;一轮跑完仍没落库的不再挂着。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionRecord } from "./agent-session-records.ts";
import { lastSeq, pendingView, type PendingMessage } from "./pending-message.ts";

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

function user(seq: number, text: string): AgentSessionRecord {
  return {
    seq,
    type: "message",
    at: "2026-09-23T00:00:00.000Z",
    entry: { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
    usage: ZERO,
  };
}

function other(seq: number): AgentSessionRecord {
  return {
    seq,
    type: "model_change",
    at: "2026-09-23T00:00:00.000Z",
    entry: { type: "model_change" },
    usage: ZERO,
  };
}

const sent = (accepted: boolean): PendingMessage => ({
  text: "继续",
  images: [],
  afterSeq: 2,
  accepted,
});

test("没有待定消息时不画", () => {
  assert.equal(pendingView(null, [user(1, "继续")], false), "hidden");
});

test("发送之后一条记录都还没回来即在准备,之前那条同文消息不算接替", () => {
  const records = [user(1, "继续"), other(2)];
  assert.equal(pendingView(sent(false), records, false), "preparing");
  assert.equal(pendingView(sent(true), records, true), "preparing");
});

test("之后到的第一条同文用户消息接替它", () => {
  assert.equal(pendingView(sent(true), [other(2), other(3), user(4, "继续")], true), "hidden");
});

test("留存的排队消息先到时仍挂着,等到自己那一条", () => {
  const records = [other(2), user(3, "上次没投出去的那句")];
  assert.equal(pendingView(sent(true), records, true), "waiting");
});

test("202 之前会话状态还是旧值,空闲不作数", () => {
  assert.equal(pendingView(sent(false), [other(3)], false), "waiting");
});

test("一轮跑完仍没落库即不再挂着(子进程起不来那一路)", () => {
  assert.equal(pendingView(sent(true), [other(3)], false), "hidden");
});

test("lastSeq 取最大的 seq,空列表为 0", () => {
  assert.equal(lastSeq([]), 0);
  assert.equal(lastSeq([user(5, "a"), other(3)]), 5);
});
