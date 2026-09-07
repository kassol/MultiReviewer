/**
 * 恢复已有评审记录里缺失的影响与修改建议(issue #268)。
 *
 * 夹具由真实的 `runReview` 落出来:三轮(可加到四轮)Review Run 留下成功上报的轨迹、被拒的
 * 上报、同一模型对同一段问题两次内容不同的上报、折叠到旧评论上的行,以及按复核结论合成的
 * 延续;之后把两列抹回 NULL、清掉历史说法,模拟升级前落的库。断言打在恢复核心的计划与
 * 写入,以及 CLI 进程边界上。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ReviewerEvent } from "../src/review/finding.ts";
import { applyRecovery, commentSections, planRecovery } from "../src/review/recover.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer, verdictReviewer } from "./support/memory-forge.ts";

const CLI = fileURLToPath(new URL("../src/recover-finding-content.ts", import.meta.url));
const run = promisify(execFile);

const BASE_CALC = `export function add(a: number, b: number) {
  return a + b;
}

export function sub(a: number, b: number) {
  return a - b;
}
`;
const HEAD_CALC = BASE_CALC.replace("return a - b;", "return a - b - 1;");
const BASE_UTIL = `export function clamp(n: number) {
  return n;
}
`;
const HEAD_UTIL = BASE_UTIL.replace("return n;", "return Math.max(0, n);");

const EVENT = { owner: "acme", repo: "widgets", number: 7 };
const REPO = { kind: "repo", owner: "acme", repo: "widgets" } as const;

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type Said = {
  file: string;
  line: number;
  title: string;
  description: string;
  impact: string;
  suggestion: string;
};

const A: Said = {
  file: "src/calc.ts",
  line: 6,
  title: "sub 多减了 1",
  description: "sub() 多减了 1。",
  impact: "差值都错。",
  suggestion: "去掉 - 1。",
};
const B: Said = {
  ...A,
  title: "sub 算错",
  description: "减法结果不对。",
  impact: "",
  suggestion: "改成 a - b。",
};
/** 同一模型对同一段问题表述的第二条归属:标题与建议不同,合并时不折叠,轨迹上因此有两次不同的上报。 */
const B2: Said = { ...B, title: "sub 结果错", suggestion: "用 a - b。" };
/** 建议跨几个段落、中间有一行粗体:原评论里读回来必须逐字一样。 */
const C: Said = {
  ...A,
  title: "sub 少了",
  description: "sub 少了。",
  impact: "余额错。",
  suggestion: "删掉 - 1。\n\n**边界处理**\n\n空数组直接返回 0。",
};
const U: Said = {
  file: "src/util.ts",
  line: 2,
  title: "clamp 没有上限",
  description: "clamp 只截了下限。",
  impact: "工具函数出错。",
  suggestion: "加上限校验。",
};
/** 位置复核者在同一轮对同一段问题表述另报的一条:标题不相似,不会被词法配对成延续。 */
const D_ALONGSIDE: Said = {
  ...A,
  title: "完全不相干的标题",
  impact: "本轮新影响。",
  suggestion: "本轮新建议。",
};

/** 一次 `report_finding` 调用进轨迹的样子;`isError` 为真即被拒的那次。 */
function reported(said: Said, isError = false): ReviewerEvent {
  return {
    kind: "tool_call",
    tool: "report_finding",
    args: { ...said, snippet: "x", severity: "P0", category: "bug" },
    durationMs: 1,
    isError,
    error: isError ? "锚不上" : null,
    resultLength: 8,
  };
}

function finding(said: Said) {
  return { ...said, severity: "P0" as const, category: "bug" as const };
}

function sql<T = Record<string, unknown>>(dbPath: string, query: string): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all() as unknown as T[];
  } finally {
    db.close();
  }
}

function exec(dbPath: string, statement: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(statement).run(...params);
  } finally {
    db.close();
  }
}

type SeedOptions = {
  /** 留下历史说法的行但抹掉两列,给「已有的补齐」那条路用;默认整表删掉。 */
  keepCarriedRows?: boolean;
  /** 第四轮:再改写一次,由 model-e 只给位置——连续两次延续。 */
  continueAgain?: boolean;
  /** 第三轮的位置复核者另报一条同一段问题表述、标题不相似的 Finding,带轨迹。 */
  reportAlongside?: boolean;
};

