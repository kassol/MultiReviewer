/**
 * 合并去重交给合并 agent(issue #228)。
 *
 * 打在 `runReview` 的注入边界上(先例 `multi-reviewer`、`review-trace`):脚本化 Reviewer
 * 给 Finding,脚本化 MergeAgent 给分组方案,内存 Forge 跑一轮,断言最终评论条数、每条的
 * 归属与折叠,以及轨迹里的合并与回退事件。不测 prompt 文本,也不测内部调用序列。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { MergeAgentRequest } from "../src/review/dedupe.ts";
import type { Reviewer, ReviewVerdict } from "../src/review/finding.ts";
import { MERGE_AGENT_TRACE_NAME, runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { setup as setupRepo } from "./support/batch-run.ts";
import {
  scriptedMergeAgent,
  scriptedReviewer,
  verdictReviewer,
  type MemoryForge,
} from "./support/memory-forge.ts";
import {
  HARNESS_SPEC,
  seedAvailableModelService,
  seedHistoricalRepo,
  startPanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";

const BASE_M = `export function sub(a, b) {
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

// 改第 2 行与第 14 行,两个 hunk 各带 3 行上下文,新侧覆盖 1..5 与 11..17。
const HEAD_M = BASE_M.replace("return a - b;", "return a - b - 1;").replace(
  "return a % b;",
  "return a % b + 0;",
);

const BASE_N = `export function inc(n) {
  return n + 1;
}
`;
const HEAD_N = BASE_N.replace("return n + 1;", "return n + 2;");

const cleanups = testCleanups();

const EVENT = { owner: "acme", repo: "widgets", number: 1 };

function setup() {
  // 同一个数组交给内存 Forge:改写它即改写本轮的变更文件清单(先例 `run-review`)。
  const changedFiles: { path: string; status: "modified" }[] = [
    { path: "src/m.js", status: "modified" },
    { path: "src/n.js", status: "modified" },
  ];
  return {
    ...setupRepo(cleanups, {
      tree: {
        base: { "src/m.js": BASE_M, "src/n.js": BASE_N },
        head: { "src/m.js": HEAD_M, "src/n.js": HEAD_N },
      },
      pullNumber: EVENT.number,
      changedFiles,
    }),
    changedFiles,
  };
}

/**
 * 改写工作分支上的 `src/m.js` 并把 PR 的 head 移过去:旧位置的指纹窗口因此在下一轮
 * 算不出来,同一条 Finding 只能靠延续交接位置(CONTEXT.md 已延续)。
 */
function rewriteHead(ctx: ReturnType<typeof setup>, source: string): void {
  ctx.forge.pullRequest.headSha = ctx.repo.commitToBranch("feature", { "src/m.js": source });
}

/** 一条 Finding 的模板。用例只改位置与那两段文本。 */
const AT = (line: number, title: string, description = title) => ({
  file: "src/m.js",
  line,
  severity: "P1" as const,
  category: "bug" as const,
  title,
  description,
});

/** 这一轮落库的全部轨迹事件。 */
function trace(dbPath: string): {
  scope: string;
  reviewer?: string;
  kind: string;
  payload: Record<string, unknown>;
}[] {
  const store = openStore(dbPath);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    return store.listTrace(runId).map((event) => ({
      scope: event.scope,
      ...(event.reviewer === undefined ? {} : { reviewer: event.reviewer }),
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
    }));
  } finally {
    store.close();
  }
}

test("分组方案过验收即生效:同一行的两个问题被拆开,相邻的同一个问题被合并", async () => {
  const { cache, db, forge } = setup();
  const merge = scriptedMergeAgent(
    [
      { members: [0, 2], reason: "两条说的都是余额校验被删掉" },
      { members: [1], reason: "类型校验是另一个问题" },
    ],
    { events: [{ kind: "assistant_message", text: "先看这三条讲的是不是一回事" }] },
  );

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "删除了余额校验")]),
      scriptedReviewer("model-b", [AT(2, "删除了类型校验"), AT(3, "余额校验被删掉了")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: merge,
  });

  // 词面重叠会把这三条串成一组(第 2 行两条同行、第 3 行相距 1 行);agent 分成两组。
  assert.deepEqual(merge.calls[0]!.map((f) => f.title), [
    "删除了余额校验",
    "删除了类型校验",
    "余额校验被删掉了",
  ]);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[0]!.attributions.map((a) => a.model), ["model-a", "model-b"]);
  // 代表段取描述最长的那条归属(issue #278):这一组里是 model-b 那份。
  assert.equal(result.findings[0]!.title, "余额校验被删掉了");
  assert.deepEqual(result.findings[1]!.attributions.map((a) => a.model), ["model-b"]);
  assert.equal(result.findings[1]!.title, "删除了类型校验");
  assert.equal(forge.createdReviews[0]!.comments.length, 2);

  const events = trace(db.path);
  // 真的合并了的那一组发一条事件,判据是 agent 档,带它给的那句理由。
  const merged = events.filter((event) => event.kind === "finding_merged");
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.payload["criteria"], {
    kind: "agent",
    reason: "两条说的都是余额校验被删掉",
  });
  assert.deepEqual(merged[0]!.payload["members"], [
    { reviewer: "model-a", line: 2, title: "删除了余额校验" },
    { reviewer: "model-b", line: 3, title: "余额校验被删掉了" },
  ]);
  // 合并 agent 的过程进本轮轨迹,与 Reviewer 同一待遇。
  assert.deepEqual(
    events
      .filter((event) => event.reviewer === MERGE_AGENT_TRACE_NAME)
      .map((event) => event.kind),
    ["assistant_message"],
  );
  assert.equal(events.filter((event) => event.kind === "merge_fallback").length, 0);
});

test("单成员组不产生合并事件", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "删除了余额校验")]),
      scriptedReviewer("model-b", [AT(2, "删除了类型校验")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      { members: [0], reason: "余额校验" },
      { members: [1], reason: "类型校验" },
    ]),
  });

  assert.equal(result.findings.length, 2);
  assert.equal(trace(db.path).filter((event) => event.kind === "finding_merged").length, 0);
});

test("同一个模型逐字重复报的两条,合进同一组后仍折叠成一段归属", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "sub 多减了 1"), AT(3, "sub 多减了 1")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([{ members: [0, 1], reason: "同一个减法错误报了两遍" }]),
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]!.attributions.map((a) => a.title), ["sub 多减了 1"]);
  assert.equal(forge.createdReviews[0]!.comments.length, 1);
});

