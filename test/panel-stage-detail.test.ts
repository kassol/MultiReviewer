/**
 * 阶段详情(issue #175)。一个审查阶段有自己的地址:阶段那一行加它的时间线,时间线
 * 按一次代码推进分组——pull request 按 head commit,范围审查按比较项。
 *
 * 打在面板 API 的 HTTP 缝上:两种来源各取一次详情,只看响应里的分组、顺序与字段。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  PANEL_PREFIX,
  seedHistoricalRepo,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type StageRunEntry = {
  runId: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  reported: number;
  folded: number;
  fixed: number;
  continued: number;
  missedVerdicts: number;
};

type StageDetailBody = {
  stage: {
    stageId: string;
    source: "pull-request" | "range-review";
    owner: string;
    repo: string;
    pullNumber: number | null;
    rangeReviewId: number | null;
    title: string | null;
    status: "active" | "closed";
    latestRunId: number | null;
    counts: { pending: number; resolved: number; fixed: number };
  };
  groups: {
    sha: string;
    recordedBy: string | null;
    recordedAt: string | null;
    runs: StageRunEntry[];
  }[];
};

/** 播种一轮 Review Run:一条 Finding 一个指纹,阶段汇总按「文件 + 指纹」折叠。 */
function seedRun(
  dbPath: string,
  meta: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    startedAt: string;
    title?: string;
    rangeReviewId?: number;
  },
  findings: { fingerprint: string; disposition?: "unknown" | "resolved" | "fixed" }[] = [],
): number {
  const store = openStore(dbPath);
  const runId = store.startRun({
    owner: meta.owner,
    repo: meta.repo,
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
        findingCount: findings.length,
        anomalyCount: 0,
        rejectedToolCalls: 0,
        anchorRejections: 0,
        durationMs: 1,
      },
    ],
    findings: findings.map((finding, index) => ({
      file: "src/a.ts",
      line: 5,
      title: "示例",
      severity: "P1" as const,
      category: "bug" as const,
      description: "示例",
      attributions: [
        { model: "model-a", severity: "P1" as const, category: "bug" as const, description: "示例" },
      ],
      groupIndex: index,
      disposition: (finding.disposition ?? "unknown") as never,
      placement: "inline" as never,
      fingerprint: finding.fingerprint,
    })),
    verdicts: [],
  });
  store.close();
  return runId;
}

async function detail(h: PanelHarness, stageId: string): Promise<StageDetailBody> {
  const response = await h.api("GET", `/stages/${encodeURIComponent(stageId)}`);
  assert.equal(response.status, 200);
  return (await response.json()) as StageDetailBody;
}

test("阶段详情:pull request 阶段按 head commit 分组,最近一次推进在最前", async () => {
  const h = await startPanelHarness(cleanups);
  const first = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      headSha: "head-one",
      startedAt: "2026-08-01T00:00:00.000Z",
      title: "把登录超时改回三十秒",
    },
    [{ fingerprint: "fp-1" }, { fingerprint: "fp-2", disposition: "resolved" }],
  );
  // 同一个 head 上再跑一轮:同一组里两轮,fp-1 这一条折叠到已有的那条上。
  const second = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      headSha: "head-one",
      startedAt: "2026-08-02T00:00:00.000Z",
      title: "把登录超时改回三十秒",
    },
    [{ fingerprint: "fp-1" }],
  );
  // 作者推了新代码:新的 head 单独一组。
  const third = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      headSha: "head-two",
      startedAt: "2026-08-03T00:00:00.000Z",
      title: "把登录超时改回三十秒",
    },
    [{ fingerprint: "fp-3", disposition: "fixed" }],
  );

  const body = await detail(h, "pr:acme/widgets/7");
  // 阶段那一行与列表读到的是同一条记录。
  const list = (await (await h.api("GET", "/stages")).json()) as { stages: unknown[] };
  assert.deepEqual(body.stage, list.stages[0]);
  assert.equal(body.stage.stageId, "pr:acme/widgets/7");
  assert.equal(body.stage.source, "pull-request");
  assert.equal(body.stage.pullNumber, 7);
  assert.equal(body.stage.rangeReviewId, null);
  assert.equal(body.stage.title, "把登录超时改回三十秒");
  assert.equal(body.stage.status, "active");
  assert.equal(body.stage.latestRunId, third);
  assert.deepEqual(body.stage.counts, { pending: 1, resolved: 1, fixed: 1 });

  // 两个 head 两组,新的推进在前;组内也是新的一轮在前。
  assert.deepEqual(
    body.groups.map((group) => group.sha),
    ["head-two", "head-one"],
  );
  assert.deepEqual(
    body.groups.map((group) => group.runs.map((run) => run.runId)),
    [[third], [second, first]],
  );
  // pull request 的 head commit 没有「谁在什么时候推的」这一层。
  assert.deepEqual(
    body.groups.map((group) => group.recordedBy),
    [null, null],
  );
  // 每一轮仍是现有的那份轮次摘要:本轮新报出 / 折叠 / 已修复 / 已延续 / 漏复核。
  const [head, previous] = [body.groups[0]!.runs[0]!, body.groups[1]!.runs];
  assert.equal(head.headSha, "head-two");
  assert.equal(head.reported, 1);
  assert.equal(previous[0]!.reported, 0);
  assert.equal(previous[0]!.folded, 1);
  assert.equal(previous[1]!.reported, 2);
  assert.equal(previous[1]!.failed, false);
  assert.equal(previous[1]!.startedAt, "2026-08-01T00:00:00.000Z");
});

