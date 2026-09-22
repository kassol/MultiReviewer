/**
 * 复核裁决与「已修复」自动处置(ADR 0016,issue #166),以及延续(CONTEXT.md 已延续,
 * issue #167)。同一条历史 Finding 的最终结论由本轮全部 Reviewer 的复核结论合成,处置
 * 元数据随 Finding Identity 走。公用夹具在 `support/cross-run.ts`,跨轮匹配与折叠那一段在
 * `cross-run.test.ts`(issue #399)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reviewer } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store/index.ts";
import { makeCacheDir, makeDbPath, makeRepo, testCleanups } from "./support/git-fixture.ts";
import { query } from "./support/batch-run.ts";
import {
  memoryForge,
  scriptedReviewer,
  verdictReviewer,
  type MemoryForge,
} from "./support/memory-forge.ts";
import {
  ANCHOR,
  asPublished,
  dispositionMarks,
  disposeInPanel,
  DISPOSED_AT,
  DISTANT_CHANGE,
  EVENT,
  FINDING,
  HEAD,
  latestDispositions,
  OUT_OF_DIFF_LINE,
  SAME_LINE_CHANGE,
  setup,
  SILENT,
  UNRELATED_CHANGE,
} from "./support/cross-run.ts";

/**
 * 复核裁决与「已修复」自动处置(ADR 0016,issue #166)。一条历史 Finding 的最终结论由
 * 本轮全部 Reviewer 的复核结论合成:任一判仍在则仍在,否则全部判已修才是已修。指纹
 * 不再单独构成证据——它变没变都不改变裁决。
 */

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
  const first = (await store.listRuns({ limit: 10 })).at(-1)!;
  await store.close();
  assert.deepEqual(
    { resolved: first.resolved, fixed: first.fixed, total: first.total },
    { resolved: 0, fixed: 1, total: 1 },
  );
});

/**
 * 同一条 Finding Identity 上的两条 Finding(issue #275)。第 6、7 行的指纹窗口去掉空行
 * 之后逐字相同,两条因此同文件同指纹;同一个模型报的相邻两条不合并(行距那道判据只
 * 对跨模型开放),各发一条行级评论。
 */
const TWIN_BASE = [
  "export const rate = 1;",
  "",
  "",
  "export function fee(amount) {",
  "  const base = amount * rate;",
  "  const net = base - 1;",
  "  return net;",
  "}",
  "",
  "",
  "export const tail = 0;",
  "",
].join("\n");

/** 第一轮的 head:改第 5 行,-U3 的 hunk 覆盖 2..8 行,两条 Finding 都落在 diff 里。 */
const TWIN_HEAD = TWIN_BASE.replace("amount * rate;", "amount * rate * 2;");

/** 第二轮的 head:改文件开头,第 6、7 行那扇窗口原样不动。 */
const TWIN_NEXT = TWIN_HEAD.replace("export const rate = 1;", "export const rate = 3;");

function twinSetup() {
  const repo = makeRepo({ base: { "src/fee.js": TWIN_BASE }, head: { "src/fee.js": TWIN_HEAD } });
  const cache = makeCacheDir();
  const db = makeDbPath();
  testCleanups().push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/fee.js", status: "modified" }],
  });

  const deps = {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        { file: "src/fee.js", line: 6, severity: "P0" as const, category: "bug" as const, description: "net 少算了 1" },
        { file: "src/fee.js", line: 7, severity: "P1" as const, category: "bug" as const, description: "返回值没有按分取整" },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
  };

  return { repo, db, forge, deps };
}

/** 跑第一轮、把两条评论按未处置喂回 Forge,并推进 head。返回第二轮开跑前的现场。 */
async function twinFirstRound(): Promise<{
  db: { path: string };
  forge: MemoryForge;
  deps: ReturnType<typeof twinSetup>["deps"];
  rows: Record<string, unknown>[];
}> {
  const { repo, db, forge, deps } = twinSetup();

  await runReview(EVENT, deps);
  forge.existingComments.push(...asPublished(forge, false));

  const rows = query(db.path, "SELECT id, line, fingerprint, comment_id FROM finding ORDER BY id");
  assert.equal(rows.length, 2, "两条 Finding 该各落一行");
  assert.equal(rows[0]!["fingerprint"], rows[1]!["fingerprint"], "夹具没造出同指纹的两条");
  assert.notEqual(rows[0]!["comment_id"], rows[1]!["comment_id"], "两条该各带一条评论");

  forge.pullRequest.headSha = repo.pushToHead({ "src/fee.js": TWIN_NEXT });
  return { db, forge, deps, rows };
}

test("同一条 Identity 上的两条 Finding 各带一条评论:判已修时两条评论都 resolve、两行都记已修复", async () => {
  const { db, forge, deps, rows } = await twinFirstRound();

  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });

  assert.deepEqual(
    [...forge.resolvedIds].sort(),
    rows.map((row) => String(row["comment_id"])).sort(),
    "只 resolve 了折叠出来的代表条,另一条评论留在了 Forge 上",
  );
  assert.deepEqual(latestDispositions(db.path), ["fixed", "fixed"]);
});

test("同一条 Identity 里一条写 Forge 失败:只有写成的那一行记已修复,另一行保持未处置", async () => {
  const { db, forge, deps, rows } = await twinFirstRound();
  const stuck = String(rows[0]!["comment_id"]);
  const resolveComment = forge.forge.resolveComment;
  forge.forge.resolveComment = async (ref, commentId) => {
    if (commentId === stuck) throw new Error("resolve 挂了");
    await resolveComment(ref, commentId);
  };

  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-a", "fixed")] });

  assert.deepEqual(forge.resolvedIds, [String(rows[1]!["comment_id"])]);
  assert.deepEqual(latestDispositions(db.path), ["unresolved", "fixed"]);
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
  await disposeInPanel(db.path, forge.publishedComments[0]!.id, "unresolved");
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
  await disposeInPanel(db.path, forge.publishedComments[0]!.id, "resolved", "确认无影响");
  forge.existingComments.push(...asPublished(forge, true));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": UNRELATED_CHANGE });

  await runReview(EVENT, deps);

  assert.deepEqual(forge.createdReviews[1]!.comments, [], "这一轮该折叠到历史评论上");
  // 面板读的是本轮那一行:处置的载体是评论,同一条评论名下的历史行与本轮新行说的
  // 是同一次处置,备注与署名不该只活在上一轮那一行上。
  const store = openStore(db.path);
  const latest = (await store.listRuns({ limit: 10 }))[0]!;
  await store.close();
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
  await disposeInPanel(db.path, forge.publishedComments[0]!.id, "unresolved");
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
  await disposeInPanel(db.path, old.id, "resolved", "确认无影响");
  await disposeInPanel(db.path, old.id, "unresolved");
  forge.existingComments.push(...asPublished(forge, false));
  forge.pullRequest.headSha = repo.pushToHead({ "src/calc.js": SAME_LINE_CHANGE });

  await runReview(EVENT, { ...deps, reviewers: continuing() });

  const store = openStore(db.path);
  const latest = (await store.listRuns({ limit: 10 }))[0]!;
  await store.close();
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
  const [second, first] = await store.listRuns({ limit: 10 });
  await store.close();
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

