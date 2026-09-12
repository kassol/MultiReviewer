/**
 * Agent 会话实体与它的面板接口(issue #332)。
 *
 * 缝与产品那一票相同:面板 API 走真实 HTTP,会话行落临时 SQLite。压的是票的验收:
 * `agent:chat` 独立一格、用途必填且只收需求拆分、没有这一格建 / 删被挡、非创建者读 404、
 * 系统管理员读得到全部但发消息被拒,以及删会话与删产品级联的条数。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { effectivePanelPermissions, PANEL_PERMISSIONS } from "../src/panel/permissions.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "agent-session-test-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";

type AgentSession = {
  id: number;
  productId: number;
  createdBy: string;
  purpose: string;
  status: string;
  createdAt: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
};

/** 以指定 cookie 发一次请求。`h.api()` 只带系统管理员那一份。 */
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

/** 建一个产品并把 harness 那个仓库归进去,回产品 id。会话都挂在它下面。 */
async function productWithRepo(h: PanelHarness, name: string): Promise<number> {
  const created = await h.api("POST", "/products", { name });
  const text = await created.text();
  assert.equal(created.status, 201, text);
  const { product } = JSON.parse(text) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  return product.id;
}

async function createSession(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<AgentSession> {
  const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
    purpose: PURPOSE,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: AgentSession }).session;
}

async function sessions(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<AgentSession[]> {
  const response = await as(h, cookie, "GET", `/products/${productId}/sessions`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { sessions: AgentSession[] }).sessions;
}

test("agent:chat 独立一格:不蕴含别的格,也不被任何格蕴含", () => {
  assert.ok(PANEL_PERMISSIONS.includes("agent:chat"));
  // 只勾这一格即只有这一格:它不带出任何读权限。
  assert.deepEqual(effectivePanelPermissions(["agent:chat"]), ["agent:chat"]);
  // 勾齐其余全部格也勾不出它:没有哪一格蕴含它。
  const others = PANEL_PERMISSIONS.filter((permission) => permission !== "agent:chat");
  assert.ok(!effectivePanelPermissions(others).includes("agent:chat"));
});

test("建会话要用途,且只收需求拆分", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);

  for (const body of [{}, { purpose: "" }, { purpose: "代码修复" }, { purpose: 42 }]) {
    const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: "会话用途必填,当前只有需求拆分",
    });
  }

  const session = await createSession(h, cookie, productId);
  assert.equal(session.productId, productId);
  assert.equal(session.createdBy, "member");
  assert.equal(session.purpose, PURPOSE);
  assert.equal(session.status, "idle");
  assert.equal(typeof session.createdAt, "string");
  assert.deepEqual(session.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  });

  // 读回来与建出来的那一份同形。
  const read = await as(h, cookie, "GET", `/agent-sessions/${session.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { session });
  assert.deepEqual(await sessions(h, cookie, productId), [session]);
});

test("没有 agent:chat 的人建会话与删会话都被挡,读不受影响", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const session = await createSession(h, owner, productId);
  // 有仓库分配、没有任何权限格的账号。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);

  for (const [method, path, body] of [
    ["POST", `/products/${productId}/sessions`, { purpose: PURPOSE }],
    ["DELETE", `/agent-sessions/${session.id}`, undefined],
    ["POST", `/agent-sessions/${session.id}/messages`, {}],
  ] as const) {
    const response = await as(h, reader, method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "没有这一格权限" });
  }

  // 这一格不管读:它只是别人的会话,所以落在 404 那一档上,而不是 403。
  assert.equal((await as(h, reader, "GET", `/agent-sessions/${session.id}`)).status, 404);
  assert.deepEqual(await sessions(h, reader, productId), []);
});

test("看不到产品的人建不了会话,也问不到它下面有没有会话", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const alpha = seedRepo(h, 101, "acme", "alpha");
  // 有 agent:chat,但分配的是另一个仓库:这个产品对他不存在。
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [alpha], ["agent:chat"]);

  for (const [method, body] of [
    ["GET", undefined],
    ["POST", { purpose: PURPOSE }],
  ] as const) {
    const response = await as(h, outsider, method, `/products/${productId}/sessions`, body);
    assert.equal(response.status, 404, method);
    assert.deepEqual(await response.json(), { error: "没有这个产品" });
  }
});

test("会话只创建者读得到,系统管理员读得到所有人的但发消息被拒", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const session = await createSession(h, owner, productId);
  const otherSession = await createSession(h, other, productId);

  // 同事:会话不存在与不是我的同形 404,发消息与删除同样问不到。
  for (const [method, path] of [
    ["GET", `/agent-sessions/${session.id}`],
    ["DELETE", `/agent-sessions/${session.id}`],
    ["POST", `/agent-sessions/${session.id}/messages`],
  ] as const) {
    const response = await as(h, other, method, path, method === "GET" ? undefined : {});
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "没有这个 Agent 会话" });
  }
  // 「我的会话」就是我的:两个人各看到自己那一条。
  assert.deepEqual(
    (await sessions(h, other, productId)).map((row) => row.id),
    [otherSession.id],
  );

  // 系统管理员:读得到两个人的会话,写一律被拒。
  assert.deepEqual(
    (await sessions(h, h.cookie, productId)).map((row) => row.id),
    [otherSession.id, session.id],
  );
  assert.equal((await h.api("GET", `/agent-sessions/${session.id}`)).status, 200);
  for (const [method, path] of [
    ["POST", `/agent-sessions/${session.id}/messages`],
    ["DELETE", `/agent-sessions/${session.id}`],
  ] as const) {
    const response = await h.api(method, path, {});
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "只有会话的创建者能做" });
  }

  // 创建者发消息过了门禁;真实投递还没接通(issue #333)。
  const message = await as(h, owner, "POST", `/agent-sessions/${session.id}/messages`, {});
  assert.equal(message.status, 501);
  assert.deepEqual(await message.json(), { error: "发消息还没接通" });
});

test("删会话只删那一条,删产品级联删掉它下面的全部会话并回条数", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const first = await createSession(h, owner, productId);
  const second = await createSession(h, owner, productId);
  const third = await createSession(h, owner, productId);

  assert.equal((await as(h, owner, "DELETE", `/agent-sessions/${first.id}`)).status, 204);
  const gone = await as(h, owner, "GET", `/agent-sessions/${first.id}`);
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { error: "没有这个 Agent 会话" });
  assert.equal((await as(h, owner, "DELETE", `/agent-sessions/${first.id}`)).status, 404);
  assert.deepEqual(
    (await sessions(h, owner, productId)).map((row) => row.id),
    [third.id, second.id],
  );

  const removed = await h.api("DELETE", `/products/${productId}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { cascade: { sessions: 2 } });
  // 会话跟着产品走:剩下那两条连读都读不到了。
  for (const id of [second.id, third.id]) {
    assert.equal((await as(h, owner, "GET", `/agent-sessions/${id}`)).status, 404);
  }
});
