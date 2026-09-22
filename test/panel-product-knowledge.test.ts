/**
 * 产品知识的那一段面板接口(CONTEXT.md 产品知识,ADR 0032 与 0035,issue #360)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,产品与产品知识行落临时 SQLite。
 * 压的是这一票的验收:产品页读到的三种条目连出处附注与决策状态一起回、写与确认那几个端点
 * 已经没有了(条目只由会话写下,ADR 0035)、库层的写与撤回(改写、取代、同名与撤回两遍),
 * 以及升级前的旧库开起来只剩空的新表。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openStore, type ProductKnowledgeKind } from "../src/review/store/index.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "product-knowledge-test-password";
const AT = "2026-09-13T00:00:00.000Z";
const ALPHA = 101;

type KnowledgeEntry = {
  id: number;
  kind: ProductKnowledgeKind;
  name: string;
  body: string;
  topic: string | null;
  avoided: string[];
  options: string | null;
  consequences: string | null;
  supersededBy: number | null;
  annotations: { location: string; reason: string }[];
  writtenAt: string;
};
type Product = {
  id: number;
  name: string;
  repos: { repoId: number; owner: string; repo: string; role: string | null }[];
};

/** 一个带两个仓库的产品:产品梳理要两个以上仓库,这几例的产品照它建。 */
async function productWithTwoRepos(h: PanelHarness): Promise<Product> {
  await seedRepo(h, ALPHA, "acme", "alpha");
  const response = await h.api("POST", "/products", { name: "报销系统" });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const { product } = JSON.parse(text) as { product: Product };
  // 归属行直接落库:走归入端点会自己开一场梳理(issue #347),而这几例压的是条目本身。
  const store = openStore(h.db.path);
  try {
    for (const repoId of [GITEA_REPO.id, ALPHA]) {
      assert.equal(await store.attachProductRepo(product.id, repoId, AT), "attached");
    }
  } finally {
    await store.close();
  }
  return product;
}

async function detail(
  h: PanelHarness,
  productId: number,
  cookie?: string,
): Promise<{ product: Product; knowledge: KnowledgeEntry[] }> {
  const path = `/api/products/${productId}`;
  const response =
    cookie === undefined
      ? await h.api("GET", `/products/${productId}`)
      : await fetch(`${h.serverUrl}${path}`, { headers: { cookie } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as { product: Product; knowledge: KnowledgeEntry[] };
}

/** 落一条产品知识,走会话工具落库的同一条路(`Store.writeProductKnowledge`)。 */
async function write(
  h: PanelHarness,
  productId: number,
  record: {
    kind: ProductKnowledgeKind;
    name?: string;
    body: string;
    topic?: string;
    avoided?: readonly string[];
    options?: string;
    consequences?: string;
    annotations?: readonly { location: string; reason: string }[];
    id?: number;
    supersedes?: number;
  },
): Promise<number | undefined> {
  const store = openStore(h.db.path);
  try {
    return (await store.writeProductKnowledge({
      productId,
      kind: record.kind,
      name: record.name ?? "",
      body: record.body,
      topic: record.topic ?? null,
      avoided: record.avoided ?? [],
      options: record.options ?? null,
      consequences: record.consequences ?? null,
      annotations: record.annotations ?? [],
      at: AT,
      sessionId: null,
      ...(record.id === undefined ? {} : { id: record.id }),
      ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
    }))?.id;
  } finally {
    await store.close();
  }
}

test("产品页读到三种条目:术语带分组与避免词、关系一句、决策带状态,附注都在", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const annotation = { location: "acme/widgets/src/order.ts:42", reason: "状态机在这里" };

  const term = await write(h, product.id, {
    kind: "term",
    name: "订单",
    body: "一次可以付钱的购买请求,付款成功之后才进履约。",
    topic: "交易",
    avoided: ["单子"],
    annotations: [annotation],
  });
  const relationship = await write(h, product.id, {
    kind: "relationship",
    body: "网关向订单服务要状态,订单服务不回调网关。",
  });
  const decision = await write(h, product.id, {
    kind: "decision",
    name: "签名统一用 HMAC",
    body: "两个仓库各签各的,轮换一次要改两处;统一成 HMAC,密钥一处轮换。",
    options: "考虑过非对称签名。",
    consequences: "两侧读同一份密钥。",
  });

  const { knowledge } = await detail(h, product.id);
  assert.deepEqual(
    knowledge.map((row) => [row.id, row.kind, row.name]),
    [
      [term, "term", "订单"],
      [relationship, "relationship", ""],
      [decision, "decision", "签名统一用 HMAC"],
    ],
  );
  const read = knowledge.find((row) => row.id === term)!;
  assert.equal(read.topic, "交易");
  assert.deepEqual(read.avoided, ["单子"]);
  assert.deepEqual(read.annotations, [annotation]);
  assert.equal(read.writtenAt, AT);
  // 决策的状态:没有被取代即生效。
  assert.equal(knowledge.find((row) => row.id === decision)!.supersededBy, null);

  // 产品列表那一份一格没多:知识只在详情里。
  const listed = await h.api("GET", "/products");
  assert.deepEqual(Object.keys(((await listed.json()) as { products: unknown[] }).products[0]!), [
    "id",
    "name",
    "createdAt",
    "repos",
  ]);
});

test("库层的写与撤回:改写落在同一条上、取代记在旧那条上、同名写两条报错、撤回两遍不算成功", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const term = (await write(h, product.id, { kind: "term", name: "订单", body: "一次购买请求。" }))!;

  // 改写:id 不变,正文换一版。
  assert.equal(await write(h, product.id, { kind: "term", id: term, name: "订单", body: "改过的定义。" }), term);
  assert.deepEqual(
    (await detail(h, product.id)).knowledge.map((row) => [row.id, row.body]),
    [[term, "改过的定义。"]],
  );

  // 取代:新决策写下时把旧那条落成被它取代,旧那条仍读得到。
  const first = (await write(h, product.id, { kind: "decision", name: "签名用对称密钥", body: "先这样。" }))!;
  const second = (await write(h, product.id, {
    kind: "decision",
    name: "签名统一用 HMAC",
    body: "换成 HMAC。",
    supersedes: first,
  }))!;
  const decisions = (await detail(h, product.id)).knowledge.filter((row) => row.kind === "decision");
  assert.deepEqual(
    decisions.map((row) => [row.id, row.supersededBy]),
    [
      [first, second],
      [second, null],
    ],
  );

  // 同名的第二条写不进去:按名字读整条的那一路要求一个名字只有一条。
  await assert.rejects(() => write(h, product.id, { kind: "term", name: "订单", body: "另一份定义。" }));
  // 改写与取代都只认这个产品下的条目:认不出的 id 一格不动。
  assert.equal(await write(h, product.id, { kind: "term", id: 9999, name: "订单", body: "x" }), undefined);

  // 撤回:删行,第二遍不算成功;指着它的「被取代」跟着松开。
  const store = openStore(h.db.path);
  try {
    assert.equal(await store.withdrawProductKnowledge(product.id, second), true);
    assert.equal(await store.withdrawProductKnowledge(product.id, second), false);
  } finally {
    await store.close();
  }
  const left = (await detail(h, product.id)).knowledge;
  assert.equal(left.some((row) => row.id === second), false);
  assert.equal(left.find((row) => row.id === first)!.supersededBy, null);
});

