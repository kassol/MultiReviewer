import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import {
  createReviewRunPlan,
  INTENT_BODY_CHARS,
  INTENT_COMMIT_LIMIT,
  rulesForBatch,
  runReview,
} from "../src/review/run.ts";
import {
  containerPullRequestBody,
  containerPullRequestTitle,
} from "../src/review/range-review.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import {
  memoryForge,
  readingReviewer,
  scriptedReviewer,
  verdictReviewer,
} from "./support/memory-forge.ts";
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

test("Reviewer 请求带上本轮 diff 的可评论行区间", async () => {
  const { cache, db, forge, reviewer } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  // -U3 的 hunk 覆盖新文件的 3..9 行,锚定校验在 Reviewer 那侧就靠这一份。
  assert.deepEqual(reviewer.calls[0]!.commentable, { "src/calc.ts": [{ start: 3, end: 9 }] });
});

test("锚不进 diff hunk 的 Finding 被丢弃,不进 review 正文也不落库", async () => {
  const { cache, db, forge, reviewer } = setup(11);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  // 一条 Finding 都没剩下,也没有缺席的模型,这一轮无话可说,只留一个赞。
  assert.deepEqual(forge.createdReviews, []);
  assert.equal(forge.reactions.has("+1"), true);
  assert.deepEqual(
    new DatabaseSync(db.path, { readOnly: true }).prepare("SELECT id FROM finding").all(),
    [],
  );
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
          at(9, "P2", "mul 缺少注释"),
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const [heading] = forge.createdReviews[0]!.body.split("\n");
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
  const reviewer = readingReviewer(scriptedReviewer("stub-model", []), "src/calc.ts");
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = {
    forge: forge.forge,
    reviewers: [reviewer],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  await runReview(event, deps);

  // 放进缓存 clone 的 .git 的标记,重新 clone 才会让它消失。
  const marker = join(cache.dir, event.owner, event.repo, ".git", "multireviewer-cache-marker");
  writeFileSync(marker, "first run");

  const NEXT_CALC = HEAD_CALC.replace("return a * b;", "return a * b * 2;");
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.ts": NEXT_CALC });

  await runReview(event, deps);

  assert.ok(existsSync(marker), "第二次 Review Run 重新 clone 了仓库,而非增量 fetch");
  assert.deepEqual(reviewer.seen, [HEAD_CALC, NEXT_CALC]);
});

test("工作副本 checkout 到 head commit,Reviewer 读到的是改动后的代码", async () => {
  const { cache, db, forge, reviewer: scripted } = setup(6);
  const reviewer = readingReviewer(scripted, "src/calc.ts");

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.deepEqual(reviewer.seen, [HEAD_CALC]);
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
    review: async ({ range }) => {
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

/** 行作者(CONTEXT.md)判定用的两个作者。 */
const ALICE = { name: "Alice Lin", email: "alice@example.invalid" };
const BOB = { name: "Bob Ma", email: "bob@example.invalid" };

type LineAuthorRow = {
  line: number;
  sha: unknown;
  name: unknown;
  email: unknown;
  at: unknown;
};

/** 落库的行作者四列,按落库顺序。 */
function lineAuthors(dbPath: string): LineAuthorRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT line, line_author_sha AS sha, line_author_name AS name,
                line_author_email AS email, line_author_at AS at
           FROM finding ORDER BY id`,
      )
      .all() as unknown as LineAuthorRow[];
  } finally {
    db.close();
  }
}

/** 落库的「延续自」链接,按落库顺序。 */
function continuedFrom(dbPath: string): unknown[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db.prepare("SELECT continued_from FROM finding ORDER BY id").all() as unknown as Record<
        string,
        unknown
      >[]
    ).map((row) => row["continued_from"]);
  } finally {
    db.close();
  }
}

test("落库的 Finding 记下本轮 head 上各自那一行的行作者", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  // 两个作者各改一行:第 2 行归 Alice,第 6 行归 Bob。
  const aliceCalc = HEAD_CALC.replace("return a + b;", "return a + b + 0;");
  const aliceSha = repo.commitToBranch(
    "feature",
    { "src/calc.ts": aliceCalc },
    { authorName: ALICE.name, authorEmail: ALICE.email },
  );
  const bobCalc = aliceCalc.replace("return a - b - 1;", "return a - b - 2;");
  const bobSha = repo.commitToBranch(
    "feature",
    { "src/calc.ts": bobCalc },
    { authorName: BOB.name, authorEmail: BOB.email },
  );

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: bobSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("stub-model", [
          at(2, "P1", "add 多加了 0"),
          at(6, "P0", "sub 多减了 2"),
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const rows = [...lineAuthors(db.path)].sort((a, b) => a.line - b.line);
  assert.deepEqual(
    rows.map((row) => ({ line: row.line, sha: row.sha, name: row.name, email: row.email })),
    [
      { line: 2, sha: aliceSha, name: ALICE.name, email: ALICE.email },
      { line: 6, sha: bobSha, name: BOB.name, email: BOB.email },
    ],
  );
  for (const row of rows) assert.match(String(row.at), /^\d{4}-\d{2}-\d{2}T/);
});

test("延续到新一轮的 Finding 按新 head 重算行作者,不沿用上一轮", async () => {
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
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [at(6, "P0", "sub 多减了 1")])],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  await runReview(event, deps);

  // 上一轮发出去的评论当成 Forge 上的既有评论喂回去:延续要在它上面发生。
  forge.existingComments.push(
    ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );
  // Bob 改写了 Finding 所指的那一行:旧指纹在新 head 上算不出,复核判仍在即触发延续。
  const bobSha = repo.commitToBranch(
    "feature",
    { "src/calc.ts": HEAD_CALC.replace("return a - b - 1;", "return a - b - 2;") },
    { authorName: BOB.name, authorEmail: BOB.email },
  );
  forge.pullRequest.headSha = bobSha;

  await runReview(event, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "present", [at(6, "P0", "sub 仍然多减了")])],
  });

  // 承接的那一行确实是延续过来的:它记下了旧评论的地址。
  const [first, second] = continuedFrom(db.path);
  assert.equal(first, null);
  assert.notEqual(second, null);

  const rows = lineAuthors(db.path);
  assert.equal(rows.length, 2, "两轮各落一行");
  assert.equal(rows[0]!.name, "fixture", "第一轮那一行的行作者是当时改这一行的人");
  assert.deepEqual(
    { sha: rows[1]!.sha, name: rows[1]!.name, email: rows[1]!.email },
    { sha: bobSha, name: BOB.name, email: BOB.email },
    "延续过来的那一行没有按新 head 重算行作者",
  );
});

test("PR 触发的轮次把 pull request 标题、正文与 commit 列表交给 Reviewer", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const headSha = repo.commitToBranch(
    "feature",
    { "src/calc.ts": HEAD_CALC.replace("return a * b;", "return a * b + 0;") },
    { message: "fix: 收紧 sub 的差值\n\n关联需求 #42" },
  );

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "修正 sub 的差值",
      body: "本 PR 把 sub 少减的那 1 补回来。\n\n取舍:mul 的溢出这一轮先不动。",
      draft: false,
      baseSha: repo.baseSha,
      headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });
  const reviewer = scriptedReviewer("stub-model", []);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  const intent = reviewer.calls[0]!.intent;
  assert.notEqual(intent, undefined);
  assert.equal(intent!.title, "修正 sub 的差值");
  assert.match(intent!.body ?? "", /取舍:mul 的溢出这一轮先不动。/);
  // 新的在前,commit message 取全文——目的与关联需求常写在正文里。
  assert.equal(intent!.commits.length, 2);
  assert.match(intent!.commits[0]!, /fix: 收紧 sub 的差值/);
  assert.match(intent!.commits[0]!, /关联需求 #42/);
  assert.equal(intent!.omittedCommits, 0);
});

test("范围审查的轮次带范围审查标题与同区间 commit 列表,不带容器 PR 的正文", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const store = openStore(db.path);
  const rangeReviewId = store.createRangeReview({
    repoId: 1,
    owner: "acme",
    repo: "widgets",
    title: "上线前复核 v2.3",
    baseSha: repo.mergeBaseSha,
    comparisonSha: repo.headSha,
    createdBy: "kassol",
    createdAt: new Date().toISOString(),
  });
  store.close();

  const forge = memoryForge({
    pullRequest: {
      number: 101,
      title: containerPullRequestTitle(repo.mergeBaseSha, repo.headSha),
      body: containerPullRequestBody("https://panel.invalid/"),
      draft: false,
      baseSha: repo.mergeBaseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });
  const reviewer = scriptedReviewer("stub-model", []);

  await runReview(
    { owner: "acme", repo: "widgets", number: 101 },
    {
      forge: forge.forge,
      reviewers: [reviewer],
      cacheDir: cache.dir,
      dbPath: db.path,
      rangeReviewId,
    },
  );

  const intent = reviewer.calls[0]!.intent;
  assert.equal(intent!.title, "上线前复核 v2.3");
  // 容器 PR 的正文由本工具自己拼出,不是意图来源。
  assert.equal(intent!.body, undefined);
  assert.equal(intent!.commits.length, 1);
});

test("意图上下文过长时正文保头部、commit 列表按条数截断", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  // 连同夹具自带的那条 head commit,区间里共 INTENT_COMMIT_LIMIT + 2 条。
  let headSha = repo.headSha;
  for (let index = 1; index <= INTENT_COMMIT_LIMIT + 1; index += 1) {
    headSha = repo.commitToBranch(
      "feature",
      { "src/calc.ts": `${HEAD_CALC}// ${index}\n` },
      { message: `chore: 第 ${index} 次迭代` },
    );
  }

  const body = "详".repeat(INTENT_BODY_CHARS + 100);
  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "长正文的 PR",
      body,
      draft: false,
      baseSha: repo.baseSha,
      headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });
  const reviewer = scriptedReviewer("stub-model", []);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  const intent = reviewer.calls[0]!.intent!;
  assert.equal(intent.body, `${"详".repeat(INTENT_BODY_CHARS)}…`);
  assert.equal(intent.commits.length, INTENT_COMMIT_LIMIT);
  assert.equal(intent.omittedCommits, 2);
  // 留下的是最新的那些:被砍掉的是区间里最早的两条。
  assert.match(intent.commits[0]!, new RegExp(`第 ${INTENT_COMMIT_LIMIT + 1} 次迭代`));
});

