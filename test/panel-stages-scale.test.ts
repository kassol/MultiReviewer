/**
 * 阶段列表与阶段详情在几千个阶段下的样子(issue #183)。
 *
 * 打在面板 API 的 HTTP 缝上:阶段由 store 直接播种——这一票问的是读的那一侧。内容照
 * `panel-stages` / `panel-stage-detail` 的口径断言。
 *
 * 耗时量的是详情,而且量成相对值:同一个阶段的详情放在一个小库与一个几千个阶段的大库里
 * 各请求一次,两边差不多才叫「不随阶段总数增长」。列表不量——它那一页的开销由三十次阶段
 * 汇总与一次归并扫描组成,后者仍与阶段总数成正比(见 `src/AGENTS.md`)。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import { startPanelHarness, type PanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const OWNER = "scale-owner";
const REPO = "scale-repo";
/** 另一个仓库,用来验证仓库过滤在几千行里仍然只回它自己那几行。 */
const OTHER_OWNER = "other-owner";
const OTHER_REPO = "other-repo";

/** 大库里先垫这么多个阶段,它们比后面那批都旧,整页整页地排在后面。 */
const FILLER_STAGES = 2970;
/** 最新的这一批阶段:两轮加一条待处置的 Finding,列表第一页与详情都按它们断言。 */
const RICH_STAGES = 30;
const OTHER_STAGES = 3;
/** 服务端一页给多少行,与 `STAGES_PAGE` 一致。 */
const PAGE = 30;

type StageRow = {
  stageId: string;
  source: "pull-request" | "range-review";
  owner: string;
  repo: string;
  pullNumber: number | null;
  rangeReviewId: number | null;
  title: string | null;
  status: "active" | "closed";
  latestRunId: number | null;
  latestRunAt: string | null;
  latestRunFinishedAt: string | null;
  counts: { pending: number; resolved: number; fixed: number };
};

type StagesPage = { stages: StageRow[]; nextOffset: number | null };
type StageDetail = {
  stage: StageRow;
  groups: { sha: string; runs: { runId: number; headSha: string }[] }[];
};

type Store = ReturnType<typeof openStore>;

/** 播种用的时刻:一分钟一格,序号越大越新。 */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString();
}

/** 播种进行到哪里:时刻走到第几格,已经建出了哪些阶段(按建出的先后)。 */
type Progress = { minute: number; stageIds: string[] };

/** 一轮跑完的 Review Run。给了指纹就带一条待处置的 Finding,三个计数因此有东西可算。 */
function seedFinishedRun(
  store: Store,
  meta: {
    pullNumber: number;
    headSha: string;
    startedAt: string;
    owner?: string;
    repo?: string;
    title?: string;
    rangeReviewId?: number;
  },
  fingerprint?: string,
): void {
  const runId = store.startRun({
    owner: meta.owner ?? OWNER,
    repo: meta.repo ?? REPO,
    pullNumber: meta.pullNumber,
    headSha: meta.headSha,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.rangeReviewId === undefined ? {} : { rangeReviewId: meta.rangeReviewId }),
    startedAt: meta.startedAt,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: [
      {
        model: "model-a",
        findingCount: fingerprint === undefined ? 0 : 1,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
      },
    ],
    findings:
      fingerprint === undefined
        ? []
        : [
            {
              file: "src/a.ts",
              line: 5,
              title: "示例",
              severity: "P1" as const,
              category: "bug" as const,
              description: "示例",
              attributions: [
                {
                  model: "model-a",
                  severity: "P1" as const,
                  category: "bug" as const,
                  description: "示例",
                },
              ],
              groupIndex: 0,
              disposition: "unknown" as never,
              placement: "inline" as never,
              fingerprint,
            },
          ],
    verdicts: [],
  });
}

/**
 * 垫底的那几千个阶段:一个 pull request 一轮,还没跑完。它们只负责让库变大,内容断言
 * 落在后面那批完整的阶段上。
 */
function seedFillerStages(dbPath: string, progress: Progress, count: number): void {
  const store = openStore(dbPath);
  try {
    for (let index = 0; index < count; index += 1) {
      const pullNumber = 100_000 + index;
      store.startRun({
        owner: OWNER,
        repo: REPO,
        pullNumber,
        headSha: `head-filler-${pullNumber}`,
        title: `垫底 ${pullNumber}`,
        startedAt: at((progress.minute += 1)),
        changedFiles: 1,
        changedLines: 1,
        batchCount: 1,
        reviewerPins: [],
      });
      progress.stageIds.push(`pr:${OWNER}/${REPO}/${pullNumber}`);
    }
  } finally {
    store.close();
  }
}

