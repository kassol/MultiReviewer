import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  createReviewRunPlan,
  findingLineAuthors,
  INTENT_BODY_CHARS,
  INTENT_COMMIT_LIMIT,
  knowledgeForBatch,
  runReview,
  VERDICT_ONLY_NO_HISTORY,
} from "../src/review/run.ts";
import {
  containerPullRequestBody,
  containerPullRequestTitle,
} from "../src/review/range-review.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo, testCleanups } from "./support/git-fixture.ts";
import { setup as setupRepo } from "./support/batch-run.ts";
import {
  memoryForge,
  readingReviewer,
  scriptedReviewer,
  verdictReviewer,
} from "./support/memory-forge.ts";
import type { ChangedFile } from "../src/forge/forge.ts";
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

const cleanups = testCleanups();

function setup(findingLine: number) {
  const { repo, cache, db, forge } = setupRepo(cleanups, {
    tree: { base: { "src/calc.ts": BASE_CALC }, head: { "src/calc.ts": HEAD_CALC } },
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

test("合并 agent 跑不成时,词法配对的延续照常发生", async () => {
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
  forge.existingComments.push(
    ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );
  // 那一行被改写:旧指纹在新 head 上算不出,复核判仍在即触发延续。
  forge.pullRequest.headSha = repo.commitToBranch("feature", {
    "src/calc.ts": HEAD_CALC.replace("return a - b - 1;", "return a - b - 2;"),
  });

  await runReview(event, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "present", [at(6, "P0", "sub 仍然多减了")])],
    // 合并 agent 报失败:分组退回算法档,延续退回词法配对(ADR 0022 的回退承诺)。
    mergeAgent: async () => ({ groups: [], failure: "模型调用超时" }),
  });

  const [first, second] = continuedFrom(db.path);
  assert.equal(first, null);
  assert.notEqual(second, null, "回退档的词法延续没有发生");
  assert.deepEqual(forge.resolvedIds, ["comment-1"]);
});


test("评论按 等级/标题 加一份代表段的 问题/影响/建议,末尾一行归属(issue #278)", async () => {
  const { cache, db, forge } = setup(6);
  // 两个模型报同一处:正文只有描述最长那份,另一个模型的原文不进评论。
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
  const other = {
    ...finding,
    title: "减法有问题",
    description: "减法结果不对。",
    impact: "余额会算错。",
    suggestion: "改成 a - b。",
  };

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
  assert.match(body, /\n\n\*\*问题\*\*:sub\(\) 的返回值比正确结果小 1。/);
  assert.match(body, /\n\n\*\*影响\*\*:所有调用方拿到的差值都错。/);
  assert.match(body, /\n\n\*\*建议\*\*:去掉多余的 - 1。/);
  // 模型名退到末尾那一行,各模型原文一段都不进评论。
  assert.doesNotMatch(body, /\*\*model-[ab]\*\*|减法结果不对。|余额会算错。|改成 a - b。/);
  assert.match(body, /\n\n由 2 个模型报出:model-a、model-b\n/);
});

test("代表段取描述最长的那条归属,归属仍逐条落库(issue #278)", async () => {
  const { cache, db, forge } = setup(6);
  const at6 = {
    file: "src/calc.ts",
    line: 6,
    category: "bug" as const,
    title: "sub 多减了 1",
  };
  // 严重度更高的那条说得短:代表段仍取说得最全的 model-b,严重度与分类各按各的口径。
  const short = {
    ...at6,
    severity: "P0" as const,
    description: "减法结果不对。",
    impact: "余额会算错。",
    suggestion: "改成 a - b。",
  };
  const long = {
    ...at6,
    severity: "P1" as const,
    title: "sub 的返回值小 1",
    description: "sub() 少减一次,返回值比正确结果小 1。",
    impact: "所有调用方拿到的差值都错。",
    suggestion: "去掉多余的 - 1。",
  };

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [scriptedReviewer("model-a", [short]), scriptedReviewer("model-b", [long])],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const store = openStore(db.path);
  const [run] = store.listRuns({ limit: 1 });
  store.close();
  const recorded = run!.findings[0]!;
  assert.equal(recorded.description, "sub() 少减一次,返回值比正确结果小 1。");
  assert.equal(recorded.impact, "所有调用方拿到的差值都错。");
  assert.equal(recorded.suggestion, "去掉多余的 - 1。");
  // 严重度仍取最高、分类仍取首报,不随代表段的选择变。
  assert.equal(recorded.severity, "P0");
  assert.equal(recorded.category, "bug");
  assert.deepEqual(recorded.models, ["model-a", "model-b"]);
  assert.equal(recorded.attributions.length, 2, "归属仍逐条留着");
});

