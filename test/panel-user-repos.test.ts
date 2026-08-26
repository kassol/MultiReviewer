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
import type { PanelPermission } from "../src/panel/permissions.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  PANEL_ADMIN_USERNAME,
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

/** 播种一轮跑完的 Review Run,附一条已处置的 Finding:处置率矩阵要有格子可数。 */
function seedRun(
  h: PanelHarness,
  meta: {
    owner: string;
    repo: string;
    pullNumber: number;
    startedAt: string;
    /** 报出这条 Finding 的模型。两个仓库各给一个,参与条数才看得出按分配收窄。 */
    model?: string;
    /** 这一轮的 token 用量。省略即这一轮没落用量,不进 `usage`。 */
    tokens?: number;
  },
): number {
  const model = meta.model ?? "model-a";
  const store = openStore(h.db.path);
  const runId = store.startRun({
    owner: meta.owner,
    repo: meta.repo,
    pullNumber: meta.pullNumber,
    headSha: `sha-${meta.owner}-${meta.repo}-${meta.pullNumber}`,
    startedAt: meta.startedAt,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: [
      {
        model,
        findingCount: 1,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
        ...(meta.tokens === undefined
          ? {}
          : {
              usage: {
                inputTokens: meta.tokens,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: meta.tokens,
              },
            }),
      },
    ],
    findings: [
      {
        file: "src/a.ts",
        line: 5,
        title: "示例",
        severity: "P1",
        category: "bug",
        description: "示例",
        attributions: [{ model, severity: "P1", category: "bug", description: "示例" }],
        groupIndex: 0,
        disposition: "resolved",
        placement: "inline",
        commentId: `comment-${meta.owner}-${meta.repo}-${meta.pullNumber}`,
        fingerprint: `fp-${meta.repo}-${meta.pullNumber}`,
      },
    ],
    verdicts: [],
  });
  store.close();
  return runId;
}

