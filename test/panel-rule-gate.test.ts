/**
 * 新仓库门禁分代(issue #206):新注册的仓库在完成知识确认之前不执行 Review Run。
 *
 * 打在面板 API 的真实 HTTP 缝上:手动重跑与发起范围审查在未确认时回 409 并说明差什么,
 * 知识确认之后同一个入口即放行。webhook 投递那一面在 `webhook.test.ts`(那里看得到
 * 投递日志),存量迁移与「注册不再落版本」在 `panel-rules.test.ts` 的临时库上。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** 门禁那句话。三个发起入口共用同一份措辞。 */
const UNCONFIRMED = "这个仓库还没确认知识集,先在知识集里探索并确认规则,再发起审查";

/** 刚注册完的仓库:知识集未确认,门禁生效。 */
async function freshlyRegistered(): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  await harness.worktreesPreparedAtLeast(1);
  return harness;
}

/** 走面板自己的知识确认:草案加一条,整组确认,生成第一个知识集版本。 */
async function confirmRules(h: PanelHarness): Promise<void> {
  const path = `/repos/${GITEA_REPO.id}/rule-draft`;
  assert.equal(
    (await h.api("POST", path, {
      scope: "",
      statement: "公开函数要有类型标注",
    })).status,
    201,
  );
  const confirmed = await h.api("POST", `${path}/confirm`);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { version: 1 });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

test("知识集未确认时手动重跑回 409,知识确认后同一个入口放行", async () => {
  const h = await freshlyRegistered();

  const blocked = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(blocked.status, 409);
  assert.equal(await errorOf(blocked), UNCONFIRMED);

  // 挡在开跑之前:一行 Review Run 都没落。
  const store = openStore(h.db.path);
  assert.equal(store.listRuns({ limit: 30 }).length, 0);
  store.close();

  await confirmRules(h);

  const allowed = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(allowed.status, 202);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
});

test("知识集未确认时发起范围审查回 409,一条分支都不建", async () => {
  const h = await freshlyRegistered();

  const blocked = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(blocked.status, 409);
  assert.equal(await errorOf(blocked), UNCONFIRMED);
  assert.deepEqual(h.memory.createdBranches, []);
  assert.deepEqual(h.memory.createdPullRequests, []);

  await confirmRules(h);

  const allowed = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(allowed.status, 202);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
});

test("零条目的知识确认:未确认的仓库确认空知识集之后,同一个入口即放行", async () => {
  const h = await freshlyRegistered();

  // 草案一条都不加就确认:空知识集是合法状态(issue #200),门禁看的是有没有版本。
  const confirmed = await h.api("POST", `/repos/${GITEA_REPO.id}/rule-draft/confirm`);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { version: 1 });

  const store = openStore(h.db.path);
  const ruleSet = store.getRuleSet(GITEA_REPO.id)!;
  store.close();
  assert.equal(ruleSet.version, 1);
  assert.deepEqual(ruleSet.rules, []);

  const allowed = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(allowed.status, 202);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  // 确认过的仓库没有第二份可确认的草案。
  assert.equal((await h.api("POST", `/repos/${GITEA_REPO.id}/rule-draft/confirm`)).status, 409);
});
