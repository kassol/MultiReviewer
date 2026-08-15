/**
 * Gitea 的 Forge 实现。用打桩的 `fetch` 驱动,不需要真实实例。
 *
 * 只验证外部可观察的行为:发出去的请求打在哪个端点、带什么头与什么body,读回来的
 * 响应被解释成什么。端点与字段名的源码依据写在 `src/forge/gitea.ts` 的注释里。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertSupportedVersion, createGiteaForge } from "../src/forge/gitea.ts";
import { stubFetch, type Route } from "./support/stub-fetch.ts";

const BASE_URL = "https://gitea.example.test";
/** 凭据绝不应出现在错误信息里,这个值就是用来在断言里反查它有没有漏出去。 */
const TOKEN = "gitea-pat-must-not-leak";
const OPTIONS = { baseUrl: BASE_URL, token: TOKEN };
const REF = { owner: "acme", repo: "widget", number: 7 };
const HEAD_SHA = "h".repeat(40);
const BASE_SHA = "b".repeat(40);

function routes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /api/v1/version": { body: { version: "1.26.4" } },
    // reaction 的两个端点都回 204 无正文,实现因此不解析响应体。
    "POST /api/v1/repos/acme/widget/issues/7/reactions": { status: 204 },
    "DELETE /api/v1/repos/acme/widget/issues/7/reactions": { status: 204 },
    "GET /api/v1/repos/acme/widget/pulls/7": {
      body: {
        number: 7,
        draft: false,
        base: { sha: BASE_SHA, repo: { clone_url: `${BASE_URL}/acme/widget.git` } },
        head: { sha: HEAD_SHA },
      },
    },
    "GET /api/v1/repos/acme/widget/pulls/7/files?page=1&limit=100": {
      body: [{ filename: "src/a.ts", status: "changed" }],
    },
    "POST /api/v1/repos/acme/widget/pulls/7/reviews": { body: { id: 99 } },
    "GET /api/v1/repos/acme/widget/pulls/7/reviews?page=1&limit=100": {
      body: [{ id: 11, comments_count: 1 }],
    },
    "GET /api/v1/repos/acme/widget/pulls/7/reviews/11/comments": {
      body: [
        {
          id: 501,
          path: "src/a.ts",
          position: 42,
          original_position: 0,
          body: "既有评论",
          resolver: null,
        },
      ],
    },
    "POST /api/v1/repos/acme/widget/pulls/comments/501/resolve": { status: 204 },
    "POST /api/v1/repos/acme/widget/pulls/comments/501/unresolve": { status: 204 },
    ...overrides,
  };
}

test("每一次 Gitea API 调用都带上凭据,读取类调用也不例外", async (t) => {
  const stub = stubFetch(routes());
  t.after(stub.restore);
  const forge = createGiteaForge(OPTIONS);

  // 目标实例要求登录后才能调用 API(ADR 0002),漏掉任何一处读取类调用都会当场 403。
  await assertSupportedVersion(OPTIONS);
  await forge.getPullRequest(REF);
  await forge.listChangedFiles(REF);
  await forge.listReviewComments(REF);
  await forge.listReviewBodies(REF);
  await forge.createReview(REF, { body: "正文", commitSha: HEAD_SHA, comments: [] });
  await forge.resolveComment(REF, "501");
  await forge.unresolveComment(REF, "501");
  await forge.cloneCredentials(REF);

  assert.ok(stub.calls.length >= 7, `只发出了 ${stub.calls.length} 个请求`);
  for (const call of stub.calls) {
    assert.equal(call.auth, `token ${TOKEN}`, `${call.method} ${call.url} 没有带凭据`);
  }
});

test("PR 元数据取 base/head 的 sha 与 base 仓库的 clone 地址", async (t) => {
  const stub = stubFetch(routes());
  t.after(stub.restore);

  const pullRequest = await createGiteaForge(OPTIONS).getPullRequest(REF);

  assert.deepEqual(pullRequest, {
    number: 7,
    draft: false,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    cloneUrl: `${BASE_URL}/acme/widget.git`,
  });
});