test("写与裁决那几个端点已经没有了:条目只由会话写下", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const entry = (await write(h, product.id, { kind: "relationship", body: "网关向订单服务要状态。" }))!;

  const gone: [string, string][] = [
    ["POST", `/products/${product.id}/knowledge`],
    ["DELETE", `/products/${product.id}/knowledge/${entry}`],
    ["POST", `/products/${product.id}/knowledge/${entry}/accept`],
    ["POST", `/products/${product.id}/knowledge/${entry}/reject`],
  ];
  for (const [method, path] of gone) {
    const response = await h.api(method, path, method === "POST" ? {} : undefined);
    assert.equal(response.status, 404, `${method} ${path} 还在`);
  }
  // 那一条一格没动。
  assert.deepEqual(
    (await detail(h, product.id)).knowledge.map((row) => row.id),
    [entry],
  );
});

test("读产品知识不要权限格:看得到产品的人就读得到", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  await write(h, product.id, { kind: "relationship", body: "网关向订单服务要状态。" });

  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  assert.equal((await detail(h, product.id, reader)).knowledge.length, 1);

  // 这个产品里一个仓库都没分配到:与产品不存在同形回 404。
  const stranger = await seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["knowledge:write"]);
  const hidden = await fetch(`${h.serverUrl}/api/products/${product.id}`, {
    headers: { cookie: outsider },
  });
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });
});

test("升级前的旧库:旧的一句话条目、提案与驳回记忆一并丢掉,新表在且为空", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  await write(h, product.id, { kind: "term", name: "订单", body: "一次购买请求。" });

  // 把库退回升级之前的样子:新表还不存在,旧的两张表带着行。
  const db = new DatabaseSync(h.db.path);
  db.exec("DROP TABLE product_knowledge_entry");
  db.exec(`CREATE TABLE product_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    statement TEXT NOT NULL,
    repo_ids TEXT NOT NULL,
    state TEXT NOT NULL,
    proposed_by TEXT,
    proposed_session_id INTEGER,
    created_at TEXT NOT NULL,
    state_changed_at TEXT NOT NULL,
    retires_id INTEGER
  )`);
  db.exec(`CREATE TABLE product_knowledge_rejection (
    product_id INTEGER NOT NULL,
    statement TEXT NOT NULL,
    rejected_at TEXT NOT NULL,
    PRIMARY KEY (product_id, statement)
  )`);
  db.prepare(
    `INSERT INTO product_knowledge
       (product_id, statement, repo_ids, state, proposed_by, created_at, state_changed_at)
     VALUES (?, ?, ?, 'active', 'kassol', ?, ?)`,
  ).run(product.id, "acme/alpha 的网关转发 acme/widgets 的订单", "[1,2]", AT, AT);
  db.close();

  // 下一次开库:旧表丢掉,新表建起来,一条条目都没有,产品与它的仓库一格不动。
  const after = await detail(h, product.id);
  assert.deepEqual(after.knowledge, []);
  assert.deepEqual(
    after.product.repos.map((row) => row.repoId),
    [ALPHA, GITEA_REPO.id].sort((a, b) => a - b),
  );
  assert.equal(after.product.name, "报销系统");

  // 旧表真的没了,不是留着不读。
  const check = new DatabaseSync(h.db.path);
  try {
    for (const table of ["product_knowledge", "product_knowledge_rejection"]) {
      assert.equal(
        check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        undefined,
        `${table} 还在`,
      );
    }
  } finally {
    check.close();
  }

  // 新表空着,写照样走得通。
  await write(h, product.id, { kind: "relationship", body: "网关向订单服务要状态。" });
  assert.equal((await detail(h, product.id)).knowledge.length, 1);
});