/** 方案没过验收时的共同断言:退回算法档的一条,轨迹留一条回退事件。 */
async function assertFallback(
  groups: Parameters<typeof scriptedMergeAgent>[0],
  extra?: Parameters<typeof scriptedMergeAgent>[1],
  findings: readonly ReturnType<typeof AT>[] = [AT(2, "删除了余额校验"), AT(3, "余额校验被删了")],
): Promise<{ reason: string; count: number }> {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [findings[0]!]),
      scriptedReviewer("model-b", [findings[1]!]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent(groups, extra),
  });

  const fallbacks = trace(db.path).filter((event) => event.kind === "merge_fallback");
  assert.equal(fallbacks.length, 1, "回退该在轨迹里留一条记录");
  return { reason: String(fallbacks[0]!.payload["reason"]), count: result.findings.length };
}

test("带空组的分组方案整体回退,不掀掉整轮审查", async () => {
  // 空组曾让验收在取代表时当场抛 TypeError,异常穿透 mergeFindings 掀掉整轮
  // (code review 实测复现)。验收的职责是把一切不成立的方案挡成回退。
  const { reason, count } = await assertFallback([
    { members: [0, 1], reason: "同一个问题" },
    { members: [], reason: "误产出的空组" },
  ]);
  assert.match(reason, /没有任何成员/);
  assert.equal(count, 1);
});

test("丢掉一条 Finding 的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback([{ members: [0], reason: "只报了一组" }]);
  assert.match(reason, /没有被分进/);
  // 算法档把这两条合成一条:回退之后的结果就是它。
  assert.equal(count, 1);
});

test("一条 Finding 出现在两组里的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback([
    { members: [0, 1], reason: "同一个问题" },
    { members: [1], reason: "又报了一遍" },
  ]);
  assert.match(reason, /被分进了两组/);
  assert.equal(count, 1);
});

test("成员跨文件的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback(
    [{ members: [0, 1], reason: "两个文件里的同一个问题" }],
    undefined,
    [AT(2, "删除了余额校验"), { ...AT(2, "inc 加错了"), file: "src/n.js" }],
  );
  assert.match(reason, /混了不同文件/);
  // 两个文件各一条,算法档也不会把它们合起来。
  assert.equal(count, 2);
});

test("组内行距越界的分组方案整体回退", async () => {
  const { reason, count } = await assertFallback(
    [{ members: [0, 1], reason: "隔得远也是同一个问题" }],
    undefined,
    [AT(2, "删除了余额校验"), AT(14, "mod 加了 0")],
  );
  assert.match(reason, /相距超过 3 行/);
  assert.equal(count, 2);
});

test("合并 agent 报失败时整体回退", async () => {
  const { reason, count } = await assertFallback([], { failure: "模型调用超时" });
  assert.equal(reason, "模型调用超时");
  assert.equal(count, 1);
});

test("合并 agent 抛异常时整体回退,整轮审查照常完成", async () => {
  const { reason, count } = await assertFallback([], { throws: "子进程无法启动" });
  assert.equal(reason, "子进程无法启动");
  assert.equal(count, 1);
});

test("回退之后的结果与没有合并 agent 时逐字一致", async () => {
  const reviewers = () => [
    scriptedReviewer("model-a", [AT(2, "删除了余额校验")]),
    scriptedReviewer("model-b", [AT(3, "余额校验被删了"), AT(14, "mod 加了 0")]),
  ];

  const withAgent = setup();
  const fallen = await runReview(EVENT, {
    forge: withAgent.forge.forge,
    reviewers: reviewers(),
    cacheDir: withAgent.cache.dir,
    dbPath: withAgent.db.path,
    mergeAgent: scriptedMergeAgent([], { failure: "模型调用失败" }),
  });

  const withoutAgent = setup();
  const algorithmic = await runReview(EVENT, {
    forge: withoutAgent.forge.forge,
    reviewers: reviewers(),
    cacheDir: withoutAgent.cache.dir,
    dbPath: withoutAgent.db.path,
  });

  assert.deepEqual(fallen.findings, algorithmic.findings);
  assert.deepEqual(
    withAgent.forge.createdReviews[0]!.comments,
    withoutAgent.forge.createdReviews[0]!.comments,
  );
});

/**
 * 多归属组的正文由合并 agent 综合(issue #279,ADR 0022 的 2026-09-07 修订附记)。
 *
 * 断言的仍只有外部行为:落库的四段、归属有没有被动过、Forge 评论正文,以及缺综合那一组
 * 的轨迹事件。综合本身怎么写是模型的事,用例只给脚本化的一份。
 */

/** 四段齐全的一条 Finding。综合要合的就是这四段。 */
const SAID = (
  line: number,
  title: string,
  description: string,
  impact: string,
  suggestion: string,
) => ({ ...AT(line, title, description), impact, suggestion });

const SYNTHESIS = {
  title: "sub 的减法多减了 1",
  description: "sub 在返回时又减了一次 1,两个模型报的是同一处越界。",
  impact: "所有调用方拿到的差都少 1,账目会逐笔偏。",
  suggestion: "去掉多出来的那次减 1。",
};

test("多归属组的综合说明成为正文,归属保留各模型原话", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        SAID(2, "减法越界", "sub 多减了 1", "结果偏小", "改回 a - b"),
      ]),
      scriptedReviewer("model-b", [
        SAID(3, "off-by-one", "返回值比正确结果少 1", "调用方算错", "去掉那个 -1"),
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      { members: [0, 1], reason: "两条说的是同一个减法越界", synthesis: SYNTHESIS },
    ]),
  });

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.title, SYNTHESIS.title);
  assert.equal(finding.description, SYNTHESIS.description);
  assert.equal(finding.impact, SYNTHESIS.impact);
  assert.equal(finding.suggestion, SYNTHESIS.suggestion);
  // 归属逐字不变:综合只改正文,各模型的原话仍在可展开区里。
  assert.deepEqual(
    finding.attributions.map((said) => [said.model, said.title, said.description]),
    [
      ["model-a", "减法越界", "sub 多减了 1"],
      ["model-b", "off-by-one", "返回值比正确结果少 1"],
    ],
  );

  const body = forge.createdReviews[0]!.comments[0]!.body;
  assert.match(body, /\*\*\[P1\] sub 的减法多减了 1\*\*/);
  assert.ok(body.includes(`**问题**:${SYNTHESIS.description}`));
  assert.ok(body.includes(`**影响**:${SYNTHESIS.impact}`));
  assert.ok(body.includes(`**建议**:${SYNTHESIS.suggestion}`));
  assert.ok(body.includes("由 2 个模型报出:model-a、model-b"));
  // 评论正文不带各模型原话(issue #278 的口径,综合之后同样成立)。
  assert.ok(!body.includes("sub 多减了 1"), "正文不该混进 model-a 的原话");
  assert.ok(!body.includes("返回值比正确结果少 1"), "正文不该混进 model-b 的原话");

  assert.equal(trace(db.path).filter((e) => e.kind === "synthesis_fallback").length, 0);
});

