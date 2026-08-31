import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { ExistingReviewComment, ReviewDraft } from "../src/forge/forge.ts";
import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import {
  memoryForge,
  scriptedReviewer,
  verdictReviewer,
  type MemoryForge,
} from "./support/memory-forge.ts";

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
      title: "示例 PR",
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

/** 人在面板上处置的时刻。 */
const DISPOSED_AT = "2026-08-25T00:00:00.000Z";

/** 把上一轮真的发布出去的行级评论,当成 Forge 上的既有评论喂给下一轮。 */
function asExisting(draft: ReviewDraft, resolved: boolean): ExistingReviewComment[] {
  return draft.comments.map((comment, index) => ({
    id: `thread-${index}`,
    path: comment.path,
    line: comment.line,
    body: comment.body,
    resolved,
    htmlUrl: `https://forge.invalid/comments/thread-${index}`,
  }));
}

/**
 * 同上,但连 Forge 给的评论 id 一起带过去。面板处置认的是那个 id,要让处置与下一轮
 * 的折叠落在同一条评论上,喂回去的就必须是它。
 */
function asPublished(forge: MemoryForge, resolved: boolean): ExistingReviewComment[] {
  return forge.publishedComments.map((comment) => ({ ...comment, resolved }));
}

function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** 落库的处置人与处置时刻,按落库顺序。 */
function dispositionMarks(dbPath: string): { by: unknown; at: unknown }[] {
  return query(dbPath, "SELECT disposed_by, disposed_at FROM finding ORDER BY id").map(
    (row) => ({ by: row["disposed_by"], at: row["disposed_at"] }),
  );
}

/** 人在面板上处置一条 Finding:落库这一步与面板 API 走同一段代码。 */
function disposeInPanel(
  dbPath: string,
  commentId: string,
  disposition: "resolved" | "unresolved",
  note?: string,
): void {
  const store = openStore(dbPath);
  try {
    store.recordDisposition({
      owner: EVENT.owner,
      repo: EVENT.repo,
      commentId,
      disposition,
      disposedBy: "kassol",
      disposedAt: DISPOSED_AT,
      ...(note === undefined ? {} : { note }),
    });
  } finally {
    store.close();
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

test("锚不进 hunk 的那条被丢弃,落库的每条来源类型都是 inline", async () => {
  const { db, forge, deps } = setup();

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-a", [
        FINDING,
        // 行距超过跨模型去重容差,两条不会被合并;这条落在 diff 之外,丢弃(issue #224)。
        { ...FINDING, line: OUT_OF_DIFF_LINE, description: "mul 的收尾没有校验" },
      ]),
    ],
  });

  assert.equal(forge.createdReviews[0]!.comments.length, 1);
  assert.doesNotMatch(forge.createdReviews[0]!.body, /mul 的收尾没有校验/);
  const rows = query(db.path, "SELECT line, placement FROM finding ORDER BY id");
  assert.deepEqual(
    rows.map((row) => ({ line: Number(row["line"]), placement: String(row["placement"]) })),
    [{ line: FINDING.line, placement: "inline" }],
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

test("跨轮折叠不分模型:上一轮 model-a 报的,本轮 model-b 报同一处也折叠", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  assert.equal(forge.createdReviews[0]!.comments.length, 1);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  // 换一个模型报同一处:Finding Identity 不含模型(ADR 0015),仍是同一条。
  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-b", [{ ...FINDING, description: "减法结果偏移" }])],
  });

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, [], "换个模型报同一处又发了一条新的行级评论");
  assert.match(second.body, /尚未处置/);

  // 本轮那一行记的是上一轮那条评论:处置的载体没有因为换了模型而分家。
  const rows = query(db.path, "SELECT comment_id FROM finding ORDER BY id");
  assert.deepEqual(
    rows.map((row) => row["comment_id"]),
    [forge.publishedComments[0]!.id, forge.publishedComments[0]!.id],
  );
  // 两轮各一条 Finding,各自记住报出它的那个模型。
  const attributions = query(
    db.path,
    "SELECT model FROM finding_attribution ORDER BY finding_id",
  );
  assert.deepEqual(attributions.map((row) => row["model"]), ["model-a", "model-b"]);
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

/**
 * 锚定收敛之前发出去的那种 review 正文:diff 外的 Finding 只活在正文里,锚点自带文件
 * 路径(issue #224 之后不再产生,存量 PR 上还挂着)。跨轮匹配仍要认得出它。
 */
function legacyBody(fingerprints: readonly string[]): string {
  return [
    "MultiReviewer",
    "",
    "以下 Finding 的行号落在本次 Review Range 的 diff 之外,无法作为行级评论呈现:",
    ...fingerprints.map((fingerprint) => `\n<!-- multireviewer:${fingerprint}:src/calc.js -->`),
  ].join("\n");
}

