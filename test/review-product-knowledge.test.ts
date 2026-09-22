/**
 * 产品知识进 Review Run 的两条路(CONTEXT.md 产品知识,issue #362,父 spec #357)。
 *
 * 边界是 `runReview` 与一个受控 Reviewer:编排层交下去的是什么、`query_knowledge` 的一次
 * 查询回的是什么,都在这个注入边界上看得见。提示怎么渲染那三行由 `reviewer-contract` 钉住,
 * 这里只钉编排层——仓库归在产品下才有目录与查询回调,不在产品下时请求形状一格不变。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store/index.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { setup as setupRepo } from "./support/batch-run.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups = testCleanups();

const BASE_CALC = `export function add(a: number, b: number) {
  return a + b;
}

export function sub(a: number, b: number) {
  return a - b;
}
`;
const HEAD_CALC = BASE_CALC.replace("return a - b;", "return a - b - 1;");

const EVENT = { owner: "acme", repo: "widgets", number: 7 };
const REPO_ID = 101;

async function setup() {
  const { cache, db, forge } = setupRepo(cleanups, {
    tree: { base: { "src/calc.ts": BASE_CALC }, head: { "src/calc.ts": HEAD_CALC } },
    changedFiles: [{ path: "src/calc.ts", status: "modified" }],
  });
  const store = openStore(db.path);
  try {
    await store.registerRepo({
      repoId: REPO_ID,
      owner: EVENT.owner,
      repo: EVENT.repo,
      generation: 1,
      key: "k".repeat(64),
    });
  } finally {
    await store.close();
  }
  return {
    cache,
    db,
    forge,
    deps: { forge: forge.forge, cacheDir: cache.dir, dbPath: db.path, repoId: REPO_ID },
  };
}

/** 建一个产品、把这个仓库归进去,并写下一份四条的产品知识。回产品 id。 */
async function seedProduct(dbPath: string): Promise<number> {
  const store = openStore(dbPath);
  const at = "2026-09-17T00:00:00.000Z";
  try {
    const product = await store.createProduct({ name: "报销系统", createdAt: at });
    assert.equal(await store.attachProductRepo(product.id, REPO_ID, at), "attached");
    const write = async (
      one: Pick<Parameters<typeof store.writeProductKnowledge>[0], "kind" | "name" | "body"> & {
        topic?: string | null;
      },
    ): Promise<number> =>
      (await store.writeProductKnowledge({
        productId: product.id,
        topic: one.topic ?? null,
        avoided: [],
        options: null,
        consequences: null,
        annotations: [],
        at,
        sessionId: null,
        ...one,
      }))!.id;
    await write({
      kind: "term",
      name: "报销系统",
      topic: "定位",
      body: "员工提交票据、财务审批并打款的内部系统。",
    });
    await write({ kind: "term", name: "报销单", body: "一次报销申请的载体,金额以分记。" });
    await write({ kind: "relationship", name: "", body: "web 的提交走 api 的报销单接口。" });
    await write({ kind: "decision", name: "金额用整数分表示", body: "浮点会攒出误差。" });
    return product.id;
  } finally {
    await store.close();
  }
}

const FINDING = {
  file: "src/calc.ts",
  line: 6,
  severity: "P0" as const,
  category: "bug" as const,
  description: "sub() 多减了 1",
};

