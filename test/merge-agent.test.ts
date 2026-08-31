/**
 * 合并去重交给合并 agent(issue #228)。
 *
 * 打在 `runReview` 的注入边界上(先例 `multi-reviewer`、`review-trace`):脚本化 Reviewer
 * 给 Finding,脚本化 MergeAgent 给分组方案,内存 Forge 跑一轮,断言最终评论条数、每条的
 * 归属与折叠,以及轨迹里的合并与回退事件。不测 prompt 文本,也不测内部调用序列。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { MERGE_AGENT_TRACE_NAME, runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedMergeAgent, scriptedReviewer } from "./support/memory-forge.ts";

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
