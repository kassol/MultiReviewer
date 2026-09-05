/**
 * 服务重启后中断的 Review Run 怎么收场:启动时先尝试续跑(issue #248),续跑不成立
 * 才改判失败并撤掉 PR 上残留的 👀(issue #247)。
 *
 * 工作副本准备(issue #184)与基点探索(issue #205)已有同样的先例,这里是 Review Run
 * 那一档:进程落地时 Reviewer 子进程随之消失,收尾事务里的 Finding 一并丢失,那些行
 * 没有谁再去改它。续跑把这一档往前推了一步——已经跑完的批次已经落库,重启后只补缺的
 * 那些,已经花掉的 token 保得住。
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ReviewRunReviewerPin } from "../src/config.ts";
import type { Forge, PullRequestRef, Reaction } from "../src/forge/forge.ts";
import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { createWebhookServer } from "../src/webhook/server.ts";
import { query } from "./support/batch-run.ts";
import type { FileTree } from "./support/git-fixture.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge } from "./support/memory-forge.ts";
import { startPanelHarness } from "./support/panel-harness.ts";

/** 启动时刻。被改判的轮次的结束时间就是它。 */
const AT = "2026-09-04T00:00:00.000Z";
const INTERRUPTED = "服务重启,上一轮没跑完";
/** 仓库已经不在注册表里时的失败原因:续跑先不成立,才退回改判(issue #248)。 */
const UNREGISTERED = `${INTERRUPTED};续跑不成立:仓库 acme/widgets 已经不在注册表里`;
/** 等撤反应的上限。撤不动时这里要报超时,不是挂着。 */
const WAIT_MS = 10_000;

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function pin(model: string): ReviewRunReviewerPin {
  return {
    identity: `test:${model}`,
    provider: "test",
    model,
    thinkingLevel: null,
    modelServiceVersion: null,
    target: null,
    runtimeModel: null,
    failure: null,
  };
}

/** 落一条停在运行中的 Review Run,返回它的 id。 */
function startRunning(
  dbPath: string,
  pullNumber: number,
  models: readonly string[] = ["a", "b"],
): number {
  const store = openStore(dbPath);
  try {
    return store.startRun({
      owner: "acme",
      repo: "widgets",
      pullNumber,
      headSha: "deadbee",
      title: "把登录超时改回三十秒",
      startedAt: "2026-09-03T23:00:00.000Z",
      changedFiles: 1,
      changedLines: 2,
      batchCount: 1,
      reviewerPins: models.map(pin),
    });
  } finally {
    store.close();
  }
}

/** 只认撤反应的 Forge:调用逐次记下来,别的方法一律不该被碰。 */
function recordingForge(options: { throws?: boolean } = {}): {
  forge: Forge;
  removed: { ref: PullRequestRef; reaction: Reaction }[];
  removedAtLeast(count: number): Promise<void>;
} {
  const removed: { ref: PullRequestRef; reaction: Reaction }[] = [];
  let waiting: { count: number; resolve: () => void }[] = [];
  const forge = {
    removeReaction: async (ref: PullRequestRef, reaction: Reaction) => {
      removed.push({ ref, reaction });
      waiting = waiting.filter((entry) => {
        if (removed.length < entry.count) return true;
        entry.resolve();
        return false;
      });
      if (options.throws === true) throw new Error("Forge 撤反应挂了");
    },
  } as unknown as Forge;
  return {
    forge,
    removed,
    removedAtLeast: (count) =>
      removed.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.push({ count, resolve });
          }),
  };
}

/** 起一次服务。返回值不用监听端口:被测的是构造时那段启动逻辑。 */
function boot(dbPath: string, forge: Forge): void {
  const cache = makeCacheDir();
  cleanups.push(cache.cleanup);
  createWebhookServer({
    forges: { gitea: forge },
    cacheDir: cache.dir,
    dbPath,
    baseUrl: "https://reviewer.example.test",
    panelDist: "web/dist",
    buildReviewers: () => [],
    now: () => Date.parse(AT),
  });
}

