import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import type { Forge, PullRequestRef } from "../src/forge/forge.ts";
import type { Reviewer, ReviewRange } from "../src/review/finding.ts";
import {
  createWebhookServer,
  normalizeEvent,
  type NormalizedEvent,
  type Platform,
} from "../src/webhook/server.ts";
import { openStore } from "../src/review/store.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const BASE_FILE = "export const answer = 1;\n";
const HEAD_FILE = "export const answer = 2;\n";

const PR: PullRequestRef = { owner: "acme", repo: "widgets", number: 7 };

/** 注册表种入的仓库:Forge 的数值 repo id 是主键,key 带代次(ADR 0007)。 */
const REPO_ID = 101;
const KEY = "widgets-key-gen1";
const GENERATION = 1;

/** 第二个已注册仓库,给「按仓库分桶」类测试用。 */
const REPO_B_ID = 102;
const KEY_B = "gadgets-key-gen1";

/**
 * 两个平台的 pull_request payload 字段路径逐字相同(依据见 `src/webhook/server.ts`
 * 的注释),差别只在 action 的拼写,因此共用一个构造器。
 */
function prPayload(action: string, headSha: string, draft = false): unknown {
  return {
    action,
    number: PR.number,
    pull_request: { draft, head: { sha: headSha } },
    repository: { id: REPO_ID, name: PR.repo, owner: { login: PR.owner } },
  };
}

function sign(body: string, key = KEY): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

/** 规范化必须成功,否则这条断言本身没有意义。 */
function normalized(platform: Platform, payload: unknown): NormalizedEvent {
  const event = normalizeEvent(platform, payload);
  if (typeof event === "string") throw new Error(`规范化失败: ${event}`);
  return event;
}

/** 挂住不返回的 Reviewer 桩。`entered` 兑现即审查已在跑,`release()` 让它跑完。 */
function gatedReviewer(model: string): Reviewer & {
  entered: Promise<void>;
  release: () => void;
} {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  return {
    model,
    entered: entered.promise,
    release: gate.resolve,
    review: async (_range: ReviewRange) => {
      entered.resolve();
      await gate.promise;
      return { model, findings: [], anomalies: [], rejectedToolCalls: 0, anchorRejections: 0 };
    },
  };
}

type Settle = { event: NormalizedEvent; error?: unknown };

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type HarnessOptions = {
  reviewer?: Reviewer;
  /** 不给 Gitea 那一格配 Forge,模拟 issue #3 尚未落地的状态。 */
  omitGiteaForge?: boolean;
  /** 压低「只记首次」集合的上限,触达封顶分支。 */
  loggedOnceMax?: number;
};

