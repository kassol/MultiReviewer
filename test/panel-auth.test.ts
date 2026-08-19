import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { createPanelAuth } from "../src/panel/auth.ts";
import { createWebhookServer } from "../src/webhook/server.ts";
import { makeCacheDir, makeDbPath } from "./support/git-fixture.ts";

const ADMIN_TOKEN = "panel-admin-token";
const PREFIX = "panel-abc123";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

async function startPanel(options: { now?: () => number } = {}) {
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(cache.cleanup, db.cleanup);

  const server = createWebhookServer({
    forges: {},
    buildReviewers: () => [],
    cacheDir: cache.dir,
    dbPath: db.path,
    adminToken: ADMIN_TOKEN,
    panelPrefix: PREFIX,
    baseUrl: "https://reviewer.example.test",
    panelDist: `${cache.dir}/no-dist`,
    ...(options.now === undefined ? {} : { now: options.now }),
    onDelivery: () => {},
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });

  function login(token: string): Promise<Response> {
    return fetch(`${baseUrl}/${PREFIX}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      redirect: "manual",
    });
  }

  function get(path: string, cookie?: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  }

  return { baseUrl, login, get };
}

/** 登录响应里的 session cookie,`名=值` 形式,直接可回填进 Cookie 头。 */
function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie()[0];
  assert.notEqual(header, undefined);
  return header!.split(";", 1)[0]!;
}

test("登录拿到 session cookie,带 cookie 200、不带 401", async () => {
  const h = await startPanel();

  const login = await h.login(ADMIN_TOKEN);
  assert.equal(login.status, 204);
  const header = login.headers.getSetCookie()[0]!;
  // HttpOnly 防脚本读,Secure 配合启动时的基地址校验,Path 限前缀让前缀轮换后旧 cookie 自然失效。
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, new RegExp(`Path=/${PREFIX}`));
  assert.match(header, /SameSite=Strict/);

  const withCookie = await h.get(`/${PREFIX}/api/session`, sessionCookie(login));
  assert.equal(withCookie.status, 204);

  const without = await h.get(`/${PREFIX}/api/session`);
  assert.equal(without.status, 401);
  assert.match(without.headers.get("content-type") ?? "", /application\/json/);
});

test("token 不对回 401,body 形状不对回 400 且不计入退避", async () => {
  const h = await startPanel();

  assert.equal((await h.login("wrong-token")).status, 401);

  const malformed = await fetch(`${h.baseUrl}/${PREFIX}/api/session`, {
    method: "POST",
    body: "{ not json",
  });
  assert.equal(malformed.status, 400);

  // 形状错误不算猜 token,正确登录不该被它挡住。
  assert.equal((await h.login(ADMIN_TOKEN)).status, 204);
});

test("连续登录失败触发退避与 IP 锁定,窗口过了恢复", async () => {
  let nowMs = 1_000_000;
  const h = await startPanel({ now: () => nowMs });

  // 头三次免罚——人也会敲错;第四次起上锁。
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await h.login("wrong-token")).status, 401);
  }
  // 锁定期内 token 对也不放行:429 是「别猜了」,不是「猜错了」。
  assert.equal((await h.login(ADMIN_TOKEN)).status, 429);

  nowMs += 5_000;
  assert.equal((await h.login(ADMIN_TOKEN)).status, 204);

  // 成功登录清零计数:再错一次只是 401,不会直接锁。
  assert.equal((await h.login("wrong-token")).status, 401);
  assert.equal((await h.login(ADMIN_TOKEN)).status, 204);
});

test("API 未知端点回 JSON 404,前缀猜错是裸 404", async () => {
  const h = await startPanel();
  const cookie = sessionCookie(await h.login(ADMIN_TOKEN));

  // 带认证打 API 下不存在的端点:JSON 404,不回 index.html。
  const api = await h.get(`/${PREFIX}/api/no-such-endpoint`, cookie);
  assert.equal(api.status, 404);
  assert.match(api.headers.get("content-type") ?? "", /application\/json/);

  // 前缀猜错一律裸 404;真前缀下的页面路由归 index.html(见 panel-pages.test.ts)。
  const wrongPrefix = await h.get(`/wrong-prefix/some-page`, cookie);
  assert.equal(wrongPrefix.status, 404);
  assert.equal(await wrongPrefix.text(), "");
});

test("未认证的 API 请求一律 401,不区分端点存不存在", async () => {
  const h = await startPanel();

  // 端点存在与否都是 401:枚举 API 面也要先过认证。
  assert.equal((await h.get(`/${PREFIX}/api/session`)).status, 401);
  assert.equal((await h.get(`/${PREFIX}/api/no-such-endpoint`)).status, 401);
});

test("面板路由表覆盖全部 method + path,且只有登录公开", async () => {
  const h = await startPanel();
  const cookie = sessionCookie(await h.login(ADMIN_TOKEN));
  const routes = [
    ["GET", "/session"],
    ["DELETE", "/session"],
    ["GET", "/settings"],
    ["PUT", "/settings"],
    ["GET", "/stats"],
    ["GET", "/runs"],
    ["POST", "/rerun"],
    ["GET", "/repos/search"],
    ["GET", "/repos"],
    ["POST", "/repos"],
    ["DELETE", "/repos/1"],
    ["PUT", "/repos/1/reviewers"],
    ["POST", "/repos/1/rotate"],
    ["GET", "/repos/1/hooks"],
    ["GET", "/catalog"],
    ["GET", "/credentials"],
    ["PUT", "/credentials/test_provider-1"],
    ["DELETE", "/credentials/test_provider-1"],
    ["GET", "/model-rows"],
    ["POST", "/model-rows"],
    ["DELETE", "/model-rows"],
    ["GET", "/custom-providers"],
    ["POST", "/custom-providers"],
    ["DELETE", "/custom-providers/test-provider"],
  ] as const;

  for (const [method, path] of routes) {
    const unauthenticated = await fetch(`${h.baseUrl}/${PREFIX}/api${path}`, { method });
    assert.equal(unauthenticated.status, 401, `${method} ${path} 没有在 session 门禁后`);

    const authenticated = await fetch(`${h.baseUrl}/${PREFIX}/api${path}`, {
      method,
      headers: { cookie },
    });
    assert.notEqual(authenticated.status, 404, `${method} ${path} 没有匹配到路由`);
  }

  // 登录是唯一公开路由;同一路径的其他 method 仍不可枚举。
  assert.equal((await h.login("wrong-token")).status, 401);
  const wrongMethod = await fetch(`${h.baseUrl}/${PREFIX}/api/session`, { method: "PUT" });
  assert.equal(wrongMethod.status, 401);
});

test("登出作废 session,清除 cookie 的属性与登录时逐字一致", async () => {
  const h = await startPanel();

  function logout(cookie?: string): Promise<Response> {
    return fetch(`${h.baseUrl}/${PREFIX}/api/session`, {
      method: "DELETE",
      redirect: "manual",
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  }

  // 登出在门禁之后:没有会话可作废的调用者与其余端点同档回 401。
  assert.equal((await logout()).status, 401);

  const login = await h.login(ADMIN_TOKEN);
  const cookie = sessionCookie(login);
  const done = await logout(cookie);
  assert.equal(done.status, 204);

  // Path 差一个字浏览器就不删,清除头因此除了值与 Max-Age 之外必须与登录头逐字相同。
  const cleared = done.headers.getSetCookie()[0]!;
  const attributes = (header: string): string =>
    header.split(";").slice(1).join(";").replace(/ Max-Age=\d+/, " Max-Age");
  assert.equal(attributes(cleared), attributes(login.headers.getSetCookie()[0]!));
  assert.match(cleared, /(^|;\s*)Max-Age=0(;|$)/);

  // 旧 cookie 就此失效:服务端的会话表里已经没有它。
  assert.equal((await h.get(`/${PREFIX}/api/session`, cookie)).status, 401);
});

// 冲刷追踪表要一万个来源地址,走 HTTP 太慢,这条直接打认证判定模块(时钟注入是同一条缝)。
test("锁定中的记录不被伪造源地址挤出追踪表", () => {
  let nowMs = 0;
  const auth = createPanelAuth(ADMIN_TOKEN, () => nowMs);

  // 攻击者的 IP 先被锁上(第 4 次失败起算)。
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(auth.login("wrong", "attacker"), { ok: false, status: 401 });
  }
  assert.deepEqual(auth.login(ADMIN_TOKEN, "attacker"), { ok: false, status: 429 });

  // 用一万个不同源地址各失败一次,试图把锁定记录挤出上限。
  for (let i = 0; i < 10_000; i += 1) {
    auth.login("wrong", `spoofed-${i}`);
  }

  // 锁仍然在:能被伪造地址冲掉的锁不是锁。
  assert.deepEqual(auth.login(ADMIN_TOKEN, "attacker"), { ok: false, status: 429 });
});
