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
 *
 * 产出工具与定稿(issue #337)同律:看的是产出表落了几版、打回的那几次落没落、定稿那句话
 * 有没有出现在下一次模型请求里。
 *
 * 子进程生命周期(issue #335)看的也都是外部事实:回收之后那一次请求里有没有此前的全部消息、
 * 名额满时接口回几、判死与模型切换在记录表里留了哪条系统消息、压缩条目落没落库、会话上那个
 * 「前 N 条不在上下文」是几。回收与判死的门槛按毫秒注入,不真等十分钟。
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import { MISSING_IMAGE_TEXT } from "../src/reviewer/session-images.ts";
import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { pngBytes, pngSize } from "./support/png.ts";
import { putGlobalSettings, seedReviewRule } from "./support/store-seed.ts";
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

/** 起 harness 时可以拨动的那几样(issue #335)。省略即取服务默认值。 */
type SessionHarnessOptions = {
  /** 空闲回收门槛(毫秒)。验「回收后再发消息从记录重建」的用例拨到毫秒级。 */
  idleReclaimMs?: number;
  /** 执行中静默判死门槛(毫秒)。验判死的用例拨到秒级。 */
  silenceTimeoutMs?: number;
  /** 这个模型服务上的模型。省略即只有 harness 那一个;验模型切换的用例给两个。 */
  models?: readonly string[];
  /** 模型声明的字段。验 compaction 的用例给一个小上下文窗口。 */
  fields?: { contextWindow?: number };
  /** 这个产品下再建几个会话(验常驻名额上限用)。 */
  extraSessions?: number;
  /** 模型目录声明的输入能力(issue #336)。省略即只有文本,图片用例传含 image 的那一份。 */
  input?: readonly ("text" | "image")[];
};

/**
 * 起一套指向假模型服务的 harness:注册 harness 那个仓库、建产品、给创建者 agent:chat,
 * 回会话 id 与创建者的 cookie。模型服务的地址就是假服务的地址,因此解析出的辅助模型
 * (生效组合首个)打到它上面。
 */
async function startSessionHarness(
  turns: readonly StubTurn[],
  options: SessionHarnessOptions = {},
): Promise<{
  h: PanelHarness;
  cookie: string;
  sessionId: number;
  /** 这个产品下另外几个会话的 id(`extraSessions` 给了才有),按建立顺序。 */
  extraSessionIds: number[];
  productId: number;
  requests: Awaited<ReturnType<typeof startModelStub>>["requests"];
  close: () => Promise<void>;
}> {
  const stub = await startModelStub(turns);
  const h = await startPanelHarness({
    ...(options.idleReclaimMs === undefined
      ? {}
      : { agentSessionIdleReclaimMs: options.idleReclaimMs }),
    ...(options.silenceTimeoutMs === undefined
      ? {}
      : { agentSessionSilenceTimeoutMs: options.silenceTimeoutMs }),
  });
  seedAvailableModelService(
    h,
    HARNESS_SPEC.provider,
    options.models ?? [HARNESS_SPEC.model],
    {
      ...(options.fields ?? {}),
      ...(options.input === undefined ? {} : { input: [...options.input] }),
    },
    stub.baseUrl,
  );
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
  const extraSessionIds: number[] = [];
  for (let more = 0; more < (options.extraSessions ?? 0); more += 1) {
    const another = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "requirement-breakdown" }),
    });
    assert.equal(another.status, 201);
    extraSessionIds.push(((await another.json()) as { session: { id: number } }).session.id);
  }
  return {
    h,
    cookie,
    sessionId: session.id,
    extraSessionIds,
    productId: product.id,
    requests: stub.requests,
    close: stub.close,
  };
}

function send(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  clientMessageId: string,
  text: string,
  mode?: "followUp" | "steer",
  /** 这条消息带的图片 id(issue #336)。 */
  images?: readonly string[],
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      clientMessageId,
      text,
      ...(mode === undefined ? {} : { mode }),
      ...(images === undefined ? {} : { images }),
    }),
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

    // SSE:这一轮的六条记录都到了,帧 id 就是 seq。不带 id 的是流式帧(issue #334),
    // 它与落库条目共用这个频道,数记录时跳过。
    const ids: string[] = [];
    while (ids.length < 6) {
      const frame = await reader.next();
      if (frame.id !== undefined) ids.push(frame.id);
    }
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

