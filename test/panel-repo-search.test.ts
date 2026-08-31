/**
 * 注册用的仓库搜索端点(issue #70)。走面板真实 HTTP,搜索打到假 Gitea 的
 * `/repos/search`——它回 `{ok, data}` 包装加 `X-Total-Count`,与其余端点的裸数组不同。
 *
 * 被测的核心是「两类不可选项照样返回并标对」:已注册查注册表,无 admin 权限读搜索
 * 结果自带的权限字段。过滤掉会让人明知仓库存在却搜不到。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  GITEA_REPO,
  HARNESS_PR as PR,
  startPanelHarness,
  startReadyPanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const startHarness = (): ReturnType<typeof startReadyPanelHarness> =>
  startReadyPanelHarness(cleanups);

type SearchResult = {
  repoId: number;
  owner: string;
  repo: string;
  registered: boolean;
  admin: boolean;
  reason?: string;
};
type SearchBody = {
  state: string;
  total: number;
  truncated: boolean;
  results: SearchResult[];
};

const search = async (
  h: Awaited<ReturnType<typeof startPanelHarness>>,
  q: string,
): Promise<SearchBody> => {
  const response = await h.api("GET", `/repos/search?q=${encodeURIComponent(q)}`);
  assert.equal(response.status, 200);
  return (await response.json()) as SearchBody;
};

test("搜索解开 {ok, data} 包装,已注册与无 admin 权限两类都返回并标对", async () => {
  const h = await startHarness();
  h.gitea.search.push(
    { id: 5001, owner: PR.owner, repo: "widgets-fork", admin: true },
    { id: 5002, owner: PR.owner, repo: "widgets-readonly", admin: false },
  );
  assert.equal((await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo })).status, 201);

  const body = await search(h, "widgets");

  assert.equal(body.state, "ok");
  assert.equal(body.truncated, false);
  // 包装解开后拿到的是三条仓库,不是包装体本身。
  assert.deepEqual(
    body.results.map((row) => [row.repoId, `${row.owner}/${row.repo}`, row.registered, row.admin]),
    [
      [GITEA_REPO.id, `${PR.owner}/${PR.repo}`, true, true],
      [5001, `${PR.owner}/widgets-fork`, false, true],
      [5002, `${PR.owner}/widgets-readonly`, false, false],
    ],
  );

  // 已注册那条说的是「已注册」,无权限那条沿用权限检查的说明文字。
  assert.match(body.results[0]!.reason!, /已注册/);
  assert.equal(body.results[1]!.reason, undefined);
  assert.match(body.results[2]!.reason!, /admin/);

});

test("无权限的置灰理由与注册被拒时的说明是同一句", async () => {
  const h = await startHarness();
  // 同一个仓库:搜索里权限字段为假,注册时权限检查也判非 admin。
  h.gitea.search[0]!.admin = false;
  h.gitea.control.admin = false;

  const body = await search(h, PR.repo);
  const rejected = await h.api("POST", "/repos", { owner: PR.owner, repo: PR.repo });

  assert.equal(rejected.status, 403);
  assert.equal(body.results[0]!.reason, ((await rejected.json()) as { error: string }).error);
});

test("空关键字与无结果各有明确形态", async () => {
  const h = await startHarness();

  const empty = await search(h, "   ");
  assert.deepEqual(empty, { state: "empty-query", total: 0, truncated: false, results: [] });

  const none = await search(h, "nonexistent-zzz");
  assert.deepEqual(none, { state: "no-match", total: 0, truncated: false, results: [] });
});

test("只取第一页,装不下时报总数并标截断", async () => {
  const h = await startHarness();
  for (let index = 0; index < 60; index += 1) {
    h.gitea.search.push({ id: 6000 + index, owner: "acme", repo: `bulk-${index}`, admin: true });
  }

  const body = await search(h, "acme/");

  // 61 条匹配,一页只取 50:剩下的靠继续输入缩小范围,不翻页。
  assert.equal(body.total, 61);
  assert.equal(body.results.length, 50);
  assert.equal(body.truncated, true);
});

test("搜索走面板门禁:没有 session 一律 401", async () => {
  const h = await startHarness();
  const response = await fetch(`${h.serverUrl}/api/repos/search?q=widgets`);
  assert.equal(response.status, 401);
});
