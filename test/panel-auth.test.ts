import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import { createWebhookServer } from "../src/webhook/server.ts";
import { makeCacheDir, makeDbPath } from "./support/git-fixture.ts";

const PREFIX = "panel-abc123";
const USERNAME = "admin";
const PASSWORD = "test-password";
const PASSWORD_HASH = await hashPassword(PASSWORD);
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

async function startPanel(options: { empty?: boolean; now?: () => number } = {}) {
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(cache.cleanup, db.cleanup);
  if (!options.empty) {
    const store = openStore(db.path);
    store.createPanelUser({
      username: USERNAME,
      displayName: "Admin",
      passwordHash: PASSWORD_HASH,
      mustChangePassword: false,
      createdAt: "2026-08-19T00:00:00.000Z",
      isSystemAdmin: true,
      roleId: null,
    });
    store.close();
  }
  const server = createWebhookServer({
    forges: {},
    buildReviewers: () => [],
    cacheDir: cache.dir,
    dbPath: db.path,
    bootstrapSecret: "bootstrap-test",
    panelPrefix: PREFIX,
    baseUrl: "https://reviewer.example.test",
    panelDist: `${cache.dir}/no-dist`,
    ...(options.now === undefined ? {} : { now: options.now }),
    onDelivery: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}/${PREFIX}/api${path}`, init);
  return { baseUrl, dbPath: db.path, request };
}

function cookie(response: Response): string {
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

async function login(h: Awaited<ReturnType<typeof startPanel>>, password = PASSWORD) {
  return h.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password }),
  });
}

test("账号登录拿到持久 session cookie,探测回身份,登出后旧 cookie 失效", async () => {
  const h = await startPanel();
  const response = await login(h);
  assert.equal(response.status, 204);
  const header = response.headers.getSetCookie()[0]!;
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, new RegExp(`Path=/${PREFIX}`));
  const sessionCookie = cookie(response);
  const who = await h.request("/session", { headers: { cookie: sessionCookie } });
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), {
    username: USERNAME,
    displayName: "Admin",
    isSystemAdmin: true,
    permissions: [],
    systemAdmins: ["Admin"],
    mustChangePassword: false,
    giteaUrl: null,
  });
  const done = await h.request("/session", { method: "DELETE", headers: { cookie: sessionCookie } });
  assert.equal(done.status, 204);
  assert.equal((await h.request("/session", { headers: { cookie: sessionCookie } })).status, 401);
});

test("零用户探测带 bootstrap,口令注册第一个管理员,第二次注册 409", async () => {
  const h = await startPanel({ empty: true });
  const probe = await h.request("/session");
  assert.equal(probe.status, 401);
  assert.deepEqual(await probe.json(), { error: "未登录", bootstrap: true });
  const wrong = await h.request("/users/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap: "wrong", username: USERNAME, password: PASSWORD }),
  });
  assert.equal(wrong.status, 401);
  const first = await h.request("/users/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap: "bootstrap-test", username: USERNAME, password: PASSWORD }),
  });
  assert.equal(first.status, 201);
  assert.equal((await h.request("/users/bootstrap", { method: "POST" })).status, 409);
  assert.equal((await login(h)).status, 204);
});

test("用户名不存在与密码错误都回 401且都承担 argon2 成本", async () => {
  const h = await startPanel();
  const started = performance.now();
  const wrong = await login(h, "wrong");
  const wrongMs = performance.now() - started;
  const missingStarted = performance.now();
  const missing = await h.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "missing", password: "wrong" }),
  });
  const missingMs = performance.now() - missingStarted;
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.ok(wrongMs >= 20, `${wrongMs}ms`);
  assert.ok(missingMs >= 20, `${missingMs}ms`);
});

test("未认证请求看不到 API 面,认证后未知端点才回 JSON 404", async () => {
  const h = await startPanel();
  assert.equal((await h.request("/no-such-endpoint")).status, 401);
  const sessionCookie = cookie(await login(h));
  const missing = await h.request("/no-such-endpoint", { headers: { cookie: sessionCookie } });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
});
