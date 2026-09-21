/**
 * 服务重启后的续跑(issue #248),恢复粒度是 Reviewer × 批次(issue #410)。
 *
 * 一个 Reviewer 在一批上的结论拿到手就落库,重启后只补缺结果的那几个,收尾仍只做一次
 * 合并与发评论。中断期间有人处置了历史也不影响续跑批次拿到的历史——那是开跑时落的快照。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { ReviewRunReviewerPin } from "../src/config.ts";
import type { Reviewer } from "../src/review/finding.ts";
import { RESUME_NOT_VIABLE, runReview } from "../src/review/run.ts";
import {
  EVENT,
  FILES,
  STUB,
  USAGE,
  batchReviewer,
  query,
  setup,
} from "./support/batch-run.ts";
import { testCleanups } from "./support/git-fixture.ts";

const cleanups = testCleanups();

/** 一批一个文件、一次只跑一批:批次序号与文件一一对应,断言因此读得懂。 */
function deps(
  fixture: ReturnType<typeof setup>,
  reviewers: readonly Reviewer[],
  extra: { resumeRunId?: number; reviewerPins?: readonly ReviewRunReviewerPin[] } = {},
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
  const fixture = setup(cleanups);
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });

  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);

  // 前两批的结果已经落库,这一轮停在没有结束时间的状态。
  const [run] = query(fixture.db.path, "SELECT id, finished_at, batch_count FROM review_run");
  assert.equal(run?.["finished_at"], null);
  assert.equal(run?.["batch_count"], 3);
  const stored = query(
    fixture.db.path,
    "SELECT batch_index, model FROM review_run_batch_outcome ORDER BY batch_index",
  );
  assert.deepEqual(
    stored.map((row) => [row["batch_index"], row["model"]]),
    [
      [0, "model-a"],
      [1, "model-a"],
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
  assert.equal(query(fixture.db.path, "SELECT run_id FROM review_run_batch_outcome").length, 0);

  // 批次里程碑接着原轮次追加,序号连续。
  const milestones = query(
    fixture.db.path,
    `SELECT payload FROM review_trace WHERE kind = 'batch_finished' ORDER BY seq`,
  ).map((row) => (JSON.parse(String(row["payload"])) as { index: number }).index);
  assert.deepEqual(milestones, [1, 2, 3]);
});

test("不中断跑完的一轮与续跑完成的一轮,Finding、用量与评论逐字相同", async () => {
  const fixture = setup(cleanups);
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

test("续跑收尾落库的归属带着各批报出的影响与建议(issue #266)", async () => {
  const fixture = setup(cleanups);
  const said = { impact: "首个新增行会被跳过。", suggestion: "从第 0 行开始遍历。" };

  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [batchReviewer("model-a", { throwOnCall: 3, said })])),
    /进程被重启了/,
  );
  const [run] = query(fixture.db.path, "SELECT id FROM review_run");
  await runReview(
    EVENT,
    deps(fixture, [batchReviewer("model-a", { said })], { resumeRunId: Number(run?.["id"]) }),
  );

  // 三批的归属都带着两段:前两批是重启前落的中间态,第三批是续跑报的。
  assert.deepEqual(
    query(
      fixture.db.path,
      "SELECT model, impact, suggestion FROM finding_attribution ORDER BY finding_id",
    ).map((row) => [row["model"], row["impact"], row["suggestion"]]),
    FILES.map(() => ["model-a", said.impact, said.suggestion]),
  );
});

test("中断期间处置了一条历史,续跑批次收到的仍是开跑时的快照", async () => {
  const fixture = setup(cleanups);

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
  const fixture = setup(cleanups);
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

test("最低报告等级改了就不续跑:一轮里报出的口径不能一半旧一半新", async () => {
  const fixture = setup(cleanups);
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");

  // 重启期间有人把审查策略的最低报告等级从全报改成了 P1。
  const db = new DatabaseSync(fixture.db.path);
  try {
    db.prepare("INSERT INTO global_setting (key, value) VALUES ('min_report_severity', 'P1')").run();
  } finally {
    db.close();
  }

  const resumed = batchReviewer("model-a");
  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [resumed], { resumeRunId: Number(run?.["id"]) })),
    new RegExp(`${RESUME_NOT_VIABLE}:最低报告等级已经从 P2 变成 P1`),
  );
  assert.deepEqual(resumed.calls, []);
});

