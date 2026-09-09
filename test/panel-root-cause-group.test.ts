/**
 * 阶段详情里的同根因组(CONTEXT.md 同根因组,ADR 0030,issue #309):按组折叠展示要的那
 * 份投影,加组级处置那个端点。
 *
 * 打在面板 API 的真实 HTTP 缝上:阶段的轮次、Finding 与组直接落临时 SQLite(这几条用例要
 * 的是投影与处置的行为,不是合并 agent 怎么提出的组——那是 issue #308 的用例),内存 Forge
 * 记下 resolve 收到的评论 id,处置结果由 `GET /stage-summary` 读回。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  HARNESS_SPEC,
  PANEL_ADMIN_USERNAME,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "root-cause-group-test-password";

/** 阶段汇总里要断言的那几格。 */
type SummaryFinding = {
  id: number;
  file: string;
  disposition: string;
  commentId: string | null;
  disposedBy: string | null;
  note: string | null;
  rootCause: { id: number; reason: string; memberCount: number; position: number } | null;
};

type SummaryBody = {
  findings: SummaryFinding[];
  rootCauseGroups: { id: number; reason: string; findingIds: number[] }[];
};

type SeedFinding = {
  file: string;
  /** 落库时的处置状态。省略即未处置。 */
  disposition?: "unknown" | "resolved";
  /** 没有行级评论承载的历史行给 false。 */
  carrier?: boolean;
  /** 折叠到上一轮那条评论上的行给它的评论 id。省略即本轮自己新发的那一条。 */
  commentId?: string;
};

/**
 * 一轮 Review Run 加它落的这几条 Finding 与同根因组。返回落库的 Finding 行 id(与
 * `findings` 同序)和组 id,后面的用例按它们拼断言。
 */
function seedRun(
  h: PanelHarness,
  pullNumber: number,
  findings: readonly SeedFinding[],
  rootCauses: readonly { reason: string; members: readonly number[] }[] = [],
  startedAt = "2026-09-01T00:00:00.000Z",
  /** 这一轮的模式与收尾结果:只复核与失败那两档不提组,取「最新一轮」时要跳过它们。 */
  run: { mode?: "verdict-only"; failed?: boolean } = {},
): { runId: number; findingIds: number[]; groupIds: number[] } {
  const store = openStore(h.db.path);
  try {
    const runId = store.startRun({
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      pullNumber,
      headSha: `sha-${pullNumber}-${startedAt}`,
      startedAt,
      changedFiles: 1,
      changedLines: 1,
      batchCount: 1,
      reviewerPins: [],
      ...(run.mode === undefined ? {} : { mode: run.mode }),
    });
    const groupIds = store.finishRun(runId, {
      finishedAt: startedAt,
      durationMs: 1,
      failed: run.failed ?? false,
      outcomes: [],
      findings: findings.map((finding, index) => ({
        file: finding.file,
        line: 1,
        title: `${finding.file} 上那条`,
        severity: "P1" as const,
        category: "bug" as const,
        description: `${finding.file} 的问题`,
        impact: "",
        suggestion: "",
        attributions: [
          {
            model: HARNESS_SPEC.model,
            severity: "P1" as const,
            category: "bug" as const,
            description: `${finding.file} 的问题`,
            impact: "",
            suggestion: "",
          },
        ],
        groupIndex: index,
        disposition: finding.disposition ?? "unknown",
        placement: (finding.carrier === false ? "body" : "inline") as "body" | "inline",
        fingerprint: `fp-${runId}-${index}`,
        ...(finding.carrier === false
          ? {}
          : {
              commentId: finding.commentId ?? `comment-${runId}-${index}`,
              commentHtmlUrl: `https://forge.invalid/pulls/${pullNumber}/files#c-${runId}-${index}`,
            }),
      })),
      verdicts: [],
      ...(rootCauses.length === 0 ? {} : { rootCauses }),
    });
    const findingIds = new DatabaseSync(h.db.path, { readOnly: true });
    try {
      const rows = findingIds
        .prepare("SELECT id FROM finding WHERE run_id = ? ORDER BY group_index")
        .all(runId) as unknown as { id: number }[];
      return { runId, findingIds: rows.map((row) => Number(row.id)), groupIds };
    } finally {
      findingIds.close();
    }
  } finally {
    store.close();
  }
}

