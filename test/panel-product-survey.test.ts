/**
 * 重梳与产品梳理会话的那一段面板接口(CONTEXT.md 产品梳理,issue #345)。
 *
 * 缝照旧:面板 API 走真实 HTTP,产品与会话行落临时 SQLite。压的是票里不需要真子进程的那几条
 * 验收:仓库不足两个的回绝、门禁两档、系统开的会话谁都读得到、发消息对谁都回绝、停止与删除
 * 只有系统管理员做得了(issue #346)、建会话端点不收这个用途。真跑起来那一路(种子消息、
 * 提示里的生效条目、产出工具的打回与合法交出、梳理在跑时的第二次重梳)在
 * `agent-session-subprocess.test.ts`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore, type AgentSessionRecord } from "../src/review/store.ts";
import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "product-survey-test-password";
const AT = "2026-09-13T00:00:00.000Z";
const ALPHA = 101;

type Product = { id: number; name: string; repos: { repoId: number }[] };

/** 建一个产品,按 `repoIds` 归入仓库。`ALPHA` 只落注册表,不建 hook。 */
async function product(h: PanelHarness, repoIds: readonly number[]): Promise<Product> {
  seedRepo(h, ALPHA, "acme", "alpha");
  const created = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(created.status, 201);
  const { product: row } = (await created.json()) as { product: Product };
  for (const repoId of repoIds) {
    assert.equal((await h.api("PUT", `/products/${row.id}/repos/${repoId}`)).status, 204);
  }
  return row;
}

function survey(h: PanelHarness, productId: number, cookie?: string): Promise<Response> {
  return cookie === undefined
    ? h.api("POST", `/products/${productId}/survey`)
    : fetch(`${h.serverUrl}/api/products/${productId}/survey`, {
        method: "POST",
        headers: { cookie },
      });
}

/** 直接落一行产品梳理会话。系统开的那一行不经接口建,这里只要它在库里。 */
function seedSurveySession(h: PanelHarness, productId: number): AgentSessionRecord {
  const store = openStore(h.db.path);
  try {
    return store.createAgentSession({
      productId,
      createdBy: "system",
      purpose: "product-survey",
      createdAt: AT,
    });
  } finally {
    store.close();
  }
}

async function sessionsOf(
  h: PanelHarness,
  productId: number,
  cookie: string,
): Promise<{ id: number; purpose: string; createdBy: string }[]> {
  const response = await fetch(`${h.serverUrl}/api/products/${productId}/sessions`, {
    headers: { cookie },
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { sessions: { id: number; purpose: string; createdBy: string }[] })
    .sessions;
}

test("仓库不足两个的产品重梳不了:回一句中文,一个会话也没建起来", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const one = await product(h, [GITEA_REPO.id]);

  const refused = await survey(h, one.id);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "产品梳理要这个产品有两个以上仓库,先把第二个仓库归入它",
  });
  assert.deepEqual(await sessionsOf(h, one.id, h.cookie), []);
});

test("重梳开一个系统开的产品梳理会话;它还在跑时第二次重梳被回绝", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  try {
    const opened = await survey(h, two.id);
    const text = await opened.text();
    assert.equal(opened.status, 201, text);
    const { session } = JSON.parse(text) as { session: AgentSessionRecord };
    assert.equal(session.purpose, "product-survey");
    // 创建者是系统:这个会话不属于点下重梳的那个人(CONTEXT.md 产品梳理)。
    assert.equal(session.createdBy, "system");
    assert.deepEqual(
      (await sessionsOf(h, two.id, h.cookie)).map((row) => [row.id, row.purpose, row.createdBy]),
      [[session.id, "product-survey", "system"]],
    );

    // 还在跑:第二次重梳回一句中文,不再开第二个会话。
    const again = await survey(h, two.id);
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), {
      error: "这个产品的产品梳理还在跑,等它交出提案再重梳",
    });
    assert.equal((await sessionsOf(h, two.id, h.cookie)).length, 1);
  } finally {
    // 登记表是进程内的一张表,下一个用例会拿同一个会话 id 播种一条。
    await disposeAgentSessions();
  }
});