test("缺综合的那一组退回代表段,其余组照用综合,轨迹记一条 synthesis_fallback", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        SAID(2, "减法越界", "sub 多减了 1", "结果偏小", "改回 a - b"),
        { ...SAID(2, "加错了", "inc 加了 2", "计数偏大", "改回 n + 1"), file: "src/n.js" },
      ]),
      scriptedReviewer("model-b", [
        SAID(3, "off-by-one", "返回值比正确结果少 1", "调用方算错", "去掉那个 -1"),
        {
          ...SAID(2, "自增步长不对", "inc 每次加了 2,步长本该是 1", "计数翻倍", "步长改回 1"),
          file: "src/n.js",
        },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      { members: [0, 2], reason: "同一个减法越界", synthesis: SYNTHESIS },
      { members: [1, 3], reason: "同一个自增步长问题" },
    ]),
  });

  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]!.title, SYNTHESIS.title, "有综合的那一组用综合");
  // 没综合的那一组取描述最长的那条归属,四段同出 model-b(issue #278 的代表段规则)。
  const fallen = result.findings[1]!;
  assert.equal(fallen.title, "自增步长不对");
  assert.equal(fallen.description, "inc 每次加了 2,步长本该是 1");
  assert.equal(fallen.impact, "计数翻倍");
  assert.equal(fallen.suggestion, "步长改回 1");
  assert.equal(fallen.attributions.length, 2, "分组照收,归属不因缺综合而少");

  const events = trace(db.path).filter((e) => e.kind === "synthesis_fallback");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload["group"], 1, "组下标即方案里的次序");
  assert.match(String(events[0]!.payload["reason"]), /没有综合说明/);
  // 整轮的合并没有退回算法档:回退只落在那一组上。
  assert.equal(trace(db.path).filter((e) => e.kind === "merge_fallback").length, 0);
});

test("综合的标题或问题说明空白的那一组同样退回代表段", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [SAID(2, "减法越界", "sub 多减了 1", "结果偏小", "改回 a - b")]),
      scriptedReviewer("model-b", [
        SAID(3, "off-by-one", "返回值比正确结果少 1", "调用方算错", "去掉那个 -1"),
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      {
        members: [0, 1],
        reason: "同一个减法越界",
        synthesis: { ...SYNTHESIS, description: "   " },
      },
    ]),
  });

  assert.equal(result.findings[0]!.title, "off-by-one");
  assert.equal(result.findings[0]!.description, "返回值比正确结果少 1");
  const events = trace(db.path).filter((e) => e.kind === "synthesis_fallback");
  assert.equal(events.length, 1);
  assert.match(String(events[0]!.payload["reason"]), /问题说明是空的/);
});

test("单归属组落库为原文,agent 给了综合也不用", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [SAID(2, "减法越界", "sub 多减了 1", "结果偏小", "改回 a - b")]),
      scriptedReviewer("model-b", [SAID(14, "mod 加了 0", "取模之后又加 0", "白算一次", "删掉")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      { members: [0], reason: "只有它报了", synthesis: SYNTHESIS },
      { members: [1], reason: "另一个问题" },
    ]),
  });

  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]!.title, "减法越界");
  assert.equal(result.findings[0]!.description, "sub 多减了 1");
  // 归属只有一条的组不要求综合,缺不缺都不记回退。
  assert.equal(trace(db.path).filter((e) => e.kind === "synthesis_fallback").length, 0);
});

test("agent 随综合给的严重度与分类不采用", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        { ...SAID(2, "减法越界", "sub 多减了 1", "结果偏小", "改回 a - b"), category: "design" },
      ]),
      scriptedReviewer("model-b", [
        {
          ...SAID(3, "off-by-one", "返回值比正确结果少 1", "调用方算错", "去掉那个 -1"),
          severity: "P0",
        },
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent([
      {
        members: [0, 1],
        reason: "同一个减法越界",
        // 契约里没有这两格,模型硬塞也只是被忽略:严重度取最高、分类取首报仍由代码定。
        synthesis: { ...SYNTHESIS, severity: "P3", category: "security" } as typeof SYNTHESIS,
      },
    ]),
  });

  assert.equal(result.findings[0]!.severity, "P0");
  assert.equal(result.findings[0]!.category, "design");
  assert.equal(result.findings[0]!.title, SYNTHESIS.title);
});