test("行级评论带 path 与 new_position,行号是 head commit 里的文件行号", async (t) => {
  const stub = stubFetch(routes());
  t.after(stub.restore);

  await createGiteaForge(OPTIONS).createReview(REF, {
    body: "MultiReviewer",
    commitSha: HEAD_SHA,
    comments: [{ path: "src/a.ts", line: 42, body: "这里会越界" }],
  });

  const posted = stub.calls.find((c) => c.method === "POST");
  assert.ok(posted !== undefined);
  assert.equal(posted.url, `${BASE_URL}/api/v1/repos/acme/widget/pulls/7/reviews`);
  assert.deepEqual(posted.body, {
    commit_id: HEAD_SHA,
    body: "MultiReviewer",
    // 审查是建议不是门禁,一律用不阻断合并的 COMMENT。
    event: "COMMENT",
    comments: [
      // `new_position` 是新文件的行号本身,不是 diff 内的偏移;旧文件一侧走
      // `old_position`,本工具只评论 head commit,因此从不填它。
      { path: "src/a.ts", body: "这里会越界", new_position: 42 },
    ],
  });
});

test("变更文件的状态映射到 ChangedFileStatus 的四个取值", async (t) => {
  const stub = stubFetch(
    routes({
      "GET /api/v1/repos/acme/widget/pulls/7/files?page=1&limit=100": {
        body: [
          { filename: "new.ts", status: "added" },
          { filename: "copy.ts", status: "copied" },
          // Gitea 把「修改」写作 `changed`,GitHub 那边才叫 `modified`。
          { filename: "edit.ts", status: "changed" },
          { filename: "same.ts", status: "unchanged" },
          // 同样地,Gitea 是 `deleted` 而非 GitHub 的 `removed`。
          { filename: "gone.ts", status: "deleted" },
          { filename: "moved.ts", status: "renamed" },
        ],
      },
    }),
  );
  t.after(stub.restore);

  const files = await createGiteaForge(OPTIONS).listChangedFiles(REF);

  assert.deepEqual(files, [
    { path: "new.ts", status: "added" },
    { path: "copy.ts", status: "added" },
    { path: "edit.ts", status: "modified" },
    { path: "same.ts", status: "modified" },
    { path: "gone.ts", status: "removed" },
    { path: "moved.ts", status: "renamed" },
  ]);
});

test("读回 review 评论:position 是文件行号,resolver 非空即已处置", async (t) => {
  const stub = stubFetch(
    routes({
      "GET /api/v1/repos/acme/widget/pulls/7/reviews?page=1&limit=100": {
        body: [
          { id: 11, comments_count: 3 },
          // 没有行级评论的 review(例如人点的 approve)不必再取它的评论。
          { id: 12, comments_count: 0 },
        ],
      },
      "GET /api/v1/repos/acme/widget/pulls/7/reviews/11/comments": {
        body: [
          {
            id: 501,
            path: "src/a.ts",
            position: 42,
            original_position: 0,
            body: "未处置",
            resolver: null,
          },
          {
            id: 502,
            path: "src/b.ts",
            position: 7,
            original_position: 0,
            body: "已处置",
            resolver: { id: 3, login: "kassol" },
          },
          // 挂在旧文件一侧的评论对应不到 head commit 里的行,跳过好过编一个行号传下去。
          {
            id: 503,
            path: "src/c.ts",
            position: 0,
            original_position: 9,
            body: "旧侧",
            resolver: null,
          },
        ],
      },
    }),
  );
  t.after(stub.restore);

  const comments = await createGiteaForge(OPTIONS).listReviewComments(REF);

  assert.deepEqual(comments, [
    { id: "501", path: "src/a.ts", line: 42, body: "未处置", resolved: false },
    { id: "502", path: "src/b.ts", line: 7, body: "已处置", resolved: true },
  ]);
  assert.ok(
    !stub.calls.some((c) => c.url.includes("/reviews/12/comments")),
    "没有行级评论的 review 不该再发一次请求",
  );
});

test("读回 review 正文:没有行级评论的 review 也要读,正文照样带锚点", async (t) => {
  const stub = stubFetch(
    routes({
      "GET /api/v1/repos/acme/widget/pulls/7/reviews?page=1&limit=100": {
        body: [
          { id: 11, comments_count: 1, body: "MultiReviewer" },
          // 一次 Finding 全部落在 diff 之外的 Review Run 就是这个形状:正文里有
          // fallback 块,行级评论一条都没有。跟着 comments_count 跳过会把它漏掉。
          { id: 12, comments_count: 0, body: "diff 之外的 Finding" },
        ],
      },
    }),
  );
  t.after(stub.restore);

  const bodies = await createGiteaForge(OPTIONS).listReviewBodies(REF);

  assert.deepEqual(bodies, ["MultiReviewer", "diff 之外的 Finding"]);
});

