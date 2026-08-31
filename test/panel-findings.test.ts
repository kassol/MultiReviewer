/**
 * 面板处置与处置备注(issue #156)。
 *
 * 打在面板 API 的真实 HTTP 缝上:脚本 Reviewer 让一轮真的跑完并发出行级评论,内存
 * Forge 记下 resolve / unresolve 收到的评论 id,库里的处置由 `GET /runs` 的投影读回。
 * 断言只看外部可观察的行为。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  HARNESS_SPEC,
  PANEL_ADMIN_USERNAME,
  PANEL_PREFIX,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "finding-dispose-test-password";
const HASH = await hashPassword(PASSWORD);

type RunFinding = {
  id: number;
  models: string[];
  file: string;
  line: number;
  severity: string;
  category: string;
  description: string;
  disposition: string;
  placement: string;
  commentId: string | null;
  commentHtmlUrl: string | null;
  disposedBy: string | null;
  disposedAt: string | null;
  note: string | null;
};

type RunRow = {
  id: number;
  resolved: number;
  total: number;
  findings: RunFinding[];
};

/**
 * 三条 Finding:两个文件各一条落在 diff 里(各自一条行级评论),第三条落在 diff 之外,
 * 只进 review 正文,没有评论 id。
 */
const reportingReviewers: NonNullable<
  NonNullable<Parameters<typeof startReadyPanelHarness>[1]>["buildReviewers"]
> = (plans) =>
  plans.map((plan) =>
    scriptedReviewer(plan.spec.model, [
      { file: "src/answer.ts", line: 1, severity: "P1", category: "bug", description: "这里会越界" },
      { file: "src/other.ts", line: 1, severity: "P0", category: "security", description: "这里会注入" },
      { file: "src/answer.ts", line: 99, severity: "P2", category: "design", description: "diff 之外的那条" },
    ]),
  );

/** 一个已注册仓库,跑完一轮,并把三条 Finding 落库。 */
async function harnessWithRun(): Promise<PanelHarness> {
  const h = await startReadyPanelHarness(cleanups, { buildReviewers: reportingReviewers });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  return h;
}

async function runs(h: PanelHarness): Promise<RunRow[]> {
  const response = await h.api("GET", "/runs");
  assert.equal(response.status, 200);
  return ((await response.json()) as { runs: RunRow[] }).runs;
}

async function findingById(h: PanelHarness, id: number): Promise<RunFinding> {
  const all = (await runs(h)).flatMap((run) => run.findings);
  const found = all.find((finding) => finding.id === id);
  assert.notEqual(found, undefined, `Finding ${id} 不在时间流里`);
  return found!;
}

test("详情投影列出 Finding 全部字段与 Forge 评论链接", async () => {
  const h = await harnessWithRun();

  const [run] = await runs(h);
  assert.notEqual(run, undefined);
  const inline = run!.findings.find((finding) => finding.file === "src/answer.ts" && finding.line === 1);
  assert.notEqual(inline, undefined);
  // 归属就是报出它的那些 Reviewer 绑定的模型(ADR 0015)。
  assert.deepEqual(inline!.models, [HARNESS_SPEC.model]);
  assert.equal(inline!.severity, "P1");
  assert.equal(inline!.category, "bug");
  assert.equal(inline!.description, "这里会越界");
  assert.equal(inline!.placement, "inline");
  assert.equal(inline!.disposition, "unknown");
  assert.equal(inline!.commentId, h.memory.publishedComments[0]!.id);
  assert.equal(inline!.commentHtmlUrl, h.memory.publishedComments[0]!.htmlUrl);
  assert.equal(inline!.disposedBy, null);
  assert.equal(inline!.disposedAt, null);
  assert.equal(inline!.note, null);

  // diff 之外的那条只进正文,没有可处置的载体。
  const fallback = run!.findings.find((finding) => finding.line === 99);
  assert.equal(fallback!.placement, "body");
  assert.equal(fallback!.commentId, null);
  assert.equal(fallback!.commentHtmlUrl, null);
});

test("面板 resolve:Forge 收到 resolve,库里记处置、操作人、时间与备注", async () => {
  const h = await harnessWithRun();
  const before = (await runs(h))[0]!;
  const target = before.findings.find((finding) => finding.commentId !== null)!;
  assert.equal(before.resolved, 0);

  const response = await h.api("POST", `/findings/${target.id}/resolve`, {
    note: "误报,上游已经判过空",
  });
  assert.equal(response.status, 200);

  assert.deepEqual(h.memory.resolvedIds, [target.commentId]);
  assert.deepEqual(h.memory.unresolvedIds, []);

  const after = await findingById(h, target.id);
  assert.equal(after.disposition, "resolved");
  assert.equal(after.disposedBy, PANEL_ADMIN_USERNAME);
  assert.ok(Number.isFinite(Date.parse(after.disposedAt ?? "")), "处置时间要是可解析的时刻");
  assert.equal(after.note, "误报,上游已经判过空");
  // 处置进度与列表同源:进度条那一格跟着涨。
  assert.equal((await runs(h))[0]!.resolved, 1);
});