test("整轮退回算法合并时综合不生效,正文取代表段", async () => {
  const { cache, db, forge } = setup();

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      // 同一行:算法档凭「同一行」这道判据就把两条合成一组,与词面相似度无关。
      scriptedReviewer("model-a", [SAID(2, "减法越界", "sub 多减了 1", "结果偏小", "改回 a - b")]),
      scriptedReviewer("model-b", [
        SAID(2, "off-by-one", "返回值比正确结果少 1", "调用方算错", "去掉那个 -1"),
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    mergeAgent: scriptedMergeAgent(
      [{ members: [0, 1], reason: "同一个减法越界", synthesis: SYNTHESIS }],
      { failure: "模型调用超时" },
    ),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.title, "off-by-one", "算法档只认代表段");
  assert.equal(result.findings[0]!.description, "返回值比正确结果少 1");
  const events = trace(db.path);
  assert.equal(events.filter((e) => e.kind === "merge_fallback").length, 1);
  assert.equal(events.filter((e) => e.kind === "synthesis_fallback").length, 0);
});

/**
 * 合并 agent 的输入扩到同文件历史(issue #240,ADR 0022 的 2026-09-04 修订附记)。
 *
 * 两轮同一份代码:第一轮报出的那条留在 Forge 上当既有评论,第二轮换个说法在别处重报,
 * 由脚本化 agent 把它与那条历史分进同一组。断言的仍只有外部行为——交给 agent 的历史
 * 是哪一批、本轮那条发不发评论、落库折叠到哪条评论,以及轨迹上的判据。
 */

/** 人在面板上处置一条 Finding,Forge 上那条评论一并置为已 resolve。 */
function dispose(dbPath: string, forge: MemoryForge, commentId: string): void {
  const store = openStore(dbPath);
  try {
    store.recordDisposition({
      owner: EVENT.owner,
      repo: EVENT.repo,
      commentId,
      disposition: "resolved",
      disposedBy: "kassol",
      disposedAt: "2026-09-04T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
  for (const comment of forge.existingComments) {
    if (comment.id === commentId) comment.resolved = true;
  }
}

/**
 * 跑第一轮,并把它真的发出去的行级评论当成 Forge 上的既有评论喂给下一轮:跨轮次的
 * 折叠认的就是那几条评论(先例 `cross-run`)。head 不动,旧指纹在第二轮仍算得出。
 */
async function firstRun(
  ctx: ReturnType<typeof setup>,
  findings: readonly ReturnType<typeof AT>[],
): Promise<void> {
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", findings)],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
  });
  carryComments(ctx);
}

/** 这一轮新发出去的行级评论按未处置预置回 Forge:下一轮的回填与折叠读的就是它们。 */
function carryComments(ctx: ReturnType<typeof setup>): void {
  const known = new Set(ctx.forge.existingComments.map((comment) => comment.id));
  ctx.forge.existingComments.push(
    ...ctx.forge.publishedComments
      .filter((comment) => !known.has(comment.id))
      .map((comment) => ({ ...comment, resolved: false })),
  );
}

/** 落库的每条 Finding:标题、处置状态、它挂着的那条评论,以及「延续自」的那条链接。 */
function findingRows(
  dbPath: string,
): { title: unknown; disposition: string; commentId: unknown; continuedFrom: unknown }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT title, disposition, comment_id, continued_from FROM finding ORDER BY id",
        )
        .all() as unknown as Record<string, unknown>[]
    ).map((row) => ({
      title: row["title"],
      disposition: String(row["disposition"]),
      commentId: row["comment_id"],
      continuedFrom: row["continued_from"],
    }));
  } finally {
    db.close();
  }
}

test("合并请求里的历史只含本轮有 Finding 的文件,未处置与已处置都在", async () => {
  const ctx = setup();
  await firstRun(ctx, [
    AT(2, "余额校验被删掉"),
    AT(14, "mod 加了 0"),
    { ...AT(2, "inc 加错了"), file: "src/n.js" },
  ]);
  // 第一条被人处置掉:两档历史都要进合并请求。
  dispose(ctx.db.path, ctx.forge, "comment-1");

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "还是那处余额校验" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(2, "余额校验没了")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(
    merge.historyCalls[0]!.map((entry) => [entry.file, entry.disposition]),
    [
      ["src/m.js", "resolved"],
      ["src/m.js", "unknown"],
    ],
    "只该给本轮有 Finding 报出的那个文件的历史,两档都在",
  );
});

test("agent 把本轮一条与旧指纹仍在的历史分成一组:不发评论,折叠到旧条,判据是 agent", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);

  // 第 14 行离第 2 行 12 行远,指纹滑窗够不着:能把这两条接上的只有合并 agent。
  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "换了说法的同一处余额校验" },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.inlineCount, 0, "折叠到旧评论的那条不再发新评论");
  assert.deepEqual(ctx.forge.createdReviews[1]!.comments, []);
  assert.deepEqual(findingRows(ctx.db.path)[1], {
    title: "余额没有被校验",
    disposition: "unresolved",
    commentId: "comment-1",
    continuedFrom: null,
  });

  const folded = trace(ctx.db.path).filter((event) => event.kind === "finding_folded");
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0]!.payload["criteria"], {
    kind: "agent",
    reason: "换了说法的同一处余额校验",
  });

  // 折叠进旧条的那一行带旧条的指纹:阶段汇总按「文件 + 指纹」归并,同一处问题只占一行,
  // 未处置计数不因换了说法再报一次而多一条。
  const store = openStore(ctx.db.path);
  const summary = store.stageSummary({ owner: EVENT.owner, repo: EVENT.repo, pullNumber: EVENT.number });
  store.close();
  assert.equal(summary.findings.length, 1);
});

test("命中已处置的历史:本轮那条沉默,落库折叠到已处置", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  dispose(ctx.db.path, ctx.forge, "comment-1");

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "这处已经处置过了" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(ctx.forge.createdReviews[1]!.comments, [], "已处置过的那处不再打扰");
  assert.deepEqual(findingRows(ctx.db.path)[1], {
    title: "余额没有被校验",
    disposition: "resolved",
    commentId: "comment-1",
    continuedFrom: null,
  });
});

test("含历史成员的组行距超容差仍过验收", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(14, "mod 加了 0")]);

  // 本轮两条相距 9 行:不含历史的组会被行距那一条挡下来,含历史的这一组免验。
  const merge = scriptedMergeAgent((request) => [
    {
      members: [0, 1],
      history: [request.history![0]!.id],
      reason: "代码改写之后这个问题漂到了两处",
    },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "取模的结果偏了")]),
      scriptedReviewer("model-b", [AT(11, "取模结果不对")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.equal(trace(ctx.db.path).filter((e) => e.kind === "merge_fallback").length, 0);
  assert.equal(result.findings.length, 1);
});

test("同一条历史被分进两组的方案整体作废回退", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(14, "mod 加了 0")]);

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "是它" },
    { members: [1], history: [request.history![0]!.id], reason: "也是它" },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "取模的结果偏了")]),
      scriptedReviewer("model-b", [AT(11, "取模结果不对")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  const fallbacks = trace(ctx.db.path).filter((e) => e.kind === "merge_fallback");
  assert.equal(fallbacks.length, 1);
  assert.match(String(fallbacks[0]!.payload["reason"]), /被分进了两组/);
  // 回退到算法档:相距 9 行的两条各自成条。
  assert.equal(result.findings.length, 2);
});