async function summary(h: PanelHarness, pullNumber = HARNESS_PR.number): Promise<SummaryBody> {
  const response = await h.api(
    "GET",
    `/stage-summary?owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}&pullNumber=${pullNumber}`,
  );
  assert.equal(response.status, 200);
  return (await response.json()) as SummaryBody;
}

function byFile(body: SummaryBody, file: string): SummaryFinding {
  const found = body.findings.find((finding) => finding.file === file);
  assert.ok(found !== undefined, `${file} 不在阶段汇总里`);
  return found;
}

function disposePath(pullNumber: number, groupId: number): string {
  return `/stages/${encodeURIComponent(
    `pr:${HARNESS_PR.owner}/${HARNESS_PR.repo}/${pullNumber}`,
  )}/root-cause-groups/${groupId}/dispose`;
}

const REASON = "helper 少判了一次边界,三处调用都受影响";

/** 三条入组(一条已经处置过)加一条组外,组由这一轮提出。 */
async function harnessWithGroup(): Promise<{
  h: PanelHarness;
  findingIds: number[];
  groupId: number;
}> {
  const h = await startReadyPanelHarness();
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  const seeded = seedRun(
    h,
    HARNESS_PR.number,
    [
      { file: "src/a.ts" },
      { file: "src/b.ts" },
      { file: "src/c.ts", disposition: "resolved" },
      { file: "src/d.ts" },
    ],
    [{ reason: REASON, members: [0, 1, 2] }],
  );
  return { h, findingIds: seeded.findingIds, groupId: seeded.groupIds[0]! };
}

test("阶段汇总:入组的三条各带组引用,组外那条为空,组列表带根因说明与成员", async () => {
  const { h, findingIds, groupId } = await harnessWithGroup();

  const body = await summary(h);
  assert.deepEqual(body.rootCauseGroups, [
    { id: groupId, reason: REASON, findingIds: [findingIds[0]!, findingIds[1]!, findingIds[2]!] },
  ]);
  for (const [position, file] of ["src/a.ts", "src/b.ts", "src/c.ts"].entries()) {
    assert.deepEqual(byFile(body, file).rootCause, {
      id: groupId,
      reason: REASON,
      memberCount: 3,
      position,
    });
  }
  assert.equal(byFile(body, "src/d.ts").rootCause, null);
});

test("合并 agent 缺席的阶段:组列表为空,每条的组引用都是 null", async () => {
  const h = await startReadyPanelHarness();
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  seedRun(h, HARNESS_PR.number, [{ file: "src/a.ts" }, { file: "src/b.ts" }]);

  const body = await summary(h);
  assert.deepEqual(body.rootCauseGroups, []);
  assert.deepEqual(
    body.findings.map((finding) => finding.rootCause),
    [null, null],
  );
});

test("只复核与失败的那几轮:上一轮完整审查的组照旧在", async () => {
  const h = await startReadyPanelHarness();
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  const full = seedRun(
    h,
    HARNESS_PR.number,
    [{ file: "src/a.ts" }, { file: "src/b.ts" }],
    [{ reason: REASON, members: [{ groupIndex: 0 }, { groupIndex: 1 }] }],
  );
  // 只复核不报新的、从不提组;失败那一轮压根没走到合并。它们都不该被当成「最新一轮」。
  seedRun(h, HARNESS_PR.number, [], [], "2026-09-02T00:00:00.000Z", { mode: "verdict-only" });
  seedRun(h, HARNESS_PR.number, [], [], "2026-09-03T00:00:00.000Z", { failed: true });

  const body = await summary(h);
  assert.deepEqual(body.rootCauseGroups, [
    { id: full.groupIds[0]!, reason: REASON, findingIds: full.findingIds },
  ]);
  assert.equal(byFile(body, "src/a.ts").rootCause?.id, full.groupIds[0]!);
});

