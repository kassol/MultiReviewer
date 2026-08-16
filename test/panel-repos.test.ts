/**
 * 仓库注册与移除全流程(issue #31)。
 *
 * 三条缝各就各位:面板 API 走真实 HTTP,hook 操作打到假 Gitea HTTP server,评审
 * 记录落在临时 SQLite。投递用「从假 Gitea 读回的 hook secret 与 ?k=」来签——注册
 * 写进 hook 的 Key 与准入认的 Key 必须是同一把,这条链路本身就是被测行为。
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { ReviewerSpec } from "../src/config.ts";
import { openStore } from "../src/review/store.ts";
import { createWebhookServer } from "../src/webhook/server.ts";
import { makeCacheDir, makeDbPath } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  HARNESS_PR as PR,
  PANEL_ADMIN_TOKEN as ADMIN_TOKEN,
  PANEL_BASE_URL as BASE_URL,
  PANEL_PREFIX as PREFIX,
  startPanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const startHarness = (): ReturnType<typeof startPanelHarness> =>
  startPanelHarness(cleanups);

test("注册建好 hook,种子 PR 的投递被受理并跑完审查", async () => {
  const h = await startHarness();

  const register = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });
  assert.equal(register.status, 201);
  assert.deepEqual(await register.json(), {
    repoId: GITEA_REPO.id,
    owner: PR.owner,
    repo: PR.repo,
    generation: 1,
  });

  // hook 由面板建出:URL 带 ?k=1、secret 是 64 位十六进制 Key、窄订阅、显式激活。
  assert.equal(h.gitea.hooks.length, 1);
  const hook = h.gitea.hooks[0]!;
  assert.equal(hook.config.url, `${BASE_URL}/webhook?k=1`);
  assert.match(hook.config.secret!, /^[0-9a-f]{64}$/);
  assert.equal(hook.active, true);
  // 载荷里发的是窄订阅哨兵;读回形态(events)则是展开后的裸 pull_request。
  assert.deepEqual([...hook.requestedEvents].sort(), [
    "pull_request_only",
    "pull_request_sync",
  ]);

  // 用 hook 里的 secret 签投递——面板写的 Key 与准入认的 Key 是同一把。
  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  assert.deepEqual(h.dispatched, [PR]);
});

test("bot 权限不足时注册被拒,响应说明缺什么", async () => {
  const h = await startHarness();
  h.gitea.control.admin = false;

  const register = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });

  assert.equal(register.status, 403);
  const body = (await register.json()) as { error: string };
  assert.match(body.error, /admin/);
  assert.deepEqual(h.gitea.hooks, []);
  assert.deepEqual(await (await h.api("GET", "/repos")).json(), []);
});

test("重复注册回 409", async () => {
  const h = await startHarness();

  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const again = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });

  assert.equal(again.status, 409);
  assert.equal(h.gitea.hooks.length, 1);
});

test("移除删掉 hook 并摘注册表,历史保留,投递从此 401", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);

  // 移除前快照签名材料——移除后 hooks 清空,重放同一份凭据要证明它已失效。
  const hook = h.gitea.hooks[0]!;
  const snapshot = { url: hook.config.url!, secret: hook.config.secret! };

  const removal = await h.api("DELETE", `/repos/${GITEA_REPO.id}`);
  assert.equal(removal.status, 204);
  assert.deepEqual(h.gitea.hooks, []);
  assert.deepEqual(await (await h.api("GET", "/repos")).json(), []);

  // 曾经合法的凭据现在按未注册拒掉。
  assert.equal((await h.deliverViaHook("sha-2", snapshot)).status, 401);

  // 评审记录一行不动:模型选型的历史不因下线而断。
  const sqlite = new DatabaseSync(h.db.path);
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS count FROM review_run WHERE owner = ? AND repo = ?")
      .get(PR.owner, PR.repo) as { count: number };
    assert.equal(Number(row.count), 1);
  } finally {
    sqlite.close();
  }
});

test("hook 删除失败时移除被阻止,注册保持原样", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  h.gitea.control.failDelete = true;

  const removal = await h.api("DELETE", `/repos/${GITEA_REPO.id}`);

  assert.equal(removal.status, 502);
  assert.equal(h.gitea.hooks.length, 1);
  const list = (await (await h.api("GET", "/repos")).json()) as unknown[];
  assert.equal(list.length, 1);
  // 注册未被摘掉,投递照常受理。
  assert.equal((await h.deliverViaHook("sha-3")).status, 200);
});

test("配置了模型覆盖的仓库,Review Run 用覆盖后的组合", async () => {
  const h = await startHarness();
  const override: ReviewerSpec[] = [
    { provider: "test", model: "override-model" },
  ];

  assert.equal(
    (await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo, reviewers: override }))
      .status,
    201,
  );
  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  // 组装只在 Review Run 开始时发生一次,用的是覆盖组合。落库的执行结果归属覆盖后的
  // 模型,不见全局模型。
  assert.deepEqual(h.factoryCalls, [override]);
  const sqlite = new DatabaseSync(h.db.path);
  try {
    const rows = sqlite.prepare("SELECT model FROM reviewer_outcome").all() as {
      model: string;
    }[];
    assert.deepEqual(
      rows.map((row) => row.model),
      ["override-model"],
    );
  } finally {
    sqlite.close();
  }
});

test("模型覆盖可编辑:PUT 全量替换、null 清除,坏覆盖 400", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const override: ReviewerSpec[] = [
    { provider: "test", model: "swapped-model" },
  ];

  assert.equal(
    (await h.api("PUT", `/repos/${GITEA_REPO.id}/reviewers`, { reviewers: override })).status,
    204,
  );
  const rows = (await (await h.api("GET", "/repos")).json()) as { reviewers: unknown }[];
  assert.deepEqual(rows[0]!.reviewers, override);

  // 注册后的下一次投递真实生效。
  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  const sqlite = new DatabaseSync(h.db.path);
  try {
    const models = (
      sqlite.prepare("SELECT model FROM reviewer_outcome").all() as { model: string }[]
    ).map((row) => row.model);
    assert.deepEqual(models, ["swapped-model"]);
  } finally {
    sqlite.close();
  }

  // null 清除覆盖,回到跟随全局。
  assert.equal(
    (await h.api("PUT", `/repos/${GITEA_REPO.id}/reviewers`, { reviewers: null })).status,
    204,
  );
  const cleared = (await (await h.api("GET", "/repos")).json()) as { reviewers: unknown }[];
  assert.equal(cleared[0]!.reviewers, null);

  // 形状坏的覆盖 400,且不落库——覆盖仍是清除后的 null;未注册仓库 404。
  assert.equal(
    (
      await h.api("PUT", `/repos/${GITEA_REPO.id}/reviewers`, {
        reviewers: [{ provider: "x" }],
      })
    ).status,
    400,
  );
  const afterBad = (await (await h.api("GET", "/repos")).json()) as { reviewers: unknown }[];
  assert.equal(afterBad[0]!.reviewers, null);
  assert.equal(
    (await h.api("PUT", "/repos/999/reviewers", { reviewers: null })).status,
    404,
  );
});

test("仓库列表带累计量,按最近活动排序,没跑过的排最后", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);

  // 另外两个仓库直接种进库(SQLite 临时库是既定测试缝):一个活动时间在遥远的未来,
  // 一个从没跑过 Review Run。
  const seed = openStore(h.db.path);
  seed.registerRepo({ repoId: 555, owner: "acme", repo: "gadgets", generation: 1, key: "kb" });
  seed.startRun({
    owner: "acme",
    repo: "gadgets",
    pullNumber: 1,
    headSha: "sha-b",
    startedAt: "9999-01-01T00:00:00.000Z",
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
  });
  seed.registerRepo({ repoId: 556, owner: "acme", repo: "sprockets", generation: 1, key: "kc" });
  seed.close();

  const list = (await (await h.api("GET", "/repos")).json()) as {
    repoId: number;
    runCount: number;
    findingCount: number;
    lastActivity: string | null;
  }[];
  assert.deepEqual(
    list.map((row) => row.repoId),
    [555, GITEA_REPO.id, 556],
  );
  assert.equal(list[1]!.runCount, 1);
  assert.equal(list[1]!.findingCount, 0);
  assert.notEqual(list[1]!.lastActivity, null);
  assert.equal(list[2]!.runCount, 0);
  assert.equal(list[2]!.lastActivity, null);
});

test("建 hook 失败时注册回滚,不留哑仓库", async () => {
  const h = await startHarness();
  h.gitea.control.failCreate = true;

  const register = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });
  assert.equal(register.status, 502);
  assert.deepEqual(await (await h.api("GET", "/repos")).json(), []);

  // 回滚干净:故障排除后同一仓库能直接重新注册,不撞 409。
  h.gitea.control.failCreate = false;
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
});

test("注册入参不合法回 400:body 形状与模型覆盖各一档", async () => {
  const h = await startHarness();

  assert.equal((await h.api("POST", "/repos", { owner: PR.owner })).status, 400);
  const badOverride = await h.api("POST", "/repos", {
    owner: PR.owner,
    repo: PR.repo,
    reviewers: [{ provider: "test" }],
  });
  assert.equal(badOverride.status, 400);
  assert.match(((await badOverride.json()) as { error: string }).error, /model/);
  assert.deepEqual(h.gitea.hooks, []);
});

test("Gitea 上残留本服务的旧 hook 时,代次取最大 +1,旧 hook 不动", async () => {
  const h = await startHarness();
  h.gitea.hooks.push({
    id: 99,
    config: { url: `${BASE_URL}/webhook?k=7`, content_type: "json", secret: "stale" },
    events: ["pull_request", "pull_request_sync"],
    requestedEvents: [],
    active: true,
  });

  const register = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });

  assert.equal(register.status, 201);
  assert.equal(((await register.json()) as { generation: number }).generation, 8);
  assert.deepEqual(
    h.gitea.hooks.map((hook) => hook.config.url),
    [`${BASE_URL}/webhook?k=7`, `${BASE_URL}/webhook?k=8`],
  );
});

test("仓库改名后移除仍按现名删掉 hook,不留孤儿", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  assert.equal(h.gitea.hooks.length, 1);

  // 改名 + 转移 owner:id 不变,旧路径 404。按旧名寻址会把「改名」误判成「已删」。
  h.gitea.rename("neworg", "renamed");

  const removal = await h.api("DELETE", `/repos/${GITEA_REPO.id}`);
  assert.equal(removal.status, 204);
  assert.deepEqual(h.gitea.hooks, []);
});

test("没配 Gitea 时注册与移除回 500,说明配置缺口", async () => {
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
    baseUrl: BASE_URL,
    panelDist: `${cache.dir}/no-dist`,
    onDelivery: () => {},
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const login = await fetch(`http://127.0.0.1:${port}/${PREFIX}/api/session`, {
    method: "POST",
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const register = await fetch(`http://127.0.0.1:${port}/${PREFIX}/api/repos`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ owner: "a", repo: "b" }),
  });
  assert.equal(register.status, 500);
  assert.match(((await register.json()) as { error: string }).error, /Gitea/);
});
