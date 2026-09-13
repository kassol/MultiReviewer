/**
 * 产品实体与它的面板接口(issue #331)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,产品与归属行落临时 SQLite。
 * 压的是票的四条验收:门禁、一仓多属被拒与仓库移除后自动摘出、按仓库分配的可见性,
 * 以及删产品回应的级联条数形状。
 *
 * 仓库职责(CONTEXT.md 仓库职责,issue #341)压在同一个归属端点上:带职责归入、重新归属
 * 改职责、空白存成没有、超过上限回 400,另一条压升级前的旧库补列。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
  repos: { repoId: number; owner: string; repo: string; role: string | null }[];
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
    { repoId: GITEA_REPO.id, owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, role: null },
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

test("仓库职责:归属时带得上,同一个端点改得动,空白存成没有,超长回 400", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const expense = await createProduct(h, "报销系统");
  const attach = (body?: unknown): Promise<Response> =>
    h.api("PUT", `/products/${expense.id}/repos/${GITEA_REPO.id}`, body);
  const role = async (): Promise<string | null> => (await product(h, expense.id)).repos[0]!.role;

  // 归入时带职责:两头空白不进库。
  assert.equal((await attach({ role: "  后端 API(Node),前端在 acme/web  " })).status, 204);
  assert.deepEqual((await product(h, expense.id)).repos, [
    {
      repoId: GITEA_REPO.id,
      owner: GITEA_REPO.owner,
      repo: GITEA_REPO.repo,
      role: "后端 API(Node),前端在 acme/web",
    },
  ]);
  // 列表那一份与单个产品同形。
  assert.equal((await products(h))[0]!.repos[0]!.role, "后端 API(Node),前端在 acme/web");

  // 同一个端点改已经归属的那一行:职责换掉,归属行还是那一条。
  assert.equal((await attach({ role: "后端 API 与定时任务" })).status, 204);
  assert.equal(await role(), "后端 API 与定时任务");

  // 只有空白即没有职责;不带请求体同样是没有(这一个 PUT 是整格覆盖)。
  assert.equal((await attach({ role: "   " })).status, 204);
  assert.equal(await role(), null);
  assert.equal((await attach({ role: "后端 API" })).status, 204);
  assert.equal((await attach()).status, 204);
  assert.equal(await role(), null);

  // 上限与产品名同一个数,超了这一次整格不写。
  assert.equal((await attach({ role: "后端 API" })).status, 204);
  const long = await attach({ role: "x".repeat(65) });
  assert.equal(long.status, 400);
  assert.deepEqual(await long.json(), { error: "仓库职责要是最多 64 个字符的文本" });
  assert.equal(await role(), "后端 API");

  // 不是字符串同样 400,不悄悄当成没有。
  assert.equal((await attach({ role: 7 })).status, 400);
  assert.equal(await role(), "后端 API");
});

test("升级前的旧库:开库补上仓库职责那一列,旧的归属行读得回来", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const expense = await createProduct(h, "报销系统");
  const attach = (body?: unknown): Promise<Response> =>
    h.api("PUT", `/products/${expense.id}/repos/${GITEA_REPO.id}`, body);
  assert.equal((await attach({ role: "后端 API" })).status, 204);

  // 把库退回升级之前的样子:那时这一列还不存在。改名而不是 DROP——SQLite 丢一张表的最后
  // 一列时要重写建表语句,而 `product_repo` 的建表语句里有中文注释(与 `range_review` 那
  // 一处同一个理由)。改名之后 `pragma_table_info` 同样查不到这个名字。
  const db = new DatabaseSync(h.db.path);
  db.exec("ALTER TABLE product_repo RENAME COLUMN role TO before_upgrade_role");
  db.close();

  // 下一次开库补列:归属行一条不少,职责是「没有」。
  assert.deepEqual((await product(h, expense.id)).repos, [
    { repoId: GITEA_REPO.id, owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, role: null },
  ]);
  assert.equal((await attach({ role: "后端 API" })).status, 204);
  assert.equal((await product(h, expense.id)).repos[0]!.role, "后端 API");
});
