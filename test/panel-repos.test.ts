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
import { confirmEmptyRuleSet, makeCacheDir, makeDbPath } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  HARNESS_PR as PR,
  PANEL_ADMIN_PASSWORD as ADMIN_PASSWORD,
  PANEL_ADMIN_USERNAME as ADMIN_USERNAME,
  PANEL_BASE_URL as BASE_URL,
  PANEL_CREDENTIAL_MASTER_KEY,
  type PanelHarness,
  seedAvailableModelService,
  startPanelHarness,
  startReadyPanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const startHarness = (): ReturnType<typeof startReadyPanelHarness> =>
  startReadyPanelHarness(cleanups);

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
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);

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
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
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
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
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
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model", "override-model"]);
  const override: ReviewerSpec[] = [
    { provider: "test", model: "override-model" },
  ];

  assert.equal(
    (await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo, reviewers: override }))
      .status,
    201,
  );
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
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

/**
 * 仓库配置整块保存(issue #302)。模型覆盖与最低报告等级在一个端点里一次写完,带整块
 * 版本号;两项都是可空即跟随全局的全量替换。
 */
type RepoSettingsRow = {
  repoId: number;
  reviewers: unknown;
  minReportSeverity: unknown;
  globalMinReportSeverity: unknown;
  settingsVersion: number;
};

const repoSettingsRow = async (h: PanelHarness): Promise<Omit<RepoSettingsRow, "repoId">> => {
  const rows = (await (await h.api("GET", "/repos")).json()) as RepoSettingsRow[];
  const row = rows.find((entry) => entry.repoId === GITEA_REPO.id)!;
  return {
    reviewers: row.reviewers,
    minReportSeverity: row.minReportSeverity,
    globalMinReportSeverity: row.globalMinReportSeverity,
    settingsVersion: row.settingsVersion,
  };
};

test("仓库配置一次写两项:版本加一、null 即跟随全局、坏取值 400 一项都不写", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model", "swapped-model"]);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);

  // 刚注册即两项都跟随全局,整块版本号从 0 起。
  assert.deepEqual(await repoSettingsRow(h), {
    reviewers: null,
    minReportSeverity: null,
    globalMinReportSeverity: "P2",
    settingsVersion: 0,
  });

  const put = (body: unknown): Promise<Response> =>
    h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, body);
  const override: ReviewerSpec[] = [{ provider: "test", model: "swapped-model" }];

  const saved = await put({ reviewers: override, minReportSeverity: "P1", expectedVersion: 0 });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.deepEqual(savedBody, { settingsVersion: 1 });
  assert.deepEqual(await repoSettingsRow(h), {
    reviewers: override,
    minReportSeverity: "P1",
    globalMinReportSeverity: "P2",
    settingsVersion: 1,
  });

  // 注册后的下一次投递真实生效:用的是覆盖后的模型。
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

  // 坏取值整次拒绝:版本与两项原样不动。
  for (
    const body of [
      { reviewers: [{ provider: "x" }], minReportSeverity: null, expectedVersion: 1 },
      { reviewers: null, minReportSeverity: "P3", expectedVersion: 1 },
      { reviewers: null, minReportSeverity: null, expectedVersion: "1" },
      { reviewers: null, expectedVersion: 1 },
      { minReportSeverity: null, expectedVersion: 1 },
    ]
  ) {
    const rejected = await put(body);
    assert.equal(rejected.status, 400, `${JSON.stringify(body)} 应该被拒`);
  }
  assert.deepEqual(await repoSettingsRow(h), {
    reviewers: override,
    minReportSeverity: "P1",
    globalMinReportSeverity: "P2",
    settingsVersion: 1,
  });

  // 两项一起清成 null,回到跟随全局。
  const cleared = await put({ reviewers: null, minReportSeverity: null, expectedVersion: 1 });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await repoSettingsRow(h), {
    reviewers: null,
    minReportSeverity: null,
    globalMinReportSeverity: "P2",
    settingsVersion: 2,
  });

  // 未注册仓库 404。
  assert.equal(
    (
      await h.api("PUT", "/repos/999/settings", {
        reviewers: null,
        minReportSeverity: null,
        expectedVersion: 0,
      })
    ).status,
    404,
  );
});

test("仓库配置的期望版本过期即 409,响应带当前值", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model", "swapped-model"]);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const override: ReviewerSpec[] = [{ provider: "test", model: "swapped-model" }];
  const put = (body: unknown): Promise<Response> =>
    h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, body);

  assert.equal(
    (await put({ reviewers: override, minReportSeverity: "P0", expectedVersion: 0 })).status,
    200,
  );

  // 另一个人拿着旧版本号再保存:整次拒绝,库里仍是先写成的那一份。
  const stale = await put({ reviewers: null, minReportSeverity: "P2", expectedVersion: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "这个仓库的配置已经被其他人修改，请核对后再保存",
    current: { reviewers: override, minReportSeverity: "P0", settingsVersion: 1 },
  });
  assert.deepEqual(await repoSettingsRow(h), {
    reviewers: override,
    minReportSeverity: "P0",
    globalMinReportSeverity: "P2",
    settingsVersion: 1,
  });
});

test("模型覆盖与最低报告等级的旧端点回没有这个端点", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model"]);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);

  for (
    const [path, body] of [
      [`/repos/${GITEA_REPO.id}/reviewers`, { reviewers: null }],
      [`/repos/${GITEA_REPO.id}/min-report-severity`, { minReportSeverity: null }],
    ] as const
  ) {
    const response = await h.api("PUT", path, body);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "没有这个端点" });
  }
});

