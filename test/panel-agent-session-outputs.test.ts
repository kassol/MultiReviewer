/**
 * 会话产出、定稿与换版的面板接口(issue #337)。
 *
 * 缝与 #333 那一票相同:面板 API 走真实 HTTP,会话、记录与产出落临时 SQLite。压的是票的
 * 验收里打在 HTTP 上的那几条:各版本带 payload 读得到、再交即新版本旧版保留、定稿、换版、
 * 换版记录、定稿版不可改,以及定稿与换版以 `custom_message` 进记录表(它进模型上下文)。
 * 产出工具那一侧(打回三情形与 IPC 落库)在 `agent-session-subprocess.test.ts`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore, type AgentSessionOutputRecord } from "../src/review/store.ts";
import {
  GITEA_REPO,
  scopedUser,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "agent-session-output-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";

type Finalization = {
  kind: string;
  seq: number;
  fromVersion: number | null;
  toVersion: number;
  finalizedBy: string;
  finalizedAt: string;
};

type Outputs = { outputs: AgentSessionOutputRecord[]; finalizations: Finalization[] };

type Record = { seq: number; type: string; entry: Record2 };
type Record2 = { type: string; id: string; parentId: string | null; content?: unknown };

function as(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, { method, headers: { cookie } });
}

async function productWithRepo(h: PanelHarness, name: string): Promise<number> {
  const created = await h.api("POST", "/products", { name });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  return product.id;
}

async function createSession(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<number> {
  const response = await fetch(`${h.serverUrl}/api/products/${productId}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: PURPOSE }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: { id: number } }).session.id;
}

/** 一份拆分的 payload。版本之间只差概要那一句,好认出读到的是哪一版。 */
function breakdown(summary: string): unknown {
  return {
    summary,
    assumptions: ["汇率由财务手工维护"],
    openQuestions: ["移动端这期做到哪一步"],
    items: [
      {
        title: "月结汇率表",
        description: "新增月结汇率表,按年月与币种唯一",
        repo: `${GITEA_REPO.owner}/${GITEA_REPO.repo}`,
        locations: ["src/finance/"],
        dependsOn: [],
        acceptance: ["同一年月同一币种只存一条"],
      },
    ],
  };
}

/** 直接往产出表里落一版。这几条用例要的是接口与定稿语义,不是子进程。 */
function seedOutput(dbPath: string, sessionId: number, summary: string): number {
  const store = openStore(dbPath);
  try {
    return store.appendAgentSessionOutput(sessionId, {
      kind: "requirement-breakdown",
      payload: breakdown(summary),
      toolCallId: `call-${summary}`,
      createdAt: AT,
    }).version;
  } finally {
    store.close();
  }
}

async function outputs(h: PanelHarness, cookie: string, sessionId: number): Promise<Outputs> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${sessionId}/outputs`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Outputs;
}

async function records(h: PanelHarness, cookie: string, sessionId: number): Promise<Record[]> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${sessionId}/records`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { records: Record[] }).records;
}

function finalize(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  version: number,
): Promise<Response> {
  return as(h, cookie, "POST", `/agent-sessions/${sessionId}/outputs/${version}/finalize`);
}

test("再交即新版本:旧版保留,各版本带 payload 读得到", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);

  // 一版都还没交:两份列表都是空的,不是 404。
  assert.deepEqual(await outputs(h, cookie, sessionId), { outputs: [], finalizations: [] });

  assert.equal(seedOutput(h.db.path, sessionId, "第一版"), 1);
  assert.equal(seedOutput(h.db.path, sessionId, "第二版"), 2);

  const read = await outputs(h, cookie, sessionId);
  assert.deepEqual(
    read.outputs.map((output) => [output.kind, output.version, output.toolCallId]),
    [
      ["requirement-breakdown", 1, "call-第一版"],
      ["requirement-breakdown", 2, "call-第二版"],
    ],
  );
  // payload 原样回来:总述三段与条目六字段一个不少。
  assert.deepEqual(read.outputs[0]!.payload, breakdown("第一版"));
  assert.deepEqual(read.outputs[1]!.payload, breakdown("第二版"));

  // 系统管理员读得到别人的会话产出;同事与「没有这个会话」同形。
  assert.equal((await h.api("GET", `/agent-sessions/${sessionId}/outputs`)).status, 200);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const denied = await as(h, other, "GET", `/agent-sessions/${sessionId}/outputs`);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "没有这个 Agent 会话" });
});

