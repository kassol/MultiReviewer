/**
 * 优雅退出(issue #249)。
 *
 * 收到 SIGTERM / SIGINT 后进程进入排空:不再接新投递与重跑,已开跑的轮次跑完当前批次、
 * 落库,再停在续跑得回来的状态(issue #248)。排空有上限,超时不再等,日志记下放弃的轮次。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { createDrain } from "../src/drain.ts";
import type { Finding, Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import type { FileTree } from "./support/git-fixture.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge } from "./support/memory-forge.ts";
import { HARNESS_PR, startPanelHarness } from "./support/panel-harness.ts";

const EVENT = { owner: "acme", repo: "widgets", number: 7 };
const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
const STUB = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** base 三行,head 追加两行:第 4 行是每个文件的首个新增行,Finding 锚在那里。 */
function setup() {
  const base: FileTree = {};
  const head: FileTree = {};
  for (const path of FILES) {
    base[path] = STUB;
    head[path] = `${STUB}const x = 0;\n`;
  }
  const repo = makeRepo({ base, head });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);
  const forge = memoryForge({
    pullRequest: {
      number: EVENT.number,
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

function findingAt(file: string, model: string): Finding {
  return {
    file,
    line: 4,
    severity: "P0",
    category: "bug",
    title: `${file} 有问题`,
    description: `${file} 的第一处新增行有问题`,
    impact: "",
    suggestion: "",
    model,
  };
}

/** 每批报一条 Finding;`onBatch` 在跑这一批时执行,用它模拟批次跑到一半收到信号。 */
function batchReviewer(model: string, onBatch?: (call: number) => void): Reviewer {
  let calls = 0;
  return {
    model,
    review: async ({ range }) => {
      calls += 1;
      onBatch?.(calls);
      return {
        model,
        findings: range.files.map((file) => findingAt(file, model)),
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
      };
    },
  };
}

test("排空开始后不再取新批:当前批次落库,这一轮不收尾,轨迹记下中止在第几批", async () => {
  const fixture = setup();
  const drain = createDrain();
  // 第一批跑到一半时收到信号。取号线跑完这一批就不该再取第二批。
  const reviewer = batchReviewer("model-a", (call) => {
    if (call === 1) drain.begin();
  });

  const result = await runReview(EVENT, {
    forge: fixture.forge.forge,
    reviewers: [reviewer],
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
    maxFilesPerBatch: 1,
    maxParallelBatches: 1,
    drain,
  });

  assert.equal(result.aborted, true);
  // 第一批的结果已经落库,后两批一次都没跑。
  assert.deepEqual(
    query(fixture.db.path, "SELECT batch_index FROM review_run_batch ORDER BY batch_index").map(
      (row) => row["batch_index"],
    ),
    [0],
  );
  // 不收尾:没有结束时间,下一次启动因此认得出它、续得上(issue #248)。
  const [run] = query(fixture.db.path, "SELECT finished_at, batch_count FROM review_run");
  assert.equal(run?.["finished_at"], null);
  assert.equal(run?.["batch_count"], 3);
  // 不合并、不发评论,也不进任何事后统计的分母。
  assert.equal(fixture.forge.createdReviews.length, 0);
  assert.equal(query(fixture.db.path, "SELECT id FROM reviewer_outcome").length, 0);
  assert.equal(query(fixture.db.path, "SELECT id FROM finding").length, 0);

  // 轨迹上看得出本轮停在第几批。
  const [aborted] = query(
    fixture.db.path,
    "SELECT payload FROM review_trace WHERE kind = 'run_aborted'",
  );
  assert.deepEqual(JSON.parse(String(aborted?.["payload"])), { batch: 2, total: 3 });
  assert.equal(
    query(fixture.db.path, "SELECT seq FROM review_trace WHERE kind = 'run_finished'").length,
    0,
  );
});

test("排空中止的那一轮,下一次启动续跑得回来", async () => {
  const fixture = setup();
  const drain = createDrain();
  const deps = {
    forge: fixture.forge.forge,
    reviewers: [batchReviewer("model-a")],
    cacheDir: fixture.cache.dir,
    dbPath: fixture.db.path,
    maxFilesPerBatch: 1,
    maxParallelBatches: 1,
  };
  await runReview(EVENT, {
    ...deps,
    reviewers: [batchReviewer("model-a", (call) => { if (call === 1) drain.begin(); })],
    drain,
  });
  const [run] = query(fixture.db.path, "SELECT id FROM review_run WHERE finished_at IS NULL");

  const resumed = await runReview(EVENT, { ...deps, resumeRunId: Number(run?.["id"]) });

  assert.equal(resumed.aborted, undefined);
  assert.deepEqual(resumed.findings.map((finding) => finding.file), FILES);
  assert.equal(fixture.forge.createdReviews.length, 1);
});

test("没有在跑的轮次时排空立即结束;有跑不完的轮次时到上限就放弃,并说得出放弃了谁", async () => {
  const idle = createDrain();
  idle.begin();
  assert.deepEqual(await idle.settle(60_000), []);

  const busy = createDrain();
  const done = busy.enter("gitea acme/widgets#7");
  busy.begin();
  assert.deepEqual(await busy.settle(20), ["gitea acme/widgets#7"]);

  // 到达可退出点之后就不再等它。
  done();
  assert.deepEqual(await busy.settle(60_000), []);
});

test("服务正在排空:面板重跑回 503,不开新一轮", async () => {
  const drain = createDrain();
  const h = await startPanelHarness(cleanups, { drain });

  drain.begin();
  const response = await h.api("POST", "/rerun", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
  });

  assert.equal(response.status, 503);
  assert.deepEqual(h.dispatched, []);
  // 范围审查那种入参走同一道闸。
  assert.equal((await h.api("POST", "/rerun", { rangeReviewId: 1 })).status, 503);
});

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const LISTENING = "MultiReviewer webhook 监听";

test("没有进行中轮次时 SIGTERM 立即退出,退出码 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-drain-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = openStore(join(dir, "multireviewer.db"));
  seed.close();

  const child = spawn(process.execPath, [MAIN], {
    cwd: dir,
    env: {
      ...process.env,
      MULTIREVIEWER_DB: join(dir, "multireviewer.db"),
      MULTIREVIEWER_CACHE_DIR: join(dir, "worktrees"),
      MULTIREVIEWER_BASE_URL: "http://localhost:3000",
      // 0 让内核挑一个空闲端口,并发跑测试时不会撞上。
      MULTIREVIEWER_PORT: "0",
      // 只要有一个 Forge 就起得来;GitHub 那一格不做启动时的实例版本检查。
      GITHUB_TOKEN: "drain-test-token",
      MULTIREVIEWER_GITEA_URL: "",
      MULTIREVIEWER_GITEA_TOKEN: "",
    },
  });

  const exited = new Promise<{ code: number | null; output: string }>((resolve) => {
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(LISTENING)) child.kill("SIGTERM");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => resolve({ code, output }));
    // 排空卡住时不该让整个测试文件挂在这里等。
    setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
  });

  const { code, output } = await exited;
  assert.equal(code, 0, output);
  assert.match(output, /排空/);
});
