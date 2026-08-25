/**
 * 处置率统计的口径(issue #36,ADR 0006)。表格驱动:每条口径一组入库数据对一个
 * 期望矩阵。SQLite 临时库是既定测试缝,数据直接经 store 种入。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  openStore,
  type DispositionCell,
  type FindingRecord,
  type Store,
} from "../src/review/store.ts";
import { makeDbPath } from "./support/git-fixture.ts";

const WIDE: [string, string] = ["2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"];

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-10T00:00:00.000Z";
const T2 = "2026-08-12T00:00:00.000Z";
const T3 = "2026-08-14T00:00:00.000Z";

function finding(
  over: Partial<Omit<FindingRecord, "fingerprint">> & {
    fingerprint?: string | undefined;
    /** 首报的模型。统计矩阵那一格取它(ADR 0015)。 */
    model?: string;
  },
): FindingRecord {
  const { model, ...rest } = over;
  const base: FindingRecord = {
    file: "src/a.ts",
    line: 5,
    title: "有毛病",
    severity: "P0",
    category: "bug",
    description: "有毛病",
    attributions: [
      { model: model ?? "model-a", severity: "P0", category: "bug", description: "有毛病" },
    ],
    groupIndex: 0,
    disposition: "unknown",
    placement: "inline",
    fingerprint: "fp-1",
  };
  const merged = { ...base, ...rest };
  // exactOptionalPropertyTypes:显式的 undefined 不能落在可选字段上,删掉这个键。
  if ("fingerprint" in rest && rest.fingerprint === undefined) delete merged.fingerprint;
  return merged as FindingRecord;
}

/** 种一轮 Review Run 连同它的 finding。 */
function seedRun(
  store: Store,
  opts: { pr?: number; startedAt: string; findings: FindingRecord[] },
): void {
  const runId = store.startRun({
    owner: "acme",
    repo: "widgets",
    pullNumber: opts.pr ?? 7,
    headSha: `sha-${opts.startedAt}`,
    startedAt: opts.startedAt,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: opts.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: [],
    findings: opts.findings,
  });
}

type Case = {
  name: string;
  seed: (store: Store) => void;
  window?: [string, string];
  expected: DispositionCell[];
};

