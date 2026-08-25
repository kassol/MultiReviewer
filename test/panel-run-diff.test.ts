/**
 * Review Run 的完整 diff(issue #160)。
 *
 * 打在面板 API 的真实 HTTP 缝上:git fixture 提供真实的两端与真实的改动,服务端从
 * 那份本地 clone 上取 diff。断言只看外部可观察的行为:HTTP 状态码与响应 JSON。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
        title: "范围审查标题",
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

/** 在本地 clone 上直接跑一条 git 命令,用来制造并观测 gc 场景。 */
function runGit(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

test("diff API:远端 ref 已删且 gc 跑过之后,历史轮次的 diff 仍打得开", async () => {
  const h = await harnessWithRun();
  const runId = await latestRunId(h);
  const clone = join(h.cacheDir, HARNESS_PR.owner, HARNESS_PR.repo);

  // 这一轮的两端钉在本地 clone 上(issue #161)。
  assert.equal(runGit(clone, "rev-parse", `refs/multireviewer/runs/${runId}/head`), h.repo.headSha);
  assert.equal(runGit(clone, "rev-parse", `refs/multireviewer/runs/${runId}/base`), h.repo.baseSha);

  // 审查完成后的局面:远端再没有任何 ref 指向这一轮的 head,`fetch --prune` 把远程
  // 跟踪分支一并删掉,自定义命名空间下那两条不受影响。
  h.repo.deleteBranch("feature");
  runGit(clone, "fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*");
  assert.equal(runGit(clone, "rev-parse", `refs/multireviewer/runs/${runId}/head`), h.repo.headSha);

  // reflog 也让对象可达,默认 90 天后过期;这里直接过期掉,跑的就是那之后的局面。
  runGit(clone, "reflog", "expire", "--expire=now", "--all");
  runGit(clone, "gc", "--prune=now", "--quiet");

  const response = await h.api("GET", `/runs/${runId}/diff`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as DiffFiles;
  assert.equal(body.headSha, h.repo.headSha);
  assert.deepEqual(
    body.files.map((file) => file.path),
    ["src/answer.ts", "src/other.ts"],
  );
});

/**
 * 详情页打开一轮时按文件并发取 patch(issue #181)。同一轮的准备工作——库里的两端、
 * Forge 上的仓库与 pull request、本地副本上的两端解析——对这几十个请求是同一份;各做
 * 一遍就是几十次 Forge 往返加上百个 git 子进程,同一进程里排在后面的请求(含审查轨迹
 * 的 SSE 握手)只能等这批活干完。
 */
test("diff API:同一轮的并发文件请求共用一次准备,不按请求数放大 Forge 往返", async () => {
  const h = await harnessWithRun();

  // 一轮改到 20 个文件:面板默认展开有 Finding 的那些,大范围一次就是这个量级。
  const paths = Array.from({ length: 20 }, (_, index) => `src/mod${index}.ts`);
  const headSha = h.repo.pushToHead(
    Object.fromEntries(paths.map((path, index) => [path, `export const v = ${index};\n`])),
  );
  const store = openStore(h.db.path);
  const runId = store.startRun({
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    pullNumber: HARNESS_PR.number,
    headSha,
    startedAt: "2026-08-25T00:00:00.000Z",
    changedFiles: paths.length,
    changedLines: paths.length,
    batchCount: 1,
    reviewerPins: [],
  });
  store.close();

  // 详情页打开的一整套请求:先文件列表,再按文件取 patch。
  const dispatchedBefore = h.dispatched.length;
  const listed = await h.api("GET", `/runs/${runId}/diff`);
  assert.equal(listed.status, 200);
  const files = ((await listed.json()) as DiffFiles).files.map((file) => file.path);
  for (const path of paths) assert.ok(files.includes(path), `文件列表里没有 ${path}`);

  const responses = await Promise.all(
    paths.map((path) => h.api("GET", `/runs/${runId}/diff?file=${encodeURIComponent(path)}`)),
  );

  // 合并的是准备,不是结果:每个请求仍旧只拿到自己那个文件的 patch。
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    const body = (await response.json()) as DiffPatch;
    assert.equal(body.path, paths[index]);
    assert.match(body.patch, new RegExp(`^\\+\\+\\+ b/src/mod${index}\\.ts$`, "m"));
  }

  // 21 个请求只读一次 pull request——修复前是一个请求读一次。
  assert.equal(h.dispatched.length - dispatchedBefore, 1);
});