test("同一个模型的多份归属只落一份代表段,归属一行仍只算一个模型(issue #278)", async () => {
  const { cache, db, forge } = setup(6);
  const at6 = { file: "src/calc.ts", line: 6, category: "bug" as const, severity: "P1" as const };
  // 同一个模型跨批次重复报出同一处的形状:同行硬证据并成一组,归属三条。
  const said = (description: string, suggestion: string) => ({
    ...at6,
    title: "sub 多减了 1",
    description,
    impact: "调用方拿到的差值都错。",
    suggestion,
  });

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", [
          said("减法结果不对。", "改成 a - b。"),
          said("sub() 少减一次,返回值比正确结果小 1。", "去掉多余的 - 1。"),
          said("返回值偏小。", "核对减法。"),
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const store = openStore(db.path);
  const [run] = store.listRuns({ limit: 1 });
  store.close();
  const recorded = run!.findings[0]!;
  assert.equal(recorded.attributions.length, 3, "三条归属都该留着");
  assert.equal(recorded.description, "sub() 少减一次,返回值比正确结果小 1。");
  assert.equal(recorded.suggestion, "去掉多余的 - 1。");

  const body = forge.createdReviews[0]!.comments[0]!.body;
  assert.match(body, /\n\n\*\*问题\*\*:sub\(\) 少减一次,返回值比正确结果小 1。/);
  assert.doesNotMatch(body, /减法结果不对。|返回值偏小。/, "其余归属的原文不进评论");
  assert.match(body, /\n\n由 1 个模型报出:model-a\n/);
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

test("新 Finding 的影响与建议按各模型归属落库,面板投影读得回(issue #266)", async () => {
  const { cache, db, forge } = setup(6);
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
  // 另一个模型报同一处:影响留空、建议不同,两段各归各的,不被代表段盖掉。
  const other = { ...finding, description: "减法结果不对。", impact: "", suggestion: "改成 a - b。" };

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [scriptedReviewer("model-a", [finding]), scriptedReviewer("model-b", [other])],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const store = openStore(db.path);
  const [run] = store.listRuns({ limit: 1 });
  store.close();
  assert.deepEqual(run!.findings[0]!.attributions, [
    {
      model: "model-a",
      severity: "P0",
      category: "bug",
      description: "sub() 的返回值比正确结果小 1。",
      impact: "所有调用方拿到的差值都错。",
      suggestion: "去掉多余的 - 1。",
    },
    {
      model: "model-b",
      severity: "P0",
      category: "bug",
      description: "减法结果不对。",
      impact: "",
      suggestion: "改成 a - b。",
    },
  ]);
});

test("同一模型在同一合并组里的多条归属,影响与建议各对各的(issue #266)", async () => {
  const { cache, db, forge } = setup(6);
  const at6 = { file: "src/calc.ts", line: 6, category: "bug" as const };

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("model-a", [
          {
            ...at6,
            severity: "P0",
            title: "sub 多减了 1",
            description: "sub() 的返回值比正确结果小 1。",
            impact: "所有调用方拿到的差值都错。",
            suggestion: "去掉多余的 - 1。",
          },
          // 同一行的另一个问题:同行硬证据把它并进同一组,归属仍各留各的两段。
          {
            ...at6,
            severity: "P1",
            title: "缺少参数校验",
            description: "非数字入参不被拦截。",
            impact: "",
            suggestion: "入口加 typeof 校验。",
          },
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const store = openStore(db.path);
  const [run] = store.listRuns({ limit: 1 });
  store.close();
  assert.equal(run!.findings.length, 1);
  assert.deepEqual(
    run!.findings[0]!.attributions.map((said) => [said.description, said.impact, said.suggestion]),
    [
      ["sub() 的返回值比正确结果小 1。", "所有调用方拿到的差值都错。", "去掉多余的 - 1。"],
      ["非数字入参不被拦截。", "", "入口加 typeof 校验。"],
    ],
  );
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
  const plan = createReviewRunPlan(
    1,
    configuredReviewers,
    { maxChangedLinesPerBatch: 1, maxFilesPerBatch: 40, maxParallelBatches: 3, maxEvidenceCallsPerBatch: 3 },
    [],
  );

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
  adjacent: unknown;
};

/** 落库的行作者四列,按落库顺序。 */
function lineAuthors(dbPath: string): LineAuthorRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT line, line_author_sha AS sha, line_author_name AS name,
                line_author_email AS email, line_author_at AS at,
                line_author_adjacent AS adjacent
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

/** 相邻改动(issue #241)判定用的两个作者。 */
const CAROL = { name: "Carol Ye", email: "carol@example.invalid" };
const DAN = { name: "Dan Qi", email: "dan@example.invalid" };

/**
 * 夹心 head:丙在 `add()` 的 return 上下各插一行,中间那一行一个字没动。base..head 的
 * hunk 因此在新侧第 2、4 行各有一处新增,夹着未改动的第 3 行。
 *
 * `rewriteLower` 时丁再改写下面那一处,上下两处新增归两个人——等距时取哪一边看得出来。
 */
function sandwichSetup(rewriteLower: boolean) {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const carolCalc = HEAD_CALC.replace(
    "  return a + b;\n",
    "  // 入参已由上游校验\n  return a + b;\n  // 结果原样返回\n",
  );
  const carolSha = repo.commitToBranch(
    "feature",
    { "src/calc.ts": carolCalc },
    { authorName: CAROL.name, authorEmail: CAROL.email },
  );
  const danSha = rewriteLower
    ? repo.commitToBranch(
        "feature",
        { "src/calc.ts": carolCalc.replace("// 结果原样返回", "// 结果直接返回") },
        { authorName: DAN.name, authorEmail: DAN.email },
      )
    : undefined;

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: danSha ?? carolSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });

  return { repo, cache, db, forge, carolSha, danSha };
}

test("落在本轮新增行上的 Finding 行作者是那一行自己的作者,不带相邻改动标记", async () => {
  const { cache, db, forge, carolSha } = sandwichSetup(false);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [scriptedReviewer("stub-model", [at(2, "P1", "这句注释没说清楚")])],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const rows = lineAuthors(db.path);
  assert.deepEqual(
    rows.map((row) => ({ line: row.line, sha: row.sha, name: row.name, adjacent: row.adjacent })),
    [{ line: 2, sha: carolSha, name: CAROL.name, adjacent: 0 }],
  );
});

test("落在两处新增之间那一行的 Finding 取相邻新增行的作者,带相邻改动标记", async () => {
  const { cache, db, forge, carolSha } = sandwichSetup(false);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [scriptedReviewer("stub-model", [at(3, "P0", "add 的返回值没有校验")])],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const rows = lineAuthors(db.path);
  assert.deepEqual(
    rows.map((row) => ({
      line: row.line,
      sha: row.sha,
      name: row.name,
      email: row.email,
      adjacent: row.adjacent,
    })),
    [{ line: 3, sha: carolSha, name: CAROL.name, email: CAROL.email, adjacent: 1 }],
  );

  // 阶段汇总的行作者投影把标记一起带出去:卡片据此在行作者之后写「相邻改动」。
  const store = openStore(db.path);
  const summary = store.stageSummary({ owner: "acme", repo: "widgets", pullNumber: 7 });
  store.close();
  assert.deepEqual(summary.findings[0]!.lineAuthor, {
    sha: carolSha,
    name: CAROL.name,
    email: CAROL.email,
    authoredAt: summary.findings[0]!.lineAuthor!.authoredAt,
    adjacent: true,
  });
});

test("落点上下等距各有一处新增时,行作者取上方那一处", async () => {
  const { cache, db, forge, carolSha, danSha } = sandwichSetup(true);

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [scriptedReviewer("stub-model", [at(3, "P0", "add 的返回值没有校验")])],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const rows = lineAuthors(db.path);
  assert.notEqual(danSha, undefined, "下方那一处新增归丁");
  assert.deepEqual(
    rows.map((row) => ({ line: row.line, sha: row.sha, name: row.name, adjacent: row.adjacent })),
    [{ line: 3, sha: carolSha, name: CAROL.name, adjacent: 1 }],
  );
});

test("行作者判定失败的那一组留空,其余照常", async () => {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC },
    head: { "src/calc.ts": HEAD_CALC },
  });
  cleanups.push(repo.cleanup);

  // 两组:一组按真 head 判,一组的 revision 在仓库里不可达。分组按「revision 加文件」,
  // 失败只吞掉它自己那一组。
  const authors = await findingLineAuthors(repo.dir, [
    { revision: repo.headSha, file: "src/calc.ts", line: 6 },
    {
      revision: "0000000000000000000000000000000000000000",
      file: "src/calc.ts",
      line: 6,
    },
  ]);

  assert.equal(authors[0]!.name, "fixture");
  assert.equal(authors[0]!.adjacent, false);
  assert.equal(authors[1], undefined);
});

