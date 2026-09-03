/**
 * 本轮指令(CONTEXT.md,issue #225):发起重审时附的一次性要求。
 *
 * 打在面板 API 的真实 HTTP 缝上(先例 `panel-range-review-rerun`):四个发起入口各带一次
 * 指令,库里那一轮记下它,下一轮不带。断言只看外部可观察的行为。
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

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "run-directive-test-password";
const HASH = await hashPassword(PASSWORD);

const DIRECTIVE = "这一轮只报 P0,重点看并发";

async function registeredHarness(): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(harness.db.path, GITEA_REPO.id);
  return harness;
}

/** 库里每一轮的本轮指令,按开跑先后。 */
function directives(h: PanelHarness, rangeReviewId?: number): (string | null)[] {
  const store = openStore(h.db.path);
  try {
    return store
      .listRuns({ limit: 30, ...(rangeReviewId === undefined ? {} : { rangeReviewId }) })
      .map((run) => run.directive)
      .reverse();
  } finally {
    store.close();
  }
}

type RangeReview = { id: number; comparisonSha: string; containerPullNumber: number | null };

/** 发起范围审查的合法请求体。坏指令那几条只换 `directive` 一格。 */
function launchBody(h: PanelHarness): Record<string, unknown> {
  return {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  };
}

async function startRangeReview(h: PanelHarness, directive?: string): Promise<RangeReview> {
  const response = await h.api("POST", "/range-reviews", {
    ...launchBody(h),
    ...(directive === undefined ? {} : { directive }),
  });
  assert.equal(response.status, 202);
  const { rangeReview } = (await response.json()) as { rangeReview: RangeReview };
  await h.settledAtLeast(1);
  return rangeReview;
}

test("PR 重跑附本轮指令:随这一轮存库,轮次详情读得到,下一轮不带", async () => {
  const h = await registeredHarness();
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);

  assert.equal(
    (
      await h.api("POST", "/rerun", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
        directive: DIRECTIVE,
      })
    ).status,
    202,
  );
  await h.settledAtLeast(2);

  // 不带指令再跑一轮:本轮指令只作用于附上它的那一轮。
  assert.equal(
    (
      await h.api("POST", "/rerun", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
      })
    ).status,
    202,
  );
  await h.settledAtLeast(3);

  // 投递触发的第一轮没有指令,附了指令的第二轮有,第三轮又没有。
  assert.deepEqual(directives(h), [null, DIRECTIVE, null]);

  // 轮次详情看得到:发起人要能回答「那一轮是按什么要求跑的」。时间流是倒序的。
  const runs = (await (await h.api("GET", "/runs")).json()) as {
    runs: { id: number; directive: string | null }[];
  };
  assert.deepEqual(
    [...runs.runs].sort((a, b) => a.id - b.id).map((run) => run.directive),
    [null, DIRECTIVE, null],
  );
});

test("范围审查重跑与增量评审都能附本轮指令,各自只作用于那一轮", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);

  assert.equal(
    (await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id, directive: DIRECTIVE }))
      .status,
    202,
  );
  await h.settledAtLeast(2);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  assert.equal(
    (
      await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
        comparison: next,
        directive: "推进这一轮补看回归",
      })
    ).status,
    202,
  );
  await h.settledAtLeast(3);

  assert.deepEqual(directives(h, rangeReview.id), [null, DIRECTIVE, "推进这一轮补看回归"]);
});

test("空白指令与不给指令同一档,超长与非字符串一律 400", async () => {
  const h = await registeredHarness();
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);

  const target = {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  };
  // 静默截断会让人以为整句都进去了,而模型只看到半句。
  assert.equal(
    (await h.api("POST", "/rerun", { ...target, directive: "很".repeat(501) })).status,
    400,
  );
  assert.equal((await h.api("POST", "/rerun", { ...target, directive: 7 })).status, 400);
  assert.equal(h.settled.length, 1);

  assert.equal((await h.api("POST", "/rerun", { ...target, directive: "  \n " })).status, 202);
  await h.settledAtLeast(2);
  assert.deepEqual(directives(h), [null, null]);
});

test("发起范围审查附本轮指令:随发起触发的首轮记下它,下一轮不带", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h, DIRECTIVE);

  // 同一个阶段再跑一轮,这次不附指令。
  assert.equal(
    (await h.api("POST", "/rerun", { rangeReviewId: rangeReview.id })).status,
    202,
  );
  await h.settledAtLeast(2);

  assert.deepEqual(directives(h, rangeReview.id), [DIRECTIVE, null]);
});

test("发起范围审查的指令超长或非字符串一律 400,一轮都不开跑", async () => {
  const h = await registeredHarness();

  assert.equal(
    (await h.api("POST", "/range-reviews", { ...launchBody(h), directive: "很".repeat(501) }))
      .status,
    400,
  );
  assert.equal(
    (await h.api("POST", "/range-reviews", { ...launchBody(h), directive: 7 })).status,
    400,
  );
  // 指令在碰 Forge 之前就判掉:一条分支、一个容器 PR、一轮 Review Run 都不该留下。
  assert.deepEqual(h.memory.createdBranches, []);
  assert.deepEqual(h.memory.createdPullRequests, []);
  assert.equal(h.settled.length, 0);

  // 全空白与不给同一档,发起照常走完。
  assert.equal(
    (await h.api("POST", "/range-reviews", { ...launchBody(h), directive: "  \n " })).status,
    202,
  );
  await h.settledAtLeast(1);
  assert.deepEqual(directives(h), [null]);
});

test("没有 review:rerun 的用户发不出带指令的重审", async () => {
  const h = await registeredHarness();
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);

  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: "只读角色",
    permissions: ["review:create"],
    createdAt: "2026-08-31T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "directive-denied",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.setPanelUserAssignment("directive-denied", [GITEA_REPO.id]);
  store.close();

  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "directive-denied", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const denied = await fetch(`${h.serverUrl}/api/rerun`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      pullNumber: HARNESS_PR.number,
      directive: DIRECTIVE,
    }),
  });
  // 指令不新增权限格,它随重审那一格走(issue #225)。
  assert.equal(denied.status, 403);
  assert.equal(h.settled.length, 1);
  assert.deepEqual(directives(h), [null]);
});