test("之后一轮完整审查没提组:组列表回空,每条的引用都是 null", async () => {
  const h = await startReadyPanelHarness();
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  seedRun(
    h,
    HARNESS_PR.number,
    [{ file: "src/a.ts" }, { file: "src/b.ts" }],
    [{ reason: REASON, members: [{ groupIndex: 0 }, { groupIndex: 1 }] }],
  );
  seedRun(h, HARNESS_PR.number, [{ file: "src/c.ts" }], [], "2026-09-02T00:00:00.000Z");

  const body = await summary(h);
  assert.deepEqual(body.rootCauseGroups, []);
  assert.deepEqual(
    body.findings.map((finding) => finding.rootCause),
    [null, null, null],
  );
});

test("成员映完只剩一条:整组不出现,剩下那条按未入组列出", async () => {
  const h = await startReadyPanelHarness();
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  const seeded = seedRun(
    h,
    HARNESS_PR.number,
    [{ file: "src/a.ts" }, { file: "src/b.ts" }],
    [{ reason: REASON, members: [{ groupIndex: 0 }, { groupIndex: 1 }] }],
  );
  // a 那条整条交接掉而没有承接者:它映不到当前列表里的任何一行,组只剩 b 一个成员。
  const db = new DatabaseSync(h.db.path);
  try {
    db.prepare("UPDATE finding SET disposition = 'continued' WHERE id = ?").run(
      seeded.findingIds[0]!,
    );
  } finally {
    db.close();
  }

  const body = await summary(h);
  assert.deepEqual(body.rootCauseGroups, []);
  assert.equal(byFile(body, "src/b.ts").rootCause, null);
});

test("成员折叠到历史评论:组引用挂在本轮那一行上,阶段汇总里仍只有一条", async () => {
  const h = await startReadyPanelHarness();
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  const first = seedRun(h, HARNESS_PR.number, [{ file: "src/a.ts" }]);
  // 第二轮 a 那条折叠到上一轮的评论上:本轮同样落一行,它与那条历史在 `identityKey` 下
  // 是同一条 Finding Identity。组成员记的是本轮这一行(评审复核 2026-09-09)。
  const second = seedRun(
    h,
    HARNESS_PR.number,
    [{ file: "src/a.ts", commentId: `comment-${first.runId}-0` }, { file: "src/b.ts" }],
    [{ reason: REASON, members: [0, 1] }],
    "2026-09-02T00:00:00.000Z",
  );

  const body = await summary(h);
  assert.deepEqual(body.rootCauseGroups, [
    {
      id: second.groupIds[0]!,
      reason: REASON,
      findingIds: [second.findingIds[0]!, second.findingIds[1]!],
    },
  ]);
  // 同一条 Identity 只出一行,上一轮那一行不再单列。
  assert.deepEqual(
    body.findings.map((finding) => finding.id),
    [second.findingIds[0]!, second.findingIds[1]!],
  );
  assert.deepEqual(byFile(body, "src/a.ts").rootCause, {
    id: second.groupIds[0]!,
    reason: REASON,
    memberCount: 2,
    position: 0,
  });
});

