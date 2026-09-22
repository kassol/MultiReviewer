/**
 * 阶段列表(issue #174)。评审记录的每一行是一个审查阶段:pull request 阶段按
 * owner、repo、pull number 归并,范围审查阶段按范围审查自身标识归并。
 *
 * 打在面板 API 的 HTTP 缝上:归并、筛选、分页与状态变化都只看响应。PR 的关闭与重开
 * 走真实的 webhook 投递,范围审查那两条用例走真实的发起、推进与审查完成。
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { openStore } from "../src/review/store/index.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  HARNESS_PR_TITLE,
  startPanelHarness,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet, seedRun as seedRunRow } from "./support/git-fixture.ts";

/*
 * 行的形状引服务端那一份契约(issue #426、#429),不在这里手抄一遍:抄一份的时候契约
 * 删一格、改一格用例照样编译得过,这里的断言于是什么都钉不住。信封那两格由端点在投影
 * 之上拼,不属于契约,留在这里。
 */
import type { StageListItem as StageRow } from "../src/contracts/stages.ts";

type StagesPage = { stages: StageRow[]; nextOffset: number | null };

/** 播种一轮 Review Run:一条 Finding 一个指纹,阶段汇总按「文件 + 指纹」折叠。 */
async function seedRun(
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
  /**
   * 这一轮另外要落的东西(issue #421、#424 的警示三档):整轮没跑成的那个模型、复核结论
   * ——`findingId` 指的是上一轮那条历史,`missing` 说它为什么没拿到结论——以及轮次级的
   * 收尾失败原因(ADR 0026)。
   */
  extra: {
    failedModel?: string;
    verdicts?: { model: string; findingId: number; missing: "no-verdict" | "batch-failed" }[];
    closingFailure?: string;
  } = {},
): Promise<number> {
  const store = openStore(dbPath);
  const runId = await seedRunRow(
    store,
    {
      owner: meta.owner,
      repo: meta.repo,
      pullNumber: meta.pullNumber,
      headSha: `sha-${meta.pullNumber}-${meta.startedAt}`,
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.rangeReviewId === undefined ? {} : { rangeReviewId: meta.rangeReviewId }),
      startedAt: meta.startedAt,
    },
    findings.map((finding, index) => ({
      file: "src/a.ts",
      line: 5,
      title: "示例",
      severity: "P1" as const,
      category: "bug" as const,
      description: "示例",
      impact: "",
      suggestion: "",
      attributions: [
        {
          model: "model-a",
          severity: "P1" as const,
          category: "bug" as const,
          description: "示例",
          impact: "",
          suggestion: "",
        },
      ],
      groupIndex: index,
      disposition: (finding.disposition ?? "unknown") as never,
      placement: "inline" as never,
      fingerprint: finding.fingerprint,
    })),
    [
      {
        model: "model-a",
        findingCount: findings.length,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
      },
      ...(extra.failedModel === undefined
        ? []
        : [
            {
              model: extra.failedModel,
              failure: "模型服务回了 429",
              findingCount: 0,
              anomalyCount: 0,
              rejectedToolCalls: 0,
              anchorRejections: 0,
              durationMs: 1,
            },
          ]),
    ],
    (extra.verdicts ?? []).map((entry) => ({
      model: entry.model,
      findingId: entry.findingId,
      verdict: "unclear" as const,
      missing: entry.missing,
    })),
  );
  if (extra.closingFailure !== undefined) await store.recordRunFailure(runId, extra.closingFailure);
  await store.close();
  return runId;
}

