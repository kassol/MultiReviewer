import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import { PANEL_PREFIX, startPanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});
const PASSWORD = "permission-test-password";
const HASH = await hashPassword(PASSWORD);

async function userCookie(serverUrl: string, username: string): Promise<string> {
  const response = await fetch(`${serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

test("角色权限每请求现读:改角色后不用重登立即生效", async () => {
  const h = await startPanelHarness(cleanups);
  const store = openStore(h.db.path);
  const none = store.createPanelRole({ name: "无权限", permissions: [], createdAt: new Date().toISOString() });
  const reader = store.createPanelRole({ name: "模型读", permissions: ["model:read"], createdAt: new Date().toISOString() });
  store.createPanelUser({
    username: "reader",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    isSystemAdmin: false,
    roleId: none.id,
  });
  store.close();

  const cookie = await userCookie(h.serverUrl, "reader");
  const request = (): Promise<Response> =>
    fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/settings`, { headers: { cookie } });
  assert.equal((await request()).status, 403);
  const update = openStore(h.db.path);
  assert.equal(
    update.updatePanelUser("reader", { displayName: null, roleId: reader.id, isSystemAdmin: false }),
    "updated",
  );
  update.close();
  assert.equal((await request()).status, 200);
});

test("普通用户不能调用系统管理员端点", async () => {
  const h = await startPanelHarness(cleanups);
  const store = openStore(h.db.path);
  store.createPanelUser({
    username: "ordinary",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    isSystemAdmin: false,
    roleId: null,
  });
  store.close();
  const cookie = await userCookie(h.serverUrl, "ordinary");
  const response = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/roles`, { headers: { cookie } });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "只有系统管理员能做" });
});
