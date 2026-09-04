/**
 * 阶段汇总(issue #168)。
 *
 * 打在面板 API 的真实 HTTP 缝上:库由 Store 自己的写入口播种(落轮次、自动处置、
 * 延续都走产品代码那几个方法),断言只看 HTTP 响应——列表按 Finding Identity 折叠成
 * 什么样、三个计数、时间线每轮五个数,以及这个端点登录即可读。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import type { PanelPermission } from "../src/panel/permissions.ts";
import { openStore, type Store } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "stage-summary-test-password";
const HASH = await hashPassword(PASSWORD);

type SummaryFinding = {
  id: number;
  file: string;
  line: number;
  title: string;
  severity: string;
  category: string;
  description: string;
  models: string[];
  disposition: string;
  placement: string;
  commentId: string | null;
  commentHtmlUrl: string | null;
  disposedBy: string | null;
  disposedAt: string | null;
  note: string | null;
  continuedFrom: string | null;
  lineAuthor: {
    sha: string;
    name: string;
    email: string;
    authoredAt: string;
    adjacent: boolean;
  } | null;
  firstRunId: number;
  firstReportedAt: string;
  lastRunId: number;
  lastReportedAt: string;
};

type TimelineEntry = {
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

type SummaryBody = {
  findings: SummaryFinding[];
  counts: { pending: number; resolved: number; fixed: number };
  timeline: TimelineEntry[];
};

type SeedFinding = {
  file: string;
  line: number;
  fingerprint: string;
  disposition?: "unknown" | "unresolved" | "resolved";
  placement?: "inline" | "body";
  models?: string[];
  commentId?: string;
  lineAuthor?: { sha: string; name: string; email: string; authoredAt: string; adjacent: boolean };
};

/** 落一轮 Review Run:一条 Finding 一个合并组,归属按传入的模型逐条落。 */
function seedRun(
  store: Store,
  meta: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    startedAt: string;
    rangeReviewId?: number;
  },
  findings: SeedFinding[],
  verdicts: { model: string; findingId: number; verdict: "present" | "fixed" | "unclear"; missing?: boolean }[] = [],
): number {
  const runId = store.startRun({
    ...meta,
    changedFiles: 1,
    changedLines: 1,
    batchCount: 1,
    reviewerPins: [],
  });
  store.finishRun(runId, {
    finishedAt: meta.startedAt,
    durationMs: 1,
    failed: false,
    outcomes: [],
    findings: findings.map((finding, index) => ({
      file: finding.file,
      line: finding.line,
      title: `标题 ${finding.fingerprint}`,
      severity: "P1" as const,
      category: "bug" as const,
      description: `正文 ${finding.fingerprint}`,
      attributions: (finding.models ?? ["model-a"]).map((model) => ({
        model,
        severity: "P1" as const,
        category: "bug" as const,
        description: `正文 ${finding.fingerprint}`,
      })),
      fingerprint: finding.fingerprint,
      groupIndex: index,
      disposition: finding.disposition ?? "unknown",
      placement: finding.placement ?? "inline",
      ...(finding.commentId === undefined
        ? {}
        : {
            commentId: finding.commentId,
            commentHtmlUrl: `https://gitea.example.test/comments/${finding.commentId}`,
          }),
      ...(finding.lineAuthor === undefined ? {} : { lineAuthor: finding.lineAuthor }),
    })),
    verdicts: verdicts.map((entry) => ({
      model: entry.model,
      findingId: entry.findingId,
      verdict: entry.verdict,
      missing: entry.missing === true,
    })),
  });
  return runId;
}

/** 库里那条 Finding 行的 id:按轮次与指纹认。 */
function findingId(store: Store, runId: number, fingerprint: string): number {
  const runs = store.listRuns({ limit: 50 });
  const run = runs.find((item) => item.id === runId);
  assert.notEqual(run, undefined, `没有这一轮 ${runId}`);
  const row = run!.findings.find((item) => item.description === `正文 ${fingerprint}`);
  assert.notEqual(row, undefined, `第 ${runId} 轮里没有 ${fingerprint}`);
  return row!.id;
}