/**
 * 三轮之后抹掉两列、清掉历史说法:
 *
 * - 第一轮:calc 第 6 行由 a / b / c 三个模型合成一条(a 有唯一成功上报外加一次被拒的;
 *   b 对同一段问题表述报了两条、两次成功上报内容不同;c 没有轨迹),util 第 2 行由 c 报出
 *   并有轨迹。
 * - 第二轮(同一 head):c 换了建议重报 util,折叠到第一轮那条评论上,没有轨迹。
 * - 第三轮(calc 第 6 行改写):d 只给位置,合成延续。
 */
async function seedLegacy(options: SeedOptions = {}) {
  const repo = makeRepo({
    base: { "src/calc.ts": BASE_CALC, "src/util.ts": BASE_UTIL },
    head: { "src/calc.ts": HEAD_CALC, "src/util.ts": HEAD_UTIL },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);
  const forge = memoryForge({
    pullRequest: {
      number: EVENT.number,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [
      { path: "src/calc.ts", status: "modified" },
      { path: "src/util.ts", status: "modified" },
    ],
  });
  const deps = { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path };
  const feedBack = (): void => {
    forge.existingComments.length = 0;
    forge.existingComments.push(
      ...forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
    );
  };
  const rewrite = (step: number): void => {
    forge.pullRequest.headSha = repo.commitToBranch("feature", {
      "src/calc.ts": HEAD_CALC.replace("return a - b - 1;", `return a - b - ${step};`),
      "src/util.ts": HEAD_UTIL,
    });
  };

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-a", [finding(A)], {
        events: [reported({ ...A, suggestion: "被拒的那次说的" }, true), reported(A)],
      }),
      scriptedReviewer("model-b", [finding(B), finding(B2)], {
        events: [reported(B), reported(B2)],
      }),
      scriptedReviewer("model-c", [finding(C), finding(U)], { events: [reported(U)] }),
    ],
  });
  feedBack();
  await runReview(EVENT, {
    ...deps,
    reviewers: [scriptedReviewer("model-c", [finding({ ...U, suggestion: "换个写法。" })])],
  });
  feedBack();
  rewrite(2);
  await runReview(EVENT, {
    ...deps,
    reviewers: [
      options.reportAlongside
        ? verdictReviewer("model-d", "present", [finding(D_ALONGSIDE)], 6, {
            events: [reported(D_ALONGSIDE)],
          })
        : verdictReviewer("model-d", "present", [], 6),
    ],
  });
  feedBack();
  if (options.continueAgain) {
    rewrite(3);
    await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-e", "present", [], 6)] });
    feedBack();
  }

  legacyComments(db.path, forge.existingComments);
  exec(db.path, "UPDATE finding_attribution SET impact = NULL, suggestion = NULL");
  exec(
    db.path,
    options.keepCarriedRows
      ? "UPDATE finding_carried_attribution SET impact = NULL, suggestion = NULL"
      : "DELETE FROM finding_carried_attribution",
  );
  return { db, forge };
}

/**
 * 把评论正文改写回逐归属分段的老形状(issue #278 之前的格式):标题行,每个归属一段带
 * 模型标识,再是承接段与锚点。恢复操作要认的原评论就是那时发出去的——现在的正文只有一份
 * 代表段,里面没有各模型原文可读,夹具因此要还原成它面对的那种正文。
 */