/** 这一轮落库的全部指纹,按落库顺序。 */
function fingerprints(dbPath: string): string[] {
  return query(dbPath, "SELECT fingerprint FROM finding ORDER BY id").map((row) =>
    String(row["fingerprint"]),
  );
}

test("上一轮只活在 review 正文里的 Finding,本轮匹配成功后折叠,不再全文重发", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  // 上一轮的记录只在正文里:锚点带路径,没有行级评论可读 resolve 状态。
  forge.existingReviewBodies.push(legacyBody(fingerprints(db.path)));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, [], "同一条 Finding 又被当成新的报了一遍");
  // 正文里的锚点读不到 resolve 状态,匹配上一律按未处置折叠。
  assert.match(second.body, /尚未处置/);
  assert.match(second.body, /src\/calc\.js:6/);
  assert.match(second.body, /sub 多减了 1/);

  assert.deepEqual(latestDispositions(db.path), ["unknown", "unresolved"]);
});

test("折叠过一轮之后仍不重发:第三轮认的是第一轮正文里的锚点", async () => {
  const { repo, db, forge, deps } = setup();

  // 折叠段本身不埋锚点(`findingLine` 只写一行摘要),第二轮的正文里因此没有锚点。
  // 这条链靠的是 `listReviewBodies` 返回 PR 上全部历史 review 而非最新一条:第三轮
  // 认的是第一轮那条正文。改成只读最新一条,这个 Finding 会从第三轮起每轮重发。
  await runReview(EVENT, deps);
  forge.existingReviewBodies.push(legacyBody(fingerprints(db.path)));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);
  forge.existingReviewBodies.push(forge.createdReviews[1]!.body);
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": DISTANT_CHANGE });

  await runReview(EVENT, deps);

  const third = forge.createdReviews[2]!;
  assert.deepEqual(third.comments, [], "折叠过一轮的 Finding 第三轮又被当成新的报出");
  assert.match(third.body, /尚未处置/);
});

test("一条正文里的多个锚点全部参与匹配", async () => {
  const { repo, db, forge, deps } = setup();
  const reviewers = [
    scriptedReviewer("model-a", [
      { ...FINDING, line: 3, description: "add 的收尾没有校验" },
      FINDING,
    ]),
  ];

  await runReview(EVENT, { ...deps, reviewers });
  forge.existingReviewBodies.push(legacyBody(fingerprints(db.path)));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, { ...deps, reviewers });

  const second = forge.createdReviews[1]!;
  assert.deepEqual(second.comments, [], "一条正文里的两个锚点只认了第一个");
  assert.match(second.body, /尚未处置的 Finding\(2 条\)/);
});

test("人写的 review 正文不带锚点,不参与匹配", async () => {
  const { db, forge, deps } = setup();
  forge.existingReviewBodies.push("这个 PR 我看过了,sub 那段没问题");

  await runReview(EVENT, deps);

  const review = forge.createdReviews[0]!;
  assert.equal(review.comments.length, 1, "人写的 review 正文把本轮 Finding 折叠掉了");
  assert.doesNotMatch(review.body, /<details>/);
  assert.deepEqual(latestDispositions(db.path), ["unknown"]);
});

test("行级 Finding 记下 Forge 的评论 id 与链接,丢弃的那条根本不落库", async () => {
  const { db, forge, deps } = setup();

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-a", [
        FINDING,
        // 行距超过跨模型去重容差,两条不会被合并;这条落在 diff 之外,丢弃(issue #224)。
        { ...FINDING, line: OUT_OF_DIFF_LINE, description: "mul 的收尾没有校验" },
      ]),
    ],
  });

  // 内存 Forge 按发布顺序给评论编号,链接跟着它走。
  assert.equal(forge.publishedComments.length, 1);
  const published = forge.publishedComments[0]!;
  const rows = query(
    db.path,
    "SELECT line, comment_id, comment_html_url FROM finding ORDER BY id",
  ).map((row) => ({
    line: Number(row["line"]),
    commentId: row["comment_id"],
    commentHtmlUrl: row["comment_html_url"],
  }));
  assert.deepEqual(rows, [
    { line: FINDING.line, commentId: published.id, commentHtmlUrl: published.htmlUrl },
  ]);
});

test("跨轮匹配到历史评论的 Finding,记的是那条历史评论的 id", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asExisting(forge.createdReviews[0]!, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  // 第二轮折叠,不发新评论,处置的载体仍是第一轮那条。
  assert.deepEqual(forge.createdReviews[1]!.comments, []);
  const latest = query(
    db.path,
    "SELECT comment_id, comment_html_url FROM finding ORDER BY id",
  ).at(-1)!;
  assert.equal(latest["comment_id"], "thread-0");
  assert.equal(latest["comment_html_url"], "https://forge.invalid/comments/thread-0");
});

