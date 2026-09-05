/**
 * 延续的交接在新评论发布确认后完成(ADR 0025,issue #252)。
 *
 * 顺序是发布 review 并读回评论标识 → resolve 旧评论 → 落库延续。三种失败各有归宿:
 * 发布明确失败不 resolve、不记延续,轮次记失败原因;发布成功而 resolve 失败仍记延续、
 * 带「交接未完成」并由下一轮重试;发布结果不确定按发布失败处理,禁止自动重发。
 *
 * 打在 `runReview` 入口上:内存 Forge 注入失败,真实 git 与 SQLite 落在临时目录,
 * 观察评论写入、持久化状态与重启选择结果。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { PublishUncertainError } from "../src/forge/forge.ts";
import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import type { TraceEvent } from "../src/review/trace.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import {
  memoryForge,
  scriptedReviewer,
  verdictReviewer,
  type MemoryForge,
} from "./support/memory-forge.ts";

const BASE = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}

export function mul(a, b) {
  return a * b;
}
`;

const HEAD = BASE.replace("return a - b;", "return a - b - 1;");
/** 改的正是 Finding 指向的那一行,指纹必变。 */
const SAME_LINE_CHANGE = HEAD.replace("return a - b - 1;", "return a - b - 2;");

const EVENT = { owner: "acme", repo: "widgets", number: 7 };

const FINDING = {
  file: "src/calc.js",
  line: 6,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub 多减了 1",
};

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function setup() {
  const repo = makeRepo({ base: { "src/calc.js": BASE }, head: { "src/calc.js": HEAD } });
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
    changedFiles: [{ path: "src/calc.js", status: "modified" }],
  });

  const deps = {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  return { repo, db, forge, deps };
}

/** 本轮判仍在,并在同一个文件的新位置报出一条:延续要的两个条件都由它给出。 */
function continuing(): Reviewer[] {
  return [
    verdictReviewer("model-a", "present", [{ ...FINDING, description: "减法仍然多减了 1" }]),
  ];
}

function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function findingRows(dbPath: string): {
  disposition: string;
  continuedFrom: unknown;
  handoffPending: unknown;
}[] {
  return query(
    dbPath,
    "SELECT disposition, continued_from, handoff_pending FROM finding ORDER BY id",
  ).map((row) => ({
    disposition: String(row["disposition"]),
    continuedFrom: row["continued_from"],
    handoffPending: row["handoff_pending"],
  }));
}

function runRows(dbPath: string): { failed: number; failure: unknown; finishedAt: unknown }[] {
  return query(dbPath, "SELECT failed, failure, finished_at FROM review_run ORDER BY id").map(
    (row) => ({
      failed: Number(row["failed"]),
      failure: row["failure"],
      finishedAt: row["finished_at"],
    }),
  );
}

function traceKinds(dbPath: string, runId: number): TraceEvent[] {
  const store = openStore(dbPath);
  try {
    return store.listTrace(runId).filter((event) => event.scope === "run");
  } finally {
    store.close();
  }
}

function interruptedRunIds(dbPath: string): number[] {
  const store = openStore(dbPath);
  try {
    return store.interruptedRuns().map((run) => run.runId);
  } finally {
    store.close();
  }
}

/**
 * 第一轮报出一条并把它当成 Forge 上未处置的既有评论,第二轮把那处代码改写掉(指纹
 * 必变),模型判仍在并在同一个文件报出新位置的那一条——延续在第二轮触发。
 */
async function firstRound(): Promise<ReturnType<typeof setup>> {
  const fixture = setup();
  await runReview(EVENT, fixture.deps);
  fixture.forge.existingComments.push(
    ...fixture.forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );
  fixture.forge.pullRequest.headSha = fixture.repo.pushToHead({
    "src/calc.js": SAME_LINE_CHANGE,
  });
  return fixture;
}