test("续跑不成立时把停在运行中的轮次改判失败,并撤掉 PR 上残留的 👀", { timeout: WAIT_MS }, async () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const runId = startRunning(db.path, 7);
  const gitea = recordingForge();

  boot(db.path, gitea.forge);
  await gitea.removedAtLeast(1);

  assert.deepEqual(gitea.removed, [
    { ref: { owner: "acme", repo: "widgets", number: 7 }, reaction: "eyes" },
  ]);

  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 10, id: runId });
    assert.equal(run?.failed, true);
    assert.equal(run?.finishedAt, AT);
    // 失败原因在面板上看得到:这一轮已落库的 Reviewer 指定各留一行,与其他失败一轮
    // 同一条展示路径。
    assert.deepEqual(
      run?.models.map((entry) => [entry.model, entry.failure]),
      [
        ["test:a", UNREGISTERED],
        ["test:b", UNREGISTERED],
      ],
    );
  } finally {
    store.close();
  }
});

test("撤反应抛错:服务照常起来,改判照样落库", { timeout: WAIT_MS }, async () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const runId = startRunning(db.path, 8);
  const gitea = recordingForge({ throws: true });

  boot(db.path, gitea.forge);
  await gitea.removedAtLeast(1);
  // 抛错那一次的 catch 也要跑完,再看库。
  await delay(0);

  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 10, id: runId });
    assert.equal(run?.failed, true);
    assert.equal(run?.finishedAt, AT);
  } finally {
    store.close();
  }
});

test("已结束与已失败的轮次重启后一行不动,也不去碰 Forge", async () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const doneId = startRunning(db.path, 9, ["a"]);
  const failedId = startRunning(db.path, 10, ["a"]);
  const seed = openStore(db.path);
  try {
    seed.finishRun(doneId, {
      finishedAt: "2026-09-03T23:30:00.000Z",
      durationMs: 1_800_000,
      failed: false,
      outcomes: [],
      findings: [],
    });
    seed.finishRun(failedId, {
      finishedAt: "2026-09-03T23:40:00.000Z",
      durationMs: 2_400_000,
      failed: true,
      outcomes: [
        {
          model: "test:a",
          failure: "模型挂了",
          findingCount: 0,
          anomalyCount: 0,
          rejectedToolCalls: 0,
          anchorRejections: 0,
          durationMs: 1,
        },
      ],
      findings: [],
    });
  } finally {
    seed.close();
  }
  const gitea = recordingForge();

  boot(db.path, gitea.forge);
  await delay(0);

  assert.deepEqual(gitea.removed, []);
  const store = openStore(db.path);
  try {
    const [done] = store.listRuns({ limit: 10, id: doneId });
    assert.equal(done?.finishedAt, "2026-09-03T23:30:00.000Z");
    assert.equal(done?.failed, false);
    assert.deepEqual(done?.models, []);
    const [failed] = store.listRuns({ limit: 10, id: failedId });
    assert.equal(failed?.finishedAt, "2026-09-03T23:40:00.000Z");
    assert.deepEqual(
      failed?.models.map((entry) => [entry.model, entry.failure]),
      [["test:a", "模型挂了"]],
    );
  } finally {
    store.close();
  }
});

test("改判后的轮次在面板上是失败带原因,轨迹流连上即结束", async () => {
  // 前端的 `live` 是 `finishedAt === null && !failed`(`web/src/run-trace.tsx`),
  // 停不停轮询由这两个字段决定,断言它们即可;轨迹流则要真的连一次——挂着不结束的
  // 流在浏览器那边就是「还在跑」。
  const h = await startPanelHarness(cleanups);
  const runId = startRunning(h.db.path, 7);
  const store = openStore(h.db.path);
  try {
    store.failInterruptedRuns(INTERRUPTED, AT);
  } finally {
    store.close();
  }

  const body = (await (await h.api("GET", "/runs")).json()) as {
    runs: { id: number; failed: boolean; finishedAt: string | null; models: {
      model: string;
      failure: string | null;
    }[] }[];
  };
  const row = body.runs.find((entry) => entry.id === runId);
  assert.equal(row?.failed, true);
  assert.equal(row?.finishedAt, AT);
  assert.deepEqual(
    row?.models.map((entry) => [entry.model, entry.failure]),
    [
      ["test:a", INTERRUPTED],
      ["test:b", INTERRUPTED],
    ],
  );

  // 频道不在内存里(那一轮的进程早没了),回放完立即 end 而不是挂着。
  const stream = await fetch(`${h.serverUrl}/api/runs/${runId}/trace/stream`, {
    headers: { cookie: h.cookie },
  });
  assert.equal(stream.status, 200);
  const frames = (await stream.text()).split("\n\n").filter((chunk) => chunk !== "");
  assert.deepEqual(
    frames.map((chunk) => chunk.split("\n")[0]),
    ["event: end"],
  );
});