test("作用范围的 glob 语义:* 不跨目录,** 跨任意层且可为零层", () => {
  const cases: [string, string, boolean][] = [
    // 空作用范围即全仓库,任何文件都命中。
    ["", "src/a.ts", true],
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/deep/more/a.ts", true],
    ["src/**", "src/deep/a.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "test/a.test.ts", true],
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    // 正则元字符按字面量处理,不当模式解释。
    ["src/a+b.ts", "src/a+b.ts", true],
    ["src/a.ts", "srcXa.ts", false],
  ];

  for (const [scope, file, expected] of cases) {
    assert.equal(
      rulesForBatch([{ id: 1, scope, statement: "s" }], [file]).length === 1,
      expected,
      `作用范围 ${scope} 对 ${file} 的判定不对`,
    );
  }
});

test("Review Run 记下开跑时冻结的知识集版本,Finding 记下模型自报的命中规则", async () => {
  const { cache, db, forge } = setup(6);
  const reviewer = scriptedReviewer("stub-model", [
    {
      file: "src/calc.ts",
      line: 6,
      severity: "P0",
      category: "bug",
      description: "sub() 多减了 1",
      ruleId: 9,
    },
  ]);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [reviewer],
      cacheDir: cache.dir,
      dbPath: db.path,
      ruleSetVersion: 4,
      rules: [{ id: 9, scope: "", statement: "减法不许多减" }],
    },
  );

  assert.deepEqual(reviewer.calls[0]!.rules, [
    { id: 9, scope: "", statement: "减法不许多减" },
  ]);

  const db2 = new DatabaseSync(db.path, { readOnly: true });
  try {
    assert.equal(
      db2.prepare("SELECT rule_set_version FROM review_run").get()!["rule_set_version"],
      4,
    );
    assert.equal(db2.prepare("SELECT rule_id FROM finding ORDER BY id").get()!["rule_id"], 9);
  } finally {
    db2.close();
  }
});