test("模型组合换了就不续跑:已落库的批次与这一轮的 Reviewer 对不上", async () => {
  const fixture = setup(cleanups);
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

/**
 * 第一批就崩的那种轮次一个批次都没落库,逐批那道核对因此看不见任何东西——模型组合换没
 * 换只有开跑时钉下的 pin 说得出(issue #248 的评审复核)。
 */
test("零批次落库时模型组合换了同样不续跑:核对开跑时钉下的 Reviewer", async () => {
  const fixture = setup(cleanups);
  const pins: ReviewRunReviewerPin[] = [
    {
      identity: "model-a",
      provider: "test",
      model: "a",
      thinkingLevel: null,
      modelServiceVersion: 1,
      target: null,
      runtimeModel: null,
      failure: null,
    },
  ];
  const crashed = batchReviewer("model-a", { throwOnCall: 1 });
  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [crashed], { reviewerPins: pins })),
    /进程被重启了/,
  );
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");
  // 一个批次都没落库:逐批核对无从下手。
  assert.equal(query(fixture.db.path, "SELECT run_id FROM review_run_batch_outcome").length, 0);

  const other = batchReviewer("model-b");
  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [other], { resumeRunId: Number(run?.["id"]) })),
    new RegExp(`${RESUME_NOT_VIABLE}:开跑时的模型组合是 model-a,现在是 model-b`),
  );
  assert.deepEqual(other.calls, []);
});

/**
 * 全部批次的分组在开跑时冻结落库(issue #253):第一批就崩的轮次也有完整的核对依据,
 * 续跑时已完成与未完成的批次都要与它相符。
 */
