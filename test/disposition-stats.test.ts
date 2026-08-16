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
  over: Partial<Omit<FindingRecord, "fingerprint">> & { fingerprint?: string | undefined },
): FindingRecord {
  const base: FindingRecord = {
    model: "model-a",
    file: "src/a.ts",
    line: 5,
    severity: "P0",
    category: "bug",
    description: "有毛病",
    groupIndex: 0,
    disposition: "unknown",
    placement: "inline",
    fingerprint: "fp-1",
  };
  const merged = { ...base, ...over };
  // exactOptionalPropertyTypes:显式的 undefined 不能落在可选字段上,删掉这个键。
  if ("fingerprint" in over && over.fingerprint === undefined) delete merged.fingerprint;
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
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 0,
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
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 1,
      },
    ],
  },
  {
    name: "同指纹跨 PR、跨模型都不折叠:Identity 的键含 PR 与模型",
    seed: (store) => {
      seedRun(store, {
        pr: 7,
        startedAt: T1,
        findings: [finding({}), finding({ model: "model-b", groupIndex: 1 })],
      });
      seedRun(store, { pr: 8, startedAt: T1, findings: [finding({})] });
    },
    expected: [
      {
        model: "model-a",
        category: "bug",
        resolved: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 2,
      },
      {
        model: "model-b",
        category: "bug",
        resolved: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 1,
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

/** 回填用的模型组合。`old-model` 是历史行里的裸 model id。 */
const SPECS = [{ provider: "acme", model: "old-model" }];

/** 读两张表里的 model 列,回填的断言全落在它上面。 */
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

test("迁移:历史的裸 model id 回填成模型标识,两张表都改", () => {
  const db = makeDbPath();
  try {
    const seed = openStore(db.path);
    seedWithModel(seed, "old-model", T1);
    seed.close();

    const migrated = openStore(db.path, SPECS);
    assert.deepEqual(models(migrated), {
      finding: ["acme:old-model"],
      outcome: ["acme:old-model"],
    });
    migrated.close();

    // 同一个库再跑一次迁移,值不变。
    const again = openStore(db.path, SPECS);
    assert.deepEqual(models(again), {
      finding: ["acme:old-model"],
      outcome: ["acme:old-model"],
    });
    again.close();
  } finally {
    db.cleanup();
  }
});

test("迁移:已是新形态的值不被二次加工,配置里查不到的模型不动", () => {
  const db = makeDbPath();
  try {
    const seed = openStore(db.path);
    seedWithModel(seed, "acme:old-model", T1);
    seedWithModel(seed, "no-such-model", T2);
    seed.close();

    const migrated = openStore(db.path, SPECS);
    assert.deepEqual(models(migrated).finding.sort(), ["acme:old-model", "no-such-model"]);
    migrated.close();
  } finally {
    db.cleanup();
  }
});

test("迁移:回填后同一个模型在处置率统计里不裂成两条", () => {
  const db = makeDbPath();
  try {
    // 一轮在升级前(裸 id),一轮在升级后(模型标识),指纹不同即两处 Finding。
    const seed = openStore(db.path);
    seedWithModel(seed, "old-model", T1);
    seedWithModel(seed, "acme:old-model", T2);
    assert.equal(seed.dispositionStats(...WIDE).length, 2, "回填前是裂开的两条");
    seed.close();

    const migrated = openStore(db.path, SPECS);
    const cells = migrated.dispositionStats(...WIDE);
    assert.deepEqual(
      cells.map((cell) => [cell.model, cell.unknownOpen]),
      [["acme:old-model", 2]],
    );
    migrated.close();
  } finally {
    db.cleanup();
  }
});
