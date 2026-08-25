/**
 * 统计 API(issue #36):口径与 store 同源,库体量与实际文件一致。口径本身的表格
 * 驱动测试在 `disposition-stats.test.ts`,这里验 HTTP 缝上的打包与默认窗口。
 */
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import { startPanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

test("统计 API:折叠后的矩阵、默认窗口与库体量", async () => {
  const h = await startPanelHarness(cleanups);

  const seed = openStore(h.db.path);
  const runId = seed.startRun({
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    headSha: "sha-1",
    startedAt: "2026-08-10T00:00:00.000Z",
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  seed.finishRun(runId, {
    finishedAt: "2026-08-10T00:01:00.000Z",
    durationMs: 1,
    failed: false,
    outcomes: [
      {
        model: "model-a",
        findingCount: 1,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
        usage: {
          inputTokens: 8,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 10,
          costUsd: 0.125,
          knownCostUsd: 0.125,
          costSource: "trusted",
        },
      },
      {
        model: "model-b",
        findingCount: 0,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
        usage: {
          inputTokens: 15,
          outputTokens: 3,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          totalTokens: 20,
          costUsd: null,
          knownCostUsd: 0,
          costSource: "unknown",
        },
      },
    ],
    findings: [
      {
        model: "model-a",
        file: "src/a.ts",
        line: 5,
        severity: "P0",
        category: "bug",
        description: "有毛病",
        groupIndex: 0,
        disposition: "resolved",
        placement: "inline",
        fingerprint: "fp-1",
      },
      // 「已改动」自动处置(ADR 0013):与人工处置分列,分母口径不变。
      {
        model: "model-a",
        file: "src/a.ts",
        line: 20,
        severity: "P1",
        category: "bug",
        description: "另一处已经改掉了",
        groupIndex: 1,
        disposition: "changed",
        placement: "inline",
        fingerprint: "fp-2",
      },
    ],
  });
  const secondRunId = seed.startRun({
    owner: "acme",
    repo: "widgets",
    pullNumber: 8,
    headSha: "sha-2",
    startedAt: "2026-08-11T00:00:00.000Z",
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  seed.finishRun(secondRunId, {
    finishedAt: "2026-08-11T00:01:00.000Z",
    durationMs: 1,
    failed: false,
    outcomes: [
      {
        model: "model-a",
        findingCount: 0,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
        usage: {
          inputTokens: 4,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 5,
          costUsd: 0.25,
          knownCostUsd: 0.25,
          costSource: "trusted",
        },
      },
    ],
    findings: [],
  });
  seed.close();

  const response = await h.api(
    "GET",
    "/stats?from=2000-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    cells: unknown[];
    usage: {
      totalTokens: number;
      costUsd: number | null;
      knownCostUsd: number;
      costIncomplete: boolean;
      unknownCostReviewers: number;
    } | null;
    database: { fileBytes: number; tables: { name: string; rows: number }[] };
  };
  assert.deepEqual(body.cells, [
    {
      model: "model-a",
      category: "bug",
      resolved: 1,
      changed: 1,
      unresolved: 0,
      unknownClosed: 0,
      unknownOpen: 0,
    },
  ]);
  assert.deepEqual(body.usage, {
    inputTokens: 27,
    outputTokens: 6,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 35,
    costUsd: null,
    knownCostUsd: 0.375,
    costSource: "unknown",
    costIncomplete: true,
    unknownCostReviewers: 1,
  });

  // 库体量与实际文件一致;行数与刚种进去的数据对得上。
  assert.equal(body.database.fileBytes, statSync(h.db.path).size);
  const rows = new Map(body.database.tables.map((table) => [table.name, table.rows]));
  assert.equal(rows.get("finding"), 2);
  assert.equal(rows.get("review_run"), 2);
  assert.ok(rows.has("webhook_delivery"));
  assert.ok(rows.has("repo_key"));
  // 无参数时默认最近 30 天,窗口边界原样回显。
  const dflt = await h.api("GET", "/stats");
  assert.equal(dflt.status, 200);
  const defaults = (await dflt.json()) as { from: string; to: string };
  const spanDays =
    (Date.parse(defaults.to) - Date.parse(defaults.from)) / (24 * 60 * 60 * 1000);
  assert.equal(Math.round(spanDays), 30);

  // 窗口参数解析不了要显形,不是静默回落。
  assert.equal((await h.api("GET", "/stats?from=nonsense")).status, 400);
});