test("带上历史之后回退档的结果仍与没有合并 agent 时逐字一致", async () => {
  const withAgent = setup();
  await firstRun(withAgent, [AT(2, "余额校验被删掉")]);
  const fallen = await runReview(EVENT, {
    forge: withAgent.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: withAgent.cache.dir,
    dbPath: withAgent.db.path,
    mergeAgent: scriptedMergeAgent([], { failure: "模型调用失败" }),
  });

  const withoutAgent = setup();
  await firstRun(withoutAgent, [AT(2, "余额校验被删掉")]);
  const algorithmic = await runReview(EVENT, {
    forge: withoutAgent.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: withoutAgent.cache.dir,
    dbPath: withoutAgent.db.path,
  });

  assert.deepEqual(fallen.findings, algorithmic.findings);
  assert.deepEqual(
    withAgent.forge.createdReviews[1]!.comments,
    withoutAgent.forge.createdReviews[1]!.comments,
  );
  assert.deepEqual(findingRows(withAgent.db.path), findingRows(withoutAgent.db.path));
});

/**
 * 收口的另一半:命中的历史所指代码已经改写时走延续(issue #243)。旧评论 resolve 并记
 *「已延续」,本轮那条承接同一条 Finding Identity,新评论正文带「延续自」——与词法配对
 * 那一档落库同形,差别只在判据是 agent。
 */

/** 第 2 行被改写:旧那处的指纹窗口在下一轮算不出来。 */
const REWRITTEN_M = HEAD_M.replace("return a - b - 1;", "return a - b - 9;");

test("命中的历史所指代码已改写:走延续,旧评论 resolve,新评论带「延续自」", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  rewriteHead(ctx, REWRITTEN_M);

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "代码改写了,同一个问题还在" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "余额没有被校验")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(ctx.forge.resolvedIds, ["comment-1"], "旧评论要被 resolve 掉");
  const rows = findingRows(ctx.db.path);
  assert.equal(rows[0]!.disposition, "continued", "旧那一行记「已延续」");
  assert.equal(
    rows[1]!.continuedFrom,
    "https://forge.invalid/pulls/7/files#comment-1",
    "本轮那一行承接旧 Identity,记下旧评论的地址",
  );
  assert.match(ctx.forge.createdReviews[1]!.comments[0]!.body, /延续自 \[上一处评论\]/);

  const continued = trace(ctx.db.path).filter((event) => event.kind === "finding_continued");
  assert.equal(continued.length, 1);
  assert.deepEqual(continued[0]!.payload["criteria"], {
    kind: "agent",
    reason: "代码改写了,同一个问题还在",
  });
});

test("命中的历史本轮已被全部 Reviewer 判已修:不延续,旧行留「已修复」,本轮那条是新 Finding", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  rewriteHead(ctx, REWRITTEN_M);

  // 复核判已修、自动处置成「已修复」之后,合并 agent 仍把它配进本轮这一组(issue #263)。
  // 已修的历史不再是延续候选:与词法配对那一档同一口径,否则旧行记「已修复」、新行又指
  // 向它,阶段汇总把同一条 Identity 数两次。
  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "代码改写了,同一个问题还在" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [verdictReviewer("model-a", "fixed", [AT(14, "余额没有被校验")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  const rows = findingRows(ctx.db.path);
  assert.equal(rows[0]!.disposition, "fixed", "旧那一行保持「已修复」");
  assert.equal(rows[1]!.continuedFrom, null, "本轮那条是新 Finding,不承接已修的 Identity");
  assert.doesNotMatch(ctx.forge.createdReviews[1]!.comments[0]!.body, /延续自/);
  assert.equal(
    trace(ctx.db.path).filter((event) => event.kind === "finding_continued").length,
    0,
    "轨迹不记延续",
  );
});

test("同一条历史同时被 agent 命中与复核结论自带位置:以 agent 命中的那条承接,不合成", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  rewriteHead(ctx, REWRITTEN_M);

  // 本轮这条与历史一个 token 都不共享,词法配对配不上;复核判仍在并给出第 14 行,
  // 没有 agent 时编排层会按历史正文在那里合成一条。
  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "换了个说法的同一处" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [verdictReviewer("model-a", "present", [AT(14, "取模的结果偏了")], 14)],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  const rows = findingRows(ctx.db.path);
  assert.equal(rows.length, 2, "不该再合成一条:那条 Identity 已经被 agent 命中的那条承接了");
  assert.equal(rows[1]!.title, "取模的结果偏了", "承接的是本轮报出的那条,不是抄旧正文的合成条");
  assert.notEqual(rows[1]!.continuedFrom, null);
});

test("一组含两条历史:id 小的延续,另一条保持原状", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉"), AT(14, "mod 加了 0")]);
  // 两处的指纹窗口都被改写:两条历史都够得上延续,平台只能挑一条。
  rewriteHead(ctx, REWRITTEN_M.replace("return a % b + 0;", "return a % b + 9;"));

  const merge = scriptedMergeAgent((request) => [
    {
      members: [0],
      history: request.history!.map((entry) => entry.id),
      reason: "这两处讲的是同一个问题",
    },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(11, "除法没有防零")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(ctx.forge.resolvedIds, ["comment-1"], "只 resolve id 小的那条");
  const rows = findingRows(ctx.db.path);
  assert.equal(rows[0]!.disposition, "continued");
  assert.equal(rows[1]!.disposition, "unresolved", "另一条历史保持原状");
  assert.equal(
    rows[2]!.continuedFrom,
    "https://forge.invalid/pulls/7/files#comment-1",
  );
});

/*
 * Finding Identity 是「同一处的同一问题」(ADR 0030,issue #307):跨轮次折叠以合并
 * agent 的判定为准,指纹只在它不可用时兜底。断言的是本轮那条发不发评论、落库的处置与
 * 指纹、阶段汇总里算几条 Identity,以及轨迹上的判据。
 */

test("同一处的另一个问题:agent 只把其中一条归给历史,另一条发新评论且未处置", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  // 上一轮那条被人驳回:旧口径下它会把本轮同一行的新问题一并压掉,连评论都不发。
  dispose(ctx.db.path, ctx.forge, "comment-1");

  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "还是那处余额校验" },
    { members: [1], reason: "日志里打印密钥是另一个问题" },
  ]);
  const result = await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "余额校验被删掉"), AT(2, "日志里打印了密钥")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.equal(result.findings.length, 2, "同一行上的两个问题各成一条");
  assert.deepEqual(
    ctx.forge.createdReviews[1]!.comments.map((comment) => [comment.line, comment.body.split("\n")[0]]),
    [[2, "**[P1] 日志里打印了密钥**"]],
    "归给历史的那条沉默,同一处的新问题照常发行级评论",
  );
  assert.deepEqual(findingRows(ctx.db.path).slice(1), [
    {
      title: "余额校验被删掉",
      disposition: "resolved",
      commentId: "comment-1",
      continuedFrom: null,
    },
    { title: "日志里打印了密钥", disposition: "unknown", commentId: "comment-2", continuedFrom: null },
  ]);

  // 判据落轨迹:只记是哪条历史。组自己的合并理由说的是组内那几条为什么是一回事,它没
  // 解释过这一次为什么不折叠,摆进判据会读成 agent 给过这个说法(评审复核 2026-09-09)。
  const notFolded = trace(ctx.db.path).filter((event) => event.kind === "finding_not_folded");
  assert.equal(notFolded.length, 1);
  assert.deepEqual(notFolded[0]!.payload["criteria"], { kind: "agent_differs", history: 1 });

  // 同一「文件 + 指纹」下两条 Identity:阶段汇总与参与条数都各算一条。
  const store = openStore(ctx.db.path);
  const summary = store.stageSummary({
    owner: EVENT.owner,
    repo: EVENT.repo,
    pullNumber: EVENT.number,
  });
  const participation = store.modelParticipation(
    "2000-01-01T00:00:00.000Z",
    "2999-01-01T00:00:00.000Z",
  );
  store.close();
  assert.deepEqual(
    summary.findings.map((finding) => [finding.title, finding.disposition]),
    [
      ["日志里打印了密钥", "unknown"],
      ["余额校验被删掉", "resolved"],
    ],
    "同一「文件 + 指纹」下两条 Identity 各算一条",
  );
  assert.deepEqual(participation, [{ model: "model-a", findings: 2 }]);
});