function legacyComments(
  dbPath: string,
  comments: { id: string; body: string }[],
): void {
  const saids = sql<{
    comment_id: string;
    model: string;
    description: string;
    impact: string | null;
    suggestion: string | null;
  }>(
    dbPath,
    `SELECT f.comment_id AS comment_id, a.model AS model, a.description AS description,
            a.impact AS impact, a.suggestion AS suggestion
       FROM finding f JOIN finding_attribution a ON a.finding_id = f.id
      WHERE f.comment_id IS NOT NULL
      ORDER BY f.id, a.position`,
  );
  const byComment = new Map<string, typeof saids>();
  for (const said of saids) {
    const list = byComment.get(said.comment_id) ?? [];
    list.push(said);
    byComment.set(said.comment_id, list);
  }
  for (const comment of comments) {
    const list = byComment.get(comment.id);
    if (list === undefined) continue;
    const blocks = comment.body.split("\n\n");
    const rest = blocks.slice(1);
    // 代表段那几段换成逐归属的段;承接段之后的部分(延续说明、锚点)原样留着,归属那一行去掉。
    const cut = rest.findIndex(
      (block) => block.startsWith("**沿用 ") || block.startsWith("延续自 ") || block.startsWith("由 "),
    );
    const tail = rest.slice(cut).filter((block) => !block.startsWith("由 "));
    const sections = list.flatMap((said) => {
      const parts = [`**${said.model}**`, `**问题**:${said.description}`];
      if (said.impact !== null && said.impact !== "") parts.push(`**影响**:${said.impact}`);
      if (said.suggestion !== null && said.suggestion !== "") {
        parts.push(`**建议**:${said.suggestion}`);
      }
      return parts;
    });
    comment.body = [blocks[0]!, ...sections, ...tail].join("\n\n");
  }
}

type Row = { id: number; run_id: number; file: string; title: string; model: string; position: number };

/** 库里的归属行,按 finding id 与位置排,断言据此对号。 */
function rows(dbPath: string): Row[] {
  return sql<Row>(
    dbPath,
    `SELECT f.id AS id, f.run_id AS run_id, f.file AS file, f.title AS title,
            a.model AS model, a.position AS position
       FROM finding_attribution a JOIN finding f ON f.id = a.finding_id
      ORDER BY f.id, a.position`,
  );
}

function at(all: Row[], runId: number, file: string, model: string, nth = 0): Row {
  const row = all.filter((r) => r.run_id === runId && r.file === file && r.model === model)[nth];
  assert.notEqual(row, undefined, `第 ${runId} 轮 ${file} 没有 ${model} 的第 ${nth + 1} 条归属`);
  return row!;
}

function setSaid(dbPath: string, row: Row, said: { impact: string | null; suggestion: string | null }): void {
  exec(
    dbPath,
    "UPDATE finding_attribution SET impact = ?, suggestion = ? WHERE finding_id = ? AND position = ?",
    said.impact,
    said.suggestion,
    row.id,
    row.position,
  );
}

async function preview(
  dbPath: string,
  scope: Parameters<typeof planRecovery>[1] = REPO,
  comments?: Parameters<typeof planRecovery>[2],
) {
  const readOnly = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return await planRecovery(readOnly, scope, comments);
  } finally {
    readOnly.close();
  }
}

async function apply(
  dbPath: string,
  scope: Parameters<typeof planRecovery>[1] = REPO,
  comments?: Parameters<typeof planRecovery>[2],
) {
  const writable = new DatabaseSync(dbPath);
  try {
    const plan = await planRecovery(writable, scope, comments);
    applyRecovery(writable, plan);
    return plan;
  } finally {
    writable.close();
  }
}

const CONFLICT = "同一轮该模型对这段问题有 2 次内容不同的成功上报,对不上是哪一次";
const FOLDED = "轨迹里没有这次上报,这一行是折叠到旧评论上的,旧评论不是它的原文";

