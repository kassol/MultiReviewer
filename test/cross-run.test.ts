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
// 改 add。第 11 行既不会被卷进 diff,它的指纹窗口(8..14 行)也不变。
const DISTANT_CHANGE = HEAD.replace("return a + b;", "return a + b + 0;");

/** mul 的收尾行。-U3 的 hunk 只覆盖 3..9 行,它落在 diff 之外,退化进 review 正文。 */
const OUT_OF_DIFF_LINE = 11;

const EVENT = { owner: "acme", repo: "widgets", number: 7 };

const FINDING = {
  file: "src/calc.js",
  line: 6,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub 多减了 1",
};

const ANCHOR = /<!-- multireviewer:([0-9a-f]{64}) -->/;
/** 正文里的锚点另带文件路径:正文没有行级评论那样一个由 API 给出的路径。 */
const BODY_ANCHOR = /<!-- multireviewer:([0-9a-f]{64}):(\S+) -->/;

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
  // 误匹配时人展开就能看到完整内容。评论是给开发者的最终结果,不带模型署名。
  assert.match(second.body, /src\/calc\.js:6/);
  assert.match(second.body, /sub 多减了 1/);
  assert.match(second.body, /\*\*\[P0\]\*\*/);
  assert.doesNotMatch(second.body, /model-a/);

  // 第一轮的历史行也被回填成 resolved(ADR 0006):读回的 resolve 状态不再用完即弃。
  assert.deepEqual(latestDispositions(db.path), ["resolved", "resolved"]);
});

test("回填以 Forge 最新状态为准:resolve 后又 unresolve,覆盖回 unresolved", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });
  await runReview(EVENT, deps);
  assert.deepEqual(latestDispositions(db.path), ["resolved", "resolved"]);

  // 人又 unresolve 了:下一轮把这个 PR 名下匹配的每一行都覆盖回 unresolved。
  for (const comment of forge.existingComments) comment.resolved = false;
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": DISTANT_CHANGE });
  await runReview(EVENT, deps);

  assert.deepEqual(latestDispositions(db.path), ["unresolved", "unresolved", "unresolved"]);
  // 折叠的行沿用它历史上的载体:有行级评论承载,来源类型是 inline,进统计。
  const placements = query(db.path, "SELECT placement FROM finding ORDER BY id").map((row) =>
    String(row["placement"]),
  );
  assert.deepEqual(placements, ["inline", "inline", "inline"]);
});

test("每条落库的 finding 都带来源类型:行级评论 inline,正文 fallback 是 body", async () => {
  const { db, forge, deps } = setup();

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-a", [
        FINDING,
        // 行距超过跨模型去重容差,两条不会被合并;这条落在 diff 之外,退化进正文。
        { ...FINDING, line: OUT_OF_DIFF_LINE, description: "mul 的收尾没有校验" },
      ]),
    ],
  });

  assert.equal(forge.createdReviews[0]!.comments.length, 1);
  const rows = query(db.path, "SELECT line, placement FROM finding ORDER BY id");
  assert.deepEqual(
    rows.map((row) => ({ line: Number(row["line"]), placement: String(row["placement"]) })),
    [
      { line: FINDING.line, placement: "inline" },
      { line: OUT_OF_DIFF_LINE, placement: "body" },
    ],
  );
});

test("折叠的 Finding 计入首行总数:口径是本轮结论,不是本轮新增", async () => {
  const { repo, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, [], "这一轮该只有折叠段");
  assert.equal(second.body.split("\n")[0], "MultiReviewer:1 条 Finding(P0 1)");
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
  // 代码改了,指纹变了:本轮是新的一条(unknown,新的处置机会);第一轮的历史行凭
  // 旧指纹仍与旧评论对得上,回填成 resolved(ADR 0006)。
  assert.deepEqual(latestDispositions(db.path), ["resolved", "unknown"]);
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

  // 历史行同样被回填:未处置也是一个明确的读回状态,覆盖掉首轮的 unknown。
  assert.deepEqual(latestDispositions(db.path), ["unresolved", "unresolved"]);
});

test("模型换了代表行(相差 3 行以内)时仍匹配为同一处,不重发", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  // 上一轮锚在第 6 行(缺陷行),这一轮模型把同一个问题指到第 3 行。
  // PR #4 实测:两轮分别指函数头与缺陷行,相差 3 行,精确指纹匹配不上,每轮重发。
  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [{ ...FINDING, line: 3 }])],
  });

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, [], "换了代表行的同一个 Finding 又被发成了行级评论");
  assert.match(second.body, /尚未处置/);
  assert.deepEqual(latestDispositions(db.path), ["unresolved", "unresolved"]);
});

