/**
 * 增量评审(issue #157)。
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
  /** 选定当前比较项时用的分支或 Tag(issue #234);旧记录是 null。 */
  comparisonSource: { kind: "branch" | "tag"; name: string } | null;
};

/** 每一轮的 Reviewer 都记下自己拿到的 Review Range,推进之后那一轮的范围要能读出来。 */
type Recorded = { ranges: ReviewRange[] };

/** 只复核那一轮要有未处置历史才开得起来:要它的用例让每个 Reviewer 都报一条。 */
const REPORTED_FINDINGS: Parameters<typeof scriptedReviewer>[1] = [
  { file: "src/answer.ts", line: 1, severity: "P1", category: "bug", description: "这里会越界" },
];

async function startedHarness(
  recorded: Recorded,
  options: Parameters<typeof startReadyPanelHarness>[1] = {},
  findings: Parameters<typeof scriptedReviewer>[1] = [],
): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups, {
    ...options,
    buildReviewers: (plans) =>
      plans.map((plan) => {
        const reviewer = scriptedReviewer(plan.spec.model, findings);
        return {
          ...reviewer,
          review: async (input) => {
            recorded.ranges.push(input.range);
            return reviewer.review(input);
          },
        };
      }),
  });
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(harness.db.path, GITEA_REPO.id);
  return harness;
}

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

/** 发起一个范围审查并等第一轮跑完。 */
async function startRangeReview(
  h: PanelHarness,
  base: string,
  comparison: string,
): Promise<RangeReview> {
  const response = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
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

test("增量评审:head 分支指向新 commit,新一轮归属同一范围审查且范围是 base..新比较项", async () => {
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
    title: "范围审查标题",
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

  const body = (await (await h.api("GET", `/stages/range:${rangeReview.id}`)).json()) as {
    rangeReview: RangeReview;
    groups: { sha: string; recordedBy: string | null; runs: { headSha: string }[] }[];
  };
  assert.equal(body.rangeReview.comparisonSha, next);
  // 详情的分组新的在前,比较项因此是推进顺序的倒序。
  assert.deepEqual(
    body.groups.map((group) => group.sha),
    [next, h.repo.headSha],
  );
  assert.deepEqual(
    body.groups.map((group) => group.recordedBy),
    [PANEL_ADMIN_USERNAME, PANEL_ADMIN_USERNAME],
  );
  // 每个比较项都能在轮次里找到审它的那一轮。
  for (const group of body.groups) {
    assert.ok(group.runs.some((run) => run.headSha === group.sha));
  }
});

test("没有 review:advance 的用户推进被拒,分支不动", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

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

  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "range-reader", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 9;\n" });
  const denied = await fetch(
    `${h.serverUrl}/api/range-reviews/${rangeReview.id}/advance`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ comparison: next }),
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
});

test("持有旧格 review:create 但没有 review:advance:推进被拒,分支不动", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const store = openStore(h.db.path);
  // 拆格之后(ADR 0023)发起权限不再蕴含推进权限:两格互相独立。
  const role = store.createPanelRole({
    name: "只发起的角色",
    permissions: ["review:create"],
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "range-creator",
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
    body: JSON.stringify({ username: "range-creator", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 10;\n" });
  const denied = await fetch(
    `${h.serverUrl}/api/range-reviews/${rangeReview.id}/advance`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ comparison: next }),
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
});

test("新比较项就是当前比较项:拒绝,比较项不动,不开新一轮(issue #234)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: h.repo.headSha,
  });
  assert.equal(response.status, 400);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
  assert.equal(h.settled.length, 1);

  const store = openStore(h.db.path);
  assert.equal(store.getRangeReview(rangeReview.id)!.comparisonSha, h.repo.headSha);
  store.close();
});

test("推进带来源:阶段详情的 rangeReview 回得出这一格(issue #234)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);
  assert.equal(rangeReview.comparisonSource, null);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 11;\n" });
  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
    comparisonSource: { kind: "branch", name: "feature" },
  });
  assert.equal(response.status, 202);
  const advanced = ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.deepEqual(advanced.comparisonSource, { kind: "branch", name: "feature" });

  const detail = (await (await h.api("GET", `/stages/range:${rangeReview.id}`)).json()) as {
    rangeReview: RangeReview;
  };
  assert.deepEqual(detail.rangeReview.comparisonSource, { kind: "branch", name: "feature" });
});