test("预览只读库:轨迹唯一匹配才补,两次不同上报与折叠行跳过,延续从上一处抄历史说法", async () => {
  const { db } = await seedLegacy();
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const b1 = at(all, 1, "src/calc.ts", "model-b");
  const b2 = at(all, 1, "src/calc.ts", "model-b", 1);
  const c1 = at(all, 1, "src/calc.ts", "model-c");
  const u1 = at(all, 1, "src/util.ts", "model-c");
  const u2 = at(all, 2, "src/util.ts", "model-c");
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  const before = sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NULL");

  const plan = await preview(db.path);

  assert.equal(plan.runs, 3);
  assert.equal(plan.attributions, 7);
  assert.deepEqual(
    plan.fills.map((fill) => [fill.findingId, fill.model, fill.source, fill.impact, fill.suggestion]),
    [
      [a1.id, "model-a", "trace", A.impact, A.suggestion],
      [u1.id, "model-c", "trace", U.impact, U.suggestion],
      [d3.id, "model-d", "continuation", "", ""],
    ],
  );
  // 每条补回都带回查凭据:轨迹事件的序号、延续事件的序号。
  assert.match(plan.fills[0]!.evidence, /^轨迹 seq \d+$/);
  assert.match(plan.fills[2]!.evidence, /^延续事件 seq \d+$/);
  assert.deepEqual(
    plan.skips.map((skip) => [skip.findingId, skip.model, skip.reason]),
    [
      [b1.id, "model-b", CONFLICT],
      [b2.id, "model-b", CONFLICT],
      [c1.id, "model-c", "轨迹里没有这次上报,没配 Forge 凭据读不到原评论"],
      [u2.id, "model-c", FOLDED],
    ],
  );
  // 延续那一行从第一轮那条抄四段:a 用的是这份计划里补回的值,b 与 c 还缺着就照实为 null。
  assert.deepEqual(
    plan.carriedInserts.map((insert) => [
      insert.findingId,
      insert.predecessorId,
      insert.rows.map((row) => [row.model, row.runId, row.description, row.impact, row.suggestion]),
    ]),
    [
      [
        d3.id,
        a1.id,
        [
          ["model-a", 1, A.description, A.impact, A.suggestion],
          ["model-b", 1, B.description, null, null],
          ["model-b", 1, B2.description, null, null],
          ["model-c", 1, C.description, null, null],
        ],
      ],
    ],
  );
  assert.deepEqual(plan.carriedFills, []);
  assert.deepEqual(plan.carriedSkips, []);
  assert.deepEqual(plan.carriedUnrecoverable, []);
  // 预览一个字都没写。
  assert.deepEqual(
    sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NULL"),
    before,
  );
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 0);
});

test("原评论只认这一行自己发出去的那条,多段落建议逐字读回;折叠上去的行不拿旧评论当原文", async () => {
  const { db, forge } = await seedLegacy();
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const c1 = at(all, 1, "src/calc.ts", "model-c");
  const u2 = at(all, 2, "src/util.ts", "model-c");

  const plan = await preview(db.path, REPO, (ref) => forge.forge.listReviewComments(ref));

  const fromComment = plan.fills.filter((fill) => fill.source === "comment");
  assert.deepEqual(
    fromComment.map((fill) => [fill.findingId, fill.model, fill.impact, fill.suggestion]),
    [[c1.id, "model-c", C.impact, C.suggestion]],
  );
  assert.match(fromComment[0]!.evidence, /^原评论 comment-\d+$/);
  // 轨迹唯一的那条也拿原评论比对过,两处一致就都列进凭据。
  const traced = plan.fills.find((fill) => fill.findingId === a1.id && fill.model === "model-a")!;
  assert.match(traced.evidence, /^轨迹 seq \d+;原评论 comment-\d+$/);
  assert.ok(
    plan.skips.some((skip) => skip.findingId === u2.id && skip.reason === FOLDED),
    "折叠行不该拿旧评论补",
  );
  // 延续那一行抄到的 c 那段跟着这份计划一起补上。
  const carried = plan.carriedInserts[0]!.rows.find((row) => row.model === "model-c")!;
  assert.deepEqual([carried.impact, carried.suggestion], [C.impact, C.suggestion]);
});

test("轨迹与可确认的原评论说的不一样时跳过,不拿轨迹单方面补", async () => {
  const { db, forge } = await seedLegacy();
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  // 原评论里 a 的建议被改成另一句(比如有人在 Forge 上编辑过):与轨迹矛盾。
  const comment = forge.existingComments.find((entry) => entry.body.includes(A.suggestion))!;
  comment.body = comment.body.replace(A.suggestion, "评论里的另一句建议。");

  const plan = await preview(db.path, REPO, (ref) => forge.forge.listReviewComments(ref));

  assert.equal(plan.fills.some((fill) => fill.findingId === a1.id && fill.model === "model-a"), false);
  const skip = plan.skips.find((entry) => entry.findingId === a1.id && entry.model === "model-a")!;
  assert.match(
    skip.reason,
    /^来源矛盾:轨迹 seq \d+说「差值都错。」\/「去掉 - 1。」,原评论 comment-\d+说「差值都错。」\/「评论里的另一句建议。」$/,
  );
  // 矛盾那条没补,延续那一行抄到的这一段也照实为 null。
  const carried = plan.carriedInserts[0]!.rows.find((row) => row.model === "model-a")!;
  assert.deepEqual([carried.impact, carried.suggestion], [null, null]);
});