test("合并 agent 收到的位置提示只给指纹命中的那条历史", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉"), AT(14, "mod 加了 0")]);

  const merge = scriptedMergeAgent([
    { members: [0], reason: "先各成一组" },
    { members: [1], reason: "先各成一组" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "余额校验被删掉"), AT(2, "日志里打印了密钥")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  // 第 1 条历史在第 2 行,本轮两条都落在那一处;第 2 条历史在第 14 行,一条都够不着。
  assert.deepEqual(merge.requests[0]!.sameSpot, { 1: [0, 1] });
});

test("合并 agent 不可用的那一轮:同一处的新问题仍按指纹并进旧条,轨迹记回退", async () => {
  const ctx = setup();
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  dispose(ctx.db.path, ctx.forge, "comment-1");

  const merge = scriptedMergeAgent([], { failure: "合并 agent 跑挂了" });
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "余额校验被删掉"), AT(2, "日志里打印了密钥")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(ctx.forge.createdReviews[1]!.comments, [], "退回指纹折叠:那一处不再打扰");
  const events = trace(ctx.db.path);
  assert.equal(events.filter((event) => event.kind === "merge_fallback").length, 1);
  assert.equal(events.filter((event) => event.kind === "finding_not_folded").length, 0);
  assert.deepEqual(events.find((event) => event.kind === "finding_folded")!.payload["criteria"], {
    kind: "fingerprint",
  });

  const store = openStore(ctx.db.path);
  const summary = store.stageSummary({
    owner: EVENT.owner,
    repo: EVENT.repo,
    pullNumber: EVENT.number,
  });
  store.close();
  assert.equal(summary.findings.length, 1, "回退档的 Identity 与这一票之前逐字一致");
});

/*
 * 同一处两条 Identity 之后的写入侧(ADR 0030,issue #307 的续)。
 *
 * 回填、自动处置与延续都要按承载它的那条 Forge 评论写,与读侧的 `identityKey` 同一个键:
 * 按「文件 + 指纹」扫会把 A 的状态写到 B 的行上,B 于是无声无息地被处置掉。
 */

/**
 * 同一处的两条 Identity:第一轮报出 A,第二轮 agent 把同一行上的另一条判为不同问题,
 * B 因此自己发一条评论(`comment-2`)。两轮的评论都留在 Forge 上当既有评论。
 * `disposeA` 即第一轮那条先被人驳回。
 */
async function twoAtOneSpot(
  ctx: ReturnType<typeof setup>,
  options: { disposeA?: boolean } = {},
): Promise<void> {
  await firstRun(ctx, [AT(2, "余额校验被删掉")]);
  if (options.disposeA === true) dispose(ctx.db.path, ctx.forge, "comment-1");
  const merge = scriptedMergeAgent((request) => [
    { members: [0], history: [request.history![0]!.id], reason: "还是那处余额校验" },
    { members: [1], reason: "日志里打印密钥是另一个问题" },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(2, "余额校验被删掉"), AT(2, "日志里打印了密钥")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });
  carryComments(ctx);
}

/** 按历史条目的标题给不同的复核结论:同一处的两条要分别对待。 */
function verdictByTitle(model: string, verdicts: Record<string, ReviewVerdict>): Reviewer {
  const scripted = scriptedReviewer(model, []);
  return {
    model,
    review: async (input) => ({
      ...(await scripted.review(input)),
      verdicts: input.history.map((entry) => ({
        findingId: entry.id,
        verdict: verdicts[entry.title] ?? ("unclear" as const),
      })),
    }),
  };
}

/** 落库的每条 Finding:标题、处置、评论与「交接未完成」标记。 */
function dispositionRows(
  dbPath: string,
): { title: unknown; disposition: string; commentId: unknown; handoffPending: unknown }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT title, disposition, comment_id, handoff_pending FROM finding ORDER BY id")
        .all() as unknown as Record<string, unknown>[]
    ).map((row) => ({
      title: row["title"],
      disposition: String(row["disposition"]),
      commentId: row["comment_id"],
      handoffPending: row["handoff_pending"],
    }));
  } finally {
    db.close();
  }
}

