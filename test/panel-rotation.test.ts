/**
 * key 轮转与核对(issue #32,ADR 0007)。
 *
 * 轮转不落状态,每一步的断点都从「库里的 key 列表 + Gitea 上的代次」推断;测试用
 * 假 Gitea 的故障开关制造断点,再重入验证单调推进。核对只读。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GITEA_REPO, HARNESS_PR as PR, startPanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const startHarness = (): ReturnType<typeof startPanelHarness> =>
  startPanelHarness(cleanups);

/** 当前第一条 hook 的签名材料快照,hook 被删后用来证明旧凭据已失效。 */
function snapshotHook(h: Awaited<ReturnType<typeof startHarness>>): {
  url: string;
  secret: string;
} {
  const hook = h.gitea.hooks[0]!;
  return { url: hook.config.url!, secret: hook.config.secret! };
}

test("正常轮转:旧代次投递 401,新代次受理", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const old = snapshotHook(h);

  const rotate = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(rotate.status, 200);
  assert.deepEqual(await rotate.json(), { repoId: GITEA_REPO.id, generation: 2 });

  // 先建后删的结果:只剩新代次一条 hook,secret 换成了新 Key。
  assert.deepEqual(
    h.gitea.hooks.map((hook) => hook.config.url),
    [`${old.url.split("?")[0]}?k=2`],
  );
  assert.notEqual(h.gitea.hooks[0]!.config.secret, old.secret);

  assert.equal((await h.deliverViaHook("sha-old", old)).status, 401);
  assert.equal((await h.deliverViaHook("sha-new")).status, 200);
});

test("建新成功、删旧失败后:轮转中投递不中断,再触发一次即收尾", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const old = snapshotHook(h);

  h.gitea.control.failDelete = true;
  const broken = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(broken.status, 502);
  assert.match(((await broken.json()) as { error: string }).error, /再点一次/);

  // 断点状态:新旧两条 hook 并存,两把 Key 都在库里——旧 hook 的投递仍被受理,
  // 轮转不需要挑时间窗口。
  assert.equal(h.gitea.hooks.length, 2);
  assert.equal((await h.deliverViaHook("sha-during", old)).status, 200);

  // 再触发一次:先推到底(收掉上一轮)再开新一轮,终态只有一条更高代次的 hook。
  h.gitea.control.failDelete = false;
  const retry = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { generation: number }).generation, 3);
  assert.deepEqual(
    h.gitea.hooks.map((hook) => hook.config.url),
    [`${old.url.split("?")[0]}?k=3`],
  );
  assert.equal((await h.deliverViaHook("sha-stale", old)).status, 401);
  assert.equal((await h.deliverViaHook("sha-final")).status, 200);
});

test("建新失败的断点:旧代次照常投递,再触发一次推进到底", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const old = snapshotHook(h);

  // 第一个断点:新 Key 已落库,新 hook 还没建成。
  h.gitea.control.failCreate = true;
  assert.equal((await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`)).status, 502);
  assert.equal(h.gitea.hooks.length, 1);
  assert.equal((await h.deliverViaHook("sha-during", old)).status, 200);

  // 重入:先补建上一轮的 hook 收尾,再开新一轮,终态只剩更高代次。
  h.gitea.control.failCreate = false;
  const retry = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { generation: number }).generation, 3);
  assert.deepEqual(
    h.gitea.hooks.map((hook) => hook.config.url),
    [`${old.url.split("?")[0]}?k=3`],
  );
  assert.equal((await h.deliverViaHook("sha-final")).status, 200);
});

test("仓库在 Gitea 上已删除时,轮转直接指向移除而不是原地循环", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  h.gitea.control.deleted = true;

  const rotate = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(rotate.status, 409);
  assert.match(((await rotate.json()) as { error: string }).error, /移除仓库/);

  // 出路真实可走:移除照常放行(仓库没了,hook 也没了)。
  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}`)).status, 204);
});