test("执行只补 NULL:已有的与候选相同才补另一格,不同即跳过;面板读得回;重复执行没有第二份副作用", async () => {
  const { db, forge } = await seedLegacy();
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const u1 = at(all, 1, "src/util.ts", "model-c");
  const u2 = at(all, 2, "src/util.ts", "model-c");
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  // a 的影响已经有了、与轨迹说的一样:只补还缺的建议。u 的影响已经有了、与轨迹说的不一样:
  // 两格都不动,不拼一个来源的影响加另一个来源的建议。
  setSaid(db.path, a1, { impact: A.impact, suggestion: null });
  setSaid(db.path, u1, { impact: "手工改过的影响", suggestion: null });
  const comments = (ref: Parameters<typeof forge.forge.listReviewComments>[0]) =>
    forge.forge.listReviewComments(ref);

  await apply(db.path, REPO, comments);
  const again = await apply(db.path, REPO, comments);

  // 第二遍没有可补的:剩下的只是仍然对不上来源、或与已有内容矛盾的那几条。
  assert.deepEqual(again.fills, []);
  assert.deepEqual(again.carriedInserts, []);
  assert.deepEqual(again.carriedFills, []);
  assert.deepEqual(
    again.skips.map((skip) => [skip.findingId, skip.model, skip.reason.replace(/seq \d+/, "seq N")]),
    [
      [a1.id, "model-b", CONFLICT],
      [a1.id, "model-b", CONFLICT],
      [u1.id, "model-c", "轨迹 seq N给出的影响与这一行已有的影响不一致,不拼混合内容"],
      [u2.id, "model-c", FOLDED],
    ],
  );

  const store = openStore(db.path);
  const runs = store.listRuns({ limit: 10 }).sort((x, y) => x.id - y.id);
  store.close();
  const first = runs[0]!.findings.find((entry) => entry.file === "src/calc.ts")!;
  assert.deepEqual(
    first.attributions.map((said) => [said.model, said.impact, said.suggestion]),
    [
      ["model-a", A.impact, A.suggestion],
      ["model-b", null, null],
      ["model-b", null, null],
      ["model-c", C.impact, C.suggestion],
    ],
  );
  const util = runs[0]!.findings.find((entry) => entry.file === "src/util.ts")!;
  assert.deepEqual(
    util.attributions.map((said) => [said.impact, said.suggestion]),
    [["手工改过的影响", null]],
  );
  assert.deepEqual(
    runs[1]!.findings[0]!.attributions.map((said) => [said.impact, said.suggestion]),
    [[null, null]],
  );
  const continued = runs[2]!.findings.find((entry) => entry.id === d3.id)!;
  assert.deepEqual(continued.attributions.map((said) => [said.impact, said.suggestion]), [["", ""]]);
  assert.deepEqual(
    continued.carried.map((row) => [row.model, row.runId, row.headSha, row.impact, row.suggestion]),
    [
      ["model-a", 1, runs[0]!.headSha, A.impact, A.suggestion],
      ["model-b", 1, runs[0]!.headSha, null, null],
      ["model-b", 1, runs[0]!.headSha, null, null],
      ["model-c", 1, runs[0]!.headSha, C.impact, C.suggestion],
    ],
  );
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 4);
});