/** 删除点(issue #244)判定用的一份代码:行号一目了然,落点与改动的距离好算。 */
const BASE_STEPS = `${Array.from(
  { length: 24 },
  (_, index) => `export const step${index + 1} = ${index + 1};`,
).join("\n")}\n`;

/** 甲之后 fixture 改了第 1 行:它自成一个 hunk,不与下面删除那一处相邻。 */
const HEAD_STEPS = BASE_STEPS.replace("export const step1 = 1;", "export const step1 = 0;");

/**
 * 乙删掉甲写的第 12、13 两行。删掉之后新侧第 12 行是原来的 step14,删除点就落在它上面
 * ——被删的内容原本在这一行之前。
 */
const BOB_STEPS = HEAD_STEPS.replace(
  "export const step12 = 12;\nexport const step13 = 13;\n",
  "",
);

/** 乙删完之后可再追一个提交,用来在同一个 hunk 里摆一处新增。 */
function stepsSetup(after?: { content: string; author: { name: string; email: string } }) {
  const repo = makeRepo({
    base: { "src/steps.ts": BASE_STEPS },
    head: { "src/steps.ts": HEAD_STEPS },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const bobSha = repo.commitToBranch(
    "feature",
    { "src/steps.ts": BOB_STEPS },
    { authorName: BOB.name, authorEmail: BOB.email },
  );
  const headSha =
    after === undefined
      ? bobSha
      : repo.commitToBranch(
          "feature",
          { "src/steps.ts": after.content },
          { authorName: after.author.name, authorEmail: after.author.email },
        );

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/steps.ts", status: "modified" }],
  });

  return { repo, cache, db, forge, bobSha };
}

function step(line: number, description: string) {
  return { file: "src/steps.ts", line, severity: "P0" as const, category: "bug" as const, description };
}

test("落在删除点旁上下文行的 Finding,行作者是删掉那几行的提交,带相邻改动标记", async () => {
  const { cache, db, forge, bobSha } = stepsSetup();

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [scriptedReviewer("stub-model", [step(12, "这里少了被删掉的那一步")])],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const rows = lineAuthors(db.path);
  assert.deepEqual(
    rows.map((row) => ({
      line: row.line,
      sha: row.sha,
      name: row.name,
      email: row.email,
      adjacent: row.adjacent,
    })),
    [{ line: 12, sha: bobSha, name: BOB.name, email: BOB.email, adjacent: 1 }],
  );
});

test("删除点在上、新增行在下时按距离取删除提交,等距同样取上方", async () => {
  // 丙在 step16 之前插一行:新侧第 14 行是新增,删除点仍在第 12 行。
  const carolSteps = BOB_STEPS.replace(
    "export const step16 = 16;\n",
    "export const step15b = 15;\nexport const step16 = 16;\n",
  );
  const { cache, db, forge, bobSha } = stepsSetup({ content: carolSteps, author: CAROL });

  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    {
      forge: forge.forge,
      reviewers: [
        scriptedReviewer("stub-model", [
          // 删除点在上(距 0)、新增行在下(距 2)。
          step(12, "这里少了被删掉的那一步"),
          // 删除点在上(距 1)、新增行在下(距 1):等距取上方。
          step(13, "这一步的顺序不对"),
        ]),
      ],
      cacheDir: cache.dir,
      dbPath: db.path,
    },
  );

  const rows = [...lineAuthors(db.path)].sort((a, b) => a.line - b.line);
  assert.deepEqual(
    rows.map((row) => ({ line: row.line, sha: row.sha, name: row.name, adjacent: row.adjacent })),
    [
      { line: 12, sha: bobSha, name: BOB.name, adjacent: 1 },
      { line: 13, sha: bobSha, name: BOB.name, adjacent: 1 },
    ],
  );
});

