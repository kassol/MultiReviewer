/**
 * 仓库分配的落库与录入(issue #191)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,分配行落临时 SQLite。
 * 这一票只管录入、回显与级联,读接口按分配过滤不在范围内。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR as PR,
  PANEL_PREFIX as PREFIX,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "user-repos-test-password";

type UserRow = { username: string; repoIds: number[] };

/** 直接落一行注册表:这几条用例要的是仓库存在,不是它的 hook。 */
function seedRepo(h: PanelHarness, repoId: number, owner: string, repo: string): number {
  const store = openStore(h.db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId, owner, repo, generation: 1, key: `key-${repoId}` }),
      true,
    );
  } finally {
    store.close();
  }
  return repoId;
}

async function createUser(
  h: PanelHarness,
  username: string,
  repoIds?: readonly number[],
): Promise<void> {
  const response = await h.api("POST", "/users", {
    username,
    password: PASSWORD,
    ...(repoIds === undefined ? {} : { repoIds }),
  });
  assert.equal(response.status, 201, await response.text());
}

async function listUsers(h: PanelHarness): Promise<UserRow[]> {
  const response = await h.api("GET", "/users");
  assert.equal(response.status, 200);
  return ((await response.json()) as { users: UserRow[] }).users;
}

async function assignedRepoIds(h: PanelHarness, username: string): Promise<number[]> {
  const user = (await listUsers(h)).find((row) => row.username === username);
  assert.ok(user !== undefined, `用户 ${username} 不在列表里`);
  return user.repoIds;
}

async function userCookie(h: PanelHarness, username: string): Promise<string> {
  const response = await fetch(`${h.serverUrl}/${PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

test("创建用户带 repoIds 后列表回显同一集合", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const beta = seedRepo(h, 102, "acme", "beta");

  await createUser(h, "reviewer", [beta, alpha]);

  assert.deepEqual(await assignedRepoIds(h, "reviewer"), [alpha, beta]);
  // 没带 repoIds 建的号一个仓库都没分到。
  await createUser(h, "newcomer");
  assert.deepEqual(await assignedRepoIds(h, "newcomer"), []);
});

test("更新用户不带 repoIds 时集合不变,带空数组时清空", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const beta = seedRepo(h, 102, "acme", "beta");
  await createUser(h, "reviewer", [alpha, beta]);
  const update = (body: Record<string, unknown>): Promise<Response> =>
    h.api("PUT", "/users/reviewer", { displayName: null, roleId: null, isSystemAdmin: false, ...body });

  assert.equal((await update({})).status, 204);
  assert.deepEqual(await assignedRepoIds(h, "reviewer"), [alpha, beta]);

  assert.equal((await update({ repoIds: [beta] })).status, 204);
  assert.deepEqual(await assignedRepoIds(h, "reviewer"), [beta]);

  assert.equal((await update({ repoIds: [] })).status, 204);
  assert.deepEqual(await assignedRepoIds(h, "reviewer"), []);
});

test("repoIds 形状不对时创建与更新都回 400", async () => {
  const h = await startReadyPanelHarness(cleanups);
  await createUser(h, "reviewer");

  const created = await h.api("POST", "/users", {
    username: "broken",
    password: PASSWORD,
    repoIds: "all",
  });
  assert.equal(created.status, 400);
  assert.equal((await listUsers(h)).some((row) => row.username === "broken"), false);

  const updated = await h.api("PUT", "/users/reviewer", {
    displayName: null,
    roleId: null,
    isSystemAdmin: false,
    repoIds: [1.5],
  });
  assert.equal(updated.status, 400);
});

test("会话带上仓库分配:普通用户是自己的集合,系统管理员是 null", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  seedRepo(h, 102, "acme", "beta");
  await createUser(h, "reviewer", [alpha]);

  const cookie = await userCookie(h, "reviewer");
  const mine = await fetch(`${h.serverUrl}/${PREFIX}/api/session`, { headers: { cookie } });
  assert.equal(mine.status, 200);
  assert.deepEqual(((await mine.json()) as { repoIds: number[] | null }).repoIds, [alpha]);

  const admin = await h.api("GET", "/session");
  assert.equal(admin.status, 200);
  assert.equal(((await admin.json()) as { repoIds: number[] | null }).repoIds, null);
});

test("删除用户与移除仓库都不留分配行", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  await createUser(h, "reviewer", [alpha, GITEA_REPO.id]);

  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}`)).status, 204);
  assert.deepEqual(await assignedRepoIds(h, "reviewer"), [alpha]);

  assert.equal((await h.api("DELETE", "/users/reviewer")).status, 204);
  const sqlite = new DatabaseSync(h.db.path, { readOnly: true });
  const remaining = Number(
    sqlite.prepare("SELECT COUNT(*) AS c FROM panel_user_repo").get()!["c"],
  );
  sqlite.close();
  assert.equal(remaining, 0);
});