test("连续两次延续:第二次从第一次抄,出处仍是最初那一轮;已有历史说法的补齐只认唯一对上的一段", async () => {
  const { db } = await seedLegacy({ continueAgain: true, keepCarriedRows: true });
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const b1 = at(all, 1, "src/calc.ts", "model-b");
  const b2 = at(all, 1, "src/calc.ts", "model-b", 1);
  const c1 = at(all, 1, "src/calc.ts", "model-c");
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  const e4 = at(all, 4, "src/calc.ts", "model-e");
  // 上一处 b 的两条归属内容已知且不同;c 的已知;a 由轨迹补。两条延续各四段、两列都是 NULL,
  // 只有第四轮 a 那段的影响已被人写过、且与第三轮那段说的不一样。
  setSaid(db.path, b1, { impact: B.impact, suggestion: B.suggestion });
  setSaid(db.path, b2, { impact: B2.impact, suggestion: B2.suggestion });
  setSaid(db.path, c1, { impact: C.impact, suggestion: C.suggestion });
  exec(
    db.path,
    "UPDATE finding_carried_attribution SET impact = ? WHERE finding_id = ? AND position = 0",
    "别人写的影响",
    e4.id,
  );

  const plan = await preview(db.path);

  assert.deepEqual(
    plan.fills.map((fill) => [fill.findingId, fill.model, fill.source]),
    [
      [a1.id, "model-a", "trace"],
      [at(all, 1, "src/util.ts", "model-c").id, "model-c", "trace"],
      [d3.id, "model-d", "continuation"],
      [e4.id, "model-e", "continuation"],
    ],
  );
  assert.deepEqual(plan.carriedInserts, []);
  // 第三轮:a 与 c 各唯一对上,补齐;b 两段分不清,跳过并说明。
  // 第四轮从第三轮补齐之后的结果抄:c 那段补上,出处仍是第一轮;a 那段已有的影响与第三轮
  // 说的不一样,跳过;b 在第三轮没补,这里也没有。
  assert.deepEqual(
    plan.carriedFills.map((fill) => [fill.findingId, fill.position, fill.predecessorId, fill.impact, fill.suggestion]),
    [
      [d3.id, 0, a1.id, A.impact, A.suggestion],
      [d3.id, 3, a1.id, C.impact, C.suggestion],
      [e4.id, 3, d3.id, C.impact, C.suggestion],
    ],
  );
  assert.deepEqual(
    plan.carriedSkips.map((skip) => [skip.findingId, skip.position, skip.model, skip.reason]),
    [
      [d3.id, 1, "model-b", `上一处(finding ${a1.id})该模型对这段问题有 2 段内容不同的说法,对不上是哪一段`],
      [d3.id, 2, "model-b", `上一处(finding ${a1.id})该模型对这段问题有 2 段内容不同的说法,对不上是哪一段`],
      [e4.id, 0, "model-a", `上一处(finding ${d3.id})的影响与这一段已有的影响不一致,不拼混合内容`],
    ],
  );
  // 第四轮那四段的出处都是第一轮,没有第三轮那个只给了位置的模型。
  assert.deepEqual(
    sql(db.path, `SELECT model, run_id FROM finding_carried_attribution WHERE finding_id = ${e4.id} ORDER BY position`)
      .map((row) => [row["model"], row["run_id"]]),
    [["model-a", 1], ["model-b", 1], ["model-b", 1], ["model-c", 1]],
  );
});

test("只恢复末轮时不从范围外、尚未恢复的上一处导历史说法;之后整仓库恢复不把位置复核者当原作者", async () => {
  const { db } = await seedLegacy({ continueAgain: true });
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  const e4 = at(all, 4, "src/calc.ts", "model-e");

  const lastOnly = await apply(db.path, { kind: "run", runId: e4.run_id });

  assert.deepEqual(
    lastOnly.fills.map((fill) => [fill.findingId, fill.source, fill.impact, fill.suggestion]),
    [[e4.id, "continuation", "", ""]],
  );
  assert.deepEqual(lastOnly.carriedInserts, []);
  assert.deepEqual(
    lastOnly.carriedUnrecoverable.map((entry) => [entry.findingId, entry.reason]),
    [[e4.id, `上一处(finding ${d3.id},第 ${d3.run_id} 轮)不在本次范围里,它自己的历史说法还没恢复;先把那一轮或整个仓库一起恢复`]],
  );
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 0);

  const whole = await apply(db.path);

  assert.deepEqual(
    whole.carriedInserts.map((insert) => [insert.findingId, insert.predecessorId, insert.rows.map((row) => `${row.model}@${row.runId}`)]),
    [
      [d3.id, a1.id, ["model-a@1", "model-b@1", "model-b@1", "model-c@1"]],
      [e4.id, d3.id, ["model-a@1", "model-b@1", "model-b@1", "model-c@1"]],
    ],
  );
  const store = openStore(db.path);
  const last = store.listRuns({ limit: 1, id: e4.run_id })[0]!.findings.find((entry) => entry.id === e4.id)!;
  store.close();
  assert.deepEqual(
    last.carried.map((row) => [row.model, row.runId, row.impact, row.suggestion]),
    [
      ["model-a", 1, A.impact, A.suggestion],
      ["model-b", 1, null, null],
      ["model-b", 1, null, null],
      ["model-c", 1, null, null],
    ],
  );
});

