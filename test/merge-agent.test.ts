/**
 * 合并去重交给合并 agent(issue #228)。
 *
 * 打在 `runReview` 的注入边界上(先例 `multi-reviewer`、`review-trace`):脚本化 Reviewer
 * 给 Finding,脚本化 MergeAgent 给分组方案,内存 Forge 跑一轮,断言最终评论条数、每条的
 * 归属与折叠,以及轨迹里的合并与回退事件。不测 prompt 文本,也不测内部调用序列。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { MERGE_AGENT_TRACE_NAME, runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import {
  memoryForge,
  scriptedMergeAgent,
  scriptedReviewer,
  type MemoryForge,
} from "./support/memory-forge.ts";

const BASE_M = `export function sub(a, b) {
  return a - b;
}

export function mul(a, b) {
  return a * b;
}

export function div(a, b) {
  return a / b;
}

export function mod(a, b) {
  return a % b;
}
`;

// 改第 2 行与第 14 行,两个 hunk 各带 3 行上下文,新侧覆盖 1..5 与 11..17。
const HEAD_M = BASE_M.replace("return a - b;", "return a - b - 1;").replace(
  "return a % b;",
  "return a % b + 0;",
);

const BASE_N = `export function inc(n) {
  return n + 1;
}
`;
const HEAD_N = BASE_N.replace("return n + 1;", "return n + 2;");

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const EVENT = { owner: "acme", repo: "widgets", number: 1 };

function setup() {
  const repo = makeRepo({
    base: { "src/m.js": BASE_M, "src/n.js": BASE_N },
    head: { "src/m.js": HEAD_M, "src/n.js": HEAD_N },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: 1,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [
      { path: "src/m.js", status: "modified" },
      { path: "src/n.js", status: "modified" },
    ],
  });

  return { cache, db, forge };
}

/** 一条 Finding 的模板。用例只改位置与那两段文本。 */
const AT = (line: number, title: string, description = title) => ({
  file: "src/m.js",
  line,
  severity: "P1" as const,
  category: "bug" as const,
  title,
  description,
});

/** 这一轮落库的全部轨迹事件。 */
function trace(dbPath: string): {
  scope: string;
  reviewer?: string;
  kind: string;
  payload: Record<string, unknown>;
}[] {
  const store = openStore(dbPath);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    return store.listTrace(runId).map((event) => ({
      scope: event.scope,
      ...(event.reviewer === undefined ? {} : { reviewer: event.reviewer }),
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
    }));
  } finally {
    store.close();
  }
}

test("分组方案过验收即生效:同一行的两个问题被拆开,相邻的同一个问题被合并", async () => {
  const { cache, db, forge } = setup();
  const merge = scriptedMergeAgent(
    [
      { members: [0, 2], reason: "两条说的都是余额校验被删掉" },
      { members: [1], reason: "类型校验是另一个问题" },
    ],
    { events: [{ kind: "assistant_message", text: "先看这三条讲的是不是一回事" }] },
  );

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "删除了余额校验")]),
      scriptedReviewer("model-b", [AT(2, "删除了类型校验"), AT(3, "余额校验被删掉了")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: merge,
  });

  // 词面重叠会把这三条串成一组(第 2 行两条同行、第 3 行相距 1 行);agent 分成两组。
  assert.deepEqual(merge.calls[0]!.map((f) => f.title), [
    "删除了余额校验",
    "删除了类型校验",
    "余额校验被删掉了",
  ]);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[0]!.attributions.map((a) => a.model), ["model-a", "model-b"]);
  assert.equal(result.findings[0]!.title, "删除了余额校验");
  assert.deepEqual(result.findings[1]!.attributions.map((a) => a.model), ["model-b"]);
  assert.equal(result.findings[1]!.title, "删除了类型校验");
  assert.equal(forge.createdReviews[0]!.comments.length, 2);

  const events = trace(db.path);
  // 真的合并了的那一组发一条事件,判据是 agent 档,带它给的那句理由。
  const merged = events.filter((event) => event.kind === "finding_merged");
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.payload["criteria"], {
    kind: "agent",
    reason: "两条说的都是余额校验被删掉",
  });
  assert.deepEqual(merged[0]!.payload["members"], [
    { reviewer: "model-a", line: 2, title: "删除了余额校验" },
    { reviewer: "model-b", line: 3, title: "余额校验被删掉了" },
  ]);
  // 合并 agent 的过程进本轮轨迹,与 Reviewer 同一待遇。
  assert.deepEqual(
    events
      .filter((event) => event.reviewer === MERGE_AGENT_TRACE_NAME)
      .map((event) => event.kind),
    ["assistant_message"],
  );
  assert.equal(events.filter((event) => event.kind === "merge_fallback").length, 0);
});

