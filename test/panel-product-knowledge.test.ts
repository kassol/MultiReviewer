/**
 * 产品知识与它手写维护的那一段面板接口(CONTEXT.md 产品知识,ADR 0032,issue #343)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,产品与产品知识行落临时 SQLite。
 * 压的是票的四条验收:手写落生效列表并扛得过重载、退役之后不在列表里、三道校验各说一句
 * 中文、权限与可见性,以及升级前的旧库开起来新表在且为空、产品其它功能不变。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
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

type KnowledgeEntry = { id: number; statement: string; repoIds: number[] };
type Product = {
  id: number;
  name: string;
  repos: { repoId: number; owner: string; repo: string; role: string | null }[];
};

/** 一个带两个仓库的产品:产品知识至少要说到两个仓库,一个仓库的产品写不出条目。 */
async function productWithTwoRepos(h: PanelHarness): Promise<Product> {
  seedRepo(h, ALPHA, "acme", "alpha");
  const response = await h.api("POST", "/products", { name: "报销系统" });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const { product } = JSON.parse(text) as { product: Product };
  // 归属行直接落库:走归入端点会自己开一场梳理(issue #347),而这几例压的是手写维护。
  const store = openStore(h.db.path);
  try {
    for (const repoId of [GITEA_REPO.id, ALPHA]) {
      assert.equal(store.attachProductRepo(product.id, repoId, AT), "attached");
    }
  } finally {
    store.close();
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

function write(h: PanelHarness, productId: number, body: unknown, cookie?: string): Promise<Response> {
  const url = `${h.serverUrl}/api/products/${productId}/knowledge`;
  return cookie === undefined
    ? h.api("POST", `/products/${productId}/knowledge`, body)
    : fetch(url, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
}

/** 写一条产品知识并取回它。非 201 即带上正文断言失败。 */
async function writeEntry(
  h: PanelHarness,
  productId: number,
  body: unknown,
  cookie?: string,
): Promise<KnowledgeEntry> {
  const response = await write(h, productId, body, cookie);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { entry: KnowledgeEntry }).entry;
}

test("手写一条产品知识:落生效列表、扛得过重载,退役之后不在列表里", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);

  const entry = await writeEntry(h, product.id, {
    statement: "acme/widgets 的订单接口由 acme/alpha 的网关转发,契约是 OpenAPI",
    repoIds: [ALPHA, GITEA_REPO.id, ALPHA],
  });
  // 仓库集合升序去重:同一个仓库写两遍只算一个。
  assert.deepEqual(entry.repoIds, [ALPHA, GITEA_REPO.id].sort((a, b) => a - b));

  // 重载即再读一次详情:同一条在生效列表里,产品列表那一份一格没多。
  const reloaded = await detail(h, product.id);
  assert.deepEqual(reloaded.knowledge, [entry]);
  const listed = await h.api("GET", "/products");
  assert.deepEqual(Object.keys(((await listed.json()) as { products: unknown[] }).products[0]!), [
    "id",
    "name",
    "createdAt",
    "repos",
  ]);

  // 退役:从生效列表里消失,再读一次还是不在(退役落库,不只是这一次响应)。
  assert.equal(
    (await h.api("DELETE", `/products/${product.id}/knowledge/${entry.id}`)).status,
    204,
  );
  assert.deepEqual((await detail(h, product.id)).knowledge, []);

  // 退役两次不算成功:第二次那一条已经不生效了。
  const again = await h.api("DELETE", `/products/${product.id}/knowledge/${entry.id}`);
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { error: "没有这条生效的产品知识" });
});

