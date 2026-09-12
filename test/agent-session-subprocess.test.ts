/**
 * Agent 会话的真实链路(issue #333):`POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 →
 * 会话记录 → SSE`,整条走一遍。模型由本机的假服务(`support/model-stub.ts`)按脚本扮演,
 * 全程不碰收费模型。先例是 `reviewer-evidence-session.test.ts`。
 *
 * 钉的是桩测不到的几件事:知识集真的分段进了模型请求、消息文本进了同一次请求、回复与工具
 * 调用作为 Pi 条目落进记录表并经 SSE 送达、用量按条目累加到会话上,以及子进程跑完一个回合
 * 之后**留着**——第二条消息不必再建一次会话。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { seedReviewRule } from "./support/store-seed.ts";
import { startModelStub, type StubTurn } from "./support/model-stub.ts";
import { frameReader } from "./support/sse.ts";

const PASSWORD = "agent-session-subprocess-password";
const AT = "2026-09-12T00:00:00.000Z";

/** 知识集里的两条,陈述独一无二,好在模型请求里认出来。 */
const RULE = "每个导出函数都要有 JSDoc 注释";
const FACT = "这个仓库的持久化只用 node:sqlite";

/** 发给 agent 的那句话。同样独一无二。 */
const MESSAGE = "把「报销单可以撤回」拆成可实现的条目";

type Record = {
  seq: number;
  type: string;
  entry: { type: string; message?: { role: string; content: unknown } };
  usage: ReviewerUsage;
};

/**
 * 起一套指向假模型服务的 harness:注册 harness 那个仓库、建产品、给创建者 agent:chat,
 * 回会话 id 与创建者的 cookie。模型服务的地址就是假服务的地址,因此解析出的辅助模型
 * (生效组合首个)打到它上面。
 */
async function startSessionHarness(turns: readonly StubTurn[]): Promise<{
  h: PanelHarness;
  cookie: string;
  sessionId: number;
  requests: Awaited<ReturnType<typeof startModelStub>>["requests"];
  close: () => Promise<void>;
}> {
  const stub = await startModelStub(turns);
  const h = await startPanelHarness();
  seedAvailableModelService(h, HARNESS_SPEC.provider, [HARNESS_SPEC.model], {}, stub.baseUrl);
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  seedReviewRule(h.db.path, GITEA_REPO.id, { type: "rule", scope: "", statement: RULE });
  seedReviewRule(h.db.path, GITEA_REPO.id, { type: "fact", scope: "src", statement: FACT });

  const created = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const response = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "requirement-breakdown" }),
  });
  assert.equal(response.status, 201);
  const { session } = (await response.json()) as { session: { id: number } };
  return { h, cookie, sessionId: session.id, requests: stub.requests, close: stub.close };
}

function send(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  clientMessageId: string,
  text: string,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId, text }),
  });
}

async function records(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<Record[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/records`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { records: Record[] }).records;
}

/** 记录里的消息条目各是什么角色。会话起头那两条 model_change / thinking_level_change 不算。 */
function messageRoles(landed: readonly Record[]): (string | undefined)[] {
  return landed
    .filter((record) => record.type === "message")
    .map((record) => record.entry.message?.role);
}

/** 等到这个会话至少落了这么多条消息记录。等的是库里的行,不猜子进程的时序。 */
async function messagesAtLeast(dbPath: string, sessionId: number, count: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const store = openStore(dbPath);
    const landed = store.listAgentSessionEntries(sessionId) as unknown as Record[];
    store.close();
    if (messageRoles(landed).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还没落到 ${count} 条消息记录`);
}

