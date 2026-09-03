/**
 * 审查轨迹的落库(CONTEXT.md,issue #171,ADR 0017)。
 *
 * 打在 Reviewer 注入边界上(先例 `multi-reviewer`、`cross-run`):脚本化 Reviewer 发预置
 * 事件,内存 Forge 跑一轮,断言库里落了哪些行。不断言子进程内部的订阅细节。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { ReviewerEvent } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const BASE = `export function sub(a, b) {
  return a - b;
}

export function mul(a, b) {
  return a * b;
}
`;
const HEAD = BASE.replace("return a - b;", "return a - b - 1;");

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const EVENT = { owner: "acme", repo: "widgets", number: 1 };

function setup() {
  const repo = makeRepo({ base: { "src/m.js": BASE }, head: { "src/m.js": HEAD } });
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
    changedFiles: [{ path: "src/m.js", status: "modified" }],
  });
  return { repo, cache, db, forge };
}

const AT_LINE_2 = {
  file: "src/m.js",
  line: 2,
  severity: "P0" as const,
  category: "bug" as const,
  title: "sub 多减了 1",
  description: "sub 多减了 1",
};

/** 这一轮落库的全部轨迹事件。 */
function trace(dbPath: string): {
  seq: number;
  scope: string;
  reviewer?: string;
  kind: string;
  payload: Record<string, unknown>;
}[] {
  const store = openStore(dbPath);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    return store.listTrace(runId).map((event) => ({
      seq: event.seq,
      scope: event.scope,
      ...(event.reviewer === undefined ? {} : { reviewer: event.reviewer }),
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
    }));
  } finally {
    store.close();
  }
}

const SAID: ReviewerEvent = { kind: "assistant_message", text: "先读一遍 src/m.js" };
const READ: ReviewerEvent = {
  kind: "tool_call",
  tool: "read",
  args: { path: "src/m.js" },
  durationMs: 12,
  isError: false,
  error: null,
  resultLength: 64,
};
const REJECTED: ReviewerEvent = {
  kind: "tool_call",
  tool: "report_finding",
  args: { file: "src/m.js", line: 2, severity: "critical" },
  durationMs: 3,
  isError: true,
  error: "severity must be one of P0, P1, P2",
  resultLength: 34,
};

test("Reviewer 发出的事件按发生顺序落进这一轮的轨迹,带模型标识", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT_LINE_2], { events: [SAID, READ, REJECTED] })],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const reviewerEvents = trace(db.path).filter((e) => e.scope === "reviewer");
  assert.deepEqual(
    reviewerEvents.map((e) => e.kind),
    ["assistant_message", "tool_call", "tool_call", "reviewer_finished"],
  );
  assert.ok(
    reviewerEvents.every((e) => e.reviewer === "model-a"),
    "每条 Reviewer 级事件都要认得出是哪个模型的",
  );
  // 载荷带这条事件出自第几批(issue #232);`reviewer_finished` 是整个模型的收尾,不带它。
  assert.deepEqual(reviewerEvents[0]!.payload, { text: "先读一遍 src/m.js", batch: 1 });
  assert.deepEqual(reviewerEvents[1]!.payload, {
    tool: "read",
    args: { path: "src/m.js" },
    durationMs: 12,
    isError: false,
    error: null,
    resultLength: 64,
    batch: 1,
  });
  // 被拒的那次带原因,返回正文只留长度(ADR 0017)。
  assert.equal(reviewerEvents[2]!.payload["isError"], true);
  assert.equal(reviewerEvents[2]!.payload["error"], "severity must be one of P0, P1, P2");
  assert.deepEqual(reviewerEvents[3]!.payload, {
    findings: 1,
    rejectedToolCalls: 0,
    anchorRejections: 0,
    usage: null,
  });

  // 序号在一轮之内自增且不重复,断线续传按它续。
  assert.deepEqual(
    trace(db.path).map((e) => e.seq),
    trace(db.path).map((_, index) => index + 1),
  );
});

test("轮次级编排事件按顺序落库:工作副本、批次起止、评论已发、轮次结束", async () => {
  const { repo, cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT_LINE_2])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const runEvents = trace(db.path).filter((e) => e.scope === "run");
  assert.deepEqual(
    runEvents.map((e) => e.kind),
    ["worktree_ready", "batch_started", "batch_finished", "review_posted", "run_finished"],
  );
  assert.equal(runEvents[0]!.payload["headSha"], repo.headSha);
  assert.equal(typeof runEvents[0]!.payload["baseSha"], "string");
  assert.deepEqual(runEvents[1]!.payload, { index: 1, total: 1, files: ["src/m.js"] });
  assert.deepEqual(runEvents[2]!.payload, { index: 1, total: 1, files: ["src/m.js"] });
  assert.deepEqual(runEvents[3]!.payload, { findingCount: 1 });
  assert.deepEqual(runEvents[4]!.payload, { failed: false, findingCount: 1 });
});

test("锚不进 diff hunk 的 Finding 被丢弃,轨迹留下一条被拒记录", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        AT_LINE_2,
        // 改的是第 2 行,-U3 的 hunk 覆盖 1..5 行;mul 的收尾落在变更之外。
        { ...AT_LINE_2, line: 7, title: "mul 没有溢出保护" },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const discarded = trace(db.path).filter((e) => e.kind === "finding_discarded");
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]!.scope, "run", "丢弃是编排层的事,挂在轮次上");
  assert.deepEqual(discarded[0]!.payload, {
    file: "src/m.js",
    line: 7,
    title: "mul 没有溢出保护",
    reviewers: ["model-a"],
  });

  // 丢掉的那条不进 review:既不作行级评论,也不写进正文。
  const review = forge.createdReviews[0]!;
  assert.deepEqual(
    review.comments.map((comment) => comment.line),
    [2],
  );
  assert.doesNotMatch(review.body, /mul 没有溢出保护/);
});

