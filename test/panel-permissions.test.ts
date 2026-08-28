import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import type { PanelPermission } from "../src/panel/permissions.ts";
import { openStore } from "../src/review/store.ts";
import { PANEL_ROUTES } from "../src/webhook/server.ts";
import { PANEL_PREFIX, startPanelHarness, type PanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});
const PASSWORD = "permission-test-password";
const HASH = await hashPassword(PASSWORD);

const ROUTE_EXPECTATIONS = [
  ["POST", "/session", "public", "-"],
  ["POST", "/users/bootstrap", "public", "-"],
  ["GET", "/session", "authenticated-only", "-"],
  ["GET", "/users", "system-admin-only", "-"],
  ["POST", "/users", "system-admin-only", "-"],
  ["PUT", "/^\\/users\\/([a-z0-9._-]{1,32})$/", "system-admin-only", "-"],
  ["DELETE", "/^\\/users\\/([a-z0-9._-]{1,32})$/", "system-admin-only", "-"],
  ["POST", "/^\\/users\\/([a-z0-9._-]{1,32})\\/reset-password$/", "system-admin-only", "-"],
  ["PUT", "/session/password", "authenticated-only", "-"],
  ["GET", "/roles", "system-admin-only", "-"],
  ["POST", "/roles", "system-admin-only", "-"],
  ["PUT", "/^\\/roles\\/(\\d+)$/", "system-admin-only", "-"],
  ["DELETE", "/^\\/roles\\/(\\d+)$/", "system-admin-only", "-"],
  ["DELETE", "/session", "authenticated-only", "-"],
  ["GET", "/setup-status", "authenticated-only", "-"],
  ["GET", "/settings", "model:read", "-"],
  ["PUT", "/settings", "model:write", "-"],
  ["GET", "/stats", "authenticated-only", "-"],
  ["GET", "/runs", "authenticated-only", "-"],
  ["GET", "/stages", "authenticated-only", "-"],
  ["GET", "/^\\/stages\\/(.+)$/", "authenticated-only", "-"],
  ["GET", "/^\\/runs\\/(\\d+)$/", "authenticated-only", "run:1"],
  ["GET", "/^\\/runs\\/(\\d+)\\/diff$/", "authenticated-only", "run:1"],
  ["GET", "/^\\/runs\\/(\\d+)\\/trace$/", "authenticated-only", "run:1"],
  ["GET", "/^\\/runs\\/(\\d+)\\/trace\\/stream$/", "authenticated-only", "run:1"],
  ["GET", "/stage-summary", "authenticated-only", "query"],
  ["POST", "/rerun", "review:rerun", "-"],
  ["POST", "/^\\/findings\\/(\\d+)\\/resolve$/", "finding:dispose", "finding:1"],
  ["POST", "/^\\/findings\\/(\\d+)\\/unresolve$/", "finding:dispose", "finding:1"],
  ["POST", "/range-reviews", "review:create", "-"],
  ["GET", "/range-reviews/prefill", "review:create", "query"],
  ["POST", "/^\\/range-reviews\\/(\\d+)\\/advance$/", "review:create", "range-review:1"],
  ["POST", "/^\\/range-reviews\\/(\\d+)\\/complete$/", "finding:dispose", "range-review:1"],
  ["GET", "/repo-branches", "anyOf:review:create|rule:write", "query"],
  ["GET", "/repo-commits", "anyOf:review:create|rule:write", "query"],
  ["GET", "/repo-tags", "anyOf:review:create|rule:write", "query"],
  ["GET", "/repos/search", "repo:write", "-"],
  ["GET", "/repos", "authenticated-only", "-"],
  ["POST", "/repos", "repo:write", "-"],
  ["DELETE", "/^\\/repos\\/(\\d+)$/", "repo:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/worktree$/", "repo:write", "repo:1"],
  ["PUT", "/^\\/repos\\/(\\d+)\\/reviewers$/", "repo:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rotate$/", "repo:write", "repo:1"],
  ["GET", "/^\\/repos\\/(\\d+)\\/hooks$/", "authenticated-only", "repo:1"],
  ["GET", "/^\\/repos\\/(\\d+)\\/rules$/", "authenticated-only", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rules$/", "rule:write", "repo:1"],
  ["PUT", "/^\\/repos\\/(\\d+)\\/rules\\/(\\d+)$/", "rule:write", "repo:1"],
  ["DELETE", "/^\\/repos\\/(\\d+)\\/rules\\/(\\d+)$/", "rule:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rule-exploration$/", "rule:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rule-draft$/", "rule:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rule-draft\\/confirm$/", "rule:write", "repo:1"],
  ["PUT", "/^\\/repos\\/(\\d+)\\/rule-draft\\/(\\d+)$/", "rule:write", "repo:1"],
  ["DELETE", "/^\\/repos\\/(\\d+)\\/rule-draft\\/(\\d+)$/", "rule:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rule-proposals\\/(\\d+)\\/accept$/", "rule:write", "repo:1"],
  ["POST", "/^\\/repos\\/(\\d+)\\/rule-proposals\\/(\\d+)\\/reject$/", "rule:write", "repo:1"],
  ["GET", "/rule-models", "rule:write", "-"],
  ["GET", "/model-services", "anyOf:model:read|credential:read", "-"],
  [
    "GET",
    "/model-services/providers",
    "anyOf:model:read|model:write|credential:read|credential:write",
    "-",
  ],
  ["POST", "/^\\/model-services\\/builtin\\/preview$/", "credential:write", "-"],
  ["POST", "/^\\/model-services\\/builtin\\/commit$/", "credential:write", "-"],
  ["POST", "/^\\/model-services\\/custom\\/preview$/", "allOf:model:write|credential:write", "-"],
  ["POST", "/^\\/model-services\\/custom\\/commit$/", "allOf:model:write|credential:write", "-"],
  [
    "POST",
    "/^\\/model-services\\/custom\\/([a-z0-9-]{1,64})\\/rename$/",
    "allOf:model:write|credential:write",
    "-",
  ],
  [
    "DELETE",
    "/^\\/model-services\\/custom\\/([a-z0-9-]{1,64})$/",
    "allOf:model:write|credential:write",
    "-",
  ],
  ["POST", "/^\\/model-services\\/([A-Za-z0-9_-]+)\\/reverify$/", "credential:write", "-"],
  ["DELETE", "/^\\/model-services\\/([A-Za-z0-9_-]+)\\/credential$/", "credential:write", "-"],
  ["POST", "/^\\/model-services\\/([A-Za-z0-9_-]+)\\/refresh$/", "model:write", "-"],
  ["PUT", "/^\\/model-services\\/([A-Za-z0-9_-]+)\\/model-states$/", "model:write", "-"],
  ["POST", "/^\\/model-services\\/([A-Za-z0-9_-]+)\\/supplements$/", "model:write", "-"],
  ["DELETE", "/^\\/model-services\\/([A-Za-z0-9_-]+)\\/supplements$/", "model:write", "-"],
] as const;

function routeAccess(access: (typeof PANEL_ROUTES)[number]["access"]): string {
  if (typeof access === "string") return access;
  if ("anyOf" in access) return `anyOf:${access.anyOf.join("|")}`;
  return `allOf:${access.allOf.join("|")}`;
}

/** 第四列:这个端点的目标仓库从哪里认(仓库分配),`-` 是不声明。 */
function routeAssignment(assignment: (typeof PANEL_ROUTES)[number]["assignment"]): string {
  if (assignment === undefined) return "-";
  return assignment.by === "query" ? "query" : `${assignment.by}:${assignment.group}`;
}

function routeKey(route: (typeof PANEL_ROUTES)[number]): string {
  return [
    route.method,
    String(route.pattern),
    routeAccess(route.access),
    routeAssignment(route.assignment),
  ].join(" ");
}

function expectedRouteKey(route: (typeof ROUTE_EXPECTATIONS)[number]): string {
  return `${route[0]} ${route[1]} ${route[2]} ${route[3]}`;
}

function addPermissionUser(
  h: PanelHarness,
  username: string,
  permissions: readonly PanelPermission[],
): void {
  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: `role-${username}`,
    permissions,
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username,
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.close();
}

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

test("写权限在会话与端点统一包含对应读权限，review:rerun 保持独立", async () => {
  const h = await startPanelHarness(cleanups);
  addPermissionUser(h, "repo-writer", ["repo:write"]);
  addPermissionUser(h, "effective-model-writer", ["model:write"]);
  addPermissionUser(h, "effective-credential-writer", ["credential:write"]);
  addPermissionUser(h, "rerunner", ["review:rerun"]);

  const cases = [
    ["repo-writer", ["repo:write"], "/repos"],
    ["effective-model-writer", ["model:read", "model:write"], "/settings"],
    [
      "effective-credential-writer",
      ["credential:read", "credential:write"],
      "/model-services",
    ],
  ] as const;
  for (const [username, permissions, readPath] of cases) {
    const cookie = await userCookie(h.serverUrl, username);
    const session = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    const body = (await session.json()) as { permissions: PanelPermission[] };
    assert.deepEqual(body.permissions, permissions);
    assert.equal(
      (await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${readPath}`, { headers: { cookie } }))
        .status,
      200,
    );
  }

  const rerunCookie = await userCookie(h.serverUrl, "rerunner");
  const rerunSession = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    headers: { cookie: rerunCookie },
  });
  const rerunBody = (await rerunSession.json()) as { permissions: PanelPermission[] };
  assert.deepEqual(rerunBody.permissions, ["review:rerun"]);
  assert.equal(
    (
      await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/runs`, {
        headers: { cookie: rerunCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/rerun`, {
        method: "POST",
        headers: { cookie: rerunCookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
});

test("新增的 rule:write 不落到已有角色上,持有它的人也只多这一格", async () => {
  const h = await startPanelHarness(cleanups);
  // 已有角色只勾了重跑:新增权限格不会自动落到它上面(角色是权限格的子集)。
  addPermissionUser(h, "rerun-only", ["review:rerun"]);
  const rerunCookie = await userCookie(h.serverUrl, "rerun-only");
  const rerunSession = (await (
    await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, { headers: { cookie: rerunCookie } })
  ).json()) as { permissions: PanelPermission[] };
  assert.deepEqual(rerunSession.permissions, ["review:rerun"]);

  // rule:write 不隐含任何读权限:读侧沿用登录加仓库分配(ADR 0019)。
  addPermissionUser(h, "rule-writer", ["rule:write"]);
  const cookie = await userCookie(h.serverUrl, "rule-writer");
  const session = (await (
    await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, { headers: { cookie } })
  ).json()) as { permissions: PanelPermission[] };
  assert.deepEqual(session.permissions, ["rule:write"]);
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
  assert.equal(
    (
      await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/setup-status`, {
        headers: { cookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/setup-status`)).status,
    401,
  );
});

test("无人引用的角色连权限关系一起删除", async () => {
  const h = await startPanelHarness(cleanups);
  const created = await h.api("POST", "/roles", {
    name: "待删除角色",
    permissions: ["review:rerun"],
  });
  assert.equal(created.status, 201);
  const role = (await created.json()) as { id: number };
  assert.equal((await h.api("DELETE", `/roles/${role.id}`)).status, 204);
  const roles = (await (await h.api("GET", "/roles")).json()) as { roles: { id: number }[] };
  assert.ok(!roles.roles.some((item) => item.id === role.id));
});

test("无角色的普通用户登录即可读仓库、评审记录与处置率", async () => {
  const h = await startPanelHarness(cleanups);
  const store = openStore(h.db.path);
  store.createPanelUser({
    username: "plain",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: null,
  });
  store.close();
  const cookie = await userCookie(h.serverUrl, "plain");
  for (const path of ["/repos", "/stages", "/runs", "/stats"]) {
    const response = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${path}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200, path);
  }
});

test("退役的两个读权限格不再被认得:角色写入回 400", async () => {
  const h = await startPanelHarness(cleanups);
  for (const retired of ["repo:read", "review:read"]) {
    const created = await h.api("POST", "/roles", { name: `角色-${retired}`, permissions: [retired] });
    assert.equal(created.status, 400, `POST ${retired}`);
    assert.deepEqual(await created.json(), { error: "有认不出的权限格" });
  }
  const role = (await (
    await h.api("POST", "/roles", { name: "评审动作", permissions: ["review:rerun"] })
  ).json()) as { id: number };
  const updated = await h.api("PUT", `/roles/${role.id}`, {
    name: "评审动作",
    permissions: ["review:rerun", "review:read"],
  });
  assert.equal(updated.status, 400);
  assert.deepEqual(await updated.json(), { error: "有认不出的权限格" });
  const roles = (await (await h.api("GET", "/roles")).json()) as {
    roles: { id: number; permissions: string[] }[];
  };
  assert.deepEqual(roles.roles.find((item) => item.id === role.id)?.permissions, ["review:rerun"]);
});

test("升级把旧角色里的两个读权限格清掉,其余格不动", async () => {
  const h = await startPanelHarness(cleanups);
  const role = (await (
    await h.api("POST", "/roles", { name: "升级前角色", permissions: ["review:rerun"] })
  ).json()) as { id: number };
  const legacy = new DatabaseSync(h.db.path);
  for (const permission of ["repo:read", "review:read"]) {
    legacy
      .prepare("INSERT INTO panel_role_permission (role_id, permission) VALUES (?, ?)")
      .run(role.id, permission);
  }
  legacy.close();

  const store = openStore(h.db.path);
  const rows = store
    .listPanelRoles()
    .find((item) => item.id === role.id);
  store.close();
  assert.deepEqual(rows?.permissions, ["review:rerun"]);

  const check = new DatabaseSync(h.db.path);
  const remaining = check
    .prepare("SELECT permission FROM panel_role_permission WHERE role_id = ? ORDER BY permission")
    .all(role.id)
    .map((row) => String(row["permission"]));
  check.close();
  assert.deepEqual(remaining, ["review:rerun"]);
});

test("手写权限与仓库分配期望表与面板代码路由集合完全相等", () => {
  const actual = PANEL_ROUTES.map(routeKey).sort();
  const expected = ROUTE_EXPECTATIONS.map(expectedRouteKey).sort();
  assert.equal(new Set(actual).size, actual.length, "代码路由表里有重复声明");
  assert.equal(new Set(expected).size, expected.length, "手写期望表里有重复声明");
  assert.deepEqual(actual, expected);
});

test("allOf 路由必须同时持有模型写与凭据写，系统管理员仍无条件放行", async () => {
  const h = await startPanelHarness(cleanups);
  addPermissionUser(h, "model-writer", ["model:write"]);
  addPermissionUser(h, "credential-writer", ["credential:write"]);
  addPermissionUser(h, "combined-writer", ["model:write", "credential:write"]);
  const modelCookie = await userCookie(h.serverUrl, "model-writer");
  const credentialCookie = await userCookie(h.serverUrl, "credential-writer");
  const combinedCookie = await userCookie(h.serverUrl, "combined-writer");
  const mutations = [
    ["POST", "/model-services/custom/preview"],
    ["POST", "/model-services/custom/commit"],
    ["POST", "/model-services/custom/missing-service/rename"],
    ["DELETE", "/model-services/custom/missing-service"],
  ] as const;
  const invoke = (cookie: string, method: string, path: string): Promise<Response> =>
    fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });

  for (const [method, path] of mutations) {
    assert.equal((await invoke(modelCookie, method, path)).status, 403, `${method} ${path}`);
    assert.equal((await invoke(credentialCookie, method, path)).status, 403, `${method} ${path}`);
    assert.equal(
      (await invoke(combinedCookie, method, path)).status,
      400,
      `${method} ${path} 两格权限应进入业务参数校验`,
    );
    assert.equal((await h.api(method, path, {})).status, 400, `${method} ${path} 管理员应放行`);
  }
});

test("旧模型 API 已从路由表删除，认证后统一返回 404", async () => {
  const h = await startPanelHarness(cleanups);
  const removed = [
    ["GET", "/catalog"],
    ["GET", "/credentials"],
    ["PUT", "/credentials/openai"],
    ["DELETE", "/credentials/openai"],
    ["GET", "/model-rows"],
    ["POST", "/model-rows"],
    ["DELETE", "/model-rows"],
    ["GET", "/custom-providers"],
    ["POST", "/custom-providers"],
    ["DELETE", "/custom-providers/example"],
  ] as const;
  for (const [method, path] of removed) {
    assert.equal(
      (await h.api(method, path, method === "GET" ? undefined : {})).status,
      404,
      `${method} ${path}`,
    );
  }

  const anonymous = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/catalog`);
  assert.equal(anonymous.status, 401, "未知 API 仍应先经过会话门禁");
});

test("目录刷新与补录变更只要求模型写权限", async () => {
  const h = await startPanelHarness(cleanups);
  addPermissionUser(h, "catalog-model-writer", ["model:write"]);
  addPermissionUser(h, "catalog-credential-writer", ["credential:write"]);
  const modelCookie = await userCookie(h.serverUrl, "catalog-model-writer");
  const credentialCookie = await userCookie(h.serverUrl, "catalog-credential-writer");
  const mutations = [
    ["POST", "/model-services/missing/refresh"],
    ["POST", "/model-services/missing/supplements"],
    ["DELETE", "/model-services/missing/supplements"],
  ] as const;
  for (const [method, path] of mutations) {
    const invoke = (cookie: string): Promise<Response> =>
      fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await invoke(credentialCookie)).status, 403, `${method} ${path}`);
    assert.equal(
      (await invoke(modelCookie)).status,
      400,
      `${method} ${path} 模型写权限应进入业务参数校验`,
    );
    assert.equal((await h.api(method, path, {})).status, 400, `${method} ${path} 管理员应放行`);
  }
});

test("模型写或凭据写权限可读取各自包含的模型服务字段", async () => {
  const h = await startPanelHarness(cleanups);
  addPermissionUser(h, "model-service-model-writer", ["model:write"]);
  addPermissionUser(h, "model-service-credential-writer", ["credential:write"]);
  for (const username of ["model-service-model-writer", "model-service-credential-writer"]) {
    const cookie = await userCookie(h.serverUrl, username);
    const response = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/model-services`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200, username);
    const body = (await response.json()) as { services: unknown[]; candidates?: unknown[] };
    assert.ok(Array.isArray(body.services));
    assert.equal("candidates" in body, username === "model-service-model-writer");
  }
});