/** 发布失败的三档共用的断言:不 resolve、不记延续,轮次记原因而不算 Reviewer 失败。 */
function assertPublishFailed(fixture: ReturnType<typeof setup>, reason: RegExp): void {
  const { db, forge } = fixture;
  assert.deepEqual(forge.resolvedIds, [], "发布没成却把旧评论 resolve 了");
  // 旧行留在未处置,本轮那条照常落库,谁都没记延续。
  assert.deepEqual(findingRows(db.path), [
    { disposition: "unresolved", continuedFrom: null, handoffPending: null },
    { disposition: "unknown", continuedFrom: null, handoffPending: null },
  ]);
  const [, second] = runRows(db.path);
  assert.ok(second !== undefined);
  assert.equal(second.failed, 0, "发布失败不是 Reviewer 失败,failed 不该置位");
  assert.notEqual(second.finishedAt, null, "本轮的结果已落库,结束时间该有");
  assert.match(String(second.failure), reason);
  assert.match(String(second.failure), /发布 review 失败/);
  // 轨迹里只有失败,没有「已发布」与正常收尾;PR 上也不点 👍。
  const kinds = traceKinds(db.path, 2).map((event) => event.kind);
  assert.ok(kinds.includes("run_failed"), `轨迹缺 run_failed:${kinds.join(",")}`);
  assert.ok(!kinds.includes("review_posted"), "发布失败却记了 review_posted");
  assert.ok(!kinds.includes("run_finished"), "发布失败却记了正常收尾");
  const failedEvent = traceKinds(db.path, 2).find((event) => event.kind === "run_failed");
  assert.equal(
    (failedEvent?.payload as { reason?: string }).reason,
    String(second.failure),
    "轨迹上的原因与轮次上的该是同一句",
  );
  assert.ok(!forge.reactionLog.includes("add:+1"), "发布失败却点了 👍");
  assert.ok(forge.reactionLog.includes("remove:eyes"), "👀 该撤掉");
  // 轮次已有结束时间,启动续跑不会再选中它:这一轮不自动重发。
  assert.deepEqual(interruptedRunIds(db.path), []);
}

test("发布明确失败:不 resolve 旧评论、不记延续,轮次记发布失败原因", async () => {
  const fixture = await firstRound();
  const { forge, deps } = fixture;
  forge.forge.createReview = async () => {
    throw new Error("Gitea POST /repos/acme/widgets/pulls/7/reviews failed: 422 行号越界");
  };

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  assertPublishFailed(fixture, /422 行号越界/);
  assert.equal(forge.createdReviews.length, 1, "review 未创建,记录里只该有第一轮那条");
});

test("review 已创建但读回评论失败:按发布失败处理,review id 随原因保存,不自动重发", async () => {
  const fixture = await firstRound();
  const { forge, deps } = fixture;
  const publish = forge.forge.createReview;
  forge.forge.createReview = async (ref, draft) => {
    // Gitea 两步调用的第二步失败:review 已经在 Forge 上了,评论标识却没读回来。
    await publish(ref, draft);
    throw new PublishUncertainError("Gitea review 99 已创建,读回评论失败: 500", "99");
  };

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  assertPublishFailed(fixture, /99/);
  assert.equal(forge.createdReviews.length, 2, "这一轮发过一次;读回失败不该再发一次");
});

test("无法判定 review 是否已创建:按发布失败处理,原因说明不确定,不自动重发", async () => {
  const fixture = await firstRound();
  const { forge, deps } = fixture;
  forge.forge.createReview = async () => {
    throw new PublishUncertainError("Gitea POST 未收到响应,无法判定 review 是否已创建");
  };

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  assertPublishFailed(fixture, /无法判定/);
  assert.equal(forge.createdReviews.length, 1);
});

test("发布成功而 resolve 旧评论失败:仍记延续并标「交接未完成」,旧评论留在 Forge 上", async () => {
  const fixture = await firstRound();
  const { db, forge, deps } = fixture;
  const old = forge.publishedComments[0]!;
  forge.forge.resolveComment = async () => {
    throw new Error("Gitea POST /pulls/comments/1/resolve failed: 502");
  };

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  // 新评论发出去了,正文带「延续自」;延续照记,旧行带待办标记。
  const second = forge.createdReviews[1]!;
  assert.equal(second.comments.length, 1);
  assert.match(second.comments[0]!.body, /延续自/);
  assert.ok(second.comments[0]!.body.includes(old.htmlUrl));
  assert.deepEqual(findingRows(db.path), [
    { disposition: "continued", continuedFrom: null, handoffPending: 1 },
    { disposition: "unknown", continuedFrom: old.htmlUrl, handoffPending: null },
  ]);
  // 本轮是正常收尾:发布成了,resolve 没成只是交接的收尾动作没做完。
  const [, run] = runRows(db.path);
  assert.equal(run!.failure, null);
  const kinds = traceKinds(db.path, 2).map((event) => event.kind);
  assert.ok(kinds.includes("review_posted"));
  assert.ok(kinds.includes("run_finished"));
  const continued = traceKinds(db.path, 2).find((event) => event.kind === "finding_continued");
  assert.equal(
    (continued?.payload as { handoff?: string }).handoff,
    "pending",
    "轨迹不该声称交接完成",
  );

  // 面板:旧行不在阶段汇总里,承接它的那条标「交接未完成」;轮次投影上旧行自己带着
  // 标记,新行没有。
  const store = openStore(db.path);
  const summary = store.stageSummary({ owner: EVENT.owner, repo: EVENT.repo, pullNumber: 7 });
  const [firstRun, secondRun] = store.listRuns({ limit: 2 }).sort((a, b) => a.id - b.id);
  store.close();
  assert.equal(summary.findings.length, 1);
  assert.equal(summary.findings[0]!.handoffPending, true);
  assert.equal(summary.findings[0]!.continuedFrom, old.htmlUrl);
  assert.deepEqual(firstRun!.findings.map((finding) => finding.handoffPending), [true]);
  assert.deepEqual(secondRun!.findings.map((finding) => finding.handoffPending), [false]);
});