test("组级处置:未处置成员写同一处置与备注,已处置的跳过,组外那条不动", async () => {
  const { h, findingIds, groupId } = await harnessWithGroup();

  const response = await h.api("POST", disposePath(HARNESS_PR.number, groupId), {
    note: "同一个根因,统一按已知问题处置",
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    disposed: number[];
    skipped: number[];
    failed: number[];
  };
  assert.deepEqual(result.disposed, [findingIds[0]!, findingIds[1]!]);
  assert.deepEqual(result.skipped, [findingIds[2]!]);
  assert.deepEqual(result.failed, []);

  // Forge 上收到的正是那两条评论,已经处置过的那条不再写一次。
  const body = await summary(h);
  assert.deepEqual(
    [...h.memory.resolvedIds].sort(),
    [byFile(body, "src/a.ts").commentId, byFile(body, "src/b.ts").commentId].sort(),
  );
  assert.deepEqual(h.memory.unresolvedIds, []);
  for (const file of ["src/a.ts", "src/b.ts"]) {
    const finding = byFile(body, file);
    assert.equal(finding.disposition, "resolved");
    assert.equal(finding.note, "同一个根因,统一按已知问题处置");
    assert.equal(finding.disposedBy, PANEL_ADMIN_USERNAME);
  }
  // 已经处置过的那条署名与备注一格未动,组外那条仍未处置。
  const already = byFile(body, "src/c.ts");
  assert.equal(already.disposedBy, null);
  assert.equal(already.note, null);
  assert.equal(byFile(body, "src/d.ts").disposition, "unknown");

  // 每条写入各排一次处置反哺,与逐条处置同一条路(ADR 0030)。
  await h.dispositionFeedbackAtLeast(2);
  assert.deepEqual(
    h.dispositionFeedbacks.map((entry) => entry.findingId).sort((a, b) => a - b),
    [findingIds[0]!, findingIds[1]!],
  );
});

test("没有备注的组级处置:照样落库,一次反哺都不排", async () => {
  const { h, findingIds, groupId } = await harnessWithGroup();

  const response = await h.api("POST", disposePath(HARNESS_PR.number, groupId), {});
  assert.equal(response.status, 200);
  const result = (await response.json()) as { disposed: number[] };
  assert.deepEqual(result.disposed, [findingIds[0]!, findingIds[1]!]);
  assert.equal(byFile(await summary(h), "src/a.ts").disposition, "resolved");
  assert.deepEqual(h.dispositionFeedbacks, []);
});

test("没有 finding:dispose-batch 的用户被拒:一条都不动", async () => {
  const { h, groupId } = await harnessWithGroup();
  const cookie = await scopedUser(
    h,
    "single-disposer",
    PASSWORD,
    "2026-09-01T00:00:00.000Z",
    [GITEA_REPO.id],
    ["finding:dispose"],
  );

  const denied = await fetch(`${h.serverUrl}/api${disposePath(HARNESS_PR.number, groupId)}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(h.memory.resolvedIds, []);
  assert.equal(byFile(await summary(h), "src/a.ts").disposition, "unknown");
});

test("仓库分配之外的阶段:有权限也回 404,一条都不动", async () => {
  const { h, groupId } = await harnessWithGroup();
  seedRepo(h, 4243, "acme", "gadgets");
  const cookie = await scopedUser(
    h,
    "other-repo",
    PASSWORD,
    "2026-09-01T00:00:00.000Z",
    [4243],
    ["finding:dispose-batch"],
  );

  const denied = await fetch(`${h.serverUrl}/api${disposePath(HARNESS_PR.number, groupId)}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(h.memory.resolvedIds, []);
  assert.equal(byFile(await summary(h), "src/a.ts").disposition, "unknown");
});

test("别的阶段的组:回 404,一条都不动", async () => {
  const { h } = await harnessWithGroup();
  const other = seedRun(
    h,
    HARNESS_PR.number + 1,
    [{ file: "src/x.ts" }, { file: "src/y.ts" }],
    [{ reason: "另一个阶段的根因", members: [0, 1] }],
  );

  const response = await h.api(
    "POST",
    disposePath(HARNESS_PR.number, other.groupIds[0]!),
    {},
  );
  assert.equal(response.status, 404);
  assert.deepEqual(h.memory.resolvedIds, []);
  assert.equal(byFile(await summary(h), "src/a.ts").disposition, "unknown");
});