test("合成的那一行自己的归属只能是两段空:同轮同模型对同一段问题的另一次上报不算它的", async () => {
  const { db } = await seedLegacy({ reportAlongside: true });
  const all = rows(db.path);
  const synthesized = all.find((row) => row.run_id === 3 && row.model === "model-d" && row.title === A.title)!;
  const alongside = all.find((row) => row.run_id === 3 && row.model === "model-d" && row.title === D_ALONGSIDE.title)!;
  assert.notEqual(synthesized, undefined);
  assert.notEqual(alongside, undefined);

  const plan = await preview(db.path);

  const bySynthesized = plan.fills.find((fill) => fill.findingId === synthesized.id)!;
  assert.deepEqual([bySynthesized.source, bySynthesized.impact, bySynthesized.suggestion], ["continuation", "", ""]);
  const byAlongside = plan.fills.find((fill) => fill.findingId === alongside.id)!;
  assert.deepEqual(
    [byAlongside.source, byAlongside.impact, byAlongside.suggestion],
    ["trace", D_ALONGSIDE.impact, D_ALONGSIDE.suggestion],
  );
});

test("有延续关系却没有延续事件的行不推断:归属跳过并说明,历史说法列为恢复不了", async () => {
  const { db } = await seedLegacy();
  const all = rows(db.path);
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  exec(db.path, "DELETE FROM review_trace WHERE run_id = ? AND kind = 'finding_continued'", d3.run_id);

  const plan = await preview(db.path);

  assert.equal(plan.fills.some((fill) => fill.findingId === d3.id), false);
  const reason = "这一行承接了旧位置,但轨迹没记延续事件或判据(2026-09-04 前的轮次),分不清是按复核结论合成的还是本轮重报的,不推断";
  assert.deepEqual(
    plan.skips.filter((skip) => skip.findingId === d3.id).map((skip) => skip.reason),
    [reason],
  );
  assert.deepEqual(plan.carriedInserts, []);
  assert.deepEqual(
    plan.carriedUnrecoverable.map((entry) => [entry.findingId, entry.reason]),
    [[d3.id, reason]],
  );
});

test("评论正文保守解析:标签先认、模型标题只认已知模型,正文里的粗体行与围栏代码照原样,拆不开就不给", () => {
  const a = { model: "model-a", description: "第一段。\n\n还有第二段。" };
  const section = (body: string[], attributions: { model: string; description: string }[] = [a]) =>
    commentSections(body.join("\n\n"), attributions);
  assert.deepEqual(
    section([
      "**[P0] sub 多减了 1**",
      "**model-a**",
      "**问题**:第一段。",
      "还有第二段。",
      "**影响**:差值都错。",
      "**建议**:改为 **必填**",
      "**边界处理**",
      "```\n**问题**:围栏里的标签不算\n```",
      "**沿用 model-z 在 Review Run #1 / abc1234 上的说法,尚未针对新代码重新验证**",
      "**问题**:旧说法",
      "**建议**:旧建议",
      "延续自 [上一处评论](https://forge.invalid/c/1):这处代码已改写,复核判定同一个问题仍在。",
      "<!-- multireviewer:0000000000000000000000000000000000000000000000000000000000000000 -->",
    ]),
    [
      {
        ...a,
        impact: "差值都错。",
        suggestion: "改为 **必填**\n\n**边界处理**\n\n```\n**问题**:围栏里的标签不算\n```",
      },
    ],
  );
  // 围栏里有空行隔开的模型标题与标签:跨段落跟踪围栏,整段建议原文读回,不多拆出一段。
  const fenced = "参考格式：\n\n```md\n\n**model-a**\n\n**问题**:示例问题\n\n```";
  const nan = { model: "model-a", description: "空数组得到 NaN。" };
  assert.deepEqual(
    section(["**[P1] 平均值**", "**model-a**", "**问题**:空数组得到 NaN。", `**建议**:${fenced}`], [nan]),
    [{ ...nan, impact: "", suggestion: fenced }],
  );
  // 围栏没闭合:后面的锚点会被当成正文,整条不给。
  assert.equal(
    section(["**[P1] t**", "**model-a**", "**问题**:x", "**建议**:```md\n\n**问题**:y", "<!-- multireviewer:0 -->"], [
      { model: "model-a", description: "x" },
    ]),
    undefined,
  );
  // 正文里出现 `**模型**` 形状的段落(不在围栏里):多拆出一段,与归属对不上,整条不给。
  assert.equal(
    section(["**[P1] t**", "**model-a**", "**问题**:x", "**建议**:见下", "**model-a**", "**问题**:y"], [
      { model: "model-a", description: "x" },
    ]),
    undefined,
  );
  // 正文里有一行像标签:拆出来的字段拼不回原文,整条不给。
  assert.equal(
    section(["**[P0] t**", "**model-a**", "**问题**:x", "**建议**:先校验。", "**问题**:又一段"], [
      { model: "model-a", description: "x" },
    ]),
    undefined,
  );
  // 模型标题后不是问题标签、结尾之后还有正文:挂不上的段落,整条不给。
  assert.equal(section(["**[P0] t**", "**model-a**", "随便一段"]), undefined);
  assert.equal(
    section(["**[P0] t**", "**model-a**", "**问题**:x", "<!-- multireviewer:0 -->", "多出来的"], [
      { model: "model-a", description: "x" },
    ]),
    undefined,
  );
  // 段数或表述与归属对不上(评论里少一段、多一段、问题表述不同)整条不给。
  assert.equal(
    section(["**[P0] t**", "**model-a**", "**问题**:x"], [
      { model: "model-a", description: "x" },
      { model: "model-b", description: "y" },
    ]),
    undefined,
  );
  assert.equal(
    section(["**[P0] t**", "**model-a**", "**问题**:x"], [{ model: "model-a", description: "改过的" }]),
    undefined,
  );
});

