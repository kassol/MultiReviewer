/*
 * 会话记录的对话投影单测(issue #333)。记录行是 Pi 的条目原样 JSON,对话流要从里面认出
 * 三样东西:人说的话、agent 回的话、它调了哪个工具。认不出来的条目跳过,而不是摊成一段
 * JSON——后端多落一种条目(model_change、compaction、custom)是常态。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_SESSION_SUBAGENT_ENTRY,
  conversation,
  describeTool,
  groupConversation,
  summarizeTools,
  SYSTEM_MESSAGE_ENTRY,
  toolSummary,
  type AgentSessionRecord,
  type ConversationItem,
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

/** 一项的人读摘要:工具看名字,产出看版本,子代理看派了几趟,其余看正文。 */
function summary(item: ConversationItem): string | number {
  if (item.kind === "tool") return item.name;
  if (item.kind === "output") return item.version;
  if (item.kind === "subagent") return item.runs.length;
  return item.text;
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
    items.map((item) => [
      item.kind,
      summary(item),
    ]),
    [
      ["user", "把这个需求拆一下"],
      ["assistant", "先看看仓库"],
      ["tool", "read"],
      ["assistant", "拆成两条"],
    ],
  );
  assert.deepEqual(items[2]!.kind === "tool" ? items[2]!.step : null, {
    kind: "read",
    label: "读取",
    target: "acme/widgets/a.ts",
  });
  assert.equal(items[2]!.kind === "tool" ? items[2]!.error : "x", undefined);
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
  assert.equal(items[0]!.kind === "tool" ? items[0]!.step.target : "", "log --oneline");
});