test("删除那几行的提交找不到时这一条留空,其余照常", async () => {
  const repo = makeRepo({
    base: { "src/steps.ts": BASE_STEPS },
    head: { "src/steps.ts": HEAD_STEPS },
  });
  cleanups.push(repo.cleanup);

  const authors = await findingLineAuthors(
    repo.dir,
    [
      { revision: repo.headSha, file: "src/steps.ts", line: 12 },
      { revision: repo.headSha, file: "src/steps.ts", line: 20 },
    ],
    {
      baseSha: repo.mergeBaseSha,
      hunks: {
        "src/steps.ts": [
          {
            start: 9,
            end: 14,
            // 这几行在 base..head 里从来没被删过,删除提交因此找不到。
            changes: [{ line: 12, deleted: ["export const nothing = 0;"] }],
          },
          { start: 18, end: 22, changes: [{ line: 21 }] },
        ],
      },
    },
  );

  assert.equal(authors[0], undefined);
  assert.equal(authors[1]!.name, "fixture");
  assert.equal(authors[1]!.adjacent, true);
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
      knowledgeForBatch([{ id: 1, scope, statement: "s" }], [file]).length === 1,
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
  assert.deepEqual(reviewer.calls[0]!.facts, []);

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

/** 最新一轮的轮次级轨迹事件类型,按落库先后。 */
function runTraceKinds(dbPath: string): string[] {
  const store = openStore(dbPath);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    return store
      .listTrace(runId)
      .filter((event) => event.scope === "run")
      .map((event) => event.kind);
  } finally {
    store.close();
  }
}

test("只复核且零新报:不向 Forge 发 review,旧评论 resolve 照常,轨迹记下未发 review", async () => {
  const { cache, db, forge, reviewer } = setup(6);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };

  await runReview(event, { ...deps, reviewers: [reviewer] });
  forge.existingComments.push(
    ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );

  await runReview(event, {
    ...deps,
    reviewers: [verdictReviewer("stub-model", "fixed")],
    mode: "verdict-only",
  });

  // 第一轮那条 review 之后再没有新的:Forge 上不该多出一条内容为空的 review。
  assert.equal(forge.createdReviews.length, 1);
  // 判已修的那条照常自动处置,旧评论照常 resolve。
  assert.deepEqual(forge.resolvedIds, [forge.publishedComments[0]!.id]);
  assert.ok(
    runTraceKinds(db.path).includes("review_skipped"),
    "只复核那一轮没有在轨迹里说清自己为什么没发 review",
  );
  assert.ok(!runTraceKinds(db.path).includes("review_posted"));
});

test("只复核时复核结论自带位置的延续照常发生", async () => {
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
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };

  await runReview(event, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [at(6, "P0", "sub 多减了 1")])],
  });
  forge.existingComments.push(
    ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );
  // 那一行被改写:旧指纹在新 head 上算不出,复核判仍在并自带新位置即触发延续。
  forge.pullRequest.headSha = repo.commitToBranch("feature", {
    "src/calc.ts": HEAD_CALC.replace("return a - b - 1;", "return a - b - 2;"),
  });

  await runReview(event, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "present", [], 6)],
    mode: "verdict-only",
  });

  const [first, second] = continuedFrom(db.path);
  assert.equal(first, null);
  assert.notEqual(second, null, "只复核那一轮没有承接旧位置的那条 Finding");
});

/**
 * 延续用例共用的夹具(issue #267):第一轮由给定的 Reviewer 在第 6 行报出,发出去的评论
 * 喂回 Forge。`rewrite` 把 Finding 所指的那一行改写成新 head,并把上一轮新发的评论一并
 * 喂回——延续要在它们上面发生。
 */
async function continuedStage(reviewers: readonly Reviewer[]) {
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
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };
  await runReview(event, { ...deps, reviewers });
  let fedBack = 0;
  let step = 1;
  const rewrite = (): void => {
    forge.existingComments.push(
      ...forge.publishedComments.slice(fedBack).map((comment) => ({ ...comment, resolved: false })),
    );
    fedBack = forge.publishedComments.length;
    step += 1;
    forge.pullRequest.headSha = repo.commitToBranch("feature", {
      "src/calc.ts": HEAD_CALC.replace("return a - b - 1;", `return a - b - ${step};`),
    });
  };
  return { db, forge, event, deps, rewrite };
}

/** 库里的每一轮,按轮次先后。 */
function runsInOrder(dbPath: string) {
  const store = openStore(dbPath);
  try {
    return store.listRuns({ limit: 10 }).sort((a, b) => a.id - b.id);
  } finally {
    store.close();
  }
}

const SAID_A1 = {
  ...at(6, "P0", "sub 多减了 1"),
  title: "sub 多减了 1",
  impact: "所有调用方拿到的差值都错。",
  suggestion: "去掉多余的 - 1。",
};