test("resolve 与 unresolve 打在评论 id 上,方法是 POST", async (t) => {
  const stub = stubFetch(routes());
  t.after(stub.restore);
  const forge = createGiteaForge(OPTIONS);

  await forge.resolveComment(REF, "501");
  await forge.unresolveComment(REF, "501");

  // 路径里没有 PR 序号:这对端点注册在 `/pulls/comments/{id}` 下,{id} 是评论 id。
  assert.deepEqual(
    stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [
      "POST /api/v1/repos/acme/widget/pulls/comments/501/resolve",
      "POST /api/v1/repos/acme/widget/pulls/comments/501/unresolve",
    ],
  );
});

test("reaction 挂在 issues 端点上,加与删都按 content,不需要 reaction id", async (t) => {
  const stub = stubFetch(routes());
  t.after(stub.restore);
  const forge = createGiteaForge(OPTIONS);

  await forge.addReaction(REF, "eyes");
  await forge.removeReaction(REF, "+1");

  // PR 在 Gitea 内部就是 issue,序号同一个。删除按 content,不像 GitHub 要先取 id。
  assert.deepEqual(
    stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [
      "POST /api/v1/repos/acme/widget/issues/7/reactions",
      "DELETE /api/v1/repos/acme/widget/issues/7/reactions",
    ],
  );
  assert.deepEqual(
    stub.calls.map((c) => c.body),
    [{ content: "eyes" }, { content: "+1" }],
  );
});

test("clone 凭据把令牌放在 password 上", async (t) => {
  const stub = stubFetch(routes());
  t.after(stub.restore);

  const credentials = await createGiteaForge(OPTIONS).cloneCredentials(REF);

  assert.equal(credentials.password, TOKEN);
  assert.notEqual(credentials.username, "");
});

test("版本合格时通过:社区版与企业版两套版本号都认", async (t) => {
  for (const version of ["1.26.0", "1.26.4", "1.27.0", "26.4.4", "27.0.1"]) {
    const stub = stubFetch(routes({ "GET /api/v1/version": { body: { version } } }));
    t.after(stub.restore);
    await assertSupportedVersion(OPTIONS);
  }
});

test("版本号读不出来时放行:企业版的版本号形状没有公开依据,宁可漏检", async (t) => {
  const stub = stubFetch(routes({ "GET /api/v1/version": { body: { version: "dev" } } }));
  t.after(stub.restore);

  await assertSupportedVersion(OPTIONS);
});

test("版本低于下限时报错,说清读到的版本、要求的下限与原因", async (t) => {
  const stub = stubFetch(
    routes({ "GET /api/v1/version": { body: { version: "1.25.5" } } }),
  );
  t.after(stub.restore);

  const error = await assertSupportedVersion(OPTIONS).then(
    () => undefined,
    (e: unknown) => e as Error,
  );

  assert.ok(error !== undefined, "1.25.5 应当被挡下");
  assert.match(error.message, /1\.25\.5/);
  assert.match(error.message, /1\.26\.0/);
  assert.match(error.message, /26\.0\.0/);
  // 说清为什么要这个下限,否则运维只知道被挡了不知道该升到哪。
  assert.match(error.message, /resolve/);
});

test("企业版低于 26.0.0 时同样被挡下", async (t) => {
  const stub = stubFetch(
    routes({ "GET /api/v1/version": { body: { version: "25.6.0" } } }),
  );
  t.after(stub.restore);

  await assert.rejects(assertSupportedVersion(OPTIONS), /25\.6\.0/);
});

test("API 报错时抛出的错误不带上凭据", async (t) => {
  const stub = stubFetch(
    routes({
      "GET /api/v1/repos/acme/widget/pulls/7": {
        status: 403,
        body: { message: "token does not have at least one of required scope(s)" },
      },
    }),
  );
  t.after(stub.restore);

  const error = await createGiteaForge(OPTIONS)
    .getPullRequest(REF)
    .then(
      () => undefined,
      (e: unknown) => e as Error,
    );

  assert.ok(error !== undefined);
  assert.match(error.message, /403/);
  assert.ok(!error.message.includes(TOKEN), "错误信息里带上了凭据");
  assert.ok(!error.stack?.includes(TOKEN), "调用栈里带上了凭据");
});