/**
 * 复核裁决与「已修复」自动处置(ADR 0016,issue #166)。一条历史 Finding 的最终结论由
 * 本轮全部 Reviewer 的复核结论合成:任一判仍在则仍在,否则全部判已修才是已修。指纹
 * 不再单独构成证据——它变没变都不改变裁决。
 */

/** 本轮什么都不报、也不给复核结论的 Reviewer。 */
const SILENT = [scriptedReviewer("model-a", [])];

/**
 * 跑两轮:第一轮报出一条 Finding 并把它当成 Forge 上未处置的既有评论,第二轮交给给定的
 * Reviewer 复核。裁决用例的差别只在「本轮各 Reviewer 怎么说」与「代码改没改」两处。
 *
 * 喂回去的是 Forge 真的给出的那个评论 id:自动处置 resolve 的是库里记着的那一条。
 */
async function judgeSecondRound(
  reviewers: readonly Reviewer[],
  head: string = SAME_LINE_CHANGE,
): Promise<{ db: { path: string }; forge: MemoryForge }> {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": head });

  await runReview(EVENT, { ...deps, reviewers });
  return { db, forge };
}

test("两个 Reviewer 都判已修:Forge 收到 resolve,库里记「已修复」,处置人留空", async () => {
  const { db, forge } = await judgeSecondRound([
    verdictReviewer("model-a", "fixed"),
    verdictReviewer("model-b", "fixed"),
  ]);

  assert.deepEqual(
    forge.resolvedIds,
    [forge.publishedComments[0]!.id],
    "复核全判已修却没有写回 Forge",
  );
  assert.deepEqual(latestDispositions(db.path), ["fixed"]);
  // 处置人留空,处置时刻照记:这一档不是人做的,时刻同时是「已被处置过」的标记。
  const [mark] = dispositionMarks(db.path);
  assert.equal(mark!.by, null);
  assert.notEqual(mark!.at, null);

  // 面板的处置进度把人工与自动分开数:这一条落在自动那一列。
  const store = openStore(db.path);
  const first = store.listRuns({ limit: 10 }).at(-1)!;
  store.close();
  assert.deepEqual(
    { resolved: first.resolved, fixed: first.fixed, total: first.total },
    { resolved: 0, fixed: 1, total: 1 },
  );
});

test("一个判已修、一个判仍在:仍在优先,不自动处置", async () => {
  const { db, forge } = await judgeSecondRound([
    verdictReviewer("model-a", "fixed"),
    verdictReviewer("model-b", "present"),
  ]);

  assert.deepEqual(forge.resolvedIds, []);
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("一个判已修、一个判无法判断:不自动处置", async () => {
  const { db, forge } = await judgeSecondRound([
    verdictReviewer("model-a", "fixed"),
    verdictReviewer("model-b", "unclear"),
  ]);

  assert.deepEqual(forge.resolvedIds, []);
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("一个判已修、一个漏复核:沉默不是证据,不自动处置", async () => {
  const { db, forge } = await judgeSecondRound([
    verdictReviewer("model-a", "fixed"),
    scriptedReviewer("model-b", []),
  ]);

  assert.deepEqual(forge.resolvedIds, []);
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("指纹未变、复核判已修:照样自动处置", async () => {
  // 作者在上游加了判空,Finding 所指的那几行原样不动:指纹算得出,只有复核认得出它已修。
  const { db, forge } = await judgeSecondRound(
    [verdictReviewer("model-a", "fixed")],
    UNRELATED_CHANGE,
  );

  assert.deepEqual(
    forge.resolvedIds,
    [forge.publishedComments[0]!.id],
    "指纹不变的修法没能自动处置",
  );
  assert.deepEqual(latestDispositions(db.path), ["fixed"]);
});

test("指纹已变、复核判仍在:不自动处置", async () => {
  const { db, forge } = await judgeSecondRound([verdictReviewer("model-a", "present")]);

  assert.deepEqual(forge.resolvedIds, [], "代码改了就被当成修好了");
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("指纹已变但一条复核结论都没有:不自动处置", async () => {
  // ADR 0013 的旧判据会在这里自动处置。指纹自 ADR 0016 起不再单独构成证据。
  const { db, forge } = await judgeSecondRound(SILENT);

  assert.deepEqual(forge.resolvedIds, [], "指纹消失又被单独当成了证据");
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("人已经在 Forge 上处置过的:复核判已修也不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });

  assert.deepEqual(forge.resolvedIds, []);
  assert.deepEqual(latestDispositions(db.path), ["resolved"], "人工处置被自动处置盖掉了");
});

test("回填不把「已修复」降级成人工处置", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });
  assert.deepEqual(latestDispositions(db.path), ["fixed"]);

  // 自动处置写回 Forge 之后,那条评论在 Forge 上就是 resolved,下一轮照样读回来。
  for (const comment of forge.existingComments) comment.resolved = true;
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": DISTANT_CHANGE });
  await runReview(EVENT, { ...deps, reviewers: SILENT });

  assert.deepEqual(latestDispositions(db.path), ["fixed"], "回填把自动处置读成了人工处置");
});

test("人把「已修复」改回未处置之后,下一轮判已修也不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });
  assert.deepEqual(latestDispositions(db.path), ["fixed"]);

  // 人在面板上撤回了这次自动处置:从此这一行是人工处置的地盘。
  disposeInPanel(db.path, forge.publishedComments[0]!.id, "unresolved");
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": DISTANT_CHANGE });
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });

  assert.deepEqual(
    forge.resolvedIds,
    [forge.publishedComments[0]!.id],
    "人撤回之后又被自动处置了一次",
  );
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("全部 Reviewer 都失败的那一轮不裁决:它根本没跑,复核结论不算数", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-a", [], {
        failure: "模型服务不可用",
        verdicts: [{ findingId: 1, verdict: "fixed" }],
      }),
    ],
  });

  assert.deepEqual(forge.resolvedIds, []);
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
});

