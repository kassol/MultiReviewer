/**
 * 每日增量的开关(issue #313,spec #310)。
 *
 * 打在面板 API 的真实 HTTP 缝上:开、关、改分支之后阶段详情读回什么是外部可观察的事实;
 * 「只改状态」由「轮次数与容器 PR 的 head 分支都不动」两条断出来——定时检查是下一票的事,
 * 这一票的开关不许自己推进。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startRangeReview as startRangeReviewRow,
  startReadyPanelHarness,
  userCookie,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";

const PASSWORD = "range-daily-increment-test-password";
const HASH = await hashPassword(PASSWORD);

type RangeReview = {
  id: number;
  state: string;
  headBranch: string;
  comparisonSource: { kind: "branch" | "tag"; name: string } | null;
  dailyIncrementEnabled: boolean;
  dailyIncrementBranch: string | null;
  dailyIncrementEnabledAt: string | null;
  scheduledCheckTime: string;
  scheduledCheckMode: string;
};

async function startedHarness(): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness({ registerRepo: true });
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(harness.db.path, GITEA_REPO.id);
  return harness;
}

/** 发起一个范围审查并等第一轮跑完。 */
function startRangeReview(h: PanelHarness): Promise<RangeReview> {
  return startRangeReviewRow<RangeReview>(h, {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
}

/** 阶段详情里那份范围审查:面板读的就是它。 */
async function detailRangeReview(h: PanelHarness, id: number): Promise<RangeReview> {
  const response = await h.api("GET", `/stages/range:${id}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
}

test("每日增量:开启、改分支、关闭各自读回正确", async () => {
  const h = await startedHarness();
  const rangeReview = await startRangeReview(h);
  const before = await detailRangeReview(h, rangeReview.id);
  assert.equal(before.dailyIncrementEnabled, false);
  assert.equal(before.dailyIncrementBranch, null);
  assert.equal(before.dailyIncrementEnabledAt, null);

  const enabled = await h.api("PUT", `/range-reviews/${rangeReview.id}/daily-increment`, {
    enabled: true,
    branch: "feature",
  });
  assert.equal(enabled.status, 200);
  const opened = await detailRangeReview(h, rangeReview.id);
  assert.equal(opened.dailyIncrementEnabled, true);
  assert.equal(opened.dailyIncrementBranch, "feature");
  assert.notEqual(opened.dailyIncrementEnabledAt, null);

  // 改分支:开着的时候换一条跟的分支,开启时刻跟着刷新(定时检查按它判「今天」)。
  const moved = await h.api("PUT", `/range-reviews/${rangeReview.id}/daily-increment`, {
    enabled: true,
    branch: "main",
  });
  assert.equal(moved.status, 200);
  const changed = await detailRangeReview(h, rangeReview.id);
  assert.equal(changed.dailyIncrementEnabled, true);
  assert.equal(changed.dailyIncrementBranch, "main");

  const closed = await h.api("PUT", `/range-reviews/${rangeReview.id}/daily-increment`, {
    enabled: false,
  });
  assert.equal(closed.status, 200);
  const off = await detailRangeReview(h, rangeReview.id);
  assert.equal(off.dailyIncrementEnabled, false);
  assert.equal(off.dailyIncrementBranch, null);
  assert.equal(off.dailyIncrementEnabledAt, null);
});

test("检查时刻与检查模式:缺省取 00:00 与只复核,带上即读回,改任一项刷新开启时刻", async () => {
  let clock = Date.parse("2026-09-11T01:00:00.000Z");
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => clock });
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  const rangeReview = await startRangeReview(h);
  const path = `/range-reviews/${rangeReview.id}/daily-increment`;

  assert.equal((await h.api("PUT", path, { enabled: true, branch: "feature" })).status, 200);
  const defaults = await detailRangeReview(h, rangeReview.id);
  assert.equal(defaults.scheduledCheckTime, "00:00");
  assert.equal(defaults.scheduledCheckMode, "verdict-only");

  clock += 60_000;
  assert.equal(
    (await h.api("PUT", path, { enabled: true, branch: "feature", time: "09:30" })).status,
    200,
  );
  const timed = await detailRangeReview(h, rangeReview.id);
  assert.equal(timed.scheduledCheckTime, "09:30");
  assert.equal(timed.scheduledCheckMode, "verdict-only");
  assert.notEqual(timed.dailyIncrementEnabledAt, defaults.dailyIncrementEnabledAt);

  clock += 60_000;
  assert.equal(
    (await h.api("PUT", path, { enabled: true, branch: "feature", time: "09:30", mode: "full" }))
      .status,
    200,
  );
  const full = await detailRangeReview(h, rangeReview.id);
  assert.equal(full.scheduledCheckTime, "09:30");
  assert.equal(full.scheduledCheckMode, "full");
  assert.notEqual(full.dailyIncrementEnabledAt, timed.dailyIncrementEnabledAt);
});

test("检查时刻或检查模式不合法:400,状态不动", async () => {
  const h = await startedHarness();
  const rangeReview = await startRangeReview(h);
  const path = `/range-reviews/${rangeReview.id}/daily-increment`;

  for (const invalid of [
    { time: "24:00" },
    { time: "9:30" },
    { time: "09:60" },
    { time: 930 },
    { mode: "quick" },
  ]) {
    const denied = await h.api("PUT", path, { enabled: true, branch: "feature", ...invalid });
    assert.equal(denied.status, 400, JSON.stringify(invalid));
  }
  const after = await detailRangeReview(h, rangeReview.id);
  assert.equal(after.dailyIncrementEnabled, false);
  assert.equal(after.scheduledCheckTime, "00:00");
  assert.equal(after.scheduledCheckMode, "verdict-only");
});

test("开启每日增量不推进:轮次数与容器 PR 的 head 分支都不动", async () => {
  const h = await startedHarness();
  const rangeReview = await startRangeReview(h);
  const headBefore = h.repo.branchSha(rangeReview.headBranch);

  // 分支上已经有新提交,开关仍旧只改状态:推进要等定时检查。
  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  assert.equal(
    (await h.api("PUT", `/range-reviews/${rangeReview.id}/daily-increment`, {
      enabled: true,
      branch: "feature",
    })).status,
    200,
  );

  assert.equal(h.settled.length, 1);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), headBefore);
  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  store.close();
  assert.equal(runs.length, 1);
});

test("分支不在仓库的分支列表里:开启被拒,状态不动", async () => {
  const h = await startedHarness();
  const rangeReview = await startRangeReview(h);

  const denied = await h.api("PUT", `/range-reviews/${rangeReview.id}/daily-increment`, {
    enabled: true,
    branch: "no-such-branch",
  });
  assert.equal(denied.status, 400);
  assert.equal((await detailRangeReview(h, rangeReview.id)).dailyIncrementEnabled, false);
});

test("审查完成之后不在进行中:开启被拒", async () => {
  const h = await startedHarness();
  const rangeReview = await startRangeReview(h);
  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);

  const denied = await h.api("PUT", `/range-reviews/${rangeReview.id}/daily-increment`, {
    enabled: true,
    branch: "feature",
  });
  assert.equal(denied.status, 409);
});

test("没有 review:advance 的用户设不了每日增量", async () => {
  const h = await startedHarness();
  const rangeReview = await startRangeReview(h);

  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: "只读评审角色",
    permissions: ["review:rerun"],
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
  const cookie = await userCookie(h.serverUrl, "range-reader", PASSWORD);

  const denied = await fetch(
    `${h.serverUrl}/api/range-reviews/${rangeReview.id}/daily-increment`,
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, branch: "feature" }),
    },
  );
  assert.equal(denied.status, 403);
  assert.equal((await detailRangeReview(h, rangeReview.id)).dailyIncrementEnabled, false);
});
