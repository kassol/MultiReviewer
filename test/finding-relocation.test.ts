/**
 * 每轮 Review Run 开跑时的位置重定位(issue #368)。
 *
 * 一条 Finding 的行号只有对着算出它的那个 head 才成立。作者在它上面插几行再推一次,
 * 旧行号在新 head 上就指着别的代码;这一票让每一轮开跑时按内容指纹把位置挪到本轮的
 * head 上,并把位置属于哪一轮一并记下。
 *
 * 两段断言:库那一层(`relocationCandidates` 选谁、`recordFindingRelocations` 动了哪几列、
 * 阶段汇总读回什么),以及 `runReview` 入口那一层(脚本化 Reviewer 加真实 git 夹具)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "../src/review/run.ts";
import { openStore, type StageScope, type StageSummary } from "../src/review/store.ts";
import { query } from "./support/batch-run.ts";
import {
  asPublished,
  disposeInPanel,
  EVENT,
  HEAD,
  SAME_LINE_CHANGE,
  setup,
  SILENT,
} from "./support/cross-run.ts";
import { makeDbPath, seedRun, testCleanups } from "./support/git-fixture.ts";
import { verdictReviewer } from "./support/memory-forge.ts";

const SCOPE: StageScope = { owner: EVENT.owner, repo: EVENT.repo, pullNumber: EVENT.number };

function summaryOf(dbPath: string): StageSummary {
  const store = openStore(dbPath);
  try {
    return store.stageSummary(SCOPE);
  } finally {
    store.close();
  }
}

/** 落库的两列重定位结果,按行 id 升序。 */
function placedRows(dbPath: string): { line: unknown; runId: unknown }[] {
  return query(dbPath, "SELECT placed_line, placed_run_id FROM finding ORDER BY id").map((row) => ({
    line: row["placed_line"],
    runId: row["placed_run_id"],
  }));
}

// —— 库那一层 ——

/** 一行落库形状的 Finding:同一个评论 id 即同一条 Finding Identity(`identityKey`)。 */
function findingRow(line: number, fingerprint: string, commentId: string) {
  return {
    file: "src/calc.js",
    line,
    title: "sub 多减了 1",
    severity: "P0" as const,
    category: "bug" as const,
    description: "sub 多减了 1",
    impact: "",
    suggestion: "",
    attributions: [
      {
        model: "model-a",
        severity: "P0" as const,
        category: "bug" as const,
        description: "sub 多减了 1",
        impact: "",
        suggestion: "",
      },
    ],
    groupIndex: 0,
    disposition: "unknown" as never,
    placement: "inline" as never,
    fingerprint,
    commentId,
    commentHtmlUrl: `https://gitea.example.test/comment/${commentId}`,
  };
}

/** 两轮各落一行、同属一条 Identity 的阶段。返回两轮的 id。 */
function seedTwoRounds(dbPath: string): { first: number; second: number } {
  const store = openStore(dbPath);
  try {
    const first = seedRun(
      store,
      { ...EVENT, pullNumber: EVENT.number, headSha: "a".repeat(40), startedAt: "2026-09-18T00:00:00.000Z" },
      [findingRow(6, "f".repeat(64), "c-1")],
    );
    const second = seedRun(
      store,
      { ...EVENT, pullNumber: EVENT.number, headSha: "b".repeat(40), startedAt: "2026-09-18T01:00:00.000Z" },
      [findingRow(6, "f".repeat(64), "c-1")],
    );
    return { first, second };
  } finally {
    store.close();
  }
}

test("重定位候选只有每条 Identity 的最新一行,已处置的照样在里面", () => {
  const db = makeDbPath();
  testCleanups().push(db.cleanup);
  const { second } = seedTwoRounds(db.path);
  // 已处置的既进不了复核也进不了延续,不在这里挪位置就永远停在报出它的那一轮上。
  disposeInPanel(db.path, "c-1", "resolved");

  const store = openStore(db.path);
  const candidates = store.relocationCandidates(SCOPE);
  store.close();

  const rows = query(db.path, "SELECT id, run_id FROM finding ORDER BY id");
  assert.equal(rows.length, 2);
  assert.deepEqual(candidates, [
    {
      findingId: Number(rows[1]!["id"]),
      file: "src/calc.js",
      line: 6,
      fingerprint: "f".repeat(64),
    },
  ]);
  assert.equal(Number(rows[1]!["run_id"]), second);
});