test("带图的消息:base64 进了模型请求,记录里只剩文件引用", async () => {
  const turns: StubTurn[] = [{ text: "图上是报销单的列表页", usage: { input: 40, output: 8 } }];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    input: ["text", "image"],
  });
  try {
    const upload = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/images`, {
      method: "POST",
      headers: { cookie, "content-type": "image/png" },
      body: pngBytes(24, 16),
    });
    const uploadText = await upload.text();
    assert.equal(upload.status, 201, uploadText);
    const { image } = JSON.parse(uploadText) as { image: { imageId: string } };

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE, undefined, [image.imageId])).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);

    // 模型请求里那条用户消息带着这张图的 base64,正文仍是人发的那句话。
    const user = requests[0]!.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", new RegExp(MESSAGE));
    assert.equal(user?.images?.length, 1);
    assert.equal(user?.images?.[0]!.mimeType, "image/png");
    const sent = Buffer.from(user!.images![0]!.data, "base64");
    assert.deepEqual(pngSize(sent), { width: 24, height: 16 });

    // 记录里只剩文件引用:base64 不进库(ADR 0031 的图片例外)。
    const landed = await records(h, cookie, sessionId);
    const entry = JSON.stringify(landed.find((record) => record.entry.message?.role === "user"));
    assert.match(entry, /"image-ref"/);
    assert.match(entry, new RegExp(`"imageId":"${image.imageId}"`));
    assert.doesNotMatch(entry, /"type":"image"/);
    assert.doesNotMatch(entry, new RegExp(sent.toString("base64").slice(0, 64)));
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/** 上传一张 24×16 的 PNG,回它的图片 id。带图的几条用例共用这一件。 */
async function uploadImage(h: PanelHarness, cookie: string, sessionId: number): Promise<string> {
  const upload = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/images`, {
    method: "POST",
    headers: { cookie, "content-type": "image/png" },
    body: pngBytes(24, 16),
  });
  const text = await upload.text();
  assert.equal(upload.status, 201, text);
  return (JSON.parse(text) as { image: { imageId: string } }).image.imageId;
}

