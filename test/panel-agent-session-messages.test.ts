/**
 * 发消息、会话记录与记录流的面板接口(issue #333)。
 *
 * 缝与 #332 那一票相同:面板 API 走真实 HTTP,会话与记录落临时 SQLite。压的是票的验收里
 * 打在 HTTP 上的那几条:同一个客户端消息 id 重发回原受理结果不重入队、执行中的新消息回
 * 409、会话根里一个仓库都没有时开不起来、记录与记录流的可见性、用量按记录累加并在统计页
 * 单列一行。真子进程那条链路在 `agent-session-subprocess.test.ts`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import { agentSessionRepos } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { frameReader } from "./support/sse.ts";

const PASSWORD = "agent-session-message-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";

type AgentSession = {
  id: number;
  status: string;
  usage: ReviewerUsage;
};

type Record = { sessionId: number; seq: number; type: string; at: string; entry: unknown; usage: ReviewerUsage };

function as(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function productWithRepos(
  h: PanelHarness,
  name: string,
  repoIds: readonly number[],
): Promise<number> {
  const created = await h.api("POST", "/products", { name });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  for (const repoId of repoIds) {
    assert.equal((await h.api("PUT", `/products/${product.id}/repos/${repoId}`)).status, 204);
  }
  return product.id;
}

async function createSession(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<number> {
  const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
    purpose: PURPOSE,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: { id: number } }).session.id;
}

async function session(h: PanelHarness, cookie: string, id: number): Promise<AgentSession> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${id}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { session: AgentSession }).session;
}

/** 直接往记录表里落一条(ADR 0031)。这几条用例要的是用量累加,不是子进程。 */
function seedEntry(dbPath: string, sessionId: number, usage: Partial<ReviewerUsage>): void {
  const store = openStore(dbPath);
  try {
    const full: ReviewerUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      totalTokens:
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0),
    };
    store.appendAgentSessionEntry(sessionId, {
      type: "message",
      at: AT,
      entry: { type: "message", id: `seeded-${full.totalTokens}`, timestamp: AT },
      usage: full,
    });
  } finally {
    store.close();
  }
}

test("会话根只挂创建者有分配的仓库:产品里别的仓库不出现", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const other = seedRepo(h, 101, "acme", "alpha");
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id, other]);
  // 创建者只分配到两个仓库里的一个。
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const mine = await createSession(h, cookie, productId);
  // 系统管理员不受分配限制:产品的全部仓库都在他的会话根里。
  const admin = await createSession(h, h.cookie, productId);

  const store = openStore(h.db.path);
  try {
    const names = (sessionId: number): string[] =>
      agentSessionRepos(h.db.path, store.getAgentSession(sessionId)!).map(
        (repo) => `${repo.owner}/${repo.repo}`,
      );
    assert.deepEqual(names(mine), ["acme/widgets"]);
    assert.deepEqual(names(admin), ["acme/alpha", "acme/widgets"]);
  } finally {
    store.close();
  }
});

test("发消息要带客户端消息 id 与非空正文", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);

  for (const body of [
    {},
    { text: "拆一下这个需求" },
    { clientMessageId: "c1" },
    { clientMessageId: " ", text: "拆一下这个需求" },
    { clientMessageId: "c1", text: "   " },
    { clientMessageId: 42, text: "拆一下这个需求" },
  ]) {
    const response = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: "发消息要带 clientMessageId 与非空的 text",
    });
  }
});

test("会话根里一个仓库都没有时开不起来", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const other = seedRepo(h, 101, "acme", "alpha");
  // 产品下两个仓库,创建者只分配到另一个:交集为空。
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id, other], [
    "agent:chat",
  ]);
  const sessionId = await createSession(h, cookie, productId);
  assert.equal((await h.api("DELETE", `/products/${productId}/repos/${GITEA_REPO.id}`)).status, 204);

  const response = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
    clientMessageId: "c1",
    text: "拆一下这个需求",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "这个产品下没有你有仓库分配的仓库" });
});

