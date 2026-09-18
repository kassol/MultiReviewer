/**
 * Agent 会话子进程的判死、换模型与惰性重建(issue #335、#356):同样只看外部事实——判死与
 * 模型切换在记录表里留了哪条系统消息、记录缺一条时重建按截断续得下去、压缩条目落没落库、
 * 删会话与更新基点有没有把子进程收掉、起不来那一次留下什么。静默闸的时钟由用例注入
 * (issue #399),不真等满门槛。空闲回收与名额那一组在 `agent-session-reclaim.test.ts`。
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import {
  agentSessionStatus,
  disposeAgentSessions,
  killChild,
} from "../src/webhook/agent-session.ts";
import { HARNESS_SPEC } from "./support/panel-harness.ts";
import { putGlobalSettings } from "./support/store-seed.ts";
import { type StubTurn } from "./support/model-stub.ts";
import {
  bodyOf,
  droppedFromContext,
  idle,
  MESSAGE,
  messagesAtLeast,
  NEVER,
  POLL_ATTEMPTS,
  POLL_MS,
  records,
  requestsAtLeast,
  send,
  startSessionHarness,
  systemMessageMatching,
} from "./support/agent-session.ts";

test("执行中连续静默即判死:记一条系统消息,下次发消息重建续上", async () => {
  const turns: StubTurn[] = [
    // 这一次挂着不回:静默闸合上。
    { text: "这一次不回", usage: { input: 10, output: 2 }, release: NEVER },
    { text: "重建之后的回答", usage: { input: 11, output: 2 } },
  ];
  // 闸的时钟由这一条用例按(issue #399)。子进程每回一条 IPC 都重排闸,拿到的这一份因此
  // 始终是此刻排着的那一个:备工作树、建 Pi 会话那一段里的重排一次都不漏。按真实时间验
  // 要取一个明显宽于子进程准备时间的门槛(线上是 5 分钟),而判据只是「闸响了会怎样」。
  let fire: (() => void) | undefined;
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    silenceTimer: (onSilence) => {
      fire = onSilence;
      return () => {
        if (fire === onSilence) fire = undefined;
      };
    },
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 模型请求已经发出去,而这一次响应永远不来:此刻起子进程一条回传都没有。
    await requestsAtLeast(requests, 1);
    assert.ok(fire !== undefined, "执行中没排上静默闸");
    fire();

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
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const landed = await records(h, cookie, sessionId);
      const system = landed.filter((record) => record.type === "custom");
      if (system.length > 0) {
        assert.match(JSON.stringify(system[0]!.entry), /会话子进程启动失败:仓库取不回来/);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    assert.fail("等了 30 秒,记录里还没有那条系统消息");
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

