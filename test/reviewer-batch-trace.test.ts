/**
 * 每个 Reviewer × 批次一条收尾事件(issue #408)。
 *
 * 打在 `runReview` 入口上(先例 `review-trace`、`batching`):三个文件切成三批,脚本化
 * Reviewer 一批给全结论、一批漏给、一批失败,断言这三条事件的字段。轮次级的那条收尾
 * (`reviewer_finished`)不在本文件的断言里——它一轮只有一条,与分批无关。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reviewer, ReviewerUsage } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store/index.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { EVENT, FILES, batchReviewer, query, setup as setupRepo } from "./support/batch-run.ts";
import { verdictReviewer } from "./support/memory-forge.ts";

const cleanups = testCleanups();

const USAGE: ReviewerUsage = {
  inputTokens: 40,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 47,
};

/** 三个文件各成一批:一批的结果因此就是一个文件的结果,断言不必猜谁和谁同批。 */
function deps(fixture: Awaited<ReturnType<typeof setupRepo>>) {
  return {
    forge: fixture.forge.forge,
    cacheDir: fixture.cache.dir,
    store: openStore(fixture.db.url),
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
  };
}

/** 这一轮落库的全部 `reviewer_batch_finished`,按批次序号排。 */
async function batchFinished(databaseUrl: string): Promise<{ reviewer: string; payload: Record<string, unknown> }[]> {
  const store = openStore(databaseUrl);
  const runId = (await store.listRuns({ limit: 1 }))[0]!.id;
  return (await store
    .listTrace(runId))
    .filter((event) => event.kind === "reviewer_batch_finished")
    .map((event) => ({
      reviewer: event.reviewer!,
      payload: event.payload as Record<string, unknown>,
    }))
    .sort((a, b) => (a.payload["batch"] as number) - (b.payload["batch"] as number));
}

/** 耗时每次都不一样,单独判类型再从载荷里摘掉,剩下的整份比对。 */
function withoutDuration(payload: Record<string, unknown>): Record<string, unknown> {
  assert.equal(typeof payload["durationMs"], "number", "收尾事件要带这一批的墙上耗时");
  const { durationMs: _, ...rest } = payload;
  return rest;
}

/**
 * 按本批文件定制这一批的结果:第一批报一条并给全结论、第二批一条结论都不给、第三批失败。
 * 脚本化 Reviewer 一轮只有一份结果,而这一票要看的恰是几批之间的差别。
 */
function perBatchReviewer(model: string): Reviewer {
  return {
    model,
    review: async ({ range, history, onEvent }) => {
      const file = range.files[0]!;
      const base = { model, anomalies: [], rejectedToolCalls: 0, anchorRejections: 0 };
      if (file === FILES[2]) {
        return { ...base, findings: [], failure: "子进程退出码 7", exitCode: 7 };
      }
      if (file === FILES[1]) return { ...base, findings: [], usage: USAGE };
      // 第一批:两次工具调用 + 一条报出 + 逐条结论,收尾事件的每一格都有非零值可断言。
      for (const tool of ["read", "grep"]) {
        onEvent?.({
          kind: "tool_call",
          tool,
          args: { path: file },
          durationMs: 1,
          isError: false,
          error: null,
          resultLength: 8,
        });
      }
      return {
        ...base,
        findings: [
          {
            file,
            line: 4,
            severity: "P0" as const,
            category: "bug" as const,
            title: "新的问题",
            description: "新的问题",
            impact: "",
            suggestion: "",
            model,
          },
        ],
        anchorRejections: 2,
        usage: USAGE,
        verdicts: history.map((entry) => ({ findingId: entry.id, verdict: "present" as const })),
      };
    },
  };
}