test("第三轮回填:A 那条评论的已 resolve 不写到同一处 B 的行上", async () => {
  const ctx = setup();
  await twoAtOneSpot(ctx, { disposeA: true });

  // 第三轮什么都不报:回填是这一轮唯一碰到那两行的写入。
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [verdictReviewer("model-a", "present")],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
  });

  assert.deepEqual(
    dispositionRows(ctx.db.path).map((row) => [row.title, row.disposition, row.commentId]),
    [
      ["余额校验被删掉", "resolved", "comment-1"],
      ["余额校验被删掉", "resolved", "comment-1"],
      ["日志里打印了密钥", "unresolved", "comment-2"],
    ],
    "B 的评论还开着,它不该跟着 A 的驳回一起被记成已处置",
  );

  const store = openStore(ctx.db.path);
  const summary = store.stageSummary({
    owner: EVENT.owner,
    repo: EVENT.repo,
    pullNumber: EVENT.number,
  });
  store.close();
  assert.deepEqual(
    summary.findings.map((finding) => [finding.title, finding.disposition]),
    [
      ["日志里打印了密钥", "unresolved"],
      ["余额校验被删掉", "resolved"],
    ],
  );
});

test("复核判已修只处置那一条:同一处另一条的评论不被 resolve", async () => {
  const ctx = setup();
  await twoAtOneSpot(ctx);

  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      verdictByTitle("model-a", { 余额校验被删掉: "fixed", 日志里打印了密钥: "present" }),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
  });

  assert.deepEqual(ctx.forge.resolvedIds, ["comment-1"], "只该 resolve 判已修的那条评论");
  assert.deepEqual(
    dispositionRows(ctx.db.path).map((row) => [row.title, row.disposition, row.commentId]),
    [
      ["余额校验被删掉", "fixed", "comment-1"],
      ["余额校验被删掉", "fixed", "comment-1"],
      ["日志里打印了密钥", "unresolved", "comment-2"],
    ],
  );
});

test("所在文件回退:同一处的两条各自自动处置,两条评论都 resolve", async () => {
  const ctx = setup();
  await twoAtOneSpot(ctx);
  // 第三轮把 src/m.js 改回 base 的内容:它不在 base..head 的 diff 里,两条历史谁都复核不到。
  ctx.forge.pullRequest.headSha = ctx.repo.commitToBranch("feature", { "src/m.js": BASE_M });
  ctx.changedFiles.splice(0, 1);

  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
  });

  assert.deepEqual([...ctx.forge.resolvedIds].sort(), ["comment-1", "comment-2"]);
  assert.deepEqual(
    dispositionRows(ctx.db.path).map((row) => [row.title, row.disposition]),
    [
      ["余额校验被删掉", "fixed"],
      ["余额校验被删掉", "fixed"],
      ["日志里打印了密钥", "fixed"],
    ],
    "两条 Identity 都落在回退掉的文件上,各自被处置",
  );
  const traced = trace(ctx.db.path).find((event) => event.kind === "history_auto_disposed");
  assert.equal((traced!.payload["deleted"] as number[]).length, 0);
  assert.equal((traced!.payload["reverted"] as number[]).length, 2);
});

test("延续 B:只 resolve B 的旧评论,同一处的 A 留在未处置", async () => {
  const ctx = setup();
  await twoAtOneSpot(ctx);
  // 那一行被改写:两条历史的旧指纹在本轮 head 上都算不出,承接谁只由 agent 说了算。
  rewriteHead(ctx, HEAD_M.replace("return a - b - 1;", "return a - b - 3;"));

  const merge = scriptedMergeAgent((request) => [
    {
      members: [0],
      history: [request.history!.find((entry) => entry.title === "日志里打印了密钥")!.id],
      reason: "打印密钥的那处挪到了这里",
    },
  ]);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "日志里打印了密钥")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: merge,
  });

  assert.deepEqual(ctx.forge.resolvedIds, ["comment-2"], "交接的是 B 的旧评论");
  assert.deepEqual(
    dispositionRows(ctx.db.path).map((row) => [row.title, row.disposition, row.commentId]),
    [
      ["余额校验被删掉", "unresolved", "comment-1"],
      ["余额校验被删掉", "unresolved", "comment-1"],
      ["日志里打印了密钥", "continued", "comment-2"],
      ["日志里打印了密钥", "unknown", "comment-3"],
    ],
    "A 只是与 B 同处一行,它不该被这次交接带走",
  );
  assert.equal(findingRows(ctx.db.path)[3]!.continuedFrom, ctx.forge.publishedComments[1]!.htmlUrl);

  const store = openStore(ctx.db.path);
  const summary = store.stageSummary({
    owner: EVENT.owner,
    repo: EVENT.repo,
    pullNumber: EVENT.number,
  });
  store.close();
  assert.deepEqual(
    summary.findings.map((finding) => [finding.title, finding.disposition]),
    [
      ["余额校验被删掉", "unresolved"],
      ["日志里打印了密钥", "unknown"],
    ],
    "A 仍在阶段汇总里未处置,延续只带走 B 那一条",
  );
});

test("交接未完成的标记只落在 B 那一条上,下一轮重试清掉它", async () => {
  const ctx = setup();
  await twoAtOneSpot(ctx);
  rewriteHead(ctx, HEAD_M.replace("return a - b - 1;", "return a - b - 3;"));

  const carry = (request: MergeAgentRequest) => [
    {
      members: [0],
      history: [request.history!.find((entry) => entry.title === "日志里打印了密钥")!.id],
      reason: "打印密钥的那处挪到了这里",
    },
  ];
  const resolve = ctx.forge.forge.resolveComment;
  ctx.forge.forge.resolveComment = async () => {
    throw new Error("Gitea POST /pulls/comments/2/resolve failed: 502");
  };
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [scriptedReviewer("model-a", [AT(14, "日志里打印了密钥")])],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    mergeAgent: scriptedMergeAgent(carry),
  });

  assert.deepEqual(
    dispositionRows(ctx.db.path).map((row) => [row.title, row.handoffPending]),
    [
      ["余额校验被删掉", null],
      ["余额校验被删掉", null],
      ["日志里打印了密钥", 1],
      ["日志里打印了密钥", null],
    ],
    "待办标记只属于交接中的那条 Identity",
  );

  // 下一轮收尾时重试成功:标记清掉,A 全程没被碰过。
  ctx.forge.forge.resolveComment = resolve;
  carryComments(ctx);
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [verdictReviewer("model-a", "present")],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
  });

  assert.deepEqual(ctx.forge.resolvedIds, ["comment-2"]);
  assert.deepEqual(
    dispositionRows(ctx.db.path).map((row) => [row.title, row.disposition, row.handoffPending]),
    [
      ["余额校验被删掉", "unresolved", null],
      ["余额校验被删掉", "unresolved", null],
      ["日志里打印了密钥", "continued", null],
      ["日志里打印了密钥", "unresolved", null],
    ],
  );
});