test("仓库归在产品下:每批提示带目录,query_knowledge 按名字回整条", async () => {
  const { db, deps } = await setup();
  await seedProduct(db.path);

  const reviewer = scriptedReviewer("stub-model", [FINDING], {
    reads: [{ names: ["报销单", "金额用整数分表示"] }, { relationships: true }],
  });
  await runReview(EVENT, { ...deps, reviewers: [reviewer] });

  // 目录三行:定位给正文,术语与生效决策只给名字,仓库关系没有名字因此不在目录里。
  assert.deepEqual(reviewer.calls[0]!.productKnowledge, {
    positioning: "员工提交票据、财务审批并打款的内部系统。",
    terms: ["报销单"],
    decisions: ["金额用整数分表示"],
  });

  // 按名字问的那一次:术语与决策各回整条,正文一字不少。
  const byName = reviewer.knowledgeReads[0]!;
  assert.deepEqual(
    byName.product.map((one) => ({ kind: one.kind, name: one.name, body: one.body })),
    [
      { kind: "term", name: "报销单", body: "一次报销申请的载体,金额以分记。" },
      { kind: "decision", name: "金额用整数分表示", body: "浮点会攒出误差。" },
    ],
  );
  // 仓库层不由这条路回:评审规则与项目事实已经整段注入了本批提示。
  assert.deepEqual(byName.repo, []);

  // relationships: true 那一次整段回仓库关系,别的种类一条都不带。
  assert.deepEqual(
    reviewer.knowledgeReads[1]!.product.map((one) => ({ kind: one.kind, body: one.body })),
    [{ kind: "relationship", body: "web 的提交走 api 的报销单接口。" }],
  );
});

test("产品写下的条目当轮就读得到:目录在开跑时算,正文按名字现取", async () => {
  const { db, deps } = await setup();
  const productId = await seedProduct(db.path);

  // Reviewer 跑着的时候又写下一条决策(写下即生效,ADR 0035)。
  const reviewer = scriptedReviewer("stub-model", [FINDING], {
    reads: [{ names: ["审批只留一级"] }],
  });
  const store = openStore(db.path);
  try {
    await store.writeProductKnowledge({
      productId,
      kind: "decision",
      name: "审批只留一级",
      body: "两级审批没人真的看第二眼。",
      topic: null,
      avoided: [],
      options: null,
      consequences: null,
      annotations: [],
      at: "2026-09-17T01:00:00.000Z",
      sessionId: null,
    });
  } finally {
    await store.close();
  }

  await runReview(EVENT, { ...deps, reviewers: [reviewer] });

  assert.deepEqual(
    reviewer.knowledgeReads[0]!.product.map((one) => one.name),
    ["审批只留一级"],
  );
});

test("仓库不在任何产品下:目录与查询回调都不交下去", async () => {
  const { deps } = await setup();

  const reviewer = scriptedReviewer("stub-model", [FINDING], { reads: [{ relationships: true }] });
  await runReview(EVENT, { ...deps, reviewers: [reviewer] });

  assert.equal(reviewer.calls[0]!.productKnowledge, undefined);
  // 回调也不在:桩的那一次查询一条都没发出去。
  assert.deepEqual(reviewer.knowledgeReads, []);
});

test("产品建了但一条都没写下:与不在产品下同一条路径", async () => {
  const { db, deps } = await setup();
  const store = openStore(db.path);
  try {
    const product = await store.createProduct({ name: "空产品", createdAt: "2026-09-17T00:00:00.000Z" });
    await store.attachProductRepo(product.id, REPO_ID, "2026-09-17T00:00:00.000Z");
  } finally {
    await store.close();
  }

  const reviewer = scriptedReviewer("stub-model", [FINDING]);
  await runReview(EVENT, { ...deps, reviewers: [reviewer] });

  assert.equal(reviewer.calls[0]!.productKnowledge, undefined);
});

test("一次 query_knowledge 调用进这一轮的审查轨迹", async () => {
  const { db, deps } = await setup();
  await seedProduct(db.path);

  // 子进程把每次工具调用按 `tool_call` 转发上来(issue #171);知识查询与别的工具同一条路。
  const reviewer = scriptedReviewer("stub-model", [FINDING], {
    reads: [{ names: ["报销单"] }],
    events: [
      {
        kind: "tool_call",
        tool: "query_knowledge",
        args: { names: ["报销单"] },
        durationMs: 3,
        isError: false,
        error: null,
        resultLength: 42,
      },
    ],
  });
  await runReview(EVENT, { ...deps, reviewers: [reviewer] });

  const rows = new DatabaseSync(db.path, { readOnly: true })
    .prepare("SELECT payload FROM review_trace WHERE scope = 'reviewer' AND kind = 'tool_call'")
    .all() as unknown as { payload: string }[];
  const tools = rows.map((row) => (JSON.parse(row.payload) as { tool: string }).tool);
  assert.deepEqual(tools, ["query_knowledge"]);
});
