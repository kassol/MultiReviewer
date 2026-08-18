import assert from "node:assert/strict";
import { after, test } from "node:test";

import { buildReviewers } from "../src/config.ts";
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
  // 合并不丢内容:另一个模型的表述保留在来源里,落库供处置率统计。
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

test("相距 3 行但内容明显不同的两条 Finding 不合并", async () => {
  const { cache, db, forge, event } = setup();

  // PR #3 的实况:`new Function` 的 RCE 与 `summary()` 越界相距 3 行,只看行距时被
  // 合成一条,评论正文讲的是其中一个问题,来源里却装着两个。
  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        {
          ...AT_LINE_2,
          title: "new Function 执行用户输入,存在 RCE 风险",
          description: "表达式未经校验就交给 new Function 执行。",
        },
      ]),
      scriptedReviewer("model-b", [
        {
          ...AT_LINE_2,
          line: 5,
          title: "summary() 在 count 为负数时切片越界",
          description: "负数下标让切片退化成整表读取。",
        },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((f) => f.title).sort(),
    [
      "new Function 执行用户输入,存在 RCE 风险",
      "summary() 在 count 为负数时切片越界",
    ].sort(),
  );
});

test("同一缺陷的不同表述相距 2 行仍合并为一条", async () => {
  const { cache, db, forge, event } = setup();

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        {
          ...AT_LINE_2,
          title: "表达式求值使用 new Function,存在远程代码执行风险",
          description: "用户可控的字符串直接进了 new Function。",
        },
      ]),
      scriptedReviewer("model-b", [
        {
          ...AT_LINE_2,
          line: 4,
          title: "new Function 执行用户输入导致 RCE",
          description: "攻击者能借表达式执行任意 JavaScript。",
        },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual([...result.findings[0]!.models].sort(), ["model-a", "model-b"]);
});

test("标题为空时改用描述判断,描述讲的不是一回事就不合并", async () => {
  const { cache, db, forge, event } = setup();

  // 模型没给标题时归一化补空串。空标题不能让内容判据失效——那会让缺标题的模型
  // 退回只看行距的老行为。
  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        { ...AT_LINE_2, description: "表达式求值存在远程代码执行风险。" },
      ]),
      scriptedReviewer("model-b", [
        { ...AT_LINE_2, line: 5, description: "历史记录切片越界。" },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.findings.length, 2);
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

/**
 * 撞名的自定义 provider 那一档(issue #94):它的模型仍在模型组合里时,这一轮留下一条写明
 * 名字冲突的失败记录,同一轮里其余 Reviewer 照常跑完、review 照常发,整轮不算失败
 * (`run.ts` 的 `failed` 是「全部都失败」)。
 *
 * 失败的那一个由真实的 `buildReviewers` 组装出来,不是脚本 Reviewer:这一条要守的正是
 * 「组装时按失败处理」与「Review Run 留下这条记录」之间那一段真实链路。
 */
test("撞名的 provider 留下失败记录,其余 Reviewer 照常跑完,整轮不算失败", async () => {
  const { cache, db, forge, event } = setup();
  const collided = { provider: "corp-gateway", model: "corp-qwen3-max" };
  const [conflicting] = buildReviewers(
    [collided],
    new Map([[collided.provider, "k-corp"]]),
    new Set([collided.provider]),
  );

  const result = await runReview(event, {
    forge: forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT_LINE_2]), conflicting!],
    cacheDir: cache.dir,
    dbPath: db.path,
  });

  assert.equal(result.failed, false, "一个模型撞名把整轮 Run 判成失败了");
  assert.equal(forge.createdReviews.length, 1);
  assert.equal(forge.createdReviews[0]!.comments.length, 1, "其余 Reviewer 的 Finding 没发出去");

  const store = openStore(db.path);
  try {
    const models = store.listRuns({ limit: 1 })[0]!.models;
    const failed = models.find((row) => row.model === "corp-gateway:corp-qwen3-max");
    assert.match(failed?.failure ?? "", /名字/, "失败记录没写明是名字冲突");
    assert.equal(models.find((row) => row.model === "model-a")?.failure, null);
  } finally {
    store.close();
  }
});