test("单成员组不产生合并事件", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "删除了余额校验")]),
      scriptedReviewer("model-b", [AT(2, "删除了类型校验")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      { members: [0], reason: "余额校验" },
      { members: [1], reason: "类型校验" },
    ]),
  });

  assert.equal(result.findings.length, 2);
  assert.equal(trace(db.path).filter((event) => event.kind === "finding_merged").length, 0);
});

test("同一个模型逐字重复报的两条,合进同一组后仍折叠成一段归属", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "sub 多减了 1"), AT(3, "sub 多减了 1")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([{ members: [0, 1], reason: "同一个减法错误报了两遍" }]),
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]!.attributions.map((a) => a.title), ["sub 多减了 1"]);
  assert.equal(forge.createdReviews[0]!.comments.length, 1);
});

/** 方案没过验收时的共同断言:退回算法档的一条,轨迹留一条回退事件。 */
async function assertFallback(
  groups: Parameters<typeof scriptedMergeAgent>[0],
  extra?: Parameters<typeof scriptedMergeAgent>[1],
  findings: readonly ReturnType<typeof AT>[] = [AT(2, "删除了余额校验"), AT(3, "余额校验被删了")],
): Promise<{ reason: string; count: number }> {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [findings[0]!]),
      scriptedReviewer("model-b", [findings[1]!]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent(groups, extra),
  });

  const fallbacks = trace(db.path).filter((event) => event.kind === "merge_fallback");
  assert.equal(fallbacks.length, 1, "回退该在轨迹里留一条记录");
  return { reason: String(fallbacks[0]!.payload["reason"]), count: result.findings.length };
}

test("带空组的分组方案整体回退,不掀掉整轮审查", async () => {
  // 空组曾让验收在取代表时当场抛 TypeError,异常穿透 mergeFindings 掀掉整轮
  // (code review 实测复现)。验收的职责是把一切不成立的方案挡成回退。
  const { reason, count } = await assertFallback([
    { members: [0, 1], reason: "同一个问题" },
    { members: [], reason: "误产出的空组" },
  ]);
  assert.match(reason, /没有任何成员/);
  assert.equal(count, 1);
});

test("丢掉一条 Finding 的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback([{ members: [0], reason: "只报了一组" }]);
  assert.match(reason, /没有被分进/);
  // 算法档把这两条合成一条:回退之后的结果就是它。
  assert.equal(count, 1);
});

test("一条 Finding 出现在两组里的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback([
    { members: [0, 1], reason: "同一个问题" },
    { members: [1], reason: "又报了一遍" },
  ]);
  assert.match(reason, /被分进了两组/);
  assert.equal(count, 1);
});

test("成员跨文件的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback(
    [{ members: [0, 1], reason: "两个文件里的同一个问题" }],
    undefined,
    [AT(2, "删除了余额校验"), { ...AT(2, "inc 加错了"), file: "src/n.js" }],
  );
  assert.match(reason, /混了不同文件/);
  // 两个文件各一条,算法档也不会把它们合起来。
  assert.equal(count, 2);
});

test("组内行距越界的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback(
    [{ members: [0, 1], reason: "隔得远也是同一个问题" }],
    undefined,
    [AT(2, "删除了余额校验"), AT(14, "mod 加了 0")],
  );
  assert.match(reason, /相距超过 3 行/);
  assert.equal(count, 2);
});

