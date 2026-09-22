/**
 * 轮次的触发来源(issue #312,父 spec #310)。
 *
 * 打在面板 API 的 HTTP 缝上:三条开轮次的入口各走一遍真实链路,只看接口返回的那一格
 * ——轮次列表与阶段详情的时间线都要答得出这一轮是被谁开出来的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";


import type { RunProjection } from "../src/contracts/runs.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startRangeReview,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

/* 轮次那一行的形状是契约(issue #433):来源那一格因此是枚举,不是任意 `string`。 */
type RunRow = RunProjection;

type StageDetailBody = {
  groups: { runs: { runId: number; triggerSource: string }[] }[];
};

async function registeredHarness(): Promise<PanelHarness> {
  const h = await startReadyPanelHarness({ registerRepo: true });
  await confirmEmptyRuleSet(h.db.url, GITEA_REPO.id);
  // 注册后工作副本在后台备(issue #184)。等它备完再开测,免得用例跑完了它还在写缓存目录。
  await h.worktreesPreparedAtLeast(1);
  return h;
}

/** 轮次列表上的来源,新的在前。 */
async function listedSources(h: PanelHarness): Promise<string[]> {
  const body = (await (await h.api("GET", "/runs")).json()) as { runs: RunRow[] };
  return body.runs.map((run) => run.triggerSource);
}

/** 阶段详情时间线上的来源,按轮次先后。 */
async function timelineSources(h: PanelHarness, stageId: string): Promise<string[]> {
  const response = await h.api("GET", `/stages/${encodeURIComponent(stageId)}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as StageDetailBody;
  return body.groups
    .flatMap((group) => group.runs)
    .sort((a, b) => a.runId - b.runId)
    .map((run) => run.triggerSource);
}

test("投递开出的一轮是投递,面板重跑那一轮是面板", async () => {
  const h = await registeredHarness();

  assert.equal((await h.deliverViaHook("delivery-head")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const rerun = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
    mode: "full",
  });
  assert.equal(rerun.status, 202);
  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  assert.deepEqual(await listedSources(h), ["panel", "delivery"]);
  assert.deepEqual(
    await timelineSources(h, `pr:${HARNESS_PR.owner}/${HARNESS_PR.repo}/${HARNESS_PR.number}`),
    ["delivery", "panel"],
  );
});

test("发起范围审查与推进比较项开出的轮次都是面板", async () => {
  const h = await registeredHarness();
  const rangeReview = await startRangeReview<{ id: number }>(h);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  const advance = await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, {
    comparison: next,
    mode: "full",
  });
  assert.equal(advance.status, 202);
  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  assert.deepEqual(await timelineSources(h, `range:${rangeReview.id}`), ["panel", "panel"]);
});

