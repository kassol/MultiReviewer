/**
 * Agent 会话的真实链路(issue #333):`POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 →
 * 会话记录 → SSE`,整条走一遍。模型由本机的假服务(`support/model-stub.ts`)按脚本扮演,
 * 全程不碰收费模型。先例是 `reviewer-evidence-session.test.ts`。
 *
 * 钉的是桩测不到的几件事:知识集真的分段进了模型请求、消息文本进了同一次请求、回复与工具
 * 调用作为 Pi 条目落进记录表并经 SSE 送达、用量按条目累加到会话上,以及子进程跑完一个回合
 * 之后**留着**——第二条消息不必再建一次会话。
 *
 * 排队、插话、清空、停止与流式帧(issue #334)也只从外部看:排队的那一条在哪一次模型请求里
 * 出现、插话出现在工具结果之后还是之前、清空之后一共发了几次请求、停止之后记录表里落了哪
 * 两条、流式帧带不带 `id`。子进程内部一概不看。
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
import { startModelStub, type StubRequest, type StubTurn } from "./support/model-stub.ts";
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
  mode?: "followUp" | "steer",
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId, text, ...(mode === undefined ? {} : { mode }) }),
  });
}

/** 这个会话此刻排着哪几条(issue #334)。排队列表跟着读会话一起回。 */
async function queueOf(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<{ mode: string; text: string }[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { queue: { mode: string; text: string }[] }).queue;
}

/** 一次请求里所有消息的正文拼起来。断言「这句话进了 / 没进这一次请求」用它。 */
function bodyOf(request: StubRequest): string {
  return request.messages.map((message) => message.content).join("\n");
}