test("两个模型报同一行:一条合并事件,成员齐全,判据是同一行", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT_LINE_2]),
      scriptedReviewer("model-b", [{ ...AT_LINE_2, title: "减法结果偏移" }]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const merges = trace(db.path).filter((e) => e.kind === "finding_merged");
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.scope, "run", "合并是编排层的事,挂在轮次上");
  assert.deepEqual(merges[0]!.payload, {
    file: "src/m.js",
    line: 2,
    members: [
      { reviewer: "model-a", line: 2, title: "sub 多减了 1" },
      { reviewer: "model-b", line: 2, title: "减法结果偏移" },
    ],
    criteria: { kind: "same_line" },
  });
});

test("行号相近而内容相似的两条:合并事件的判据带行距与相似度", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT_LINE_2]),
      // 差 2 行、标题共享「sub」与「多减」,靠行距容差那一档并进来。
      scriptedReviewer("model-b", [{ ...AT_LINE_2, line: 4, title: "sub 多减了一次" }]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const merges = trace(db.path).filter((e) => e.kind === "finding_merged");
  assert.equal(merges.length, 1);
  const criteria = merges[0]!.payload["criteria"] as Record<string, unknown>;
  assert.equal(criteria["kind"], "distance");
  assert.equal(criteria["distance"], 2);
  const similarity = criteria["similarity"] as number;
  assert.ok(
    similarity > 0 && similarity <= 1,
    "靠行距容差并进来的必须带上那道相似度原值,否则解释不了为什么合",
  );
});

test("相邻但讲的不是一回事:两条各自成组,一条合并事件都不发", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT_LINE_2]),
      scriptedReviewer("model-b", [
        { ...AT_LINE_2, line: 4, title: "文档缺失", description: "文档缺失" },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.findings.length, 2, "内容不相似的相邻两条不该合并");
  assert.deepEqual(
    trace(db.path).filter((e) => e.kind === "finding_merged"),
    [],
    "没有合并就不该有合并事件",
  );
});

test("Reviewer 失败:末尾一条失败事件带原因,它之前发出的事件仍然保留", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [], { events: [SAID], failure: "模型返回 401" }),
      scriptedReviewer("model-b", [AT_LINE_2]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const failed = trace(db.path).filter((e) => e.reviewer === "model-a");
  assert.deepEqual(
    failed.map((e) => e.kind),
    ["assistant_message", "reviewer_failed"],
    "崩溃前已经发生的事件要留着,失败原因补在末尾",
  );
  assert.deepEqual(failed[1]!.payload, { failure: "模型返回 401", exitCode: null });
  // 跑成功的那个走的是另一档,两者不混。
  assert.equal(
    trace(db.path).find((e) => e.reviewer === "model-b")!.kind,
    "reviewer_finished",
  );
});

test("两轮各记各的轨迹,序号各自从 1 起", async () => {
  const { repo, cache, db, forge } = setup();
  const deps = {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT_LINE_2], { events: [SAID] })],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  await runReview(EVENT, deps);
  forge.pullRequest.headSha = repo.headSha;
  await runReview(EVENT, deps);

  const store = openStore(db.path);
  try {
    const runs = store.listRuns({ limit: 10 });
    assert.equal(runs.length, 2);
    for (const run of runs) {
      const events = store.listTrace(run.id);
      assert.ok(events.length > 0, "每一轮都要有自己的轨迹");
      assert.equal(events[0]!.seq, 1, "序号在一轮之内自增,跨轮不接着数");
      assert.ok(events.every((event) => event.runId === run.id));
    }
  } finally {
    store.close();
  }
});

test("afterSeq 只回它之后的那些事件", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT_LINE_2], { events: [SAID, READ] })],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  const store = openStore(db.path);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    const all = store.listTrace(runId);
    assert.deepEqual(
      store.listTrace(runId, 3).map((event) => event.seq),
      all.slice(3).map((event) => event.seq),
    );
  } finally {
    store.close();
  }
});

/** 一次取证调用:子会话的事件嵌在它下面(issue #227)。 */
const EVIDENCE: ReviewerEvent = {
  kind: "tool_call",
  tool: "subagent",
  args: { agent: "evidence", task: "谁调用 sub" },
  durationMs: 840,
  isError: false,
  error: null,
  resultLength: 96,
  nested: [
    { kind: "assistant_message", text: "先 grep 一遍 sub 的调用方" },
    {
      kind: "tool_call",
      tool: "grep",
      args: { pattern: "sub\\(" },
      durationMs: 9,
      isError: false,
      error: null,
      resultLength: 21,
    },
    { kind: "assistant_message", text: "src/m.js:1 定义,仓库内没有别的调用方" },
  ],
};

test("取证子会话的事件随那次调用一起落库,实时与回看是同一条路径(issue #227)", async () => {
  const { cache, db, forge } = setup();

  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT_LINE_2], { events: [SAID, EVIDENCE] })],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  // 实时广播与历史回看读的是同一批行(`createTraceRecorder` 把落库与广播合成一个动作),
  // 因此库里读回来嵌套一格不少,即两条路径都拿得到它。
  const calls = trace(db.path).filter((e) => e.kind === "tool_call");
  assert.equal(calls.length, 1);
  const payload = calls[0]!.payload;
  assert.equal(calls[0]!.reviewer, "model-a", "嵌套事件与它所属的 Reviewer 关联");
  assert.deepEqual(payload["args"], { agent: "evidence", task: "谁调用 sub" });
  assert.deepEqual(payload["nested"], EVIDENCE.kind === "tool_call" ? EVIDENCE.nested : undefined);
});