test("合并 agent 报失败时整体回退", async () => {
  const { reason, count } = await assertFallback([], { failure: "模型调用超时" });
  assert.equal(reason, "模型调用超时");
  assert.equal(count, 1);
});

test("合并 agent 抛异常时整体回退,整轮审查照常完成", async () => {
  const { reason, count } = await assertFallback([], { throws: "子进程无法启动" });
  assert.equal(reason, "子进程无法启动");
  assert.equal(count, 1);
});

test("回退之后的结果与没有合并 agent 时逐字一致", async () => {
  const reviewers = () => [
    scriptedReviewer("model-a", [AT(2, "删除了余额校验")]),
    scriptedReviewer("model-b", [AT(3, "余额校验被删了"), AT(14, "mod 加了 0")]),
  ];

  const withAgent = setup();
  const fallen = await runReview(EVENT, {
    forge: withAgent.forge.forge,
    reviewers: reviewers(),
    cacheDir: withAgent.cache.dir,
    dbPath: withAgent.db.path,
    mergeAgent: scriptedMergeAgent([], { failure: "模型调用失败" }),
  });

  const withoutAgent = setup();
  const algorithmic = await runReview(EVENT, {
    forge: withoutAgent.forge.forge,
    reviewers: reviewers(),
    cacheDir: withoutAgent.cache.dir,
    dbPath: withoutAgent.db.path,
  });

  assert.deepEqual(fallen.findings, algorithmic.findings);
  assert.deepEqual(
    withAgent.forge.createdReviews[0]!.comments,
    withoutAgent.forge.createdReviews[0]!.comments,
  );
});

/**
 * 合并 agent 的输入扩到同文件历史(issue #240,ADR 0022 的 2026-09-04 修订附记)。
 *
 * 两轮同一份代码:第一轮报出的那条留在 Forge 上当既有评论,第二轮换个说法在别处重报,
 * 由脚本化 agent 把它与那条历史分进同一组。断言的仍只有外部行为——交给 agent 的历史
 * 是哪一批、本轮那条发不发评论、落库折叠到哪条评论,以及轨迹上的判据。
 */

/** 人在面板上处置一条 Finding,Forge 上那条评论一并置为已 resolve。 */
function dispose(dbPath: string, forge: MemoryForge, commentId: string): void {
  const store = openStore(dbPath);
  try {
    store.recordDisposition({
      owner: EVENT.owner,
      repo: EVENT.repo,
      commentId,
      disposition: "resolved",
      disposedBy: "kassol",
      disposedAt: "2026-09-04T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
  for (const comment of forge.existingComments) {
    if (comment.id === commentId) comment.resolved = true;
  }
}

/**
 * 跑第一轮,并把它真的发出去的行级评论当成 Forge 上的既有评论喂给下一轮:跨轮次的
 * 折叠认的就是那几条评论(先例 `cross-run`)。head 不动,旧指纹在第二轮仍算得出。
 */
async function firstRun(
  ctx: ReturnType<typeof setup>,
  findings: readonly ReturnType<typeof AT>[],
): Promise<void> {
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", findings)],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
  });
  ctx.forge.existingComments.push(
    ...ctx.forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );
}

/** 落库的每条 Finding:处置状态与它挂着的那条评论。 */
function findingRows(dbPath: string): { disposition: string; commentId: unknown }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT disposition, comment_id FROM finding ORDER BY id")
        .all() as unknown as Record<string, unknown>[]
    ).map((row) => ({ disposition: String(row["disposition"]), commentId: row["comment_id"] }));
  } finally {
    db.close();
  }
}

