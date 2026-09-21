/**
 * 没给结论的三种由来各自记账(issue #412、#413)。
 *
 * 打在 `runReview` 入口加临时库上:一条历史没拿到结论,可能是这个模型跑了这一批却没给、
 * 这一批根本没跑成,也可能是本轮没有哪一批读到它那个文件——三件事的排障方向不同,时间线
 * 因此分开数。断言落库的 `missing_reason` 与阶段时间线的三个数。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { EVENT, FILES, batchReviewer, query, setup as setupRepo } from "./support/batch-run.ts";

const cleanups = testCleanups();

/** 这一轮的三个数:时间线上一轮要说清没给结论的那些各自是怎么来的。 */
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
      uncoveredVerdicts: latest.uncoveredVerdicts,
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

test("跑了没给、批次跑不成与本轮没审到,三种由来各自记账", async () => {
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
    uncoveredVerdicts: 0,
  });
});

test("文件不在本轮任何批次里的那条历史记「没有批次覆盖」,不混进漏复核", async () => {
  const fixture = setupRepo(cleanups);
  // 一个文件一批:历史因此按所在文件路由到批次(issue #235),不分批时全部历史进那唯一
  // 一批,「不在任何批次里」这件事本身不成立。
  const common = {
    forge: fixture.forge.forge,
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
  };

  // 头一轮三个文件各留一条未处置历史。
  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });

  // 第二轮只改前两个文件:第三个文件上那条历史因此不在任何批次里。开跑时的「文件已回退」
  // 自动处置写 Forge 失败,它按现有规则留给人——这正是这一档的触发条件。
  const forge = fixture.forge.forge;
  forge.listChangedFiles = async () =>
    [FILES[0]!, FILES[1]!].map((path) => ({ path, status: "modified" as const }));
  forge.resolveComment = async () => {
    throw new Error("Forge 挂了");
  };

  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-b")] });

  const store = openStore(fixture.db.path);
  const runId = store.listRuns({ limit: 1 })[0]!.id;
  store.close();

  assert.deepEqual(reasons(fixture.db.path, runId), { "no-batch": 1 });
  assert.deepEqual(verdictCounts(fixture.db.path), {
    missedVerdicts: 0,
    batchFailedVerdicts: 0,
    uncoveredVerdicts: 1,
  });
});