test("合成延续完整沿用历史各归属的影响与建议并各记出处,不改本轮归属(issue #267)", async () => {
  // 第一轮三段归属合成一条:model-a 两段内容不同的说法,model-b 一段。
  const stage = await continuedStage([
    scriptedReviewer("model-a", [
      SAID_A1,
      {
        ...at(6, "P1", "非数字入参不被拦截。"),
        title: "缺少参数校验",
        impact: "",
        suggestion: "入口加 typeof 校验。",
      },
    ]),
    scriptedReviewer("model-b", [
      {
        ...at(6, "P0", "减法结果不对。"),
        title: "sub 算错",
        impact: "余额会算错。",
        suggestion: "改成 a - b。",
      },
    ]),
  ]);
  stage.rewrite();

  // 给出新位置的是第三个模型,它自己什么都没报:合成的那条只归属它,历史三段原样带过来。
  await runReview(stage.event, {
    ...stage.deps,
    reviewers: [verdictReviewer("model-c", "present", [], 6)],
  });

  const [first, second] = runsInOrder(stage.db.path);
  assert.equal(second!.findings.length, 1);
  const continued = second!.findings[0]!;
  // 本轮归属只有位置复核者,两段为空:它没有对着新代码给过修法。参与统计因此不变。
  // 它承接的是上一轮那条的代表段(issue #278):三段归属里描述最长的那一份。
  assert.deepEqual(continued.attributions, [
    {
      model: "model-c",
      severity: "P0",
      category: "bug",
      description: "非数字入参不被拦截。",
      impact: "",
      suggestion: "",
    },
  ]);
  assert.deepEqual(second!.models.map((entry) => entry.model), ["model-c"]);
  // 历史三段各自带着原模型、来源轮次与那一轮的 head。
  const from = { runId: first!.id, headSha: first!.headSha };
  assert.deepEqual(continued.carried, [
    {
      ...from,
      model: "model-a",
      description: "sub 多减了 1",
      impact: "所有调用方拿到的差值都错。",
      suggestion: "去掉多余的 - 1。",
    },
    {
      ...from,
      model: "model-a",
      description: "非数字入参不被拦截。",
      impact: "",
      suggestion: "入口加 typeof 校验。",
    },
    {
      ...from,
      model: "model-b",
      description: "减法结果不对。",
      impact: "余额会算错。",
      suggestion: "改成 a - b。",
    },
  ]);
  // 本轮自己报出的没有历史建议。
  assert.deepEqual(first!.findings[0]!.carried, []);

  const body = stage.forge.createdReviews[1]!.comments[0]!.body;
  const sha = first!.headSha.slice(0, 7);
  // 来源要能唯一定位到那一轮:同一 head 可以重跑出多轮,只写 head 认不出是哪一轮。
  const note = (model: string) =>
    `**沿用 ${model} 在 Review Run #${first!.id} / ${sha} 上的说法,尚未针对新代码重新验证**`;
  // 代表段是合成那条自己的一段问题(issue #278),承接段接在它后面,位置不变。
  assert.ok(
    body.includes(
      `**问题**:非数字入参不被拦截。\n\n${note("model-a")}\n\n**问题**:sub 多减了 1\n\n**影响**:所有调用方拿到的差值都错。\n\n**建议**:去掉多余的 - 1。`,
    ),
    body,
  );
  assert.ok(
    body.includes(`${note("model-a")}\n\n**问题**:非数字入参不被拦截。\n\n**建议**:入口加 typeof 校验。`),
    body,
  );
  assert.ok(
    body.includes(
      `${note("model-b")}\n\n**问题**:减法结果不对。\n\n**影响**:余额会算错。\n\n**建议**:改成 a - b。\n\n由 1 个模型报出:model-c`,
    ),
    body,
  );
});

test("连续两轮延续仍指向最初那一轮的出处,正文不层层嵌套(issue #267)", async () => {
  const stage = await continuedStage([scriptedReviewer("model-a", [SAID_A1])]);
  stage.rewrite();
  await runReview(stage.event, {
    ...stage.deps,
    reviewers: [verdictReviewer("model-b", "present", [], 6)],
  });
  stage.rewrite();
  await runReview(stage.event, {
    ...stage.deps,
    reviewers: [verdictReviewer("model-c", "present", [], 6)],
  });

  const [first, , third] = runsInOrder(stage.db.path);
  const continued = third!.findings[0]!;
  assert.deepEqual(continued.attributions.map((said) => said.model), ["model-c"]);
  // 出处是最初说出它的那一轮;上一轮那个只给了位置的模型没有内容,不占一段。
  assert.deepEqual(continued.carried, [
    {
      model: "model-a",
      runId: first!.id,
      headSha: first!.headSha,
      description: "sub 多减了 1",
      impact: "所有调用方拿到的差值都错。",
      suggestion: "去掉多余的 - 1。",
    },
  ]);
  const body = stage.forge.createdReviews[2]!.comments[0]!.body;
  assert.equal(body.match(/沿用/g)?.length, 1, body);
  assert.doesNotMatch(body, /model-b/);
});

test("本轮重报的那条用本轮自己的影响与建议,历史建议不覆盖它(issue #267)", async () => {
  const stage = await continuedStage([scriptedReviewer("model-a", [SAID_A1])]);
  stage.rewrite();
  await runReview(stage.event, {
    ...stage.deps,
    reviewers: [
      verdictReviewer("model-b", "present", [
        { ...at(6, "P0", "sub 仍然多减了"), impact: "新影响。", suggestion: "新建议。" },
      ]),
    ],
  });

  // 词法配对承接了旧 Identity,内容却是本轮 model-b 自己说的:不带历史建议,不标沿用。
  const [, continuedRow] = continuedFrom(stage.db.path);
  assert.notEqual(continuedRow, null);
  const [, second] = runsInOrder(stage.db.path);
  assert.deepEqual(second!.findings[0]!.attributions, [
    {
      model: "model-b",
      severity: "P0",
      category: "bug",
      description: "sub 仍然多减了",
      impact: "新影响。",
      suggestion: "新建议。",
    },
  ]);
  assert.deepEqual(second!.findings[0]!.carried, []);
  assert.doesNotMatch(stage.forge.createdReviews[1]!.comments[0]!.body, /沿用|去掉多余/);
});

test("历史没存影响与建议时延续如实缺失,不凭空生成(issue #267)", async () => {
  const stage = await continuedStage([
    scriptedReviewer("model-a", [{ ...SAID_A1, impact: "", suggestion: "" }]),
  ]);
  // 升级前落的归属:两列是 NULL。
  const legacy = new DatabaseSync(stage.db.path);
  legacy.exec("UPDATE finding_attribution SET impact = NULL, suggestion = NULL");
  legacy.close();
  stage.rewrite();
  await runReview(stage.event, {
    ...stage.deps,
    reviewers: [verdictReviewer("model-b", "present", [], 6)],
  });

  const [first, second] = runsInOrder(stage.db.path);
  // 历史那段照实带着 null 过来,不写成空串:恢复操作要认得出它还缺着。
  assert.deepEqual(second!.findings[0]!.carried, [
    {
      model: "model-a",
      runId: first!.id,
      headSha: first!.headSha,
      description: "sub 多减了 1",
      impact: null,
      suggestion: null,
    },
  ]);
  assert.doesNotMatch(
    stage.forge.createdReviews[1]!.comments[0]!.body,
    /沿用|\*\*影响\*\*|\*\*建议\*\*/,
  );
});

