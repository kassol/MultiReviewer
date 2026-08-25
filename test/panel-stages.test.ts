/**
 * 阶段列表(issue #174)。评审记录的每一行是一个审查阶段:pull request 阶段按
 * owner、repo、pull number 归并,范围审查阶段按范围审查自身标识归并。
 *
 * 打在面板 API 的 HTTP 缝上:归并、筛选、分页与状态变化都只看响应。PR 的关闭与重开
 * 走真实的 webhook 投递,范围审查那两条用例走真实的发起、推进与审查完成。
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  HARNESS_PR_TITLE,
  startPanelHarness,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type StageRow = {
  stageId: string;
  source: "pull-request" | "range-review";
  owner: string;
  repo: string;
  pullNumber: number | null;
  rangeReviewId: number | null;
  title: string | null;
  status: "active" | "closed";
  latestRunId: number | null;
  latestRunAt: string | null;
  counts: { pending: number; resolved: number; fixed: number };
};

type StagesPage = { stages: StageRow[]; nextOffset: number | null };

/** 播种一轮 Review Run:一条 Finding 一个指纹,阶段汇总按「文件 + 指纹」折叠。 */
function seedRun(
  dbPath: string,
  meta: {
    owner: string;
    repo: string;
    pullNumber: number;
    startedAt: string;
    title?: string;
    rangeReviewId?: number;
  },
  findings: { fingerprint: string; disposition?: "unknown" | "resolved" | "fixed" }[] = [],
): number {
  const store = openStore(dbPath);
  const runId = store.startRun({
    owner: meta.owner,
    repo: meta.repo,
    pullNumber: meta.pullNumber,
    headSha: `sha-${meta.pullNumber}-${meta.startedAt}`,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.rangeReviewId === undefined ? {} : { rangeReviewId: meta.rangeReviewId }),
    startedAt: meta.startedAt,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: [
      {
        model: "model-a",
        findingCount: findings.length,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
      },
    ],
    findings: findings.map((finding, index) => ({
      file: "src/a.ts",
      line: 5,
      title: "示例",
      severity: "P1" as const,
      category: "bug" as const,
      description: "示例",
      attributions: [
        { model: "model-a", severity: "P1" as const, category: "bug" as const, description: "示例" },
      ],
      groupIndex: index,
      disposition: (finding.disposition ?? "unknown") as never,
      placement: "inline" as never,
      fingerprint: finding.fingerprint,
    })),
    verdicts: [],
  });
  store.close();
  return runId;
}

/** 用 hook 的凭据签一次 pull request 投递。关闭与重开都走这一条真实链路。 */
function deliver(h: PanelHarness, action: string, headSha: string): Promise<Response> {
  const hook = h.gitea.hooks[0];
  assert.notEqual(hook, undefined, "假 Gitea 上没有 hook 可用");
  const target = new URL(hook!.config.url!);
  const body = JSON.stringify({
    action,
    number: HARNESS_PR.number,
    pull_request: { draft: false, head: { sha: headSha } },
    repository: { id: GITEA_REPO.id, name: HARNESS_PR.repo, owner: { login: HARNESS_PR.owner } },
  });
  return fetch(`${h.serverUrl}${target.pathname}${target.search}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitea-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", hook!.config.secret!)
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
}

async function stages(h: PanelHarness, query = ""): Promise<StagesPage> {
  const response = await h.api("GET", `/stages${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as StagesPage;
}

test("阶段列表:同一 pull request 三轮只占一行,带最新一轮与阶段汇总三个数", async () => {
  const h = await startPanelHarness(cleanups);
  seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      startedAt: "2026-08-01T00:00:00.000Z",
      title: "旧标题",
    },
    [{ fingerprint: "fp-1" }, { fingerprint: "fp-2", disposition: "resolved" }],
  );
  seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      startedAt: "2026-08-02T00:00:00.000Z",
      title: "旧标题",
    },
    // 同一条 Finding 再报一次:按 Finding Identity 折叠,阶段里仍只有一条。
    [{ fingerprint: "fp-1" }],
  );
  const latest = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      startedAt: "2026-08-03T00:00:00.000Z",
      title: "把登录超时改回三十秒",
    },
    [{ fingerprint: "fp-3", disposition: "fixed" }],
  );

  const body = await stages(h);
  assert.equal(body.stages.length, 1);
  const stage = body.stages[0]!;
  assert.equal(stage.stageId, "pr:acme/widgets/7");
  assert.equal(stage.source, "pull-request");
  assert.equal(stage.owner, "acme");
  assert.equal(stage.repo, "widgets");
  assert.equal(stage.pullNumber, 7);
  assert.equal(stage.rangeReviewId, null);
  // 标题取最新一轮那份快照:pull request 改了名,列表跟着改。
  assert.equal(stage.title, "把登录超时改回三十秒");
  assert.equal(stage.status, "active");
  assert.equal(stage.latestRunId, latest);
  assert.equal(stage.latestRunAt, "2026-08-03T00:00:00.000Z");
  // 口径与 `GET /stage-summary` 一致:fp-1 待处置、fp-2 人工已处置、fp-3 已修复。
  assert.deepEqual(stage.counts, { pending: 1, resolved: 1, fixed: 1 });

  const summary = (await (
    await h.api("GET", "/stage-summary?owner=acme&repo=widgets&pullNumber=7")
  ).json()) as { counts: { pending: number; resolved: number; fixed: number } };
  assert.deepEqual(stage.counts, summary.counts);
});