test("定稿、换版与换版记录:两次都以 custom_message 进记录表", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => Date.parse(AT) });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  seedOutput(h.db.path, sessionId, "第一版");
  seedOutput(h.db.path, sessionId, "第二版");

  // 首次定稿:来源版本为空。
  const first = await finalize(h, cookie, sessionId, 1);
  const firstText = await first.text();
  assert.equal(first.status, 200, firstText);
  assert.deepEqual(JSON.parse(firstText), {
    finalization: {
      kind: "requirement-breakdown",
      seq: 1,
      fromVersion: null,
      toVersion: 1,
      finalizedBy: "member",
      finalizedAt: AT,
    },
  });

  // 同一版再定稿是空操作:不多一条换版记录,也不多一条进上下文的消息。
  assert.equal((await finalize(h, cookie, sessionId, 1)).status, 200);
  assert.equal((await outputs(h, cookie, sessionId)).finalizations.length, 1);
  assert.equal((await records(h, cookie, sessionId)).length, 1);

  // 换版:同一个端点换到另一版,记一条带来源版本的换版记录。
  assert.equal((await finalize(h, cookie, sessionId, 2)).status, 200);
  const after = await outputs(h, cookie, sessionId);
  assert.deepEqual(
    after.finalizations.map((row) => [row.seq, row.fromVersion, row.toVersion, row.finalizedBy]),
    [
      [1, null, 1, "member"],
      [2, 1, 2, "member"],
    ],
  );
  // 当前定稿版本就是最后一条的 toVersion。
  assert.equal(after.finalizations.at(-1)!.toVersion, 2);

  // 两次动作各落一条 custom_message(它进模型上下文,ADR 0031),文案说明定了哪一版。
  const landed = await records(h, cookie, sessionId);
  assert.deepEqual(
    landed.map((record) => record.type),
    ["custom_message", "custom_message"],
  );
  assert.match(String(landed[0]!.entry.content), /需求拆分 v1 已定稿/);
  assert.match(String(landed[1]!.entry.content), /需求拆分的定稿从 v1 换到 v2/);
  // 第二条的 parentId 接在第一条上:重建时 Pi 顺着这条链上行,断了就丢掉断点之前的历史。
  assert.equal(landed[0]!.entry.parentId, null);
  assert.equal(landed[1]!.entry.parentId, landed[0]!.entry.id);
});

test("定稿版不可改:之后再交一版不动定稿标记,定稿那一版的 payload 一字不变", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => Date.parse(AT) });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  seedOutput(h.db.path, sessionId, "第一版");
  assert.equal((await finalize(h, cookie, sessionId, 1)).status, 200);

  // agent 又交了一版:定稿仍是 v1,新的一版只是多出来的一版。
  assert.equal(seedOutput(h.db.path, sessionId, "第二版"), 2);
  const read = await outputs(h, cookie, sessionId);
  assert.equal(read.finalizations.at(-1)!.toVersion, 1);
  assert.equal(read.outputs.length, 2);
  assert.deepEqual(read.outputs[0]!.payload, breakdown("第一版"));
});

test("定稿的门禁:没有这一版 404,非创建者动不了", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => Date.parse(AT) });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  seedOutput(h.db.path, sessionId, "第一版");

  const missing = await finalize(h, cookie, sessionId, 7);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "没有这一版会话产出" });

  // 系统管理员读得到这个会话,定稿是续谈那一侧的动作,只有创建者做得了。
  const admin = await h.api("POST", `/agent-sessions/${sessionId}/outputs/1/finalize`);
  assert.equal(admin.status, 403);
  assert.deepEqual(await admin.json(), { error: "只有会话的创建者能做" });

  // 同事与「没有这个会话」同形。
  const denied = await finalize(h, other, sessionId, 1);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "没有这个 Agent 会话" });

  // 一次都没定稿成功:记录表与换版记录都是空的。
  assert.deepEqual((await outputs(h, cookie, sessionId)).finalizations, []);
  assert.deepEqual(await records(h, cookie, sessionId), []);
});