/**
 * 一个走完三轮的范围审查阶段:
 *
 * - `fp-a` 三轮都报出,最后一轮被人处置——同一条只该出现一次,状态取最新一轮。
 * - `fp-b` 第一轮报出,第二轮全部 Reviewer 复核判已修,自动记「已修复」。
 * - `fp-c` 第一轮报出,第二轮复核判仍在而代码已改写,交接给新位置的 `fp-c2`。
 * - `fp-d` 第二轮才新报出,第三轮折叠。
 */
function seedStage(dbPath: string): { rangeReviewId: number; runs: number[] } {
  const store = openStore(dbPath);
  try {
    // 注册表里要有这个仓库:普通用户的可见范围由「分配的 repo id」经注册表认出来。
    store.registerRepo({
      repoId: GITEA_REPO.id,
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      generation: 1,
      key: "stage-summary-key",
    });
    const rangeReviewId = store.createRangeReview({
      repoId: GITEA_REPO.id,
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      title: "阶段汇总夹具",
      baseSha: "base-sha",
      comparisonSha: "sha-1",
      createdBy: "operator",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    const container = { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo, pullNumber: 900 };

    const run1 = seedRun(
      store,
      { ...container, headSha: "sha-1", startedAt: "2026-08-20T01:00:00.000Z", rangeReviewId },
      [
        { file: "src/a.ts", line: 5, fingerprint: "fp-a", commentId: "c1", models: ["model-a", "model-b"] },
        { file: "src/b.ts", line: 9, fingerprint: "fp-b", commentId: "c2" },
        { file: "src/c.ts", line: 3, fingerprint: "fp-c", commentId: "c3" },
      ],
    );
    const aRun1 = findingId(store, run1, "fp-a");
    const bRun1 = findingId(store, run1, "fp-b");
    const cRun1 = findingId(store, run1, "fp-c");

    // 第二轮:a 折叠、d 新报出、c2 承接 c 的位置;b 由复核判已修自动处置。
    const run2 = seedRun(
      store,
      { ...container, headSha: "sha-2", startedAt: "2026-08-20T02:00:00.000Z", rangeReviewId },
      [
        { file: "src/a.ts", line: 5, fingerprint: "fp-a", commentId: "c1", models: ["model-a", "model-b"] },
        { file: "src/c.ts", line: 20, fingerprint: "fp-c2", commentId: "c4" },
        { file: "src/d.ts", line: 1, fingerprint: "fp-d", commentId: "c5" },
      ],
      [
        // b:两个模型都判已修 → 自动处置。
        { model: "model-a", findingId: bRun1, verdict: "fixed" },
        { model: "model-b", findingId: bRun1, verdict: "fixed" },
        // c:任一判仍在即仍在 → 走延续。
        { model: "model-a", findingId: cRun1, verdict: "present" },
        { model: "model-b", findingId: cRun1, verdict: "unclear", missing: true },
        // a:漏复核不构成证据,原样留着。
        { model: "model-a", findingId: aRun1, verdict: "unclear", missing: true },
        { model: "model-b", findingId: aRun1, verdict: "unclear" },
      ],
    );
    store.recordAutoDisposition(
      container.owner,
      container.repo,
      container.pullNumber,
      { findingId: bRun1, commentId: "c2" },
      "2026-08-20T02:05:00.000Z",
    );
    const [continuation] = store.continuationCandidates([cRun1]);
    assert.notEqual(continuation, undefined, "c 应当还能被延续");
    store.recordContinuation({
      ...container,
      runId: run2,
      // fp-c2 是这一轮的第二个合并组。
      groupIndex: 1,
      candidate: continuation!,
    });

    // 第三轮:三条都折叠,a 被人在面板上处置。
    const run3 = seedRun(
      store,
      { ...container, headSha: "sha-3", startedAt: "2026-08-20T03:00:00.000Z", rangeReviewId },
      [
        {
          file: "src/a.ts",
          line: 5,
          fingerprint: "fp-a",
          commentId: "c1",
          models: ["model-a", "model-b"],
          disposition: "resolved",
        },
        { file: "src/c.ts", line: 20, fingerprint: "fp-c2", commentId: "c4" },
        { file: "src/d.ts", line: 1, fingerprint: "fp-d", commentId: "c5" },
      ],
    );
    return { rangeReviewId, runs: [run1, run2, run3] };
  } finally {
    store.close();
  }
}

async function summaryOf(h: PanelHarness, query: string): Promise<SummaryBody> {
  const response = await h.api("GET", `/stage-summary?${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as SummaryBody;
}

test("阶段汇总:同一条只出现一次、状态取最新一轮,已延续不在待处置,计数与列表一致", async () => {
  const h = await startPanelHarness(cleanups);
  const { rangeReviewId, runs } = seedStage(h.db.path);

  const body = await summaryOf(h, `rangeReviewId=${rangeReviewId}`);

  // 三轮报出 9 行,折叠成 4 条 Identity:a、b、d 与承接了 c 的 c2。
  assert.deepEqual(
    body.findings.map((finding) => finding.description).sort(),
    ["正文 fp-a", "正文 fp-b", "正文 fp-c2", "正文 fp-d"],
  );

  const a = body.findings.find((finding) => finding.description === "正文 fp-a")!;
  // 状态取最新一轮那一行:前两轮还是未处置,第三轮人处置掉了。
  assert.equal(a.disposition, "resolved");
  assert.equal(a.firstRunId, runs[0]);
  assert.equal(a.lastRunId, runs[2]);
  assert.deepEqual(a.models, ["model-a", "model-b"]);
  assert.equal(a.commentHtmlUrl, "https://gitea.example.test/comments/c1");

  // 「已修复」是自动处置,处置人留空。
  const b = body.findings.find((finding) => finding.description === "正文 fp-b")!;
  assert.equal(b.disposition, "fixed");
  assert.equal(b.disposedBy, null);
  assert.equal(b.disposedAt, "2026-08-20T02:05:00.000Z");

  // 已延续的那条 Identity 交接给了新位置:旧行不出现,新行带着延续来源与原来的首见轮次。
  const c2 = body.findings.find((finding) => finding.description === "正文 fp-c2")!;
  assert.equal(c2.disposition, "unknown");
  assert.equal(c2.continuedFrom, "https://gitea.example.test/comments/c3");
  assert.equal(c2.firstRunId, runs[0]);
  assert.equal(c2.lastRunId, runs[2]);
  assert.ok(!body.findings.some((finding) => finding.disposition === "continued"));

  // 三个计数与列表口径一致:待处置只数未处置那两条,已延续一条都不占。
  assert.deepEqual(body.counts, { pending: 2, resolved: 1, fixed: 1 });
  assert.equal(
    body.counts.pending + body.counts.resolved + body.counts.fixed,
    body.findings.length,
  );
});

test("阶段汇总的时间线:每轮的新报出 / 折叠 / 已修复 / 已延续 / 漏复核", async () => {
  const h = await startPanelHarness(cleanups);
  const { rangeReviewId, runs } = seedStage(h.db.path);

  const body = await summaryOf(h, `rangeReviewId=${rangeReviewId}`);
  assert.deepEqual(
    body.timeline.map((entry) => entry.runId),
    runs,
  );
  assert.deepEqual(
    body.timeline.map((entry) => ({
      reported: entry.reported,
      folded: entry.folded,
      fixed: entry.fixed,
      continued: entry.continued,
      missed: entry.missedVerdicts,
    })),
    [
      // 第一轮三条都是新报出。
      { reported: 3, folded: 0, fixed: 0, continued: 0, missed: 0 },
      // 第二轮:d 新报出、a 折叠、b 自动处置、c 交接给 c2;两条漏复核。
      { reported: 1, folded: 1, fixed: 1, continued: 1, missed: 2 },
      // 第三轮三条都折叠。
      { reported: 0, folded: 3, fixed: 0, continued: 0, missed: 0 },
    ],
  );
  assert.deepEqual(
    body.timeline.map((entry) => entry.headSha),
    ["sha-1", "sha-2", "sha-3"],
  );
});

test("阶段汇总按 pull request 取范围:容器 PR 的轮次不混进 PR 链路", async () => {
  const h = await startPanelHarness(cleanups);
  seedStage(h.db.path);
  const store = openStore(h.db.path);
  try {
    seedRun(
      store,
      {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
        headSha: "pr-sha-1",
        startedAt: "2026-08-21T01:00:00.000Z",
      },
      [{ file: "src/pr.ts", line: 2, fingerprint: "fp-pr", commentId: "p1" }],
    );
  } finally {
    store.close();
  }

  const body = await summaryOf(
    h,
    `owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}&pullNumber=${HARNESS_PR.number}`,
  );
  assert.deepEqual(
    body.findings.map((finding) => finding.description),
    ["正文 fp-pr"],
  );
  assert.deepEqual(body.counts, { pending: 1, resolved: 0, fixed: 0 });
  assert.equal(body.timeline.length, 1);
});

test("阶段汇总每条 Finding 带行作者,未判定的那条是 null", async () => {
  const h = await startPanelHarness(cleanups);
  const store = openStore(h.db.path);
  try {
    seedRun(
      store,
      {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
        headSha: "pr-sha-1",
        startedAt: "2026-08-21T01:00:00.000Z",
      },
      [
        {
          file: "src/pr.ts",
          line: 2,
          fingerprint: "fp-authored",
          commentId: "p1",
          lineAuthor: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            name: "Alice Lin",
            email: "alice@example.invalid",
            authoredAt: "2026-08-21T00:30:00.000Z",
            // 相邻改动标记随行作者一起投影出去(issue #241)。
            adjacent: true,
          },
        },
        // 四列同 NULL 即未判定:侧滑显示「无法追溯」,读路径按 null 给。
        { file: "src/pr.ts", line: 9, fingerprint: "fp-unknown", commentId: "p2" },
      ],
    );
  } finally {
    store.close();
  }

  const body = await summaryOf(
    h,
    `owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}&pullNumber=${HARNESS_PR.number}`,
  );
  const authored = body.findings.find((finding) => finding.description === "正文 fp-authored")!;
  assert.deepEqual(authored.lineAuthor, {
    sha: "0123456789abcdef0123456789abcdef01234567",
    name: "Alice Lin",
    email: "alice@example.invalid",
    authoredAt: "2026-08-21T00:30:00.000Z",
    adjacent: true,
  });
  const unknown = body.findings.find((finding) => finding.description === "正文 fp-unknown")!;
  assert.equal(unknown.lineAuthor, null);
});

type StoredLineAuthor = { sha: unknown; name: unknown; email: unknown; at: unknown };

/** 库里落着的行作者四列,按落库顺序。补录写没写回只能从库里看。 */
function storedLineAuthors(dbPath: string): StoredLineAuthor[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT line_author_sha AS sha, line_author_name AS name,
                line_author_email AS email, line_author_at AS at
           FROM finding ORDER BY id`,
      )
      .all() as unknown as Record<string, unknown>[];
    // node:sqlite 的行是无原型对象,`deepEqual` 会拿它跟字面量比出差异。
    return rows.map((row) => ({
      sha: row["sha"],
      name: row["name"],
      email: row["email"],
      at: row["at"],
    }));
  } finally {
    db.close();
  }
}

