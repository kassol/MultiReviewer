/**
 * 阶段详情的批量处置(issue #274):一次处置这个阶段里低于生效最低报告等级的未处置项。
 *
 * 打在面板 API 的真实 HTTP 缝上:阶段的轮次与 Finding 直接落临时 SQLite(这几条用例要
 * 的是选条目与逐条处置的行为,不是 Reviewer 怎么跑出来的),内存 Forge 记下 resolve 收到
 * 的评论 id,处置结果由 `GET /stage-summary` 读回。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Forge } from "../src/forge/forge.ts";
import { hashPassword } from "../src/panel/password.ts";
import type { PanelPermission } from "../src/panel/permissions.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  HARNESS_SPEC,
  PANEL_ADMIN_USERNAME,
  startReadyPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "dispose-batch-test-password";
const HASH = await hashPassword(PASSWORD);

/** 阶段汇总里要断言的那几格。 */
type SummaryFinding = {
  id: number;
  file: string;
  severity: string;
  disposition: string;
  commentId: string | null;
  disposedBy: string | null;
  note: string | null;
};

type SeedFinding = {
  file: string;
  line: number;
  severity: "P0" | "P1" | "P2";
  /** 落库时的处置状态。省略即未处置。 */
  disposition?: "unknown" | "resolved";
  /** 没有行级评论承载的历史行(升级前留下的)给 false。 */
  carrier?: boolean;
};

/** 一个 pull request 阶段:一轮 Review Run 加它报出的这几条 Finding。 */
function seedStage(
  h: PanelHarness,
  ref: { owner: string; repo: string; pullNumber: number },
  findings: readonly SeedFinding[],
): void {
  const store = openStore(h.db.path);
  try {
    const runId = store.startRun({
      owner: ref.owner,
      repo: ref.repo,
      pullNumber: ref.pullNumber,
      headSha: `sha-${ref.owner}-${ref.repo}-${ref.pullNumber}`,
      startedAt: "2026-09-01T00:00:00.000Z",
      changedFiles: 1,
      changedLines: 1,
      batchCount: 1,
      reviewerPins: [],
    });
    store.finishRun(runId, {
      finishedAt: "2026-09-01T00:00:01.000Z",
      durationMs: 1,
      failed: false,
      outcomes: [],
      findings: findings.map((finding, index) => ({
        file: finding.file,
        line: finding.line,
        title: `${finding.severity} 的那条`,
        severity: finding.severity,
        category: "bug" as const,
        description: `${finding.file}:${finding.line}`,
        impact: "",
        suggestion: "",
        attributions: [
          {
            model: HARNESS_SPEC.model,
            severity: finding.severity,
            category: "bug" as const,
            description: `${finding.file}:${finding.line}`,
            impact: "",
            suggestion: "",
          },
        ],
        groupIndex: index,
        disposition: finding.disposition ?? "unknown",
        placement: (finding.carrier === false ? "body" : "inline") as "body" | "inline",
        fingerprint: `fp-${ref.repo}-${index}`,
        ...(finding.carrier === false
          ? {}
          : {
              commentId: `comment-${ref.repo}-${index}`,
              commentHtmlUrl: `https://forge.invalid/pulls/${ref.pullNumber}/files#comment-${index}`,
            }),
      })),
      verdicts: [],
    });
  } finally {
    store.close();
  }
}

/** 直接落一行注册表:这几条用例要的是仓库存在,不是它的 hook。 */
function seedRepo(h: PanelHarness, repoId: number, owner: string, repo: string): void {
  const store = openStore(h.db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId, owner, repo, generation: 1, key: `key-${repoId}` }),
      true,
    );
  } finally {
    store.close();
  }
}

const STAGE_ID = `pr:${HARNESS_PR.owner}/${HARNESS_PR.repo}/${HARNESS_PR.number}`;

