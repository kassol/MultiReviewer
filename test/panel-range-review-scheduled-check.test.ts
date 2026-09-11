/**
 * 定时检查(issue #314,spec #310)。
 *
 * 打在面板 HTTP 夹具的真实缝上:tick 间隔拨到毫秒级,`now` 拨「今天」,断言只看外部
 * 可观察的事实——容器 PR 的 head 分支指向哪个 commit、这个阶段有几轮、那一轮的来源与
 * 模式、范围审查读回的最近一次定时检查结果。不断言内部调用。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createDrain } from "../src/drain.ts";
import type { ReviewRange } from "../src/review/finding.ts";
import { openStore, type ScheduledCheckResult } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  PANEL_ADMIN_USERNAME,
  startRangeReview as startRangeReviewRow,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

/** tick 间隔。够快让用例不必等,又不至于每秒开上百次库。 */
const TICK_MS = 25;

/** 拨「今天」的两个日子。整日相差,本地日期分量因此一定翻页。 */
const DAY_MS = 24 * 60 * 60 * 1000;

type RangeReview = {
  id: number;
  baseSha: string;
  comparisonSha: string;
  state: string;
  headBranch: string;
  containerPullNumber: number | null;
  dailyIncrementEnabled: boolean;
  dailyIncrementEnabledAt: string | null;
  dailyIncrementBranch: string | null;
  scheduledCheckAt: string | null;
  scheduledCheckResult: ScheduledCheckResult | null;
  scheduledCheckTime: string;
  scheduledCheckMode: string;
};

/** 只复核那一轮要有未处置历史才开得起来:要它的用例让每个 Reviewer 都报一条。 */
const REPORTED_FINDINGS: Parameters<typeof scriptedReviewer>[1] = [
  { file: "src/answer.ts", line: 1, severity: "P1", category: "bug", description: "这里会越界" },
];

/** 每一轮的 Reviewer 记下自己拿到的范围与历史:定时开出的那一轮审了什么由它说。 */
type Recorded = { ranges: ReviewRange[]; historyEntries: string[][] };

type Clock = { set(ms: number): void; readonly at: number };