test("跨轮折叠继承处置备注与署名:面板处置活过下一轮", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  // 人在面板上处置了它,并留了一句备注。
  disposeInPanel(db.path, forge.publishedComments[0]!.id, "resolved", "确认无影响");
  forge.existingComments.push(...asPublished(forge, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  assert.deepEqual(forge.createdReviews[1]!.comments, [], "这一轮该折叠到历史评论上");
  // 面板读的是本轮那一行:处置的载体是评论,同一条评论名下的历史行与本轮新行说的
  // 是同一次处置,备注与署名不该只活在上一轮那一行上。
  const store = openStore(db.path);
  const latest = store.listRuns({ limit: 10 })[0]!;
  store.close();
  const carried = latest.findings[0]!;
  assert.equal(carried.disposition, "resolved");
  assert.equal(carried.commentId, forge.publishedComments[0]!.id);
  assert.equal(carried.note, "确认无影响");
  assert.equal(carried.disposedBy, "kassol");
  assert.equal(carried.disposedAt, DISPOSED_AT);
});

test("人撤回处置之后再折叠一轮:复核判已修也不自动处置", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  // 人在面板上把它标回未处置:从此这一行是人工处置的地盘(ADR 0016)。
  disposeInPanel(db.path, forge.publishedComments[0]!.id, "unresolved");
  forge.existingComments.push(...asPublished(forge, false));

  // 第二轮代码没变,同一条 Finding 又被报出,折叠到那条历史评论上。
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });
  await runReview(EVENT, deps);

  // 第三轮复核判已修。折叠那一行不继承 `disposed_at` 时,人的免疫被新的一行稀释,
  // 这条会被自动处置成「已修复」。
  forge.pullRequest.headSha = repo.pushToHead({
    "src/calc.js": UNRELATED_CHANGE.replace("return a - b - 1;", "return a - b - 2;"),
  });
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });

  assert.deepEqual(forge.resolvedIds, [], "人撤回处置之后又被自动处置了一次");
  assert.deepEqual(latestDispositions(db.path), ["unresolved", "unresolved"]);
});

/**
 * 延续(CONTEXT.md 已延续,ADR 0016,issue #167)。复核判仍在、旧指纹在本轮 head 上算
 * 不出时,本轮在新位置报出的那条承接同一条 Finding Identity:旧评论 resolve、旧行记
 * 「已延续」,处置元数据随 Identity 走,新评论正文注明延续自哪条旧评论。
 */

/** 本轮判仍在,并在同一个文件的新位置报出一条:延续要的两个条件都由它给出。 */
function continuing(): Reviewer[] {
  return [
    verdictReviewer("model-a", "present", [{ ...FINDING, description: "减法仍然多减了 1" }]),
  ];
}

/** 落库的「延续自」链接,按落库顺序。 */
function continuedFrom(dbPath: string): unknown[] {
  return query(dbPath, "SELECT continued_from FROM finding ORDER BY id").map(
    (row) => row["continued_from"],
  );
}

/**
 * 跑到延续发生为止:第一轮报出一条并把它当成 Forge 上未处置的既有评论,第二轮把那处
 * 代码改写掉(指纹必变),模型判仍在并在同一个文件报出新位置的那一条。
 */
async function continueSecondRound(): Promise<{
  repo: ReturnType<typeof makeRepo>;
  db: { path: string };
  forge: MemoryForge;
  deps: Parameters<typeof runReview>[1];
}> {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, { ...deps, reviewers: continuing() });
  return { repo, db, forge, deps };
}

