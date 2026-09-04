/**
 * 按批次落库与服务重启后的续跑(issue #248)。
 *
 * 一批跑完就落库,重启后只补缺结果的批次,收尾仍只做一次合并与发评论。中断期间有人
 * 处置了历史也不影响续跑批次拿到的历史——那是开跑时落的快照。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type {
  Finding,
  HistoryFinding,
  ReviewRange,
  Reviewer,
  ReviewerUsage,
} from "../src/review/finding.ts";
import { RESUME_NOT_VIABLE, runReview } from "../src/review/run.ts";
import type { FileTree } from "./support/git-fixture.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge } from "./support/memory-forge.ts";

const EVENT = { owner: "acme", repo: "widgets", number: 7 };
const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
const STUB = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
/** 每批都回同一份用量。三批合起来的总量因此是它的三倍,续跑前后必须一致。 */
const USAGE: ReviewerUsage = {
  inputTokens: 10,
  outputTokens: 3,
  cacheReadTokens: 1,
  cacheWriteTokens: 2,
  totalTokens: 16,
};

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** base 是三行的桩,head 追加两行,第 4 行因此是每个文件的首个新增行。 */
function trees(): { base: FileTree; head: FileTree } {
  const base: FileTree = {};
  const head: FileTree = {};
  for (const path of FILES) {
    base[path] = STUB;
    head[path] = `${STUB}const x = 0;\nconst y = 1;\n`;
  }
  return { base, head };
}

function setup() {
  const { base, head } = trees();
  const repo = makeRepo({ base, head });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);
  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: FILES.map((path) => ({ path, status: "modified" as const })),
  });
  return { repo, cache, db, forge };
}

function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function findingAt(file: string): Omit<Finding, "model"> {
  return {
    file,
    line: 4,
    severity: "P0",
    category: "bug",
    title: `${file} 有问题`,
    description: `${file} 的第一处新增行有问题`,
    impact: "",
    suggestion: "",
  };
}

/**
 * 一批报一条 Finding 的 Reviewer 桩。`throwOnCall` 给了就在第几次调用时抛——用它模拟
 * 服务在那一批上被重启:前面的批次已经落库,这一轮停在没有结束时间的状态。
 */
function batchReviewer(
  model: string,
  options: { throwOnCall?: number } = {},
): Reviewer & { calls: { range: ReviewRange; history: readonly HistoryFinding[] }[] } {
  const calls: { range: ReviewRange; history: readonly HistoryFinding[] }[] = [];
  return {
    model,
    calls,
    review: async ({ range, history }) => {
      calls.push({ range, history });
      if (options.throwOnCall === calls.length) throw new Error("进程被重启了");
      return {
        model,
        findings: range.files.map((file) => ({ ...findingAt(file), model })),
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        usage: USAGE,
        verdicts: history.map((entry) => ({ findingId: entry.id, verdict: "present" as const })),
      };
    },
  };
}

/** 一批一个文件、一次只跑一批:批次序号与文件一一对应,断言因此读得懂。 */
function deps(
  fixture: ReturnType<typeof setup>,
  reviewers: readonly Reviewer[],
  extra: { resumeRunId?: number } = {},
) {
  return {
    forge: fixture.forge.forge,
    reviewers,
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
    maxFilesPerBatch: 1,
    maxParallelBatches: 1,
    ...extra,
  };
}

test("三批跑到第二批后被打断,续跑只调第三批,结果与不中断时一致", async () => {
  const fixture = setup();
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });

  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);

  // 前两批的结果已经落库,这一轮停在没有结束时间的状态。
  const [run] = query(fixture.db.path, "SELECT id, finished_at, batch_count FROM review_run");
  assert.equal(run?.["finished_at"], null);
  assert.equal(run?.["batch_count"], 3);
  const stored = query(
    fixture.db.path,
    "SELECT batch_index, files_json FROM review_run_batch ORDER BY batch_index",
  );
  assert.deepEqual(
    stored.map((row) => [row["batch_index"], JSON.parse(String(row["files_json"]))]),
    [
      [0, ["src/a.ts"]],
      [1, ["src/b.ts"]],
    ],
  );
  // 中间态不进任何分母:收尾还没跑,逐模型结果与 Finding 一行都没有。
  assert.equal(query(fixture.db.path, "SELECT id FROM reviewer_outcome").length, 0);
  assert.equal(query(fixture.db.path, "SELECT id FROM finding").length, 0);

  const runId = Number(run?.["id"]);
  const resumed = batchReviewer("model-a");
  const result = await runReview(EVENT, deps(fixture, [resumed], { resumeRunId: runId }));

  // 只有第三批被调用一次,前两批一次都没重跑。
  assert.deepEqual(
    resumed.calls.map((call) => call.range.files),
    [["src/c.ts"]],
  );

  // 沿用原轮次的编号,收尾正常结束。
  const [after] = query(
    fixture.db.path,
    "SELECT id, failed, finished_at, total_tokens FROM review_run",
  );
  assert.equal(Number(after?.["id"]), runId);
  assert.equal(after?.["failed"], 0);
  assert.notEqual(after?.["finished_at"], null);
  // 三批的用量都在,前两批的没有因为重启丢掉。
  assert.equal(after?.["total_tokens"], USAGE.totalTokens * 3);
  assert.equal(result.failed, false);
  assert.deepEqual(
    result.findings.map((finding) => finding.file),
    FILES,
  );
  // 一轮只发一次 review,三条行级评论。
  assert.equal(fixture.forge.createdReviews.length, 1);
  assert.deepEqual(
    fixture.forge.createdReviews[0]?.comments.map((comment) => comment.path),
    FILES,
  );
  // 收尾之后中间态清空:这张表只服务还没收尾的那一轮。
  assert.equal(query(fixture.db.path, "SELECT run_id FROM review_run_batch").length, 0);

  // 批次里程碑接着原轮次追加,序号连续。
  const milestones = query(
    fixture.db.path,
    `SELECT payload FROM review_trace WHERE kind = 'batch_finished' ORDER BY seq`,
  ).map((row) => (JSON.parse(String(row["payload"])) as { index: number }).index);
  assert.deepEqual(milestones, [1, 2, 3]);
});

