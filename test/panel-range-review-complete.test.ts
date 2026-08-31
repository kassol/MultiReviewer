/**
 * 审查完成(issue #158)。
 *
 * 打在面板 API 的真实 HTTP 缝上:内存 Forge 记下容器 PR 有没有被关、两条分支有没有被
 * 删,夹具仓库上那两条分支是不是真的没了,库里落的是不是终态。回填那一档按处置率的口径
 * 断言:已 resolve 的同步过来,其余 unknown 进分母。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Forge, PullRequestRef } from "../src/forge/forge.ts";
import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  PANEL_ADMIN_USERNAME,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "range-complete-test-password";
const HASH = await hashPassword(PASSWORD);

type RangeReview = {
  id: number;
  baseSha: string;
  comparisonSha: string;
  state: string;
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
  completedBy: string | null;
  completedAt: string | null;
  lastForgeFailure: string | null;
};

/** 两条 Finding 落在两个文件上,合并不到一起,回填因此分得出「同步过来」与「仍 unknown」。 */
const reportingReviewers: NonNullable<
  Parameters<typeof startReadyPanelHarness>[1]
>["buildReviewers"] = (plans) =>
  plans.map((plan) =>
    scriptedReviewer(plan.spec.model, [
      {
        file: "src/answer.ts",
        line: 1,
        severity: "P1",
        category: "bug",
        description: "这里会越界",
      },
      {
        file: "src/other.ts",
        line: 1,
        severity: "P2",
        category: "maintainability",
        description: "这个名字看不懂",
      },
    ]),
  );

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

test("审查完成:容器 PR 关闭、两条分支删除,记录进入终态", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);

  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/complete`);
  assert.equal(response.status, 200);
  const completed = ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.equal(completed.state, "completed");
  assert.equal(completed.completedBy, PANEL_ADMIN_USERNAME);
  assert.notEqual(completed.completedAt, null);
  assert.equal(completed.lastForgeFailure, null);

  assert.deepEqual(h.memory.closedPullRequests, [rangeReview.containerPullNumber]);
  assert.deepEqual(h.memory.deletedBranches, [
    rangeReview.headBranch,
    rangeReview.baseBranch,
  ]);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), undefined);
  assert.equal(h.repo.branchSha(rangeReview.baseBranch), undefined);
});

test("完成后推进被拒,不开新一轮", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);
  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  const advance = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
  });
  assert.equal(advance.status, 409);
  assert.equal(h.settled.length, 1);
});

test("完成时全量回填:已 resolve 的同步过来,其余 unknown 进分母,处置与备注仍看得到", async () => {
  const h = await registeredHarness({ buildReviewers: reportingReviewers });
  const rangeReview = await startRangeReview(h);
  assert.equal(h.memory.publishedComments.length, 2);

  // 人在这个阶段里给第一条留了备注并处置过。
  const before = (await (
    await h.api("GET", `/stage-summary?rangeReviewId=${rangeReview.id}`)
  ).json()) as {
    findings: { id: number; commentId: string | null }[];
  };
  const first = before.findings.find(
    (finding) => finding.commentId === h.memory.publishedComments[0]!.id,
  )!;
  assert.equal(
    (await h.api("POST", `/findings/${first.id}/resolve`, { note: "这条是误报" })).status,
    200,
  );

  // Gitea 上只有第一条是 resolved,第二条谁都没碰过。
  h.memory.existingComments.push({ ...h.memory.publishedComments[0]!, resolved: true });

  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);

  const summary = (await (
    await h.api("GET", `/stage-summary?rangeReviewId=${rangeReview.id}`)
  ).json()) as {
    findings: {
      commentId: string | null;
      disposition: string;
      disposedBy: string | null;
      note: string | null;
    }[];
  };
  const findings = summary.findings;
  const resolved = findings.find(
    (finding) => finding.commentId === h.memory.publishedComments[0]!.id,
  )!;
  const untouched = findings.find(
    (finding) => finding.commentId === h.memory.publishedComments[1]!.id,
  )!;
  assert.equal(resolved.disposition, "resolved");
  // 完成后仍看得到是谁处置的与那条备注。
  assert.equal(resolved.disposedBy, PANEL_ADMIN_USERNAME);
  assert.equal(resolved.note, "这条是误报");
  assert.equal(untouched.disposition, "unknown");

  // 容器 PR 到了终态,剩下的 unknown 从此进分母。
  const stats = (await (await h.api("GET", "/stats")).json()) as {
    cells: { resolved: number; unknownClosed: number; unknownOpen: number }[];
  };
  const total = (key: "resolved" | "unknownClosed" | "unknownOpen"): number =>
    stats.cells.reduce((sum, cell) => sum + cell[key], 0);
  assert.equal(total("resolved"), 1);
  assert.equal(total("unknownClosed"), 1);
  assert.equal(total("unknownOpen"), 0);
});

test("完成后同一个 base 再次发起:新记录、新容器 PR,不再提醒", async () => {
  const h = await registeredHarness();
  const first = await startRangeReview(h);
  assert.equal((await h.api("POST", `/range-reviews/${first.id}/complete`)).status, 200);

  // 不带确认标志也照样发起:已完成的那条不占「同一 base 进行中」。
  const second = await startRangeReview(h);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.containerPullNumber, first.containerPullNumber);
  assert.equal(h.memory.createdPullRequests.length, 2);
});

test("Forge 步骤失败:记下失败原因,状态不变,改好之后重试成功", async () => {
  let failing = true;
  const h = await registeredHarness({
    wrapForge: (forge: Forge) => ({
      ...forge,
      closePullRequest: async (ref: PullRequestRef) => {
        if (failing) throw new Error("bot 没有权限关这个 PR");
        return forge.closePullRequest(ref);
      },
    }),
  });
  const rangeReview = await startRangeReview(h);

  const failed = await h.api("POST", `/range-reviews/${rangeReview.id}/complete`);
  assert.equal(failed.status, 502);
  const store = openStore(h.db.path);
  const record = store.getRangeReview(rangeReview.id)!;
  store.close();
  assert.equal(record.state, "in-progress");
  assert.equal(record.completedAt, null);
  assert.match(record.lastForgeFailure!, /没有权限/);
  // 关不掉就不删分支:仓库里不该留下一个开着却没有 head 的 PR。
  assert.deepEqual(h.memory.deletedBranches, []);

  failing = false;
  const retried = await h.api("POST", `/range-reviews/${rangeReview.id}/complete`);
  assert.equal(retried.status, 200);
  const completed = ((await retried.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.equal(completed.state, "completed");
  assert.equal(completed.lastForgeFailure, null);
  assert.deepEqual(h.memory.deletedBranches, [
    rangeReview.headBranch,
    rangeReview.baseBranch,
  ]);
});

test("没有 finding:dispose 的用户标记不了审查完成", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview(h);

  const store = openStore(h.db.path);
  // 有发起权限、没有处置权限:两格互相独立。
  const role = store.createPanelRole({
    name: "只发起的角色",
    permissions: ["review:create"],
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "range-starter",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.close();

  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "range-starter", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const denied = await fetch(
    `${h.serverUrl}/api/range-reviews/${rangeReview.id}/complete`,
    { method: "POST", headers: { cookie } },
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(h.memory.closedPullRequests, []);
  assert.deepEqual(h.memory.deletedBranches, []);

  assert.equal(
    (await h.api("POST", "/range-reviews/9999/complete")).status,
    404,
  );
});
