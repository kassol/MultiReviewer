/**
 * commit 选择器的两个只读接口(issue #178):列分支与列某分支的提交。
 *
 * 打在面板 API 的真实 HTTP 缝上:数据来自服务端本地 clone,git fixture 就是那个「远端」,
 * 往它上面推一个 commit 即模拟作者推代码。断言只看响应。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  HARNESS_PR,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type Branch = { name: string; isDefault: boolean };
type Commit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
};

const REPO_QUERY = `owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}`;

async function registeredHarness(): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  return harness;
}

async function branches(h: PanelHarness): Promise<Branch[]> {
  const response = await h.api("GET", `/repo-branches?${REPO_QUERY}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { branches: Branch[] }).branches;
}

async function commits(h: PanelHarness, query: string): Promise<{ commits: Commit[]; nextOffset: number | null }> {
  const response = await h.api("GET", `/repo-commits?${REPO_QUERY}&${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as { commits: Commit[]; nextOffset: number | null };
}

test("列分支:标出默认分支,容器 PR 的机器人分支不出现", async () => {
  const h = await registeredHarness();
  // 远端上已经有一个容器 PR 的两条分支(ADR 0012 的固定前缀)。
  h.repo.setBranch("multireviewer/9-base", h.repo.baseSha);
  h.repo.setBranch("multireviewer/9-head", h.repo.headSha);

  const rows = await branches(h);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["feature", "main"],
  );
  assert.deepEqual(
    rows.filter((row) => row.isDefault).map((row) => row.name),
    ["main"],
  );
});

test("列提交:每条带短 sha、完整 sha、信息首行、作者与时间", async () => {
  const h = await registeredHarness();

  const page = await commits(h, "branch=feature");
  assert.equal(page.nextOffset, null);
  const [head] = page.commits;
  assert.notEqual(head, undefined);
  assert.equal(head!.sha, h.repo.headSha);
  assert.equal(head!.shortSha, h.repo.headSha.slice(0, 7));
  assert.equal(head!.subject, "head");
  assert.equal(head!.author, "fixture");
  assert.match(head!.authoredAt, /^\d{4}-\d{2}-\d{2}T/);
  // feature 上是 base 那一个加自己那一个,新的在前。
  assert.deepEqual(
    page.commits.map((commit) => commit.sha),
    [h.repo.headSha, h.repo.mergeBaseSha],
  );
});

test("列提交:offset 与 limit 分页,还有下一页时给 nextOffset", async () => {
  const h = await registeredHarness();

  const first = await commits(h, "branch=feature&limit=1");
  assert.deepEqual(first.commits.map((commit) => commit.sha), [h.repo.headSha]);
  assert.equal(first.nextOffset, 1);

  const second = await commits(h, `branch=feature&limit=1&offset=${first.nextOffset}`);
  assert.deepEqual(second.commits.map((commit) => commit.sha), [h.repo.mergeBaseSha]);

  // 取满一页就还给下一页的入口(与评审记录同一套),翻过头拿到的是空的一页。
  const third = await commits(h, `branch=feature&limit=1&offset=${second.nextOffset}`);
  assert.deepEqual(third.commits, []);
  assert.equal(third.nextOffset, null);
});

test("列分支先 fetch:刚推上远端的 commit 随即选得到", async () => {
  const h = await registeredHarness();
  // 先让本地 clone 建出来,新 commit 才是「已有副本之后推的」。
  await branches(h);

  const pushed = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await branches(h);

  const page = await commits(h, "branch=feature");
  assert.equal(page.commits[0]!.sha, pushed);
});

test("列分支与列提交:仓库要注册,分支要存在", async () => {
  const h = await registeredHarness();

  assert.equal((await h.api("GET", "/repo-branches?owner=nobody&repo=nothing")).status, 409);
  assert.equal((await h.api("GET", `/repo-commits?${REPO_QUERY}`)).status, 400);
  assert.equal(
    (await h.api("GET", `/repo-commits?${REPO_QUERY}&branch=no-such-branch`)).status,
    404,
  );
  assert.equal(
    (await h.api("GET", `/repo-commits?${REPO_QUERY}&branch=feature&offset=-1`)).status,
    400,
  );
});