test("不中断跑完的一轮与续跑完成的一轮,Finding、用量与评论逐字相同", async () => {
  const fixture = setup();
  const straight = batchReviewer("model-a");

  const result = await runReview(EVENT, deps(fixture, [straight]));

  assert.deepEqual(
    result.findings.map((finding) => finding.file),
    FILES,
  );
  const [run] = query(fixture.db.path, "SELECT failed, total_tokens FROM review_run");
  assert.equal(run?.["failed"], 0);
  assert.equal(run?.["total_tokens"], USAGE.totalTokens * 3);
  assert.equal(fixture.forge.createdReviews.length, 1);
  assert.deepEqual(
    fixture.forge.createdReviews[0]?.comments.map((comment) => comment.path),
    FILES,
  );
});

test("中断期间处置了一条历史,续跑批次收到的仍是开跑时的快照", async () => {
  const fixture = setup();

  // 第一轮不分批,在 src/c.ts 上留下一条历史 Finding。
  await runReview(EVENT, {
    forge: fixture.forge.forge,
    reviewers: [batchReviewer("model-a")],
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
  });
  const [history] = query(fixture.db.path, "SELECT id FROM finding WHERE file = 'src/c.ts'");
  const historyId = Number(history?.["id"]);

  // 第二轮切三批,停在第三批——历史所在的那一批(issue #235 的按文件路由)还没跑。
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [interrupted] = query(
    fixture.db.path,
    "SELECT id FROM review_run WHERE finished_at IS NULL",
  );

  // 有人在重启期间把这条历史处置掉了。库里当前的历史因此变了,快照不变。
  const db = new DatabaseSync(fixture.db.path);
  try {
    db.prepare("UPDATE finding SET disposition = 'resolved' WHERE id = ?").run(historyId);
  } finally {
    db.close();
  }

  const resumed = batchReviewer("model-a");
  await runReview(
    EVENT,
    deps(fixture, [resumed], { resumeRunId: Number(interrupted?.["id"]) }),
  );

  const injected = resumed.calls[0]?.history ?? [];
  assert.deepEqual(
    injected.map((entry) => [entry.id, entry.disposition]),
    [[historyId, "unknown"]],
  );
  // 未处置的条目带全文;读当前历史的话这条已是已处置,只会剩下一行。
  assert.equal(injected[0]?.description, "src/c.ts 的第一处新增行有问题");
});

test("head 变了就不续跑:抛续跑不成立,原因说得出变成了哪个 head", async () => {
  const fixture = setup();
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");

  // 作者在重启期间又推了一版:审的已经不是这一轮那段代码了。
  fixture.forge.pullRequest.headSha = fixture.repo.pushToHead({ "src/a.ts": `${STUB}const z = 2;\n` });

  const resumed = batchReviewer("model-a");
  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [resumed], { resumeRunId: Number(run?.["id"]) })),
    new RegExp(`${RESUME_NOT_VIABLE}:这个 pull request 的 head 已经从`),
  );
  assert.deepEqual(resumed.calls, []);
});

test("模型组合换了就不续跑:已落库的批次与这一轮的 Reviewer 对不上", async () => {
  const fixture = setup();
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");

  const other = batchReviewer("model-b");
  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [other], { resumeRunId: Number(run?.["id"]) })),
    new RegExp(`${RESUME_NOT_VIABLE}:第 1 批已落库的 Reviewer`),
  );
  assert.deepEqual(other.calls, []);
});