test("交接未完成的旧评论由下一轮 Review Run 收尾时重试 resolve,成功即清掉标记", async () => {
  const fixture = await firstRound();
  const { db, forge, deps } = fixture;
  const old = forge.publishedComments[0]!;
  const resolve = forge.forge.resolveComment;
  forge.forge.resolveComment = async () => {
    throw new Error("Gitea POST /pulls/comments/1/resolve failed: 502");
  };
  await runReview(EVENT, { ...deps, reviewers: continuing() });
  assert.deepEqual(forge.resolvedIds, []);

  // Forge 恢复;第二轮的新评论也成了既有评论(旧评论仍未 resolve)。第三轮只复核。
  forge.forge.resolveComment = resolve;
  forge.existingComments.push(
    ...forge.publishedComments.slice(1).map((comment) => ({ ...comment, resolved: false })),
  );
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "present")] });

  assert.deepEqual(forge.resolvedIds, [old.id], "下一轮该把待关闭的旧评论 resolve 掉");
  const rows = findingRows(db.path);
  assert.equal(rows[0]!.disposition, "continued");
  assert.equal(rows[0]!.handoffPending, null, "交接完成后标记该清掉");
  const store = openStore(db.path);
  const summary = store.stageSummary({ owner: EVENT.owner, repo: EVENT.repo, pullNumber: 7 });
  store.close();
  assert.equal(summary.findings[0]!.handoffPending, false);
});

test("回填读到交接未完成的旧评论已被 resolve:标记清掉,不再重试", async () => {
  const fixture = await firstRound();
  const { db, forge, deps } = fixture;
  const old = forge.publishedComments[0]!;
  forge.forge.resolveComment = async () => {
    throw new Error("Gitea POST /pulls/comments/1/resolve failed: 502");
  };
  await runReview(EVENT, { ...deps, reviewers: continuing() });

  // 人在 Forge 上把旧评论关了。第三轮读回它已 resolve;resolve 端点仍然坏着。
  forge.existingComments[0] = { ...old, resolved: true };
  forge.existingComments.push(
    ...forge.publishedComments.slice(1).map((comment) => ({ ...comment, resolved: false })),
  );
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "present")] });

  assert.deepEqual(forge.resolvedIds, [], "回填已经确认关闭,不该再去 resolve");
  const rows = findingRows(db.path);
  assert.equal(rows[0]!.disposition, "continued", "「已延续」的处置值不被回填覆盖");
  assert.equal(rows[0]!.handoffPending, null);
});

test("新评论标识没读回的那一条不算确认:不 resolve 旧评论、不记延续", async () => {
  const fixture = await firstRound();
  const { db, forge, deps } = fixture;
  const publish = forge.forge.createReview;
  forge.forge.createReview = async (ref, draft) => {
    // 平台读回的清单里没有这条评论:载体没确认,延续的交接不做。
    await publish(ref, draft);
    return [];
  };

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  assert.deepEqual(forge.resolvedIds, []);
  assert.deepEqual(findingRows(db.path), [
    { disposition: "unresolved", continuedFrom: null, handoffPending: null },
    { disposition: "unknown", continuedFrom: null, handoffPending: null },
  ]);
  const [, run] = runRows(db.path);
  assert.equal(run!.failure, null);
});

test("正常发布:新评论确认后才 resolve 旧评论,延续不带待办标记", async () => {
  const fixture = await firstRound();
  const { db, forge, deps } = fixture;
  const old = forge.publishedComments[0]!;
  const order: string[] = [];
  const publish = forge.forge.createReview;
  const resolve = forge.forge.resolveComment;
  forge.forge.createReview = async (ref, draft) => {
    order.push("publish");
    return publish(ref, draft);
  };
  forge.forge.resolveComment = async (ref, id) => {
    order.push(`resolve:${id}`);
    return resolve(ref, id);
  };

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  assert.deepEqual(order, ["publish", `resolve:${old.id}`]);
  assert.deepEqual(findingRows(db.path), [
    { disposition: "continued", continuedFrom: null, handoffPending: null },
    { disposition: "unknown", continuedFrom: old.htmlUrl, handoffPending: null },
  ]);
  const continued = traceKinds(db.path, 2).find((event) => event.kind === "finding_continued");
  assert.equal((continued?.payload as { handoff?: string }).handoff, "complete");
});