/** 把夹具仓库克隆成这个仓库的缓存副本:补录在它上面按 revision 判定。 */
function cloneRepoCache(h: PanelHarness): string {
  const path = join(h.cacheDir, HARNESS_PR.owner, HARNESS_PR.repo);
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("git", ["clone", "--quiet", h.repo.dir, path]);
  return path;
}

const PR_QUERY = `owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}&pullNumber=${HARNESS_PR.number}`;

test("阶段汇总给升级前的 Finding 补录行作者并写回,之后不再重算", async () => {
  const h = await startPanelHarness(cleanups);
  // 升级前那一轮的 head,由一个认得出的作者改出来。
  const headSha = h.repo.commitToBranch(
    "feature",
    { "src/answer.ts": "export const answer = 3;\n" },
    { authorName: "Alice Lin", authorEmail: "alice@example.invalid" },
  );
  const cached = cloneRepoCache(h);

  const store = openStore(h.db.path);
  try {
    // 行作者四列全空:这条是升级前落的。
    seedRun(
      store,
      {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
        headSha,
        startedAt: "2026-08-21T01:00:00.000Z",
      },
      [{ file: "src/answer.ts", line: 1, fingerprint: "fp-old", commentId: "p1" }],
    );
  } finally {
    store.close();
  }

  const body = await summaryOf(h, PR_QUERY);
  assert.equal(body.findings.length, 1);
  const lineAuthor = body.findings[0]!.lineAuthor;
  assert.notEqual(lineAuthor, null);
  assert.equal(lineAuthor!.sha, headSha);
  assert.equal(lineAuthor!.name, "Alice Lin");
  assert.equal(lineAuthor!.email, "alice@example.invalid");
  assert.match(lineAuthor!.authoredAt, /^\d{4}-\d{2}-\d{2}T/);

  // 库里已经写回,不只是这一次响应算出来的。
  assert.deepEqual(storedLineAuthors(h.db.path), [
    {
      sha: headSha,
      name: "Alice Lin",
      email: "alice@example.invalid",
      at: lineAuthor!.authoredAt,
    },
  ]);

  // 写回之后不再重算:缓存副本没了也照样给得出同一个行作者。
  rmSync(cached, { recursive: true, force: true });
  const again = await summaryOf(h, PR_QUERY);
  assert.deepEqual(again.findings[0]!.lineAuthor, lineAuthor);
});

