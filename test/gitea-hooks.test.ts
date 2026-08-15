/**
 * Gitea 专属的 hook 管理模块。用打桩的 `fetch` 驱动,不需要真实实例。
 *
 * 端点与字段名的源码依据写在 `src/forge/gitea-hooks.ts` 的注释里,契约细节见
 * `docs/research/gitea-webhook-api.md`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGiteaHookManager, SUBSCRIBED_EVENTS } from "../src/forge/gitea-hooks.ts";
import { stubFetch, type Route } from "./support/stub-fetch.ts";

const BASE_URL = "https://gitea.example.test";
/** 凭据绝不应出现在错误信息里,这个值就是用来在断言里反查它有没有漏出去。 */
const TOKEN = "gitea-pat-must-not-leak";
const OPTIONS = { baseUrl: BASE_URL, token: TOKEN };
const REPO = { owner: "acme", repo: "widget" };

const HOOK_URL = "https://reviewer.example.test/webhook?k=3";
const KEY = "widget-key-gen3";

const LIST_PATH = "GET /api/v1/repos/acme/widget/hooks?page=1&limit=100";
/** 分页以空页收尾(实例会把 limit 钳到 MAX_RESPONSE_ITEMS,「不满一页」不代表到底)。 */
const LIST_PATH_END = "GET /api/v1/repos/acme/widget/hooks?page=2&limit=100";

/** Gitea 读回的 hook。窄订阅的回显是展开后的 `pull_request` 与 `pull_request_sync`。 */
function existingHook(
  overrides: Partial<{
    events: string[];
    active: boolean;
    url: string;
    contentType: string;
  }> = {},
) {
  return {
    id: 5,
    active: overrides.active ?? true,
    events: overrides.events ?? ["pull_request", "pull_request_sync"],
    config: { url: overrides.url ?? HOOK_URL, content_type: overrides.contentType ?? "json" },
  };
}

test("首次注册:建 hook 的载荷逐项正确", async () => {
  const stub = stubFetch({
    [LIST_PATH]: { body: [] },
    "POST /api/v1/repos/acme/widget/hooks": { status: 201, body: existingHook() },
  });
  try {
    await createGiteaHookManager(OPTIONS).ensureHook(REPO, { url: HOOK_URL, key: KEY });
  } finally {
    stub.restore();
  }

  const post = stub.calls.find((call) => call.method === "POST");
  assert.notEqual(post, undefined);
  // type/config/events/active 逐项核对:active 必须显式置真(默认 false),
  // content_type 必须是 "json",events 用窄订阅哨兵集。
  assert.deepEqual(post!.body, {
    type: "gitea",
    config: { url: HOOK_URL, content_type: "json", secret: KEY },
    events: SUBSCRIBED_EVENTS,
    active: true,
  });
  // 每一次调用都带凭据,列表也不例外。
  for (const call of stub.calls) assert.equal(call.auth, `token ${TOKEN}`);
});

test("重复注册:同 config.url 已存在且订阅正确时不再建", async () => {
  // 回显顺序不稳定(Go map 迭代无序),这里故意打乱顺序,比对必须按集合。
  const stub = stubFetch({
    [LIST_PATH]: { body: [existingHook({ events: ["pull_request_sync", "pull_request"] })] },
    [LIST_PATH_END]: { body: [] },
  });
  try {
    await createGiteaHookManager(OPTIONS).ensureHook(REPO, { url: HOOK_URL, key: KEY });
  } finally {
    stub.restore();
  }

  // 只列了 hook:没有 POST 也没有 PATCH,不产生第二条 hook。
  assert.deepEqual(
    stub.calls.map((call) => call.method),
    ["GET", "GET"],
  );
});

test("同 URL 但订阅、激活或 content_type 被人改过:PATCH 收敛,不建第二条", async () => {
  async function ensure(hook: unknown): Promise<void> {
    const stub = stubFetch({
      [LIST_PATH]: { body: [hook] },
      [LIST_PATH_END]: { body: [] },
      "PATCH /api/v1/repos/acme/widget/hooks/5": { body: existingHook() },
    });
    try {
      await createGiteaHookManager(OPTIONS).ensureHook(REPO, { url: HOOK_URL, key: KEY });
    } finally {
      stub.restore();
    }
    const patch = stub.calls.find((call) => call.method === "PATCH");
    assert.notEqual(patch, undefined);
    // PATCH 的 events 是全量覆盖(省略即被重置为 push),active 是指针字段要显式置真,
    // config 按 key 部分更新、只回 content_type。
    assert.deepEqual(patch!.body, {
      config: { content_type: "json" },
      events: SUBSCRIBED_EVENTS,
      active: true,
    });
    assert.equal(
      stub.calls.some((call) => call.method === "POST"),
      false,
    );
  }

  await ensure(existingHook({ events: ["push"], active: false }));
  // content_type 被改成 form 时投递不再是 JSON,验签端解析不了——也要收敛。
  await ensure(existingHook({ contentType: "form" }));
});

test("删 hook:404 视为已达成,其他失败照抛", async () => {
  async function remove(route: Route): Promise<void> {
    const stub = stubFetch({ "DELETE /api/v1/repos/acme/widget/hooks/5": route });
    try {
      await createGiteaHookManager(OPTIONS).deleteHook(REPO, 5);
    } finally {
      stub.restore();
    }
  }

  await remove({ status: 204 });
  // 删除不幂等,重复删回 404——而 404 的语义就是目标已达成。
  await remove({ status: 404, body: { message: "not found" } });
  await assert.rejects(remove({ status: 500, body: { message: "boom" } }), /500/);
});

test("权限查询:admin 放行,非 admin 与不可见各带说明", async () => {
  async function check(route: Route) {
    const stub = stubFetch({ "GET /api/v1/repos/acme/widget": route });
    try {
      return await createGiteaHookManager(OPTIONS).checkAdmin(REPO);
    } finally {
      stub.restore();
    }
  }

  // admin 放行时一并带回数值 repo id——它是注册表的主键,同一次请求读回。
  assert.deepEqual(
    await check({ body: { id: 4242, permissions: { admin: true, push: true, pull: true } } }),
    { admin: true, repoId: 4242 },
  );

  const notAdmin = await check({
    body: { permissions: { admin: false, push: true, pull: true } },
  });
  assert.equal(notAdmin.admin, false);
  // 拒绝要明说缺什么,不能只说「不行」。
  assert.match((notAdmin as { reason: string }).reason, /admin/);

  const invisible = await check({ status: 404, body: { message: "not found" } });
  assert.equal(invisible.admin, false);
  assert.match((invisible as { reason: string }).reason, /协作者/);
});

test("列 hook:仓库整个 404 时返回空数组——仓库都没了,hook 自然一个没有", async () => {
  const stub = stubFetch({
    [LIST_PATH]: { status: 404, body: { message: "not found" } },
  });
  try {
    assert.deepEqual(await createGiteaHookManager(OPTIONS).listHooks(REPO), []);
  } finally {
    stub.restore();
  }
});

test("列 hook 的读回形状:id、config.url、content_type、events 与 active", async () => {
  const stub = stubFetch({
    [LIST_PATH]: { body: [existingHook()] },
    [LIST_PATH_END]: { body: [] },
  });
  try {
    const hooks = await createGiteaHookManager(OPTIONS).listHooks(REPO);
    assert.deepEqual(hooks, [
      {
        id: 5,
        url: HOOK_URL,
        contentType: "json",
        events: ["pull_request", "pull_request_sync"],
        active: true,
      },
    ]);
  } finally {
    stub.restore();
  }
});
