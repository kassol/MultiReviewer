/**
 * 没给结论的由来各自记账(issue #412)。
 *
 * 打在 `runReview` 入口加临时库上:一条历史没拿到结论,可能是这个模型跑了这一批却没给,
 * 也可能是这一批根本没跑成——前者是模型行为,后者是模型服务或额度,排障方向不同,时间线
 * 因此分开数。断言落库的 `missing_reason` 与阶段时间线的两个数。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { EVENT, FILES, batchReviewer, query, setup as setupRepo } from "./support/batch-run.ts";

const cleanups = testCleanups();

/** 这一轮的两个数:时间线上一轮要说清没给结论的那些各自是怎么来的。 */
function verdictCounts(dbPath: string) {
  const store = openStore(dbPath);
  try {
    const timeline = store.stageSummary({
      owner: EVENT.owner,
      repo: EVENT.repo,
      pullNumber: EVENT.number,
    }).timeline;
    const latest = timeline[timeline.length - 1]!;
    return {
      missedVerdicts: latest.missedVerdicts,
      batchFailedVerdicts: latest.batchFailedVerdicts,
    };
  } finally {
    store.close();
  }
}

/** 库里这一轮每种由来各几行。给了结论的那些不在这份结果里。 */
function reasons(dbPath: string, runId: number): Record<string, number> {
  const rows = query(
    dbPath,
    `SELECT missing_reason AS reason, COUNT(*) AS n
       FROM finding_verdict
      WHERE run_id = ${runId} AND missing = 1
      GROUP BY missing_reason`,
  );
  return Object.fromEntries(rows.map((row) => [String(row["reason"]), Number(row["n"])]));
}

/** 按本批文件定制:第一批给全结论、第二批一条不给、第三批跑不成。 */
function perBatchReviewer(model: string): Reviewer {
  return {
    model,
    review: async ({ range, history }) => {
      const file = range.files[0]!;
      const base = { model, findings: [], anomalies: [], rejectedToolCalls: 0, anchorRejections: 0 };
      if (file === FILES[2]) return { ...base, failure: "子进程退出码 7", exitCode: 7 };
      if (file === FILES[1]) return base;
      return {
        ...base,
        verdicts: history.map((entry) => ({ findingId: entry.id, verdict: "present" as const })),
      };
    },
  };
}

test("跑了没给与批次跑不成各自记账,后者不混进漏复核", async () => {
  const fixture = setupRepo(cleanups);
  const common = {
    forge: fixture.forge.forge,
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
  };

  // 头一轮三个文件各留一条历史,第二轮每一批因此恰好要复核一条。
  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });
  await runReview(EVENT, { ...common, reviewers: [perBatchReviewer("model-a")] });

  const store = openStore(fixture.db.path);
  const runId = store.listRuns({ limit: 1 })[0]!.id;
  store.close();

  assert.deepEqual(reasons(fixture.db.path, runId), {
    "no-verdict": 1,
    "batch-failed": 1,
  });
  assert.deepEqual(verdictCounts(fixture.db.path), {
    missedVerdicts: 1,
    batchFailedVerdicts: 1,
  });
});