test("用户消息里的图片引用投影成图片 id,正文照旧", () => {
  const items = conversation([
    record(
      1,
      "message",
      message("user", [
        { type: "text", text: "看这两张原型图" },
        { type: "image-ref", imageId: "a1", path: "/data/agent-sessions/1/a1.png", mimeType: "image/png" },
        { type: "image-ref", imageId: "a2", path: "/data/agent-sessions/1/a2.png", mimeType: "image/png" },
      ]),
    ),
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.kind === "user" ? items[0]! : null, {
    kind: "user",
    seq: 1,
    at: "2026-09-12T00:00:00.000Z",
    text: "看这两张原型图",
    images: ["a1", "a2"],
  });
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

test("人点停止那条系统消息成为灰底一行", () => {
  const items = conversation([
    record(1, "message", message("assistant", [{ type: "text", text: "开始读" }])),
    record(2, "custom", {
      type: "custom",
      customType: SYSTEM_MESSAGE_ENTRY,
      data: { text: "人点了停止:已中止当前这一步。" },
    }),
    // 同一种条目但没有正文:跳过,不留一行空白。
    record(3, "custom", { type: "custom", customType: SYSTEM_MESSAGE_ENTRY, data: {} }),
  ]);
  assert.deepEqual(
    items.map((item) => [
      item.kind,
      summary(item),
    ]),
    [
      ["assistant", "开始读"],
      ["system", "人点了停止:已中止当前这一步。"],
    ],
  );
});

test("工具调用翻成动词加对象,失败的结果按 toolCallId 记到那次调用上", () => {
  assert.deepEqual(describeTool("read", { path: "a.ts", offset: 10, limit: 20 }), {
    kind: "read",
    label: "读取",
    target: "a.ts L10-29",
  });
  assert.equal(describeTool("grep", { pattern: "foo", path: "src", glob: "*.ts" }).target, "foo 于 src *.ts");
  assert.equal(describeTool("find", { pattern: "**/*" }).target, "**/*");
  assert.equal(describeTool("ls", {}).target, ".");
  assert.equal(describeTool("query_knowledge", { repos: ["a/b", "c/d"] }).target, "a/b、c/d");
  assert.deepEqual(describeTool("submit_product_survey", { statements: [] }), {
    kind: "submit",
    label: "提交产出",
    target: "",
  });
  assert.deepEqual(describeTool("mystery", { x: 1 }), { kind: "other", label: "mystery", target: "x=1" });

  const items = conversation([
    record(
      1,
      "message",
      message("assistant", [
        { type: "toolCall", id: "c1", name: "find", arguments: { pattern: "**/*" } },
        { type: "toolCall", id: "c2", name: "ls", arguments: { path: "src" } },
      ]),
    ),
    record(2, "message", {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        isError: true,
        content: [{ type: "text", text: "error: Found argument '--no-require-git'\n\nUsage: fd" }],
      },
    }),
    record(3, "message", {
      type: "message",
      message: { role: "toolResult", toolCallId: "c2", isError: false, content: [{ type: "text", text: "a.ts" }] },
    }),
  ]);
  assert.deepEqual(
    items.map((item) => (item.kind === "tool" ? [item.name, item.error] : item.kind)),
    [
      ["find", "error: Found argument '--no-require-git'"],
      ["ls", undefined],
    ],
  );
});

test("组头按动词计数、次数多的在前,读取与列目录按对象去重,超过三类折成「等 N 步」", () => {
  const read = (path: string) => describeTool("read", { path });
  assert.equal(summarizeTools([read("a.ts"), read("a.ts"), read("b.ts")]), "读取 2 个文件");
  assert.equal(
    summarizeTools([
      read("a.ts"),
      describeTool("ls", { path: "src" }),
      describeTool("git", { args: ["log"] }),
      describeTool("git", { args: ["show", "x"] }),
      describeTool("query_findings", { repo: "a/b" }),
      describeTool("query_knowledge", { repos: ["a/b"] }),
    ]),
    "git 2 次、读取 1 个文件、列目录 1 个目录等 2 步",
  );
  assert.equal(summarizeTools([]), "");
});

test("参数摘要一行放得下:超出就截断", () => {
  assert.equal(toolSummary({ path: "a.ts", limit: 20 }), "path=a.ts limit=20");
  assert.equal(toolSummary(undefined), "");
  const long = toolSummary({ pattern: "x".repeat(300) });
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});

test("产出条目投成产出卡片,定稿那一句投成一行提示(issue #337)", () => {
  const items = conversation([
    record(1, "custom", {
      type: "custom",
      customType: "multireviewer-session-output",
      data: { kind: "requirement-breakdown", version: 2 },
    }),
    // 版本号缺失或 customType 认不出的 custom 条目跳过,不在对话流里摊出来。
    record(2, "custom", { type: "custom", customType: "multireviewer-session-output", data: {} }),
    record(3, "custom_message", {
      type: "custom_message",
      customType: "multireviewer-session-note",
      content: "需求拆分 v2 已定稿。",
      display: true,
    }),
    record(4, "custom_message", { type: "custom_message", content: "  " }),
  ]);
  assert.deepEqual(
    items.map((item) => [
      item.kind,
      item.kind === "output" ? item.version : item.kind === "note" ? item.text : "",
    ]),
    [
      ["output", 2],
      ["note", "需求拆分 v2 已定稿。"],
    ],
  );
});

test("基点更新投成系统消息那一行:仓库、旧短 sha → 新短 sha(issue #356)", () => {
  const items = conversation([
    record(1, "custom_message", {
      type: "custom_message",
      customType: "multireviewer-session-baseline-update",
      content: "acme/widgets 的会话基点从 aaaaaaa 更新到 bbbbbbb(分支 main)。",
      details: { repo: "acme/widgets", branch: "main", from: "a".repeat(40), to: "b".repeat(40) },
      display: true,
    }),
  ]);
  assert.deepEqual(items.map((item) => [item.kind, "text" in item ? item.text : ""]), [
    ["system", "基点更新 acme/widgets(main) aaaaaaa → bbbbbbb"],
  ]);
});

test("会话子代理派单投成一项,派单那次工具调用读成「派子代理 + 任务」(issue #358)", () => {
  const items = conversation([
    record(
      1,
      "message",
      message("assistant", [
        {
          type: "toolCall",
          id: "c1",
          name: "subagent",
          arguments: {
            agent: "explore",
            tasks: [{ task: "报销单的状态机在哪" }, { task: "撤回走哪个接口" }],
          },
        },
      ]),
    ),
    record(2, "custom", {
      customType: AGENT_SESSION_SUBAGENT_ENTRY,
      data: {
        runs: [
          {
            task: "报销单的状态机在哪",
            status: "done",
            steps: 1,
            calls: [{ name: "read", args: { path: "acme/widgets/state.ts" } }],
            conclusion: "state.ts:12 起是状态机",
          },
          {
            task: "撤回走哪个接口",
            status: "failed",
            steps: 0,
            calls: [],
            conclusion: "没找到",
          },
        ],
      },
    }),
  ]);

  // 派单那一次仍是一行工具调用:动词加它派出去的那几句任务。
  assert.deepEqual(items.map((item) => item.kind), ["tool", "subagent"]);
  const call = items[0]!;
  assert.ok(call.kind === "tool");
  assert.deepEqual(call.step, {
    kind: "subagent",
    label: "派子代理",
    target: "报销单的状态机在哪、撤回走哪个接口",
  });

  // 条目那一项带着两趟的任务、状态、步数、工具调用与结论。
  const dispatched = items[1]!;
  assert.ok(dispatched.kind === "subagent");
  assert.deepEqual(
    dispatched.runs.map((run) => [run.task, run.status, run.steps, run.conclusion]),
    [
      ["报销单的状态机在哪", "done", 1, "state.ts:12 起是状态机"],
      ["撤回走哪个接口", "failed", 0, "没找到"],
    ],
  );
  assert.deepEqual(dispatched.runs[0]!.calls.map((one) => one.name), ["read"]);
});

test("子代理条目没有 runs 或形状认不出时跳过,不在对话流里摊成 JSON", () => {
  const items = conversation([
    record(1, "custom", { customType: AGENT_SESSION_SUBAGENT_ENTRY, data: { runs: [] } }),
    record(2, "custom", { customType: AGENT_SESSION_SUBAGENT_ENTRY, data: {} }),
    record(3, "custom", { customType: AGENT_SESSION_SUBAGENT_ENTRY }),
  ]);
  assert.deepEqual(items, []);
});

test("子代理那一项不与相邻的工具调用折进同一组(issue #358)", () => {
  const tool = (seq: number, name: string) =>
    ({ kind: "tool", seq, at: "t", id: `c${seq}`, name, step: describeTool(name, {}) }) as const;
  const groups = groupConversation([
    tool(1, "read"),
    {
      kind: "subagent",
      seq: 2,
      at: "t",
      runs: [{ task: "查一下", status: "done", steps: 0, calls: [], conclusion: "查完了" }],
    },
    tool(3, "read"),
  ]);
  assert.deepEqual(
    groups.map((group) => (group.kind === "tools" ? group.calls.length : group.kind)),
    [1, "subagent", 1],
  );
});

test("连续的工具调用折成一组,隔一条 agent 回复就分两组", () => {
  const tool = (seq: number, name: string) =>
    ({ kind: "tool", seq, at: "t", id: `c${seq}`, name, step: describeTool(name, {}) }) as const;
  const said = (seq: number, text: string) => ({ kind: "assistant", seq, at: "t", text }) as const;
  const groups = groupConversation([tool(1, "ls"), tool(2, "read"), tool(3, "read"), said(4, "看完了"), tool(5, "git")]);
  assert.deepEqual(
    groups.map((group) => (group.kind === "tools" ? group.calls.map((call) => call.name) : group.kind)),
    [["ls", "read", "read"], "assistant", ["git"]],
  );
  assert.equal(groups[0]!.seq, 1);
});
