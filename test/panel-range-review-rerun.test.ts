/**
 * 范围审查阶段的重跑(issue #176)。
 *
 * 打在面板 API 的真实 HTTP 缝上:重跑之后库里那个范围审查名下多了一轮、head 仍是当前
 * 比较项,容器 PR 的分支一动不动;审查完成之后重跑与推进都被拒。断言只看外部可观察的
 * 行为,不碰 store 内部查询以外的东西。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "range-rerun-test-password";
const HASH = await hashPassword(PASSWORD);

type RangeReview = {
  id: number;
  comparisonSha: string;
  state: string;
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
};

async function registeredHarness(
  options: Parameters<typeof startReadyPanelHarness>[1] = {},
): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups, options);
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(harness.db.path, GITEA_REPO.id);
  return harness;
}

/** 发起一个范围审查并等第一轮跑完。 */
async function startRangeReview(h: PanelHarness): Promise<RangeReview> {
  const response = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(response.status, 202);
  const { rangeReview } = (await response.json()) as { rangeReview: RangeReview };
  await h.settledAtLeast(1);
  return rangeReview;
}

/** 登录一个自定义权限的用户,拿它的会话 cookie。仓库一并分给他:可见才能操作。 */
async function userCookie(
  h: PanelHarness,
  username: string,
  permissions: string[],
): Promise<string> {
  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: `${username}-角色`,
    permissions: permissions as Parameters<typeof store.createPanelRole>[0]["permissions"],
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  store.createPanelUser({
    username,
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-25T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.setPanelUserAssignment(username, [GITEA_REPO.id]);
  store.close();

  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  return login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

/** 阶段详情里那条范围审查记录的状态。 */
async function stageRangeReviewState(h: PanelHarness, id: number): Promise<string> {
  const response = await h.api("GET", `/stages/${encodeURIComponent(`range:${id}`)}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { rangeReview: RangeReview };
  return body.rangeReview.state;
}

test("范围审查重跑:在当前比较项上多跑一轮,归入同一个阶段,分支不动", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);

  // 这条用例看的是重跑本身,与模式无关;完整审查那一档不依赖阶段有没有历史。
  const response = await h.api("POST", "/rerun", {
    rangeReviewId: rangeReview.id,
    mode: "full",
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    rangeReviewId: rangeReview.id,
    headSha: h.repo.headSha,
  });

  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  const record = store.getRangeReview(rangeReview.id)!;
  store.close();
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((run) => run.headSha),
    [h.repo.headSha, h.repo.headSha],
  );
  // 两轮都挂在同一个容器 PR 上,阶段没有被拆成两条。
  assert.deepEqual(
    runs.map((run) => run.pullNumber),
    [rangeReview.containerPullNumber, rangeReview.containerPullNumber],
  );
  // 重跑不动比较项,也不动 Forge 上的两条分支。
  assert.equal(record.comparisonSha, h.repo.headSha);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
  assert.equal(h.repo.branchSha(rangeReview.baseBranch), h.repo.baseSha);
});

test("审查完成之后:重跑与推进都被拒,不开新一轮", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);
  // 详情页按记录里的状态决定这三个按钮能不能点,阶段详情因此带上这条记录。
  assert.equal(await stageRangeReviewState(h, rangeReview.id), "in-progress");
  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);
  assert.equal(await stageRangeReviewState(h, rangeReview.id), "completed");

  const rerun = await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id });
  assert.equal(rerun.status, 409);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  const advance = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
  });
  assert.equal(advance.status, 409);
  assert.equal(h.settled.length, 1);
});

test("重跑入参:范围审查不存在 404,rangeReviewId 不是正整数 400", async () => {
  const h = await registeredHarness();
  assert.equal((await h.api("POST", "/rerun", { rangeReviewId: 9999 })).status, 404);
  assert.equal((await h.api("POST", "/rerun", { rangeReviewId: 0 })).status, 400);
  assert.equal((await h.api("POST", "/rerun", { rangeReviewId: "3" })).status, 400);
  assert.equal(h.settled.length, 0);
});

test("范围审查重跑要 review:rerun:有它的用户跑得动,没有的被拒", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);

  // 只能推进、不能重跑的角色:重跑独立于 review:create。
  const advancerCookie = await userCookie(h, "range-advancer", ["review:create"]);
  const denied = await fetch(`${h.serverUrl}/api/rerun`, {
    method: "POST",
    headers: { cookie: advancerCookie, "content-type": "application/json" },
    body: JSON.stringify({ rangeReviewId: rangeReview.id }),
  });
  assert.equal(denied.status, 403);
  assert.equal(h.settled.length, 1);

  const rerunnerCookie = await userCookie(h, "range-rerunner", ["review:rerun"]);
  const allowed = await fetch(`${h.serverUrl}/api/rerun`, {
    method: "POST",
    headers: { cookie: rerunnerCookie, "content-type": "application/json" },
    body: JSON.stringify({ rangeReviewId: rangeReview.id, mode: "full" }),
  });
  assert.equal(allowed.status, 202);
  await h.settledAtLeast(2);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  store.close();
  assert.equal(runs.length, 2);
  // 触发人记的是点重跑的那个账号。
  assert.equal(runs[0]!.triggeredBy, "range-rerunner");
});

/** 报一条 Finding 的 Reviewer:只复核那一轮要有未处置历史才开得起来。 */
const reportingReviewers: NonNullable<
  NonNullable<Parameters<typeof startReadyPanelHarness>[1]>["buildReviewers"]
> = (plans) =>
  plans.map((plan) =>
    scriptedReviewer(plan.spec.model, [
      { file: "src/answer.ts", line: 1, severity: "P1", category: "bug", description: "这里会越界" },
    ]),
  );

/** 库里每一轮的模式,按开跑先后。 */
function modes(h: PanelHarness, rangeReviewId: number): string[] {
  const store = openStore(h.db.path);
  try {
    return store
      .listRuns({ limit: 30, rangeReviewId })
      .map((run) => run.mode)
      .reverse();
  } finally {
    store.close();
  }
}

test("范围审查重跑默认只复核,`full` 才是完整审查,非法取值 400", async () => {
  const h = await registeredHarness({ buildReviewers: reportingReviewers });
  const rangeReview = await startRangeReview(h);

  // 不带 mode:清历史是重跑的常态,整段范围再审一遍不是。
  assert.equal((await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id })).status, 202);
  await h.settledAtLeast(2);
  assert.equal(
    (await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id, mode: "full" })).status,
    202,
  );
  await h.settledAtLeast(3);

  // 认不出的取值当场拒:悄悄按默认跑会开出一轮不是人要的审查。
  assert.equal(
    (await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id, mode: "only" })).status,
    400,
  );
  assert.equal(
    (await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id, mode: 7 })).status,
    400,
  );
  assert.equal(h.settled.length, 3);

  // 发起触发的首轮永远是完整审查。
  assert.deepEqual(modes(h, rangeReview.id), ["full", "verdict-only", "full"]);
});

test("未处置历史全落在本轮没改的文件上:只复核重跑同样 409,不先答已触发", async () => {
  // 首轮在 src/answer.ts 报出一条;随后 Forge 上这个 PR 的变更文件里不再有它——编排层
  // 过滤完一个文件都不剩,那该在接口上就拒掉,不该先回 202 再在后台空跑一轮。
  let narrowed = false;
  const h = await registeredHarness({
    buildReviewers: reportingReviewers,
    wrapForge: (forge) => ({
      ...forge,
      listChangedFiles: async (ref) =>
        (await forge.listChangedFiles(ref)).filter(
          (file) => !narrowed || file.path !== "src/answer.ts",
        ),
    }),
  });
  const rangeReview = await startRangeReview(h);
  narrowed = true;

  const denied = await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id });
  assert.equal(denied.status, 409);
  assert.match(((await denied.json()) as { error: string }).error, /未处置/);
  assert.equal(h.settled.length, 1);
  assert.deepEqual(modes(h, rangeReview.id), ["full"]);
});

test("没有未处置历史的阶段:只复核重跑 409 并说明,一轮不开", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);

  const denied = await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id });
  assert.equal(denied.status, 409);
  assert.match(((await denied.json()) as { error: string }).error, /未处置/);
  assert.equal(h.settled.length, 1);

  // 完整审查这一档不受影响:它本来就不依赖历史。
  assert.equal(
    (await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id, mode: "full" })).status,
    202,
  );
  await h.settledAtLeast(2);
  assert.deepEqual(modes(h, rangeReview.id), ["full", "full"]);
});
