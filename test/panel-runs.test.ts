/**
 * 时间流与手动重跑(issue #37)。时间流 API 打在 HTTP 缝上:分页、逐条计数、
 * 已移除仓库的历史照常出现;重跑走真实 runReview 加内存 Forge,不新增注入边界。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import { HARNESS_PR, startPanelHarness } from "./support/panel-harness.ts";

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
  failed: boolean;
  models: { model: string; findings: number }[];
  resolved: number;
  total: number;
};

function seedRun(
  dbPath: string,
  meta: { owner: string; repo: string; pullNumber: number; startedAt: string },
  findings: { model: string; disposition?: string; placement?: string; group?: number }[],
): number {
  const store = openStore(dbPath);
  const runId = store.startRun({
    ...meta,
    headSha: `sha-${meta.pullNumber}-${meta.startedAt}`,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
  });
  store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: [],
    findings: findings.map((f, i) => ({
      model: f.model,
      file: "src/a.ts",
      line: 5,
      severity: "P1" as const,
      category: "bug" as const,
      description: "示例",
      groupIndex: f.group ?? i,
      disposition: (f.disposition ?? "unknown") as never,
      placement: (f.placement ?? "inline") as never,
      fingerprint: `fp-${f.group ?? i}`,
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
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
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
  assert.equal(oldest.repo, "gone");

  // 逐模型来源行计数;已处置口径按合并组算且只认行级承载:
  // 组 0 有一行 resolved 即已处置,组 1 未处置,组 2 是正文行不进分母。
  assert.deepEqual(latest.models, [
    { model: "model-a", findings: 1 },
    { model: "model-b", findings: 3 },
  ]);
  assert.equal(latest.resolved, 1);
  assert.equal(latest.total, 2);
  assert.equal(oldest.total, 1);
  assert.equal(oldest.resolved, 0);
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
  const h = await startPanelHarness(cleanups);
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
  const h = await startPanelHarness(cleanups);
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
  const h = await startPanelHarness(cleanups);
  assert.equal(
    (
      await h.api("POST", "/repos", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        reviewers: [
          { provider: "openai", model: "override-model", apiKeyEnv: "KEY_ENV" },
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
  assert.deepEqual(h.factoryCalls.at(-1), [{ provider: "openai", model: "override-model", apiKeyEnv: "KEY_ENV" }]);
});