/** 等到这个会话回到空闲(一个回合跑完)。 */
async function idle(h: PanelHarness, cookie: string, sessionId: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      headers: { cookie },
    });
    const { session } = (await response.json()) as { session: { status: string } };
    if (session.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还在执行`);
}

test("发一条消息:知识集分段与消息文本进了模型请求,回复与工具调用落库并经 SSE 送达", async () => {
  const turns: StubTurn[] = [
    {
      text: "先看看仓库里怎么写的",
      toolCall: { name: "read", args: { path: `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts` } },
      usage: { input: 120, output: 30 },
    },
    { text: "拆成两条:撤回入口与状态机", usage: { input: 80, output: 20, cacheRead: 4 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    // 流先接上:这一轮的记录要从它送到。
    const stream = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stream`, {
      headers: { cookie },
    });
    assert.equal(stream.status, 200);
    const reader = frameReader(stream);

    const accepted = await send(h, cookie, sessionId, "c1", MESSAGE);
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 202, acceptedText);

    // 一个回合 = 用户消息 + 助手消息(带工具调用)+ 工具结果 + 助手消息。
    await messagesAtLeast(h.db.path, sessionId, 4);
    await idle(h, cookie, sessionId);

    // 模型请求里有系统提示的知识集两段、会话根的仓库目录,以及人发的那句话。
    assert.equal(requests.length, 2, "脚本两次响应,父会话就该发两次请求");
    const system = requests[0]!.messages.filter((message) => message.role === "system");
    assert.equal(system.length, 1);
    assert.match(system[0]!.content, new RegExp(RULE));
    assert.match(system[0]!.content, new RegExp(FACT));
    assert.match(system[0]!.content, /- acme\/widgets/);
    assert.match(system[0]!.content, /requirement-breakdown/);
    assert.ok(
      requests[0]!.messages.some(
        (message) => message.role === "user" && message.content.includes(MESSAGE),
      ),
      "发出去的那句话没进模型请求",
    );
    // 工具面是只读四件套、受控 git、历史 Finding 查询(issue #338),加这个用途的产出工具
    // (issue #337);写工具一个都没注册。
    assert.deepEqual(
      [...requests[0]!.tools].sort(),
      ["find", "git", "grep", "ls", "query_findings", "read", "submit_requirement_breakdown"],
    );

    // 记录:会话起头的两条(这一次用哪个模型、哪个思考档位)原样落下来,随后是用户消息、
    // 带工具调用的助手消息、工具结果与收尾的助手消息,各自是原样的 Pi 条目。
    const landed = await records(h, cookie, sessionId);
    assert.deepEqual(
      landed.map((record) => record.type),
      [
        "model_change",
        "thinking_level_change",
        "message",
        "message",
        "message",
        "message",
      ],
    );
    assert.deepEqual(messageRoles(landed), ["user", "assistant", "toolResult", "assistant"]);
    assert.deepEqual(
      landed.map((record) => record.seq),
      [1, 2, 3, 4, 5, 6],
    );
    // 工具调用在助手条目里,读到的是会话根下那个仓库的文件。
    const toolCall = JSON.stringify(landed[3]!.entry);
    assert.match(toolCall, /"toolCall"/);
    assert.match(toolCall, /acme\/widgets\/src\/answer\.ts/);
    assert.match(JSON.stringify(landed[4]!.entry), /export const answer/);

    // 用量按条目累加,与 Pi 的会话统计同口径(两次响应的四项之和)。
    const session = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      headers: { cookie },
    });
    const read = (await session.json()) as { session: { usage: ReviewerUsage } };
    assert.deepEqual(read.session.usage, {
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      totalTokens: 254,
    });

    // SSE:这一轮的六条记录都到了,帧 id 就是 seq。
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await reader.next()).id!);
    assert.deepEqual(ids, ["1", "2", "3", "4", "5", "6"]);
    await reader.cancel();
  } finally {
    // 登记表是进程内的一张表,下一个用例会拿同一个会话 id 开新会话。
    await disposeAgentSessions();
    await close();
  }
});