test("开跑时冻结全部批次的分组;零批次完成的轮次续跑跑全部三批并正常收尾", async () => {
  const fixture = setup(cleanups);
  const crashed = batchReviewer("model-a", { throwOnCall: 1 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);

  // 一个批次都没落库,计划却已经在:它在任何批次完成之前就写下了。
  const [run] = query(
    fixture.db.path,
    "SELECT id, batch_count, batch_plan_json FROM review_run WHERE finished_at IS NULL",
  );
  assert.equal(run?.["batch_count"], 3);
  assert.deepEqual(JSON.parse(String(run?.["batch_plan_json"])), [
    ["src/a.ts"],
    ["src/b.ts"],
    ["src/c.ts"],
  ]);
  assert.equal(query(fixture.db.path, "SELECT run_id FROM review_run_batch_outcome").length, 0);

  const runId = Number(run?.["id"]);
  const resumed = batchReviewer("model-a");
  const result = await runReview(EVENT, deps(fixture, [resumed], { resumeRunId: runId }));

  // 三批都缺结果,三批都跑;沿用原编号,收尾正常。
  assert.deepEqual(
    resumed.calls.map((call) => call.range.files),
    [["src/a.ts"], ["src/b.ts"], ["src/c.ts"]],
  );
  const [after] = query(
    fixture.db.path,
    "SELECT id, failed, finished_at, total_tokens, batch_plan_json FROM review_run",
  );
  assert.equal(Number(after?.["id"]), runId);
  assert.equal(after?.["failed"], 0);
  assert.notEqual(after?.["finished_at"], null);
  assert.equal(after?.["total_tokens"], USAGE.totalTokens * 3);
  // 计划随轮次永久保留:回看一轮时「当时切成哪几批」答得出来。
  assert.notEqual(after?.["batch_plan_json"], null);
  assert.equal(result.failed, false);
  assert.equal(fixture.forge.createdReviews.length, 1);
  assert.equal(query(fixture.db.path, "SELECT run_id FROM review_run_batch_outcome").length, 0);
});

test("升级前没有批次计划的轮次不续跑:抛续跑不成立,不调用 Reviewer", async () => {
  const fixture = setup(cleanups);
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");
  const runId = Number(run?.["id"]);

  // 升级前落的行:有历史快照(issue #248)却没有批次计划。
  const db = new DatabaseSync(fixture.db.path);
  try {
    db.prepare("UPDATE review_run SET batch_plan_json = NULL WHERE id = ?").run(runId);
  } finally {
    db.close();
  }

  const resumed = batchReviewer("model-a");
  await assert.rejects(
    () => runReview(EVENT, deps(fixture, [resumed], { resumeRunId: runId })),
    new RegExp(`${RESUME_NOT_VIABLE}:第 ${runId} 轮没有开跑时的批次计划`),
  );
  assert.deepEqual(resumed.calls, []);
});

/** 这一轮落库的全部 `reviewer_batch_finished`,按模型与批次序号排(issue #410)。 */
function batchFinished(dbPath: string): [string, number][] {
  return query(
    dbPath,
    "SELECT reviewer, payload FROM review_trace WHERE kind = 'reviewer_batch_finished'",
  )
    .map((row): [string, number] => [
      String(row["reviewer"]),
      (JSON.parse(String(row["payload"])) as { batch: number }).batch,
    ])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
}

/**
 * 恢复粒度是一次完整的 Reviewer 会话(issue #410):同一批里先跑完的那个模型的结果在它
 * 拿到手的那一刻就落库,后面那个还没跑完时进程停下,续跑只补后面那个。
 */
test("批内一个 Reviewer 跑完、另一个没跑完:续跑只调没跑完的那个(issue #410)", async () => {
  const fixture = setup(cleanups);
  const done = batchReviewer("model-a");
  const crashed = batchReviewer("model-b", { throwOnCall: 1, yieldBeforeThrow: true });

  await assert.rejects(() => runReview(EVENT, deps(fixture, [done, crashed])), /进程被重启了/);

  // 第一批里只有 model-a 的那一份落了库:整批还没跑完,它的结果照样保住。
  assert.deepEqual(
    query(
      fixture.db.path,
      "SELECT batch_index, model FROM review_run_batch_outcome ORDER BY batch_index, model",
    ).map((row) => [row["batch_index"], row["model"]]),
    [[0, "model-a"]],
  );
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");
  const runId = Number(run?.["id"]);

  const resumedA = batchReviewer("model-a");
  const resumedB = batchReviewer("model-b");
  const result = await runReview(
    EVENT,
    deps(fixture, [resumedA, resumedB], { resumeRunId: runId }),
  );

  // model-a 的第一批不再重跑,model-b 三批都跑:白花的那一次模型调用省了下来。
  assert.deepEqual(
    resumedA.calls.map((call) => call.range.files),
    [["src/b.ts"], ["src/c.ts"]],
  );
  assert.deepEqual(
    resumedB.calls.map((call) => call.range.files),
    [["src/a.ts"], ["src/b.ts"], ["src/c.ts"]],
  );

  // 结论与不中断时一致:沿用原编号、六份用量一份不少、一轮只发一次 review。
  const [after] = query(
    fixture.db.path,
    "SELECT id, failed, finished_at, total_tokens FROM review_run",
  );
  assert.equal(Number(after?.["id"]), runId);
  assert.equal(after?.["failed"], 0);
  assert.notEqual(after?.["finished_at"], null);
  assert.equal(after?.["total_tokens"], USAGE.totalTokens * 6);
  assert.equal(result.failed, false);
  assert.deepEqual(
    result.findings.map((finding) => finding.file),
    FILES,
  );
  assert.equal(fixture.forge.createdReviews.length, 1);
  assert.equal(query(fixture.db.path, "SELECT run_id FROM review_run_batch_outcome").length, 0);

  // 每个(模型,批)上恰好一条收尾事件:落库的那一批续跑时不再发第二条。
  assert.deepEqual(batchFinished(fixture.db.path), [
    ["model-a", 1],
    ["model-a", 2],
    ["model-a", 3],
    ["model-b", 1],
    ["model-b", 2],
    ["model-b", 3],
  ]);
});

test("批内某个 Reviewer 失败的结果同样当场落库,续跑不重跑它(issue #410)", async () => {
  const fixture = setup(cleanups);
  const failing = batchReviewer("model-a", { failOnCall: 1 });
  const crashed = batchReviewer("model-b", { throwOnCall: 1, yieldBeforeThrow: true });

  await assert.rejects(() => runReview(EVENT, deps(fixture, [failing, crashed])), /进程被重启了/);
  assert.deepEqual(
    query(fixture.db.path, "SELECT batch_index, model FROM review_run_batch_outcome").map(
      (row) => [row["batch_index"], row["model"]],
    ),
    [[0, "model-a"]],
  );
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");

  const resumedA = batchReviewer("model-a");
  const resumedB = batchReviewer("model-b");
  await runReview(EVENT, deps(fixture, [resumedA, resumedB], { resumeRunId: Number(run?.["id"]) }));

  // 失败与成功同一档:跑过了就是跑过了,续跑不给它第二次机会。
  assert.deepEqual(
    resumedA.calls.map((call) => call.range.files),
    [["src/b.ts"], ["src/c.ts"]],
  );
  // 收尾按那一批的失败记账:model-a 只报出后两批的两条,第一批的失败记在覆盖不全上。
  const [outcome] = query(
    fixture.db.path,
    "SELECT finding_count, failure FROM reviewer_outcome WHERE model = 'model-a'",
  );
  assert.equal(outcome?.["finding_count"], 2);
  assert.equal(outcome?.["failure"], null);
});

test("部分落库的批次续跑时,轮次级批次事件标明是续跑并写出这次跑了谁(issue #416)", async () => {
  const fixture = setup(cleanups);
  const done = batchReviewer("model-a");
  const crashed = batchReviewer("model-b", { throwOnCall: 1, yieldBeforeThrow: true });

  await assert.rejects(() => runReview(EVENT, deps(fixture, [done, crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");
  const runId = Number(run?.["id"]);

  await runReview(
    EVENT,
    deps(fixture, [batchReviewer("model-a"), batchReviewer("model-b")], { resumeRunId: runId }),
  );

  const events = query(
    fixture.db.path,
    `SELECT kind, payload FROM review_trace
     WHERE kind IN ('batch_started', 'batch_finished') ORDER BY seq`,
  ).map((row) => {
    const payload = JSON.parse(String(row["payload"])) as Record<string, unknown>;
    return [
      String(row["kind"]),
      payload["index"],
      payload["resumed"] ?? null,
      payload["models"] ?? null,
    ];
  });

  assert.deepEqual(events, [
    // 崩溃前的那一次:第一批开了、没结束,标记一格都没有。
    ["batch_started", 1, null, null],
    // 续跑重新进入第一批:model-a 的结果在库里,这次只跑 model-b。
    ["batch_started", 1, true, ["model-b"]],
    ["batch_finished", 1, true, ["model-b"]],
    // 后两批一次都没跑过,不是续跑重新进入。
    ["batch_started", 2, null, null],
    ["batch_finished", 2, null, null],
    ["batch_started", 3, null, null],
    ["batch_finished", 3, null, null],
  ]);
});

test("续跑轮次的单模型耗时不含两次进程之间的空档(issue #415)", async () => {
  const fixture = setup(cleanups);
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");
  const runId = Number(run?.["id"]);

  // 把已落库的那两批改写成一小时前的两段。它们各跑 1000 毫秒、错开 500 毫秒,并集因此是
  // 1500 毫秒;中间那一小时是停机,没有任何一批盖着它。
  const crashedAt = Date.now() - 3_600_000;
  const db = new DatabaseSync(fixture.db.path);
  try {
    const stored = db
      .prepare("SELECT batch_index, outcome_json FROM review_run_batch_outcome")
      .all() as unknown as Record<string, unknown>[];
    const update = db.prepare(
      "UPDATE review_run_batch_outcome SET outcome_json = ? WHERE run_id = ? AND batch_index = ?",
    );
    for (const row of stored) {
      const index = Number(row["batch_index"]);
      const timed = JSON.parse(String(row["outcome_json"])) as Record<string, unknown>;
      update.run(
        JSON.stringify({ ...timed, startedAt: crashedAt + index * 500, durationMs: 1_000 }),
        runId,
        index,
      );
    }
  } finally {
    db.close();
  }

  await runReview(EVENT, deps(fixture, [batchReviewer("model-a")], { resumeRunId: runId }));

  const [outcome] = query(fixture.db.path, "SELECT duration_ms FROM reviewer_outcome");
  const durationMs = Number(outcome?.["duration_ms"]);
  // 崩溃前跑掉的那 1500 毫秒保住(重叠的 500 毫秒只算一次),停机那一小时不计。
  assert.ok(durationMs >= 1_500, `耗时 ${durationMs} 毫秒,少于崩溃前已经跑掉的 1500 毫秒`);
  assert.ok(durationMs < 60_000, `耗时 ${durationMs} 毫秒,把停机那一小时算进去了`);
});

/**
 * 升级前的中间态行一行存整批(issue #248 的形状)。它只在整批全部模型跑完之后才写,按
 * 模型拆开因此无损:那一批照常整批跳过。
 */
test("升级前的整批中间态行拆成逐模型的行,续跑整批跳过(issue #410)", async () => {
  const fixture = setup(cleanups);
  const crashed = batchReviewer("model-a", { throwOnCall: 3 });
  await assert.rejects(() => runReview(EVENT, deps(fixture, [crashed])), /进程被重启了/);
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");
  const runId = Number(run?.["id"]);

  // 把前两批的行改造回升级前的形状:一批一行,`outcomes_json` 是整批的数组。
  const stored = query(
    fixture.db.path,
    "SELECT batch_index, outcome_json FROM review_run_batch_outcome ORDER BY batch_index",
  );
  const db = new DatabaseSync(fixture.db.path);
  try {
    db.exec(`CREATE TABLE review_run_batch (
      run_id INTEGER NOT NULL REFERENCES review_run(id),
      batch_index INTEGER NOT NULL,
      files_json TEXT NOT NULL,
      outcomes_json TEXT NOT NULL,
      PRIMARY KEY (run_id, batch_index)
    )`);
    const insert = db.prepare(
      `INSERT INTO review_run_batch (run_id, batch_index, files_json, outcomes_json)
       VALUES (?, ?, ?, ?)`,
    );
    for (const row of stored) {
      const index = Number(row["batch_index"]);
      insert.run(runId, index, JSON.stringify([FILES[index]]), `[${String(row["outcome_json"])}]`);
    }
    db.exec("DELETE FROM review_run_batch_outcome");
  } finally {
    db.close();
  }

  const resumed = batchReviewer("model-a");
  const result = await runReview(EVENT, deps(fixture, [resumed], { resumeRunId: runId }));

  // 旧行拆开之后前两批照样跳过,只跑第三批;三批的用量一份不少。
  assert.deepEqual(
    resumed.calls.map((call) => call.range.files),
    [["src/c.ts"]],
  );
  const [after] = query(fixture.db.path, "SELECT failed, total_tokens FROM review_run");
  assert.equal(after?.["failed"], 0);
  assert.equal(after?.["total_tokens"], USAGE.totalTokens * 3);
  assert.equal(result.failed, false);
  // 旧表迁完即删,不留着让下一次启动再扫一遍。
  assert.equal(
    query(
      fixture.db.path,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_run_batch'",
    ).length,
    0,
  );
});