test("复核判仍在、代码已改写:新位置那条承接同一条,旧评论 resolve 并记「已延续」", async () => {
  const { db, forge } = await continueSecondRound();
  const old = forge.publishedComments[0]!;

  // 旧评论收到 resolve,旧行记「已延续」——它只是位置的交接,不是处置。
  assert.deepEqual(forge.resolvedIds, [old.id], "旧评论没有被 resolve");
  assert.deepEqual(latestDispositions(db.path), ["continued", "unknown"]);

  // 本轮在新位置发了一条新评论,正文里注明延续自旧评论并带它的链接。
  const second = forge.createdReviews[1]!;
  assert.equal(second.comments.length, 1, "承接的那条该发成新的行级评论");
  assert.match(second.comments[0]!.body, /延续自/);
  assert.ok(second.comments[0]!.body.includes(old.htmlUrl), "正文里没有旧评论的链接");

  // 新行记下旧评论的链接:面板的 diff 卡片据此显示「延续自」。
  assert.deepEqual(continuedFrom(db.path), [null, old.htmlUrl]);
});

test("延续把旧行的备注、处置人与处置时刻带到新行上", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  const old = forge.publishedComments[0]!;
  // 人处置过又撤回:备注与署名留在旧行上,延续要把它们带到新位置去。延续是位置的交接
  // 不是处置,「已修复」自动处置那道「人碰过就不再碰」的闸门不适用于它(issue #163 US 36)。
  disposeInPanel(db.path, old.id, "resolved", "确认无影响");
  disposeInPanel(db.path, old.id, "unresolved");
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  const store = openStore(db.path);
  const latest = store.listRuns({ limit: 10 })[0]!;
  store.close();
  const carried = latest.findings[0]!;
  assert.equal(carried.note, "确认无影响");
  assert.equal(carried.disposedBy, "kassol");
  assert.equal(carried.disposedAt, DISPOSED_AT);
  assert.equal(carried.continuedFrom, old.htmlUrl);
});

test("复核判仍在、代码已改写但本轮没在新位置报出:旧行不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  // 判仍在,却一条都没报出来:没有承接它的新位置,这条留在原地等人。
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "present")] });

  assert.deepEqual(forge.resolvedIds, [], "没人承接却把旧评论 resolve 了");
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
  assert.deepEqual(continuedFrom(db.path), [null]);
});

test("本轮那条讲的不是同一回事:不承接,旧行不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  // 判仍在、指纹也变了,但本轮在这个文件里报出的那条与旧条目一个词都不共享。承接它
  // 就是把旧问题挪到一处无关的代码上,旧评论还被 resolve 掉——比不承接更糟。行号
  // 撞上也不豁免:旧位置的代码已经改写,行号跨轮之间证明不了两条讲的是同一回事。
  await runReview(EVENT, {
    ...deps,
    reviewers: [
      verdictReviewer("model-a", "present", [
        { ...FINDING, description: "缺少参数类型校验" },
      ]),
    ],
  });

  assert.deepEqual(forge.resolvedIds, [], "内容对不上却把旧评论 resolve 了");
  assert.deepEqual(latestDispositions(db.path), ["unresolved", "unknown"]);
  assert.deepEqual(continuedFrom(db.path), [null, null]);
  // 本轮那条按新 Finding 正常提出,正文里没有那句「延续自」。
  assert.doesNotMatch(forge.createdReviews[1]!.comments[0]!.body, /延续自/);
});

test("承接的新位置落在 diff 之外:那条先被丢弃,不承接,旧行不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  // 判仍在、指纹也变了、内容也对得上,但本轮那条落在 diff 之外:锚定收敛把它丢掉了
  // (issue #224),没有东西可以承接。承接一条接不住的位置等于旧评论白被 resolve。
  await runReview(EVENT, {
    ...deps,
    reviewers: [
      verdictReviewer("model-a", "present", [
        { ...FINDING, line: OUT_OF_DIFF_LINE, description: "减法仍然多减了 1" },
      ]),
    ],
  });

  assert.deepEqual(forge.resolvedIds, [], "diff 之外的那条却把旧评论 resolve 了");
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
  assert.deepEqual(continuedFrom(db.path), [null]);
  // 一条结论都没剩下,这一轮无话可说,连 review 都不发。
  assert.equal(forge.createdReviews.length, 1);
});

/**
 * 复核结论自带新位置(issue #170):模型只回 `present` 并给出新位置时,编排层按历史条目
 * 在那个位置合成本轮的一条去承接,不再等模型自己重报——线上两次验证里它都不重报。
 */

/** SAME_LINE_CHANGE 之后 sub 的函数头。它在 -U3 的 hunk(3..9 行)内,承得住行级评论。 */
const NEW_LINE = 5;