test("回收之后重建:记录里的图片引用读回 base64 再喂给模型", async () => {
  const turns: StubTurn[] = [
    { text: "图上是报销单的列表页", usage: { input: 40, output: 8 } },
    { text: "接着说那一版", usage: { input: 41, output: 8 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    input: ["text", "image"],
  });
  try {
    const imageId = await uploadImage(h, cookie, sessionId);
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE, undefined, [imageId])).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);
    // 回收:登记表摘掉,下一条消息从记录重建(issue #335)。
    await disposeAgentSessions();

    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);

    // 重建那一次请求里,此前那条用户消息带的是 base64 而不是文件引用。
    const rebuilt = requests[1]!;
    const user = rebuilt.messages.find((message) => message.role === "user");
    assert.match(user?.content ?? "", new RegExp(MESSAGE));
    assert.equal(user?.images?.length, 1);
    assert.equal(user?.images?.[0]!.mimeType, "image/png");
    assert.deepEqual(pngSize(Buffer.from(user!.images![0]!.data, "base64")), {
      width: 24,
      height: 16,
    });
    assert.ok(!bodyOf(rebuilt).includes("image-ref"), "文件引用原样进了模型上下文");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("排队中被排空:图片引用跟着那一条落库,重建补投时仍是 base64", async () => {
  const turns: StubTurn[] = [
    // 回得慢一点:这一轮还在跑的时候人才来得及排队。
    { text: "第一轮", usage: { input: 10, output: 2 }, delayMs: 1500 },
    { text: "图上是报销单的列表页", usage: { input: 40, output: 8 } },
    { text: "接着说那一版", usage: { input: 41, output: 8 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    input: ["text", "image"],
  });
  try {
    const imageId = await uploadImage(h, cookie, sessionId);
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 执行中排队的这一条带着图。
    const queued = await send(h, cookie, sessionId, "c2", "看这张图", "followUp", [imageId]);
    assert.equal(queued.status, 202, await queued.text());
    assert.deepEqual(await queueOf(h, cookie, sessionId), [{ mode: "followUp", text: "看这张图" }]);

    // 排空:在跑的那一轮中止,排着的这一条落库。
    await disposeAgentSessions();

    assert.equal((await send(h, cookie, sessionId, "c3", "接着说")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);

    // 重建补投的还是人当初发的那一条:正文与那张图都在。
    const carried = requests
      .slice(1)
      .flatMap((request) => request.messages)
      .find((message) => message.content.includes("看这张图"));
    assert.notEqual(carried, undefined, "排着的那一条没被补投");
    assert.equal(carried?.images?.length, 1);
    assert.deepEqual(pngSize(Buffer.from(carried!.images![0]!.data, "base64")), {
      width: 24,
      height: 16,
    });
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("图片文件丢了再重建:那一块是占位文本,历史照样续得上", async () => {
  const turns: StubTurn[] = [
    { text: "图上是报销单的列表页", usage: { input: 40, output: 8 } },
    { text: "接着说那一版", usage: { input: 41, output: 8 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    input: ["text", "image"],
  });
  try {
    const imageId = await uploadImage(h, cookie, sessionId);
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE, undefined, [imageId])).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);
    await disposeAgentSessions();

    // 人手动删掉那个文件:库里的引用还在,文件没了。
    const store = openStore(h.db.path);
    const image = store.getAgentSessionImage(sessionId, imageId)!;
    store.close();
    rmSync(image.path);

    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);

    // 那一块换成占位文本,正文与后一句都还在:丢一张图不该让整段历史重建不起来。
    const rebuilt = requests[1]!;
    const user = rebuilt.messages.find((message) => message.role === "user");
    assert.equal(user?.images, undefined);
    assert.match(user?.content ?? "", new RegExp(MISSING_IMAGE_TEXT.replace(/[[\]]/g, "\\$&")));
    assert.match(bodyOf(rebuilt), new RegExp(MESSAGE));
    assert.match(bodyOf(rebuilt), /接着说/);
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

    const rows = await records(h, cookie, sessionId);
    // 工具回的是 recorded:打回才换文案。
    assert.match(JSON.stringify(rows), /recorded/);
    // 记录表上多一条 custom 条目:对话流里由它长出产出卡片。
    const custom = rows.filter((row) => row.type === "custom");
    assert.equal(custom.length, 1);
    assert.deepEqual((custom[0]!.entry as { data?: unknown }).data, {
      kind: "requirement-breakdown",
      version: 1,
    });

    // SSE:那条 custom 条目也从流里送到了。不带 id 的流式帧(issue #334)不是记录,跳过。
    const seen: string[] = [];
    while (seen.length < rows.length && !seen.includes("custom")) {
      const frame = await reader.next();
      if (frame.id === undefined) continue;
      seen.push((JSON.parse(frame.data) as Record).type);
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
    const rows = await records(h, cookie, sessionId);
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
      const landed = await records(h, cookie, sessionId);
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

/* ─────────────── 排队、插话、清空、停止与流式帧(issue #334) ─────────────── */

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
      // 插话要在这一次回应到达之前投进去。4 秒而不是 1.5 秒:本机并行跑整套测试时进程排不上
      // 队,一两秒的窗口会让插话落到工具批次之后,那时它等的是再下一个回合边界(issue #335)。
      delayMs: 4000,
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

/* ─────────────── 子进程生命周期(issue #335) ─────────────── */

/** 回收之后才录的那条规则。重建时取的是当下的知识集,不是建会话那一刻的。 */
const LATER_RULE = "撤回只允许在当月内做";

/** 这个会话读接口报的「前 N 条不在上下文」。 */
async function droppedFromContext(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<number> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { droppedFromContext: number }).droppedFromContext;
}

/** 等到记录表里出现一条正文匹配的系统消息(ADR 0031 的 `custom` 条目)。 */
async function systemMessageMatching(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  pattern: RegExp,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const landed = await records(h, cookie, sessionId);
    const system = landed.filter((record) => record.type === "custom");
    if (system.some((record) => pattern.test(JSON.stringify(record.entry)))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 的记录里还没有匹配 ${String(pattern)} 的系统消息`);
}

test("空闲满门槛即回收:再发消息从记录重建,此前全部消息都在模型请求里", async () => {
  const turns: StubTurn[] = [
    { text: "第一轮", usage: { input: 10, output: 2 } },
    { text: "第二轮", usage: { input: 12, output: 3 } },
  ];
  const { h, cookie, sessionId, productId, requests, close } = await startSessionHarness(turns, {
    idleReclaimMs: 50,
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);
    // 空闲门槛 50ms:过了它子进程已经被回收(登记表摘掉、工作树与会话根释放)。
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 重建时取的是当下的知识集:这一条是回收之后才录进去的。
    seedReviewRule(h.db.path, GITEA_REPO.id, { type: "rule", scope: "", statement: LATER_RULE });

    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 4);
    await idle(h, cookie, sessionId);

    assert.equal(requests.length, 2);
    // 重建后这一次请求里有此前的全部消息:人说的那句、agent 回的那句,加这一条新的。
    const second = bodyOf(requests[1]!);
    assert.match(second, new RegExp(MESSAGE));
    assert.match(second, /第一轮/);
    assert.match(second, /接着说/);
    // 知识集是重建那一刻取的值。
    const system = requests[1]!.messages.filter((message) => message.role === "system");
    assert.match(system[0]!.content, new RegExp(LATER_RULE));

    // 重建那一刻的系统提示是新的一份,这就是「子进程换过一个」的证据:提示在建会话时定下,
    // 活着的那一个拿不到回收之后才录的规则。
    //
    // 喂回去的那一段不再镜像一遍:记录仍是起头两条加四条消息。Pi 不重复落「这次用哪个模型」
    // ——重建时喂回去的条目里已经写着同一个模型,它只在模型真的换了时才追加那一条。
    const landed = await records(h, cookie, sessionId);
    assert.deepEqual(
      landed.map((record) => record.type),
      ["model_change", "thinking_level_change", "message", "message", "message", "message"],
    );
    assert.deepEqual(messageRoles(landed), ["user", "assistant", "user", "assistant"]);
    // 记录完整,会话上那个数是 0。
    assert.equal(await droppedFromContext(h, cookie, sessionId), 0);

    // 仓库集合同样每次重建时取:产品把仓库移出去之后,下一条消息就开不起来。
    assert.equal(
      (await h.api("DELETE", `/products/${productId}/repos/${GITEA_REPO.id}`)).status,
      204,
    );
    const refused = await send(h, cookie, sessionId, "c3", "再说一句");
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /没有你有仓库分配的仓库/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("常驻名额有上限:全都在跑时回 409,有空闲的就回收最久空闲的那个再开", async () => {
  // 四个会话各占一个名额并挂在模型调用上,第五个因此没有名额可用。
  const slow: StubTurn = { text: "慢慢回", usage: { input: 10, output: 2 }, delayMs: 60_000 };
  const turns: StubTurn[] = [slow, slow, slow, slow, { text: "第五个的回答", usage: { input: 11, output: 2 } }];
  const { h, cookie, sessionId, extraSessionIds, requests, close } = await startSessionHarness(
    turns,
    { extraSessions: 4 },
  );
  try {
    const running = [sessionId, ...extraSessionIds.slice(0, 3)];
    const fifth = extraSessionIds[3]!;
    for (const [index, id] of running.entries()) {
      assert.equal((await send(h, cookie, id, `c${index}`, `第 ${index} 个会话的话`)).status, 202);
    }
    // 四个子进程都起来了:名额占满。
    await requestsAtLeast(requests, 4);

    const full = await send(h, cookie, fifth, "c5", "我也要拆");
    assert.equal(full.status, 409);
    assert.match(await full.text(), /名额已满,稍后再发/);

    // 停掉第一个:它回到空闲,名额让得出来。
    const stopped = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stop`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(stopped.status, 200);
    await idle(h, cookie, sessionId);

    // 同一个客户端消息 id 再发一次就收下了:满名额那一次判在受理之前,没把这条记成发过。
    assert.equal((await send(h, cookie, fifth, "c5", "我也要拆")).status, 202);
    await requestsAtLeast(requests, 5);
    assert.ok(bodyOf(requests[4]!).includes("我也要拆"), "第五个会话的消息没投出去");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("执行中连续静默即判死:记一条系统消息,下次发消息重建续上", async () => {
  const turns: StubTurn[] = [
    // 这一次挂着不回:静默闸合上。
    { text: "这一次不回", usage: { input: 10, output: 2 }, delayMs: 60_000 },
    { text: "重建之后的回答", usage: { input: 11, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    // 比起子进程那段准备时间要宽:闸计的是开跑之后的连续静默。
    silenceTimeoutMs: 3000,
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 1);

    await systemMessageMatching(h, cookie, sessionId, /执行中静默超时/);
    // 判死即登记表摘掉:会话回到空闲,人发得出下一条。
    await idle(h, cookie, sessionId);

    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);

    const second = bodyOf(requests[1]!);
    // 续上了:判死之前人说的那句还在上下文里。
    assert.match(second, new RegExp(MESSAGE));
    assert.match(second, /接着说/);
    // 系统消息不进模型上下文(ADR 0031)。
    assert.ok(!second.includes("静默超时"), "判死那条系统消息进了模型上下文");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("辅助模型变了:落一条系统消息、用新模型重建,上下文照旧续上", async () => {
  const turns: StubTurn[] = [
    { text: "第一轮", usage: { input: 10, output: 2 } },
    { text: "换了模型之后的回答", usage: { input: 11, output: 2 } },
  ];
  const second = "another-model";
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    models: [HARNESS_SPEC.model, second],
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);
    // 子进程还活着:这一刻把生效的辅助模型换成同一个服务上的另一个模型。
    const store = openStore(h.db.path);
    assert.equal(
      putGlobalSettings(store, {
        auxiliaryModelJson: JSON.stringify({ provider: HARNESS_SPEC.provider, model: second }),
      }),
      true,
    );
    store.close();

    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 4);
    await idle(h, cookie, sessionId);

    // 换模型那条系统消息在记录里,两头的模型都写明。
    await systemMessageMatching(h, cookie, sessionId, /辅助模型从 .+ 换成 .+/);
    const landed = await records(h, cookie, sessionId);
    const switched = landed.filter(
      (record) => record.type === "custom" && JSON.stringify(record.entry).includes("辅助模型从"),
    );
    assert.equal(switched.length, 1);
    assert.match(JSON.stringify(switched[0]!.entry), new RegExp(second));

    // 第二次请求打的是新模型,上下文仍是同一段。
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.model, HARNESS_SPEC.model);
    assert.equal(requests[1]!.model, second);
    assert.match(bodyOf(requests[1]!), new RegExp(MESSAGE));
    assert.match(bodyOf(requests[1]!), /第一轮/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("记录缺了中间一条:重建按截断续得下去,会话上报得出前几条不在上下文", async () => {
  const turns: StubTurn[] = [
    { text: "第一轮", usage: { input: 10, output: 2 } },
    { text: "缺损之后的回答", usage: { input: 11, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);
    // 回收:登记表摘掉,下一条消息从记录重建。
    await disposeAgentSessions();

    // 人为删掉中间那一条(人说的那句),模拟记录缺损。
    const db = new DatabaseSync(h.db.path);
    const landed = await records(h, cookie, sessionId);
    const userRow = landed.find((record) => record.entry.message?.role === "user")!;
    db.prepare("DELETE FROM agent_session_entry WHERE session_id = ? AND seq = ?").run(
      sessionId,
      userRow.seq,
    );
    db.close();

    // 剩下三条:末条顺 parentId 上行一步就指空,它之前的两条因此不在上下文里。
    assert.equal(await droppedFromContext(h, cookie, sessionId), 2);

    // 不拒绝续谈:照 Pi 的截断重建,新的一轮照样跑得完。
    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);
    const second = bodyOf(requests[1]!);
    assert.match(second, /接着说/);
    assert.ok(!second.includes(MESSAGE), "被截掉的那条还是进了上下文");
    // 缺损不会自己补回来:重建之后读接口仍报同一个数。
    assert.equal(await droppedFromContext(h, cookie, sessionId), 2);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("自动 compaction 开着:压缩条目落库,重建后用量连续", async () => {
  // 估出来的上下文要超过 Pi 默认的 keepRecentTokens(20000),压缩才真的切一刀:按 chars/4
  // 估,这一段回复就是八万多字符。声明的上下文窗口小,用量一报就过了触发线。
  const long = `压缩前的长篇回复 ${"报销单撤回的细节。".repeat(9000)}`;
  const summary = "压缩摘要:先前讨论了报销单撤回的范围与边界";
  const turns: StubTurn[] = [
    { text: long, usage: { input: 6000, output: 20 } },
    { text: summary, usage: { input: 100, output: 30 } },
    { text: "重建之后的回答", usage: { input: 12, output: 3 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    fields: { contextWindow: 20_000 },
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 第二次请求就是压缩那一次:它由 Pi 自己发起,不是人发的消息。
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);

    const landed = await records(h, cookie, sessionId);
    const compaction = landed.filter((record) => record.type === "compaction");
    assert.equal(compaction.length, 1, "压缩条目没落库");
    assert.match(JSON.stringify(compaction[0]!.entry), new RegExp(summary));
    // 压缩那次调用的用量挂在条目自己身上,照样累加到会话上(ADR 0031)。
    assert.equal(compaction[0]!.usage.totalTokens, 130);

    // 回收之后重建:压缩条目也喂回去,摘要因此在新一轮的上下文里。
    await disposeAgentSessions();
    assert.equal((await send(h, cookie, sessionId, "c2", "接着说")).status, 202);
    await requestsAtLeast(requests, 3);
    await idle(h, cookie, sessionId);
    assert.match(bodyOf(requests[2]!), new RegExp(summary));

    // 用量连续:三次响应的用量一项不少,重建没让它从压缩点重新起算。
    const read = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      headers: { cookie },
    });
    const { session } = (await read.json()) as { session: { usage: ReviewerUsage } };
    assert.deepEqual(session.usage, {
      inputTokens: 6112,
      outputTokens: 53,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 6165,
    });
  } finally {
    await disposeAgentSessions();
    await close();
  }
});
