/**
 * 处置率统计的口径(issue #36,ADR 0006;主维度改仓库 × category 见 issue #169
 * 与 ADR 0015)。表格驱动:每条口径一组入库数据对一个期望矩阵,模型那一维只剩
 * 参与条数。SQLite 临时库是既定测试缝,数据直接经 store 种入。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  openStore,
  type DispositionCell,
  type FindingRecord,
  type ModelParticipation,
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
    /** 报出它的模型,按首报先后。参与条数按它们各计一次(ADR 0015)。 */
    models?: string[];
  },
): FindingRecord {
  const { models, ...rest } = over;
  const base: FindingRecord = {
    file: "src/a.ts",
    line: 5,
    title: "有毛病",
    severity: "P0",
    category: "bug",
    description: "有毛病",
    attributions: (models ?? ["model-a"]).map((model) => ({
      model,
      severity: "P0" as const,
      category: "bug",
      description: "有毛病",
    })),
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
  opts: {
    owner?: string;
    repo?: string;
    pr?: number;
    startedAt: string;
    findings: FindingRecord[];
  },
): void {
  const runId = store.startRun({
    owner: opts.owner ?? "acme",
    repo: opts.repo ?? "widgets",
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
  /** 缺省即这一条不验参与条数。 */
  participation?: ModelParticipation[];
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
        owner: "acme",
        repo: "widgets",
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
        owner: "acme",
        repo: "widgets",
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
        owner: "acme",
        repo: "widgets",
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
        owner: "acme",
        repo: "widgets",
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
        owner: "acme",
        repo: "widgets",
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
    name: "已关闭阶段新增 Review Run 继承关闭状态,新 Finding 进入关闭档",
    seed: (store) => {
      seedRun(store, { pr: 7, startedAt: T1, findings: [] });
      store.markPullRequestState("acme", "widgets", 7, "closed");
      seedRun(store, {
        pr: 7,
        startedAt: T2,
        findings: [finding({ fingerprint: "fp-after-close" })],
      });
      assert.equal(
        store.listStages({ offset: 0, limit: 30 })[0]?.status,
        "closed",
        "新一轮必须保留阶段的关闭状态",
      );
    },
    expected: [
      {
        owner: "acme",
        repo: "widgets",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 1,
        unknownOpen: 0,
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
        owner: "acme",
        repo: "widgets",
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
    // 同一条。跨 PR 的同指纹仍是两条——一个 pull request 是一个审查阶段,阶段之间
    // 不折叠,但两个阶段都归在同一个仓库那一行上。
    name: "同指纹跨 PR 不折叠,同一 PR 里换个模型报出仍是同一条",
    seed: (store) => {
      seedRun(store, { pr: 7, startedAt: T1, findings: [finding({})] });
      seedRun(store, { pr: 7, startedAt: T2, findings: [finding({ models: ["model-b"] })] });
      seedRun(store, { pr: 8, startedAt: T1, findings: [finding({})] });
    },
    expected: [
      {
        owner: "acme",
        repo: "widgets",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 2,
      },
    ],
    // pr 7 那一条两个模型都报过,各计一次;pr 8 那条只有 model-a。
    participation: [
      { model: "model-a", findings: 2 },
      { model: "model-b", findings: 1 },
    ],
  },
  {
    // 主维度是仓库(ADR 0015):同一个 owner 下的两个仓库各成一行,同名分类不合并。
    name: "两个仓库各成一行",
    seed: (store) => {
      seedRun(store, { repo: "widgets", startedAt: T1, findings: [finding({})] });
      seedRun(store, {
        repo: "gadgets",
        startedAt: T1,
        findings: [finding({ disposition: "resolved" })],
      });
    },
    expected: [
      {
        owner: "acme",
        repo: "gadgets",
        category: "bug",
        resolved: 1,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 0,
      },
      {
        owner: "acme",
        repo: "widgets",
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
    // 一条 Finding 由几个模型合报时分母只加一次(否则同一处被重复计入,比率不可解释),
    // 参与条数则每个归属各加一。
    name: "多模型归属的一条 Finding 分母只计一次,参与条数各计一次",
    seed: (store) => {
      seedRun(store, {
        startedAt: T1,
        findings: [finding({ models: ["model-a", "model-b", "model-c"] })],
      });
    },
    expected: [
      {
        owner: "acme",
        repo: "widgets",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 1,
      },
    ],
    participation: [
      { model: "model-a", findings: 1 },
      { model: "model-b", findings: 1 },
      { model: "model-c", findings: 1 },
    ],
  },
  {
    // 参与条数与分母同一批 Identity:已延续那条整条退出,fallback 与窗外的也不算。
    name: "参与条数不数已延续、fallback 与窗外的那些",
    seed: (store) => {
      seedRun(store, { startedAt: T0, findings: [finding({ fingerprint: "fp-old" })] });
      seedRun(store, {
        startedAt: T2,
        findings: [
          finding({ fingerprint: "fp-continued", disposition: "continued" }),
          finding({
            fingerprint: "fp-body",
            line: 30,
            groupIndex: 1,
            placement: "body",
            models: ["model-b"],
          }),
          finding({ fingerprint: "fp-live", line: 40, groupIndex: 2, models: ["model-b"] }),
        ],
      });
    },
    window: [T1, T3],
    expected: [
      {
        owner: "acme",
        repo: "widgets",
        category: "bug",
        resolved: 0,
        fixed: 0,
        unresolved: 0,
        unknownClosed: 0,
        unknownOpen: 1,
      },
    ],
    participation: [{ model: "model-b", findings: 1 }],
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
        owner: "acme",
        repo: "widgets",
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
      if (c.participation !== undefined) {
        assert.deepEqual(store.modelParticipation(from, to), c.participation);
      }
    } finally {
      store.close();
      db.cleanup();
    }
  });
}

/** 读两张表里的 model 列。 */
function models(store: Store): { finding: string[]; outcome: string[] } {
  return {
    finding: store.modelParticipation(...WIDE).map((entry) => entry.model),
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
    findings: [finding({ models: [model], fingerprint: `fp-${model}` })],
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
    // 主维度是仓库,两条落在同一格里;它们没有互相折叠这件事由分母的 2 说了算。
    assert.equal(reopened.dispositionStats(...WIDE)[0]?.unknownOpen, 2, "两条各自独立");
    reopened.close();
  } finally {
    db.cleanup();
  }
});