test("阶段列表:升级前没有标题的旧行,列表里没有标题可用", async () => {
  const h = await startPanelHarness(cleanups);
  seedRun(h.db.path, {
    owner: "ghost",
    repo: "gone",
    pullNumber: 1,
    startedAt: "2026-08-01T00:00:00.000Z",
  });

  const body = await stages(h);
  assert.equal(body.stages.length, 1);
  assert.equal(body.stages[0]!.title, null);
  assert.equal(body.stages[0]!.pullNumber, 1);
});

test("阶段列表:全局与仓库过滤返回同一个阶段的同一条记录", async () => {
  const h = await startPanelHarness(cleanups);
  seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    startedAt: "2026-08-02T00:00:00.000Z",
    title: HARNESS_PR_TITLE,
  });
  seedRun(h.db.path, {
    owner: "other",
    repo: "thing",
    pullNumber: 3,
    startedAt: "2026-08-03T00:00:00.000Z",
  });

  const all = await stages(h);
  assert.deepEqual(
    all.stages.map((stage) => stage.stageId),
    ["pr:other/thing/3", "pr:acme/widgets/7"],
  );

  const scoped = await stages(h, "?owner=acme&repo=widgets");
  assert.equal(scoped.stages.length, 1);
  assert.deepEqual(
    scoped.stages[0],
    all.stages.find((stage) => stage.stageId === "pr:acme/widgets/7"),
  );

  // 过滤不接受半个键。
  assert.equal((await h.api("GET", "/stages?owner=acme")).status, 400);
});

test("阶段列表:pull request 关闭后已结束,重开回到进行中且仍是同一行", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  assert.equal((await h.deliverViaHook("delivery-head")).status, 200);
  await h.settledAtLeast(1);

  const opened = await stages(h);
  assert.equal(opened.stages.length, 1);
  assert.equal(opened.stages[0]!.status, "active");
  assert.equal(opened.stages[0]!.title, HARNESS_PR_TITLE);
  const stageId = opened.stages[0]!.stageId;

  assert.equal((await deliver(h, "closed", "delivery-head")).status, 200);
  const closed = await stages(h);
  assert.equal(closed.stages.length, 1);
  assert.equal(closed.stages[0]!.stageId, stageId);
  assert.equal(closed.stages[0]!.status, "closed");

  assert.equal((await deliver(h, "reopened", "delivery-head")).status, 200);
  const reopened = await stages(h);
  assert.equal(reopened.stages.length, 1);
  assert.equal(reopened.stages[0]!.stageId, stageId);
  assert.equal(reopened.stages[0]!.status, "active");
});

test("阶段列表:同一范围审查推进两次只占一行,审查完成后已结束", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  const created = await h.api("POST", "/range-reviews", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(created.status, 202);
  const { rangeReview } = (await created.json()) as { rangeReview: { id: number } };
  await h.settledAtLeast(1);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  assert.equal(
    (await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, { comparison: next })).status,
    202,
  );
  await h.settledAtLeast(2);

  // 两轮 Review Run,列表里仍只有这一个阶段:容器 PR 不另占一行。
  const running = await stages(h);
  assert.equal(running.stages.length, 1);
  const stage = running.stages[0]!;
  assert.equal(stage.stageId, `range:${rangeReview.id}`);
  assert.equal(stage.source, "range-review");
  assert.equal(stage.rangeReviewId, rangeReview.id);
  assert.equal(stage.pullNumber, null);
  assert.equal(stage.status, "active");
  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  store.close();
  assert.equal(runs.length, 2);
  assert.equal(stage.latestRunId, runs[0]!.id);
  assert.equal(stage.latestRunAt, runs[0]!.startedAt);

  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);
  const completed = await stages(h);
  assert.equal(completed.stages.length, 1);
  assert.equal(completed.stages[0]!.stageId, `range:${rangeReview.id}`);
  assert.equal(completed.stages[0]!.status, "closed");
});

