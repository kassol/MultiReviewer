/**
 * 跨轮次的 Finding 匹配与折叠(issue #7),以及本阶段历史的注入与复核结论落库(ADR 0016,
 * issue #165)。上一轮发布出去的行级评论按锚点认回来:同一处不重发、折叠段里交代它此前
 * 被怎么处置;正文里的锚点与行级评论的锚点一样算数。公用夹具在 `support/cross-run.ts`,
 * 复核裁决、自动处置与延续那两段在 `cross-run-disposition.test.ts`(issue #399)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { query } from "./support/batch-run.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";
import {
  ANCHOR,
  asPublished,
  disposeInPanel,
  DISTANT_CHANGE,
  EVENT,
  FINDING,
  latestDispositions,
  OUT_OF_DIFF_LINE,
  SAME_LINE_CHANGE,
  setup,
  UNRELATED_CHANGE,
} from "./support/cross-run.ts";

test("代码未变且上一轮已处置:本轮不发行级评论,折叠段里标注曾被处置", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, true));
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
  forge.existingComments.push(...asPublished(forge, true));
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
  forge.existingComments.push(...asPublished(forge, false));
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
  forge.existingComments.push(...asPublished(forge, true));
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
  forge.existingComments.push(...asPublished(forge, false));
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
  forge.existingComments.push(...asPublished(forge, false));
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

test("偏移命中折叠的那条落库沿用历史行的指纹:轨迹折叠数与阶段汇总一致", async () => {
  const { repo, db, forge, deps } = setup();

  await runReview(EVENT, deps);
  // 喂回 Forge 给的那几个评论 id(`asPublished`):Finding Identity 的键是承载它的那条
  // 评论(ADR 0030),折叠上去的那一行记的必须是同一个 id,汇总才把两轮算成一条。
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  // 指纹在 ±3 偏移处命中(issue #264):折叠这件事已经判定,落库的指纹要与被折叠到的
  // 历史行相同,否则阶段汇总按「文件 + 指纹」归并时把它判成新报。
  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-a", [{ ...FINDING, line: 3 }])],
  });

  const fingerprints = query(db.path, "SELECT fingerprint FROM finding ORDER BY id").map(
    (row) => row["fingerprint"],
  );
  assert.equal(fingerprints.length, 2);
  assert.equal(fingerprints[1], fingerprints[0], "折叠命中的行落了与历史行不同的指纹");

  const store = openStore(db.path);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    const folded = store.listTrace(runId).filter((event) => event.kind === "finding_folded");
    const summary = store.stageSummary({ owner: EVENT.owner, repo: EVENT.repo, pullNumber: 7 });
    const latest = summary.timeline.find((entry) => entry.runId === runId)!;
    assert.equal(folded.length, 1);
    assert.equal(latest.folded, folded.length, "时间线的折叠数与轨迹 finding_folded 条数不一致");
    assert.equal(latest.reported, 0);
    assert.equal(summary.findings.length, 1, "折叠命中的行在阶段汇总里占了新的 Identity");
  } finally {
    store.close();
  }
});

test("行号相差超过 3 行时不匹配,按新 Finding 提出", async () => {
  const { repo, forge, deps } = setup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));
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
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  // 第二轮折叠,不发新评论,处置的载体仍是第一轮那条。
  assert.deepEqual(forge.createdReviews[1]!.comments, []);
  const latest = query(
    db.path,
    "SELECT comment_id, comment_html_url FROM finding ORDER BY id",
  ).at(-1)!;
  const published = forge.publishedComments[0]!;
  assert.equal(latest["comment_id"], published.id);
  assert.equal(latest["comment_html_url"], published.htmlUrl);
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

test("复核结论逐条落库,漏给的记为无法判断", async () => {
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