test("改判写轮次级失败原因并记 run_failed 事件,零 pin 的轮次也读得到原因", { timeout: WAIT_MS }, async () => {
  // ADR 0026:原因落在 `review_run` 自己的那一列上,不再只借 Reviewer 的 outcome 行——
  // 一个 pin 都没有的轮次此前改判后原因不落任何行。
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const pinned = startRunning(db.path, 11);
  const bare = startRunning(db.path, 12, []);
  const gitea = recordingForge();

  boot(db.path, gitea.forge);
  await gitea.removedAtLeast(2);

  const store = openStore(db.path);
  try {
    for (const runId of [pinned, bare]) {
      const [run] = store.listRuns({ limit: 10, id: runId });
      assert.equal(run?.failed, true);
      assert.equal(run?.failure, UNREGISTERED);
      // 轨迹上多一条 Run 级事件,带与列内相同的一句原因。
      assert.deepEqual(
        store
          .listTrace(runId)
          .filter((event) => event.kind === "run_failed")
          .map((event) => [event.scope, event.payload]),
        [["run", { reason: UNREGISTERED }]],
      );
    }
    // 逐 pin 的 outcome 行照旧:有 pin 的那一轮仍每个 Reviewer 一行,零 pin 的一行都没有。
    assert.deepEqual(
      store.listRuns({ limit: 10, id: pinned })[0]?.models.map((entry) => entry.failure),
      [UNREGISTERED, UNREGISTERED],
    );
    assert.deepEqual(store.listRuns({ limit: 10, id: bare })[0]?.models, []);
  } finally {
    store.close();
  }
});

test("改判后列表、详情与阶段时间线都读得到轮次级失败原因", async () => {
  const h = await startPanelHarness(cleanups);
  const pinned = startRunning(h.db.path, 7);
  const bare = startRunning(h.db.path, 8, []);
  const store = openStore(h.db.path);
  try {
    store.failInterruptedRuns(INTERRUPTED, AT);
  } finally {
    store.close();
  }

  const list = (await (await h.api("GET", "/runs")).json()) as {
    runs: { id: number; failed: boolean; failure: string | null; models: unknown[] }[];
  };
  assert.deepEqual(
    [pinned, bare].map((id) => {
      const row = list.runs.find((entry) => entry.id === id);
      return [row?.failed, row?.failure, row?.models.length];
    }),
    [
      [true, INTERRUPTED, 2],
      [true, INTERRUPTED, 0],
    ],
  );

  const detail = (await (await h.api("GET", `/runs/${bare}`)).json()) as {
    run: { failed: boolean; failure: string | null };
  };
  assert.deepEqual([detail.run.failed, detail.run.failure], [true, INTERRUPTED]);

  const summary = (await (
    await h.api("GET", "/stage-summary?owner=acme&repo=widgets&pullNumber=8")
  ).json()) as { timeline: { runId: number; failed: boolean; failure: string | null }[] };
  assert.deepEqual(
    summary.timeline.map((entry) => [entry.runId, entry.failed, entry.failure]),
    [[bare, true, INTERRUPTED]],
  );
});

/**
 * 续跑那条链路要真的跑起来:注册表里的仓库、一份真实工作副本、一个脚本化 Reviewer
 * (issue #248)。这里的断言覆盖启动侧的接线——找仓库、组运行计划、调 `runReview`
 * 续跑——`runReview` 自己那一层的行为在 `test/run-resume.test.ts`。
 */