test("没有未处置历史时只复核不开跑,失败原因认得出来", async () => {
  const { cache, db, forge } = setup(6);

  await assert.rejects(
    runReview(
      { owner: "acme", repo: "widgets", number: 7 },
      {
        forge: forge.forge,
        reviewers: [verdictReviewer("stub-model", "fixed")],
        cacheDir: cache.dir,
        dbPath: db.path,
        mode: "verdict-only",
      },
    ),
    (error: Error) => error.message === VERDICT_ONLY_NO_HISTORY,
  );

  const empty = new DatabaseSync(db.path, { readOnly: true });
  try {
    assert.equal(empty.prepare("SELECT count(*) AS n FROM review_run").get()!["n"], 0);
  } finally {
    empty.close();
  }
  assert.deepEqual(forge.createdReviews, []);
});

const BASE_GONE = `export function gone(a: number) {
  return a;
}

export function stay(a: number) {
  return a * 2;
}
`;

// 只改第 2 行,与 calc.ts 同形:上一轮在这一行报出的 Finding 落成一条行级评论。
const HEAD_GONE = BASE_GONE.replace("return a;", "return a + 1;");

/**
 * 造一个「上一轮在 src/gone.ts 上报过一条」的阶段(issue #272)。第二轮把那个文件
 * 回退或删掉,它就落在本轮可审文件集之外。
 */
function absenceFixture(pullNumber: number) {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC, "src/gone.ts": BASE_GONE },
    head: { "src/calc.ts": HEAD_CALC, "src/gone.ts": HEAD_GONE },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  // 同一个数组交给内存 Forge,第二轮改写它即改写本轮的变更文件清单。
  const changedFiles: ChangedFile[] = [
    { path: "src/calc.ts", status: "modified" },
    { path: "src/gone.ts", status: "modified" },
  ];
  const forge = memoryForge({
    pullRequest: {
      number: pullNumber,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles,
  });

  const firstRound = scriptedReviewer("stub-model", [
    { file: "src/calc.ts", line: 6, severity: "P0", category: "bug", description: "sub() 多减了 1" },
    { file: "src/gone.ts", line: 2, severity: "P1", category: "bug", description: "gone() 原样返回" },
  ]);

  return { repo, cache, db, forge, changedFiles, firstRound };
}

/** 上一轮发出去的行级评论,按未处置预置回 Forge,第二轮的回填才读得到它们。 */
function carryComments(forge: ReturnType<typeof memoryForge>): void {
  forge.existingComments.push(
    ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );
}

/** 某个文件上最新那一行 Finding 的落库 id、处置值与处置备注。 */
function latestFinding(
  dbPath: string,
  file: string,
): { id: number; disposition: string; note: string | null } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT id, disposition, disposition_note FROM finding
          WHERE file = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(file)!;
    return {
      id: Number(row["id"]),
      disposition: String(row["disposition"]),
      note: row["disposition_note"] === null ? null : String(row["disposition_note"]),
    };
  } finally {
    db.close();
  }
}

/** 最近那一轮的轮次级轨迹,连 payload 一起。 */
function lastRunTrace(dbPath: string): { kind: string; payload: unknown }[] {
  const store = openStore(dbPath);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    return store
      .listTrace(runId)
      .filter((event) => event.scope === "run")
      .map((event) => ({ kind: event.kind, payload: event.payload }));
  } finally {
    store.close();
  }
}

/** 把全局最低报告等级(issue #271)写成这一档;不写即缺行,读回默认 P2。 */
function setMinReportSeverity(dbPath: string, severity: "P0" | "P1" | "P2" | null): void {
  const store = openStore(dbPath);
  try {
    assert.equal(store.putGlobalSettings({ minReportSeverity: severity }), true);
  } finally {
    store.close();
  }
}

test("所在文件已回退到 base 的未处置历史,完整审查开跑即自动处置(issue #272)", async () => {
  const { repo, cache, db, forge, changedFiles, firstRound } = absenceFixture(7);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };

  await runReview(event, { ...deps, reviewers: [firstRound] });
  carryComments(forge);
  const history = latestFinding(db.path, "src/gone.ts");
  const carried = forge.publishedComments.find((comment) => comment.path === "src/gone.ts")!;

  // 第二轮把 src/gone.ts 改回 base 的内容:它因此根本不在 base..head 的 diff 里。
  forge.pullRequest.headSha = repo.pushToHead({ "src/gone.ts": BASE_GONE });
  changedFiles.splice(1, 1);

  await runReview(event, { ...deps, reviewers: [scriptedReviewer("stub-model", [])] });

  assert.deepEqual(forge.resolvedIds, [carried.id]);
  assert.deepEqual(latestFinding(db.path, "src/gone.ts"), {
    id: history.id,
    disposition: "fixed",
    note: "文件已回退,自动处置",
  });
  const traced = lastRunTrace(db.path).find((event) => event.kind === "history_auto_disposed");
  assert.deepEqual(traced?.payload, { deleted: [], reverted: [history.id] });
  // 还在可审文件集里的那条不受影响。
  assert.equal(latestFinding(db.path, "src/calc.ts").disposition, "unresolved");
});