test("每个 Reviewer × 批次一条收尾事件:给全结论、漏给结论与失败三档各带自己的字段", async () => {
  const fixture = (await setupRepo(cleanups));
  const common = deps(fixture);

  // 头一轮三个文件各留一条历史,第二轮每一批因此恰好要复核一条。
  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });
  await runReview(EVENT, { ...common, reviewers: [perBatchReviewer("model-a")] });

  const events = await batchFinished(fixture.db.url);
  assert.equal(events.length, 3, "三批各一条,失败的那一批同样有");
  assert.ok(
    events.every((event) => event.reviewer === "model-a"),
    "每条都要认得出是哪个模型的",
  );

  assert.deepEqual(withoutDuration(events[0]!.payload), {
    batch: 1,
    failed: false,
    failure: null,
    exitCode: null,
    stopReason: null,
    turns: null,
    toolCalls: 2,
    findings: 1,
    rejectedToolCalls: 0,
    anchorRejections: 2,
    verdictsGiven: 1,
    verdictsExpected: 1,
    usage: USAGE,
  });

  // 漏给结论的那一批:给出少于应给,面板据这两个数标警示色。
  assert.deepEqual(withoutDuration(events[1]!.payload), {
    batch: 2,
    failed: false,
    failure: null,
    exitCode: null,
    stopReason: null,
    turns: null,
    toolCalls: 0,
    findings: 0,
    rejectedToolCalls: 0,
    anchorRejections: 0,
    verdictsGiven: 0,
    verdictsExpected: 1,
    usage: USAGE,
  });

  // 失败那一批的原因与退出码在这一批结束时就进轨迹,不必等整轮结束。
  assert.deepEqual(withoutDuration(events[2]!.payload), {
    batch: 3,
    failed: true,
    failure: "子进程退出码 7",
    exitCode: 7,
    stopReason: null,
    turns: null,
    toolCalls: 0,
    findings: 0,
    rejectedToolCalls: 0,
    anchorRejections: 0,
    verdictsGiven: 0,
    verdictsExpected: 1,
    usage: null,
  });
});

test("漏给结论的条数与 finding_verdict 里记「跑了没给」的对得上", async () => {
  const fixture = (await setupRepo(cleanups));
  const common = deps(fixture);

  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });
  await runReview(EVENT, { ...common, reviewers: [perBatchReviewer("model-a")] });

  const store = openStore(fixture.db.url);
  const runId = (await store.listRuns({ limit: 1 }))[0]!.id;
  const batchEnds = (await store
    .listTrace(runId))
    .filter((event) => event.kind === "reviewer_batch_finished")
    .map((event) => event.payload as Record<string, number | boolean>);

  // 跑完了却没给的那些:失败的那一批不算,它没跑。
  const skipped = batchEnds
    .filter((payload) => payload["failed"] !== true)
    .reduce(
      (sum, payload) =>
        sum + ((payload["verdictsExpected"] as number) - (payload["verdictsGiven"] as number)),
      0,
    );
  assert.equal(skipped, 1, "第二批那一条历史没拿到结论");

  // 「跑了没给」只数非失败批的那部分(issue #412),两边逐条对得上;失败那一批的历史另记
  // 一档「批次跑不成」,不混进漏复核——它说的是模型服务或额度,不是模型有没有认真复核。
  // 失败批这一侧对的是「应给」而不是「应给 − 给出」(issue #420):那一批给过的结论在合并
  // 时整份丢掉,它的历史因此一条不落地全记「批次跑不成」,而事件里的「给出」照实记。
  const failedExpected = batchEnds
    .filter((payload) => payload["failed"] === true)
    .reduce((sum, payload) => sum + (payload["verdictsExpected"] as number), 0);
  const [row] = (await query(
    fixture.db.url,
    // PostgreSQL 的 SUM 不收布尔:计数改写成 COUNT + FILTER。
    `SELECT COUNT(*) FILTER (WHERE missing_reason = 'no-verdict') AS missed,
            COUNT(*) FILTER (WHERE missing_reason = 'batch-failed') AS "batchFailed"
       FROM finding_verdict WHERE run_id = ${runId}`,
  ));
  assert.equal(row!["missed"], skipped);
  assert.equal(row!["batchFailed"], failedExpected);
});

test("只复核那一轮的批次同样落这条事件,报出条数恒为 0", async () => {
  const fixture = (await setupRepo(cleanups));
  const common = deps(fixture);

  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });
  await runReview(EVENT, {
    ...common,
    mode: "verdict-only",
    // 只复核那一轮的 Reviewer 不注册报出工具,一条都报不出来。
    reviewers: [verdictReviewer("model-b", "present")],
  });

  const events = await batchFinished(fixture.db.url);
  assert.deepEqual(
    events.map((event) => ({
      batch: event.payload["batch"],
      findings: event.payload["findings"],
      verdictsGiven: event.payload["verdictsGiven"],
      verdictsExpected: event.payload["verdictsExpected"],
    })),
    [
      { batch: 1, findings: 0, verdictsGiven: 1, verdictsExpected: 1 },
      { batch: 2, findings: 0, verdictsGiven: 1, verdictsExpected: 1 },
      { batch: 3, findings: 0, verdictsGiven: 1, verdictsExpected: 1 },
    ],
  );
});