const RESUME_FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
const RESUME_STUB = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

/** 一批报一条 Finding;`throwOnCall` 那一次抛,用它模拟进程在那一批上被重启。 */
function resumeReviewer(
  options: { throwOnCall?: number } = {},
): Reviewer & { files: string[][] } {
  const files: string[][] = [];
  return {
    model: "test:a",
    files,
    review: async ({ range }) => {
      files.push([...range.files]);
      if (options.throwOnCall === files.length) throw new Error("进程被重启了");
      return {
        model: "test:a",
        findings: range.files.map((file) => ({
          file,
          line: 4,
          severity: "P0" as const,
          category: "bug" as const,
          title: `${file} 有问题`,
          description: "第一处新增行有问题",
          impact: "",
          suggestion: "",
          model: "test:a",
        })),
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
      };
    },
  };
}

/** 分批上限那两项,与 `ReviewRunDeps` 同名;全局设置与直接调 `runReview` 用同一份。 */
type BatchLimits = { maxChangedLinesPerBatch?: number; maxFilesPerBatch: number };

/**
 * 注册好仓库、备好真实 head 的夹具,并留下一轮停在 `throwOnCall` 那一批的 Review Run。
 * `added` 给每个文件在 head 上新增的行数,文件顺序即切批顺序。
 */
async function interruptedRun(options: {
  added: Record<string, number>;
  limits: BatchLimits;
  throwOnCall: number;
}): Promise<{
  db: { path: string };
  memory: ReturnType<typeof memoryForge>;
  runId: number;
}> {
  const files = Object.keys(options.added);
  const base: FileTree = {};
  const head: FileTree = {};
  for (const path of files) {
    base[path] = RESUME_STUB;
    head[path] =
      RESUME_STUB +
      Array.from({ length: options.added[path]! }, (_, index) => `const x${index} = ${index};\n`)
        .join("");
  }
  const repo = makeRepo({ base, head });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const store = openStore(db.path);
  try {
    store.registerRepo({
      repoId: 4242,
      owner: "acme",
      repo: "widgets",
      generation: 1,
      key: "unused",
    });
    // 分批上限是全局设置,重启后的续跑按它重新切批:与开跑那次相同才切得出同样的批次。
    for (const [field, limit] of Object.entries(options.limits)) {
      assert.equal(store.putGlobalBatchLimit(field as keyof BatchLimits, 1, limit), true);
    }
  } finally {
    store.close();
  }

  const memory = memoryForge({
    pullRequest: {
      number: 7,
      title: "把登录超时改回三十秒",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: files.map((path) => ({ path, status: "modified" as const })),
  });

  await assert.rejects(
    () =>
      runReview(
        { owner: "acme", repo: "widgets", number: 7 },
        {
          forge: memory.forge,
          reviewers: [resumeReviewer({ throwOnCall: options.throwOnCall })],
          cacheDir: cache.dir,
          dbPath: db.path,
          // 失败原因逐 Reviewer 各记一份,给了指定才有那几行(issue #247);轮次级那一份
          // 不靠它(issue #256)。
          reviewerPins: [pin("a")],
          ...options.limits,
          maxParallelBatches: 1,
        },
      ),
    /进程被重启了/,
  );

  const seeded = openStore(db.path);
  try {
    const [run] = seeded.listRuns({ limit: 10 });
    assert.equal(run?.finishedAt, null);
    return { db, memory, runId: run!.id };
  } finally {
    seeded.close();
  }
}

/** 三个文件各一批,停在第三批。 */
function interruptedAtThirdBatch(): ReturnType<typeof interruptedRun> {
  return interruptedRun({
    added: Object.fromEntries(RESUME_FILES.map((path) => [path, 1])),
    limits: { maxFilesPerBatch: 1 },
    throwOnCall: 3,
  });
}

test("重启后只补缺的那一批,这一轮沿用原编号正常结束", { timeout: WAIT_MS }, async () => {
  const { db, memory, runId } = await interruptedAtThirdBatch();
  const reviewer = resumeReviewer();
  const cache = makeCacheDir();
  cleanups.push(cache.cleanup);
  const resumed: { runId: number; failure?: string }[] = [];
  const done = new Promise<void>((resolve) => {
    createWebhookServer({
      forges: { gitea: memory.forge },
      cacheDir: cache.dir,
      dbPath: db.path,
      baseUrl: "https://reviewer.example.test",
      panelDist: "web/dist",
      buildReviewers: () => [reviewer],
      now: () => Date.parse(AT),
      onRunResumed: (id, failure) => {
        resumed.push({ runId: id, ...(failure === undefined ? {} : { failure }) });
        resolve();
      },
    });
  });
  await done;

  assert.deepEqual(resumed, [{ runId }]);
  // 只有第三批被重跑,前两批的结果直接取自库里。
  assert.deepEqual(reviewer.files, [["src/c.ts"]]);

  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 10, id: runId });
    assert.equal(run?.failed, false);
    assert.notEqual(run?.finishedAt, null);
  } finally {
    store.close();
  }
  // 一轮只发一次 review,三条行级评论——与不中断时一致。
  assert.equal(memory.createdReviews.length, 1);
  assert.deepEqual(
    memory.createdReviews[0]?.comments.map((comment) => comment.path),
    RESUME_FILES,
  );
});

