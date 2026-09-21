/**
 * 没给结论的三种由来各自记账(issue #412、#413)。
 *
 * 打在 `runReview` 入口加临时库上:一条历史没拿到结论,可能是这个模型跑了这一批却没给、
 * 这一批根本没跑成,也可能是本轮没有哪一批读到它那个文件——三件事的排障方向不同,时间线
 * 因此分开数。断言落库的 `missing_reason` 与阶段时间线的三个数。
 *
 * 失败批在倒下之前给出的结论一并丢弃(issue #420),那几条历史因此同样落进「批次没跑成」:
 * 后两条用例打在这个丢弃上——不作自动处置的证据,也不触发延续。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { EVENT, FILES, STUB, batchReviewer, query, setup as setupRepo } from "./support/batch-run.ts";

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

/** 一个仓库三批、一批一个文件:历史因此一条一批,失败的是哪一批一目了然。 */
function perFileBatches(fixture: ReturnType<typeof setupRepo>) {
  return {
    forge: fixture.forge.forge,
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
    maxChangedLinesPerBatch: 100,
    maxFilesPerBatch: 1,
  };
}

/**
 * 第三批(`FILES[2]`)在倒下之前给出结论,另两批照常跑完(issue #420)。结论与失败同一次
 * 返回:一批跑到一半 429 的模型在注入边界上就是这个形状。`line` 给了就是「仍在」一并给出的
 * 新位置。本轮一条都不报出,`finding` 表里因此只有头一轮那三行。
 */
function failingBatchReviewer(model: string, verdict: "fixed" | "present", line?: number): Reviewer {
  return {
    model,
    review: async ({ range, history }) => {
      const base = { model, findings: [], anomalies: [], rejectedToolCalls: 0, anchorRejections: 0 };
      if (range.files[0] !== FILES[2]) {
        return {
          ...base,
          verdicts: history.map((entry) => ({ findingId: entry.id, verdict: "present" as const })),
        };
      }
      return {
        ...base,
        verdicts: history.map((entry) => ({
          findingId: entry.id,
          verdict,
          ...(line === undefined ? {} : { line }),
        })),
        failure: "子进程退出码 7",
        exitCode: 7,
      };
    },
  };
}

/** 这一轮的 run id。 */
function latestRunId(dbPath: string): number {
  const store = openStore(dbPath);
  try {
    return store.listRuns({ limit: 1 })[0]!.id;
  } finally {
    store.close();
  }
}

/** 库里每条 Finding 的处置与延续来源,按文件。`node:sqlite` 的行是空原型,逐格抄出来再比。 */
function findingRows(dbPath: string): { file: string; disposition: string; continuedFrom: unknown }[] {
  return query(dbPath, "SELECT file, disposition, continued_from FROM finding ORDER BY file").map(
    (row) => ({
      file: String(row["file"]),
      disposition: String(row["disposition"]),
      continuedFrom: row["continued_from"],
    }),
  );
}

/** 三个文件各一条未处置历史,一条都没被处置、也没被交接走。 */
const UNTOUCHED = FILES.map((file) => ({
  file,
  disposition: "unknown",
  continuedFrom: null,
}));

test("失败批在倒下之前给出的「已修」不作自动处置的证据,由来记「批次没跑成」", async () => {
  const fixture = setupRepo(cleanups);
  const common = perFileBatches(fixture);

  // 头一轮三个文件各留一条未处置历史,第二轮每一批因此恰好要复核一条。
  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });
  await runReview(EVENT, { ...common, reviewers: [failingBatchReviewer("model-a", "fixed")] });

  assert.deepEqual(reasons(fixture.db.path, latestRunId(fixture.db.path)), { "batch-failed": 1 });
  assert.deepEqual(fixture.forge.resolvedIds, [], "失败批的「已修」却把 Forge 上的评论关掉了");
  assert.deepEqual(findingRows(fixture.db.path), UNTOUCHED);
});

test("失败批带新位置的「仍在」不触发延续:旧评论不关,不合成承接它的那条", async () => {
  const fixture = setupRepo(cleanups);
  const common = perFileBatches(fixture);

  await runReview(EVENT, { ...common, reviewers: [batchReviewer("model-a")] });
  // 改掉 `FILES[2]` 上那条 Finding 指着的第 4 行:它的指纹在新 head 上算不出,延续的前置
  // 条件因此成立——结论要是没被丢掉,这一条就会被承接到第 5 行去。
  fixture.forge.pullRequest.headSha = fixture.repo.pushToHead({
    [FILES[2]!]: `${STUB}const x = 2;\nconst y = 1;\n`,
  });

  await runReview(EVENT, {
    ...common,
    reviewers: [failingBatchReviewer("model-a", "present", 5)],
  });

  assert.deepEqual(reasons(fixture.db.path, latestRunId(fixture.db.path)), { "batch-failed": 1 });
  assert.deepEqual(fixture.forge.resolvedIds, [], "延续把旧评论关掉了");
  assert.deepEqual(findingRows(fixture.db.path), UNTOUCHED);
});