test("重定位只写 placed_line / placed_run_id,报出位置、归属与评论载体一格不动", () => {
  const db = makeDbPath();
  testCleanups().push(db.cleanup);
  const { first, second } = seedTwoRounds(db.path);
  const before = query(
    db.path,
    "SELECT id, run_id, line, comment_id FROM finding ORDER BY id",
  );
  const attributionsBefore = query(
    db.path,
    "SELECT finding_id, model, description FROM finding_attribution ORDER BY finding_id",
  );
  const latestId = Number(before[1]!["id"]);

  const store = openStore(db.path);
  store.recordFindingRelocations(second, [{ findingId: latestId, line: 16 }]);
  store.close();

  // 报出位置、所属轮次与评论载体逐字不动:归属、首次报出与指纹窗口都按那一份算。
  assert.deepEqual(
    query(db.path, "SELECT id, run_id, line, comment_id FROM finding ORDER BY id"),
    before,
  );
  assert.deepEqual(
    query(
      db.path,
      "SELECT finding_id, model, description FROM finding_attribution ORDER BY finding_id",
    ),
    attributionsBefore,
  );
  // 两列只落在最新那一行上,旧行不动。
  assert.deepEqual(placedRows(db.path), [
    { line: null, runId: null },
    { line: 16, runId: second },
  ]);

  const summary = summaryOf(db.path);
  assert.equal(summary.findings.length, 1);
  const [finding] = summary.findings;
  assert.equal(finding!.line, 16);
  assert.equal(finding!.reportedLine, 6);
  assert.equal(finding!.placedRunId, second);
  // 报出位置的所属轮次不受重定位影响:这一行本就是在 second 那一轮报出的。
  assert.equal(finding!.lastRunId, second);
  assert.equal(finding!.firstRunId, first);
});

// —— `runReview` 入口那一层 ——

/** 在 `src/calc.js` 上方插 10 行:第 6 行那扇窗口原样不动,只是整体下移到第 16 行。 */
const PADDED = `${Array.from({ length: 10 }, (_, i) => `export const pad${i} = ${i};`).join(
  "\n",
)}\n${HEAD}`;

/** 重定位之后那条 Finding 落在第几行。 */
const SHIFTED_LINE = 16;

test("只复核那一轮:代码只是下移时位置跟到本轮,不落新行、不改处置", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": PADDED });
  await runReview(EVENT, { ...deps, reviewers: SILENT, mode: "verdict-only" });

  const summary = summaryOf(db.path);
  const [first, second] = summary.timeline;
  assert.notEqual(second, undefined, "第二轮没有开出来");
  assert.equal(summary.findings.length, 1);
  const [finding] = summary.findings;
  assert.equal(finding!.line, SHIFTED_LINE);
  assert.equal(finding!.reportedLine, 6);
  assert.equal(finding!.placedRunId, second!.runId);
  // 只复核那一轮没报新的,这条 Finding 报出的仍是第一轮;重定位只挪位置,不改报出轮次。
  assert.equal(finding!.lastRunId, first!.runId);
  assert.equal(finding!.firstRunId, first!.runId);
  // 回填读回的是 Forge 上那条未 resolve 的评论,处置值因此仍是人没碰过的那一档。
  assert.equal(finding!.disposition, "unresolved");

  // 重定位不建行:这一轮一条 Finding 都没报出。
  assert.equal(query(db.path, "SELECT id FROM finding").length, 1);
  // 本轮各 Reviewer 一条结论都没给,按漏复核落库(ADR 0016),处置因此一格未动。
  assert.deepEqual(
    query(db.path, "SELECT verdict, missing FROM finding_verdict").map((row) => ({
      verdict: row["verdict"],
      missing: row["missing"],
    })),
    [{ verdict: "unclear", missing: 1 }],
  );
  assert.deepEqual(forge.resolvedIds, []);
});

test("已处置的那条同样跟着本轮走", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, true));
  disposeInPanel(db.path, forge.publishedComments[0]!.id, "resolved");
  // 已处置之后这个阶段没有未处置历史,只复核那一轮开不起来(CONTEXT.md 只复核),
  // 这一档因此跑完整审查:两种模式都做重定位。
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": PADDED });
  await runReview(EVENT, { ...deps, reviewers: SILENT });

  const summary = summaryOf(db.path);
  const [finding] = summary.findings;
  assert.equal(finding!.line, SHIFTED_LINE);
  assert.equal(finding!.reportedLine, 6);
  assert.equal(finding!.placedRunId, summary.timeline[1]!.runId);
  // 报出的仍是第一轮:第二轮只做了重定位与自动处置,没有新报。
  assert.equal(finding!.lastRunId, summary.timeline[0]!.runId);
  assert.equal(finding!.disposition, "resolved");
  assert.equal(query(db.path, "SELECT id FROM finding").length, 1);
});

test("那处代码被改写、复核又判无法判断时,位置与所属轮次都不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });
  await runReview(EVENT, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "unclear")],
    mode: "verdict-only",
  });

  const summary = summaryOf(db.path);
  const [finding] = summary.findings;
  assert.equal(finding!.line, 6);
  assert.equal(finding!.placedRunId, summary.timeline[0]!.runId);
  // 没重定位过,位置所属轮次退回报出那一轮,两格同值。
  assert.equal(finding!.lastRunId, summary.timeline[0]!.runId);
  assert.deepEqual(placedRows(db.path), [{ line: null, runId: null }]);
});