test("复核判仍在并给出新位置:模型一条都没重报也照样承接", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  const old = forge.publishedComments[0]!;
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "present", [], NEW_LINE)],
  });

  assert.deepEqual(forge.resolvedIds, [old.id], "旧评论没有被 resolve");
  assert.deepEqual(latestDispositions(db.path), ["continued", "unknown"]);

  const second = forge.createdReviews[1]!;
  assert.equal(second.comments.length, 1, "该在复核给出的新位置上发一条");
  assert.equal(second.comments[0]!.line, NEW_LINE);
  assert.match(second.comments[0]!.body, /延续自/);
  // 合成的那条抄历史条目的正文与严重度,归属给出这个位置的那个模型。
  assert.match(second.comments[0]!.body, /sub 多减了 1/);
  assert.match(second.comments[0]!.body, /model-a/);
  assert.deepEqual(continuedFrom(db.path), [null, old.htmlUrl]);
  const synthesized = query(db.path, "SELECT severity, category FROM finding ORDER BY id")[1]!;
  assert.equal(synthesized["severity"], "P0");
  assert.equal(synthesized["category"], "bug");
});

test("复核给的新位置落在 diff 之外:不承接,旧行不动", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  // 判据与模型自己重报那一档同一条(issue #167):diff 之外的位置没有 resolve 载体,
  // 承接它等于旧评论被 resolve 掉、新位置却接不住。
  await runReview(EVENT, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "present", [], OUT_OF_DIFF_LINE)],
  });

  assert.deepEqual(forge.resolvedIds, [], "diff 之外的位置却把旧评论 resolve 了");
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
  assert.deepEqual(continuedFrom(db.path), [null]);
});

test("模型同时重报了同内容的一条:以重报那条为准,不再合成", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  const old = forge.publishedComments[0]!;
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  // 复核给的新位置是第 5 行,重报的那条在第 6 行。重报带着模型本轮的措辞,比抄旧正文
  // 更贴近现在的代码,因此由它承接。
  await runReview(EVENT, {
    ...deps,
    reviewers: [
      verdictReviewer(
        "model-a",
        "present",
        [{ ...FINDING, description: "减法仍然多减了 1" }],
        NEW_LINE,
      ),
    ],
  });

  const second = forge.createdReviews[1]!;
  assert.equal(second.comments.length, 1, "重报之外又合成了一条");
  assert.equal(second.comments[0]!.line, FINDING.line);
  assert.match(second.comments[0]!.body, /减法仍然多减了 1/);
  assert.match(second.comments[0]!.body, /延续自/);
  assert.deepEqual(forge.resolvedIds, [old.id]);
  assert.deepEqual(continuedFrom(db.path), [null, old.htmlUrl]);
});

test("旧位置的代码没改动:复核给的新位置一并忽略,不产生延续", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  // 改的是 mul,旧 Finding 那处代码原样还在,旧指纹照样算得出。
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, {
    ...deps,
    reviewers: [verdictReviewer("model-a", "present", [], NEW_LINE)],
  });

  assert.deepEqual(forge.resolvedIds, [], "代码没改动却把旧评论 resolve 了");
  assert.deepEqual(latestDispositions(db.path), ["unresolved"]);
  assert.deepEqual(continuedFrom(db.path), [null]);
  assert.equal(forge.createdReviews.length, 1, "没有该发的东西却又发了一轮 review");
});

/**
 * 两处改动的两端:sub 那处两轮之间又改了一次,mul 那处两轮都一样。第二轮的 diff 因此
 * 覆盖 3..13 行,mul 那条既落在 hunk 内(有行级评论承载)、指纹又没变(照旧折叠)。
 */
const HEAD_TWO_SPOTS = HEAD.replace("return a * b;", "return a * b * 2;");
const SECOND_HEAD_TWO_SPOTS = SAME_LINE_CHANGE.replace("return a * b;", "return a * b * 2;");

/** mul 的收尾行。它靠 mul 那处改动进了 hunk,指纹又不被下一轮碰到,下一轮照旧折叠。 */
const MUL_FINDING = {
  ...FINDING,
  line: 11,
  description: "mul 的结果没有做溢出保护",
};

/** 本轮另报的两条,与旧条目一个词都不共享:承接不到它们身上,各自按新 Finding 提出。 */
const UNRELATED_FINDINGS = [
  { ...FINDING, line: 3, description: "加法没有校验参数类型" },
  { ...FINDING, line: 7, description: "文件末尾缺少换行" },
];