async function startHarness(options: HarnessOptions = {}) {
  const repo = makeRepo({
    base: { "src/answer.ts": BASE_FILE },
    head: { "src/answer.ts": HEAD_FILE },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  // 种入注册表:准入凭仓库的 key,不再有全局 secret。
  const seed = openStore(db.path);
  seed.registerRepo({
    repoId: REPO_ID,
    owner: PR.owner,
    repo: PR.repo,
    generation: GENERATION,
    key: KEY,
  });
  seed.registerRepo({
    repoId: REPO_B_ID,
    owner: "acme",
    repo: "gadgets",
    generation: GENERATION,
    key: KEY_B,
  });
  seed.close();

  const base = memoryForge({
    pullRequest: {
      number: PR.number,
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/answer.ts", status: "modified" }],
  });

  const dispatched: PullRequestRef[] = [];
  const control = { failNextRun: false };
  // `runReview` 第一件事就是调 getPullRequest,且发生在它第一次挂起之前。HTTP 响应
  // 回到客户端时这个数组已经定了,断言"没触发"不必等也不必赌时序。
  const forge: Forge = {
    ...base.forge,
    getPullRequest: async (ref: PullRequestRef) => {
      dispatched.push(ref);
      if (control.failNextRun) {
        control.failNextRun = false;
        throw new Error("forge 调用失败");
      }
      return base.forge.getPullRequest(ref);
    },
  };

  const settled: Settle[] = [];
  // 收进数组而不是打到 stdout:测试里既要能断言,又不该刷屏。
  const deliveries: string[] = [];
  let waiting: { count: number; resolve: () => void }[] = [];

  const server = createWebhookServer({
    forges: options.omitGiteaForge ? { github: forge } : { github: forge, gitea: forge },
    reviewers: [options.reviewer ?? scriptedReviewer("stub-model", [])],
    // 本文件的仓库都不带模型覆盖,这个构建器不该被调用。
    buildReviewers: (specs) => specs.map((spec) => scriptedReviewer(spec.model, [])),
    cacheDir: cache.dir,
    dbPath: db.path,
    adminToken: "webhook-test-admin-token",
    panelPrefix: "webhook-test-prefix",
    baseUrl: "https://reviewer.example.test",
    panelDist: `${cache.dir}/no-dist`,
    ...(options.loggedOnceMax === undefined ? {} : { loggedOnceMax: options.loggedOnceMax }),
    onDelivery: (message) => deliveries.push(message),
    onRunSettled: (event, error) => {
      settled.push({ event, ...(error === undefined ? {} : { error }) });
      waiting = waiting.filter((w) => {
        if (settled.length < w.count) return true;
        w.resolve();
        return false;
      });
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  // fetch 默认长连接,不主动断开则服务器关不掉,测试进程会挂在那里不退出。
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });

  function post(
    body: string,
    headers: Record<string, string>,
    path = `/webhook?k=${GENERATION}`,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      // 重定向要在断言里显形,不能被 fetch 静默跟掉。
      redirect: "manual",
    });
  }

  function deliver(
    platform: Platform,
    action: string,
    delivery: { headSha: string; draft?: boolean },
  ): Promise<Response> {
    const body = JSON.stringify(prPayload(action, delivery.headSha, delivery.draft));
    // Gitea 为兼容 GitHub 的接收端连 X-GitHub-Event 一起发,真实投递就是两个头都在。
    const eventHeaders =
      platform === "gitea"
        ? { "x-gitea-event": "pull_request", "x-github-event": "pull_request" }
        : { "x-github-event": "pull_request" };
    return post(body, { ...eventHeaders, "x-hub-signature-256": sign(body) });
  }

  return {
    repo,
    forge: base,
    dispatched,
    settled,
    deliveries,
    control,
    baseUrl,
    post,
    deliver,
    /** 等到后台跑完 `count` 次 Review Run。靠回调等待,不用固定 sleep。 */
    settledAtLeast(count: number): Promise<void> {
      if (settled.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting.push({ count, resolve });
      });
    },
  };
}

test("签名正确的投递被受理并触发 Review Run", async () => {
  const h = await startHarness();

  const response = await h.deliver("github", "opened", { headSha: "sha-1" });

  assert.equal(response.status, 200);
  assert.deepEqual(h.dispatched, [PR]);
});

test("签名错误或缺失的投递返回 401 且不触发 Review Run", async () => {
  const h = await startHarness();
  const body = JSON.stringify(prPayload("opened", "sha-1"));
  const eventHeader = { "x-github-event": "pull_request" };

  const wrong = await h.post(body, {
    ...eventHeader,
    "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
  });
  assert.equal(wrong.status, 401);

  // 长度不等的签名走 timingSafeEqual 之前的短路,不能让它抛成 500。
  const truncated = await h.post(body, {
    ...eventHeader,
    "x-hub-signature-256": "sha256=dead",
  });
  assert.equal(truncated.status, 401);

  const missing = await h.post(body, eventHeader);
  assert.equal(missing.status, 401);

  assert.deepEqual(h.dispatched, []);
});

test("GitHub 的 opened 与 synchronize 各触发一次 Review Run", async () => {
  const h = await startHarness();

  assert.equal((await h.deliver("github", "opened", { headSha: "sha-1" })).status, 200);
  assert.equal(
    (await h.deliver("github", "synchronize", { headSha: "sha-2" })).status,
    200,
  );

  assert.deepEqual(h.dispatched, [PR, PR]);
});

test("Gitea 的两个 action 规范化后与 GitHub 得到同一形状", async () => {
  for (const [giteaAction, githubAction] of [
    ["opened", "opened"],
    ["synchronized", "synchronize"],
  ] as const) {
    const gitea = normalized("gitea", prPayload(giteaAction, "sha-1"));
    const github = normalized("github", prPayload(githubAction, "sha-1"));

    const { platform: giteaPlatform, ...giteaRest } = gitea;
    const { platform: githubPlatform, ...githubRest } = github;
    assert.equal(giteaPlatform, "gitea");
    assert.equal(githubPlatform, "github");
    // 来源平台之外逐字段相同,`runReview` 之下再也分不出投递来自哪个平台。
    assert.deepEqual(giteaRest, githubRest);
  }
});

test("Gitea 的投递照样触发 Review Run,不被 X-GitHub-Event 带偏", async () => {
  const h = await startHarness();

  assert.equal((await h.deliver("gitea", "opened", { headSha: "sha-1" })).status, 200);
  assert.equal(
    (await h.deliver("gitea", "synchronized", { headSha: "sha-2" })).status,
    200,
  );

  assert.deepEqual(h.dispatched, [PR, PR]);
});

test("草稿 PR 的投递返回 200 但不触发 Review Run", async () => {
  const h = await startHarness();

  const response = await h.deliver("github", "opened", {
    headSha: "sha-1",
    draft: true,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(h.dispatched, []);
});

test("不关心的事件类型与 action 返回 200 且不触发 Review Run", async () => {
  const h = await startHarness();
  const body = JSON.stringify(prPayload("opened", "sha-1"));

  const otherEvent = await h.post(body, {
    "x-github-event": "push",
    "x-hub-signature-256": sign(body),
  });
  assert.equal(otherEvent.status, 200);

  const otherAction = await h.deliver("github", "closed", { headSha: "sha-1" });
  assert.equal(otherAction.status, 200);

  assert.deepEqual(h.dispatched, []);
});

test("body 解析不出仓库 id 时返回 401——无从查 key,也无从归类", async () => {
  const h = await startHarness();

  // 非法 JSON 与缺 repository.id 的 JSON 是同一档:准入查 key 靠 id,拿不到就验不了签。
  for (const body of ["{ not json", JSON.stringify(prPayloadWithoutId())]) {
    const response = await h.post(body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(body),
    });
    assert.equal(response.status, 401);
  }

  assert.deepEqual(h.dispatched, []);
});

/** 形状完整但没有 repository.id 的 payload。 */
function prPayloadWithoutId(): unknown {
  return {
    action: "opened",
    number: PR.number,
    pull_request: { draft: false, head: { sha: "sha-1" } },
    repository: { name: PR.repo, owner: { login: PR.owner } },
  };
}

test("准入过了但 payload 缺必需字段时返回 400", async () => {
  const h = await startHarness();
  // 有 id、签名对,但没有 pull_request 字段——平台改字段名时要在投递记录里显形。
  const body = JSON.stringify({
    action: "opened",
    repository: { id: REPO_ID, name: PR.repo, owner: { login: PR.owner } },
  });

  const response = await h.post(body, {
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(body),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(h.dispatched, []);
});

test("Webhook 响应在 Review Run 完成之前就返回", async () => {
  const reviewer = gatedReviewer("gated-model");
  const h = await startHarness({ reviewer });

  const response = await h.deliver("github", "opened", { headSha: "sha-1" });
  assert.equal(response.status, 200);

  // 审查已经在跑且被挂住,此刻响应早已回到客户端。
  await reviewer.entered;
  assert.deepEqual(h.settled, []);

  reviewer.release();
  await h.settledAtLeast(1);
  assert.equal(h.settled.length, 1);
});

test("同一仓库同一 head commit 重复投递只产生一次 Review Run", async () => {
  const h = await startHarness();

  assert.equal((await h.deliver("github", "opened", { headSha: "sha-1" })).status, 200);
  assert.equal(
    (await h.deliver("github", "synchronize", { headSha: "sha-1" })).status,
    200,
  );
  assert.deepEqual(h.dispatched, [PR]);

  // 换 head commit 即新的幂等键,照常再跑一次。
  h.forge.pullRequest.headSha = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  assert.equal(
    (await h.deliver("github", "synchronize", { headSha: "sha-2" })).status,
    200,
  );
  assert.deepEqual(h.dispatched, [PR, PR]);
});

test("并发投递同一个 head commit 仍然只产生一次 Review Run", async () => {
  const h = await startHarness();

  const responses = await Promise.all([
    h.deliver("github", "synchronize", { headSha: "sha-1" }),
    h.deliver("github", "synchronize", { headSha: "sha-1" }),
  ]);

  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(h.dispatched, [PR]);
});

test("后台 Review Run 抛异常时进程不崩,下一次投递照常受理", async () => {
  const h = await startHarness();
  h.control.failNextRun = true;

  assert.equal((await h.deliver("github", "opened", { headSha: "sha-1" })).status, 200);
  await h.settledAtLeast(1);
  assert.notEqual(h.settled[0]!.error, undefined);

  assert.equal(
    (await h.deliver("github", "synchronize", { headSha: "sha-2" })).status,
    200,
  );
  await h.settledAtLeast(2);
  assert.equal(h.settled[1]!.error, undefined);
  assert.deepEqual(h.dispatched, [PR, PR]);
});

test("来源平台还没有 Forge 实现时记录下来并返回 200", async () => {
  const h = await startHarness({ omitGiteaForge: true });

  const response = await h.deliver("gitea", "opened", { headSha: "sha-1" });

  assert.equal(response.status, 200);
  assert.deepEqual(h.dispatched, []);
  assert.equal(h.settled.length, 1);
  assert.notEqual(h.settled[0]!.error, undefined);
});

test("通过签名的投递都留痕,说明这次做了什么", async () => {
  const h = await startHarness();

  // 触发审查的那一条。
  await h.deliver("gitea", "opened", { headSha: h.repo.headSha });
  await h.settledAtLeast(1);
  assert.match(h.deliveries[0]!, /gitea .+#7 opened @/);
  assert.match(h.deliveries[0]!, /开始审查/);

  // 重复投递、草稿、不触发的 action、非 pull request 事件,四种「没动静」各自留痕。
  await h.deliver("gitea", "opened", { headSha: h.repo.headSha });
  await h.deliver("gitea", "opened", { headSha: h.repo.headSha, draft: true });
  await h.deliver("gitea", "labeled", { headSha: h.repo.headSha });
  const push = JSON.stringify({
    repository: { id: REPO_ID, name: PR.repo, owner: { login: PR.owner } },
  });
  await h.post(push, { "x-gitea-event": "push", "x-hub-signature-256": sign(push) });

  const joined = h.deliveries.join("\n");
  assert.match(joined, /已经审过,跳过/);
  assert.match(joined, /草稿,不审/);
  assert.match(joined, /labeled 动作不触发审查/);
  assert.match(joined, /收到 push 事件/);
});

/** 日志里含 `needle` 的行数。去重生效与否只看这个计数。 */
function countLines(deliveries: readonly string[], needle: string): number {
  return deliveries.filter((line) => line.includes(needle)).length;
}

test("无关的事件类型只在首次出现时记一行", async () => {
  const h = await startHarness();
  const body = JSON.stringify({
    repository: { id: REPO_ID, name: PR.repo, owner: { login: PR.owner } },
  });

  // PR 下每条评论都投一次 pull_request_comment,逐条记会把真正要看的行淹掉。
  for (let i = 0; i < 3; i += 1) {
    const response = await h.post(body, {
      "x-gitea-event": "pull_request_comment",
      "x-hub-signature-256": sign(body),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(countLines(h.deliveries, "pull_request_comment"), 1);

  // 按事件类型分别记首次,不是记过一条之后就再也不记。
  await h.post(body, { "x-gitea-event": "push", "x-hub-signature-256": sign(body) });
  assert.equal(countLines(h.deliveries, "收到 push 事件"), 1);
});

test("不触发审查的 action 同样只在首次出现时记一行", async () => {
  const h = await startHarness();

  await h.deliver("github", "labeled", { headSha: "sha-1" });
  await h.deliver("github", "labeled", { headSha: "sha-1" });
  await h.deliver("github", "assigned", { headSha: "sha-1" });

  assert.equal(countLines(h.deliveries, "labeled 动作不触发审查"), 1);
  assert.equal(countLines(h.deliveries, "assigned 动作不触发审查"), 1);
  assert.deepEqual(h.dispatched, []);
});

/** 带自定义 repository 的 payload,验证「只记首次」按仓库分桶而非全实例共用一格。 */
function payloadForRepo(id: number, owner: string, repo: string, action: string): string {
  return JSON.stringify({
    action,
    number: 1,
    pull_request: { draft: false, head: { sha: "sha-x" } },
    repository: { id, name: repo, owner: { login: owner } },
  });
}

test("不触发审查的 action:不同仓库各记首次,不互相吞", async () => {
  const h = await startHarness();
  const a = payloadForRepo(REPO_ID, "acme", "widgets", "labeled");
  const b = payloadForRepo(REPO_B_ID, "acme", "gadgets", "labeled");

  await h.post(a, { "x-github-event": "pull_request", "x-hub-signature-256": sign(a) });
  await h.post(b, {
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(b, KEY_B),
  });

  // 一个仓库的 labeled 记过之后,另一个仓库的 labeled 仍要记:一份实例服务多个仓库,
  // 全局去重会让除第一个之外的仓库都看不出 webhook 通没通。
  assert.equal(countLines(h.deliveries, "labeled 动作不触发审查"), 2);
});

test("无关事件类型:不同仓库各记首次,不互相吞", async () => {
  const h = await startHarness();
  const a = JSON.stringify({
    repository: { id: REPO_ID, name: "widgets", owner: { login: "acme" } },
  });
  const b = JSON.stringify({
    repository: { id: REPO_B_ID, name: "gadgets", owner: { login: "acme" } },
  });

  await h.post(a, { "x-gitea-event": "push", "x-hub-signature-256": sign(a) });
  await h.post(b, { "x-gitea-event": "push", "x-hub-signature-256": sign(b, KEY_B) });

  assert.equal(countLines(h.deliveries, "收到 push 事件"), 2);
});

test("关心的判定结果逐条记,不去重", async () => {
  const h = await startHarness();

  await h.deliver("github", "opened", { headSha: h.repo.headSha, draft: true });
  await h.deliver("github", "opened", { headSha: h.repo.headSha, draft: true });
  await h.deliver("github", "opened", { headSha: h.repo.headSha });
  await h.settledAtLeast(1);
  await h.deliver("github", "synchronize", { headSha: h.repo.headSha });
  await h.deliver("github", "synchronize", { headSha: h.repo.headSha });

  // 这几档是本服务对 pull request 的判定结果,少记一条就看不出投递还在进来。
  assert.equal(countLines(h.deliveries, "草稿,不审"), 2);
  assert.equal(countLines(h.deliveries, "开始审查"), 1);
  assert.equal(countLines(h.deliveries, "已经审过,跳过"), 2);
});

test("路由:签名正确但路径不对的投递一律 404,不触发也不留痕", async () => {
  const h = await startHarness();
  const body = JSON.stringify(prPayload("opened", "sha-1"));
  const headers = {
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(body),
  };

  // 签名再对,路径不对就到不了投递处理——路由在签名校验之前分发。
  for (const path of ["/", "/admin", "/webhook/", "/webhook/extra"]) {
    const response = await h.post(body, headers, path);
    assert.equal(response.status, 404, path);
  }

  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.deliveries, []);
});

test("路由:非 POST 方法一律 404,不重定向", async () => {
  const h = await startHarness();

  // `GET /webhook` 与 `/` 也是 404,不重定向。
  for (const path of ["/webhook", "/", "/assets/app.js"]) {
    const response = await fetch(`${h.baseUrl}${path}`, { redirect: "manual" });
    assert.equal(response.status, 404, path);
  }
});

test("路由:带查询参数的 POST /webhook 照常受理", async () => {
  const h = await startHarness();
  const body = JSON.stringify(prPayload("opened", "sha-1"));

  // hook URL 将携带 `?k=<代次>`(ADR 0007),查询参数不参与路径匹配。
  const response = await h.post(
    body,
    { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) },
    "/webhook?k=1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(h.dispatched, [PR]);
});

test("未注册仓库的投递回 401,按仓库只记首次", async () => {
  const h = await startHarness();
  // GitHub 从准入层退场:没有注册途径,它的投递走的就是「未注册」这一档。
  const alien = payloadForRepo(999, "zhangxu", "review", "opened");
  const alienHeaders = {
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(alien, "some-unknown-key"),
  };

  assert.equal((await h.post(alien, alienHeaders)).status, 401);
  assert.equal((await h.post(alien, alienHeaders)).status, 401);

  const other = payloadForRepo(998, "zhangxu", "docs", "opened");
  const otherHeaders = {
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(other, "some-unknown-key"),
  };
  assert.equal((await h.post(other, otherHeaders)).status, 401);

  assert.deepEqual(h.dispatched, []);
  // 同一仓库重复投递只记首次,不同仓库各记一条。
  assert.equal(countLines(h.deliveries, "未注册"), 2);
});

test("准入拒绝的记录:仓库名滤掉控制字符,集合封顶后不再记新类", async () => {
  const h = await startHarness({ loggedOnceMax: 1 });

  // 仓库名带换行——这行日志在验签前输出,不滤等于让外人伪造日志行。
  const forged = JSON.stringify({
    repository: { id: 999, name: "x\ninjected: line", owner: { login: "evil" } },
  });
  assert.equal(
    (
      await h.post(forged, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(forged, "unknown"),
      })
    ).status,
    401,
  );
  assert.equal(h.deliveries.length, 1);
  assert.doesNotMatch(h.deliveries[0]!, /\n/);

  // 上限(1)已满:新仓库的拒绝照样 401,只是不再记;已记过的仍去重。
  const another = payloadForRepo(998, "evil", "other", "opened");
  const headers = {
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(another, "unknown"),
  };
  assert.equal((await h.post(another, headers)).status, 401);
  assert.equal((await h.post(another, headers)).status, 401);
  assert.equal(h.deliveries.length, 1);
});

test("代次缺失或对不上时回 401,与未注册分成两类记录", async () => {
  const h = await startHarness();
  const body = JSON.stringify(prPayload("opened", "sha-1"));
  const headers = { "x-gitea-event": "pull_request", "x-hub-signature-256": sign(body) };

  // 代次是索引不是凭证,取错即 401(ADR 0007):缺失、不存在的代次、非十进制整数各一档。
  // "0x1" 与 "1e0" 能被 Number() 解析成 1,但代次只认十进制数字。
  for (const path of ["/webhook", "/webhook?k=99", "/webhook?k=abc", "/webhook?k=0x1", "/webhook?k=1e0"]) {
    assert.equal((await h.post(body, headers, path)).status, 401, path);
  }

  assert.deepEqual(h.dispatched, []);
  assert.equal(countLines(h.deliveries, "代次"), 1);
  assert.equal(countLines(h.deliveries, "未注册"), 0);
});

test("仓库改名或转移 owner 后,凭 payload 里的 id 照常匹配", async () => {
  const h = await startHarness();
  // id 不变、owner 与名字全换:注册表主键是数值 repo id,改名不是运维事件。
  const body = JSON.stringify({
    action: "opened",
    number: PR.number,
    pull_request: { draft: false, head: { sha: "sha-1" } },
    repository: { id: REPO_ID, name: "renamed", owner: { login: "moved" } },
  });

  const response = await h.post(body, {
    "x-gitea-event": "pull_request",
    "x-hub-signature-256": sign(body),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(h.dispatched, [{ owner: "moved", repo: "renamed", number: PR.number }]);
});

test("签名不过的投递不进日志——否则日志由外人写", async () => {
  const h = await startHarness();
  const body = JSON.stringify(prPayload("opened", h.repo.headSha));

  const response = await h.post(body, {
    "x-gitea-event": "pull_request",
    "x-hub-signature-256": "sha256=deadbeef",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(h.deliveries, []);
});
