/**
 * 服务重启后中断的 Review Run 怎么收场(issue #247):启动时把停在运行中的轮次改判
 * 失败,并撤掉 PR 上残留的 👀。
 *
 * 工作副本准备(issue #184)与基点探索(issue #205)已有同样的先例,这里是 Review Run
 * 那一档:进程落地时 Reviewer 子进程随之消失,收尾事务里的 Finding 一并丢失,那些行
 * 没有谁再去改它。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ReviewRunReviewerPin } from "../src/config.ts";
import type { Forge, PullRequestRef, Reaction } from "../src/forge/forge.ts";
import { openStore } from "../src/review/store.ts";
import { createWebhookServer } from "../src/webhook/server.ts";
import { makeCacheDir, makeDbPath } from "./support/git-fixture.ts";
import { startPanelHarness } from "./support/panel-harness.ts";

/** 启动时刻。被改判的轮次的结束时间就是它。 */
const AT = "2026-09-04T00:00:00.000Z";
const INTERRUPTED = "服务重启,上一轮没跑完";
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

test("重启时把停在运行中的轮次改判失败,并撤掉 PR 上残留的 👀", { timeout: WAIT_MS }, async () => {
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
        ["test:a", INTERRUPTED],
        ["test:b", INTERRUPTED],
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