const CASES: Case[] = [
  {
    name: "同一处 Finding 多轮多行折叠成一条,任一行 resolved 即已处置",
    seed: (store) => {
      seedRun(store, { startedAt: T1, findings: [finding({})] });
      seedRun(store, { startedAt: T2, findings: [finding({ disposition: "unresolved" })] });
      seedRun(store, { startedAt: T3, findings: [finding({ disposition: "resolved" })] });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 1,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 0,
      },
    ],
  },
  {
    name: "「已修复」自成一列,同一处上人工处置盖过自动处置",
    seed: (store) => {
      seedRun(store, { startedAt: T1, findings: [finding({ disposition: "fixed" })] });
      // 同一处先被自动处置,人后来又在面板上 resolve:这一条算人工那一列。
      seedRun(store, {
        startedAt: T1,
        findings: [finding({ fingerprint: "fp-2", disposition: "fixed" })],
      });
      seedRun(store, {
        startedAt: T2,
        findings: [finding({ fingerprint: "fp-2", disposition: "resolved" })],
      });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 1,
        fixed: 1,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 0,
      },
    ],
  },
  {
    // 「已延续」只是位置的交接(CONTEXT.md 已延续):旧那一条整条退出统计,新位置那条
    // 自成一条 Identity,分母因此不加。整条退出而不是只跳过那一行——同一条上更早的
    // 未处置行还在,只过滤那一行会把它原样带回分母。
    name: "已延续不进分子分母,新位置那条独立计一条",
    seed: (store) => {
      seedRun(store, { startedAt: T1, findings: [finding({})] });
      seedRun(store, {
        startedAt: T2,
        findings: [
          finding({ disposition: "continued" }),
          finding({ fingerprint: "fp-2", line: 20, groupIndex: 1 }),
        ],
      });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 1,
      },
    ],
  },
  {
    name: "fallback(body)排除在统计外,即便它被标了 resolved",
    seed: (store) => {
      seedRun(store, {
        startedAt: T1,
        findings: [finding({ placement: "body", disposition: "resolved" })],
      });
    },
    expected: [],
  },
  {
    name: "指纹算不出的行各算一条,不互相折叠",
    seed: (store) => {
      seedRun(store, {
        startedAt: T1,
        findings: [
          finding({ fingerprint: undefined, line: 3 }),
          finding({ fingerprint: undefined, line: 9, groupIndex: 1 }),
        ],
      });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 2,
      },
    ],
  },
  {
    name: "unknown 按 PR 状态分流:已关闭进分母档,开放只作展示",
    seed: (store) => {
      seedRun(store, { pr: 7, startedAt: T1, findings: [finding({})] });
      seedRun(store, { pr: 8, startedAt: T1, findings: [finding({ fingerprint: "fp-8" })] });
      store.markPullRequestState("acme", "widgets", 7, "closed");
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 1,
        unknownOpen: 1,
      },
    ],
  },
  {
    name: "时间窗按同一处 Finding 首次报出那轮归属,再次报出不改归属",
    seed: (store) => {
      // fp-old 首见于窗外,窗内再次报出也不算进来;fp-new 首见于窗内。
      seedRun(store, { startedAt: T0, findings: [finding({ fingerprint: "fp-old" })] });
      seedRun(store, {
        startedAt: T2,
        findings: [finding({ fingerprint: "fp-old" }), finding({ fingerprint: "fp-new" })],
      });
    },
    window: [T1, T3],
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 1,
      },
    ],
  },
  {
    // Identity 的键是 PR + 文件 + 指纹,不含模型(ADR 0015):换个模型报同一处仍是
    // 同一条,那一格的模型取首报的。跨 PR 的同指纹仍是两条。
    name: "同指纹跨 PR 不折叠,同一 PR 里换个模型报出仍是同一条",
    seed: (store) => {
      seedRun(store, { pr: 7, startedAt: T1, findings: [finding({})] });
      seedRun(store, { pr: 7, startedAt: T2, findings: [finding({ model: "model-b" })] });
      seedRun(store, { pr: 8, startedAt: T1, findings: [finding({})] });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 2,
      },
    ],
  },
  {
    name: "category 跨轮漂移时以首次报出那轮为准",
    seed: (store) => {
      seedRun(store, { startedAt: T1, findings: [finding({ category: "bug" })] });
      seedRun(store, {
        startedAt: T2,
        findings: [finding({ category: "maintainability", disposition: "resolved" })],
      });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 1,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 0,
      },
    ],
  },
];

for (const c of CASES) {
  test(`口径:${c.name}`, () => {
    const db = makeDbPath();
    const store = openStore(db.path);
    try {
      c.seed(store);
      const [from, to] = c.window ?? WIDE;
      assert.deepEqual(store.dispositionStats(from, to), c.expected);
    } finally {
      store.close();
      db.cleanup();
    }
  });
}

/** 读两张表里的 model 列。 */
function models(store: Store): { finding: string[]; outcome: string[] } {
  const cells = store.dispositionStats(...WIDE);
  return {
    finding: cells.map((cell) => cell.model),
    outcome: store.listRuns({ limit: 50 }).flatMap((run) => run.models.map((m) => m.model)),
  };
}

/** 种一轮带 outcome 的 Run,model 列直接写成传进来的值。 */
function seedWithModel(store: Store, model: string, at: string): void {
  const runId = store.startRun({
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    headSha: `sha-${model}-${at}`,
    startedAt: at,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: at,
    durationMs: 1,
    failed: false,
    outcomes: [
      {
        model,
        findingCount: 1,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
      },
    ],
    findings: [finding({ model, fingerprint: `fp-${model}` })],
  });
}

test("迁移不改写历史行:裸 model id 原样留着,与新标识各成一条", () => {
  const db = makeDbPath();
  try {
    // 升级前的一轮写裸 id,升级后的一轮写模型标识。provider 从库里恢复不出来,
    // 按当前模型组合反查会把历史错归到别家去,所以一律不回填(issue #73 的取舍)。
    const seed = openStore(db.path);
    seedWithModel(seed, "old-model", T1);
    seedWithModel(seed, "acme:old-model", T2);
    seed.close();

    const reopened = openStore(db.path);
    assert.deepEqual(models(reopened), {
      finding: ["acme:old-model", "old-model"],
      outcome: ["acme:old-model", "old-model"],
    });
    assert.equal(reopened.dispositionStats(...WIDE).length, 2, "两条各自独立");
    reopened.close();
  } finally {
    db.cleanup();
  }
});