test("合成的那条与本轮多条新报并存:「延续自」只落在承接它的那条评论上", async () => {
  const { repo, db, forge, deps } = setup();

  // 第一轮报两条,两条都在 diff 内,各发一条行级评论。
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": HEAD_TWO_SPOTS });
  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [FINDING, MUL_FINDING])],
  });
  const old = forge.publishedComments[0]!;
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SECOND_HEAD_TWO_SPOTS });

  // 第二轮:mul 那条代码未改动照旧折叠,另报两条无关的新 Finding,sub 那条只回复核结论
  // 并带新位置——合成的那条接在本轮之后,合并组序号最大。
  await runReview(EVENT, {
    ...deps,
    reviewers: [
      verdictReviewer("model-a", "present", [MUL_FINDING, ...UNRELATED_FINDINGS], NEW_LINE),
    ],
  });

  assert.deepEqual(forge.resolvedIds, [old.id], "旧评论没有被 resolve");

  const second = forge.createdReviews[1]!;
  assert.equal(second.comments.length, 3, "两条新报加合成的那条,该发三条行级评论");
  for (const comment of second.comments) {
    if (comment.line === NEW_LINE) {
      assert.match(comment.body, /延续自/);
      assert.ok(comment.body.includes(old.htmlUrl), "承接的那条没带旧评论的链接");
      continue;
    }
    assert.doesNotMatch(comment.body, /延续自/, `第 ${comment.line} 行不该带「延续自」`);
  }

  // 每条评论的锚点与它自己那一行的落库指纹一致:合成的那条追加在后面,不该让别人的
  // 指纹挪位。
  const stored = new Map(
    query(db.path, "SELECT line, fingerprint FROM finding ORDER BY id")
      .slice(2)
      .map((row) => [Number(row["line"]), row["fingerprint"]]),
  );
  for (const comment of second.comments) {
    assert.equal(
      ANCHOR.exec(comment.body)?.[1],
      stored.get(comment.line),
      `第 ${comment.line} 行的锚点与落库指纹对不上`,
    );
  }

  // 跨轮匹配同样不受影响:mul 那条照旧折叠进正文,两条新报与合成的那条都是本轮新报。
  assert.match(second.body, /尚未处置/);
  assert.deepEqual(latestDispositions(db.path), [
    "continued",
    // 第一轮 mul 那条有行级评论承载,回填按 Forge 上的未 resolve 状态写回。
    "unresolved",
    "unknown",
    "unknown",
    "unresolved",
    "unknown",
  ]);
  assert.deepEqual(continuedFrom(db.path), [null, null, null, null, null, old.htmlUrl]);
});

test("已延续不进处置计数:旧那一轮的进度里不再有它", async () => {
  const { db } = await continueSecondRound();

  const store = openStore(db.path);
  const [second, first] = store.listRuns({ limit: 10 });
  store.close();
  // 旧那一轮的那条已经交接走,它既不算处置掉,也不该继续挂在待处置里。
  assert.deepEqual(
    { resolved: first!.resolved, fixed: first!.fixed, total: first!.total },
    { resolved: 0, fixed: 0, total: 0 },
  );
  // 要处置的是新位置那一条。
  assert.equal(second!.total, 1);
});

test("回填不把「已延续」读回处置:下一轮照样是已延续", async () => {
  const { repo, db, forge, deps } = await continueSecondRound();

  // 延续时旧评论已经在 Forge 上被 resolve,下一轮照样读回来。
  for (const comment of forge.existingComments) comment.resolved = true;
  forge.pullRequest.headSha = repo.pushToHead({
    "src/calc.js": SAME_LINE_CHANGE.replace("return a + b;", "return a + b + 0;"),
  });
  await runReview(EVENT, { ...deps, reviewers: SILENT });

  assert.equal(latestDispositions(db.path)[0], "continued", "回填把已延续读成了处置");
});

test("已延续的那条不再注入下一轮:同一个问题只在新位置上复核一次", async () => {
  const { repo, db, forge, deps } = await continueSecondRound();

  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({
    "src/calc.js": SAME_LINE_CHANGE.replace("return a + b;", "return a + b + 0;"),
  });
  const third = scriptedReviewer("model-b", []);
  await runReview(EVENT, { ...deps, reviewers: [third] });

  // 注入的只有新位置那条:旧行已经交接,再给一遍就是让模型复核同一个问题两次。
  const injected = third.calls[0]!.history;
  assert.equal(injected.length, 1);
  assert.equal(injected[0]!.id, Number(query(db.path, "SELECT id FROM finding ORDER BY id")[1]!["id"]));
});

/**
 * 历史注入与复核契约(ADR 0016,issue #165)。本阶段已经报过的 Finding 注入每个
 * Reviewer,Reviewer 回的复核结论逐条落库。裁决与自动处置见上一段。
 */

/** 本轮落库的复核结论,按落库顺序。 */
function verdictRows(dbPath: string): Record<string, unknown>[] {
  return query(
    dbPath,
    "SELECT run_id, model, finding_id, verdict, missing FROM finding_verdict ORDER BY rowid",
  );
}