/**
 * 最新的那一批阶段,两种来源交错——归并、筛选与排序是同一条查询做的,交错才看得出两
 * 条链路真的合到了一起。每个阶段两轮同一个 head,第二轮带一条待处置的 Finding。
 */
function seedRichStages(dbPath: string, progress: Progress): void {
  const store = openStore(dbPath);
  try {
    for (let index = 0; index < RICH_STAGES; index += 1) {
      // 每五个里的第五个是范围审查。
      if (index % 5 === 4) {
        const comparisonSha = `comparison-${index}`;
        const rangeReviewId = store.createRangeReview({
          repoId: 1,
          owner: OWNER,
          repo: REPO,
          title: `范围审查 ${index}`,
          baseSha: `base-${index}`,
          comparisonSha,
          createdBy: "seed",
          createdAt: at(progress.minute),
        });
        const containerPullNumber = 9000 + index;
        seedFinishedRun(store, {
          pullNumber: containerPullNumber,
          headSha: comparisonSha,
          startedAt: at((progress.minute += 1)),
          rangeReviewId,
        });
        seedFinishedRun(
          store,
          {
            pullNumber: containerPullNumber,
            headSha: comparisonSha,
            startedAt: at((progress.minute += 1)),
            rangeReviewId,
          },
          `fingerprint-range-${index}`,
        );
        progress.stageIds.push(`range:${rangeReviewId}`);
        continue;
      }
      const pullNumber = index + 1;
      const headSha = `head-pull-${pullNumber}`;
      const title = `pull request ${pullNumber}`;
      seedFinishedRun(store, {
        pullNumber,
        headSha,
        startedAt: at((progress.minute += 1)),
        title,
      });
      seedFinishedRun(
        store,
        { pullNumber, headSha, startedAt: at((progress.minute += 1)), title },
        `fingerprint-pull-${index}`,
      );
      progress.stageIds.push(`pr:${OWNER}/${REPO}/${pullNumber}`);
    }
  } finally {
    store.close();
  }
}

/** 另一个仓库的几个阶段,最先播因此时刻最旧,只在仓库过滤那一档露面。 */
function seedOtherRepoStages(dbPath: string, progress: Progress): void {
  const store = openStore(dbPath);
  try {
    for (let index = 0; index < OTHER_STAGES; index += 1) {
      const pullNumber = index + 1;
      seedFinishedRun(store, {
        owner: OTHER_OWNER,
        repo: OTHER_REPO,
        pullNumber,
        headSha: `head-other-${pullNumber}`,
        startedAt: at((progress.minute += 1)),
        title: `另一个仓库 ${pullNumber}`,
      });
    }
  } finally {
    store.close();
  }
}

async function page(h: PanelHarness, query: string): Promise<StagesPage> {
  const response = await h.api("GET", `/stages${query}`);
  assert.equal(response.status, 200, query);
  return (await response.json()) as StagesPage;
}

async function detail(h: PanelHarness, stageId: string): Promise<StageDetail> {
  const response = await h.api("GET", `/stages/${encodeURIComponent(stageId)}`);
  assert.equal(response.status, 200, stageId);
  return (await response.json()) as StageDetail;
}

/**
 * 一次请求最快能有多快。取几次里的最小值:这台机器上还有别的事在跑,平均值量到的是
 * 调度噪声,最小值量到的才是这条链路本身。
 */
