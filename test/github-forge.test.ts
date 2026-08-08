/**
 * GitHub 实现里读回 review 正文的那一段。用打桩的 `fetch` 驱动,不需要真实仓库。
 *
 * 这条路径与 `listReviewComments` 分了岔:后者走 GraphQL 的 reviewThreads,那里只有
 * 行级评论,读不到 review 自己的正文。其余方法由默认跳过的 `github-live.test.ts`
 * 对真实 pull request 覆盖。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitHubForge } from "../src/forge/github.ts";

const TOKEN = "github-token-must-not-leak";
const REF = { owner: "acme", repo: "widget", number: 7 };

test("读回 review 正文:走 REST 的 reviews 端点,带凭据并分页取完", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const requested: string[] = [];
  const auths: (string | null)[] = [];
  // 满一页才会去取下一页,分页因此要用满页的响应驱动。
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ body: `第 ${index} 条` }));

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(`${url.pathname}${url.search}`);
    auths.push(new Headers(init?.headers).get("authorization"));
    const page = url.searchParams.get("page") === "1" ? fullPage : [{ body: "最后一条" }];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const bodies = await createGitHubForge({
    auth: { kind: "token", token: TOKEN },
  }).listReviewBodies(REF);

  assert.deepEqual(requested, [
    "/repos/acme/widget/pulls/7/reviews?per_page=100&page=1",
    "/repos/acme/widget/pulls/7/reviews?per_page=100&page=2",
  ]);
  assert.deepEqual(auths, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  assert.equal(bodies.length, 101);
  assert.equal(bodies.at(-1), "最后一条");
});