test("阶段汇总补录不了行作者时照常 200,那几条留空等下次读取再试", async () => {
  const h = await startPanelHarness(cleanups);
  cloneRepoCache(h);

  const store = openStore(h.db.path);
  try {
    // 这一轮的 head 在缓存副本里不可达:评审失败提前退出、没跑过钉住那一步的旧轮次。
    seedRun(
      store,
      {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
        headSha: "0000000000000000000000000000000000000000",
        startedAt: "2026-08-21T01:00:00.000Z",
      },
      [{ file: "src/answer.ts", line: 1, fingerprint: "fp-unreachable", commentId: "p1" }],
    );
  } finally {
    store.close();
  }

  const body = await summaryOf(h, PR_QUERY);
  assert.equal(body.findings[0]!.lineAuthor, null);
  assert.deepEqual(storedLineAuthors(h.db.path), [
    { sha: null, name: null, email: null, at: null },
  ]);
});

test("阶段汇总的入参:两条链路只能选一条,范围审查不存在时 404", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal((await h.api("GET", "/stage-summary")).status, 400);
  assert.equal(
    (await h.api("GET", `/stage-summary?owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}`)).status,
    400,
  );
  assert.equal((await h.api("GET", "/stage-summary?rangeReviewId=abc")).status, 400);
  assert.equal((await h.api("GET", "/stage-summary?rangeReviewId=4242")).status, 404);
});

