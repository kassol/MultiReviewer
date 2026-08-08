import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { ExistingReviewComment, ReviewDraft } from "../src/forge/forge.ts";
import { runReview } from "../src/review/run.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

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

// Finding 指向第 6 行,指纹窗口覆盖 3..9 行。改 mul 落在窗口之外,指纹不变。
const UNRELATED_CHANGE = HEAD.replace("return a * b;", "return a * b * 2;");
// 改的正是 Finding 指向的那一行,指纹必变。
const SAME_LINE_CHANGE = HEAD.replace("return a - b - 1;", "return a - b - 2;");

const EVENT = { owner: "acme", repo: "widgets", number: 7 };

const FINDING = {
  file: "src/calc.js",
  line: 6,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub 多减了 1",
};

const ANCHOR = /<!-- multireviewer:([0-9a-f]{64}) -->/;

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

/** 把上一轮真的发布出去的行级评论,当成 Forge 上的既有评论喂给下一轮。 */
function asExisting(draft: ReviewDraft, resolved: boolean): ExistingReviewComment[] {
  return draft.comments.map((comment, index) => ({
    id: `thread-${index}`,
    path: comment.path,
    line: comment.line,
    body: comment.body,
    resolved,
  }));
}

function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** 本轮落库的 disposition。第二次 Review Run 的记录 id 更大。 */
function latestDispositions(dbPath: string): string[] {
  return query(dbPath, "SELECT disposition FROM finding ORDER BY id").map(
    (row) => String(row["disposition"]),
  );
}

test("代码未变且上一轮已处置:本轮不发行级评论,折叠段里标注曾被处置", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, [], "已处置且代码未变的 Finding 又被发成了行级评论");
  assert.match(second.body, /<details>/);
  assert.match(second.body, /曾被处置/);
  // 误匹配时人展开就能看到完整内容。
  assert.match(second.body, /src\/calc\.js:6/);
  assert.match(second.body, /sub 多减了 1/);
  assert.match(second.body, /P0 · bug/);
  assert.match(second.body, /model-a/);

  assert.deepEqual(latestDispositions(db.path), ["unknown", "resolved"]);
});

test("上一轮已处置但代码已改动:本轮按新 Finding 正常提出", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, deps);

  const second = forge.createdReviews[1]!;
  assert.deepEqual(
    second.comments.map((c) => ({ path: c.path, line: c.line })),
    [{ path: "src/calc.js", line: 6 }],
  );
  assert.doesNotMatch(second.body, /<details>/);
  assert.deepEqual(latestDispositions(db.path), ["unknown", "unknown"]);
});

test("代码未变且上一轮未处置:折叠并标注尚未处置", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, []);
  assert.match(second.body, /<details>/);
  assert.match(second.body, /尚未处置/);
  assert.match(second.body, /sub 多减了 1/);

  assert.deepEqual(latestDispositions(db.path), ["unknown", "unresolved"]);
});

test("人写的评论不带锚点,不参与匹配", async () => {
  const { db, forge, deps } = setup();

  forge.existingComments.push({
    id: "human-1",
    path: "src/calc.js",
    line: 6,
    body: "这处我看过了,没问题",
    resolved: true,
  });

  await runReview(EVENT, deps);

  const review = forge.createdReviews[0]!;
  assert.equal(review.comments.length, 1, "人写的评论把本轮 Finding 折叠掉了");
  assert.doesNotMatch(review.body, /<details>/);
  assert.deepEqual(latestDispositions(db.path), ["unknown"]);
});

test("发布的行级评论正文带指纹锚点,锚点与落库的指纹一致", async () => {
  const { db, forge, deps } = setup();

  await runReview(EVENT, deps);

  const anchor = ANCHOR.exec(forge.createdReviews[0]!.comments[0]!.body);
  assert.ok(anchor !== null, "行级评论正文里没有指纹锚点");
  assert.equal(anchor[1], query(db.path, "SELECT fingerprint FROM finding")[0]!["fingerprint"]);
});