test("发起带来源、推进不带来源:阶段详情的 rangeReview.comparisonSource 清成 null(issue #234)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const created = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
    comparisonSource: { kind: "branch", name: "feature" },
  });
  assert.equal(created.status, 202);
  const rangeReview = ((await created.json()) as { rangeReview: RangeReview }).rangeReview;
  await h.settledAtLeast(1);
  assert.deepEqual(rangeReview.comparisonSource, { kind: "branch", name: "feature" });

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 12;\n" });
  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
  });
  assert.equal(response.status, 202);
  const advanced = ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.equal(advanced.comparisonSource, null);

  const detail = (await (await h.api("GET", `/stages/range:${rangeReview.id}`)).json()) as {
    rangeReview: RangeReview;
  };
  assert.equal(detail.rangeReview.comparisonSource, null);
});

test("增量评审默认完整审查,`full` 同档,非法取值 400(issue #250)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  // 不带 mode:推进的常态是作者推了新代码,要审新代码。
  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 13;\n" });
  assert.equal(
    (await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, { comparison: next })).status,
    202,
  );
  await h.settledAtLeast(2);

  const later = h.repo.pushToHead({ "src/answer.ts": "export const answer = 14;\n" });
  assert.equal(
    (
      await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
        comparison: later,
        mode: "full",
      })
    ).status,
    202,
  );
  await h.settledAtLeast(3);

  // 认不出的取值当场拒:悄悄按默认跑会开出一轮不是人要的审查。
  const rejected = h.repo.pushToHead({ "src/answer.ts": "export const answer = 15;\n" });
  assert.equal(
    (
      await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
        comparison: rejected,
        mode: "only",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
        comparison: rejected,
        mode: 7,
      })
    ).status,
    400,
  );
  assert.equal(h.settled.length, 3);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), later);

  const store = openStore(h.db.path);
  assert.equal(store.getRangeReview(rangeReview.id)!.comparisonSha, later);
  store.close();
  assert.deepEqual(modes(h, rangeReview.id), ["full", "full", "full"]);
});

test("没有未处置历史的阶段:只复核推进 409,比较项与 head 分支都不动(issue #250)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 16;\n" });
  const denied = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
    mode: "verdict-only",
  });
  assert.equal(denied.status, 409);
  assert.match(((await denied.json()) as { error: string }).error, /未处置/);
  // 闸在一切副作用之前:比较项、head 分支与轮次数都停在推进之前那一刻。
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
  assert.equal(h.settled.length, 1);
  const store = openStore(h.db.path);
  assert.equal(store.getRangeReview(rangeReview.id)!.comparisonSha, h.repo.headSha);
  store.close();

  // 勾回完整审查:同一个比较项推得动。
  assert.equal(
    (
      await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
        comparison: next,
        mode: "full",
      })
    ).status,
    202,
  );
  await h.settledAtLeast(2);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), next);
  assert.deepEqual(modes(h, rangeReview.id), ["full", "full"]);
});

test("有未处置历史:只复核推进 202,head 跟着走,范围仍是 base..新比较项(issue #250)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded, {}, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 17;\n" });
  const response = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
    mode: "verdict-only",
  });
  assert.equal(response.status, 202);
  const advanced = ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.equal(advanced.comparisonSha, next);
  // 复核在作者最新的代码上做,head 分支照样跟到新比较项。
  assert.equal(h.repo.branchSha(rangeReview.headBranch), next);

  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  store.close();
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.pullNumber, rangeReview.containerPullNumber);
  assert.deepEqual(modes(h, rangeReview.id), ["full", "verdict-only"]);

  // 模式变了不换范围:复核口径与完整审查一致。
  const latest = recorded.ranges.at(-1)!;
  assert.equal(latest.baseSha, h.repo.baseSha);
  assert.equal(latest.headSha, next);
});

test("未处置历史全落在这次没改到的文件上:只复核推进 409,不先答已触发(issue #250)", async () => {
  const recorded: Recorded = { ranges: [] };
  const h = await startedHarness(recorded, {}, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  // 从 base 另拉一条只改 src/other.ts 的旁支:base..它的变更文件里没有 src/answer.ts,
  // 而未处置历史全在那个文件上,编排层过滤完一个文件都不剩。
  const hotfix = h.repo.branchFrom("hotfix", h.repo.baseSha, {
    "src/other.ts": "export const other = 3;\n",
  });
  const denied = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: hotfix,
    mode: "verdict-only",
  });
  assert.equal(denied.status, 409);
  assert.match(((await denied.json()) as { error: string }).error, /未处置/);
  assert.equal(h.settled.length, 1);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
  assert.deepEqual(modes(h, rangeReview.id), ["full"]);
});