/** 起 CLI 进程:剥掉宿主机上的 Gitea 凭据,预览与执行都不该碰网络。 */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MULTIREVIEWER_")) env[name] = value;
  }
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("CLI:默认预览不写库,--apply 先留备份再写,再预览已无可补", async () => {
  const { db } = await seedLegacy();
  const expectLines = (output: string, lines: string[]): void => {
    for (const line of lines) assert.ok(output.includes(line), `缺 ${line}\n${output}`);
  };

  const previewed = await cli(["--db", db.path, "--repo", "acme/widgets"]);
  assert.equal(previewed.code, 0, previewed.stderr);
  expectLines(previewed.stdout, [
    "范围内轮次 3 个,模型归属 7 条",
    "可补回 3 条",
    "成功上报轨迹 2、原评论 0、延续合成 1",
    "跳过 4 条",
    "← 成功上报轨迹(轨迹 seq ",
    "延续承接的历史说法:1 条 Finding 补进 4 段,已有的补齐 0 段,跳过 0 段",
    "← 抄自 finding ",
    "历史说法整份恢复不了的 Finding 0 条",
    "没配 Gitea 凭据,本次没有读原评论。",
    "预览模式,未写库。",
  ]);
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NOT NULL")[0]!["n"], 0);
  assert.deepEqual(readdirSync(dirname(db.path)), ["multireviewer.db"]);

  const applied = await cli(["--db", db.path, "--repo", "acme/widgets", "--apply"]);
  assert.equal(applied.code, 0, applied.stderr);
  expectLines(applied.stdout, ["已备份到 ", "已写入:补回归属 3 条,历史说法新增 4 段、补齐 0 段。"]);
  const backup = readdirSync(dirname(db.path)).find((name) => name.startsWith("multireviewer.db.bak-"));
  assert.notEqual(backup, undefined, "执行前没有留备份");
  assert.ok(existsSync(`${db.path}.bak-${backup!.slice("multireviewer.db.bak-".length)}`));
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NOT NULL")[0]!["n"], 3);
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 4);

  const after = await cli(["--db", db.path, "--repo", "acme/widgets"]);
  expectLines(after.stdout, [
    "可补回 0 条",
    "跳过 4 条",
    "延续承接的历史说法:0 条 Finding 补进 0 段,已有的补齐 0 段,跳过 0 段",
  ]);

  const noScope = await cli(["--db", db.path]);
  assert.equal(noScope.code, 2);
  assert.match(noScope.stderr, /范围要且只要给一个/);
});
