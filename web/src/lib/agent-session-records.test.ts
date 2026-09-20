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
  subagentTaskLabel,
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

/** 一项的人读摘要:工具看名字,子代理看派了几趟,其余看正文。 */
function summary(item: ConversationItem): string | number {
  if (item.kind === "tool") return item.name;
  if (item.kind === "subagent") return item.runs.length;
  return "text" in item ? item.text : "";
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

test("产品知识与产品 tracker 的写工具各有自己那一行", () => {
  // 产品知识的两件(issue #360):有名字的按名字,仓库关系没有名字,改写时按条目号。
  assert.deepEqual(describeTool("write_knowledge", { kind: "term", name: "报销单", body: "一句话" }), {
    kind: "knowledge",
    label: "写产品知识",
    target: "报销单",
  });
  assert.equal(
    describeTool("write_knowledge", { kind: "relationship", entryId: 7, body: "一句话" }).target,
    "条目 7",
  );
  assert.equal(describeTool("write_knowledge", { kind: "relationship", body: "一句话" }).target, "");
  assert.deepEqual(describeTool("withdraw_knowledge", { entryId: 3 }), {
    kind: "knowledge",
    label: "撤回产品知识",
    target: "条目 3",
  });

  // 产品 tracker 的九件(issue #361)。新写的那两件还没有号,列的是标题。
  assert.deepEqual(describeTool("tracker_create_spec", { title: "报销单可以撤回", body: "x" }), {
    kind: "tracker",
    label: "写 spec",
    target: "报销单可以撤回",
  });
  assert.equal(
    describeTool("tracker_create_ticket", { spec: 4, title: "撤回接口", body: "x" }).target,
    "spec 4 · 撤回接口",
  );
  assert.deepEqual(describeTool("tracker_list", {}), { kind: "tracker", label: "看 tracker", target: "" });
  assert.equal(describeTool("tracker_read", { kind: "spec", id: 4 }).target, "spec 4");
  assert.equal(describeTool("tracker_read", { kind: "ticket", id: 9 }).target, "#9");
  assert.equal(describeTool("tracker_update_body", { kind: "ticket", id: 9, body: "x" }).target, "#9");
  assert.equal(describeTool("tracker_close", { kind: "spec", id: 4 }).target, "spec 4");
  assert.equal(describeTool("tracker_comment", { ticket: 9, body: "x" }).target, "#9");
  assert.equal(describeTool("tracker_block", { ticket: 9, blockedBy: 8 }).target, "#9 等 #8");
  assert.equal(describeTool("tracker_unblock", { ticket: 9, blockedBy: 8 }).target, "#9 不再等 #8");
  // 九件都归 tracker 这一类:组头因此把它们数成一组。
  for (const name of [
    "tracker_create_spec",
    "tracker_create_ticket",
    "tracker_list",
    "tracker_read",
    "tracker_update_body",
    "tracker_close",
    "tracker_comment",
    "tracker_block",
    "tracker_unblock",
  ]) {
    assert.equal(describeTool(name, {}).kind, "tracker", name);
  }
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
  assert.deepEqual(describeTool("complete_survey", {}), {
    kind: "submit",
    label: "记下谈完了",
    target: "",
  });
  // 退役的产出工具没有专门那一档了(issue #366):旧会话里的那次调用退回工具名加参数摘要,
  // 对话流照样读得下去。
  assert.deepEqual(describeTool("submit_requirement_breakdown", { items: [] }), {
    kind: "other",
    label: "submit_requirement_breakdown",
    target: "items=[]",
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

test("退役了的产出条目与定稿那一句不进对话流,旧会话照样读得下去(issue #366)", () => {
  const items = conversation([
    record(1, "custom", {
      type: "custom",
      customType: "multireviewer-session-output",
      data: { kind: "requirement-breakdown", version: 2 },
    }),
    record(2, "custom_message", {
      type: "custom_message",
      customType: "multireviewer-session-note",
      content: "需求拆分 v2 已定稿。",
      display: true,
    }),
    record(3, "message", message("assistant", "拆完了")),
  ]);
  assert.deepEqual(
    items.map((item) => [item.kind, summary(item)]),
    [["assistant", "拆完了"]],
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

test("提问轮次条目投成选择卡片,三态由它后面第一条用户消息定(issue #359)", () => {
  const round = {
    type: "custom",
    customType: "multireviewer-session-question-round",
    data: {
      questions: [
        {
          title: "汇率取哪一天的",
          body: "两处代码都取提交当天",
          options: [
            { text: "提交当天", recommended: true },
            { text: "月末统一", recommended: false },
          ],
          multiple: false,
        },
      ],
    },
  };
  const answer = ["提问轮次的回答:", "", "1. 汇率取哪一天的", "- 月末统一"].join("\n");

  // 还没有下一条用户消息:可答。
  const open = conversation([record(1, "custom", round)]);
  assert.deepEqual(
    open.map((item) => [item.kind, item.kind === "round" ? [item.answers, item.expired] : []]),
    [["round", [undefined, undefined]]],
  );

  // 下一条用户消息是这一轮的答案:已答,卡片显示所选。
  const answered = conversation([record(1, "custom", round), record(2, "message", message("user", answer))]);
  assert.deepEqual(answered[0]!.kind === "round" ? answered[0]!.answers : undefined, [["月末统一"]]);
  assert.equal(answered[0]!.kind === "round" ? answered[0]!.expired : true, undefined);

  // 下一条用户消息是别的话:过期,答不了了。
  const expired = conversation([
    record(1, "custom", round),
    record(2, "message", message("user", "先别管汇率")),
    record(3, "message", message("user", answer)),
  ]);
  assert.equal(expired[0]!.kind === "round" ? expired[0]!.expired : undefined, true);
  assert.equal(expired[0]!.kind === "round" ? expired[0]!.answers : "x", undefined);

  // 形状不对的那一条认不出来:跳过,不在对话流里摊出一段 JSON。
  assert.deepEqual(
    conversation([
      record(1, "custom", {
        type: "custom",
        customType: "multireviewer-session-question-round",
        data: { questions: [] },
      }),
    ]),
    [],
  );
});

test("子代理卡头的任务只留人要读的那半句", () => {
  // 有「任务:」就从它之后起,铺装那一段丢掉。全角冒号同律。
  assert.equal(
    subagentTaskLabel("在会话根目录 /tmp/x 下,读 kassol/web。任务:找出登录态是怎么存的"),
    "找出登录态是怎么存的",
  );
  assert.equal(subagentTaskLabel("任务：查清这三处调用链"), "查清这三处调用链");
  // 没有标记时去掉开头那句「在…下,」。
  assert.equal(
    subagentTaskLabel("在会话根目录 /tmp/x 下,查清 webhook 的准入是怎么判的"),
    "查清 webhook 的准入是怎么判的",
  );
  // 两样都没有的原样显示;裁剪之后空了也退回全文。
  assert.equal(subagentTaskLabel("读一遍 CONTEXT.md"), "读一遍 CONTEXT.md");
  assert.equal(subagentTaskLabel("任务:"), "任务:");
  // 工具行上的派单目标走同一份裁法。
  assert.equal(
    describeTool("subagent", { task: "在会话根目录 /tmp/x 下,读 kassol/web。任务:找出登录态是怎么存的" }).target,
    "找出登录态是怎么存的",
  );
});