test("面板 unresolve:Forge 收到 unresolve,处置回未处置,备注保留", async () => {
  const h = await harnessWithRun();
  const target = (await runs(h))[0]!.findings.find((finding) => finding.commentId !== null)!;

  assert.equal(
    (await h.api("POST", `/findings/${target.id}/resolve`, { note: "先按误报处置" })).status,
    200,
  );
  assert.equal((await h.api("POST", `/findings/${target.id}/unresolve`, {})).status, 200);

  assert.deepEqual(h.memory.unresolvedIds, [target.commentId]);
  const after = await findingById(h, target.id);
  assert.equal(after.disposition, "unresolved");
  assert.equal(after.note, "先按误报处置");
  assert.equal(after.disposedBy, PANEL_ADMIN_USERNAME);
  assert.equal((await runs(h))[0]!.resolved, 0);
});

test("fallback Finding 没有行级评论:处置被拒,Forge 一个调用都不发", async () => {
  const h = await harnessWithRun();
  const fallback = (await runs(h))[0]!.findings.find((finding) => finding.commentId === null)!;

  const response = await h.api("POST", `/findings/${fallback.id}/resolve`, {});
  assert.equal(response.status, 409);
  assert.deepEqual(h.memory.resolvedIds, []);
  assert.equal((await findingById(h, fallback.id)).disposition, "unknown");

  // 不存在的 Finding 与不存在的端点分开:前者 404 带原因。
  assert.equal((await h.api("POST", "/findings/999999/resolve", {})).status, 404);
});

test("没有 finding:dispose 的用户处置被拒,新权限格不落到已有角色", async () => {
  const h = await harnessWithRun();
  const target = (await runs(h))[0]!.findings.find((finding) => finding.commentId !== null)!;

  const store = openStore(h.db.path);
  // 升级前就存在的角色:它拿到的是当时的全部评审权限,不含新增的 finding:dispose。
  const legacy = store.createPanelRole({
    name: "老的评审角色",
    permissions: ["review:rerun", "review:create"],
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "finding-reader",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: legacy.id,
  });
  store.close();

  const login = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "finding-reader", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const session = (await (
    await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, { headers: { cookie } })
  ).json()) as { permissions: string[] };
  assert.deepEqual(session.permissions, ["review:rerun", "review:create"]);

  const denied = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/findings/${target.id}/resolve`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(h.memory.resolvedIds, []);
  assert.equal((await findingById(h, target.id)).disposition, "unknown");
});

test("回填不抹掉面板记的操作人与备注,Gitea 上的 resolve 照常回到面板", async () => {
  const h = await harnessWithRun();
  const first = (await runs(h))[0]!;
  const disposed = first.findings.find((finding) => finding.file === "src/answer.ts" && finding.line === 1)!;
  const onForge = first.findings.find((finding) => finding.file === "src/other.ts")!;

  assert.equal(
    (await h.api("POST", `/findings/${disposed.id}/resolve`, { note: "面板上判过的误报" })).status,
    200,
  );

  // Forge 上两条评论此刻都是 resolved:一条来自面板,一条是人直接在 Gitea 上点的。
  h.memory.existingComments.push(
    ...h.memory.publishedComments.map((comment) => ({ ...comment, resolved: true })),
  );
  const nextSha = h.repo.pushToHead({
    "src/answer.ts": "export const answer = 2;\n",
    "src/other.ts": "export const other = 3;\n",
  });
  h.memory.pullRequest.headSha = nextSha;
  assert.equal((await h.deliverViaHook(nextSha)).status, 200);
  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);

  const kept = await findingById(h, disposed.id);
  assert.equal(kept.disposition, "resolved");
  assert.equal(kept.disposedBy, PANEL_ADMIN_USERNAME);
  assert.equal(kept.note, "面板上判过的误报");

  // 面板没处置过的那条由回填补上,操作人为空——那是在 Gitea 上做的。
  const backfilled = await findingById(h, onForge.id);
  assert.equal(backfilled.disposition, "resolved");
  assert.equal(backfilled.disposedBy, null);
  assert.equal(backfilled.note, null);
});