test("阶段详情:范围审查阶段按比较项分组,带推进的人与时刻,没跑过的比较项也在", async () => {
  const h = await startPanelHarness(cleanups);
  const store = openStore(h.db.path);
  const rangeReviewId = store.createRangeReview({
    repoId: GITEA_REPO.id,
    owner: "acme",
    repo: "widgets",
    title: "范围审查阶段",
    baseSha: "base-sha",
    comparisonSha: "cmp-one",
    createdBy: "operator",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  store.advanceRangeReview({
    id: rangeReviewId,
    comparisonSha: "cmp-two",
    advancedBy: "reviewer",
    advancedAt: "2026-08-02T00:00:00.000Z",
  });
  store.close();
  // 容器 PR 的 head 就是当前比较项:两个比较项各跑过一轮。
  const first = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 101,
      headSha: "cmp-one",
      startedAt: "2026-08-01T00:10:00.000Z",
      rangeReviewId,
    },
    [{ fingerprint: "fp-1" }],
  );
  const second = seedRun(
    h.db.path,
    {
      owner: "acme",
      repo: "widgets",
      pullNumber: 101,
      headSha: "cmp-two",
      startedAt: "2026-08-02T00:10:00.000Z",
      rangeReviewId,
    },
    [{ fingerprint: "fp-2" }],
  );
  // 又推进一次,这一次的轮次还没跑起来。
  const advanced = openStore(h.db.path);
  advanced.advanceRangeReview({
    id: rangeReviewId,
    comparisonSha: "cmp-three",
    advancedBy: "reviewer",
    advancedAt: "2026-08-03T00:00:00.000Z",
  });
  advanced.close();

  const body = await detail(h, `range:${rangeReviewId}`);
  assert.equal(body.stage.stageId, `range:${rangeReviewId}`);
  assert.equal(body.stage.source, "range-review");
  assert.equal(body.stage.rangeReviewId, rangeReviewId);
  // 容器 PR 的序号不露面。
  assert.equal(body.stage.pullNumber, null);
  assert.equal(body.stage.status, "active");
  assert.equal(body.stage.latestRunId, second);
  assert.deepEqual(body.stage.counts, { pending: 2, resolved: 0, fixed: 0 });

  assert.deepEqual(
    body.groups.map((group) => group.sha),
    ["cmp-three", "cmp-two", "cmp-one"],
  );
  assert.deepEqual(
    body.groups.map((group) => group.runs.map((run) => run.runId)),
    [[], [second], [first]],
  );
  assert.deepEqual(body.groups[0]!.recordedBy, "reviewer");
  assert.deepEqual(body.groups[0]!.recordedAt, "2026-08-03T00:00:00.000Z");
  assert.deepEqual(body.groups[2]!.recordedBy, "operator");
  assert.deepEqual(body.groups[2]!.recordedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(body.groups[1]!.runs[0]!.reported, 1);
});

test("阶段详情:标识认不出或阶段不存在都是 404", async () => {
  const h = await startPanelHarness(cleanups);
  seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    headSha: "head-one",
    startedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal((await h.api("GET", "/stages/pr%3Aacme%2Fwidgets%2F8")).status, 404);
  assert.equal((await h.api("GET", "/stages/range%3A404")).status, 404);
  assert.equal((await h.api("GET", "/stages/nonsense")).status, 404);
  // 解不开的百分号转义同样是 404,不是 500。
  assert.equal((await h.api("GET", "/stages/%zz")).status, 404);
});

test("阶段详情:未认证 401,一格权限都没有的人分到仓库就读得到", async () => {
  const h = await startPanelHarness(cleanups);
  seedRun(h.db.path, {
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    headSha: "head-one",
    startedAt: "2026-08-01T00:00:00.000Z",
  });
  const path = `/${PANEL_PREFIX}/api/stages/${encodeURIComponent("pr:acme/widgets/7")}`;
  assert.equal((await fetch(`${h.serverUrl}${path}`)).status, 401);

  seedHistoricalRepo(h);
  const password = "stage-detail-test-password";
  const store = openStore(h.db.path);
  store.createPanelUser({
    username: "plain-user",
    displayName: null,
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: null,
  });
  store.setPanelUserAssignment("plain-user", [GITEA_REPO.id]);
  store.close();
  const login = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "plain-user", password }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  assert.equal((await fetch(`${h.serverUrl}${path}`, { headers: { cookie } })).status, 200);
});
