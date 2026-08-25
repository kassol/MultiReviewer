/**
 * 时间流与手动重跑(issue #37)。时间流 API 打在 HTTP 缝上:分页、逐条计数、
 * 已移除仓库的历史照常出现;重跑走真实 runReview 加内存 Forge,不新增注入边界。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { openStore, type RecordedUsage } from "../src/review/store.ts";
import type { ReviewerUsage } from "../src/review/finding.ts";
import {
  HARNESS_PR,
  PANEL_ADMIN_USERNAME,
  seedAvailableModelService,
  startPanelHarness,
  startReadyPanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type RunRow = {
  id: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  startedAt: string;
  triggeredBy: string | null;
  failed: boolean;
  models: {
    model: string;
    findings: number;
    failure: string | null;
    usage?: RecordedUsage;
  }[];
  usage?: RecordedUsage;
  missedVerdicts: number;
  resolved: number;
  total: number;
};

function seedRun(
  dbPath: string,
  meta: {
    owner: string;
    repo: string;
    pullNumber: number;
    startedAt: string;
    triggeredBy?: string;
  },
  findings: { model: string; disposition?: string; placement?: string; group?: number }[],
  outcomes: { model: string; failure?: string; usage?: ReviewerUsage }[] = [],
  verdicts: { model: string; findingId: number; missing?: boolean }[] = [],
): number {
  const store = openStore(dbPath);
  const runId = store.startRun({
    ...meta,
    headSha: `sha-${meta.pullNumber}-${meta.startedAt}`,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: outcomes.map((o) => ({
      model: o.model,
      ...(o.failure === undefined ? {} : { failure: o.failure }),
      findingCount: findings.filter((f) => f.model === o.model).length,
      anomalyCount: 0,
      rejectedToolCalls: 0,
      anchorRejections: 0,
      durationMs: 1,
      ...(o.usage === undefined ? {} : { usage: o.usage }),
    })),
    // 同一个 group 的几条是同一处:落成一条 Finding 加几条归属(ADR 0015)。
    findings: [...new Set(findings.map((f, i) => f.group ?? i))].map((group) => {
      const members = findings.filter((f, i) => (f.group ?? i) === group);
      const first = members[0]!;
      return {
        file: "src/a.ts",
        line: 5,
        title: "示例",
        severity: "P1" as const,
        category: "bug" as const,
        description: "示例",
        attributions: members.map((f) => ({
          model: f.model,
          severity: "P1" as const,
          category: "bug" as const,
          description: "示例",
        })),
        groupIndex: group,
        disposition: (first.disposition ?? "unknown") as never,
        placement: (first.placement ?? "inline") as never,
        fingerprint: `fp-${group}`,
      };
    }),
    // 漏给结论的按无法判断落库并标 missing(ADR 0016),时间流数的就是它。
    verdicts: verdicts.map((v) => ({
      model: v.model,
      findingId: v.findingId,
      verdict: v.missing === true ? ("unclear" as const) : ("fixed" as const),
      missing: v.missing === true,
    })),
  });
  store.close();
  return runId;
}

test("时间流 API:倒序分页、逐条计数、已移除仓库的历史照常出现", async () => {
  const h = await startPanelHarness(cleanups);

  // 一条“已移除仓库”的历史(注册表里没有 ghost/gone)加一条带计数的:
  // 两个模型各报了行级 Finding,其中一组被 resolve,另有一条正文行不进已处置口径。
  seedRun(
    h.db.path,
    { owner: "ghost", repo: "gone", pullNumber: 1, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ model: "model-a" }],
  );
  seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      startedAt: "2026-08-02T00:00:00.000Z",
      triggeredBy: "former-operator",
    },
    [
      { model: "model-a", disposition: "resolved", group: 0 },
      { model: "model-b", disposition: "unknown", group: 0 },
      { model: "model-b", disposition: "unknown", group: 1 },
      { model: "model-b", placement: "body", group: 2 },
    ],
  );

  const response = await h.api("GET", "/runs");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { runs: RunRow[]; nextBefore: number | null };
  assert.equal(body.runs.length, 2);
  assert.equal(body.nextBefore, null);

  // 倒序:新的在前。
  const [latest, oldest] = [body.runs[0]!, body.runs[1]!];
  assert.equal(latest.owner, "acme");
  assert.equal(oldest.owner, "ghost");
  assert.equal(latest.triggeredBy, "former-operator");
  assert.equal(oldest.triggeredBy, null);
  assert.equal(oldest.repo, "gone");

  // 逐模型来源行计数;已处置口径按合并组算且只认行级承载:
  // 组 0 有一行 resolved 即已处置,组 1 未处置,组 2 是正文行不进分母。
  // 没有 outcome 行的历史(这两条就是)按 finding 表兜底,失败原因自然是 null。
  assert.deepEqual(latest.models, [
    { model: "model-a", findings: 1, failure: null },
    { model: "model-b", findings: 3, failure: null },
  ]);
  assert.equal(latest.resolved, 1);
  assert.equal(latest.total, 2);
  assert.equal(oldest.total, 1);
  assert.equal(oldest.resolved, 0);
});

test("时间流 API:失败的模型照样出现在 JSON 里,带失败原因", async () => {
  const h = await startPanelHarness(cleanups);
  seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
    [{ model: "model-a" }],
    [{ model: "model-a" }, { model: "model-b", failure: "403 not available in your region" }],
  );

  const body = (await (await h.api("GET", "/runs")).json()) as { runs: RunRow[] };
  // 零 Finding 的 model-b 只在 reviewer_outcome 里有行,按 finding 分组时它会消失。
  assert.deepEqual(body.runs[0]!.models, [
    { model: "model-a", findings: 1, failure: null },
    { model: "model-b", findings: 0, failure: "403 not available in your region" },
  ]);
  assert.equal(body.runs[0]!.failed, false);
  assert.equal(Object.hasOwn(body.runs[0]!, "usage"), false);
  assert.equal(Object.hasOwn(body.runs[0]!.models[0]!, "usage"), false);
});

test("时间流 API:混合费用返回已知小计、未知状态与未知 Reviewer 数", async () => {
  const h = await startPanelHarness(cleanups);
  const known: ReviewerUsage = {
    inputTokens: 8,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
    costUsd: 0.1,
    knownCostUsd: 0.1,
    costSource: "trusted",
  };
  const unknown: ReviewerUsage = {
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 20,
    costUsd: null,
    knownCostUsd: 0,
    costSource: "unknown",
  };
  seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
    [],
    [
      { model: "model-a", usage: known },
      { model: "model-b", usage: unknown },
    ],
  );

  const body = (await (await h.api("GET", "/runs")).json()) as { runs: RunRow[] };
  assert.deepEqual(body.runs[0]!.usage, {
    inputTokens: 23,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 30,
    costUsd: null,
    knownCostUsd: 0.1,
    costSource: "unknown",
    costIncomplete: true,
    unknownCostReviewers: 1,
  });
  assert.deepEqual(body.runs[0]!.models[0]!.usage, {
    inputTokens: 8,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
    costUsd: 0.1,
    knownCostUsd: 0.1,
    costSource: "trusted",
    costIncomplete: false,
    unknownCostReviewers: 0,
  });
  assert.deepEqual(body.runs[0]!.models[1]!.usage, {
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 20,
    costUsd: null,
    knownCostUsd: 0,
    costSource: "unknown",
    costIncomplete: true,
    unknownCostReviewers: 1,
  });
});

test("时间流 API:满页给 nextBefore 游标,翻页不重不漏;owner/repo 过滤", async () => {
  const h = await startPanelHarness(cleanups);
  for (let i = 1; i <= 32; i += 1) {
    seedRun(
      h.db.path,
      {
        owner: i % 2 === 0 ? "acme" : "other",
        repo: i % 2 === 0 ? "widgets" : "thing",
        pullNumber: i,
        startedAt: `2026-08-02T00:00:${String(i).padStart(2, "0")}.000Z`,
      },
      [],
    );
  }

  const first = (await (await h.api("GET", "/runs")).json()) as {
    runs: RunRow[];
    nextBefore: number | null;
  };
  assert.equal(first.runs.length, 30);
  assert.notEqual(first.nextBefore, null);

  const rest = (await (
    await h.api("GET", `/runs?before=${first.nextBefore}`)
  ).json()) as { runs: RunRow[]; nextBefore: number | null };
  assert.equal(rest.runs.length, 2);
  assert.equal(rest.nextBefore, null);
  const all = [...first.runs, ...rest.runs].map((run) => run.pullNumber);
  assert.equal(new Set(all).size, 32);

  const filtered = (await (
    await h.api("GET", "/runs?owner=acme&repo=widgets")
  ).json()) as { runs: RunRow[] };
  assert.equal(filtered.runs.length, 16);
  assert.ok(filtered.runs.every((run) => run.owner === "acme"));

  // 游标解析不了要显形。
  assert.equal((await h.api("GET", "/runs?before=abc")).status, 400);
});

test("重跑:注册仓库触发新 Review Run,同一 head commit 重复审合法", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );

  const rerun = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(rerun.status, 202);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  // 同一 head commit 再跑一次也合法:重跑不走幂等 claim。
  const again = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(again.status, 202);
  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30 });
  store.close();
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.pullNumber, HARNESS_PR.number);
  assert.deepEqual(
    runs.map((run) => run.triggeredBy),
    [PANEL_ADMIN_USERNAME, PANEL_ADMIN_USERNAME],
  );
});

test("投递触发的 Review Run 不写调用者快照", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );

  assert.equal((await h.deliverViaHook("delivery-head")).status, 200);
  await h.settledAtLeast(1);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30 });
  store.close();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.triggeredBy, null);
});

test("重跑:未注册仓库 409,PR 号不是数字 400", async () => {
  const h = await startPanelHarness(cleanups);
  const rerun = await h.api("POST", "/rerun", {
    owner: "ghost",
    repo: "gone",
    pullNumber: 1,
  });
  assert.equal(rerun.status, 409);

  assert.equal(
    (
      await h.api("POST", "/rerun", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: "seven",
      })
    ).status,
    400,
  );
});

test("重跑:PR 号读不到 404,不开跑", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  const rerun = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: 999,
  });
  assert.equal(rerun.status, 404);
  const store = openStore(h.db.path);
  assert.equal(store.listRuns({ limit: 30 }).length, 0);
  store.close();
});

test("重跑:模型覆盖生效,经 buildReviewers 构建", async () => {
  const h = await startReadyPanelHarness(cleanups);
  seedAvailableModelService(h, "rerun-provider", ["override-model"]);
  assert.equal(
    (
      await h.api("POST", "/repos", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        reviewers: [
          { provider: "rerun-provider", model: "override-model" },
        ],
      })
    ).status,
    201,
  );
  h.factoryCalls.length = 0;

  const rerun = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });
  assert.equal(rerun.status, 202);
  await h.settledAtLeast(1);
  assert.deepEqual(h.factoryCalls.at(-1), [
    { provider: "rerun-provider", model: "override-model" },
  ]);
});

test("时间流 API:每轮带漏复核条数,没有历史可复核的那轮是零", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
    [{ model: "model-a" }],
    [{ model: "model-a" }],
  );
  // 下一轮复核上一轮那条:一个模型给了结论,另一个漏给。
  const store = openStore(h.db.path);
  const findingId = store.listRuns({ limit: 10 })[0]!.findings[0]!.id;
  store.close();
  seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-03T00:00:00.000Z" },
    [],
    [{ model: "model-a" }, { model: "model-b" }],
    [
      { model: "model-a", findingId },
      { model: "model-b", findingId, missing: true },
    ],
  );

  const body = (await (await h.api("GET", "/runs")).json()) as { runs: RunRow[] };
  assert.equal(body.runs[0]!.missedVerdicts, 1);
  assert.equal(body.runs[1]!.id, runId);
  assert.equal(body.runs[1]!.missedVerdicts, 0);
});
