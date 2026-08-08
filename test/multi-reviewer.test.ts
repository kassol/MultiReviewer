import assert from "node:assert/strict";
import { after, test } from "node:test";

import { runReview } from "../src/review/run.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const BASE = `export function sub(a, b) {
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

// 改第 2 行与第 18 行,两个 hunk 各带 3 行上下文,新侧覆盖 1..5 与 15..21。
const HEAD = BASE.replace("return a - b;", "return a - b - 1;").replace(
  "return a % b;",
  "return a % b + 0;",
);

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function setup() {
  const repo = makeRepo({ base: { "src/m.js": BASE }, head: { "src/m.js": HEAD } });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: 1,
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/m.js", status: "modified" }],
  });

  return { cache, db, forge, event: { owner: "acme", repo: "widgets", number: 1 } };
}

const AT_LINE_2 = {
  file: "src/m.js",
  line: 2,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub 多减了 1",
};

test("两个模型对同一处的 Finding 合并为一条,来源模型齐全", async () => {
  const { cache, db, forge, event } = setup();

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT_LINE_2]),
      scriptedReviewer("model-b", [{ ...AT_LINE_2, description: "减法结果偏移" }]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual([...result.findings[0]!.models].sort(), ["model-a", "model-b"]);

  const review = forge.createdReviews[0]!;
  assert.equal(review.comments.length, 1);
  // 评论是给开发者的最终结果:只呈现合并后的一份内容,不出现模型署名。
  assert.match(review.comments[0]!.body, /sub 多减了 1/);
  assert.doesNotMatch(review.comments[0]!.body, /model-a|model-b|减法结果偏移/);
  // 合并不丢内容:另一个模型的表述保留在来源里,落库供采纳率统计。
  assert.deepEqual(
    result.findings[0]!.sources.map((s) => s.description).sort(),
    ["sub 多减了 1", "减法结果偏移"],
  );
});

test("行号相差在阈值内视为同一处,超出阈值分开", async () => {
  const { cache, db, forge, event } = setup();

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT_LINE_2]),
      // 第 4 行与第 2 行相差 2,在阈值内;第 18 行远在阈值外。
      scriptedReviewer("model-b", [
        { ...AT_LINE_2, line: 4 },
        { ...AT_LINE_2, line: 18, description: "mod 加了 0" },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.findings.length, 2);
  const merged = result.findings.find((f) => f.line <= 4)!;
  assert.deepEqual([...merged.models].sort(), ["model-a", "model-b"]);
  const separate = result.findings.find((f) => f.line === 18)!;
  assert.deepEqual(separate.models, ["model-b"]);
});

test("不同文件的同一行号不合并", async () => {
  const repo = makeRepo({
    base: { "src/m.js": BASE, "src/n.js": BASE },
    head: { "src/m.js": HEAD, "src/n.js": HEAD },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: 1,
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

  const result = await runReview(
    { owner: "acme", repo: "widgets", number: 1 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", [AT_LINE_2, { ...AT_LINE_2, file: "src/n.js" }]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  assert.equal(result.findings.length, 2);
});

test("一个 Reviewer 失败时其余结果照常发布,正文列出缺席的模型", async () => {
  const { cache, db, forge, event } = setup();

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT_LINE_2]),
      scriptedReviewer("model-b", [], { failure: "402 dead credential" }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.failed, false);
  assert.equal(forge.createdReviews.length, 1);
  const review = forge.createdReviews[0]!;
  assert.equal(review.comments.length, 1);
  assert.match(review.body, /model-b/);
  assert.match(review.body, /缺席|未参与|失败/);
});

test("全部 Reviewer 失败时记录为失败,且不发布空的 review", async () => {
  const { cache, db, forge, event } = setup();

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [], { failure: "timeout" }),
      scriptedReviewer("model-b", [], { failure: "402" }),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.failed, true);
  assert.deepEqual(forge.createdReviews, []);
});

test("零 Finding 但 Reviewer 都成功时,不算失败", async () => {
  const { cache, db, forge, event } = setup();

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [])],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.failed, false);
});