/** 上一轮落的那条 Finding 的 id:下一轮的复核结论指向它。 */
async function historyFindingId(dbPath: string, runId: number): Promise<number> {
  const store = openStore(dbPath);
  const run = (await store.listRuns({ limit: 50 })).find((item) => item.id === runId);
  await store.close();
  assert.notEqual(run, undefined, `没有这一轮 ${runId}`);
  return run!.findings[0]!.id;
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
  const h = await startPanelHarness();
  await seedRun(
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
  await seedRun(
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
  const latest = await seedRun(
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
  const h = await startPanelHarness();
  await seedRun(h.db.path, {
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
  const h = await startPanelHarness();
  await seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    startedAt: "2026-08-02T00:00:00.000Z",
    title: HARNESS_PR_TITLE,
  });
  await seedRun(h.db.path, {
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
  const h = await startReadyPanelHarness();
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  await confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
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

test("阶段列表:已关闭 pull request 手动重跑后仍是已结束,重开后回到进行中", async () => {
  const h = await startReadyPanelHarness();
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  await confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook("delivery-head")).status, 200);
  await h.settledAtLeast(1);

  assert.equal((await deliver(h, "closed", "delivery-head")).status, 200);
  await h.settledAtLeast(2);
  assert.equal((await stages(h)).stages[0]!.status, "closed");

  const rerun = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
    // 这条用例看的是阶段状态,与模式无关;完整审查那一档不依赖阶段有没有历史。
    mode: "full",
  });
  assert.equal(rerun.status, 202);
  await h.settledAtLeast(3);

  const rerunFinished = (await stages(h)).stages[0]!;
  assert.equal(rerunFinished.status, "closed");
  assert.notEqual(rerunFinished.latestRunFinishedAt, null);

  assert.equal((await deliver(h, "reopened", "delivery-head")).status, 200);
  assert.equal((await stages(h)).stages[0]!.status, "active");
});

test("阶段列表:同一范围审查推进两次只占一行,审查完成后已结束", async () => {
  const h = await startReadyPanelHarness();
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  await confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  const created = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
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
  // 行上的名字是发起时填的标题(issue #177),不是容器 PR 的序号。
  assert.equal(stage.title, "范围审查标题");
  assert.equal(stage.rangeReviewId, rangeReview.id);
  assert.equal(stage.pullNumber, null);
  assert.equal(stage.status, "active");
  const store = openStore(h.db.path);
  const runs = await store.listRuns({ limit: 30, rangeReviewId: rangeReview.id });
  await store.close();
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
  const h = await startPanelHarness();
  // 进行中的 pull request 阶段。
  await seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    startedAt: "2026-08-01T00:00:00.000Z",
  });
  // 已关闭的 pull request 阶段。
  await seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 8,
    startedAt: "2026-08-02T00:00:00.000Z",
  });
  const store = openStore(h.db.path);
  await store.markPullRequestState("acme", "widgets", 8, "closed");
  // 一个进行中、一个已完成的范围审查。
  const running = await store.createRangeReview({
    repoId: GITEA_REPO.id,
    owner: "acme",
    repo: "widgets",
    title: "进行中的范围审查",
    baseSha: "base-sha",
    comparisonSha: "cmp-sha",
    createdBy: "operator",
    createdAt: "2026-08-03T00:00:00.000Z",
  });
  const done = await store.createRangeReview({
    repoId: GITEA_REPO.id,
    owner: "acme",
    repo: "widgets",
    title: "已完成的范围审查",
    baseSha: "base-sha",
    comparisonSha: "cmp-sha",
    createdBy: "operator",
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  await store.completeRangeReview({
    id: done,
    completedBy: "operator",
    completedAt: "2026-08-05T00:00:00.000Z",
  });
  await store.close();

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
  const h = await startPanelHarness();
  for (let i = 1; i <= 32; i += 1) {
    await seedRun(h.db.path, {
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
  const h = await startPanelHarness();
  const runId = await seedRun(
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

/*
 * 最新一轮没跑全时行上挂警示(issue #421)。Run #58 那种一个模型多批 429 的轮次此前
 * 在列表上没有任何痕迹,要点进阶段页翻时间线才看得出来。
 *
 * 判据只看最新一轮:更早那轮出过问题不算——这一格说的是此刻的结论完不完整。
 */
test("阶段列表:最新一轮有批次没跑成,行上挂警示且说的是批次那一档", async () => {
  const h = await startPanelHarness();
  const first = await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
  );
  // 下一轮复核上一轮那条:model-a 的那一批没跑成,这条历史因此没拿到结论。
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
    [],
    {
      verdicts: [
        { model: "model-a", findingId: await historyFindingId(h.db.path, first), missing: "batch-failed" },
      ],
    },
  );

  const body = await stages(h);
  assert.equal(body.stages.length, 1);
  // 部分批次没跑成的模型不算整体失败:两档分开说,排障方向不同。
  assert.deepEqual(body.stages[0]!.latestRunAlert, {
    modelFailed: false,
    batchFailed: true,
    closingFailure: null,
  });
});

test("阶段列表:失败的那一批上没有历史时,批次没跑成由审查轨迹说出来", async () => {
  const h = await startPanelHarness();
  // 头一轮没有历史,复核记录一行都没有;model-a 第 2 批失败只留在批次收尾事件里。
  const runId = await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
  );
  const store = openStore(h.db.path);
  await store.appendTrace(runId, {
    scope: "reviewer",
    reviewer: "model-a",
    kind: "reviewer_batch_finished",
    payload: { batch: 2, failed: true, failure: "429" },
  });
  await store.close();

  const body = await stages(h);
  assert.deepEqual(body.stages[0]!.latestRunAlert, {
    modelFailed: false,
    batchFailed: true,
    closingFailure: null,
  });
});

test("阶段列表:最新一轮有模型整轮没跑成,行上挂警示且说的是模型那一档", async () => {
  const h = await startPanelHarness();
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
    { failedModel: "model-b" },
  );

  const body = await stages(h);
  assert.equal(body.stages.length, 1);
  assert.deepEqual(body.stages[0]!.latestRunAlert, {
    modelFailed: true,
    batchFailed: false,
    closingFailure: null,
  });
});

/*
 * 第三档:Reviewer 都跑成了,轮次却没有正常收尾(ADR 0026,issue #424)。发布 review
 * 失败意味着 Forge 上根本没有这一轮的评论,而这种阶段在列表上此前看着一切正常。
 */
test("阶段列表:最新一轮收尾失败,行上挂警示并带原因第一行", async () => {
  const h = await startPanelHarness();
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
    { closingFailure: "发布 review 失败:Gitea 回了 500\n这一行不进警示" },
  );

  const body = await stages(h);
  assert.equal(body.stages.length, 1);
  // 只取第一行:行上那枚徽章的 title 放得下一句话,放不下一整段堆栈。
  assert.deepEqual(body.stages[0]!.latestRunAlert, {
    modelFailed: false,
    batchFailed: false,
    closingFailure: "发布 review 失败:Gitea 回了 500",
  });
});

test("阶段列表:三档同时出现时各自说得出,阶段详情那一行同形", async () => {
  const h = await startPanelHarness();
  const first = await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
  );
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
    [],
    {
      failedModel: "model-b",
      verdicts: [
        { model: "model-a", findingId: await historyFindingId(h.db.path, first), missing: "batch-failed" },
      ],
      closingFailure: "resolve 旧评论失败",
    },
  );
  const expected = {
    modelFailed: true,
    batchFailed: true,
    closingFailure: "resolve 旧评论失败",
  };

  const body = await stages(h);
  assert.deepEqual(body.stages[0]!.latestRunAlert, expected);
  // 阶段详情里的那一行与列表是同一份形状,警示因此也是同一份。
  const response = await h.api("GET", `/stages/${encodeURIComponent("pr:acme/widgets/7")}`);
  assert.equal(response.status, 200);
  const detail = (await response.json()) as { stage: StageRow };
  assert.deepEqual(detail.stage.latestRunAlert, expected);
});

