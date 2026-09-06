/**
 * 恢复已有评审记录里缺失的影响与修改建议(issue #268)。
 *
 * 夹具由真实的 `runReview` 落出来:三轮 Review Run 留下成功上报的轨迹、被拒的上报、同一
 * 模型两次内容不同的上报、折叠到旧评论上的行,以及按复核结论合成的延续;之后把两列抹回
 * NULL、清掉历史说法,模拟升级前落的库。断言打在恢复核心的计划与写入,以及 CLI 进程边界上。
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

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type Said = { file: string; line: number; title: string; description: string; impact: string; suggestion: string };

const A: Said = {
  file: "src/calc.ts",
  line: 6,
  title: "sub 多减了 1",
  description: "sub() 多减了 1。",
  impact: "差值都错。",
  suggestion: "去掉 - 1。",
};
const B: Said = { ...A, title: "sub 算错", description: "减法结果不对。", impact: "", suggestion: "改成 a - b。" };
const C: Said = { ...A, title: "sub 少了", description: "sub 少了。", impact: "余额错。", suggestion: "删掉 - 1。" };
const U: Said = {
  file: "src/util.ts",
  line: 2,
  title: "clamp 没有上限",
  description: "clamp 只截了下限。",
  impact: "工具函数出错。",
  suggestion: "加上限校验。",
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

/**
 * 三轮之后抹掉两列、清掉历史说法:
 *
 * - 第一轮:calc 第 6 行由 a / b / c 三个模型合成一条(a 有唯一成功上报外加一次被拒的;
 *   b 两次内容不同的成功上报;c 没有轨迹),util 第 2 行由 c 报出并有轨迹。
 * - 第二轮(同一 head):c 换了建议重报 util,折叠到第一轮那条评论上,没有轨迹。
 * - 第三轮(calc 第 6 行改写):d 只给位置,合成延续。
 */