test("工作副本准备失败:改判失败、原因可见,下一次启动不再处理它", { timeout: WAIT_MS }, async () => {
  const { db, memory, runId } = await interruptedAtThirdBatch();
  // 空的缓存根加一个不存在的 clone 地址:这一次准备工作副本必然失败。
  memory.pullRequest.cloneUrl = join(tmpdir(), "multireviewer-missing-clone-source");
  const cache = makeCacheDir();
  cleanups.push(cache.cleanup);

  const resumed: { runId: number; failure?: string }[] = [];
  const first = new Promise<void>((resolve) => {
    createWebhookServer({
      forges: { gitea: memory.forge },
      cacheDir: cache.dir,
      dbPath: db.path,
      baseUrl: "https://reviewer.example.test",
      panelDist: "web/dist",
      buildReviewers: () => [resumeReviewer()],
      now: () => Date.parse(AT),
      onRunResumed: (id, failure) => {
        resumed.push({ runId: id, ...(failure === undefined ? {} : { failure }) });
        resolve();
      },
    });
  });
  await first;

  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.runId, runId);

  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 10, id: runId });
    assert.equal(run?.failed, true);
    assert.equal(run?.finishedAt, AT);
    // 原因在面板上看得到:这一轮已落库的 Reviewer 指定那一行带着它。
    const failure = run?.models[0]?.failure ?? "";
    assert.ok(failure.startsWith(INTERRUPTED), failure);
    assert.notEqual(failure, INTERRUPTED);
  } finally {
    store.close();
  }

  // 第二次启动:这一轮已经有结束时间,不再被拿去续跑。
  const second: number[] = [];
  createWebhookServer({
    forges: { gitea: memory.forge },
    cacheDir: cache.dir,
    dbPath: db.path,
    baseUrl: "https://reviewer.example.test",
    panelDist: "web/dist",
    buildReviewers: () => [resumeReviewer()],
    now: () => Date.parse(AT),
    onRunResumed: (id) => second.push(id),
  });
  await delay(50);
  assert.deepEqual(second, []);
});

/** 起一次服务并等启动续跑那一轮落定,返回回调收到的结果。 */
function bootAndSettle(
  db: { path: string },
  memory: ReturnType<typeof memoryForge>,
  reviewer: Reviewer,
): Promise<{ runId: number; failure?: string }> {
  const cache = makeCacheDir();
  cleanups.push(cache.cleanup);
  return new Promise((resolve) => {
    createWebhookServer({
      forges: { gitea: memory.forge },
      cacheDir: cache.dir,
      dbPath: db.path,
      baseUrl: "https://reviewer.example.test",
      panelDist: "web/dist",
      buildReviewers: () => [reviewer],
      now: () => Date.parse(AT),
      onRunResumed: (id, failure) =>
        resolve({ runId: id, ...(failure === undefined ? {} : { failure }) }),
    });
  });
}