test("所在文件被这一轮删掉的未处置历史,备注写「文件已删除」(issue #272)", async () => {
  const { repo, cache, db, forge, changedFiles, firstRound } = absenceFixture(7);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };

  await runReview(event, { ...deps, reviewers: [firstRound] });
  carryComments(forge);
  const history = latestFinding(db.path, "src/gone.ts");

  forge.pullRequest.headSha = repo.pushToHead({ "src/gone.ts": null });
  changedFiles[1] = { path: "src/gone.ts", status: "removed" };

  await runReview(event, { ...deps, reviewers: [scriptedReviewer("stub-model", [])] });

  assert.deepEqual(latestFinding(db.path, "src/gone.ts"), {
    id: history.id,
    disposition: "fixed",
    note: "文件已删除,自动处置",
  });
  const traced = lastRunTrace(db.path).find((event) => event.kind === "history_auto_disposed");
  assert.deepEqual(traced?.payload, { deleted: [history.id], reverted: [] });
});

test("范围审查阶段的只复核轮次同律:回退文件上的历史开跑即自动处置(issue #272)", async () => {
  const { repo, cache, db, forge, changedFiles, firstRound } = absenceFixture(101);
  const event = { owner: "acme", repo: "widgets", number: 101 };

  const seed = openStore(db.path);
  const rangeReviewId = seed.createRangeReview({
    repoId: 1,
    owner: "acme",
    repo: "widgets",
    title: "上线前复核 v2.3",
    baseSha: repo.mergeBaseSha,
    comparisonSha: repo.headSha,
    createdBy: "kassol",
    createdAt: new Date().toISOString(),
  });
  seed.close();
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path, rangeReviewId };

  await runReview(event, { ...deps, reviewers: [firstRound] });
  carryComments(forge);
  const history = latestFinding(db.path, "src/gone.ts");

  forge.pullRequest.headSha = repo.pushToHead({ "src/gone.ts": BASE_GONE });
  changedFiles.splice(1, 1);

  const second = verdictReviewer("stub-model", "present");
  await runReview(event, { ...deps, reviewers: [second], mode: "verdict-only" });

  assert.deepEqual(latestFinding(db.path, "src/gone.ts"), {
    id: history.id,
    disposition: "fixed",
    note: "文件已回退,自动处置",
  });
  // 处置掉的那条不再注入:只复核那一轮只剩 src/calc.ts 上的历史要复核。
  assert.deepEqual(
    second.calls.flatMap((call) => call.history.map((entry) => entry.file)),
    ["src/calc.ts"],
  );
  const traced = lastRunTrace(db.path).find((event) => event.kind === "history_auto_disposed");
  assert.deepEqual(traced?.payload, { deleted: [], reverted: [history.id] });
});

test("回退处置写 Forge 失败时那一条保持未处置,这一轮照常跑完(issue #272)", async () => {
  const { repo, cache, db, forge, changedFiles, firstRound } = absenceFixture(7);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };

  await runReview(event, { ...deps, reviewers: [firstRound] });
  carryComments(forge);
  const history = latestFinding(db.path, "src/gone.ts");

  forge.pullRequest.headSha = repo.pushToHead({ "src/gone.ts": BASE_GONE });
  changedFiles.splice(1, 1);
  forge.forge.resolveComment = async () => {
    throw new Error("resolve 挂了");
  };

  await runReview(event, { ...deps, reviewers: [scriptedReviewer("stub-model", [])] });

  assert.deepEqual(latestFinding(db.path, "src/gone.ts"), {
    id: history.id,
    disposition: "unresolved",
    note: null,
  });
  const kinds = lastRunTrace(db.path).map((event) => event.kind);
  assert.ok(!kinds.includes("history_auto_disposed"));
  assert.ok(kinds.includes("run_finished"), "写 Forge 失败不该让这一轮跑不完");
});

/** 那一轮落库的最低报告等级。轮次列表不带它,直接读列。 */
function runMinReportSeverity(dbPath: string): string[] {
  const sqlite = new DatabaseSync(dbPath);
  try {
    return sqlite
      .prepare("SELECT min_report_severity FROM review_run ORDER BY id")
      .all()
      .map((row) => String(row["min_report_severity"]));
  } finally {
    sqlite.close();
  }
}

test("阈值 P1 时模型报的 P2 不发出也不落库,轨迹记下丢弃条数", async () => {
  const { cache, db, forge } = setup(6);
  setMinReportSeverity(db.path, "P1");

  // 四条各占一行:同一行的会被合并成一条评论,数不出挡掉了几条。
  const reviewer = scriptedReviewer("model-a", [
    at(6, "P0", "sub 多减了 1"),
    at(5, "P1", "边界值没覆盖"),
    at(7, "P2", "这里可以改成 const"),
    at(8, "P2", "命名再直白一点"),
  ]);
  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  // 发出去的只有够阈值的那两条。
  const review = forge.createdReviews[0]!;
  assert.equal(review.comments.length, 2);
  assert.equal(review.comments.some((comment) => /const/.test(comment.body)), false);

  const store = openStore(db.path);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    assert.deepEqual(
      store.listRuns({ limit: 1 })[0]!.findings.map((finding) => finding.severity).sort(),
      ["P0", "P1"],
    );
    const filtered = store.listTrace(runId).filter((event) => event.kind === "findings_filtered");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.scope, "run");
    assert.deepEqual(filtered[0]!.payload, { discarded: 2, minReportSeverity: "P1" });
  } finally {
    store.close();
  }

  // prompt 那侧也知道阈值:注入边界带上它。
  assert.equal(reviewer.calls[0]!.minReportSeverity, "P1");
});

test("阈值全报时一条都不丢,注入边界不带阈值,轨迹里没有过滤事件", async () => {
  const { cache, db, forge } = setup(6);

  const reviewer = scriptedReviewer("model-a", [at(6, "P2", "这里可以改成 const")]);
  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );

  assert.equal(forge.createdReviews[0]!.comments.length, 1);
  assert.equal(reviewer.calls[0]!.minReportSeverity, undefined);
  const store = openStore(db.path);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    assert.equal(
      store.listTrace(runId).some((event) => event.kind === "findings_filtered"),
      false,
    );
  } finally {
    store.close();
  }
  assert.deepEqual(runMinReportSeverity(db.path), ["P2"]);
});