test("子进程跑完一个回合留着:第二条消息在同一个会话里接着跑", async () => {
  const turns: StubTurn[] = [
    { text: "第一轮", usage: { input: 10, output: 2 } },
    { text: "第二轮", usage: { input: 12, output: 3 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);

    assert.equal((await send(h, cookie, sessionId, "c2", "再补一句")).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 4);
    await idle(h, cookie, sessionId);

    // 第二次请求带着第一轮的上下文:同一个 Pi 会话,历史没丢。
    assert.equal(requests.length, 2);
    const second = requests[1]!.messages.map((message) => message.content).join("\n");
    assert.match(second, new RegExp(MESSAGE));
    assert.match(second, /第一轮/);
    assert.match(second, /再补一句/);

    assert.deepEqual(messageRoles(await records(h, cookie, sessionId)), [
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/* ─────────────── 产出工具与会话产出(issue #337) ─────────────── */

const REPO = `${GITEA_REPO.owner}/${GITEA_REPO.repo}`;

type Output = { kind: string; version: number; payload: unknown; toolCallId: string };

/** 任意 JSON 对象。改坏一份好拆分时按键改,不为此造一套类型。 */
type Json = globalThis.Record<string, unknown>;

/** 一份拆分的工具参数。`summary` 两头带空白、列表里掺一个空项,用来压服务端归一化。 */
function breakdownArgs(summary: string): Json {
  return {
    summary: `  ${summary}  `,
    assumptions: ["汇率由财务手工维护", "   "],
    openQuestions: [],
    items: [
      {
        title: "月结汇率表",
        description: "新增月结汇率表,按年月与币种唯一",
        repo: REPO,
        locations: ["src/finance/", ""],
        dependsOn: [],
        acceptance: ["同一年月同一币种只存一条"],
      },
      {
        title: "报销单按原币录入",
        description: "提交时锁定当月汇率",
        repo: REPO,
        locations: ["src/answer.ts"],
        dependsOn: [1],
        acceptance: ["提交后改汇率表,折算金额不变"],
      },
    ],
  };
}

async function outputs(h: PanelHarness, cookie: string, sessionId: number): Promise<Output[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/outputs`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { outputs: Output[] }).outputs;
}

/** 等到这个会话落了这么多版产出。等的是库里的行,不猜子进程的时序。 */
async function outputsAtLeast(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  count: number,
): Promise<Output[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const landed = await outputs(h, cookie, sessionId);
    if (landed.length >= count) return landed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还没落到 ${count} 版产出`);
}

async function readRecords(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<Record[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/records`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { records: Record[] }).records;
}

test("调一次产出工具即落一版产出,经 SSE 推到面板;再交即新版本", async () => {
  const turns: StubTurn[] = [
    {
      toolCall: { name: "submit_requirement_breakdown", args: breakdownArgs("第一版拆分") },
      usage: { input: 100, output: 20 },
    },
    { text: "第一版交了", usage: { input: 40, output: 5 } },
    {
      toolCall: { name: "submit_requirement_breakdown", args: breakdownArgs("第二版拆分") },
      usage: { input: 110, output: 22 },
    },
    { text: "第二版交了", usage: { input: 45, output: 6 } },
  ];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    const stream = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stream`, {
      headers: { cookie },
    });
    assert.equal(stream.status, 200);
    const reader = frameReader(stream);

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    const landed = await outputsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);

    // 产出表:第一版,payload 归一化过(两头空白去掉、列表里的空项丢掉),记着那次工具调用。
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.kind, "requirement-breakdown");
    assert.equal(landed[0]!.version, 1);
    assert.notEqual(landed[0]!.toolCallId, "");
    assert.deepEqual(landed[0]!.payload, {
      summary: "第一版拆分",
      assumptions: ["汇率由财务手工维护"],
      openQuestions: [],
      items: [
        {
          title: "月结汇率表",
          description: "新增月结汇率表,按年月与币种唯一",
          repo: REPO,
          locations: ["src/finance/"],
          dependsOn: [],
          acceptance: ["同一年月同一币种只存一条"],
        },
        {
          title: "报销单按原币录入",
          description: "提交时锁定当月汇率",
          repo: REPO,
          locations: ["src/answer.ts"],
          dependsOn: [1],
          acceptance: ["提交后改汇率表,折算金额不变"],
        },
      ],
    });

    const rows = await readRecords(h, cookie, sessionId);
    // 工具回的是 recorded:打回才换文案。
    assert.match(JSON.stringify(rows), /recorded/);
    // 记录表上多一条 custom 条目:对话流里由它长出产出卡片。
    const custom = rows.filter((row) => row.type === "custom");
    assert.equal(custom.length, 1);
    assert.deepEqual((custom[0]!.entry as { data?: unknown }).data, {
      kind: "requirement-breakdown",
      version: 1,
    });

    // SSE:那条 custom 条目也从流里送到了。
    const seen: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const frame = await reader.next();
      seen.push((JSON.parse(frame.data) as Record).type);
      if (seen.includes("custom")) break;
    }
    assert.ok(seen.includes("custom"), `流里没见到 custom 条目:${seen.join(",")}`);
    await reader.cancel();

    // 再交一版:旧版保留,版本号加一。
    assert.equal((await send(h, cookie, sessionId, "c2", "再拆细一点")).status, 202);
    const both = await outputsAtLeast(h, cookie, sessionId, 2);
    await idle(h, cookie, sessionId);
    assert.deepEqual(
      both.map((output) => output.version),
      [1, 2],
    );
    assert.equal((both[0]!.payload as { summary: string }).summary, "第一版拆分");
    assert.equal((both[1]!.payload as { summary: string }).summary, "第二版拆分");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("三种打回走正常返回:不落产出,打回的调用照样进记录表", async () => {
  /** 把一份好拆分改坏:改哪一处由 `patch` 决定。 */
  const broken = (patch: (items: Json[]) => void): Json => {
    const args = breakdownArgs("被打回的那一版");
    patch(args["items"] as Json[]);
    return args;
  };
  const turns: StubTurn[] = [
    {
      // 所属仓库不在会话根内。
      toolCall: {
        name: "submit_requirement_breakdown",
        args: broken((items) => {
          items[0]!["repo"] = "acme/nowhere";
        }),
      },
      usage: { input: 10, output: 2 },
    },
    {
      // 依赖序号自指。
      toolCall: {
        name: "submit_requirement_breakdown",
        args: broken((items) => {
          items[0]!["dependsOn"] = [1];
        }),
      },
      usage: { input: 10, output: 2 },
    },
    {
      // 落点不是仓库相对路径。
      toolCall: {
        name: "submit_requirement_breakdown",
        args: broken((items) => {
          items[1]!["locations"] = ["../../etc/passwd"];
        }),
      },
      usage: { input: 10, output: 2 },
    },
    { text: "三次都被打回了,我改完再交", usage: { input: 10, output: 2 } },
  ];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 一个回合 = 用户消息 + 3 ×(助手消息 + 工具结果)+ 收尾的助手消息。
    await messagesAtLeast(h.db.path, sessionId, 8);
    await idle(h, cookie, sessionId);

    // 一版都没落:打回的调用不是产出。
    assert.deepEqual(await outputs(h, cookie, sessionId), []);

    // 三次打回各自的理由都在记录表里的工具结果上,调用本身也在。
    const rows = await readRecords(h, cookie, sessionId);
    const results = rows
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.equal(results.length, 3);
    assert.match(results[0]!, /acme\/nowhere, which is not a repository of this session/);
    assert.match(results[1]!, /item 1 depends on itself/);
    assert.match(results[2]!, /\.\.\/\.\.\/etc\/passwd/);
    // 打回走正常返回,不是工具错误:产出一版没落,而调用本身留在记录里。
    assert.equal(rows.filter((row) => row.type === "custom").length, 0);
    assert.equal(
      rows.filter((row) => JSON.stringify(row.entry).includes("submit_requirement_breakdown"))
        .length,
      6,
    );
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("定稿进模型上下文:子进程活着时那条消息经它落库,下一轮的模型请求里看得到", async () => {
  const turns: StubTurn[] = [
    { text: "先这样", usage: { input: 10, output: 2 } },
    { text: "知道 v1 定稿了", usage: { input: 12, output: 3 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    // 第一条消息把子进程起起来,之后它一直活着。
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);

    // 产出直接落一版:这一条用例要的是定稿那条消息的去处,不是产出工具。
    const store = openStore(h.db.path);
    store.appendAgentSessionOutput(sessionId, {
      kind: "requirement-breakdown",
      payload: { summary: "一版", assumptions: [], openQuestions: [], items: [] },
      toolCallId: "call-1",
      createdAt: AT,
    });
    store.close();

    const finalized = await fetch(
      `${h.serverUrl}/api/agent-sessions/${sessionId}/outputs/1/finalize`,
      { method: "POST", headers: { cookie } },
    );
    assert.equal(finalized.status, 200, await finalized.text());

    // 那条消息经子进程放进 Pi 会话,再由镜像落回记录表。
    for (let attempt = 0; ; attempt += 1) {
      const landed = await readRecords(h, cookie, sessionId);
      if (landed.some((row) => row.type === "custom_message")) break;
      assert.ok(attempt < 300, "等了 30 秒,定稿那条 custom_message 还没落库");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 下一轮:它在模型请求里。
    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 4);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 2);
    assert.match(
      requests[1]!.messages.map((message) => message.content).join("\n"),
      /需求拆分 v1 已定稿/,
    );
  } finally {
    await disposeAgentSessions();
    await close();
  }
});