/*
 * 本轮的合并 agent 用哪一处模型(issue #304,ADR 0029)。
 *
 * 这一段打在服务的注入边界上而不是 `runReview` 上:选哪一处模型是 `webhook/server.ts`
 * 开跑时的解析,`buildMergeAgent` 收到的那份运行模型就是这一轮合并 agent 用的模型与
 * 档位。断言只看它与轮次落库的那一处,不看合并本身怎么分组——那是上面几十条用例的事。
 */

/** 一次合并 agent 建出来时收到的模型快照。一条都没有即这一轮的合并走算法档。 */
type MergeBuild = { provider: string; model: string; thinkingLevel?: string };

function recordMergeBuilds(builds: MergeBuild[]): PanelHarnessOptions["buildMergeAgent"] {
  return (config) => {
    builds.push({
      provider: config.runtimeModel.provider,
      model: config.runtimeModel.id,
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
    });
    return scriptedMergeAgent([]);
  };
}

/** 这一轮落库的辅助模型引用。列是 JSON,没有即 null。 */
function runAuxiliaryModel(dbPath: string): unknown {
  const raw = new DatabaseSync(dbPath);
  try {
    const row = raw
      .prepare("SELECT auxiliary_model FROM review_run ORDER BY id DESC LIMIT 1")
      .get();
    const value = row?.["auxiliary_model"];
    return value === null || value === undefined ? null : JSON.parse(String(value));
  } finally {
    raw.close();
  }
}

/**
 * 直接写审查策略里那一处辅助模型。面板写链与 store 的兜底都只收当前可用的模型,这里要造的
 * 正是「解析得出、却跑不了」的那一处,所以绕过 store 直写那一行。
 */
function setGlobalAuxiliaryModel(dbPath: string, spec: unknown): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw
      .prepare(
        `INSERT INTO global_setting (key, value) VALUES ('auxiliary_model', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(spec));
  } finally {
    raw.close();
  }
}

/**
 * 起一份就绪的实例,按需设一处辅助模型,跑一轮,回这一轮建出来的合并 agent 与落库的
 * 那一处。一轮一份实例:同一个 head 投递两次只跑得起来一轮。
 */
async function runOnceWithAuxiliary(
  auxiliary?: { provider: string; model: string; thinkingLevel?: string },
): Promise<{ builds: MergeBuild[]; frozen: unknown }> {
  const builds: MergeBuild[] = [];
  const h = await startPanelHarness({ buildMergeAgent: recordMergeBuilds(builds) });
  seedAvailableModelService(h, HARNESS_SPEC.provider, [HARNESS_SPEC.model]);
  seedAvailableModelService(h, "second", ["other-model"], { reasoning: true });
  const hook = seedHistoricalRepo(h);
  if (auxiliary !== undefined) setGlobalAuxiliaryModel(h.db.path, auxiliary);

  assert.equal((await h.deliverViaHook(h.repo.headSha, hook)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  return { builds, frozen: runAuxiliaryModel(h.db.path) };
}

test("没设辅助模型时合并 agent 用生效组合的第一个", async () => {
  const { builds, frozen } = await runOnceWithAuxiliary();
  assert.deepEqual(builds[0], { provider: "test", model: "global-model" });
  assert.deepEqual(frozen, HARNESS_SPEC);
});

test("显式设了辅助模型时合并 agent 用它,不再看组合的排列顺序", async () => {
  const auxiliary = { provider: "second", model: "other-model", thinkingLevel: "high" };
  const { builds, frozen } = await runOnceWithAuxiliary(auxiliary);
  assert.deepEqual(builds[0], {
    provider: "second",
    model: "other-model",
    thinkingLevel: "high",
  });
  assert.deepEqual(frozen, auxiliary);
});

test("开跑后改辅助模型不影响本轮:轮次落的是开跑时解析出的那一处", async () => {
  const builds: MergeBuild[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await startPanelHarness({
    buildMergeAgent: recordMergeBuilds(builds),
    // Reviewer 停在这里,用例趁这一轮还在跑的时候改配置。
    buildReviewers: (plans) =>
      plans.map((plan) => {
        const scripted = scriptedReviewer(plan.spec.model, []);
        return {
          ...scripted,
          review: async (task) => {
            await held;
            return scripted.review(task);
          },
        };
      }),
  });
  seedAvailableModelService(h, HARNESS_SPEC.provider, [HARNESS_SPEC.model]);
  seedAvailableModelService(h, "second", ["other-model"]);
  const hook = seedHistoricalRepo(h);

  assert.equal((await h.deliverViaHook(h.repo.headSha, hook)).status, 200);
  setGlobalAuxiliaryModel(h.db.path, { provider: "second", model: "other-model" });
  release();
  await h.settledAtLeast(1);

  // 这一轮的合并 agent 与落库的那一处都是开跑时的解析结果。
  assert.deepEqual(builds[0], { provider: "test", model: "global-model" });
  assert.deepEqual(runAuxiliaryModel(h.db.path), HARNESS_SPEC);
});

test("解析出的辅助模型跑不了时不建合并 agent,这一轮的合并走算法档", async () => {
  // 没有这一家模型服务:解析得出这一处,却缺凭据与运行模型。
  const auxiliary = { provider: "ghost", model: "missing-model" };
  const { builds, frozen } = await runOnceWithAuxiliary(auxiliary);
  assert.deepEqual(builds, [], "跑不了即缺席,不建合并 agent");
  // 落库的仍是开跑时解析出的那一处:续跑据它,不重新解析。
  assert.deepEqual(frozen, auxiliary);
});

test("辅助模型选了这个模型不支持的档位时不建合并 agent", async () => {
  // 播种的模型不声明推理能力,它只支持「关闭」:选 high 即跑不了,与两条发起链路同一个判据。
  const auxiliary = { ...HARNESS_SPEC, thinkingLevel: "high" };
  const { builds, frozen } = await runOnceWithAuxiliary(auxiliary);
  assert.deepEqual(builds, [], "档位不支持即缺席,不建合并 agent");
  assert.deepEqual(frozen, auxiliary);
});
