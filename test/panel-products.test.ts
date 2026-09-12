/**
 * 产品实体与它的面板接口(issue #331)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,产品与归属行落临时 SQLite。
 * 压的是票的四条验收:门禁、一仓多属被拒与仓库移除后自动摘出、按仓库分配的可见性,
 * 以及删产品回应的级联条数形状。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "products-test-password";
const AT = "2026-09-12T00:00:00.000Z";

type Product = {
  id: number;
  name: string;
  createdAt: string;
  repos: { repoId: number; owner: string; repo: string }[];
};

async function createProduct(h: PanelHarness, name: string): Promise<Product> {
  const response = await h.api("POST", "/products", { name });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { product: Product }).product;
}

/** 以指定 cookie 发一次请求。未登录与别的账号都走它,`api()` 只带管理员那一份。 */
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

async function products(h: PanelHarness, cookie?: string): Promise<Product[]> {
  const response =
    cookie === undefined ? await h.api("GET", "/products") : await as(h, cookie, "GET", "/products");
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { products: Product[] }).products;
}

async function product(h: PanelHarness, productId: number, cookie?: string): Promise<Product> {
  const response =
    cookie === undefined
      ? await h.api("GET", `/products/${productId}`)
      : await as(h, cookie, "GET", `/products/${productId}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { product: Product }).product;
}

test("建产品、改名、归属与删产品都要 repo:write,读不要", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const expense = await createProduct(h, "报销系统");
  assert.equal(
    (await h.api("PUT", `/products/${expense.id}/repos/${GITEA_REPO.id}`)).status,
    204,
  );
  // 有仓库分配、没有任何权限格的账号:读得到,写一律 403。
  const cookie = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);

  const writes: [string, string, unknown?][] = [
    ["POST", "/products", { name: "考勤系统" }],
    ["PUT", `/products/${expense.id}`, { name: "报销中心" }],
    ["DELETE", `/products/${expense.id}`],
    ["PUT", `/products/${expense.id}/repos/${GITEA_REPO.id}`],
    ["DELETE", `/products/${expense.id}/repos/${GITEA_REPO.id}`],
  ];
  for (const [method, path, body] of writes) {
    const response = await as(h, cookie, method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "没有这一格权限" });
  }

  assert.equal((await product(h, expense.id, cookie)).name, "报销系统");
  assert.equal((await products(h, cookie)).length, 1);
});

test("一个仓库归入第二个产品回 409,仓库移除后产品里不再有它", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const expense = await createProduct(h, "报销系统");
  const attendance = await createProduct(h, "考勤系统");
  const attach = (productId: number): Promise<Response> =>
    h.api("PUT", `/products/${productId}/repos/${GITEA_REPO.id}`);

  assert.equal((await attach(expense.id)).status, 204);
  // 再归入同一个产品是空操作,不是冲突。
  assert.equal((await attach(expense.id)).status, 204);
  assert.deepEqual((await product(h, expense.id)).repos, [
    { repoId: GITEA_REPO.id, owner: GITEA_REPO.owner, repo: GITEA_REPO.repo },
  ]);

  const conflict = await attach(attendance.id);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "这个仓库已经归在别的产品下" });
  assert.deepEqual((await product(h, attendance.id)).repos, []);

  // 移出之后那个仓库才归得进另一个产品。
  assert.equal(
    (await h.api("DELETE", `/products/${expense.id}/repos/${GITEA_REPO.id}`)).status,
    204,
  );
  const detachedTwice = await h.api("DELETE", `/products/${expense.id}/repos/${GITEA_REPO.id}`);
  assert.equal(detachedTwice.status, 404);
  assert.deepEqual(await detachedTwice.json(), { error: "这个产品下没有这个仓库" });
  assert.equal((await attach(attendance.id)).status, 204);

  // 仓库从注册表移除:产品里自动摘出,不留一个指向已不存在仓库的归属行。
  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}`)).status, 204);
  assert.deepEqual((await product(h, attendance.id)).repos, []);
});

test("产品按仓库分配可见:零分配 404,有任一仓库分配即可读,系统管理员看全部", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const expense = await createProduct(h, "报销系统");
  const attendance = await createProduct(h, "考勤系统");
  assert.equal((await h.api("PUT", `/products/${expense.id}/repos/${GITEA_REPO.id}`)).status, 204);
  assert.equal((await h.api("PUT", `/products/${attendance.id}/repos/${alpha}`)).status, 204);

  const member = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id]);
  assert.deepEqual(
    (await products(h, member)).map((row) => row.name),
    ["报销系统"],
  );
  const hidden = await as(h, member, "GET", `/products/${attendance.id}`);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });

  const nobody = await scopedUser(h, "nobody", PASSWORD, AT, []);
  assert.deepEqual(await products(h, nobody), []);
  assert.equal((await as(h, nobody, "GET", `/products/${expense.id}`)).status, 404);

  assert.deepEqual(
    (await products(h)).map((row) => row.name),
    ["报销系统", "考勤系统"],
  );
});

test("删产品回应带级联条数,没有会话时是 0", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const expense = await createProduct(h, "报销系统");
  assert.equal((await h.api("PUT", `/products/${expense.id}/repos/${GITEA_REPO.id}`)).status, 204);

  const removed = await h.api("DELETE", `/products/${expense.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { cascade: { sessions: 0 } });

  assert.deepEqual(await products(h), []);
  const missing = await h.api("DELETE", `/products/${expense.id}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "没有这个产品" });

  // 归属行跟着产品一起删掉:否则这个仓库归不进下一个产品。
  const attendance = await createProduct(h, "考勤系统");
  assert.equal(
    (await h.api("PUT", `/products/${attendance.id}/repos/${GITEA_REPO.id}`)).status,
    204,
  );
});

test("产品名唯一且不收空白名,改名同一条判据", async () => {
  const h = await startReadyPanelHarness();
  const expense = await createProduct(h, "报销系统");

  const duplicate = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "已经有同名产品" });

  for (const name of ["", "   ", "x".repeat(65), 42]) {
    const response = await h.api("POST", "/products", { name });
    assert.equal(response.status, 400, JSON.stringify(name));
    assert.deepEqual(await response.json(), { error: "产品名要是 1 到 64 个字符" });
  }

  // 改名落的是去掉两头空白的那一份。
  assert.equal((await h.api("PUT", `/products/${expense.id}`, { name: "  报销中心  " })).status, 204);
  assert.equal((await product(h, expense.id)).name, "报销中心");

  const attendance = await createProduct(h, "考勤系统");
  const taken = await h.api("PUT", `/products/${attendance.id}`, { name: "报销中心" });
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: "已经有同名产品" });

  const absent = await h.api("PUT", `/products/${expense.id + 999}`, { name: "合同中心" });
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), { error: "没有这个产品" });
});
