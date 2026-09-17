/**
 * Agent 会话的真实链路(issue #333):`POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 →
 * 会话记录 → SSE`,整条走一遍。模型由本机的假服务(`support/model-stub.ts`)按脚本扮演,
 * 全程不碰收费模型。先例是 `reviewer-evidence-session.test.ts`。
 *
 * 钉的是桩测不到的几件事:知识目录真的进了模型请求、消息文本进了同一次请求、回复与工具
 * 调用作为 Pi 条目落进记录表并经 SSE 送达、用量按条目累加到会话上,以及子进程跑完一个回合
 * 之后**留着**——第二条消息不必再建一次会话。
 *
 * 排队、插话、清空、停止与流式帧(issue #334)也只从外部看:排队的那一条在哪一次模型请求里
 * 出现、插话出现在工具结果之后还是之前、清空之后一共发了几次请求、停止之后记录表里落了哪
 * 两条、流式帧带不带 `id`。子进程内部一概不看。
 *
 * 需求拆分(issue #366)同律:看的是题落成了哪条条目、术语与 spec / 票落进库没有、退役了的
 * 产出工具在不在工具清单里。
 *
 * 子进程生命周期(issue #335)看的也都是外部事实:回收之后那一次请求里有没有此前的全部消息、
 * 名额满时接口回几、判死与模型切换在记录表里留了哪条系统消息、压缩条目落没落库、会话上那个
 * 「前 N 条不在上下文」是几。回收与判死的门槛按毫秒注入,不真等十分钟。
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import { MISSING_IMAGE_TEXT } from "../src/reviewer/session-images.ts";
import {
  AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
  SYSTEM_MESSAGE_ENTRY,
} from "../src/reviewer/session-protocol.ts";
import { COMPLETE_SURVEY_TOOL } from "../src/reviewer/session-output-tools.ts";
import { ASK_QUESTION_ROUND_TOOL } from "../src/reviewer/session-question-tool.ts";
import {
  agentSessionContextGap,
  agentSessionStatus,
  disposeAgentSessions,
  killChild,
} from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  seedRepo,
  startPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";
import { pngBytes, pngSize } from "./support/png.ts";
import { putGlobalSettings, seedReviewRule } from "./support/store-seed.ts";
import { startModelStub, type StubRequest, type StubTurn } from "./support/model-stub.ts";
import { frameReader } from "./support/sse.ts";

const PASSWORD = "agent-session-subprocess-password";
const AT = "2026-09-12T00:00:00.000Z";

/** 知识集里的两条。陈述不进提示(issue #344),断言因此落在那一行条数上。 */
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

/** 会话子代理条目里的一趟(issue #358)。与 `src/reviewer/session-subagent.ts` 那一份同形。 */
type SubagentRunRecord = {
  task: string;
  status: string;
  steps: number;
  calls: { name: string; error?: string }[];
  conclusion: string;
};

/** 起 harness 时可以拨动的那几样(issue #335)。省略即取服务默认值。 */
type SessionHarnessOptions = {
  /** 这个会话的用途。省略即需求拆分;开放对话那几例(issue #364)另给。 */
  purpose?: string;
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
  /** 换一份 Forge(评审复核):备会话根要经它取仓库,造「子进程起不来」用它。 */
  wrapForge?: PanelHarnessOptions["wrapForge"];
  /**
   * 产品下再归入一个仓库(issue #345)。产品梳理要产品有两个以上仓库;内存 Forge 对每个
   * 仓库都回同一份夹具仓库,两棵工作树因此都备得出来。
   */
  extraRepo?: { repoId: number; owner: string; repo: string };
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
    ...(options.wrapForge === undefined ? {} : { wrapForge: options.wrapForge }),
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
  if (options.extraRepo !== undefined) {
    const extra = options.extraRepo;
    seedRepo(h, extra.repoId, extra.owner, extra.repo);
    // 第二个仓库直接落归属行:走归入端点会自己开一场梳理(issue #347),而这几例要的是它们
    // 自己投的那一条消息,不是那一场。
    const store = openStore(h.db.path);
    try {
      assert.equal(store.attachProductRepo(product.id, extra.repoId, AT), "attached");
    } finally {
      store.close();
    }
  }
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const response = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: options.purpose ?? "requirement-breakdown" }),
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