test("旧库的仓库读回整块版本号 0,两项覆盖原值不变", async () => {
  const h = await startPanelHarness(cleanups);
  seedAvailableModelService(h, "test", ["global-model", "swapped-model"]);
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const override: ReviewerSpec[] = [{ provider: "test", model: "swapped-model" }];
  assert.equal(
    (
      await h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, {
        reviewers: override,
        minReportSeverity: "P1",
        expectedVersion: 0,
      })
    ).status,
    200,
  );

  // 升级前的形状:`repo` 表没有整块版本号这一列。去掉它,下一次 openStore 即走补列那一路。
  const sqlite = new DatabaseSync(h.db.path);
  try {
    sqlite.exec("ALTER TABLE repo DROP COLUMN settings_version");
  } finally {
    sqlite.close();
  }

  assert.deepEqual(await repoSettingsRow(h), {
    reviewers: override,
    minReportSeverity: "P1",
    globalMinReportSeverity: "P2",
    settingsVersion: 0,
  });
});

test("仓库覆盖只接受可用候选，失效保存项仍能移除或清为跟随全局", async () => {
  const h = await startHarness();
  seedAvailableModelService(h, "repo-healthy", ["keep"]);
  seedAvailableModelService(h, "repo-broken", ["saved"]);

  const sqlite = new DatabaseSync(h.db.path);
  try {
    sqlite.prepare(
      `UPDATE model_service_credential
          SET state = 'pending-reverification', verified_at = NULL,
              validation_model = NULL, verification_source = NULL
        WHERE provider = ?`,
    ).run("repo-broken");
  } finally {
    sqlite.close();
  }

  const invalidRegister = await h.api("POST", "/repos", {
    owner: PR.owner,
    repo: PR.repo,
    reviewers: [{ provider: "vanished-repo-service", model: "missing" }],
  });
  assert.equal(invalidRegister.status, 400);
  assert.match(await invalidRegister.text(), /模型来源消失/);
  assert.deepEqual(h.gitea.hooks, [], "候选校验应先于注册与 hook 副作用");

  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const selected = [
    { provider: "repo-healthy", model: "keep" },
    { provider: "repo-broken", model: "saved" },
    { provider: "vanished-repo-service", model: "missing" },
  ];
  const seed = openStore(h.db.path);
  seed.setRepoReviewers(GITEA_REPO.id, JSON.stringify(selected));
  seed.close();

  const serviceState = () => {
    const store = openStore(h.db.path);
    try {
      return {
        services: store.listModelServices(),
        supplements: store.listModelSupplements(),
      };
    } finally {
      store.close();
    }
  };
  const before = serviceState();

  const blocked = await h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, {
    reviewers: selected,
    minReportSeverity: null,
    expectedVersion: 0,
  });
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /模型凭据不可用.*模型来源消失/);

  const saved = await h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, {
    reviewers: [selected[0]],
    minReportSeverity: null,
    expectedVersion: 0,
  });
  assert.equal(saved.status, 200);
  const rowsAfterSave = (await (await h.api("GET", "/repos")).json()) as {
    repoId: number;
    reviewers: unknown;
  }[];
  assert.deepEqual(rowsAfterSave.find((repo) => repo.repoId === GITEA_REPO.id)?.reviewers, [
    { provider: "repo-healthy", model: "keep" },
  ]);
  assert.deepEqual(serviceState(), before, "覆盖写入不得创建、删除或改写模型服务与来源");

  const reset = openStore(h.db.path);
  reset.setRepoReviewers(GITEA_REPO.id, JSON.stringify(selected));
  reset.close();
  assert.equal(
    (
      await h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, {
        reviewers: null,
        minReportSeverity: null,
        expectedVersion: 1,
      })
    ).status,
    200,
  );
  const rowsAfterClear = (await (await h.api("GET", "/repos")).json()) as {
    repoId: number;
    reviewers: unknown;
  }[];
  assert.equal(rowsAfterClear.find((repo) => repo.repoId === GITEA_REPO.id)?.reviewers, null);
  assert.deepEqual(serviceState(), before);
});

test("仓库列表带累计量,按最近活动排序,没跑过的排最后", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
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
    reviewerPins: [],
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
  seedAvailableModelService({ db }, "test", ["global-model"]);
  const seed = openStore(db.path);
  assert.equal(seed.putGlobalSettings({
    reviewersJson: JSON.stringify([{ provider: "test", model: "global-model" }]),
    maxChangedLinesPerBatch: null,
  }), true);
  seed.close();
  const server = createWebhookServer({
    forges: {},
    buildReviewers: () => [],
    cacheDir: cache.dir,
    dbPath: db.path,
    bootstrapSecret: "panel-repos-bootstrap",
    baseUrl: BASE_URL,
    credentialMasterKey: PANEL_CREDENTIAL_MASTER_KEY,
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
  const registered = await fetch(`http://127.0.0.1:${port}/api/users/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bootstrap: "panel-repos-bootstrap",
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  assert.equal(registered.status, 201);
  const login = await fetch(`http://127.0.0.1:${port}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const register = await fetch(`http://127.0.0.1:${port}/api/repos`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ owner: "a", repo: "b" }),
  });
  assert.equal(register.status, 500);
  assert.match(((await register.json()) as { error: string }).error, /Gitea/);
});
