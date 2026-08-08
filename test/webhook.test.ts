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
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const SECRET = "webhook-secret";

const BASE_FILE = "export const answer = 1;\n";
const HEAD_FILE = "export const answer = 2;\n";

const PR: PullRequestRef = { owner: "acme", repo: "widgets", number: 7 };

/**
 * 两个平台的 pull_request payload 字段路径逐字相同(依据见 `src/webhook/server.ts`
 * 的注释),差别只在 action 的拼写,因此共用一个构造器。
 */
function prPayload(action: string, headSha: string, draft = false): unknown {
  return {
    action,
    number: PR.number,
    pull_request: { draft, head: { sha: headSha } },
    repository: { name: PR.repo, owner: { login: PR.owner } },
  };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
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
};

async function startHarness(options: HarnessOptions = {}) {
  const repo = makeRepo({
    base: { "src/answer.ts": BASE_FILE },
    head: { "src/answer.ts": HEAD_FILE },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

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
    secret: SECRET,
    forges: options.omitGiteaForge ? { github: forge } : { github: forge, gitea: forge },
    reviewers: [options.reviewer ?? scriptedReviewer("stub-model", [])],
    cacheDir: cache.dir,
    dbPath: db.path,
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
  const url = `http://127.0.0.1:${port}/webhook`;
  // fetch 默认长连接,不主动断开则服务器关不掉,测试进程会挂在那里不退出。
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });

  function post(body: string, headers: Record<string, string>): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
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

test("body 解析不了时返回 400", async () => {
  const h = await startHarness();
  const body = "{ not json";

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
  await h.post(JSON.stringify({}), {
    "x-gitea-event": "push",
    "x-hub-signature-256": sign(JSON.stringify({})),
  });

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
  const body = JSON.stringify({});

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