test("合并请求里的历史只含本轮有 Finding 的文件,未处置与已处置都在", async () => {
  const ctx = setup();
  await firstRun(ctx, [
    AT(2, "余额校验被删掉"),
    AT(14, "mod 加了 0"),
    { ...AT(2, "inc 加错了"), file: "src/n.js" },
  ]);
  // 第一条被人处置掉:两档历史都要进合并请求。
  dispose(ctx.db.path, ctx.forge, "comment-1");

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "还是那处余额校验" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(2, "余额校验没了")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(
    merge.historyCalls[0]!.map((entry) => [entry.file, entry.disposition]),
    [
      ["src/m.js", "resolved"],
      ["src/m.js", "unknown"],
    ],
    "只该给本轮有 Finding 报出的那个文件的历史,两档都在",
  );
});

test("agent 把本轮一条与旧指纹仍在的历史分成一组:不发评论,折叠到旧条,判据是 agent", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);

  // 第 14 行离第 2 行 12 行远,指纹滑窗够不着:能把这两条接上的只有合并 agent。
  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "换了说法的同一处余额校验" },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.inlineCount, 0, "折叠到旧评论的那条不再发新评论");
  assert.deepEqual(ctx.forge.createdReviews[1]!.comments, []);
  assert.deepEqual(findingRows(ctx.db.path)[1], {
    disposition: "unresolved",
    commentId: "comment-1",
  });

  const folded = trace(ctx.db.path).filter((event) => event.kind === "finding_folded");
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0]!.payload["criteria"], {
    kind: "agent",
    reason: "换了说法的同一处余额校验",
  });
});

test("命中已处置的历史:本轮那条沉默,落库折叠到已处置", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  dispose(ctx.db.path, ctx.forge, "comment-1");

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "这处已经处置过了" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(ctx.forge.createdReviews[1]!.comments, [], "已处置过的那处不再打扰");
  assert.deepEqual(findingRows(ctx.db.path)[1], {
    disposition: "resolved",
    commentId: "comment-1",
  });
});

test("含历史成员的组行距超容差仍过验收", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(14, "mod 加了 0")]);

  // 本轮两条相距 9 行:不含历史的组会被行距那一条挡下来,含历史的这一组免验。
  const merge = scriptedMergeAgent((request) => [
    {
      members: [0, 1],
      history: [request.history![0]!.id],
      reason: "代码改写之后这个问题漂到了两处",
    },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "取模的结果偏了")]),
      scriptedReviewer("model-b", [AT(11, "取模结果不对")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.equal(trace(ctx.db.path).filter((e) => e.kind === "merge_fallback").length, 0);
  assert.equal(result.findings.length, 1);
});

test("同一条历史被分进两组的方案整体作废回退", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(14, "mod 加了 0")]);

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "是它" },
    { members: [1], history: [request.history![0]!.id], reason: "也是它" },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "取模的结果偏了")]),
      scriptedReviewer("model-b", [AT(11, "取模结果不对")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  const fallbacks = trace(ctx.db.path).filter((e) => e.kind === "merge_fallback");
  assert.equal(fallbacks.length, 1);
  assert.match(String(fallbacks[0]!.payload["reason"]), /被分进了两组/);
  // 回退到算法档:相距 9 行的两条各自成条。
  assert.equal(result.findings.length, 2);
});

test("带上历史之后回退档的结果仍与没有合并 agent 时逐字一致", async () => {
  const withAgent = setup();
  await firstRun(withAgent, [AT(2, "余额校验被删掉")]);
  const fallen = await runReview(EVENT, {
    forge: withAgent.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: withAgent.cache.dir,
    dbPath: withAgent.db.path,
    mergeAgent: scriptedMergeAgent([], { failure: "模型调用失败" }),
  });

  const withoutAgent = setup();
  await firstRun(withoutAgent, [AT(2, "余额校验被删掉")]);
  const algorithmic = await runReview(EVENT, {
    forge: withoutAgent.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: withoutAgent.cache.dir,
    dbPath: withoutAgent.db.path,
  });

  assert.deepEqual(fallen.findings, algorithmic.findings);
  assert.deepEqual(
    withAgent.forge.createdReviews[1]!.comments,
    withoutAgent.forge.createdReviews[1]!.comments,
  );
  assert.deepEqual(findingRows(withAgent.db.path), findingRows(withoutAgent.db.path));
});