/**
 * issue #253 的反例:六个文件的改动行数依次 10、10、95、10、10、10。上限 999 行 / 2 文件
 * 切成「ab、cd、ef」,停机期间管理员改成 100 行 / 3 文件,重新切批是「ab、c、def」——总批数
 * 与已完成的首批都相同,只有未完成部分的分组变了。核对对照的是开跑时冻结的完整计划,
 * 这种变化因此认得出来:改判失败、原因写在轮次级那一列,一个 Reviewer 都不调。
 */
test("总批数与已完成首批相同、未完成分组不同:续跑不成立,改判并写原因,不调 Reviewer", { timeout: WAIT_MS }, async () => {
  const { db, memory, runId } = await interruptedRun({
    added: {
      "src/a.ts": 10,
      "src/b.ts": 10,
      "src/c.ts": 95,
      "src/d.ts": 10,
      "src/e.ts": 10,
      "src/f.ts": 10,
    },
    limits: { maxChangedLinesPerBatch: 999, maxFilesPerBatch: 2 },
    throwOnCall: 2,
  });
  const plan = [
    ["src/a.ts", "src/b.ts"],
    ["src/c.ts", "src/d.ts"],
    ["src/e.ts", "src/f.ts"],
  ];
  assert.deepEqual(
    query(db.path, "SELECT batch_plan_json FROM review_run").map((row) =>
      JSON.parse(String(row["batch_plan_json"])),
    ),
    [plan],
  );
  // 停机期间改了分批上限。
  const admin = openStore(db.path);
  try {
    assert.equal(admin.putGlobalBatchLimit("maxChangedLinesPerBatch", 2, 100), true);
    assert.equal(admin.putGlobalBatchLimit("maxFilesPerBatch", 2, 3), true);
  } finally {
    admin.close();
  }

  const reviewer = resumeReviewer();
  const settled = await bootAndSettle(db, memory, reviewer);

  const reason = `${INTERRUPTED};续跑不成立:第 2 批的分组与冻结计划不符`;
  assert.deepEqual(settled, { runId, failure: "续跑不成立:第 2 批的分组与冻结计划不符" });
  assert.deepEqual(reviewer.files, []);
  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 10, id: runId });
    assert.equal(run?.failed, true);
    assert.equal(run?.finishedAt, AT);
    assert.equal(run?.failure, reason);
    assert.deepEqual(
      store
        .listTrace(runId)
        .filter((event) => event.kind === "run_failed")
        .map((event) => event.payload),
      [{ reason }],
    );
  } finally {
    store.close();
  }
  // 改变后的分组没有混进原轮次:冻结的计划原样保留,中间态随改判清掉。
  assert.deepEqual(
    query(db.path, "SELECT batch_plan_json FROM review_run").map((row) =>
      JSON.parse(String(row["batch_plan_json"])),
    ),
    [plan],
  );
  assert.equal(query(db.path, "SELECT run_id FROM review_run_batch").length, 0);
  assert.equal(memory.createdReviews.length, 0);
});

test("升级前没有批次计划的中断轮次:启动改判并写原因,不调 Reviewer", { timeout: WAIT_MS }, async () => {
  const { db, memory, runId } = await interruptedAtThirdBatch();
  const legacy = new DatabaseSync(db.path);
  try {
    legacy.prepare("UPDATE review_run SET batch_plan_json = NULL WHERE id = ?").run(runId);
  } finally {
    legacy.close();
  }

  const reviewer = resumeReviewer();
  const settled = await bootAndSettle(db, memory, reviewer);

  const failure = `续跑不成立:第 ${runId} 轮没有开跑时的批次计划`;
  assert.deepEqual(settled, { runId, failure });
  assert.deepEqual(reviewer.files, []);
  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 10, id: runId });
    assert.equal(run?.failed, true);
    assert.equal(run?.finishedAt, AT);
    assert.equal(run?.failure, `${INTERRUPTED};${failure}`);
  } finally {
    store.close();
  }
  assert.equal(memory.createdReviews.length, 0);
});