test("重梳要 knowledge:write 加这个产品里的一个仓库分配", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);

  // 有仓库分配、没有这一格权限:403。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  const refused = await survey(h, two.id, reader);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "没有这一格权限" });

  // 有这一格权限、对这个产品里一个仓库都没分配:与产品不存在同形回 404。
  const stranger = seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["knowledge:write"]);
  const hidden = await survey(h, two.id, outsider);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });
});

test("系统开的产品梳理会话:产品可见者都读得到,发消息与别的动作一律回绝", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  const session = seedSurveySession(h, two.id);
  assert.equal(session.createdBy, "system");
  assert.equal(session.purpose, "product-survey");

  // 看得到产品、自己一个会话都没建的人:这一条在他的会话列表里,也读得开。
  const member = await scopedUser(h, "member", PASSWORD, AT, [ALPHA], ["agent:chat"]);
  assert.deepEqual(await sessionsOf(h, two.id, member), [
    { ...session, purpose: "product-survey", createdBy: "system" },
  ]);
  const read = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}`, {
    headers: { cookie: member },
  });
  assert.equal(read.status, 200);

  // 发消息、停止与删除对普通人都回同一句:创建者是系统,回「只有创建者能做」会让人去找
  // 那个不存在的人。
  const refusal = { error: "产品梳理会话由系统开,谁都续不了它" };
  const sent = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}/messages`, {
    method: "POST",
    headers: { cookie: member, "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId: "c1", text: "再读一遍" }),
  });
  assert.equal(sent.status, 409);
  assert.deepEqual(await sent.json(), refusal);
  const stopped = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}/stop`, {
    method: "POST",
    headers: { cookie: member },
  });
  assert.equal(stopped.status, 409);
  assert.deepEqual(await stopped.json(), refusal);
  const deleted = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}`, {
    method: "DELETE",
    headers: { cookie: member },
  });
  assert.equal(deleted.status, 409);
  assert.deepEqual(await deleted.json(), refusal);

  // 一个仓库都没分到的人看不到这个产品,也就问不到它的会话。
  const stranger = seedRepo(h, 404, "acme", "delta");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["agent:chat"]);
  const hidden = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}`, {
    headers: { cookie: outsider },
  });
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个 Agent 会话" });
});

test("产品梳理会话:系统管理员停得了、删得了它,发消息仍回绝", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  const session = seedSurveySession(h, two.id);

  // 发消息仍是那一句:系统开的会话谁都续不了它,系统管理员也不例外。
  const sent = await h.api("POST", `/agent-sessions/${session.id}/messages`, {
    clientMessageId: "c1",
    text: "再读一遍",
  });
  assert.equal(sent.status, 409);
  assert.deepEqual(await sent.json(), { error: "产品梳理会话由系统开,谁都续不了它" });

  // 停止是空操作(这一行没有在跑的子进程),回 200 而不是 409:动作本身做得了。
  const stopped = await h.api("POST", `/agent-sessions/${session.id}/stop`);
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { stopped: false, queue: [] });

  // 删得掉:交完提案的梳理会话要有人收得掉,否则它永远留在列表里。
  assert.equal((await h.api("DELETE", `/agent-sessions/${session.id}`)).status, 204);
  assert.deepEqual(await sessionsOf(h, two.id, h.cookie), []);
});

test("建会话端点不收产品梳理:那个用途只有系统开得了", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  const member = await scopedUser(h, "member", PASSWORD, AT, [ALPHA], ["agent:chat"]);

  const refused = await fetch(`${h.serverUrl}/api/products/${two.id}/sessions`, {
    method: "POST",
    headers: { cookie: member, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "product-survey" }),
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), {
    error: "会话用途必填,只能是需求拆分或开放对话",
  });
  assert.deepEqual(await sessionsOf(h, two.id, member), []);
});
