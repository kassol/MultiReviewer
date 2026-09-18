/**
 * Agent 会话子进程的空闲回收与常驻名额(issue #335):看的都是外部事实——回收之后那一次
 * 请求里有没有此前的全部消息、名额满时接口回几、排着消息的会话算不算空闲、收掉之后排队
 * 消息还在不在库里。回收的门槛按毫秒注入,不真等十分钟。判死与重建那一组在
 * `agent-session-rebuild.test.ts`,公用 harness 在 `support/agent-session.ts`(issue #399)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import { GITEA_REPO } from "./support/panel-harness.ts";
import { seedReviewRule } from "./support/store-seed.ts";
import { type StubTurn } from "./support/model-stub.ts";
import {
  bodyOf,
  droppedFromContext,
  idle,
  LATER_RULE,
  MESSAGE,
  messageRoles,
  messagesAtLeast,
  NEVER,
  queueOf,
  records,
  requestsAtLeast,
  send,
  startSessionHarness,
  stop,
} from "./support/agent-session.ts";

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
    { text: "开始读", usage: { input: 10, output: 2 }, release: NEVER },
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