async function startedHarness(
  recorded: Recorded,
  clock: Clock,
  findings: Parameters<typeof scriptedReviewer>[1] = [],
  options: Parameters<typeof startReadyPanelHarness>[0] = {},
  /** Reviewer 开审之前停在这里:要让某一轮一直没有结束时间的用例用它。 */
  hold?: (range: ReviewRange) => Promise<void>,
): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness({
    ...options,
    scheduledCheckTickMs: TICK_MS,
    now: () => clock.at,
    buildReviewers: (plans) =>
      plans.map((plan) => {
        const reviewer = scriptedReviewer(plan.spec.model, findings);
        return {
          ...reviewer,
          review: async (input) => {
            recorded.ranges.push(input.range);
            recorded.historyEntries.push(
              input.history.map((entry) => `${entry.file}:${entry.disposition}`),
            );
            await hold?.(input.range);
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

function makeClock(startAt = Date.parse("2026-09-11T09:00:00.000Z")): Clock {
  let at = startAt;
  return {
    set(ms: number) {
      at = ms;
    },
    get at() {
      return at;
    },
  };
}

function startRangeReview(
  h: PanelHarness,
  base: string,
  comparison: string,
  /** 同一个 base 上已有进行中的范围审查时要它:接口只提醒,确认之后照常发起。 */
  confirm = false,
): Promise<RangeReview> {
  return startRangeReviewRow<RangeReview>(h, {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base,
    comparison,
    ...(confirm ? { confirm: true } : {}),
  });
}

/**
 * 开每日增量并跟上这条分支。时刻缺省 00:00:开在「今天」的 00:00 之后,当天因此不算错过。
 */
async function enableDailyIncrement(
  h: PanelHarness,
  id: number,
  branch: string,
  schedule: { time?: string; mode?: string } = {},
): Promise<void> {
  const response = await h.api("PUT", `/range-reviews/${id}/daily-increment`, {
    enabled: true,
    branch,
    ...schedule,
  });
  assert.equal(response.status, 200);
}

/** 阶段详情里那份范围审查:面板读的就是它。 */
async function detailRangeReview(h: PanelHarness, id: number): Promise<RangeReview> {
  const response = await h.api("GET", `/stages/range:${id}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { rangeReview: RangeReview }).rangeReview;
}

/** 这个阶段名下的轮次,开跑先后。 */
function runsOf(
  h: PanelHarness,
  rangeReviewId: number,
): { headSha: string; mode: string; triggerSource: string; triggeredBy: string | null }[] {
  const store = openStore(h.db.path);
  try {
    return store
      .listRuns({ limit: 30, rangeReviewId })
      .map((run) => ({
        headSha: run.headSha,
        mode: run.mode,
        triggerSource: run.triggerSource,
        triggeredBy: run.triggeredBy,
      }))
      .reverse();
  } finally {
    store.close();
  }
}

/** 等过几个 tick。用来断言「什么都没发生」:没有回调可等的那些用例只能等时间。 */
function afterSomeTicks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TICK_MS * 6));
}

test("到点推进:head 跟着分支走,那一轮来源是定时、范围是 base..新比较项、只复核历史注入", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.deepEqual(h.scheduledChecks[0], { rangeReviewId: rangeReview.id, result: "advanced" });

  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);
  // 容器 PR 的 head 分支跟着走到了分支最新 commit,base 分支一动不动。
  assert.equal(h.repo.branchSha(rangeReview.headBranch), next);

  const runs = runsOf(h, rangeReview.id);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1], {
    headSha: next,
    mode: "verdict-only",
    triggerSource: "scheduled",
    triggeredBy: null,
  });
  // 新一轮审的是 base..新比较项,不是上一比较项..新比较项。
  const latest = recorded.ranges.at(-1)!;
  assert.equal(latest.baseSha, h.repo.baseSha);
  assert.equal(latest.headSha, next);
  assert.deepEqual(recorded.historyEntries.at(-1), ["src/answer.ts:unknown"]);

  // 历次比较项那一行没有记录人:面板据此显示「定时检查」。
  const store = openStore(h.db.path);
  const comparisons = store.listRangeReviewComparisons(rangeReview.id);
  store.close();
  assert.deepEqual(
    comparisons.map((entry) => entry.recordedBy),
    [PANEL_ADMIN_USERNAME, ""],
  );

  const detail = await detailRangeReview(h, rangeReview.id);
  assert.equal(detail.scheduledCheckResult, "advanced");
  assert.notEqual(detail.scheduledCheckAt, null);
  assert.equal(detail.dailyIncrementEnabled, true);
});

test("同一天多次 tick 只跑一次;拨到第二天再跑一次", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  await h.settledAtLeast(2);
  // 同一天里 tick 再跑几次:检查次数与轮次数都不动。
  const again = h.repo.pushToHead({ "src/answer.ts": "export const answer = 4;\n" });
  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 1);
  assert.equal(runsOf(h, rangeReview.id).length, 2);

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(2);
  assert.equal(h.scheduledChecks[1]!.result, "advanced");
  await h.settledAtLeast(3);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), again);
  assert.equal(runsOf(h, rangeReview.id).length, 3);
});

test("开关开在今天不算错过:当天的 tick 不推进", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");

  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 0);
  assert.equal(runsOf(h, rangeReview.id).length, 1);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
});

/** 本地时区的某一刻:检查时刻按容器 TZ 算,用例跟着跑测试那台机器的时区拨。 */
function localAt(day: number, hours: number, minutes: number): number {
  return new Date(2026, 8, day, hours, minutes).getTime();
}

test("检查时刻 09:30:09:29 不跑、09:31 跑、同日不重跑、次日到点再跑", async () => {
  const clock = makeClock(localAt(11, 8, 0));
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  // 开在当天时刻点之前:当天就跑。
  await enableDailyIncrement(h, rangeReview.id, "feature", { time: "09:30" });

  clock.set(localAt(11, 9, 29));
  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 0);

  clock.set(localAt(11, 9, 31));
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "advanced");
  await h.settledAtLeast(2);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), next);

  const again = h.repo.pushToHead({ "src/answer.ts": "export const answer = 4;\n" });
  clock.set(localAt(11, 23, 59));
  await afterSomeTicks();
  // 次日跨过 00:00 但还没到 09:30:仍不跑。
  clock.set(localAt(12, 9, 29));
  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 1);

  clock.set(localAt(12, 9, 31));
  await h.scheduledChecksAtLeast(2);
  assert.equal(h.scheduledChecks[1]!.result, "advanced");
  await h.settledAtLeast(3);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), again);
});

test("开在当天时刻点之后:当天不跑,次日到点才跑", async () => {
  const clock = makeClock(localAt(11, 10, 0));
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature", { time: "09:30" });

  clock.set(localAt(11, 23, 59));
  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 0);

  clock.set(localAt(12, 9, 31));
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "advanced");
  await h.settledAtLeast(2);
});

test("完整审查模式:没有未处置历史也开轮次,那一轮模式是完整审查", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature", { mode: "full" });

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "advanced");
  await h.settledAtLeast(2);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), next);
  const runs = runsOf(h, rangeReview.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.mode, "full");
  assert.equal(runs[1]!.triggerSource, "scheduled");
});

test("分支上没有新提交:跳过并记原因,不开轮次", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);
  await enableDailyIncrement(h, rangeReview.id, "feature");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "no-new-commit");
  assert.equal(runsOf(h, rangeReview.id).length, 1);
  assert.equal((await detailRangeReview(h, rangeReview.id)).scheduledCheckResult, "no-new-commit");
});

test("这个范围审查有轮次在跑:跳过并记原因", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");

  // 一轮停在没有结束时间的状态:人点的那一次,或等着续跑的那一轮。
  const store = openStore(h.db.path);
  store.startRun({
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: rangeReview.containerPullNumber!,
    headSha: h.repo.headSha,
    startedAt: new Date(clock.at).toISOString(),
    rangeReviewId: rangeReview.id,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.close();

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "run-in-flight");
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
});

test("这个阶段没有未处置历史:跳过并记原因,不开轮次", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "nothing-to-verdict");
  assert.equal(runsOf(h, rangeReview.id).length, 1);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);
});

test("分支被强推、最新 commit 不再是 base 后代:跳过并记原因", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  // base 取 feature 尖端,main 上的根 commit 因此是它的祖先而不是后代。
  const comparison = h.repo.pushToHead({ "src/answer.ts": "export const answer = 5;\n" });
  const rangeReview = await startRangeReview(h, h.repo.headSha, comparison);

  // 跟的分支被强推回一个不在 base 之后的 commit。
  h.repo.setBranch("forced", h.repo.mergeBaseSha);
  await enableDailyIncrement(h, rangeReview.id, "forced");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "not-descendant");
  assert.equal(h.repo.branchSha(rangeReview.headBranch), comparison);
  assert.equal(runsOf(h, rangeReview.id).length, 1);
});

test("跟的分支被删掉:跳过并记原因,开关仍然开着", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.setBranch("short-lived", h.repo.headSha);
  await enableDailyIncrement(h, rangeReview.id, "short-lived");
  h.repo.deleteBranch("short-lived");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "branch-unknown");
  const detail = await detailRangeReview(h, rangeReview.id);
  assert.equal(detail.dailyIncrementEnabled, true);
  assert.equal(detail.dailyIncrementBranch, "short-lived");
  assert.equal(detail.scheduledCheckResult, "branch-unknown");
});

test("排空期间:跳过并记「排空中」,不开轮次", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const drain = createDrain();
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS, { drain });
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");

  drain.begin();
  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(1);
  assert.equal(h.scheduledChecks[0]!.result, "draining");
  assert.equal(runsOf(h, rangeReview.id).length, 1);
  assert.equal(h.repo.branchSha(rangeReview.headBranch), h.repo.headSha);

  // 同一天不再补:排空那一次已经刷新了时刻。
  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 1);
});

test("审查完成之后:定时检查不再碰这个阶段", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await enableDailyIncrement(h, rangeReview.id, "feature");
  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);

  clock.set(clock.at + DAY_MS);
  await afterSomeTicks();
  assert.equal(h.scheduledChecks.length, 0);
  assert.equal(runsOf(h, rangeReview.id).length, 1);
});

test("一条推分支失败不影响另一条:同一个仓库里另一个范围审查照常推进", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const failing = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);
  const healthy = await startRangeReview(h, h.repo.baseSha, h.repo.headSha, true);
  // 两条都要先跑完:定时检查对还在跑的那一条会记「有轮次在跑」,那是另一条用例的事。
  await h.settledAtLeast(2);

  // 远端拒收非快进的推送:从 base 另拉的那条对容器 PR 的 head 分支正是非快进。
  execFileSync("git", ["-C", h.repo.dir, "config", "receive.denyNonFastForwards", "true"]);
  h.repo.branchFrom("sidelined", h.repo.baseSha, { "src/answer.ts": "export const answer = 6;\n" });
  const forward = h.repo.pushToHead({ "src/answer.ts": "export const answer = 7;\n" });

  await enableDailyIncrement(h, failing.id, "sidelined");
  await enableDailyIncrement(h, healthy.id, "feature");

  clock.set(clock.at + DAY_MS);
  await h.scheduledChecksAtLeast(2);
  const results = new Map(h.scheduledChecks.map((entry) => [entry.rangeReviewId, entry.result]));
  assert.equal(results.get(failing.id), "push-failed");
  assert.equal(results.get(healthy.id), "advanced");

  await h.settledAtLeast(3);
  assert.equal(h.repo.branchSha(failing.headBranch), h.repo.headSha);
  assert.equal(h.repo.branchSha(healthy.headBranch), forward);
  assert.equal(runsOf(h, failing.id).length, 1);
  assert.equal(runsOf(h, healthy.id).length, 2);
});

/** 轮询到条件成立。等的是 git 钩子落下的信号文件,没有回调可挂。 */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("tick 处理前一条期间人工推进了后一条:后一条开检查前重读,记「有轮次在跑」、不再开轮次", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  // 人工推进开出的那一轮停在 Reviewer 里,因此一直没有结束时间。
  let manualSha = "";
  let reachManual!: () => void;
  const manualReached = new Promise<void>((resolve) => (reachManual = resolve));
  let releaseManual!: () => void;
  const manualReleased = new Promise<void>((resolve) => (releaseManual = resolve));
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS, {}, async (range) => {
    if (range.headSha !== manualSha) return;
    reachManual();
    await manualReleased;
  });
  // 列表按 id 倒序,tick 先检查后发起的那一条。
  const checkedSecond = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);
  const checkedFirst = await startRangeReview(h, h.repo.baseSha, h.repo.headSha, true);
  await h.settledAtLeast(2);

  manualSha = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  const tip = h.repo.pushToHead({ "src/answer.ts": "export const answer = 4;\n" });
  await enableDailyIncrement(h, checkedFirst.id, "feature");
  await enableDailyIncrement(h, checkedSecond.id, "feature");

  // 远端的 pre-receive 钩子把先检查的那一条卡在推容器 PR head 分支那一步,tick 停在它身上。
  const signals = mkdtempSync(join(tmpdir(), "multireviewer-hold-"));
  mkdirSync(join(signals, "hooks"));
  const hook = join(signals, "hooks", "pre-receive");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "while read old new ref; do",
      `  if [ "$ref" = "refs/heads/${checkedFirst.headBranch}" ]; then`,
      `    touch "${signals}/held"`,
      // 信号目录被删掉也放行:用例半途失败时不留一个永远等着的 push。
      `    while [ -d "${signals}" ] && [ ! -f "${signals}/release" ]; do sleep 0.05; done`,
      "  fi",
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
  execFileSync("git", ["-C", h.repo.dir, "config", "core.hooksPath", join(signals, "hooks")]);

  try {
    clock.set(clock.at + DAY_MS);
    await until(() => existsSync(join(signals, "held")));

    // tick 卡住的这段时间里,人把后一条推进到中间那个 commit,那一轮停在 Reviewer 里。
    const advance = await h.api("POST", `/range-reviews/${checkedSecond.id}/advance`, {
      comparison: manualSha,
    });
    assert.equal(advance.status, 202);
    await manualReached;

    writeFileSync(join(signals, "release"), "");
    await h.scheduledChecksAtLeast(2);
    const results = new Map(h.scheduledChecks.map((entry) => [entry.rangeReviewId, entry.result]));
    assert.equal(results.get(checkedFirst.id), "advanced");
    assert.equal(results.get(checkedSecond.id), "run-in-flight");

    // 后一条停在人推的那个 commit 上,没有定时开出的轮次。
    assert.equal(h.repo.branchSha(checkedFirst.headBranch), tip);
    assert.equal(h.repo.branchSha(checkedSecond.headBranch), manualSha);
    assert.deepEqual(
      runsOf(h, checkedSecond.id).map((run) => run.triggerSource),
      ["panel", "panel"],
    );
    releaseManual();
    await h.settledAtLeast(4);
  } finally {
    releaseManual();
    writeFileSync(join(signals, "release"), "");
    rmSync(signals, { recursive: true, force: true });
  }
});

test("升级前的旧库:开库补上每日增量那几列,开关照常能开", async () => {
  const clock = makeClock();
  const recorded: Recorded = { ranges: [], historyEntries: [] };
  const h = await startedHarness(recorded, clock, REPORTED_FINDINGS);
  const rangeReview = await startRangeReview(h, h.repo.baseSha, h.repo.headSha);

  // 把库退回升级之前的样子:那时这五列还不存在。改名而不是 DROP——SQLite 丢一张表的
  // 最后一列时要重写建表语句,而 `range_review` 的建表语句里有中文注释,重写会截断并
  // 报 `incomplete input`。改名之后 `pragma_table_info` 同样查不到这几个名字,补列那段
  // 走的是同一条路。
  const db = new DatabaseSync(h.db.path);
  for (const column of [
    "daily_increment_enabled",
    "daily_increment_branch",
    "daily_increment_enabled_at",
    "scheduled_check_at",
    "scheduled_check_result",
    "scheduled_check_time",
    "scheduled_check_mode",
  ]) {
    db.exec(`ALTER TABLE range_review RENAME COLUMN ${column} TO before_upgrade_${column}`);
  }
  db.close();

  // 下一次打开补列:读得回来,值是「开关没开过、也没检查过」。
  const detail = await detailRangeReview(h, rangeReview.id);
  assert.equal(detail.dailyIncrementEnabled, false);
  assert.equal(detail.dailyIncrementBranch, null);
  assert.equal(detail.dailyIncrementEnabledAt, null);
  assert.equal(detail.scheduledCheckAt, null);
  assert.equal(detail.scheduledCheckResult, null);
  assert.equal(detail.scheduledCheckTime, "00:00");
  assert.equal(detail.scheduledCheckMode, "verdict-only");

  await enableDailyIncrement(h, rangeReview.id, "feature");
  const opened = await detailRangeReview(h, rangeReview.id);
  assert.equal(opened.dailyIncrementEnabled, true);
  assert.equal(opened.dailyIncrementBranch, "feature");
});
