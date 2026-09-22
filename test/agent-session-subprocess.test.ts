/**
 * Agent 会话的真实链路(issue #333):`POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 →
 * 会话记录 → SSE`,整条走一遍。模型由本机的假服务(`support/model-stub.ts`)按脚本扮演,
 * 全程不碰收费模型。先例是 `reviewer-evidence-session.test.ts`;公用 harness 在
 * `support/agent-session.ts`,用途与生命周期那几组在同名的另三个文件里(issue #399)。
 *
 * 钉的是桩测不到的几件事:知识目录真的进了模型请求、消息文本进了同一次请求、回复与工具
 * 调用作为 Pi 条目落进记录表并经 SSE 送达、用量按条目累加到会话上,以及子进程跑完一个回合
 * 之后**留着**——第二条消息不必再建一次会话。图片附件(issue #336)同律:base64 进了哪一次
 * 请求、记录里剩下的是不是文件引用。
 *
 * 排队、插话、清空、停止与流式帧(issue #334)也只从外部看:排队的那一条在哪一次模型请求里
 * 出现、插话出现在工具结果之后还是之前、清空之后一共发了几次请求、停止之后记录表里落了哪
 * 两条、流式帧带不带 `id`。子进程内部一概不看。
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store/index.ts";
import { MISSING_IMAGE_TEXT } from "../src/reviewer/session-images.ts";
import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import { GITEA_REPO, type PanelHarness } from "./support/panel-harness.ts";
import { pngBytes, pngSize } from "./support/png.ts";
import { frameReader } from "./support/sse.ts";
import { type StubTurn } from "./support/model-stub.ts";
import {
  bodyOf,
  FACT,
  idle,
  MESSAGE,
  messageRoles,
  messagesAtLeast,
  NEVER,
  queueOf,
  records,
  requestsAtLeast,
  RULE,
  send,
  startSessionHarness,
} from "./support/agent-session.ts";

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
    await messagesAtLeast(h.db.url, sessionId, 4);
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

    // 记录:会话起头的两条(这一次用哪个模型、哪个思考档位)原样落下来,随后是系统提示那一条
    // (Pi 0.86 起把提示按段记进会话,提示改了才再记一条;面板的对话流只认用户、助手与工具
    // 结果三种角色,它照常不显示)、用户消息、带工具调用的助手消息、工具结果与收尾的助手
    // 消息,各自是原样的 Pi 条目。
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
        "message",
      ],
    );
    assert.deepEqual(messageRoles(landed), [
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    assert.deepEqual(
      landed.map((record) => record.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
    // 工具调用在助手条目里,读到的是会话根下那个仓库的文件。
    const toolCall = JSON.stringify(landed[4]!.entry);
    assert.match(toolCall, /"toolCall"/);
    assert.match(toolCall, /acme\/widgets\/src\/answer\.ts/);
    assert.match(JSON.stringify(landed[5]!.entry), /export const answer/);

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

    // SSE:这一轮的七条记录都到了,帧 id 就是 seq。不带 id 的是流式帧(issue #334),
    // 它与落库条目共用这个频道,数记录时跳过。
    const ids: string[] = [];
    while (ids.length < 7) {
      const frame = await reader.next();
      if (frame.id !== undefined) ids.push(frame.id);
    }
    assert.deepEqual(ids, ["1", "2", "3", "4", "5", "6", "7"]);
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
    await messagesAtLeast(h.db.url, sessionId, 2);
    await idle(h, cookie, sessionId);

    assert.equal((await send(h, cookie, sessionId, "c2", "再补一句")).status, 202);
    await messagesAtLeast(h.db.url, sessionId, 4);
    await idle(h, cookie, sessionId);

    // 第二次请求带着第一轮的上下文:同一个 Pi 会话,历史没丢。
    assert.equal(requests.length, 2);
    const second = requests[1]!.messages.map((message) => message.content).join("\n");
    assert.match(second, new RegExp(MESSAGE));
    assert.match(second, /第一轮/);
    assert.match(second, /再补一句/);

    // 系统提示那一条只在头一回合记下(Pi 0.86 起),第二回合的提示没变,不再记第二条。
    assert.deepEqual(messageRoles(await records(h, cookie, sessionId)), [
      "system",
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
    await messagesAtLeast(h.db.url, sessionId, 2);
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
    await messagesAtLeast(h.db.url, sessionId, 2);
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
    // 排空落在子进程还在准备的时候(备工作树加建 Pi 会话近一秒,排队与排空都在那之前),
    // 这一条脚本响应因此是重建之后那个子进程的第一次请求收到的:它不能挂着不回,不然
    // 留存的那条与新发的这条只跑得出一个回合。
    { text: "第一轮", usage: { input: 10, output: 2 } },
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
    await messagesAtLeast(h.db.url, sessionId, 2);
    await idle(h, cookie, sessionId);
    await disposeAgentSessions();

    // 人手动删掉那个文件:库里的引用还在,文件没了。
    const store = openStore(h.db.url);
    const image = (await store.getAgentSessionImage(sessionId, imageId))!;
    await store.close();
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

test("执行中发「排队」:这一轮跑完之后才投递", async () => {
  const path = `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts`;
  // 排队的那一条投进去之前这一轮不回:窗口由测试放行,不靠延迟跑赢机器负载(issue #397)。
  let go = (): void => {};
  const queuedIn = new Promise<void>((resolve) => {
    go = resolve;
  });
  const turns: StubTurn[] = [
    {
      text: "先读一下",
      toolCall: { name: "read", args: { path } },
      usage: { input: 10, output: 2 },
      release: queuedIn,
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
    go();

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
  // 插话要在这一次回应到达之前投进去。响应由测试放行,不靠延迟跑赢机器负载(issue #397):
  // 一两秒的窗口在并行跑整套测试时会让插话落到工具批次之后,那时它等的是再下一个回合边界。
  let go = (): void => {};
  const steered = new Promise<void>((resolve) => {
    go = resolve;
  });
  const turns: StubTurn[] = [
    {
      text: "两个文件都读一下",
      toolCalls: [
        { name: "read", args: { path: `${prefix}/src/answer.ts` } },
        { name: "read", args: { path: `${prefix}/src/other.ts` } },
      ],
      usage: { input: 10, output: 2 },
      release: steered,
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
    go();

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
      release: NEVER,
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