async function seedLegacy() {
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

  await runReview(EVENT, {
    ...deps,
    reviewers: [
      scriptedReviewer("model-a", [finding(A)], {
        events: [reported({ ...A, suggestion: "被拒的那次说的" }, true), reported(A)],
      }),
      scriptedReviewer("model-b", [finding(B)], {
        events: [reported(B), reported({ ...B, suggestion: "用 a - b。" })],
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
  forge.pullRequest.headSha = repo.commitToBranch("feature", {
    "src/calc.ts": HEAD_CALC.replace("return a - b - 1;", "return a - b - 2;"),
    "src/util.ts": HEAD_UTIL,
  });
  await runReview(EVENT, { ...deps, reviewers: [verdictReviewer("model-d", "present", [], 6)] });
  feedBack();

  const legacy = new DatabaseSync(db.path);
  legacy.exec(
    "UPDATE finding_attribution SET impact = NULL, suggestion = NULL; DELETE FROM finding_carried_attribution",
  );
  legacy.close();
  return { db, forge };
}

type Row = { id: number; run_id: number; file: string; model: string; position: number };

/** 库里的归属行,按 finding id 与位置排,断言据此对号。 */
function rows(dbPath: string): Row[] {
  return sql<Row>(
    dbPath,
    `SELECT f.id AS id, f.run_id AS run_id, f.file AS file, a.model AS model, a.position AS position
       FROM finding_attribution a JOIN finding f ON f.id = a.finding_id
      ORDER BY f.id, a.position`,
  );
}

function at(all: Row[], runId: number, file: string, model: string): Row {
  const row = all.find((r) => r.run_id === runId && r.file === file && r.model === model);
  assert.notEqual(row, undefined, `第 ${runId} 轮 ${file} 没有 ${model} 的归属`);
  return row!;
}

test("预览只读库:轨迹唯一匹配才补,两次不同上报与折叠行跳过,延续从上一处抄历史说法", async () => {
  const { db } = await seedLegacy();
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const b1 = at(all, 1, "src/calc.ts", "model-b");
  const c1 = at(all, 1, "src/calc.ts", "model-c");
  const u1 = at(all, 1, "src/util.ts", "model-c");
  const u2 = at(all, 2, "src/util.ts", "model-c");
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  const before = sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NULL");

  const readOnly = new DatabaseSync(db.path, { readOnly: true });
  const plan = await planRecovery(readOnly, { kind: "repo", owner: "acme", repo: "widgets" });
  readOnly.close();

  assert.equal(plan.runs, 3);
  assert.equal(plan.attributions, 6);
  assert.deepEqual(
    plan.fills.map((fill) => [fill.findingId, fill.model, fill.source, fill.impact, fill.suggestion]),
    [
      [a1.id, "model-a", "trace", A.impact, A.suggestion],
      [u1.id, "model-c", "trace", U.impact, U.suggestion],
      [d3.id, "model-d", "continuation", "", ""],
    ],
  );
  assert.deepEqual(
    plan.skips.map((skip) => [skip.findingId, skip.model, skip.reason]),
    [
      [b1.id, "model-b", "同一轮该模型对这段问题有 2 次内容不同的成功上报,对不上是哪一次"],
      [c1.id, "model-c", "轨迹里没有这次上报,没配 Forge 凭据读不到原评论"],
      [u2.id, "model-c", "轨迹里没有这次上报,这一行是折叠到旧评论上的,旧评论不是它的原文"],
    ],
  );
  // 延续那一行从第一轮那条抄三段:a 用的是这份计划里补回的值,b 与 c 还缺着就照实为 null。
  assert.deepEqual(
    plan.carriedInserts.map((insert) => [
      insert.findingId,
      insert.rows.map((row) => [row.model, row.runId, row.description, row.impact, row.suggestion]),
    ]),
    [
      [
        d3.id,
        [
          ["model-a", 1, A.description, A.impact, A.suggestion],
          ["model-b", 1, B.description, null, null],
          ["model-c", 1, C.description, null, null],
        ],
      ],
    ],
  );
  assert.deepEqual(plan.carriedFills, []);
  // 预览一个字都没写。
  assert.deepEqual(
    sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NULL"),
    before,
  );
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 0);
});

test("原评论只认这一行自己发出去的那条;折叠上去的行不拿旧评论当原文", async () => {
  const { db, forge } = await seedLegacy();
  const all = rows(db.path);
  const c1 = at(all, 1, "src/calc.ts", "model-c");
  const u2 = at(all, 2, "src/util.ts", "model-c");

  const readOnly = new DatabaseSync(db.path, { readOnly: true });
  const plan = await planRecovery(
    readOnly,
    { kind: "repo", owner: "acme", repo: "widgets" },
    (ref) => forge.forge.listReviewComments(ref),
  );
  readOnly.close();

  const fromComment = plan.fills.filter((fill) => fill.source === "comment");
  assert.deepEqual(
    fromComment.map((fill) => [fill.findingId, fill.model, fill.impact, fill.suggestion]),
    [[c1.id, "model-c", C.impact, C.suggestion]],
  );
  assert.ok(
    plan.skips.some((skip) => skip.findingId === u2.id && skip.reason.includes("折叠到旧评论上")),
    "折叠行不该拿旧评论补",
  );
  // 延续那一行抄到的 c 那段跟着这份计划一起补上。
  const carried = plan.carriedInserts[0]!.rows.find((row) => row.model === "model-c")!;
  assert.deepEqual([carried.impact, carried.suggestion], [C.impact, C.suggestion]);
});

test("执行只补 NULL、非空不碰,面板读得回,重复执行没有第二份副作用", async () => {
  const { db, forge } = await seedLegacy();
  const all = rows(db.path);
  const a1 = at(all, 1, "src/calc.ts", "model-a");
  const d3 = at(all, 3, "src/calc.ts", "model-d");
  // 有人已经手工补过 a 的影响:那一格不被轨迹覆盖,只补还缺的建议。
  const edited = new DatabaseSync(db.path);
  edited
    .prepare("UPDATE finding_attribution SET impact = ? WHERE finding_id = ? AND position = ?")
    .run("人工写的影响", a1.id, a1.position);
  edited.close();

  const writable = new DatabaseSync(db.path);
  const scope = { kind: "repo", owner: "acme", repo: "widgets" } as const;
  const comments = (ref: Parameters<typeof forge.forge.listReviewComments>[0]) =>
    forge.forge.listReviewComments(ref);
  applyRecovery(writable, await planRecovery(writable, scope, comments));
  const again = await planRecovery(writable, scope, comments);
  applyRecovery(writable, again);
  writable.close();

  // 第二遍没有可补的:剩下的只是仍然对不上来源的那两条。
  assert.deepEqual(again.fills, []);
  assert.deepEqual(again.carriedInserts, []);
  assert.deepEqual(again.carriedFills, []);
  assert.deepEqual(
    again.skips.map((skip) => skip.model),
    ["model-b", "model-c"],
  );

  const store = openStore(db.path);
  const runs = store.listRuns({ limit: 10 }).sort((x, y) => x.id - y.id);
  store.close();
  const first = runs[0]!.findings.find((entry) => entry.file === "src/calc.ts")!;
  assert.deepEqual(
    first.attributions.map((said) => [said.model, said.impact, said.suggestion]),
    [
      ["model-a", "人工写的影响", A.suggestion],
      ["model-b", null, null],
      ["model-c", C.impact, C.suggestion],
    ],
  );
  const util = runs[0]!.findings.find((entry) => entry.file === "src/util.ts")!;
  assert.deepEqual(util.attributions.map((said) => [said.impact, said.suggestion]), [[U.impact, U.suggestion]]);
  assert.deepEqual(
    runs[1]!.findings[0]!.attributions.map((said) => [said.impact, said.suggestion]),
    [[null, null]],
  );
  const continued = runs[2]!.findings.find((entry) => entry.id === d3.id)!;
  assert.deepEqual(continued.attributions.map((said) => [said.impact, said.suggestion]), [["", ""]]);
  assert.deepEqual(
    continued.carried.map((row) => [row.model, row.runId, row.headSha, row.impact, row.suggestion]),
    [
      ["model-a", 1, runs[0]!.headSha, "人工写的影响", A.suggestion],
      ["model-b", 1, runs[0]!.headSha, null, null],
      ["model-c", 1, runs[0]!.headSha, C.impact, C.suggestion],
    ],
  );
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 3);
});

test("评论正文按模型分段读回,等级标题与沿用段不算模型段,多段落正文接得上", () => {
  const body = [
    "**[P0] sub 多减了 1**",
    "**model-a**",
    "**问题**:第一段。",
    "还有第二段。",
    "**影响**:差值都错。",
    "**建议**:去掉 - 1。",
    "**沿用 model-z 在 abc1234 上的说法,尚未针对新代码重新验证**",
    "**问题**:旧说法",
    "**建议**:旧建议",
    "延续自 [上一处评论](https://forge.invalid/c/1):这处代码已改写,复核判定同一个问题仍在。",
    "<!-- multireviewer:0000000000000000000000000000000000000000000000000000000000000000 -->",
  ].join("\n\n");
  assert.deepEqual(commentSections(body), [
    { model: "model-a", description: "第一段。\n\n还有第二段。", impact: "差值都错。", suggestion: "去掉 - 1。" },
  ]);
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

  const preview = await cli(["--db", db.path, "--repo", "acme/widgets"]);
  assert.equal(preview.code, 0, preview.stderr);
  const expectLines = (output: string, lines: string[]): void => {
    for (const line of lines) assert.ok(output.includes(line), `缺 ${line}\n${output}`);
  };
  expectLines(preview.stdout, [
    "范围内轮次 3 个,模型归属 6 条",
    "可补回 3 条",
    "成功上报轨迹 2、原评论 0、延续合成 1",
    "跳过 3 条",
    "延续承接的历史说法:1 条 Finding 补进 3 段,已有的补齐 0 段",
    "没配 Gitea 凭据,本次没有读原评论。",
    "预览模式,未写库。",
  ]);
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NOT NULL")[0]!["n"], 0);
  assert.deepEqual(readdirSync(dirname(db.path)), ["multireviewer.db"]);

  const applied = await cli(["--db", db.path, "--repo", "acme/widgets", "--apply"]);
  assert.equal(applied.code, 0, applied.stderr);
  expectLines(applied.stdout, ["已备份到 ", "已写入:补回归属 3 条,历史说法新增 3 段、补齐 0 段。"]);
  const backup = readdirSync(dirname(db.path)).find((name) => name.startsWith("multireviewer.db.bak-"));
  assert.notEqual(backup, undefined, "执行前没有留备份");
  assert.ok(existsSync(`${db.path}.bak-${backup!.slice("multireviewer.db.bak-".length)}`));
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_attribution WHERE impact IS NOT NULL")[0]!["n"], 3);
  assert.equal(sql(db.path, "SELECT COUNT(*) AS n FROM finding_carried_attribution")[0]!["n"], 3);

  const after = await cli(["--db", db.path, "--repo", "acme/widgets"]);
  expectLines(after.stdout, [
    "可补回 0 条",
    "跳过 3 条",
    "延续承接的历史说法:0 条 Finding 补进 0 段,已有的补齐 0 段",
  ]);

  const noScope = await cli(["--db", db.path]);
  assert.equal(noScope.code, 2);
  assert.match(noScope.stderr, /范围要且只要给一个/);
});