test("阶段列表:只有更早那轮没跑全时最新一轮干净,行上没有警示", async () => {
  const h = await startPanelHarness();
  const first = await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
    { failedModel: "model-b", closingFailure: "发布 review 失败" },
  );
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-02T00:00:00.000Z" },
    [],
    {
      verdicts: [
        { model: "model-a", findingId: await historyFindingId(h.db.path, first), missing: "batch-failed" },
      ],
    },
  );
  // 第三轮两样都没有:警示只看最新那一轮。
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-03T00:00:00.000Z" },
    [],
  );

  const body = await stages(h);
  assert.equal(body.stages.length, 1);
  assert.equal(body.stages[0]!.latestRunAlert, null);
});

/*
 * 收尾失败那一档是面板直接读给人看的(issue #428):原因原文取不出第一行时,徽章照挂
 * 而悬停说明末尾会是「:」加一段空白。两种写法都落到同一句回落上。
 */
test("阶段列表:收尾失败的原因取头一行有内容的,整篇空白才回落成未记录原因", async () => {
  const h = await startPanelHarness();
  // 以换行开头:第一行是空的。
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 7, startedAt: "2026-08-01T00:00:00.000Z" },
    [{ fingerprint: "fp-1" }],
    { closingFailure: "\n发布 review 失败:Gitea 回了 500" },
  );
  // 通篇只有空白。
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 8, startedAt: "2026-08-02T00:00:00.000Z" },
    [{ fingerprint: "fp-2" }],
    { closingFailure: "   \n  " },
  );
  // 空串。
  await seedRun(
    h.db.path,
    { owner: "acme", repo: "widgets", pullNumber: 9, startedAt: "2026-08-03T00:00:00.000Z" },
    [{ fingerprint: "fp-3" }],
    { closingFailure: "" },
  );

  const body = await stages(h);
  assert.equal(body.stages.length, 3);
  // 取的是头一行有内容的:原因写在第二行时照样读得到,整篇空白才回落。
  const reasons = new Map(
    body.stages.map((stage) => [stage.pullNumber, stage.latestRunAlert?.closingFailure]),
  );
  assert.equal(reasons.get(7), "发布 review 失败:Gitea 回了 500");
  assert.equal(reasons.get(8), "未记录原因");
  assert.equal(reasons.get(9), "未记录原因");
});