test("阶段列表:按状态、按来源筛选各自生效,组合筛选生效,默认全部", async () => {
  const h = await startPanelHarness(cleanups);
  // 进行中的 pull request 阶段。
  seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    startedAt: "2026-08-01T00:00:00.000Z",
  });
  // 已关闭的 pull request 阶段。
  seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 8,
    startedAt: "2026-08-02T00:00:00.000Z",
  });
  const store = openStore(h.db.path);
  store.markPullRequestState("acme", "widgets", 8, "closed");
  // 一个进行中、一个已完成的范围审查。
  const running = store.createRangeReview({
    repoId: GITEA_REPO.id,
    owner: "acme",
    repo: "widgets",
    baseSha: "base-sha",
    comparisonSha: "cmp-sha",
    createdBy: "operator",
    createdAt: "2026-08-03T00:00:00.000Z",
  });
  const done = store.createRangeReview({
    repoId: GITEA_REPO.id,
    owner: "acme",
    repo: "widgets",
    baseSha: "base-sha",
    comparisonSha: "cmp-sha",
    createdBy: "operator",
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  store.completeRangeReview({
    id: done,
    completedBy: "operator",
    completedAt: "2026-08-05T00:00:00.000Z",
  });
  store.close();

  const all = await stages(h);
  assert.deepEqual(
    new Set(all.stages.map((stage) => stage.stageId)),
    new Set(["pr:acme/widgets/7", "pr:acme/widgets/8", `range:${running}`, `range:${done}`]),
  );

  const active = await stages(h, "?status=active");
  assert.deepEqual(
    new Set(active.stages.map((stage) => stage.stageId)),
    new Set(["pr:acme/widgets/7", `range:${running}`]),
  );

  const closed = await stages(h, "?status=closed");
  assert.deepEqual(
    new Set(closed.stages.map((stage) => stage.stageId)),
    new Set(["pr:acme/widgets/8", `range:${done}`]),
  );

  const rangeOnly = await stages(h, "?source=range-review");
  assert.deepEqual(
    new Set(rangeOnly.stages.map((stage) => stage.stageId)),
    new Set([`range:${running}`, `range:${done}`]),
  );

  const combined = await stages(h, "?source=pull-request&status=closed");
  assert.deepEqual(
    combined.stages.map((stage) => stage.stageId),
    ["pr:acme/widgets/8"],
  );

  // 认不出来的筛选值要显形,不能悄悄按「全部」处理。
  assert.equal((await h.api("GET", "/stages?status=maybe")).status, 400);
  assert.equal((await h.api("GET", "/stages?source=issue")).status, 400);
});

test("阶段列表:满页给 nextOffset,翻页不重不漏", async () => {
  const h = await startPanelHarness(cleanups);
  for (let i = 1; i <= 32; i += 1) {
    seedRun(h.db.path, {
      owner: "acme",
      repo: "widgets",
      pullNumber: i,
      startedAt: `2026-08-02T00:00:${String(i).padStart(2, "0")}.000Z`,
    });
  }

  const first = await stages(h);
  assert.equal(first.stages.length, 30);
  assert.equal(first.nextOffset, 30);

  const rest = await stages(h, `?offset=${first.nextOffset}`);
  assert.equal(rest.stages.length, 2);
  assert.equal(rest.nextOffset, null);
  const seen = [...first.stages, ...rest.stages].map((stage) => stage.stageId);
  assert.equal(new Set(seen).size, 32);

  assert.equal((await h.api("GET", "/stages?offset=abc")).status, 400);
});

test("单轮 API:按 id 取该阶段最新一轮,不存在的 id 是 404", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      startedAt: "2026-08-02T00:00:00.000Z",
      title: HARNESS_PR_TITLE,
    },
    [{ fingerprint: "fp-1" }],
  );

  const response = await h.api("GET", `/runs/${runId}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    run: { id: number; title: string | null; findings: { id: number }[] };
  };
  assert.equal(body.run.id, runId);
  assert.equal(body.run.title, HARNESS_PR_TITLE);
  assert.equal(body.run.findings.length, 1);

  assert.equal((await h.api("GET", "/runs/9999")).status, 404);
});
