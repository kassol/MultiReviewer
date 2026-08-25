/**
 * 推进比较项(issue #157)。
 *
 * 打在面板 API 的真实 HTTP 缝上:夹具仓库同时是容器 PR 的远端,推进之后那条 head
 * 分支指向哪个 commit 是可以直接读出来的事实;脚本 Reviewer 让每一轮真的跑完,新一轮
 * 拿到的 Review Range 由它记下来。断言只看外部可观察的行为。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";

import type { Forge } from "../src/forge/forge.ts";
import { hashPassword } from "../src/panel/password.ts";
import type { ReviewRange } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import {
  HARNESS_PR,
  PANEL_ADMIN_USERNAME,
  PANEL_PREFIX,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "range-advance-test-password";
const HASH = await hashPassword(PASSWORD);

type RangeReview = {
  id: number;
  baseSha: string;
  comparisonSha: string;
  state: string;
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
  lastForgeFailure: string | null;
};

type Comparison = { id: number; sha: string; recordedBy: string; recordedAt: string };

/** 每一轮的 Reviewer 都记下自己拿到的 Review Range,推进之后那一轮的范围要能读出来。 */
type Recorded = { ranges: ReviewRange[] };

async function startedHarness(
  recorded: Recorded,
  options: Parameters<typeof startReadyPanelHarness>[1] = {},
): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups, {
    ...options,
    buildReviewers: (plans) =>
      plans.map((plan) => {
        const reviewer = scriptedReviewer(plan.spec.model, []);
        return {
          ...reviewer,
          review: async (range, worktreePath) => {
            recorded.ranges.push(range);
            return reviewer.review(range, worktreePath);
          },
        };
      }),
  });
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  return harness;
}

/** 发起一个范围审查并等第一轮跑完。 */
async function startRangeReview(
  h: PanelHarness,
  base: string,
  comparison: string,
): Promise<RangeReview> {
  const response = await h.api("POST", "/range-reviews", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base,
    comparison,
  });
  assert.equal(response.status, 202);
  const { rangeReview } = (await response.json()) as { rangeReview: RangeReview };
  await h.settledAtLeast(1);
  return rangeReview;
}

test("推进比较项:head 分支指向新 commit,新一轮归属同一范围审查且范围是 base..新比较项", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
  });
  assert.equal(response.status, 202);
  const advanced = ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.equal(advanced.comparisonSha, next);
  assert.equal(advanced.state, "in-progress");

  // 远端上的 head 分支跟着走到了新比较项,base 分支一动不动。
  assert.equal(h.repo.branchSha(rangeReview.headBranch), next);
  assert.equal(h.repo.branchSha(rangeReview.baseBranch), h.repo.baseSha);

  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  store.close();
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((run) => run.headSha),
    [next, h.repo.headSha],
  );
  assert.equal(runs[0]!.pullNumber, rangeReview.containerPullNumber);

  // 新一轮审的是 base..新比较项的全量,不是上一比较项..新比较项。
  const latest = recorded.ranges.at(-1)!;
  assert.equal(latest.baseSha, h.repo.baseSha);
  assert.equal(latest.headSha, next);
});

test("rebase 之后的比较项:是 base 的后代、不是上一比较项的后代,照样推得动", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  // 从 base 另拉一条:它是 base 的后代,与上一个比较项互不相干。
  const rebased = h.repo.branchFrom("rebased", h.repo.baseSha, {
    "src/answer.ts": "export const answer = 4;\n",
  });
  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: rebased,
  });
  assert.equal(response.status, 202);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), rebased);

  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);
  assert.equal(recorded.ranges.at(-1)!.headSha, rebased);
});

test("新比较项不是 base 的后代:拒绝,分支不动,不开新一轮", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  // base 取 feature 尖端,这样 main 上的根 commit 就是它的祖先而非后代。
  const comparison = h.repo.pushToHead({ "src/answer.ts": "export const answer = 5;\n" });
  const rangeReview = await startRangeReview(h, h.repo.headSha, comparison);

  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: h.repo.mergeBaseSha,
  });
  assert.equal(response.status, 400);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), comparison);
  assert.equal(h.settled.length, 1);

  const store = openStore(h.db.path);
  assert.equal(store.getRangeReview(rangeReview.id)!.comparisonSha, comparison);
  store.close();
});

test("推分支失败:记下失败原因,状态仍是进行中,分支与轮次都不动", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  // 远端拒收非快进的推送,而 rebase 之后的比较项对旧的正是非快进。
  execFileSync("git", ["-C", h.repo.dir, "config", "receive.denyNonFastForwards", "true"]);
  const rebased = h.repo.branchFrom("rejected", h.repo.baseSha, {
    "src/answer.ts": "export const answer = 6;\n",
  });
  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: rebased,
  });
  assert.equal(response.status, 502);

  const store = openStore(h.db.path);
  const record = store.getRangeReview(rangeReview.id)!;
  store.close();
  assert.equal(record.state, "in-progress");
  assert.equal(record.comparisonSha, h.repo.headSha);
  assert.notEqual(record.lastForgeFailure, null);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
  assert.equal(h.settled.length, 1);
});

test("发起失败的范围审查不能推进", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded, {
    wrapForge: (forge: Forge) => ({
      ...forge,
      createPullRequest: async () => {
        throw new Error("branch protection 拦住了");
      },
    }),
  });
  const failed = await h.api("POST", "/range-reviews", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(failed.status, 502);
  const { rangeReviewId } = (await failed.json()) as { rangeReviewId: number };

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 7;\n" });
  const response = await h.api("POST", `/range-reviews/${rangeReviewId}/advance`, {
    comparison: next,
  });
  assert.equal(response.status, 409);
  assert.equal(h.settled.length, 0);
  assert.equal((await h.api("POST", "/range-reviews/9999/advance", { comparison: next })).status, 404);
});

test("详情端点给出历次比较项,轮次按 head 对得上", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);
  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 8;\n" });
  assert.equal(
    (await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, { comparison: next })).status,
    202,
  );
  await h.settledAtLeast(2);

  const body = (await (await h.api("GET", `/range-reviews/${rangeReview.id}`)).json()) as {
    rangeReview: RangeReview;
    comparisons: Comparison[];
    runs: { headSha: string }[];
  };
  assert.equal(body.rangeReview.comparisonSha, next);
  assert.deepEqual(
    body.comparisons.map((item) => item.sha),
    [h.repo.headSha, next],
  );
  assert.deepEqual(
    body.comparisons.map((item) => item.recordedBy),
    [PANEL_ADMIN_USERNAME, PANEL_ADMIN_USERNAME],
  );
  // 每个比较项都能在轮次里找到审它的那一轮。
  for (const comparison of body.comparisons) {
    assert.ok(body.runs.some((run) => run.headSha === comparison.sha));
  }
});

test("没有 review:create 的用户推进被拒,分支不动", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: "只读评审角色",
    permissions: ["review:read", "review:rerun"],
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "range-reader",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.close();

  const login = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "range-reader", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 9;\n" });
  const denied = await fetch(
    `${h.serverUrl}/${PANEL_PREFIX}/api/range-reviews/${rangeReview.id}/advance`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ comparison: next }),
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
});