test("发一条消息:知识目录与消息文本进了模型请求,回复与工具调用落库并经 SSE 送达", async () => {
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

    // 模型请求里有系统提示的知识目录那一行、会话根的仓库目录,以及人发的那句话。
    assert.equal(requests.length, 2, "脚本两次响应,父会话就该发两次请求");
    const system = requests[0]!.messages.filter((message) => message.role === "system");
    assert.equal(system.length, 1);
    // 知识只报条数(issue #344):播下去的一条规则与一条事实在提示里就是这一行。
    assert.match(system[0]!.content, /^- acme\/widgets — 1 review rule, 1 project fact$/m);
    assert.doesNotMatch(system[0]!.content, new RegExp(RULE));
    assert.doesNotMatch(system[0]!.content, new RegExp(FACT));
    // 仓库清单那一行带短 sha(issue #351):这棵工作树停在生效默认分支(夹具那边是 `main`)
    // 的 head 上,agent 被问起看的是哪份代码时照着它说。
    assert.match(
      system[0]!.content,
      new RegExp(`^- acme/widgets ${h.repo.baseSha.slice(0, 7)}$`, "m"),
    );
    assert.match(system[0]!.content, /requirement-breakdown/);
    assert.ok(
      requests[0]!.messages.some(
        (message) => message.role === "user" && message.content.includes(MESSAGE),
      ),
      "发出去的那句话没进模型请求",
    );
    // 需求拆分的工具面:只读四件套、受控 git、历史 Finding 查询(issue #338)、知识的读写
    // 三件(issue #344、#360)、会话子代理(issue #358)、提问轮次(issue #359),再加产品
    // tracker 那九件(issue #361)——这个用途谈定之后写的就是一条 spec 与它的票。碰文件与
    // shell 的写工具一个都没注册;需求拆分那件产出工具随 issue #366 退役,清单里没有它。
    // 产品梳理的工具面另一例(它没有 tracker 那九件)在下面那条产品梳理用例里。
    assert.deepEqual([...requests[0]!.tools].sort(), [
      "ask_question_round",
      "find",
      "git",
      "grep",
      "ls",
      "query_findings",
      "query_knowledge",
      "read",
      "subagent",
      "tracker_block",
      "tracker_close",
      "tracker_comment",
      "tracker_create_spec",
      "tracker_create_ticket",
      "tracker_list",
      "tracker_read",
      "tracker_unblock",
      "tracker_update_body",
      "withdraw_knowledge",
      "write_knowledge",
    ]);

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

/* ─────────────── 需求拆分:访谈到 spec 与票(issue #366) ─────────────── */

/** 任意 JSON 对象。改坏一份好参数时按键改,不为此造一套类型。 */
type Json = globalThis.Record<string, unknown>;

/**
 * 需求拆分那一条链路(CONTEXT.md 需求拆分,ADR 0035):按轮问 → 人答 → 从答案写术语 →
 * 写 spec、拆票、连阻塞边。脚本化的模型照这个顺序走一遍,压的是外部事实:题落成条目、
 * 答案回来是一条用户消息、术语与 spec / 票落进库,以及退役了的产出工具不在工具清单里。
 */
test("需求拆分:一轮提问、从答案写术语、写 spec 与两张票并连上阻塞边", async () => {
  const [SPEC, FIRST, SECOND] = [1, 1, 2];
  const turns: StubTurn[] = [
    {
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: {
          questions: [
            {
              title: "按哪个汇率折算",
              body: "报销单提交之后汇率变了,折算金额跟不跟着变",
              options: [
                { text: "锁定提交当月的月结汇率", recommended: true },
                { text: "每次读当天汇率", recommended: false },
              ],
              multiple: false,
            },
          ],
        },
      },
      usage: { input: 100, output: 20 },
    },
    // 答案就是裁决:当轮把定下来的术语写进产品知识。
    {
      toolCall: {
        name: "write_knowledge",
        args: {
          kind: "term",
          name: "月结汇率",
          body: "每个月为每种币种定一次、当月不再变的折算汇率。",
          avoided: ["汇率快照"],
        },
      },
      usage: { input: 40, output: 8 },
    },
    {
      toolCall: {
        name: "tracker_create_spec",
        args: {
          title: "报销单按原币录入",
          body: "## Problem Statement\n\n外币报销现在要人手算折算金额。",
        },
      },
      usage: { input: 40, output: 8 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "月结汇率表", body: "按年月与币种唯一", label: "ready-for-agent" },
      },
      usage: { input: 30, output: 6 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: {
          spec: SPEC,
          title: "报销单按原币录入",
          body: "提交时锁定当月汇率",
          label: "ready-for-agent",
        },
      },
      usage: { input: 30, output: 6 },
    },
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: FIRST } },
      usage: { input: 20, output: 4 },
    },
    { text: "写好了一条 spec 与两张票", usage: { input: 20, output: 4 } },
  ];
  const { h, cookie, sessionId, productId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    const asked = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);
    assert.equal(asked.length, 1);
    assert.match(JSON.stringify(asked[0]!.entry), /锁定提交当月的月结汇率/);

    // 退役的产出工具不在工具清单里:这一场的产出落在产品知识与产品 tracker 上。
    assert.ok(!requests[0]!.tools.includes("submit_requirement_breakdown"));
    assert.ok(requests[0]!.tools.includes("tracker_create_spec"));

    // 答这一轮:合成的那条用户消息走与输入区同一条发消息路径。
    assert.equal(
      (await send(h, cookie, sessionId, "c2", "1. 按哪个汇率折算\n- 锁定提交当月的月结汇率")).status,
      202,
    );
    await idle(h, cookie, sessionId);

    const store = openStore(h.db.path);
    try {
      // 答案落成一条术语,写下即生效。
      assert.deepEqual(
        store
          .listProductKnowledge(productId)
          .map((entry) => [entry.kind, entry.name, entry.writtenBySessionId]),
        [["term", "月结汇率", sessionId]],
      );
      // spec 与它的两张票落在这个产品下,记着写下它们的这一场会话。
      assert.deepEqual(
        store.listProductSpecs(productId).map((spec) => [spec.id, spec.title, spec.sessionId]),
        [[SPEC, "报销单按原币录入", sessionId]],
      );
      assert.deepEqual(
        store
          .listProductTickets(productId)
          .map((one) => [one.id, one.title, one.blockedBy, one.sessionId]),
        [
          [FIRST, "月结汇率表", [], sessionId],
          [SECOND, "报销单按原币录入", [FIRST], sessionId],
        ],
      );
    } finally {
      store.close();
    }
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

const SURVEY_REPO_ID = 909;
const SURVEY_REPO = { repoId: SURVEY_REPO_ID, owner: "acme", repo: "alpha" };
const ACTIVE_STATEMENT = "acme/widgets 的订单接口由 acme/alpha 的网关转发,契约是 OpenAPI";

/** 产品页读到的一条产品知识(CONTEXT.md 产品知识,issue #360)。 */
type KnowledgeEntry = {
  id: number;
  kind: "term" | "relationship" | "decision";
  name: string;
  body: string;
  topic: string | null;
  avoided: string[];
  options: string | null;
  consequences: string | null;
  supersededBy: number | null;
  annotations: { location: string; reason: string }[];
};