/** 等到假模型服务至少收到这么多次请求。等的是它那一侧的事实,不猜子进程的时序。 */
async function requestsAtLeast(requests: readonly StubRequest[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (requests.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,假模型服务还没收到 ${count} 次请求`);
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
    // 工具面就是只读四件套加受控 git,写工具一个都没注册。
    assert.deepEqual([...requests[0]!.tools].sort(), ["find", "git", "grep", "ls", "read"]);

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

test("执行中发「排队」:这一轮跑完之后才投递", async () => {
  const path = `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts`;
  const turns: StubTurn[] = [
    // 回得慢一点:这一轮还在跑的时候人才来得及排队。
    {
      text: "先读一下",
      toolCall: { name: "read", args: { path } },
      usage: { input: 10, output: 2 },
      delayMs: 1500,
    },
    { text: "这一轮说完了", usage: { input: 11, output: 2 } },
    { text: "补充也收到了", usage: { input: 12, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 执行中的这一条不被挡下,受理即 202,排队列表里立刻看得到它。
    const queued = await send(h, cookie, sessionId, "c2", "再补一句", "followUp");
    assert.equal(queued.status, 202, await queued.text());
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "followUp", text: "再补一句" },
    ]);

    await requestsAtLeast(requests, 3);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 3);
    // 本轮第二次请求里还没有它,工具批次的结果已经在里面:排队的等这一轮全跑完才投递。
    assert.ok(bodyOf(requests[1]!).includes("export const answer"), "工具结果没回到本轮请求里");
    assert.ok(!bodyOf(requests[1]!).includes("再补一句"), "排队的消息在本轮里就投出去了");
    assert.ok(bodyOf(requests[2]!).includes("再补一句"), "排队的消息没投递");
    // 投出去之后队列就空了。
    assert.deepEqual(await queueOf(h, cookie, sessionId), []);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("执行中发「插话」:下一个回合边界投递,工具批次完整跑完", async () => {
  const prefix = `${GITEA_REPO.owner}/${GITEA_REPO.repo}`;
  const turns: StubTurn[] = [
    {
      text: "两个文件都读一下",
      toolCalls: [
        { name: "read", args: { path: `${prefix}/src/answer.ts` } },
        { name: "read", args: { path: `${prefix}/src/other.ts` } },
      ],
      usage: { input: 10, output: 2 },
      delayMs: 1500,
    },
    { text: "按你说的改方向", usage: { input: 11, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 等第一次模型请求发出去再插话:Pi 开跑之前也取一次插话队列,那一档验不到「不打断工具
    // 批次」——这一条要落在工具批次已经排定的那一刻。
    await requestsAtLeast(requests, 1);
    const interjected = await send(h, cookie, sessionId, "c2", "先别读了,说结论", "steer");
    assert.equal(interjected.status, 202, await interjected.text());
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "steer", text: "先别读了,说结论" },
    ]);

    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 2);
    // 第二次请求里两条工具结果都在,插话排在它们之后:整批跑完才到回合边界。
    const messages = requests[1]!.messages;
    assert.equal(messages.filter((message) => message.role === "tool").length, 2);
    const lastTool = messages.map((message) => message.role).lastIndexOf("tool");
    const interjection = messages.findIndex(
      (message) => message.role === "user" && message.content.includes("先别读了"),
    );
    assert.ok(interjection > lastTool, "插话插在工具批次中间了");
    assert.deepEqual(await queueOf(h, cookie, sessionId), []);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("清空队列:排队与插话都不再投递", async () => {
  const path = `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts`;
  const turns: StubTurn[] = [
    {
      text: "先读一下",
      toolCall: { name: "read", args: { path } },
      usage: { input: 10, output: 2 },
      delayMs: 2000,
    },
    { text: "这一轮说完了", usage: { input: 11, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 两条都排在开跑之后:Pi 开跑前那一次取插话队列不该把它们先取走。
    await requestsAtLeast(requests, 1);
    assert.equal((await send(h, cookie, sessionId, "c2", "排队的一句", "followUp")).status, 202);
    assert.equal((await send(h, cookie, sessionId, "c3", "插话的一句", "steer")).status, 202);
    assert.equal((await queueOf(h, cookie, sessionId)).length, 2);

    const cleared = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/queue`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { queue: [] });

    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);
    // 脚本只有两次响应:多投一条出去就会有第三次请求,而那一次会回 500。
    assert.equal(requests.length, 2);
    const sent = requests.map(bodyOf).join("\n");
    assert.ok(!sent.includes("排队的一句"), "清空之后排队的那一条还是投出去了");
    assert.ok(!sent.includes("插话的一句"), "清空之后插话的那一条还是投出去了");
    assert.deepEqual(await queueOf(h, cookie, sessionId), []);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("停止:中止当前这一步、两条记录落库,排队消息留到下次发消息时投递", async () => {
  const path = `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts`;
  const turns: StubTurn[] = [
    // 这一次回应挂着不回,等着被中止。
    {
      text: "开始读",
      toolCall: { name: "read", args: { path } },
      usage: { input: 10, output: 2 },
      delayMs: 2000,
    },
    { text: "排队那一条的回答", usage: { input: 11, output: 2 } },
    { text: "新的那一条的回答", usage: { input: 12, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    assert.equal((await send(h, cookie, sessionId, "c2", "排队的一句", "followUp")).status, 202);
    // 模型请求已经发出去:当前这一步确实在跑。
    await requestsAtLeast(requests, 1);

    const stopped = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stop`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), {
      stopped: true,
      queue: [{ mode: "followUp", text: "排队的一句" }],
    });
    await idle(h, cookie, sessionId);

    // 被中止的回复照常落库,人点停止另以 custom 条目落同一张表(ADR 0031)。
    const landed = await records(h, cookie, sessionId);
    const aborted = landed.filter(
      (record) =>
        record.type === "message" &&
        (record.entry.message as { stopReason?: string } | undefined)?.stopReason === "aborted",
    );
    assert.equal(aborted.length, 1, "被中止的回复没落库");
    const system = landed.filter((record) => record.type === "custom");
    assert.equal(system.length, 1);
    assert.match(JSON.stringify(system[0]!.entry), /人点了停止/);
    // 排队的那一条没被停止带走。
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "followUp", text: "排队的一句" },
    ]);

    // 下次发消息时,留存的那一条先投递,新的这一条排在它后面。
    assert.equal((await send(h, cookie, sessionId, "c3", "再说一句")).status, 202);
    await requestsAtLeast(requests, 3);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 3);
    assert.ok(bodyOf(requests[1]!).includes("排队的一句"), "留存的排队消息没被投递");
    assert.ok(bodyOf(requests[2]!).includes("再说一句"));
    assert.deepEqual(await queueOf(h, cookie, sessionId), []);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("流式 delta 走无 id 的瞬时帧:不落库,重连不回放", async () => {
  const turns: StubTurn[] = [{ text: "流着回一句", usage: { input: 10, output: 2 } }];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    const stream = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stream`, {
      headers: { cookie },
    });
    assert.equal(stream.status, 200);
    const reader = frameReader(stream);
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);

    // 帧里总会有一条不带 id 的:那是流式帧,正在生成的文字在它的 payload 里。
    let delta: { kind: string; payload: { text: string; tool?: string } } | undefined;
    for (let read = 0; read < 12 && delta === undefined; read += 1) {
      const frame = await reader.next();
      if (frame.id !== undefined) continue;
      delta = JSON.parse(frame.data) as { kind: string; payload: { text: string; tool?: string } };
    }
    assert.ok(delta !== undefined, "没收到流式帧");
    assert.equal(delta.kind, "agent_session_stream");
    assert.match(delta.payload.text, /流着回一句/);
    await reader.cancel();
    await idle(h, cookie, sessionId);

    // 重连只补落库的条目:回放出来的每一帧都带 id,流式帧一条都不在里面。
    const landed = await records(h, cookie, sessionId);
    const replay = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stream?after=0`, {
      headers: { cookie },
    });
    const again = frameReader(replay);
    const ids: (string | undefined)[] = [];
    for (let read = 0; read < landed.length; read += 1) ids.push((await again.next()).id);
    assert.deepEqual(
      ids,
      landed.map((record) => String(record.seq)),
    );
    await again.cancel();
  } finally {
    await disposeAgentSessions();
    await close();
  }
});
