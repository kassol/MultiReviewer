import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { createReviewRunPlan, runReview } from "../src/review/run.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";
import type { Reviewer } from "../src/review/finding.ts";

const BASE_CALC = `export function add(a: number, b: number) {
  return a + b;
}

export function sub(a: number, b: number) {
  return a - b;
}

export function mul(a: number, b: number) {
  return a * b;
}
`;

// 只改第 6 行。-U3 的 hunk 因此覆盖新文件的 3..9 行,第 11 行落在 diff 之外。
const HEAD_CALC = BASE_CALC.replace("return a - b;", "return a - b - 1;");

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function setup(findingLine: number) {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
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
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });

  const reviewer = scriptedReviewer("stub-model", [
    {
      file: "src/calc.ts",
      line: findingLine,
      severity: "P0",
      category: "bug",
      description: "sub() 多减了 1",
    },
  ]);

  return { repo, cache, db, forge, reviewer };
}

test("行号落在 diff 内的 Finding 发布为行级评论", async () => {
  const { cache, db, forge, reviewer } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.equal(forge.createdReviews.length, 1);
  const review = forge.createdReviews[0]!;
  assert.deepEqual(
    review.comments.map((c) => ({ path: c.path, line: c.line })),
    [{ path: "src/calc.ts", line: 6 }],
  );
  assert.match(review.comments[0]!.body, /sub\(\) 多减了 1/);
});

test("行号落不到 diff 内的 Finding 退化为 PR 级评论且内容不丢", async () => {
  const { cache, db, forge, reviewer } = setup(11);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.equal(forge.createdReviews.length, 1);
  const review = forge.createdReviews[0]!;
  assert.deepEqual(review.comments, []);
  assert.match(review.body, /sub\(\) 多减了 1/);
  assert.match(review.body, /src\/calc\.ts/);
  assert.match(review.body, /11/);
});

test("评论按 等级/标题 加逐模型的 问题/影响/建议 分段呈现", async () => {
  const { cache, db, forge } = setup(6);
  // 两个模型报同一处:合并后也只呈现一份内容,另一个模型的表述不进评论。
  const finding = {
    file: "src/calc.ts",
    line: 6,
    severity: "P0" as const,
    category: "bug" as const,
    title: "sub 多减了 1",
    description: "sub() 的返回值比正确结果小 1。",
    impact: "所有调用方拿到的差值都错。",
    suggestion: "去掉多余的 - 1。",
  };
  const other = { ...finding, description: "减法结果不对。" };

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", [finding]),
        scriptedReviewer("model-b", [other]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const body = forge.createdReviews[0]!.comments[0]!.body;
  const [heading] = body.split("\n");
  assert.equal(heading, "**[P0] sub 多减了 1**");
  assert.match(body, /\n\n\*\*model-a\*\*\n/);
  assert.match(body, /\n\n\*\*问题\*\*:sub\(\) 的返回值比正确结果小 1。/);
  assert.match(body, /\n\n\*\*影响\*\*:所有调用方拿到的差值都错。/);
  assert.match(body, /\n\n\*\*建议\*\*:去掉多余的 - 1。/);
  // 另一个模型的表述同样留着,自成一段(ADR 0015)。
  assert.match(body, /\n\n\*\*model-b\*\*\n\n\*\*问题\*\*:减法结果不对。/);
});

test("影响与建议为空时整段消失,不留空标签", async () => {
  const { cache, db, forge, reviewer } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  const body = forge.createdReviews[0]!.comments[0]!.body;
  assert.match(body, /\*\*问题\*\*:/);
  assert.doesNotMatch(body, /\*\*影响\*\*|\*\*建议\*\*/);
});

/** 行号相差 4 行,超出去重的行距容差,三条各自成一条。第 11 行落在 diff 之外。 */
function at(line: number, severity: "P0" | "P1" | "P2", description: string) {
  return { file: "src/calc.ts", line, severity, category: "bug" as const, description };
}

test("正文首行写明本轮 Finding 总数与分级计数", async () => {
  const { cache, db, forge } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", [
          at(3, "P0", "add 没有参数校验"),
          at(7, "P1", "sub 的返回值没有断言"),
          at(11, "P2", "mul 缺少注释"),
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const [heading] = forge.createdReviews[0]!.body.split("\n");
  // 第 11 行退化进正文,同样计入:口径是本轮结论总数,不分呈现方式。
  assert.equal(heading, "MultiReviewer:3 条 Finding(P0 1 / P1 1 / P2 1)");
});

test("某个等级本轮为零时,首行不列它", async () => {
  const { cache, db, forge } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", [
          at(3, "P2", "add 缺少注释"),
          at(7, "P2", "sub 缺少注释"),
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const [heading] = forge.createdReviews[0]!.body.split("\n");
  assert.equal(heading, "MultiReviewer:2 条 Finding(P2 2)");
});

test("零 Finding 但有模型缺席时,首行不写「0 条」", async () => {
  const { cache, db, forge } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", []),
        scriptedReviewer("model-b", [], { failure: "402 dead credential" }),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const body = forge.createdReviews[0]!.body;
  assert.equal(body.split("\n")[0], "MultiReviewer");
  // 「0 条」会把「没审到」读成「没问题」。缺席那一段仍要照常写明。
  assert.doesNotMatch(body, /0 条 Finding/);
  assert.match(body, /model-b/);
  // 厂商错误原文不外发到 PR:它常带 endpoint、request id、配额提示,只留在库里。
  assert.doesNotMatch(body, /402 dead credential/);
});

test("Reviewer 拿到的 Review Range 以 merge-base 为基准,不是 base 分支尖端", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
    baseAdvance: { "docs/note.md": "base 分支在 PR 拉出之后又前进了\n" },
  });
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
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });
  const reviewer = scriptedReviewer("stub-model", []);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.notEqual(repo.baseSha, repo.mergeBaseSha);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(reviewer.calls[0]!.range.baseSha, repo.mergeBaseSha);
  assert.equal(reviewer.calls[0]!.range.headSha, repo.headSha);
  // base 分支上的 docs/note.md 不属于本次 Review Range。
  assert.deepEqual(reviewer.calls[0]!.range.files, ["src/calc.ts"]);
});