/** 这个产品此刻的产品知识(CONTEXT.md 产品知识)。 */
async function productKnowledge(h: PanelHarness, productId: number): Promise<KnowledgeEntry[]> {
  const response = await h.api("GET", `/products/${productId}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { knowledge: KnowledgeEntry[] }).knowledge;
}

/** 落一条产品知识,不经子进程。压提示与改写的那几例用它播种。 */
function seedKnowledge(
  dbPath: string,
  productId: number,
  record: { kind: "term" | "relationship" | "decision"; name?: string; body: string },
): number {
  const store = openStore(dbPath);
  try {
    return store.writeProductKnowledge({
      productId,
      kind: record.kind,
      name: record.name ?? "",
      body: record.body,
      topic: null,
      avoided: [],
      options: null,
      consequences: null,
      annotations: [],
      at: AT,
      sessionId: null,
    })!.id;
  } finally {
    store.close();
  }
}

/**
 * 产品梳理的整条访谈(CONTEXT.md 产品梳理,issue #365):派子代理出候选 → 抛一轮题 → 人答
 * → 把答案写成条目 → 宣告共识调完成工具。钉的是桩测不到的那几件——提示带的是**整份**产品
 * 知识(不是三行目录)、带着 skill 替代说明那一段、种子消息真的进了第一次模型请求、这四样
 * 动作各自落成会话记录,以及完成那一格落在会话上。
 *
 * 子代理那一趟走真实的 pi-subagents(先例:同文件「会话里派一个子代理」),因此脚本里夹着
 * 子会话自己那两轮。
 */
const SURVEY_TURNS: StubTurn[] = [
  {
    text: "先派个子代理读一遍",
    toolCall: {
      name: "subagent",
      args: { agent: "explore", task: "acme/widgets 里「订单」这个词指的是什么" },
    },
    usage: { input: 40, output: 10 },
  },
  // 子会话:读一个文件,回一句结论。
  {
    text: "读目标文件",
    toolCall: {
      name: "read",
      args: { path: `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts` },
    },
    usage: { input: 12, output: 4 },
  },
  { text: "answer.ts:1 写着 export const answer = 1;", usage: { input: 18, output: 8 } },
  // 拿着候选抛第一轮题,回合就地收尾等人答。
  {
    text: "候选出来了,先问你一轮",
    toolCall: {
      name: ASK_QUESTION_ROUND_TOOL,
      args: {
        questions: [
          {
            title: "订单指的是哪一层",
            body: "代码里 order 同时指请求体与聚合根,读不出哪个是这个产品说的那个",
            options: [
              { text: "下单后的那张单据", recommended: true },
              { text: "购物车里的一次结算请求", recommended: false },
            ],
            multiple: false,
          },
        ],
      },
    },
    usage: { input: 90, output: 18 },
  },
  // 答案回来:当场写成一条术语条目。
  {
    toolCall: {
      name: "write_knowledge",
      args: {
        kind: "term",
        name: "订单",
        body: "人下单之后生成的那张单据,从待审批走到已结清",
        topic: "报销",
        avoided: ["单子"],
      },
    },
    usage: { input: 30, output: 8 },
  },
  // frontier 空了:宣告共识并调完成工具。
  {
    text: "问不出新的了",
    toolCall: { name: COMPLETE_SURVEY_TOOL, args: {} },
    usage: { input: 20, output: 6 },
  },
  { text: "这个产品现在写下了「订单」这一条", usage: { input: 10, output: 4 } },
];

/** 面板把那一轮的答案合成的那条用户消息。 */
const SURVEY_ANSWER = ["提问轮次的回答:", "", "1. 订单指的是哪一层", "- 下单后的那张单据"].join(
  "\n",
);

test("产品梳理:提示带整份产品知识与替代说明,子代理、一轮题、写下的条目与完成标记都落库", async () => {
  const { h, productId, requests, close } = await startSessionHarness(SURVEY_TURNS, {
    extraRepo: SURVEY_REPO,
  });
  try {
    // 先落一条仓库关系与一条术语:梳理的提示带的是整条正文,不是目录里的一个名字。
    assert.equal(
      seedKnowledge(h.db.path, productId, { kind: "relationship", body: ACTIVE_STATEMENT }),
      1,
    );
    assert.equal(
      seedKnowledge(h.db.path, productId, {
        kind: "term",
        name: "结算",
        body: "把一张已审批的单据划给财务付款的那一步",
      }),
      2,
    );

    const opened = await h.api("POST", `/products/${productId}/survey`);
    const openedText = await opened.text();
    assert.equal(opened.status, 201, openedText);
    const { session } = JSON.parse(openedText) as { session: { id: number; createdBy: string } };
    await roundsAtLeast(h, h.cookie, session.id, 1);
    await idle(h, h.cookie, session.id);

    const system = requests[0]!.messages.filter((message) => message.role === "system");
    assert.equal(system.length, 1);
    assert.match(system[0]!.content, /^## This session: interviewing the person about this product$/m);
    // 整份产品知识,不是三行目录:那一条仓库关系带着它的 id 与正文出现在提示里。
    assert.match(
      system[0]!.content,
      new RegExp(`^- \\[1\\] repository relationship: ${ACTIVE_STATEMENT}$`, "m"),
    );
    assert.match(
      system[0]!.content,
      /^- \[2\] glossary term 结算: 把一张已审批的单据划给财务付款的那一步$/m,
    );
    // 目录那一行只给别的用途:这个用途看得到自己可能改写的每一条正文。
    assert.doesNotMatch(system[0]!.content, /^- Glossary terms:/m);
    // skill 替代说明那一段(issue #364)同在。
    assert.match(system[0]!.content, /^## The skills in this session$/m);
    // 这个用途的工具面:只读四件套、git、历史 Finding 查询、知识三件、提问轮次、会话子代理
    // 与无参的完成工具。**产品 tracker 那九件不在**(评审复核):梳理谈的是这个产品是什么,
    // 产出是产品知识条目,给它那九件只会让访谈中途拐去开票。
    assert.deepEqual([...requests[0]!.tools].sort(), [
      "ask_question_round",
      COMPLETE_SURVEY_TOOL,
      "find",
      "git",
      "grep",
      "ls",
      "query_findings",
      "query_knowledge",
      "read",
      "subagent",
      "withdraw_knowledge",
      "write_knowledge",
    ]);
    // 底座那一段 tracker 说明跟着工具面走:手上没有的工具不该在提示里写成「yours to write」。
    assert.doesNotMatch(system[0]!.content, /This product also has a tracker/);
    // 种子消息:开场投的那一条在第一次请求的用户消息里,它要的是先派子代理再抛第一轮题。
    const seed = requests[0]!.messages.find(
      (message) => message.role === "user" && message.content.includes("Survey this product with me"),
    );
    assert.ok(seed, "种子消息没进模型请求");
    assert.match(seed.content, /send subagents into the repositories/);

    // 子代理那一趟落成一条记录,提问轮次落成另一种条目。
    const drafted = await records(h, h.cookie, session.id);
    const dispatched = drafted.filter(
      (one) => (one.entry as { customType?: string }).customType === "multireviewer-session-subagent",
    );
    assert.equal(dispatched.length, 1, "子代理派单没落成条目");
    const { runs } = (dispatched[0]!.entry as unknown as { data: { runs: SubagentRunRecord[] } })
      .data;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "done");

    // 一轮题抛出去就收尾:这一刻还没写下新条目。
    assert.equal(
      (await productKnowledge(h, productId)).map((row) => row.kind).join(","),
      "term,relationship",
    );

    // 人答完这一轮:答案当场写成一条术语条目,接着 agent 宣告共识。
    assert.equal(
      (
        await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}/messages`, {
          method: "POST",
          headers: { cookie: h.cookie, "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId: "c2", text: SURVEY_ANSWER }),
        })
      ).status,
      202,
    );
    await idle(h, h.cookie, session.id);

    assert.deepEqual(
      (await productKnowledge(h, productId)).map((row) => [row.kind, row.name, row.topic]),
      [
        ["term", "结算", null],
        ["term", "订单", "报销"],
        ["relationship", "", null],
      ],
    );

    // 完成标记落在会话上:同一个产品的下一场因此开得起来。
    const read = await h.api("GET", `/agent-sessions/${session.id}`);
    assert.equal(read.status, 200);
    const completedAt = (
      (await read.json()) as { session: { completedAt: string | null } }
    ).session.completedAt;
    assert.notEqual(completedAt, null);

    // 谈完的会话照旧续得了:创建者再发一条,接口收下它。
    const again = await h.api("POST", `/products/${productId}/survey`);
    assert.equal(again.status, 201, await again.text());
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/** 一次知识写入的脚本响应。 */
function writeKnowledge(args: globalThis.Record<string, unknown>): StubTurn {
  return { toolCall: { name: "write_knowledge", args }, usage: { input: 10, output: 2 } };
}