test("阈值随轮次落库,开跑后改设置不影响本轮", async () => {
  const { cache, db, forge } = setup(6);
  setMinReportSeverity(db.path, "P1");

  const reviewer = scriptedReviewer("model-a", [at(6, "P2", "这里可以改成 const")]);
  // 这一轮已经开跑并读过阈值;改设置只影响下一轮。
  const running = runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
  );
  await running;
  setMinReportSeverity(db.path, "P2");

  assert.deepEqual(runMinReportSeverity(db.path), ["P1"]);
  assert.equal(reviewer.calls[0]!.minReportSeverity, "P1");
  // 那一条 P2 按开跑时的 P1 挡掉,改回全报救不了已经跑完的这一轮。
  assert.equal(forge.publishedComments.length, 0);

  const next = scriptedReviewer("model-b", [at(6, "P2", "这里可以改成 const")]);
  await runReview(
    { owner: "acme", repo: "widgets", number: 7 },
    { forge: forge.forge, reviewers: [next], cacheDir: cache.dir, dbPath: db.path },
  );
  assert.deepEqual(runMinReportSeverity(db.path), ["P1", "P2"]);
  assert.equal(next.calls[0]!.minReportSeverity, undefined);
});

/** 把这个仓库注册进注册表,好挂仓库级的覆盖(issue #273)。 */
function registerRepoRow(dbPath: string, repoId: number): void {
  const store = openStore(dbPath);
  try {
    assert.equal(
      store.registerRepo({
        repoId,
        owner: "acme",
        repo: "widgets",
        generation: 1,
        key: "k".repeat(64),
      }),
      true,
    );
  } finally {
    store.close();
  }
}

/** 给这个仓库写一档最低报告等级覆盖(issue #273);null 即清掉,跟随全局。 */
function setRepoMinReportSeverity(
  dbPath: string,
  repoId: number,
  severity: "P0" | "P1" | "P2" | null,
): void {
  const store = openStore(dbPath);
  try {
    // 写入口只有整块那一个(issue #302):读当前版本,别的两项原样带过去。
    const repo = store.getRepo(repoId)!;
    assert.equal(
      store.putRepoSettings(repoId, repo.settingsVersion, {
        reviewersJson: repo.reviewersJson,
        auxiliaryModelJson: repo.auxiliaryModelJson,
        minReportSeverity: severity,
      }).ok,
      true,
    );
  } finally {
    store.close();
  }
}

test("仓库覆盖优先于全局阈值,清掉覆盖就回到全局(issue #273)", async () => {
  const { cache, db, forge } = setup(6);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };
  registerRepoRow(db.path, 101);
  registerRepoRow(db.path, 102);
  // 全局仍是默认的全报;只有 101 这个仓库自定义到 P1。
  setRepoMinReportSeverity(db.path, 101, "P1");

  const covered = scriptedReviewer("model-a", [at(6, "P2", "这里可以改成 const")]);
  await runReview(event, { ...deps, repoId: 101, reviewers: [covered] });

  assert.equal(forge.publishedComments.length, 0, "覆盖到 P1 的仓库不该发出 P2");
  assert.equal(covered.calls[0]!.minReportSeverity, "P1");

  // 没有覆盖的另一个仓库照全局跑:P2 照发。
  const other = scriptedReviewer("model-b", [at(6, "P2", "这里可以改成 const")]);
  await runReview(event, { ...deps, repoId: 102, reviewers: [other] });

  assert.equal(forge.publishedComments.length, 1);
  assert.equal(other.calls[0]!.minReportSeverity, undefined);

  // 清掉覆盖,101 也回到全局的全报。
  setRepoMinReportSeverity(db.path, 101, null);
  const cleared = scriptedReviewer("model-c", [at(11, "P2", "命名再直白一点")]);
  await runReview(event, { ...deps, repoId: 101, reviewers: [cleared] });

  assert.equal(cleared.calls[0]!.minReportSeverity, undefined);
  // 三轮各自落下开跑时的生效阈值。
  assert.deepEqual(runMinReportSeverity(db.path), ["P1", "P2", "P2"]);
});

test("低于阈值的未处置历史照旧注入并要结论", async () => {
  const { cache, db, forge } = setup(6);
  const event = { owner: "acme", repo: "widgets", number: 7 };
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };

  // 第一轮全报,落下一条 P2 历史。
  await runReview(event, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [at(6, "P2", "这里可以改成 const")])],
  });
  forge.existingComments.push(
    ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );

  // 第二轮把阈值提到 P1:新报的 P2 发不出去,历史那条 P2 仍要注入、仍要结论。
  setMinReportSeverity(db.path, "P1");
  const second = verdictReviewer("model-a", "present", [at(6, "P2", "这里还是可以改成 const")]);
  await runReview(event, { ...deps, reviewers: [second] });

  const injected = second.calls[0]!.history;
  assert.equal(injected.length, 1);
  assert.equal(injected[0]!.severity, "P2");

  const store = openStore(db.path);
  try {
    const [, latest] = store.listRuns({ limit: 10 }).sort((a, b) => a.id - b.id);
    // 复核结论照常落库:阈值只管新报,不改变历史的口径。
    assert.equal(latest!.findings.length, 0, "新报的 P2 不该落库");
    const runId = latest!.id;
    const filtered = store.listTrace(runId).filter((e) => e.kind === "findings_filtered");
    assert.deepEqual(filtered[0]!.payload, { discarded: 1, minReportSeverity: "P1" });
  } finally {
    store.close();
  }
});