/** 播种一个范围审查:推进、审查完成与重跑三个动作的目标。容器 PR 不建,不碰 Forge。 */
function seedRangeReview(h: PanelHarness, repoId: number, owner: string, repo: string): number {
  const store = openStore(h.db.path);
  try {
    const id = store.createRangeReview({
      repoId,
      owner,
      repo,
      title: "一段范围",
      baseSha: "a".repeat(40),
      comparisonSha: "b".repeat(40),
      createdBy: PANEL_ADMIN_USERNAME,
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    return id;
  } finally {
    store.close();
  }
}

/** 建一个带角色与仓库分配的普通用户并登录。 */
async function scopedUser(
  h: PanelHarness,
  username: string,
  repoIds: readonly number[],
  permissions: readonly PanelPermission[],
): Promise<string> {
  const store = openStore(h.db.path);
  try {
    const role = store.createPanelRole({
      name: `role-${username}`,
      permissions,
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    store.createPanelUser({
      username,
      displayName: null,
      passwordHash: await hashPassword(PASSWORD),
      mustChangePassword: false,
      createdAt: "2026-08-20T00:00:00.000Z",
      isSystemAdmin: false,
      roleId: role.id,
    });
    store.setPanelUserAssignment(username, repoIds);
  } finally {
    store.close();
  }
  return userCookie(h, username);
}

/** 全部面板权限格。可见范围由分配决定,这些用例要的是「权限不挡路」。 */
const ALL_PERMISSIONS: readonly PanelPermission[] = [
  "repo:write",
  "review:rerun",
  "review:create",
  "finding:dispose",
];

function get(h: PanelHarness, cookie: string, path: string): Promise<Response> {
  return fetch(`${h.serverUrl}/${PREFIX}/api${path}`, { headers: { cookie } });
}

function post(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/${PREFIX}/api${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 两个仓库各一轮 Review Run,普通用户只分到 alpha。 */
async function twoRepoHarness(): Promise<{
  h: PanelHarness;
  alpha: number;
  beta: number;
  cookie: string;
}> {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const beta = seedRepo(h, 102, "acme", "beta");
  seedRun(h, { owner: "acme", repo: "alpha", pullNumber: 1, startedAt: "2026-08-10T00:00:00.000Z" });
  seedRun(h, { owner: "acme", repo: "beta", pullNumber: 2, startedAt: "2026-08-11T00:00:00.000Z" });
  const cookie = await scopedUser(h, "reviewer", [alpha], ALL_PERMISSIONS);
  return { h, alpha, beta, cookie };
}

const STATS_WINDOW = "?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z";

test("普通用户的仓库、阶段与处置率只含分配到的仓库", async () => {
  const { h, cookie } = await twoRepoHarness();

  const repos = (await (await get(h, cookie, "/repos")).json()) as { repo: string }[];
  assert.deepEqual(repos.map((row) => row.repo), ["alpha"]);

  const stages = (await (await get(h, cookie, "/stages")).json()) as {
    stages: { repo: string }[];
  };
  assert.deepEqual(stages.stages.map((row) => row.repo), ["alpha"]);

  const stats = (await (await get(h, cookie, `/stats${STATS_WINDOW}`)).json()) as {
    cells: { repo: string }[];
  };
  assert.deepEqual(stats.cells.map((cell) => cell.repo), ["alpha"]);
});

test("模型参与条数与 token 用量与处置率矩阵同一口径,都只算分配到的仓库", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  seedRepo(h, 102, "acme", "beta");
  seedRun(h, {
    owner: "acme",
    repo: "alpha",
    pullNumber: 1,
    startedAt: "2026-08-10T00:00:00.000Z",
    model: "model-alpha",
    tokens: 100,
  });
  seedRun(h, {
    owner: "acme",
    repo: "beta",
    pullNumber: 2,
    startedAt: "2026-08-11T00:00:00.000Z",
    model: "model-beta",
    tokens: 7,
  });
  const cookie = await scopedUser(h, "reviewer", [alpha], ALL_PERMISSIONS);
  type Stats = {
    models: { model: string; findings: number }[];
    usage: { runs: number; totalTokens: number } | null;
  };

  const mine = (await (await get(h, cookie, `/stats${STATS_WINDOW}`)).json()) as Stats;
  assert.deepEqual(mine.models, [{ model: "model-alpha", findings: 1 }]);
  assert.deepEqual(mine.usage, {
    runs: 1,
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 100,
  });

  const all = (await (await h.api("GET", `/stats${STATS_WINDOW}`)).json()) as Stats;
  assert.deepEqual(all.models.map((row) => row.model), ["model-alpha", "model-beta"]);
  assert.equal(all.usage?.runs, 2);
  assert.equal(all.usage?.totalTokens, 107);
});

test("时间流的收窄在 SQL 里做:分配外的一整页不会把自己那一行挤掉", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  seedRepo(h, 102, "acme", "beta");
  // 自己的那一轮最旧,分配外的仓库在它上面压满一整页(时间流一页 30 行)。收窄要是回到
  // JS 再做,这一页会滤成空的,而 nextBefore 照样按满页给出去。
  seedRun(h, { owner: "acme", repo: "alpha", pullNumber: 1, startedAt: "2026-08-10T00:00:00.000Z" });
  for (let index = 1; index <= 31; index += 1) {
    seedRun(h, {
      owner: "acme",
      repo: "beta",
      pullNumber: index,
      startedAt: "2026-08-11T00:00:00.000Z",
    });
  }
  const cookie = await scopedUser(h, "reviewer", [alpha], ALL_PERMISSIONS);

  const body = (await (await get(h, cookie, "/runs")).json()) as {
    runs: { repo: string }[];
    nextBefore: number | null;
  };
  assert.deepEqual(body.runs.map((run) => run.repo), ["alpha"]);
  assert.equal(body.nextBefore, null);
});

test("受限账号对未注册的 owner/repo 与分配外同形 404,系统管理员才走注册表那一档", async () => {
  const { h, cookie } = await twoRepoHarness();
  const ghost = "owner=acme&repo=ghost";
  const cases: [string, string, unknown?][] = [
    ["POST", "/rerun", { owner: "acme", repo: "ghost", pullNumber: 1 }],
    [
      "POST",
      "/range-reviews",
      { owner: "acme", repo: "ghost", title: "t", base: "a".repeat(40), comparison: "b".repeat(40) },
    ],
    ["GET", `/range-reviews/prefill?${ghost}`],
    ["GET", `/repo-branches?${ghost}`],
    ["GET", `/repo-commits?${ghost}&branch=main`],
    ["GET", `/stage-summary?${ghost}&pullNumber=1`],
  ];
  for (const [method, path, body] of cases) {
    const response = await post(h, cookie, method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    // 措辞与分配外那一句逐字相同:仓库没注册这件事不该从 404 的措辞里漏出去。
    assert.deepEqual(await response.json(), { error: "没有这个仓库" }, `${method} ${path}`);
  }

  // 系统管理员看得到整张注册表,「先注册」这一档只对他成立。
  const rerun = await h.api("POST", "/rerun", { owner: "acme", repo: "ghost", pullNumber: 1 });
  assert.equal(rerun.status, 409);
  assert.deepEqual(await rerun.json(), { error: "仓库不在注册表里,先注册再重跑" });
});

test("系统管理员不受分配限制,三份列表都看得到两个仓库", async () => {
  const { h } = await twoRepoHarness();

  const repos = (await (await h.api("GET", "/repos")).json()) as { repo: string }[];
  assert.deepEqual(repos.map((row) => row.repo).sort(), ["alpha", "beta"]);

  const stages = (await (await h.api("GET", "/stages")).json()) as { stages: { repo: string }[] };
  assert.deepEqual(stages.stages.map((row) => row.repo).sort(), ["alpha", "beta"]);

  const stats = (await (await h.api("GET", `/stats${STATS_WINDOW}`)).json()) as {
    cells: { repo: string }[];
  };
  assert.deepEqual(stats.cells.map((cell) => cell.repo).sort(), ["alpha", "beta"]);
});

test("直达分配外的阶段页、汇总、轨迹与 diff 一律 404", async () => {
  const { h, cookie } = await twoRepoHarness();
  const store = openStore(h.db.path);
  const mine = store.listRuns({ limit: 30, owner: "acme", repo: "alpha" })[0]!.id;
  const theirs = store.listRuns({ limit: 30, owner: "acme", repo: "beta" })[0]!.id;
  store.close();

  const stage = (name: string): string => `/stages/${encodeURIComponent(`pr:acme/${name}`)}`;
  const summary = (name: string): string =>
    `/stage-summary?owner=acme&repo=${name}&pullNumber=${name === "alpha" ? 1 : 2}`;

  for (const path of [
    stage("beta/2"),
    summary("beta"),
    `/runs/${theirs}`,
    `/runs/${theirs}/trace`,
    `/runs/${theirs}/diff`,
  ]) {
    assert.equal((await get(h, cookie, path)).status, 404, path);
  }
  for (const path of [stage("alpha/1"), summary("alpha"), `/runs/${mine}`, `/runs/${mine}/trace`]) {
    assert.equal((await get(h, cookie, path)).status, 200, path);
  }
});

test("分配外的处置、重跑、发起、推进、完成、配置与移除一律 404", async () => {
  const { h, alpha, beta, cookie } = await twoRepoHarness();
  const sqlite = new DatabaseSync(h.db.path, { readOnly: true });
  const finding = Number(
    sqlite
      .prepare(
        `SELECT f.id AS id FROM finding f JOIN review_run r ON r.id = f.run_id
          WHERE r.repo = ? ORDER BY f.id LIMIT 1`,
      )
      .get("beta")!["id"],
  );
  sqlite.close();
  const theirRange = seedRangeReview(h, beta, "acme", "beta");
  const mineRange = seedRangeReview(h, alpha, "acme", "alpha");

  const cases: [string, string, unknown?][] = [
    ["POST", `/findings/${finding}/resolve`, {}],
    ["POST", "/rerun", { owner: "acme", repo: "beta", pullNumber: 2 }],
    ["POST", "/rerun", { rangeReviewId: theirRange }],
    [
      "POST",
      "/range-reviews",
      { owner: "acme", repo: "beta", title: "t", base: "a".repeat(40), comparison: "b".repeat(40) },
    ],
    ["POST", `/range-reviews/${theirRange}/advance`, { comparison: "c".repeat(40) }],
    ["POST", `/range-reviews/${theirRange}/complete`],
    ["GET", "/range-reviews/prefill?owner=acme&repo=beta"],
    ["GET", "/repo-branches?owner=acme&repo=beta"],
    ["GET", "/repo-commits?owner=acme&repo=beta&branch=main"],
    ["PUT", `/repos/${beta}/reviewers`, { reviewers: null }],
    ["POST", `/repos/${beta}/rotate`],
    ["POST", `/repos/${beta}/worktree`],
    ["GET", `/repos/${beta}/hooks`],
    ["DELETE", `/repos/${beta}`],
  ];
  for (const [method, path, body] of cases) {
    const response = await post(h, cookie, method, path, body);
    assert.equal(response.status, 404, `${method} ${path} → ${await response.text()}`);
  }

  // 分配内的同一批动作照常走到 handler 自己的判断,不被过滤层挡掉。
  assert.notEqual((await post(h, cookie, "PUT", `/repos/${alpha}/reviewers`, { reviewers: null })).status, 404);
  assert.notEqual((await get(h, cookie, `/range-reviews/prefill?owner=acme&repo=alpha`)).status, 404);
  // 分配内的这条没有容器 PR,重跑走到 handler 自己的 409,而不是被过滤层判成不存在。
  assert.equal((await post(h, cookie, "POST", "/rerun", { rangeReviewId: mineRange })).status, 409);
});

test("非系统管理员注册仓库后它立刻在自己的列表里,管理员注册不写分配行", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const cookie = await scopedUser(h, "maintainer", [], ALL_PERMISSIONS);

  assert.equal(
    (await post(h, cookie, "POST", "/repos", { owner: PR.owner, repo: PR.repo })).status,
    201,
  );
  const repos = (await (await get(h, cookie, "/repos")).json()) as { repoId: number }[];
  assert.deepEqual(repos.map((row) => row.repoId), [GITEA_REPO.id]);
  assert.deepEqual(await assignedRepoIds(h, "maintainer"), [GITEA_REPO.id]);

  // 管理员注册的仓库不挂在任何人名下。
  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}`)).status, 204);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  assert.deepEqual(await assignedRepoIds(h, "maintainer"), []);
});

test("webhook 投递不经过仓库分配", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const cookie = await scopedUser(h, "maintainer", [], ALL_PERMISSIONS);
  assert.equal(
    (await post(h, cookie, "POST", "/repos", { owner: PR.owner, repo: PR.repo })).status,
    201,
  );
  // 谁都没分到这个仓库也照样投递:webhook 路径不经过过滤层。
  const store = openStore(h.db.path);
  store.setPanelUserAssignment("maintainer", []);
  store.close();

  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
});