function disposePath(stageId: string): string {
  return `/stages/${encodeURIComponent(stageId)}/findings/dispose-below-threshold`;
}

async function summary(h: PanelHarness, ref = HARNESS_PR): Promise<SummaryFinding[]> {
  const response = await h.api(
    "GET",
    `/stage-summary?owner=${ref.owner}&repo=${ref.repo}&pullNumber=${ref.number}`,
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as { findings: SummaryFinding[] }).findings;
}

function byFile(findings: readonly SummaryFinding[], file: string): SummaryFinding {
  const found = findings.find((finding) => finding.file === file);
  assert.ok(found !== undefined, `${file} 不在阶段汇总里`);
  return found;
}

/**
 * 一个阶段六条 Finding:P0、P1 各一条未处置,P2 两条未处置,一条 P2 已经处置过,再一条
 * P2 是升级前留下的、只在 review 正文里。阈值抬到 P1 之后,该动的只有 c 与 d 两条。
 */
const STAGE_FINDINGS: readonly SeedFinding[] = [
  { file: "src/a.ts", line: 1, severity: "P0" },
  { file: "src/b.ts", line: 2, severity: "P1" },
  { file: "src/c.ts", line: 3, severity: "P2" },
  { file: "src/d.ts", line: 4, severity: "P2" },
  { file: "src/e.ts", line: 5, severity: "P2", disposition: "resolved" },
  { file: "src/f.ts", line: 6, severity: "P2", carrier: false },
];

async function harnessWithStage(options: PanelHarnessOptions = {}): Promise<PanelHarness> {
  const h = await startReadyPanelHarness(cleanups, options);
  seedRepo(h, GITEA_REPO.id, GITEA_REPO.owner, GITEA_REPO.repo);
  seedStage(h, { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo, pullNumber: HARNESS_PR.number }, STAGE_FINDINGS);
  return h;
}

/** 把这个仓库的最低报告等级覆盖成 P1(issue #302 起与模型覆盖同一个整块端点)。 */
async function setThreshold(h: PanelHarness, severity: "P0" | "P1" | "P2" | null): Promise<void> {
  const rows = (await (await h.api("GET", "/repos")).json()) as {
    repoId: number;
    reviewers: unknown;
    settingsVersion: number;
  }[];
  const row = rows.find((entry) => entry.repoId === GITEA_REPO.id)!;
  const response = await h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, {
    reviewers: row.reviewers,
    minReportSeverity: severity,
    expectedVersion: row.settingsVersion,
  });
  assert.equal(response.status, 200, await response.text());
}