test("同一仓库的第二次 Review Run 复用缓存并增量 fetch 到新的 head commit", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
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
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });
  const reviewer = scriptedReviewer("stub-model", []);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  await runReview(event, deps);
  const worktree = reviewer.calls[0]!.worktreePath;

  // 放进 .git 的标记不受 `git clean` 影响,重新 clone 才会让它消失。
  const marker = join(worktree, ".git", "multireviewer-cache-marker");
  writeFileSync(marker, "first run");

  const NEXT_CALC = HEAD_CALC.replace("return a * b;", "return a * b * 2;");
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.ts": NEXT_CALC });

  await runReview(event, deps);

  assert.equal(reviewer.calls[1]!.worktreePath, worktree);
  assert.ok(existsSync(marker), "第二次 Review Run 重新 clone 了仓库,而非增量 fetch");
  assert.equal(readFileSync(join(worktree, "src/calc.ts"), "utf8"), NEXT_CALC);
});

test("工作副本 checkout 到 head commit,Reviewer 读到的是改动后的代码", async () => {
  const { cache, db, forge, reviewer } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  const worktree = reviewer.calls[0]!.worktreePath;
  assert.equal(readFileSync(join(worktree, "src/calc.ts"), "utf8"), HEAD_CALC);
});

test("Review Run 在首批前固定一份运行计划,后续批次不跟随模型组合改动", async () => {
  const repo = makeRepo({
    base: {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    },
    head: {
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 2;\n",
    },
  });
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
    changedFiles: [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "modified" },
    ],
  });

  let enteredFirstBatch = (): void => {};
  const firstBatchEntered = new Promise<void>((resolve) => {
    enteredFirstBatch = resolve;
  });
  let releaseFirstBatch = (): void => {};
  const firstBatchGate = new Promise<void>((resolve) => {
    releaseFirstBatch = resolve;
  });
  const calls: string[][] = [];
  const planned: Reviewer = {
    model: "planned-model",
    review: async (range) => {
      calls.push([...range.files]);
      if (calls.length === 1) {
        enteredFirstBatch();
        await firstBatchGate;
      }
      return {
        model: "planned-model",
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
      };
    },
  };
  const replacement = scriptedReviewer("replacement-model", []);
  const configuredReviewers: Reviewer[] = [planned];
  const plan = createReviewRunPlan(configuredReviewers, 1, []);

  const running = runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, ...plan, cacheDir: cache.dir, dbPath: db.path },
  );
  await firstBatchEntered;

  // 模拟首批运行期间模型组合切换。进行中的 Run 必须继续用计划里的 Reviewer;
  // 新组合只属于下一轮,不能从第二批开始混进这一轮。
  configuredReviewers.splice(0, 1, replacement);
  releaseFirstBatch();
  const result = await running;

  assert.deepEqual(calls, [["src/a.ts"], ["src/b.ts"]]);
  assert.equal(replacement.calls.length, 0);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.model), ["planned-model"]);
});