test("同一个客户端消息 id 重发回原受理结果,另一个 id 在执行中回 409", async () => {
  let nowMs = Date.parse(AT);
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => nowMs });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  const send = (body: unknown): Promise<Response> =>
    as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, body);

  const first = await send({ clientMessageId: "c1", text: "拆一下这个需求" });
  const firstText = await first.text();
  assert.equal(first.status, 202, firstText);
  assert.deepEqual(JSON.parse(firstText), {
    accepted: { clientMessageId: "c1", acceptedAt: AT },
  });
  // 受理即在跑:子进程起来之前就登记,下一条消息看得到它。
  assert.equal((await session(h, cookie, sessionId)).status, "running");

  // 时钟往前走一分钟:重发回的仍是第一次那一刻,没有第二次受理。
  nowMs += 60_000;
  const again = await send({ clientMessageId: "c1", text: "拆一下这个需求" });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), {
    accepted: { clientMessageId: "c1", acceptedAt: AT },
  });

  // 另一个 id:排队与插话还没接入,执行中的新消息先回 409。
  const busy = await send({ clientMessageId: "c2", text: "再补一句" });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: "这个会话正在执行" });
});

test("记录与记录流只有创建者与系统管理员读得到", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);
  seedEntry(h.db.path, sessionId, { inputTokens: 10, outputTokens: 2 });

  // 创建者:记录读得到。
  const mine = await as(h, owner, "GET", `/agent-sessions/${sessionId}/records`);
  assert.equal(mine.status, 200);
  const { records } = (await mine.json()) as { records: Record[] };
  assert.equal(records.length, 1);
  assert.equal(records[0]!.seq, 1);
  assert.equal(records[0]!.type, "message");
  assert.deepEqual(records[0]!.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 12,
  });
  // 系统管理员读得到别人的会话与它的记录。
  assert.equal((await h.api("GET", `/agent-sessions/${sessionId}/records`)).status, 200);

  // 同事:两个端点都与会话不存在同形。
  for (const path of [`/records`, `/stream`]) {
    const response = await as(h, other, "GET", `/agent-sessions/${sessionId}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "没有这个 Agent 会话" });
  }

  // 创建者读流:落库的那一条按 seq 作帧 id 回放,流保持打开(会话空闲着仍然续得上)。
  const stream = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stream`, {
    headers: { cookie: owner },
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = frameReader(stream);
  const frame = await reader.next();
  assert.equal(frame.event, "trace");
  assert.equal(frame.id, "1");
  assert.equal((JSON.parse(frame.data) as Record).seq, 1);
  await reader.cancel();
});

test("记录流的 ?after=seq 只补它之后的落库条目", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);
  seedEntry(h.db.path, sessionId, { inputTokens: 10 });
  seedEntry(h.db.path, sessionId, { inputTokens: 20 });

  const stream = await fetch(
    `${h.serverUrl}/api/agent-sessions/${sessionId}/stream?after=1`,
    { headers: { cookie: owner } },
  );
  assert.equal(stream.status, 200);
  const reader = frameReader(stream);
  // 第一条不补,第一帧就是第二条。
  const frame = await reader.next();
  assert.equal(frame.id, "2");
  assert.equal((JSON.parse(frame.data) as Record).usage.inputTokens, 20);
  await reader.cancel();
});

test("用量按记录累加到会话上,统计页单列一行", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => Date.parse(AT) });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);

  seedEntry(h.db.path, sessionId, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 });
  seedEntry(h.db.path, sessionId, { inputTokens: 30, outputTokens: 4, cacheWriteTokens: 1 });
  const expected = {
    inputTokens: 130,
    outputTokens: 24,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 160,
  };
  assert.deepEqual((await session(h, owner, sessionId)).usage, expected);

  // 统计页:Agent 会话单列一行,不混进 Review Run 那一格。
  const stats = await as(h, owner, "GET", "/stats");
  assert.equal(stats.status, 200);
  const read = (await stats.json()) as {
    usage: unknown;
    agentSessions: (ReviewerUsage & { sessions: number }) | null;
  };
  assert.equal(read.usage, null);
  assert.deepEqual(read.agentSessions, { sessions: 1, ...expected });

  // 系统管理员看得到全部会话的花费;别人的会话不进这个人自己那一行。
  const adminStats = (await (await h.api("GET", "/stats")).json()) as {
    agentSessions: { sessions: number } | null;
  };
  assert.equal(adminStats.agentSessions?.sessions, 1);
  const otherStats = (await (await as(h, other, "GET", "/stats")).json()) as {
    agentSessions: unknown;
  };
  assert.equal(otherStats.agentSessions, null);
});