async function fastest(request: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    await request();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test("几千个阶段:列表一页与详情一次的内容照旧,耗时不随阶段总数走", async () => {
  const large = await startPanelHarness(cleanups);
  const largeProgress: Progress = { minute: 0, stageIds: [] };
  seedOtherRepoStages(large.db.path, largeProgress);
  const oldestFillerStageId = `pr:${OWNER}/${REPO}/100000`;
  seedFillerStages(large.db.path, largeProgress, FILLER_STAGES);
  seedRichStages(large.db.path, largeProgress);
  const richStageIds = largeProgress.stageIds.slice(-RICH_STAGES);
  const newestStageId = richStageIds[RICH_STAGES - 1]!;
  const oldestRichStageId = richStageIds[0]!;

  // 第一页就是最新的那一页,排序键是最新一轮的时刻。
  const first = await page(large, "");
  assert.equal(first.stages.length, PAGE);
  assert.equal(first.nextOffset, PAGE);
  assert.equal(first.stages[0]!.stageId, newestStageId);
  assert.deepEqual([...first.stages].map((stage) => stage.stageId).reverse(), richStageIds);
  const times = first.stages.map((stage) => stage.latestRunAt!);
  assert.deepEqual(times, [...times].sort().reverse());

  // 两种来源都在,三个计数是这个阶段自己的(第二轮那一条 Finding 还没人处置)。
  assert.deepEqual(
    [...new Set(first.stages.map((stage) => stage.source))].sort(),
    ["pull-request", "range-review"],
  );
  for (const stage of first.stages) {
    assert.deepEqual(stage.counts, { pending: 1, resolved: 0, fixed: 0 }, stage.stageId);
  }

  // 翻一页接着往下,既不重也不漏。
  const second = await page(large, `?offset=${PAGE}`);
  assert.equal(second.stages.length, PAGE);
  const both = [...first.stages, ...second.stages];
  assert.equal(new Set(both.map((stage) => stage.stageId)).size, PAGE * 2);
  const bothTimes = both.map((stage) => stage.latestRunAt!);
  assert.deepEqual(bothTimes, [...bothTimes].sort().reverse());

  // 详情读到的是列表里的同一行,一个字段都不差。
  const newest = await detail(large, newestStageId);
  assert.deepEqual(newest.stage, first.stages[0]);

  // 同一个 head 的两轮归一组,新的在前。
  const rich = await detail(large, oldestRichStageId);
  assert.equal(rich.groups.length, 1);
  assert.equal(rich.groups[0]!.runs.length, 2);
  assert.ok(rich.groups[0]!.runs[0]!.runId > rich.groups[0]!.runs[1]!.runId);

  // 排在几千行之后的那个阶段照样直接查得到,不必先把全部阶段建出来。
  const filler = await detail(large, oldestFillerStageId);
  assert.equal(filler.stage.stageId, oldestFillerStageId);
  assert.equal(filler.stage.title, "垫底 100000");
  assert.equal(filler.stage.status, "active");
  assert.equal(filler.stage.latestRunFinishedAt, null);
  assert.deepEqual(filler.stage.counts, { pending: 0, resolved: 0, fixed: 0 });

  // 来源、状态与仓库三个筛选也在服务端做。
  const ranges = await page(large, "?source=range-review");
  assert.equal(ranges.stages.length, RICH_STAGES / 5);
  assert.equal(ranges.nextOffset, null);
  assert.ok(ranges.stages.every((stage) => stage.source === "range-review"));
  const pulls = await page(large, "?source=pull-request");
  assert.ok(pulls.stages.every((stage) => stage.source === "pull-request"));
  const active = await page(large, "?status=active");
  assert.equal(active.stages.length, PAGE);
  assert.ok(active.stages.every((stage) => stage.status === "active"));
  const closed = await page(large, "?status=closed");
  assert.deepEqual(closed.stages, []);
  assert.equal(closed.nextOffset, null);
  const scoped = await page(large, `?owner=${OTHER_OWNER}&repo=${OTHER_REPO}`);
  assert.equal(scoped.stages.length, OTHER_STAGES);
  assert.equal(scoped.nextOffset, null);
  assert.ok(scoped.stages.every((stage) => stage.owner === OTHER_OWNER));

  // 小库:只有那三十个完整的阶段,请求的活儿与大库第一页一模一样。
  const small = await startPanelHarness(cleanups);
  const smallProgress: Progress = { minute: 0, stageIds: [] };
  seedRichStages(small.db.path, smallProgress);
  const smallFirst = await page(small, "");
  assert.deepEqual(
    smallFirst.stages.map((stage) => stage.counts),
    first.stages.map((stage) => stage.counts),
  );

  /*
   * 库大了一百倍,同一个阶段的详情不该跟着变慢:它按标识直接查那一行。倍数放到三倍
   * ——单次只有零点几毫秒,两倍会被计时噪声撞上;三倍仍拦得住「先把全库阶段归并出来
   * 再从里面找一行」,那一档下大库要慢四倍以上。
   */
  const smallDetailMs = await fastest(() => detail(small, oldestRichStageId));
  const largeDetailMs = await fastest(() => detail(large, oldestRichStageId));
  assert.ok(
    largeDetailMs < smallDetailMs * 3,
    `阶段详情:小库 ${smallDetailMs.toFixed(1)}ms,大库 ${largeDetailMs.toFixed(1)}ms`,
  );
});