test("写产品知识的三道校验各说一句中文", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const outside = seedRepo(h, 202, "acme", "beta");
  const statement = "acme/widgets 与 acme/alpha 共用一份订单状态枚举";

  const refusals: [unknown, string][] = [
    [{ statement, repoIds: [GITEA_REPO.id] }, "产品知识至少要说到这个产品里的两个仓库"],
    [{ statement, repoIds: [GITEA_REPO.id, GITEA_REPO.id] }, "产品知识至少要说到这个产品里的两个仓库"],
    [{ statement, repoIds: "两个" }, "产品知识至少要说到这个产品里的两个仓库"],
    [
      { statement, repoIds: [GITEA_REPO.id, outside] },
      `这个产品下没有 repo id 为 ${outside} 的仓库`,
    ],
    [{ statement: "   ", repoIds: [GITEA_REPO.id, ALPHA] }, "产品知识的陈述要是 1 到 100 个字符"],
    [
      { statement: "长".repeat(101), repoIds: [GITEA_REPO.id, ALPHA] },
      "产品知识的陈述要是 1 到 100 个字符",
    ],
  ];
  for (const [body, error] of refusals) {
    const response = await write(h, product.id, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error });
  }
  assert.deepEqual((await detail(h, product.id)).knowledge, []);

  // 100 字正好收下:上限与 agent 产出的陈述同一个数。
  await writeEntry(h, product.id, { statement: "长".repeat(100), repoIds: [GITEA_REPO.id, ALPHA] });
});

test("写与退役要 knowledge:write 加这个产品里的一个仓库分配,读不要", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const statement = "acme/widgets 的定时任务读 acme/alpha 落的那张队列表";
  const entry = await writeEntry(h, product.id, { statement, repoIds: [GITEA_REPO.id, ALPHA] });

  // 有仓库分配、没有这一格权限:读得到列表,写与退役一律 403。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  assert.deepEqual((await detail(h, product.id, reader)).knowledge, [entry]);
  const refused = await write(h, product.id, { statement, repoIds: [GITEA_REPO.id, ALPHA] }, reader);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "没有这一格权限" });
  const retire = await fetch(`${h.serverUrl}/api/products/${product.id}/knowledge/${entry.id}`, {
    method: "DELETE",
    headers: { cookie: reader },
  });
  assert.equal(retire.status, 403);
  assert.deepEqual(await retire.json(), { error: "没有这一格权限" });

  // 有这一格权限、却对这个产品里一个仓库都没分配:与产品不存在同形回 404。
  const stranger = seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["knowledge:write"]);
  const hidden = await write(
    h,
    product.id,
    { statement, repoIds: [GITEA_REPO.id, ALPHA] },
    outsider,
  );
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });

  // 有这一格权限又有产品内的仓库分配:写得进去。
  const writer = await scopedUser(h, "writer", PASSWORD, AT, [ALPHA], ["knowledge:write"]);
  await writeEntry(
    h,
    product.id,
    { statement: "acme/alpha 的网关把 acme/widgets 的错误码原样透出", repoIds: [GITEA_REPO.id, ALPHA] },
    writer,
  );
  assert.equal((await detail(h, product.id)).knowledge.length, 2);
});

test("升级前的旧库:开库建起产品知识表,列表为空、产品其它功能不变", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  await writeEntry(h, product.id, {
    statement: "acme/widgets 与 acme/alpha 的会话口令由同一个密钥签",
    repoIds: [GITEA_REPO.id, ALPHA],
  });

  // 把库退回升级之前的样子:那时这张表还不存在。
  const db = new DatabaseSync(h.db.path);
  db.exec("DROP TABLE product_knowledge");
  db.close();

  // 下一次开库把表建回来:一条条目都没有,产品与它的仓库一格不动。
  const after = await detail(h, product.id);
  assert.deepEqual(after.knowledge, []);
  assert.deepEqual(
    after.product.repos.map((row) => row.repoId),
    [ALPHA, GITEA_REPO.id].sort((a, b) => a - b),
  );
  assert.equal(after.product.name, "报销系统");
  // 新表空着,手写照样走得通。
  await writeEntry(h, product.id, {
    statement: "acme/alpha 的构建产物由 acme/widgets 的流水线发布",
    repoIds: [GITEA_REPO.id, ALPHA],
  });
  assert.equal((await detail(h, product.id)).knowledge.length, 1);
});