test("空知识集时不注入规则,Review Run 不记知识集版本", async () => {
  const { cache, db, forge, reviewer } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.deepEqual(reviewer.calls[0]!.rules, []);

  const db2 = new DatabaseSync(db.path, { readOnly: true });
  try {
    assert.equal(
      db2.prepare("SELECT rule_set_version FROM review_run").get()!["rule_set_version"],
      null,
    );
    assert.equal(db2.prepare("SELECT rule_id FROM finding ORDER BY id").get()!["rule_id"], null);
  } finally {
    db2.close();
  }
});

test("本轮指令随这一轮注入 Reviewer 并落库,不给指令时两处都是空", async () => {
  const { cache, db, forge, reviewer } = setup(6);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [reviewer],
      cacheDir: cache.dir,
      dbPath: db.path,
      directive: "这一轮只报 P0",
    },
  );

  assert.equal(reviewer.calls[0]!.directive, "这一轮只报 P0");

  const withDirective = new DatabaseSync(db.path, { readOnly: true });
  try {
    assert.equal(
      withDirective.prepare("SELECT directive FROM review_run").get()!["directive"],
      "这一轮只报 P0",
    );
  } finally {
    withDirective.close();
  }

  // 下一轮不带:本轮指令只作用于发起它的那一轮(CONTEXT.md 本轮指令)。
  const next = scriptedReviewer("stub-model", []);
  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [next], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.equal(next.calls[0]!.directive, undefined);

  const plain = new DatabaseSync(db.path, { readOnly: true });
  try {
    assert.deepEqual(
      plain
        .prepare("SELECT directive FROM review_run ORDER BY id")
        .all()
        .map((row) => row["directive"]),
      ["这一轮只报 P0", null],
    );
  } finally {
    plain.close();
  }
});