test("库回滚场景:Gitea 侧代次更高时,一次轮转自愈", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  const base = h.gitea.hooks[0]!.config.url!.split("?")[0]!;

  // 模拟回滚:Gitea 上残留一条更高代次的 hook,它的 Key 已随库回滚丢失。
  h.gitea.hooks.push({
    id: 77,
    config: { url: `${base}?k=5`, content_type: "json", secret: "lost-key" },
    events: ["pull_request", "pull_request_sync"],
    requestedEvents: [],
    active: true,
  });
  assert.equal(
    (await h.deliverViaHook("sha-lost", { url: `${base}?k=5`, secret: "lost-key" })).status,
    401,
  );

  const rotate = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(rotate.status, 200);
  // 新代次取两侧最大 +1(max(1, 5) + 1),残留 hook 一并清掉。
  assert.equal(((await rotate.json()) as { generation: number }).generation, 6);
  assert.deepEqual(
    h.gitea.hooks.map((hook) => hook.config.url),
    [`${base}?k=6`],
  );
  assert.equal((await h.deliverViaHook("sha-healed")).status, 200);
});

test("核对返回的差异与 Gitea 实际状态一致,核对本身无副作用", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);

  // 一致时零差异。
  const clean = (await (await h.api("GET", `/repos/${GITEA_REPO.id}/hooks`)).json()) as {
    expectedGenerations: number[];
    hooks: { generation: number }[];
    issues: { message: string; action: string }[];
  };
  assert.deepEqual(clean.expectedGenerations, [1]);
  assert.deepEqual(clean.issues, []);

  // 有人在 Gitea UI 里动过:订阅改掉、又多出一条废弃代次的 hook。
  h.gitea.hooks[0]!.events = ["push"];
  const base = h.gitea.hooks[0]!.config.url!.split("?")[0]!;
  h.gitea.hooks.push({
    id: 88,
    config: { url: `${base}?k=9`, content_type: "json", secret: "stale" },
    events: ["pull_request", "pull_request_sync"],
    requestedEvents: [],
    active: true,
  });
  const before = JSON.stringify(h.gitea.hooks);

  const check = (await (await h.api("GET", `/repos/${GITEA_REPO.id}/hooks`)).json()) as {
    hooks: { generation: number }[];
    issues: { message: string; action: string }[];
  };
  const messages = check.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /代次 1 的 hook 订阅、激活或 content type 被改过/);
  assert.match(messages, /已废弃代次 9/);
  assert.deepEqual(
    check.hooks.map((hook) => hook.generation),
    [1, 9],
  );

  // 只展示差异,不自动修:核对前后 Gitea 的状态一字不差。
  assert.equal(JSON.stringify(h.gitea.hooks), before);
});

test("核对认得出「hook 丢了」与「轮转未收尾」", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);

  // 制造未收尾:删旧失败的轮转留下两把 Key。再把两条 hook 都手动删光,模拟人清场。
  h.gitea.control.failDelete = true;
  assert.equal((await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`)).status, 502);
  h.gitea.hooks.length = 0;

  const check = (await (await h.api("GET", `/repos/${GITEA_REPO.id}/hooks`)).json()) as {
    expectedGenerations: number[];
    issues: { message: string }[];
  };
  assert.deepEqual(check.expectedGenerations, [1, 2]);
  const messages = check.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /上一轮轮转未收尾/);
  assert.match(messages, /代次 1 的 hook 不在 Gitea 上/);
  assert.match(messages, /代次 2 的 hook 不在 Gitea 上/);
});

test("仓库改名后:轮转按现名寻址,核对报出名字漂移", async () => {
  const h = await startHarness();
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);
  h.gitea.rename("neworg", "renamed");

  const check = (await (await h.api("GET", `/repos/${GITEA_REPO.id}/hooks`)).json()) as {
    issues: { message: string }[];
  };
  assert.match(
    check.issues.map((issue) => issue.message).join("\n"),
    /已改名或转移.*neworg\/renamed/,
  );

  // 轮转照常完成:hook 操作全落在现名下。
  const rotate = await h.api("POST", `/repos/${GITEA_REPO.id}/rotate`);
  assert.equal(rotate.status, 200);
  assert.equal(h.gitea.hooks.length, 1);
  assert.match(h.gitea.hooks[0]!.config.url!, /\?k=2$/);
});