async function scopedCookie(
  h: PanelHarness,
  username: string,
  permissions: readonly PanelPermission[],
  repoIds?: readonly number[],
): Promise<string> {
  const store = openStore(h.db.path);
  try {
    const role = store.createPanelRole({
      name: `角色-${username}`,
      permissions: [...permissions],
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    store.createPanelUser({
      username,
      displayName: null,
      passwordHash: HASH,
      mustChangePassword: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      isSystemAdmin: false,
      roleId: role.id,
    });
    if (repoIds !== undefined) store.setPanelUserAssignment(username, [...repoIds]);
  } finally {
    store.close();
  }
  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  return login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

test("阈值 P1:未处置的 P2 全部处置,P0、P1 与已处置的不动,备注落到每一条", async () => {
  const h = await harnessWithStage();
  await setThreshold(h, "P1");

  const response = await h.api("POST", disposePath(STAGE_ID), { note: "低于阈值,统一按误报处置" });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { disposed: number[]; failed: number[] };
  assert.deepEqual(result.failed, []);

  const after = await summary(h);
  assert.deepEqual(
    [...result.disposed].sort(),
    [byFile(after, "src/c.ts").id, byFile(after, "src/d.ts").id].sort(),
  );
  // Forge 上收到的正是那两条评论,已经处置过的与没有评论承载的都不再写一次。
  assert.deepEqual(
    [...h.memory.resolvedIds].sort(),
    [byFile(after, "src/c.ts").commentId, byFile(after, "src/d.ts").commentId].sort(),
  );
  assert.deepEqual(h.memory.unresolvedIds, []);

  // 备注逐条落库,操作人是调用的那个人。
  for (const file of ["src/c.ts", "src/d.ts"]) {
    const finding = byFile(after, file);
    assert.equal(finding.disposition, "resolved");
    assert.equal(finding.note, "低于阈值,统一按误报处置");
    assert.equal(finding.disposedBy, PANEL_ADMIN_USERNAME);
  }
  // 阈值之上的两条、已经处置过的那条与只在正文里的那条都一格未动。
  for (const file of ["src/a.ts", "src/b.ts", "src/f.ts"]) {
    const finding = byFile(after, file);
    assert.equal(finding.disposition, "unknown");
    assert.equal(finding.disposedBy, null);
    assert.equal(finding.note, null);
  }
  const alreadyDisposed = byFile(after, "src/e.ts");
  assert.equal(alreadyDisposed.disposition, "resolved");
  assert.equal(alreadyDisposed.note, null);
  assert.equal(alreadyDisposed.disposedBy, null);
});

test("阈值 P2:端点回 409,一条都不动", async () => {
  const h = await harnessWithStage();

  const response = await h.api("POST", disposePath(STAGE_ID), {});
  assert.equal(response.status, 409);
  assert.deepEqual(h.memory.resolvedIds, []);
  const after = await summary(h);
  for (const file of ["src/c.ts", "src/d.ts"]) {
    assert.equal(byFile(after, file).disposition, "unknown");
  }
});

test("部分 Forge 失败:成功的照样落库,响应带成功与失败两组 id", async () => {
  const failing = `comment-${GITEA_REPO.repo}-2`;
  const h = await harnessWithStage({
    wrapForge: (forge: Forge): Forge => ({
      ...forge,
      resolveComment: async (ref, commentId) => {
        if (commentId === failing) throw new Error("Gitea 上这条评论没了");
        return forge.resolveComment(ref, commentId);
      },
    }),
  });
  await setThreshold(h, "P1");

  const response = await h.api("POST", disposePath(STAGE_ID), {});
  assert.equal(response.status, 200);
  const result = (await response.json()) as { disposed: number[]; failed: number[] };
  assert.equal(result.disposed.length, 1);
  assert.equal(result.failed.length, 1);

  const after = await summary(h);
  const failed = after.find((finding) => finding.id === result.failed[0])!;
  assert.equal(failed.commentId, failing);
  assert.equal(failed.disposition, "unknown");
  const disposed = after.find((finding) => finding.id === result.disposed[0])!;
  assert.equal(disposed.disposition, "resolved");
  assert.deepEqual(h.memory.resolvedIds, [disposed.commentId]);
});

test("没有 finding:dispose-batch 的用户被拒:只有逐条处置那一格同样被拒", async () => {
  const h = await harnessWithStage();
  await setThreshold(h, "P1");
  const cookie = await scopedCookie(h, "single-disposer", ["finding:dispose"]);

  const denied = await fetch(`${h.serverUrl}/api${disposePath(STAGE_ID)}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(h.memory.resolvedIds, []);
  const after = await summary(h);
  for (const file of ["src/c.ts", "src/d.ts"]) {
    assert.equal(byFile(after, file).disposition, "unknown");
  }
});

test("仓库分配之外的阶段:有权限也回 404,一条都不动", async () => {
  const h = await harnessWithStage();
  await setThreshold(h, "P1");
  seedRepo(h, 4243, "acme", "gadgets");
  const cookie = await scopedCookie(h, "other-repo", ["finding:dispose-batch"], [4243]);

  const denied = await fetch(`${h.serverUrl}/api${disposePath(STAGE_ID)}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(h.memory.resolvedIds, []);
});