/** 第一轮报两处:第 6 行进行级评论(可处置),第 11 行落在 diff 外只进正文。 */
const TWO_FINDINGS = [
  { ...FINDING, title: "减法多减一" },
  {
    ...FINDING,
    // -U3 的 hunk 覆盖 3..9 行,这一行同样锚得进去。
    line: 9,
    title: "收尾没校验",
    description: "mul 的函数头没有校验",
  },
];

test("下一轮把本阶段历史注入 Reviewer:未处置的带正文与备注,已处置的只占一行且不带操作人", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, { ...deps, reviewers: [scriptedReviewer("model-a", TWO_FINDINGS)] });
  // 人在面板上处置了行级那一条,并留了一句备注。备注要跟着注入,操作人不能跟着。
  disposeInPanel(db.path, forge.publishedComments[0]!.id, "resolved", "确认无影响");
  forge.existingComments.push(...asPublished(forge, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  const second = scriptedReviewer("model-b", []);
  await runReview(EVENT, { ...deps, reviewers: [second] });

  assert.deepEqual(second.calls[0]!.history, [
    // 已处置的只占一行:没有正文、严重度与分类,也没有操作人。
    {
      id: 1,
      file: "src/calc.js",
      line: 6,
      title: "减法多减一",
      disposition: "resolved",
      note: "确认无影响",
    },
    // 未处置的给全文:模型要据此判断这个问题还在不在。
    {
      id: 2,
      file: "src/calc.js",
      line: 9,
      title: "收尾没校验",
      disposition: "unknown",
      severity: "P0",
      category: "bug",
      description: "mul 的函数头没有校验",
    },
  ]);
});

test("历史对所有 Reviewer 共享,每一批拿到的是同一份", async () => {
  const { repo, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  const first = scriptedReviewer("model-b", []);
  const other = scriptedReviewer("model-c", []);
  await runReview(EVENT, { ...deps, reviewers: [first, other] });

  assert.equal(first.calls[0]!.history.length, 1);
  assert.deepEqual(first.calls[0]!.history, other.calls[0]!.history);
});

test("复核结论逐条落库,漏给的记为无法判断;时间流带本轮漏复核条数", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-b", [], { verdicts: [{ findingId: 1, verdict: "fixed" }] }),
      // 这个模型一条结论都没给:按无法判断落库,并计进漏复核。
      scriptedReviewer("model-c", []),
    ],
  });

  const rows = verdictRows(db.path);
  assert.deepEqual(
    rows.map((row) => ({
      model: row["model"],
      finding: Number(row["finding_id"]),
      verdict: row["verdict"],
      missing: Number(row["missing"]),
    })),
    [
      { model: "model-b", finding: 1, verdict: "fixed", missing: 0 },
      { model: "model-c", finding: 1, verdict: "unclear", missing: 1 },
    ],
  );
  // 两轮的结论各归各轮:第一轮没有历史可复核,一条都不该有。
  assert.deepEqual([...new Set(rows.map((row) => Number(row["run_id"])))], [2]);

  const store = openStore(db.path);
  const runs = store.listRuns({ limit: 10 });
  store.close();
  assert.equal(runs[0]!.missedVerdicts, 1);
  assert.equal(runs[1]!.missedVerdicts, 0);
});

test("已处置的历史不要结论:漏复核只数未处置的那些", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  disposeInPanel(db.path, forge.publishedComments[0]!.id, "resolved");
  forge.existingComments.push(...asPublished(forge, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, { ...deps, reviewers: [scriptedReviewer("model-b", [])] });

  assert.deepEqual(verdictRows(db.path), []);
});

test("全部 Reviewer 都失败的那一轮不落复核结论:它根本没跑,不是漏复核", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-b", [], { failure: "模型服务不可用" })],
  });

  assert.deepEqual(verdictRows(db.path), []);
});

test("范围审查与 PR 触发各注入自己阶段的历史", async () => {
  const { deps } = setup();

  // 范围审查那一档:轮次归在 range_review_id 名下(ADR 0012)。
  await runReview(EVENT, { ...deps, rangeReviewId: 1 });

  // PR 链路看不到范围审查阶段的历史:它们是两个审查阶段(CONTEXT.md 审查阶段)。
  const onPullRequest = scriptedReviewer("model-b", [
    { ...FINDING, line: OUT_OF_DIFF_LINE, description: "mul 的收尾没有校验" },
  ]);
  await runReview(EVENT, { ...deps, reviewers: [onPullRequest] });
  assert.deepEqual(onPullRequest.calls[0]!.history, []);

  // 范围审查的下一轮只看得到自己阶段报过的那条。
  const onRange = scriptedReviewer("model-c", []);
  await runReview(EVENT, { ...deps, reviewers: [onRange], rangeReviewId: 1 });
  assert.deepEqual(
    onRange.calls[0]!.history.map((entry) => ({ id: entry.id, line: entry.line })),
    [{ id: 1, line: 6 }],
  );
});