test("行号相差超过 3 行时不匹配,按新 Finding 提出", async () => {
  const { repo, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  // 相差 4 行:与跨模型去重同一条容差线,线外就是另一处问题。
  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [{ ...FINDING, line: 10 }])],
  });

  const second = forge.createdReviews[1]!;
  assert.doesNotMatch(second.body, /尚未处置|曾被处置/);
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

test("退化进 review 正文的 Finding 带指纹锚点,锚点里另有文件路径", async () => {
  const { db, forge, deps } = setup();

  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [{ ...FINDING, line: OUT_OF_DIFF_LINE }])],
  });

  const review = forge.createdReviews[0]!;
  assert.deepEqual(review.comments, [], "第 11 行本该落在 diff 之外");
  const anchor = BODY_ANCHOR.exec(review.body);
  assert.ok(anchor !== null, "正文里的 fallback 块没有指纹锚点");
  assert.equal(anchor[2], "src/calc.js");
  assert.equal(anchor[1], query(db.path, "SELECT fingerprint FROM finding")[0]!["fingerprint"]);
});

test("上一轮退化进正文的 Finding,本轮匹配成功后折叠,不再全文重发", async () => {
  const { repo, db, forge, deps } = setup();
  const reviewers = [
    scriptedReviewer("model-a", [{ ...FINDING, line: OUT_OF_DIFF_LINE }]),
  ];

  await runReview(EVENT, { ...deps, reviewers });
  // 把上一轮真的发布出去的正文,当成 Forge 上的既有 review 喂给下一轮。
  forge.existingReviewBodies.push(forge.createdReviews[0]!.body);
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": DISTANT_CHANGE });

  await runReview(EVENT, { ...deps, reviewers });

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, []);
  assert.doesNotMatch(second.body, /diff 之外/, "diff 外的同一条 Finding 又被全文重发");
  // 正文里的锚点读不到 resolve 状态,匹配上一律按未处置折叠。
  assert.match(second.body, /尚未处置/);
  assert.match(second.body, /src\/calc\.js:11/);
  assert.match(second.body, /sub 多减了 1/);

  assert.deepEqual(latestDispositions(db.path), ["unknown", "unresolved"]);
});

test("折叠过一轮之后仍不重发:第三轮认的是第一轮正文里的锚点", async () => {
  const { repo, forge, deps } = setup();
  const reviewers = [
    scriptedReviewer("model-a", [{ ...FINDING, line: OUT_OF_DIFF_LINE }]),
  ];

  // 折叠段本身不埋锚点(`findingLine` 只写一行摘要),第二轮的正文里因此没有锚点。
  // 这条链靠的是 `listReviewBodies` 返回 PR 上全部历史 review 而非最新一条:第三轮
  // 认的是第一轮那条正文。改成只读最新一条,这个 Finding 会从第三轮起每轮重发。
  await runReview(EVENT, { ...deps, reviewers });
  forge.existingReviewBodies.push(forge.createdReviews[0]!.body);
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": DISTANT_CHANGE });

  await runReview(EVENT, { ...deps, reviewers });
  forge.existingReviewBodies.push(forge.createdReviews[1]!.body);
  forge.pullRequest.headSha = repo.pushToHead({
    "src/calc.js": HEAD.replace("return a + b;", "return a + b + 1;"),
  });

  await runReview(EVENT, { ...deps, reviewers });

  const third = forge.createdReviews[2]!;
  assert.doesNotMatch(third.body, /diff 之外/, "折叠过一轮的 Finding 第三轮又被全文重发");
  assert.match(third.body, /尚未处置/);
});

test("一条正文里的多个锚点全部参与匹配", async () => {
  const { repo, forge, deps } = setup();
  const reviewers = [
    scriptedReviewer("model-a", [
      { ...FINDING, line: 1, description: "add 没有参数校验" },
      { ...FINDING, line: OUT_OF_DIFF_LINE },
    ]),
  ];

  await runReview(EVENT, { ...deps, reviewers });
  forge.existingReviewBodies.push(forge.createdReviews[0]!.body);
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, { ...deps, reviewers });

  const second = forge.createdReviews[1]!;
  assert.doesNotMatch(second.body, /diff 之外/, "一条正文里的两个锚点只认了第一个");
  assert.match(second.body, /尚未处置的 Finding\(2 条\)/);
});

test("人写的 review 正文不带锚点,不参与匹配", async () => {
  const { db, forge, deps } = setup();
  forge.existingReviewBodies.push("这个 PR 我看过了,mul 那段没问题");

  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [{ ...FINDING, line: OUT_OF_DIFF_LINE }])],
  });

  const review = forge.createdReviews[0]!;
  assert.match(review.body, /diff 之外/, "人写的 review 正文把本轮 Finding 折叠掉了");
  assert.doesNotMatch(review.body, /<details>/);
  assert.deepEqual(latestDispositions(db.path), ["unknown"]);
});
