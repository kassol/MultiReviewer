/**
 * Review Run 的完整 diff(issue #160)。
 *
 * 打在面板 API 的真实 HTTP 缝上:git fixture 提供真实的两端与真实的改动,服务端从
 * 那份本地 clone 上取 diff。断言只看外部可观察的行为:HTTP 状态码与响应 JSON。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  HARNESS_PR,
  PANEL_PREFIX,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "run-diff-test-password";
const HASH = await hashPassword(PASSWORD);

type DiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

type DiffFiles = { baseSha: string; headSha: string; files: DiffFile[] };
type DiffPatch = { path: string; patch: string };

/** 一个已注册仓库,跑完一轮 PR 触发的 Review Run。 */
async function harnessWithRun(): Promise<PanelHarness> {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  return h;
}

async function latestRunId(h: PanelHarness): Promise<number> {
  const body = (await (await h.api("GET", "/runs")).json()) as { runs: { id: number }[] };
  assert.notEqual(body.runs[0], undefined, "时间流里没有轮次");
  return body.runs[0]!.id;
}

test("diff API:PR 触发的一轮按文件回列表,带增删行数与状态", async () => {
  const h = await harnessWithRun();
  const runId = await latestRunId(h);

  const response = await h.api("GET", `/runs/${runId}/diff`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as DiffFiles;

  // 范围的基准是 merge-base;夹具里 base 分支没有前进,它就是 base 自己。
  assert.equal(body.baseSha, h.repo.mergeBaseSha);
  assert.equal(body.headSha, h.repo.headSha);
  assert.deepEqual(
    body.files,
    [
      { path: "src/answer.ts", status: "modified", additions: 1, deletions: 1, binary: false },
      { path: "src/other.ts", status: "modified", additions: 1, deletions: 1, binary: false },
    ],
  );
});

test("diff API:带 file 参数只回那一个文件的 unified diff", async () => {
  const h = await harnessWithRun();
  const runId = await latestRunId(h);

  const response = await h.api("GET", `/runs/${runId}/diff?file=${encodeURIComponent("src/answer.ts")}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as DiffPatch;

  assert.equal(body.path, "src/answer.ts");
  assert.match(body.patch, /^diff --git a\/src\/answer\.ts b\/src\/answer\.ts$/m);
  assert.match(body.patch, /^@@ /m);
  assert.match(body.patch, /^-export const answer = 1;$/m);
  assert.match(body.patch, /^\+export const answer = 2;$/m);
  // 只取一个文件:另一个文件的改动不在这一份里。
  assert.equal(body.patch.includes("src/other.ts"), false);

  // 不在这个范围里的路径回空 patch,不是错误——文件列表才是权威。
  const missing = await h.api("GET", `/runs/${runId}/diff?file=src/nope.ts`);
  assert.equal(missing.status, 200);
  assert.equal(((await missing.json()) as DiffPatch).patch, "");
});

test("diff API:head 已不在本地副本里时 409 说明原因,不是 500", async () => {
  const h = await harnessWithRun();

  // 一轮指向已经不存在的 commit:分支删了或者仓库被强推过之后就是这个样子。
  const store = openStore(h.db.path);
  const runId = store.startRun({
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
    headSha: "0".repeat(40),
    startedAt: "2026-08-25T00:00:00.000Z",
    changedFiles: 0,
    changedLines: 0,
    batchCount: 1,
    reviewerPins: [],
  });
  store.close();

  const response = await h.api("GET", `/runs/${runId}/diff`);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /head commit/);

  // 不存在的一轮与不存在的端点分开:前者 404 带原因。
  assert.equal((await h.api("GET", "/runs/999999/diff")).status, 404);
});

test("diff API:范围审查的一轮按阶段基准取范围", async () => {
  const h = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  assert.equal(
    (
      await h.api("POST", "/range-reviews", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        base: h.repo.baseSha,
        comparison: h.repo.headSha,
      })
    ).status,
    202,
  );
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const runs = (await (await h.api("GET", "/runs")).json()) as {
    runs: { id: number; rangeReviewId: number | null }[];
  };
  const run = runs.runs[0]!;
  assert.notEqual(run.rangeReviewId, null);

  const body = (await (await h.api("GET", `/runs/${run.id}/diff`)).json()) as DiffFiles;
  assert.equal(body.baseSha, h.repo.baseSha);
  assert.equal(body.headSha, h.repo.headSha);
  assert.deepEqual(
    body.files.map((file) => file.path),
    ["src/answer.ts", "src/other.ts"],
  );
});

test("diff API:没有 review:read 的用户取不到", async () => {
  const h = await harnessWithRun();
  const runId = await latestRunId(h);

  const store = openStore(h.db.path);
  const role = store.createPanelRole({
    name: "只管仓库",
    permissions: ["repo:read"],
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "diff-outsider",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-25T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: role.id,
  });
  store.close();

  const login = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "diff-outsider", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const denied = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/runs/${runId}/diff`, {
    headers: { cookie },
  });
  assert.equal(denied.status, 403);
});