test("知识工具:三种条目写下即生效,改写与撤回算数,形状不对的带理由打回", async () => {
  const annotation = { location: "acme/widgets/src/order.ts:42", reason: "状态机在这里" };
  const turns: StubTurn[] = [
    // 定义里带路径:打回,说得出判据。
    writeKnowledge({ kind: "term", name: "订单", body: "src/order.ts 里的那个聚合根" }),
    // 决策没有标题:打回。
    writeKnowledge({ kind: "decision", body: "签名换成 HMAC,因为对称密钥好轮换" }),
    // 定义为空:打回。
    writeKnowledge({ kind: "term", name: "订单", body: "   " }),
    writeKnowledge({
      kind: "term",
      name: "订单",
      body: "一次可以付钱的购买请求,付款成功之后才进履约。",
      topic: "交易",
      avoided: ["单子", ""],
      annotations: [annotation],
    }),
    writeKnowledge({ kind: "relationship", body: "网关向订单服务要状态,订单服务不回调网关。" }),
    writeKnowledge({
      kind: "decision",
      name: "签名统一用 HMAC",
      body: "两个仓库各签各的,轮换一次要改两处;统一成 HMAC,密钥一处轮换。",
      options: "考虑过非对称签名,私钥分发更麻烦。",
      consequences: "两侧都要读同一份密钥。",
    }),
    // 改写第一条:定义换一版,id 不变。
    writeKnowledge({
      kind: "term",
      entryId: 1,
      name: "订单",
      body: "一次可以付钱的购买请求,取消之前都改得动。",
      topic: "交易",
    }),
    {
      toolCall: {
        name: "query_knowledge",
        args: { names: ["订单", "签名统一用 HMAC"], relationships: true },
      },
      usage: { input: 10, output: 2 },
    },
    {
      toolCall: { name: "withdraw_knowledge", args: { entryId: 2 } },
      usage: { input: 10, output: 2 },
    },
    { text: "写完了", usage: { input: 8, output: 2 } },
  ];
  const { h, cookie, sessionId, productId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    // 三件知识工具都在工具面上,所有用途都注册。
    for (const tool of ["query_knowledge", "write_knowledge", "withdraw_knowledge"]) {
      assert.ok(requests[0]!.tools.includes(tool), `工具面里没有 ${tool}`);
    }

    const rows = await records(h, cookie, sessionId);
    const results = rows
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry.message?.content));
    assert.equal(results.length, 9, `工具结果条数不对:${results.join("\n")}`);
    // 三道打回各说一句能改得动的理由。
    assert.match(results[0]!, /reads as implementation/);
    assert.match(results[0]!, /it contains the path src\/order.ts/);
    assert.match(results[1]!, /a decision needs a title/);
    assert.match(results[2]!, /the definition is empty/);
    // 落下来的那三条各回自己的 id:改写与撤回按它指。
    assert.match(results[3]!, /written as entry 1/);
    assert.match(results[4]!, /written as entry 2/);
    assert.match(results[5]!, /written as entry 3/);

    // 按名字读整条:术语带分组、决策带状态与备选项,仓库关系整段回。
    assert.match(results[7]!, /\[1\] glossary term 订单 \(topic 交易\)/);
    assert.match(results[7]!, /一次可以付钱的购买请求,取消之前都改得动。/);
    assert.match(results[7]!, /\[2\] repository relationship: 网关向订单服务要状态/);
    assert.match(results[7]!, /\[3\] decision 签名统一用 HMAC \(in force\)/);
    assert.match(results[7]!, /Options considered: 考虑过非对称签名/);
    // 出处附注只在产品页上看得到,一次查询里不回(ADR 0035)。
    assert.equal(results[7]!.includes(annotation.location), false);
    assert.equal(results[7]!.includes(annotation.reason), false);

    // 产品页读到的最终形状:改写落在同一条上,撤回那一条不在了,附注在。
    const knowledge = await productKnowledge(h, productId);
    assert.deepEqual(
      knowledge.map((row) => [row.id, row.kind, row.name]),
      [
        [1, "term", "订单"],
        [3, "decision", "签名统一用 HMAC"],
      ],
    );
    const term = knowledge[0]!;
    assert.equal(term.body, "一次可以付钱的购买请求,取消之前都改得动。");
    assert.equal(term.topic, "交易");
    // 改写是整条替换:上一版列出的避免词没留在这一版上。
    assert.deepEqual(term.avoided, []);
    assert.deepEqual(term.annotations, []);
    const decision = knowledge[1]!;
    assert.equal(decision.supersededBy, null);
    assert.equal(decision.consequences, "两侧都要读同一份密钥。");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 产品 tracker 的工具面(CONTEXT.md 产品 tracker,issue #361)。
 *
 * 票号在脚本里是写死的:临时库里两张表都从 1 起自增,别的产品那一条 spec 与那一张票在会话
 * 开跑之前先落库,因此占掉 1 号,这一场写下的 spec 是 2 号、两张票是 2 与 3 号。
 */
test("tracker 工具:写 spec 与票、加阻塞边、改正文、关票与评论,自指与跨产品的边被打回", async () => {
  const FOREIGN_TICKET = 1;
  const SPEC = 2;
  const [FIRST, SECOND] = [2, 3];
  const turns: StubTurn[] = [
    {
      toolCall: {
        name: "tracker_create_spec",
        args: { title: "  报销单可以撤回  ", body: "## Problem Statement\n\n提交之后改不了。" },
      },
      usage: { input: 100, output: 20 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "撤回接口", body: "PATCH /expenses/{id}", label: "ready-for-agent" },
      },
      usage: { input: 30, output: 5 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "撤回按钮", body: "列表页每行一颗", label: "needs-info" },
      },
      usage: { input: 30, output: 5 },
    },
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: FIRST } },
      usage: { input: 20, output: 4 },
    },
    {
      toolCall: {
        name: "tracker_update_body",
        args: { kind: "ticket", id: FIRST, body: "PATCH /expenses/{id};重复撤回回 409。" },
      },
      usage: { input: 20, output: 4 },
    },
    {
      toolCall: { name: "tracker_close", args: { kind: "ticket", id: FIRST } },
      usage: { input: 20, output: 4 },
    },
    {
      toolCall: {
        name: "tracker_comment",
        args: { ticket: SECOND, body: "财务确认了只有草稿态能撤回。" },
      },
      usage: { input: 20, output: 4 },
    },
    // 自指的边。
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: SECOND } },
      usage: { input: 20, output: 4 },
    },
    // 别的产品那张票。
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: FOREIGN_TICKET } },
      usage: { input: 20, output: 4 },
    },
    { toolCall: { name: "tracker_list", args: {} }, usage: { input: 20, output: 4 } },
    { text: "写完了", usage: { input: 20, output: 4 } },
  ];
  const { h, cookie, sessionId, productId, close } = await startSessionHarness(turns);
  try {
    // 别的产品的 spec 与票:跨产品的边要打回的正是指向它的那一条。
    const store = openStore(h.db.path);
    let foreignProductId: number;
    try {
      foreignProductId = store.createProduct({ name: "结算系统", createdAt: AT }).id;
      const foreignSpec = store.createProductSpec({
        productId: foreignProductId,
        title: "对账",
        body: "别的产品的 spec",
        sessionId: null,
        at: AT,
      });
      assert.equal(
        store.createProductTicket({
          specId: foreignSpec.id,
          title: "对账明细",
          body: "别的产品的票",
          label: "needs-triage",
          sessionId: null,
          at: AT,
        }).id,
        FOREIGN_TICKET,
      );
    } finally {
      store.close();
    }

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    const after = openStore(h.db.path);
    try {
      // spec 与票都落在这个产品下,标题两头的空白去掉了。
      const specs = after.listProductSpecs(productId);
      assert.deepEqual(
        specs.map((spec) => [spec.id, spec.title, spec.state, spec.sessionId]),
        [[SPEC, "报销单可以撤回", "open", sessionId]],
      );
      assert.match(specs[0]!.body, /提交之后改不了。/);

      const tickets = after.listProductTickets(productId);
      assert.deepEqual(
        tickets.map((one) => [one.id, one.title, one.label, one.state, one.blockedBy]),
        [
          [FIRST, "撤回接口", "ready-for-agent", "closed", []],
          [SECOND, "撤回按钮", "needs-info", "open", [FIRST]],
        ],
      );
      // 改正文改的就是那一张票。
      assert.match(tickets[0]!.body, /重复撤回回 409/);
      // 评论记在写它的那个会话名下。
      assert.deepEqual(
        after.listProductTicketComments(SECOND).map((one) => [one.body, one.sessionId]),
        [["财务确认了只有草稿态能撤回。", sessionId]],
      );
      // 打回的那两条一条边都没加上,别的产品那张票也没被牵进来。
      assert.deepEqual(after.getProductTicket(FOREIGN_TICKET)?.blockedBy, []);
      assert.equal(after.listProductSpecs(foreignProductId).length, 1);
    } finally {
      after.close();
    }

    // 两次打回各自的理由在记录表里的工具结果上,打回走的是正常返回。
    const results = (await records(h, cookie, sessionId))
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.equal(results.length, turns.length - 1);
    assert.match(results[7]!, /cannot block itself/);
    assert.match(results[8]!, new RegExp(`there is no ticket ${FOREIGN_TICKET} in this product`));
    // 列表看得到这条 spec 与它的两张票,阻塞关系也在。
    assert.match(results[9]!, new RegExp(`spec ${SPEC}`));
    assert.match(results[9]!, new RegExp(`blocked by ticket ${FIRST}`));
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 会话 skill(CONTEXT.md 会话 skill,issue #364)。
 *
 * 这一条是真实 SDK 的回归:铺进 agentDir 的那几个 skill 由 Pi 自己扫出来、写进系统提示的
 * `<available_skills>`,桩测验不到这一步。同时钉住「恰好是这几个」——Pi 默认还扫
 * `~/.agents/skills`,开发机上那一堆宿主机 skill 不能渗进会话。
 */
test("会话 skill:铺进 agentDir 的那几个被 Pi 列进系统提示,替代说明跟在用途那一段后面", async () => {
  const turns: StubTurn[] = [{ text: "在", usage: { input: 10, output: 2 } }];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    purpose: "open-conversation",
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", "这个产品是做什么的")).status, 202);
    await idle(h, cookie, sessionId);

    const system = requests[0]!.messages.find((message) => message.role === "system")!.content;
    const listed = [...system.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1]);
    // 开放对话那五个,加 pi-subagents 这个包自带的两份派单说明——它作为 pi 包铺进会话
    // (issue #358),Pi 连它 `skills/` 下的两个一起收。宿主机的全局 skill 目录一个都不在。
    assert.deepEqual(
      [...listed].sort(),
      [
        "ask-matt",
        "council-mode",
        "domain-modeling",
        "grilling",
        "pi-subagents",
        "to-spec",
        "to-tickets",
      ],
      "开放对话这一档列出的 skill 不对",
    );
    // 正文的位置也在提示里:模型据它用 read 打开,而 read 放行了这一段路径。
    for (const name of ["ask-matt", "domain-modeling", "grilling", "to-spec", "to-tickets"]) {
      assert.match(system, new RegExp(`<location>.*/skills/${name}/SKILL\\.md</location>`), name);
    }
    assert.match(system, /^## The skills in this session$/m);
    assert.match(system, /^## This session: an open conversation about this product$/m);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 开放对话走同一条流程(CONTEXT.md 开放对话,issue #364):说「grill 这个」得到一轮提问,
 * 说「收成 spec」把 spec 与票写进产品 tracker,想写文件被工具面挡回去。
 */
test("开放对话:grill 得到提问轮次,收成 spec 写进 tracker,写文件被工具面打回", async () => {
  const [SPEC, TICKET] = [1, 1];
  const turns: StubTurn[] = [
    {
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: {
          questions: [
            {
              title: "撤回到哪一步为止",
              body: "已经进了财务复核的单子还能不能撤回",
              options: [
                { text: "只有草稿态能撤回", recommended: true },
                { text: "复核前都能撤回", recommended: false },
              ],
              multiple: false,
            },
          ],
        },
      },
      usage: { input: 100, output: 20 },
    },
    {
      toolCall: {
        name: "tracker_create_spec",
        args: { title: "报销单可以撤回", body: "## Problem Statement\n\n提交之后改不了。" },
      },
      usage: { input: 40, output: 8 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "撤回接口", body: "PATCH /expenses/{id}", label: "ready-for-agent" },
      },
      usage: { input: 30, output: 6 },
    },
    { text: "写好了一条 spec 与一张票", usage: { input: 20, output: 4 } },
    {
      toolCall: { name: "write", args: { path: "notes.md", content: "撤回规则" } },
      usage: { input: 20, output: 4 },
    },
    { text: "这里写不了文件", usage: { input: 20, output: 4 } },
  ];
  const { h, cookie, sessionId, productId, close } = await startSessionHarness(turns, {
    purpose: "open-conversation",
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", "grill 这个:报销单可以撤回")).status, 202);
    // 一轮提问落成一条自己那一种的条目,会话就此转空闲等人答题。
    const asked = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);
    assert.equal(asked.length, 1);
    assert.match(JSON.stringify(asked[0]!.entry), /只有草稿态能撤回/);

    assert.equal((await send(h, cookie, sessionId, "c2", "收成 spec")).status, 202);
    await idle(h, cookie, sessionId);
    const store = openStore(h.db.path);
    try {
      assert.deepEqual(
        store.listProductSpecs(productId).map((spec) => [spec.id, spec.title, spec.sessionId]),
        [[SPEC, "报销单可以撤回", sessionId]],
      );
      assert.deepEqual(
        store.listProductTickets(productId).map((one) => [one.id, one.title, one.label]),
        [[TICKET, "撤回接口", "ready-for-agent"]],
      );
    } finally {
      store.close();
    }

    // 写文件那一次:`write` 一开始就没注册,调用它拿回的是一条错误的工具结果。
    assert.equal((await send(h, cookie, sessionId, "c3", "顺手写份笔记进仓库")).status, 202);
    await idle(h, cookie, sessionId);
    const results = (await records(h, cookie, sessionId))
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.match(results[results.length - 1]!, /"isError":true/);
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
  // 第一次回应等清空之后才放行:那之前 Pi 到不了回合边界,插话不会被先投出去。
  const { promise: firstReply, resolve: releaseFirst } = Promise.withResolvers<void>();
  const turns: StubTurn[] = [
    {
      text: "先读一下",
      toolCall: { name: "read", args: { path } },
      usage: { input: 10, output: 2 },
      release: firstReply,
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
    releaseFirst();

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

test("执行中连发排队与插话,紧接着读队列两条都在:晚到的队列现状不覆盖刚入队的那一条", async () => {
  // 第一次回应挂到读完队列才放行:两条都在执行中入队,Pi 也到不了回合边界去取它们。
  const { promise: firstReply, resolve: releaseFirst } = Promise.withResolvers<void>();
  const turns: StubTurn[] = [
    { text: "第一轮", usage: { input: 10, output: 2 }, release: firstReply },
    { text: "回插话", usage: { input: 11, output: 2 } },
    { text: "回排队", usage: { input: 12, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 1);
    assert.equal((await send(h, cookie, sessionId, "c2", "排队的一句", "followUp")).status, 202);
    assert.equal((await send(h, cookie, sessionId, "c3", "插话的一句", "steer")).status, 202);
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "steer", text: "插话的一句" },
      { mode: "followUp", text: "排队的一句" },
    ]);
    releaseFirst();

    await requestsAtLeast(requests, 3);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 3);
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

/** 回收之后才录的那条规则。重建时取的是当下的知识集条数,不是建会话那一刻的。 */
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
    // 知识集是重建那一刻取的值:条数从一条规则涨到两条(issue #344 只报条数)。
    const system = requests[1]!.messages.filter((message) => message.role === "system");
    assert.match(system[0]!.content, /^- acme\/widgets — 2 review rules, 1 project fact$/m);

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
    // 比起子进程那段准备时间要宽:闸计的是开跑之后的连续静默,而准备那一段里子进程一条
    // IPC 都不发——备工作树、建 Pi 会话,还要由 jiti 加载 vendor 的 pi-subagents(会话
    // 子代理,issue #358)。取一个明显宽于它的数;线上那一格是 5 分钟。
    silenceTimeoutMs: 15_000,
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

/** 停止这个会话当前的这一步。 */
async function stop(h: PanelHarness, cookie: string, sessionId: number): Promise<void> {
  const stopped = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stop`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(stopped.status, 200);
}

test("删会话与删产品都把常驻子进程收掉:登记表里不再有它", async () => {
  // 两个会话各挂在一次模型调用上:删的时候它们都还在跑。
  const slow: StubTurn = { text: "慢慢回", usage: { input: 10, output: 2 }, delayMs: 60_000 };
  const { h, cookie, sessionId, extraSessionIds, productId, requests, close } =
    await startSessionHarness([slow, slow], { extraSessions: 1 });
  const second = extraSessionIds[0]!;
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    assert.equal((await send(h, cookie, second, "c2", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 2);
    assert.equal(agentSessionStatus(sessionId), "running");
    assert.equal(agentSessionStatus(second), "running");

    // 删会话:库里那一行与子进程一起没了。只删行会留下一个挂着工作树、还在计时的子进程。
    const removed = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(removed.status, 204);
    assert.equal(agentSessionStatus(sessionId), "idle");

    // 删产品级联:它下面那个还在跑的会话同样被收掉。
    assert.equal((await h.api("DELETE", `/products/${productId}`)).status, 200);
    assert.equal(agentSessionStatus(second), "idle");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("子进程起不来:记录里留一条系统消息说明原因", async () => {
  // 备会话根要经 Forge 取仓库。注册仓库那一步先放过去,发消息那一下才失败。
  let failing = false;
  const { h, cookie, sessionId, close } = await startSessionHarness(
    [{ text: "用不到", usage: { input: 1, output: 1 } }],
    {
      wrapForge: (forge) => ({
        ...forge,
        getRepository: async (ref) => {
          if (failing) throw new Error("仓库取不回来");
          return forge.getRepository(ref);
        },
      }),
    },
  );
  try {
    failing = true;
    // 受理即 202:失败原因回不到这一次响应里,只能从记录里看到。
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const landed = await records(h, cookie, sessionId);
      const system = landed.filter((record) => record.type === "custom");
      if (system.length > 0) {
        assert.match(JSON.stringify(system[0]!.entry), /会话子进程启动失败:仓库取不回来/);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("等了 30 秒,记录里还没有那条系统消息");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("停止后留着排队消息的会话不算空闲:空闲回收与名额都不碰它", async () => {
  const slow: StubTurn = { text: "慢慢回", usage: { input: 10, output: 2 }, delayMs: 60_000 };
  const { h, cookie, sessionId, extraSessionIds, requests, close } = await startSessionHarness(
    [slow, slow, slow, slow],
    { extraSessions: 4, idleReclaimMs: 50 },
  );
  try {
    const fifth = extraSessionIds[3]!;
    // 四个会话各占一个常驻名额。
    for (const [index, id] of [sessionId, ...extraSessionIds.slice(0, 3)].entries()) {
      assert.equal((await send(h, cookie, id, `c${index}`, `第 ${index} 个会话的话`)).status, 202);
    }
    await requestsAtLeast(requests, 4);

    // 第一个会话排一条再停止:它回到空闲,队列里那一条还等着下次开跑时投出去。
    assert.equal((await send(h, cookie, sessionId, "q1", "排队的一句", "followUp")).status, 202);
    await stop(h, cookie, sessionId);
    await idle(h, cookie, sessionId);
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "followUp", text: "排队的一句" },
    ]);

    // 空闲门槛 50ms,等十倍的时间照样不回收;名额也不腾给第五个会话——排着消息的会话不算
    // 空闲(spec #329)。回收掉它就是把别人写好的下一步推到重建之后。
    await new Promise((resolve) => setTimeout(resolve, 500));
    const full = await send(h, cookie, fifth, "c5", "我也要拆");
    assert.equal(full.status, 409);
    assert.match(await full.text(), /名额已满,稍后再发/);
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "followUp", text: "排队的一句" },
    ]);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("子进程被收掉之后排队消息还在库里:读得到、清得掉,清掉就不再投递", async () => {
  const turns: StubTurn[] = [
    // 这一次挂着不回,等着被中止。
    { text: "开始读", usage: { input: 10, output: 2 }, delayMs: 2000 },
    { text: "再说一句的回答", usage: { input: 12, output: 2 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    assert.equal((await send(h, cookie, sessionId, "c2", "排队的一句", "followUp")).status, 202);
    await requestsAtLeast(requests, 1);
    await stop(h, cookie, sessionId);
    await idle(h, cookie, sessionId);

    // 发版排空:镜像落库、登记表清空。重启后的服务就是这个样子。
    await disposeAgentSessions();

    // 没有子进程不等于没有排队消息:它还会被投出去,人因此要看得见。
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "followUp", text: "排队的一句" },
    ]);

    // 清队列清的就是落库那一份。
    const cleared = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/queue`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { queue: [] });
    assert.deepEqual(await queueOf(h, cookie, sessionId), []);

    // 再发一条:清掉的那一条不再跟着投出去。
    assert.equal((await send(h, cookie, sessionId, "c3", "再说一句")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 2);
    assert.ok(!bodyOf(requests[1]!).includes("排队的一句"), "清掉的排队消息又被投出去了");
    assert.ok(bodyOf(requests[1]!).includes("再说一句"));
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("更新基点回收活着的子进程:下一条消息重建,系统提示带新短 sha,那条基点更新进了上下文", async () => {
  const turns: StubTurn[] = [
    { text: "第一轮", usage: { input: 10, output: 2 } },
    { text: "按新代码说", usage: { input: 12, output: 3 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await messagesAtLeast(h.db.path, sessionId, 2);
    await idle(h, cookie, sessionId);
    const before = await records(h, cookie, sessionId);
    const moved = h.repo.commitToBranch("main", { "src/answer.ts": "export const answer = 3;\n" });

    // 子进程此刻空闲地活着;更新基点把它收掉。
    const updated = await fetch(
      `${h.serverUrl}/api/agent-sessions/${sessionId}/baselines/acme/widgets/update`,
      { method: "POST", headers: { cookie } },
    );
    const text = await updated.text();
    assert.equal(updated.status, 200, text);
    assert.equal((JSON.parse(text) as { to: string }).to, moved);
    const after = await records(h, cookie, sessionId);
    assert.equal(after.length, before.length + 1);
    assert.equal(after.at(-1)!.type, "custom_message");

    assert.equal((await send(h, cookie, sessionId, "c2", "再补一句")).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);

    // 活着的子进程会沿用旧系统提示;新短 sha 出现在提示里,说明这一次是重建。
    const system = requests[1]!.messages.filter((message) => message.role === "system");
    assert.match(system[0]!.content, new RegExp(`^- acme/widgets ${moved.slice(0, 7)}$`, "m"));
    assert.match(bodyOf(requests[1]!), new RegExp(`${h.repo.baseSha.slice(0, 7)}.*${moved.slice(0, 7)}`));
    // 历史照样续上。
    assert.match(bodyOf(requests[1]!), /第一轮/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 会话子代理的真实 SDK 回归(issue #358),先例是 `reviewer-evidence-session.test.ts`:
 * `POST /messages → 常驻子进程 → pi-subagents → 子会话 → transcript → 会话记录`,整条走
 * 一遍。钉的是桩测不到的几件事——子代理的工具面恰是只读四件套(派单工具本身不在其中)、
 * 出会话根的路径被拒、它读到的文件内容回到了它自己的模型请求里,以及这一趟的任务、状态、
 * 步数、工具调用与结论作一条记录落进了库,回收重建之后仍在。
 */
const SUBAGENT_TURNS: StubTurn[] = [
  {
    text: "这一段得深读,派个子代理",
    toolCall: {
      name: "subagent",
      args: { agent: "explore", task: "answer.ts 的第 1 行写的是什么" },
    },
    usage: { input: 40, output: 10 },
  },
  // 子会话第一步:一次出根的 grep 与一次正常的读。出根那一次由铺进 agentDir 的只读四件套
  // 扩展拒掉,子会话照常往下走。
  {
    text: "先看看系统目录",
    toolCall: { name: "grep", args: { pattern: "root", path: "/etc" } },
    usage: { input: 12, output: 4 },
  },
  {
    text: "读目标文件",
    toolCall: {
      name: "read",
      args: { path: `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts` },
    },
    usage: { input: 12, output: 4 },
  },
  { text: "answer.ts:1 写着 export const answer = 2;", usage: { input: 18, output: 8 } },
  { text: "子代理带回来了:answer 是 2", usage: { input: 20, output: 6 } },
];

test("会话里派一个子代理:工具面是只读四件套、出根被拒,过程与结论落成会话记录(issue #358)", async () => {
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(SUBAGENT_TURNS);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 5);
    await idle(h, cookie, sessionId);

    // 父会话的工具面有派单工具;子会话的恰是只读四件套——派单工具、git、两种查询与
    // pi-subagents 自己的 contact_supervisor 一个都不在。单层靠工具面构造出来。
    assert.ok(requests[0]!.tools.includes("subagent"));
    assert.deepEqual([...requests[1]!.tools].sort(), ["find", "grep", "ls", "read"]);

    // 子会话第三次请求里那条工具返回就是文件内容:证明 read 真读到了会话根里的工作树。
    const readResult = requests[3]!.messages.findLast((message) => message.role === "tool");
    assert.ok(readResult, "子会话第三次请求没带 read 的返回");
    assert.match(readResult.content, /^1: export const answer = 1;/m);

    // 这一趟落成一条记录:任务、状态、步数、逐次工具调用与结论。出根的那次 grep 带着原因。
    const landed = await records(h, cookie, sessionId);
    const dispatched = landed.filter(
      (one) => (one.entry as { customType?: string }).customType === "multireviewer-session-subagent",
    );
    assert.equal(dispatched.length, 1, "子代理派单没落成条目");
    const { runs } = (dispatched[0]!.entry as unknown as { data: { runs: SubagentRunRecord[] } }).data;
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.ok(run);
    assert.equal(run.task, "answer.ts 的第 1 行写的是什么");
    assert.equal(run.status, "done");
    assert.equal(run.steps, 2);
    assert.deepEqual(run.calls.map((call) => call.name), ["grep", "read"]);
    assert.match(run.calls[0]!.error ?? "", /outside|超出|not in|会话根|repository/i);
    assert.match(run.conclusion, /answer\.ts:1/);

    // 回收之后从记录重建,这一条照样在:transcript 文件随子进程的临时目录没了,卡片靠它。
    await disposeAgentSessions();
    const rebuilt = await records(h, cookie, sessionId);
    assert.deepEqual(
      rebuilt.map((one) => (one.entry as { customType?: string }).customType ?? one.type),
      landed.map((one) => (one.entry as { customType?: string }).customType ?? one.type),
    );
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("spawn 同步失败的子进程再强杀不会连整个进程组一起杀", async () => {
  // cwd 不存在:fork 同步失败,`pid` 为空、句柄里 pid 是 0。直接 `kill("SIGKILL")` 会成 `kill(0)`,
  // 把这个测试进程与 `node --test` 的整组一起杀掉——这条用例失败的样子就是测试进程凭空消失。
  const child = fork(process.execPath, ["-e", "0"], { cwd: join(tmpdir(), "multireviewer-no-such-dir"), stdio: "ignore" });
  const failed = new Promise<Error>((resolve) => child.once("error", resolve));
  assert.equal(child.pid, undefined);
  killChild(child);
  assert.match((await failed).message, /ENOENT/);
});

/* ─────────────── 提问轮次(CONTEXT.md 提问轮次,issue #359) ─────────────── */

/** 一轮题的工具参数。标题两头带空白、第一题掺一个空选项,用来压服务端归一化。 */
const ROUND_ARGS: Json = {
  questions: [
    {
      title: "  汇率取哪一天的  ",
      body: "两处代码都取提交当天,财务那边的口径我读不出来",
      options: [
        { text: " 提交当天 ", recommended: true },
        { text: "月末统一", recommended: false },
        { text: "   ", recommended: false },
      ],
      multiple: false,
    },
    {
      title: "撤回之后谁收到通知",
      body: "现在只有审批人一条路",
      options: [
        { text: "审批人", recommended: true },
        { text: "抄送人", recommended: false },
      ],
      multiple: true,
    },
  ],
};

/** 面板把整轮答案合成的那一条用户消息(`web/src/lib/session-question-round.ts` 的格式)。 */
const ROUND_ANSWER = [
  "提问轮次的回答:",
  "",
  "1. 汇率取哪一天的",
  "- 月末统一",
  "",
  "2. 撤回之后谁收到通知",
  "- 审批人",
  "- 抄送人",
].join("\n");

/** 等到这个会话落了这么多条提问轮次条目。等的是库里的行,不猜子进程的时序。 */
async function roundsAtLeast(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  count: number,
): Promise<Record[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = (await records(h, cookie, sessionId)).filter(
      (row) =>
        row.type === "custom" &&
        (row.entry as { customType?: unknown }).customType ===
          AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
    );
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还没落到 ${count} 条提问轮次`);
}

test("提问轮次:一轮题落成新种类条目、回合就地收尾转空闲,整轮答案回来是一条用户消息", async () => {
  const turns: StubTurn[] = [
    {
      toolCall: { name: ASK_QUESTION_ROUND_TOOL, args: ROUND_ARGS },
      usage: { input: 90, output: 18 },
    },
    { text: "按月末统一算,通知审批人与抄送人", usage: { input: 60, output: 12 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    const rounds = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);

    // 工具面里有它(需求拆分这个用途);产品梳理那一条用例验的是另一个用途。
    assert.ok(
      requests[0]!.tools.includes(ASK_QUESTION_ROUND_TOOL),
      `工具面里没有提问轮次:${requests[0]!.tools.join(",")}`,
    );
    // 落的是新种类条目,内容归一化过:标题两头空白去掉,空文字的选项丢掉。
    assert.equal(rounds.length, 1);
    assert.deepEqual((rounds[0]!.entry as { data?: unknown }).data, {
      questions: [
        {
          title: "汇率取哪一天的",
          body: "两处代码都取提交当天,财务那边的口径我读不出来",
          options: [
            { text: "提交当天", recommended: true },
            { text: "月末统一", recommended: false },
          ],
          multiple: false,
        },
        {
          title: "撤回之后谁收到通知",
          body: "现在只有审批人一条路",
          options: [
            { text: "审批人", recommended: true },
            { text: "抄送人", recommended: false },
          ],
          multiple: true,
        },
      ],
    });
    // 回合就地收尾:题抛出去之后没有第二次模型请求,会话已经空闲等人答题。
    assert.equal(requests.length, 1);
    // 这一下中止不是人点的停止,记录里因此没有那条系统消息。
    const rows = await records(h, cookie, sessionId);
    assert.equal(
      rows.filter(
        (row) => (row.entry as { customType?: unknown }).customType === SYSTEM_MESSAGE_ENTRY,
      ).length,
      0,
    );
    // 条目接在这次工具调用后面:主进程直接落库会让它成旁支,重建时被算成「不在上下文」。
    const store = openStore(h.db.path);
    try {
      assert.equal(agentSessionContextGap(store.agentSessionEntryLinks(sessionId)), 0);
    } finally {
      store.close();
    }

    // 整轮答案作一条用户消息回来,会话接着跑。
    assert.equal((await send(h, cookie, sessionId, "c2", ROUND_ANSWER)).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);
    const answers = requests[1]!.messages.filter(
      (message) => message.role === "user" && message.content.includes("提问轮次的回答"),
    );
    assert.equal(answers.length, 1);
    assert.match(answers[0]!.content, /1\. 汇率取哪一天的\n- 月末统一/);
    assert.match(answers[0]!.content, /2\. 撤回之后谁收到通知\n- 审批人\n- 抄送人/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("不合规的一轮走正常返回打回:不落条目,回合照旧跑下去", async () => {
  /** 把一轮好题改坏:改哪一处由 `patch` 决定。 */
  const broken = (patch: (questions: Json[]) => void): Json => {
    const args = JSON.parse(JSON.stringify(ROUND_ARGS)) as Json;
    patch(args["questions"] as Json[]);
    return args;
  };
  const turns: StubTurn[] = [
    {
      // 一题都没有。
      toolCall: { name: ASK_QUESTION_ROUND_TOOL, args: { questions: [] } },
      usage: { input: 10, output: 2 },
    },
    {
      // 只剩一个选项。
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: broken((questions) => {
          questions[0]!["options"] = [{ text: "提交当天", recommended: true }];
        }),
      },
      usage: { input: 10, output: 2 },
    },
    {
      // 没有推荐项。
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: broken((questions) => {
          questions[1]!["options"] = [
            { text: "审批人", recommended: false },
            { text: "抄送人", recommended: false },
          ];
        }),
      },
      usage: { input: 10, output: 2 },
    },
    { text: "三次都被打回了,我重排一轮再问", usage: { input: 10, output: 2 } },
  ];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 一个回合 = 用户消息 + 3 ×(助手消息 + 工具结果)+ 收尾的助手消息。
    await messagesAtLeast(h.db.path, sessionId, 8);
    await idle(h, cookie, sessionId);

    const rows = await records(h, cookie, sessionId);
    // 一条提问轮次都没落:打回的那几次不是一轮题,回合也没有被就地收尾。
    assert.equal(
      rows.filter(
        (row) =>
          (row.entry as { customType?: unknown }).customType ===
          AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
      ).length,
      0,
    );
    const results = rows
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.equal(results.length, 3);
    assert.match(results[0]!, /this round has no questions/);
    assert.match(results[1]!, /question 1 has 1 options/);
    assert.match(results[2]!, /question 2 has 0 recommended options/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});
