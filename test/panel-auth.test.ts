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
    reviewers: [],
    cacheDir: cache.dir,
    dbPath: db.path,
    adminToken: ADMIN_TOKEN,
    panelPrefix: PREFIX,
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

test("API 未知端点回 JSON 404,页面 404 与前缀猜错不可区分", async () => {
  const h = await startPanel();
  const cookie = sessionCookie(await h.login(ADMIN_TOKEN));

  // 带认证打 API 下不存在的端点:JSON 404,不回 index.html。
  const api = await h.get(`/${PREFIX}/api/no-such-endpoint`, cookie);
  assert.equal(api.status, 404);
  assert.match(api.headers.get("content-type") ?? "", /application\/json/);

  // 前缀下的页面路径(本票内)与前缀猜错是同一个 404:同状态、同空 body、无内容类型。
  const page = await h.get(`/${PREFIX}/some-page`, cookie);
  const wrongPrefix = await h.get(`/wrong-prefix/some-page`, cookie);
  assert.equal(page.status, 404);
  assert.equal(wrongPrefix.status, 404);
  assert.equal(await page.text(), await wrongPrefix.text());
  assert.equal(page.headers.get("content-type"), wrongPrefix.headers.get("content-type"));
});

test("未认证的 API 请求一律 401,不区分端点存不存在", async () => {
  const h = await startPanel();

  // 端点存在与否都是 401:枚举 API 面也要先过认证。
  assert.equal((await h.get(`/${PREFIX}/api/session`)).status, 401);
  assert.equal((await h.get(`/${PREFIX}/api/no-such-endpoint`)).status, 401);
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