test("阶段汇总登录即可读:未登录 401,一格权限都没有的人分到仓库就读得到", async () => {
  const h = await startPanelHarness(cleanups);
  const { rangeReviewId } = seedStage(h.db.path);
  const path = `/api/stage-summary?rangeReviewId=${rangeReviewId}`;

  assert.equal((await fetch(`${h.serverUrl}${path}`)).status, 401);

  const readerCookie = await userCookie(h, "stage-reader", []);
  assert.equal((await fetch(`${h.serverUrl}${path}`, { headers: { cookie: readerCookie } })).status, 200);
});

/** 建一个只挂指定权限的用户并登录,拿它的会话 cookie。仓库一并分给他:可见才能读。 */
async function userCookie(
  h: PanelHarness,
  username: string,
  permissions: readonly PanelPermission[],
): Promise<string> {
  const store = openStore(h.db.path);
  try {
    const role = store.createPanelRole({
      name: `role-${username}`,
      permissions,
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    store.createPanelUser({
      username,
      displayName: null,
      passwordHash: HASH,
      mustChangePassword: false,
      createdAt: "2026-08-20T00:00:00.000Z",
      isSystemAdmin: false,
      roleId: role.id,
    });
    store.setPanelUserAssignment(username, [GITEA_REPO.id]);
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
