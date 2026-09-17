/**
 * 发消息、会话记录与记录流的面板接口(issue #333)。
 *
 * 缝与 #332 那一票相同:面板 API 走真实 HTTP,会话与记录落临时 SQLite。压的是票的验收里
 * 打在 HTTP 上的那几条:同一个客户端消息 id 重发回原受理结果不重入队、执行中的新消息按模式
 * 进队列、排队列表与整队清空、空闲时停止是空操作、会话根里一个仓库都没有时开不起来、记录
 * 与记录流的可见性、用量按记录累加并在统计页单列一行。真子进程那条链路在
 * `agent-session-subprocess.test.ts`。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createDrain } from "../src/drain.ts";
import type { ReviewerUsage } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import { agentSessionRepos, disposeAgentSessions } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { frameReader } from "./support/sse.ts";

const PASSWORD = "agent-session-message-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";

type AgentSession = {
  id: number;
  status: string;
  usage: ReviewerUsage;
  /** 这个会话每个仓库开在哪个 commit(issue #351)。 */
  baselines: { owner: string; repo: string; sha: string; branch: string; kind: string }[];
};

type Record = { sessionId: number; seq: number; type: string; at: string; entry: unknown; usage: ReviewerUsage };

function as(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function productWithRepos(
  h: PanelHarness,
  name: string,
  repoIds: readonly number[],
): Promise<number> {
  const created = await h.api("POST", "/products", { name });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  // 归属行直接落库:走归入端点在第二个仓库上会自己开一场梳理(issue #347),这几例压的是
  // 发消息。
  const store = openStore(h.db.path);
  try {
    for (const repoId of repoIds) {
      assert.equal(store.attachProductRepo(product.id, repoId, AT), "attached");
    }
  } finally {
    store.close();
  }
  return product.id;
}

async function createSession(
  h: PanelHarness,
  cookie: string,
  productId: number,
  baselines?: readonly { owner: string; repo: string; sha: string; branch?: string; kind?: string }[],
): Promise<number> {
  const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
    purpose: PURPOSE,
    ...(baselines === undefined ? {} : { baselines }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: { id: number } }).session.id;
}

async function session(h: PanelHarness, cookie: string, id: number): Promise<AgentSession> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${id}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { session: AgentSession }).session;
}

/** 读会话时跟着回的排队列表(issue #334)。 */
async function queueOf(
  h: PanelHarness,
  cookie: string,
  id: number,
): Promise<{ mode: string; text: string }[]> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${id}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { queue: { mode: string; text: string }[] }).queue;
}

/** 直接往记录表里落一条(ADR 0031)。这几条用例要的是用量累加,不是子进程。 */
function seedEntry(dbPath: string, sessionId: number, usage: Partial<ReviewerUsage>): void {
  const store = openStore(dbPath);
  try {
    const full: ReviewerUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      totalTokens:
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0),
    };
    store.appendAgentSessionEntry(sessionId, {
      type: "message",
      at: AT,
      entry: { type: "message", id: `seeded-${full.totalTokens}`, timestamp: AT },
      usage: full,
    });
  } finally {
    store.close();
  }
}

test("会话根只挂创建者有分配的仓库:产品里别的仓库不出现", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const other = seedRepo(h, 101, "acme", "alpha");
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id, other]);
  // 创建者只分配到两个仓库里的一个。
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const mine = await createSession(h, cookie, productId);
  // 系统管理员不受分配限制:产品的全部仓库都在他的会话根里。
  const admin = await createSession(h, h.cookie, productId);

  const store = openStore(h.db.path);
  try {
    const names = (sessionId: number): string[] =>
      agentSessionRepos(h.db.path, store.getAgentSession(sessionId)!).map(
        (repo) => `${repo.owner}/${repo.repo}`,
      );
    assert.deepEqual(names(mine), ["acme/widgets"]);
    assert.deepEqual(names(admin), ["acme/alpha", "acme/widgets"]);
  } finally {
    store.close();
  }
});

/**
 * 会话根下那棵工作树停在哪个 commit(issue #352)。备树在会话开起来之后的后台里跑,因此等到
 * 每个仓库都挂出一棵为止;读法与 `panel-product-survey.test.ts` 同一条:一棵工作树连着它的
 * HEAD,agent 的工具看到的就是这一份。
 */
async function sessionWorktreeHeads(
  h: PanelHarness,
  refs: readonly { owner: string; repo: string }[],
): Promise<string[]> {
  const head = (ref: { owner: string; repo: string }): string | undefined => {
    const clone = join(h.cacheDir, ref.owner, ref.repo);
    if (!existsSync(clone)) return undefined;
    const listed = execFileSync("git", ["-C", clone, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const lines = listed.split("\n");
    const index = lines.findIndex((line) => line.includes("multireviewer-session-root-"));
    if (index < 0) return undefined;
    const line = lines[index + 1] ?? "";
    assert.match(line, /^HEAD [0-9a-f]{40}$/, listed);
    return line.slice("HEAD ".length);
  };
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const heads = refs.map(head);
    if (heads.every((one) => one !== undefined)) return heads as string[];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return assert.fail("等了 30 秒,会话根下的工作树还没挂齐");
}

test("会话记下每个仓库开在哪条分支的哪个 commit,读端点回这一份", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id, alpha]);
  // harness 那个仓库的默认分支设成 `feature`(夹具那边的默认是 `main`,指向 `baseSha`,
  // `feature` 指向 `headSha`);另一个仓库没设,跟随平台那一条。
  const saved = await h.api("PUT", `/repos/${GITEA_REPO.id}/settings`, {
    reviewers: null,
    auxiliaryModel: null,
    minReportSeverity: null,
    defaultBranch: "feature",
    expectedVersion: 0,
  });
  assert.equal(saved.status, 200, await saved.text());
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id, alpha], [
    "agent:chat",
  ]);
  const sessionId = await createSession(h, cookie, productId);
  // 建会话那一刻就记下了(issue #352):每仓库一条,sha 是生效默认分支此刻的 head,分支名就是
  // 生效的那一条。
  const expected = [
    { owner: "acme", repo: "alpha", sha: h.repo.baseSha, branch: "main", kind: "branch" },
    { owner: "acme", repo: "widgets", sha: h.repo.headSha, branch: "feature", kind: "branch" },
  ];
  assert.deepEqual((await session(h, cookie, sessionId)).baselines, expected);

  try {
    const sent = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
      clientMessageId: "c1",
      text: "拆一下这个需求",
    });
    assert.equal(sent.status, 202, await sent.text());
    // 备树按会话记的 sha 检出,不再重解一次(issue #352):读回来还是同一份。
    assert.deepEqual(
      await sessionWorktreeHeads(h, [{ owner: "acme", repo: "alpha" }, GITEA_REPO]),
      [h.repo.baseSha, h.repo.headSha],
    );
    assert.deepEqual((await session(h, cookie, sessionId)).baselines, expected);
  } finally {
    await disposeAgentSessions();
  }
});

test("建会话时选的基点就是工作树停的地方,没选的那个仓库回落生效默认分支", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id, alpha]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id, alpha], [
    "agent:chat",
  ]);
  // 只动 widgets 那一行:选 `feature` 上的 head(夹具的 Gitea 默认分支是 `main`,指向
  // `baseSha`)。alpha 那一行没动,跟随生效的默认分支。
  const sessionId = await createSession(h, cookie, productId, [
    { owner: "acme", repo: "widgets", sha: h.repo.headSha, branch: "feature" },
  ]);
  const expected = [
    { owner: "acme", repo: "alpha", sha: h.repo.baseSha, branch: "main", kind: "branch" },
    { owner: "acme", repo: "widgets", sha: h.repo.headSha, branch: "feature", kind: "branch" },
  ];
  assert.deepEqual((await session(h, cookie, sessionId)).baselines, expected);

  try {
    const sent = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
      clientMessageId: "c1",
      text: "拆一下这个需求",
    });
    assert.equal(sent.status, 202, await sent.text());
    // agent 的工具看到的 HEAD 就是人选的那个 commit。
    assert.deepEqual(
      await sessionWorktreeHeads(h, [{ owner: "acme", repo: "alpha" }, GITEA_REPO]),
      [h.repo.baseSha, h.repo.headSha],
    );
    assert.deepEqual((await session(h, cookie, sessionId)).baselines, expected);
  } finally {
    await disposeAgentSessions();
  }
});

test("发消息要带客户端消息 id 与非空正文", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);

  for (const body of [
    {},
    { text: "拆一下这个需求" },
    { clientMessageId: "c1" },
    { clientMessageId: " ", text: "拆一下这个需求" },
    { clientMessageId: "c1", text: "   " },
    { clientMessageId: 42, text: "拆一下这个需求" },
  ]) {
    const response = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: "发消息要带 clientMessageId 与非空的 text",
    });
  }
});

test("会话根里一个仓库都没有时开不起来", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const other = seedRepo(h, 101, "acme", "alpha");
  // 产品下两个仓库,创建者只分配到另一个:交集为空。
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id, other], [
    "agent:chat",
  ]);
  const sessionId = await createSession(h, cookie, productId);
  assert.equal((await h.api("DELETE", `/products/${productId}/repos/${GITEA_REPO.id}`)).status, 204);

  const response = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
    clientMessageId: "c1",
    text: "拆一下这个需求",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "这个产品下没有你有仓库分配的仓库" });
});

test("服务正在排空:发消息回 503,不起新的子进程", async () => {
  // 排空时在跑的会话正被中止(issue #335),这一刻起一个新子进程只会被当场收掉。
  const drain = createDrain();
  const h = await startReadyPanelHarness({ registerRepo: true, drain });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);

  drain.begin();
  const response = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
    clientMessageId: "c1",
    text: "拆一下这个需求",
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "服务正在排空,等它起回来再发" });
  // 受理判在这道闸之后:排空结束、服务起回来之后,人重发的还是同一条消息。
  const store = openStore(h.db.path);
  assert.equal(store.acceptedAgentSessionMessage(sessionId, "c1"), undefined);
  store.close();
});

test("同一个客户端消息 id 重发回原受理结果,另一个 id 在执行中进队列", async () => {
  let nowMs = Date.parse(AT);
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => nowMs });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  const send = (body: unknown): Promise<Response> =>
    as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, body);

  const first = await send({ clientMessageId: "c1", text: "拆一下这个需求" });
  const firstText = await first.text();
  assert.equal(first.status, 202, firstText);
  assert.deepEqual(JSON.parse(firstText), {
    accepted: { clientMessageId: "c1", acceptedAt: AT },
  });
  // 受理即在跑:子进程起来之前就登记,下一条消息看得到它。
  assert.equal((await session(h, cookie, sessionId)).status, "running");

  // 时钟往前走一分钟:重发回的仍是第一次那一刻,没有第二次受理。
  nowMs += 60_000;
  const again = await send({ clientMessageId: "c1", text: "拆一下这个需求" });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), {
    accepted: { clientMessageId: "c1", acceptedAt: AT },
  });

  // 另一个 id:执行中照样受理,按模式进队列(issue #334)。缺省是排队。
  const queued = await send({ clientMessageId: "c2", text: "再补一句" });
  assert.equal(queued.status, 202);
  assert.deepEqual(await queueOf(h, cookie, sessionId), [
    { mode: "followUp", text: "再补一句" },
  ]);

  // 插话同样受理,排在排队那一条之前:Pi 在回合边界先取插话。
  assert.equal((await send({ clientMessageId: "c3", text: "先说结论", mode: "steer" })).status, 202);
  assert.deepEqual(await queueOf(h, cookie, sessionId), [
    { mode: "steer", text: "先说结论" },
    { mode: "followUp", text: "再补一句" },
  ]);

  // 整队清空之后一条都不剩。
  const cleared = await as(h, cookie, "DELETE", `/agent-sessions/${sessionId}/queue`);
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { queue: [] });

  // 登记表是进程内的一张表,下一个用例会拿同一个会话 id 开新会话。
  await disposeAgentSessions();
});

test("发消息的 mode 只认排队与插话", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);

  for (const mode of ["queue", "", 1, true]) {
    const response = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
      clientMessageId: "c1",
      text: "拆一下这个需求",
      mode,
    });
    assert.equal(response.status, 400, JSON.stringify(mode));
    assert.deepEqual(await response.json(), {
      error: "发消息的 mode 只能是 followUp(排队)或 steer(插话)",
    });
  }
});

test("空闲时停止是空操作,队列端点只有创建者动得了", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);

  // 空闲时没有「当前这一步」可中止:200 带标识,不报错。
  const stopped = await as(h, owner, "POST", `/agent-sessions/${sessionId}/stop`);
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { stopped: false, queue: [] });

  // 系统管理员读得到这个会话,停不了也清不了它的队列。
  for (const [method, path] of [
    ["POST", `/agent-sessions/${sessionId}/stop`],
    ["DELETE", `/agent-sessions/${sessionId}/queue`],
  ] as const) {
    const admin = await h.api(method, path);
    assert.equal(admin.status, 403, path);
    assert.deepEqual(await admin.json(), { error: "只有会话的创建者能做" });
    // 同事连这一条在不在都问不到。
    const stranger = await as(h, other, method, path);
    assert.equal(stranger.status, 404, path);
    assert.deepEqual(await stranger.json(), { error: "没有这个 Agent 会话" });
  }
});

test("记录与记录流只有创建者与系统管理员读得到", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);
  seedEntry(h.db.path, sessionId, { inputTokens: 10, outputTokens: 2 });

  // 创建者:记录读得到。
  const mine = await as(h, owner, "GET", `/agent-sessions/${sessionId}/records`);
  assert.equal(mine.status, 200);
  const { records } = (await mine.json()) as { records: Record[] };
  assert.equal(records.length, 1);
  assert.equal(records[0]!.seq, 1);
  assert.equal(records[0]!.type, "message");
  assert.deepEqual(records[0]!.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 12,
  });
  // 系统管理员读得到别人的会话与它的记录。
  assert.equal((await h.api("GET", `/agent-sessions/${sessionId}/records`)).status, 200);

  // 同事:两个端点都与会话不存在同形。
  for (const path of [`/records`, `/stream`]) {
    const response = await as(h, other, "GET", `/agent-sessions/${sessionId}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "没有这个 Agent 会话" });
  }

  // 创建者读流:落库的那一条按 seq 作帧 id 回放,流保持打开(会话空闲着仍然续得上)。
  const stream = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stream`, {
    headers: { cookie: owner },
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = frameReader(stream);
  const frame = await reader.next();
  assert.equal(frame.event, "trace");
  assert.equal(frame.id, "1");
  assert.equal((JSON.parse(frame.data) as Record).seq, 1);
  await reader.cancel();
});

test("记录流的 ?after=seq 只补它之后的落库条目", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);
  seedEntry(h.db.path, sessionId, { inputTokens: 10 });
  seedEntry(h.db.path, sessionId, { inputTokens: 20 });

  const stream = await fetch(
    `${h.serverUrl}/api/agent-sessions/${sessionId}/stream?after=1`,
    { headers: { cookie: owner } },
  );
  assert.equal(stream.status, 200);
  const reader = frameReader(stream);
  // 第一条不补,第一帧就是第二条。
  const frame = await reader.next();
  assert.equal(frame.id, "2");
  assert.equal((JSON.parse(frame.data) as Record).usage.inputTokens, 20);
  await reader.cancel();
});

test("用量按记录累加到会话上,统计页单列一行", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true, now: () => Date.parse(AT) });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, owner, productId);

  seedEntry(h.db.path, sessionId, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 });
  seedEntry(h.db.path, sessionId, { inputTokens: 30, outputTokens: 4, cacheWriteTokens: 1 });
  const expected = {
    inputTokens: 130,
    outputTokens: 24,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 160,
  };
  assert.deepEqual((await session(h, owner, sessionId)).usage, expected);

  // 统计页:Agent 会话单列一行,不混进 Review Run 那一格。
  const stats = await as(h, owner, "GET", "/stats");
  assert.equal(stats.status, 200);
  const read = (await stats.json()) as {
    usage: unknown;
    agentSessions: (ReviewerUsage & { sessions: number }) | null;
  };
  assert.equal(read.usage, null);
  assert.deepEqual(read.agentSessions, { sessions: 1, ...expected });

  // 系统管理员看得到全部会话的花费;别人的会话不进这个人自己那一行。
  const adminStats = (await (await h.api("GET", "/stats")).json()) as {
    agentSessions: { sessions: number } | null;
  };
  assert.equal(adminStats.agentSessions?.sessions, 1);
  const otherStats = (await (await as(h, other, "GET", "/stats")).json()) as {
    agentSessions: unknown;
  };
  assert.equal(otherStats.agentSessions, null);
});

/** 更新基点(issue #356)。回的是端点的原样响应,状态码与正文由各用例自己断言。 */
function updateBaseline(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  repo: { owner: string; repo: string } = GITEA_REPO,
): Promise<Response> {
  return as(h, cookie, "POST", `/agent-sessions/${sessionId}/baselines/${repo.owner}/${repo.repo}/update`);
}

async function recordsOf(h: PanelHarness, cookie: string, sessionId: number): Promise<Record[]> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${sessionId}/records`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { records: Record[] }).records;
}

test("更新基点:换到记下的那条分支此刻的 head,落一条基点更新,下一条消息的工作树停在新 commit", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  seedEntry(h.db.path, sessionId, { inputTokens: 1 });
  const previous = (await recordsOf(h, cookie, sessionId)).at(-1)!;
  // 建会话之后 `main` 往前走了一步。
  const moved = h.repo.commitToBranch("main", { "src/answer.ts": "export const answer = 3;\n" });

  try {
    const updated = await updateBaseline(h, cookie, sessionId);
    const text = await updated.text();
    assert.equal(updated.status, 200, text);
    assert.deepEqual(JSON.parse(text), {
      changed: true,
      owner: "acme",
      repo: "widgets",
      branch: "main",
      from: h.repo.baseSha,
      to: moved,
    });
    // 同一条分支、同一种来源,只换 sha。
    assert.deepEqual((await session(h, cookie, sessionId)).baselines, [
      { owner: "acme", repo: "widgets", sha: moved, branch: "main", kind: "branch" },
    ]);
    // 记录末尾多一条基点更新,接在此前最后一条上。
    const landed = await recordsOf(h, cookie, sessionId);
    assert.equal(landed.length, 2);
    const entry = landed[1]!.entry as {
      type: string;
      parentId: string | null;
      customType: string;
      display: boolean;
      content: string;
      details: unknown;
    };
    assert.equal(landed[1]!.type, "custom_message");
    assert.equal(entry.parentId, (previous.entry as { id: string }).id);
    assert.equal(entry.customType, "multireviewer-session-baseline-update");
    assert.equal(entry.display, true);
    assert.deepEqual(entry.details, {
      repo: "acme/widgets",
      branch: "main",
      from: h.repo.baseSha,
      to: moved,
    });
    assert.match(entry.content, new RegExp(`${h.repo.baseSha.slice(0, 7)}.*${moved.slice(0, 7)}`));

    // 分支没再动:回 changed false,不再落记录。
    const again = await updateBaseline(h, cookie, sessionId);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), {
      changed: false,
      owner: "acme",
      repo: "widgets",
      branch: "main",
      from: moved,
      to: moved,
    });
    assert.equal((await recordsOf(h, cookie, sessionId)).length, 2);

    // 下一条消息按新基点重建:工作树 HEAD 是新 commit。
    const sent = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
      clientMessageId: "c1",
      text: "拆一下这个需求",
    });
    assert.equal(sent.status, 202, await sent.text());
    assert.deepEqual(await sessionWorktreeHeads(h, [GITEA_REPO]), [moved]);
  } finally {
    await disposeAgentSessions();
  }
});

test("更新基点的回绝:不可见、不在会话、Tag、在跑、有排队、排空中,基点与记录都不动", async () => {
  const drain = createDrain();
  const h = await startReadyPanelHarness({ registerRepo: true, drain });
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id, alpha]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  h.repo.setLightweightTag("v1", h.repo.baseSha);
  const tagged = await createSession(h, owner, productId, [
    { owner: "acme", repo: "widgets", sha: h.repo.baseSha, branch: "v1", kind: "tag" },
  ]);
  const sessionId = await createSession(h, owner, productId);
  seedEntry(h.db.path, sessionId, { inputTokens: 1 });
  // 分支往前走了:每一道闸若没挡住,基点就会变。
  h.repo.commitToBranch("main", { "src/answer.ts": "export const answer = 3;\n" });
  const baselines = (await session(h, owner, sessionId)).baselines;
  const unchanged = async (): Promise<void> => {
    assert.deepEqual((await session(h, owner, sessionId)).baselines, baselines);
    assert.equal((await recordsOf(h, owner, sessionId)).length, 1);
  };
  const refused = async (response: Response, status: number, error: string): Promise<void> => {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  };

  // 同事连这个会话在不在都问不到;系统管理员看得到但不是创建者。
  await refused(await updateBaseline(h, other, sessionId), 404, "没有这个 Agent 会话");
  await refused(await updateBaseline(h, h.cookie, sessionId), 403, "只有会话的创建者能做");
  // 产品梳理与别的用途同律(issue #365):只有开这一场的那个人动得了它的基点。
  const store0 = openStore(h.db.path);
  const survey = store0.createAgentSession({
    productId,
    createdBy: "owner",
    purpose: "product-survey",
    createdAt: AT,
  }).id;
  store0.close();
  await refused(await updateBaseline(h, h.cookie, survey), 403, "只有会话的创建者能做");
  // 会话里没有这个仓库的会话基点(创建者没有 alpha 的仓库分配)。
  await refused(
    await updateBaseline(h, owner, sessionId, { owner: "acme", repo: "alpha" }),
    404,
    "这个会话没有 acme/alpha 的会话基点",
  );
  // 来自 Tag 的会话基点没有「最新」。
  await refused(
    await updateBaseline(h, owner, tagged),
    409,
    "acme/widgets 的会话基点来自 Tag v1,没有最新可更新",
  );
  await unchanged();

  // 有排队的消息(回收时落库的那一种):等它投出去再更新。
  const store = openStore(h.db.path);
  store.putAgentSessionPendingMessages(sessionId, [{ mode: "followUp", text: "再补一句" }]);
  store.close();
  const busy = "会话在跑或还有排队的消息,等它空闲再更新基点";
  await refused(await updateBaseline(h, owner, sessionId), 409, busy);
  await unchanged();
  assert.equal((await as(h, owner, "DELETE", `/agent-sessions/${sessionId}/queue`)).status, 200);

  try {
    // 在跑:受理即在跑。
    const sent = await as(h, owner, "POST", `/agent-sessions/${sessionId}/messages`, {
      clientMessageId: "c1",
      text: "拆一下这个需求",
    });
    assert.equal(sent.status, 202, await sent.text());
    await refused(await updateBaseline(h, owner, sessionId), 409, busy);
    assert.deepEqual((await session(h, owner, sessionId)).baselines, baselines);
  } finally {
    await disposeAgentSessions();
  }

  // 排空中。
  drain.begin();
  await refused(await updateBaseline(h, owner, sessionId), 503, "服务正在排空,等它起回来再发");
  assert.deepEqual((await session(h, owner, sessionId)).baselines, baselines);
});

test("更新基点时记下的分支在远端没了:照 ADR 0033 报错,基点与记录不动", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepos(h, "报销系统", [GITEA_REPO.id]);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId, [
    { owner: "acme", repo: "widgets", sha: h.repo.headSha, branch: "feature" },
  ]);
  const baselines = (await session(h, cookie, sessionId)).baselines;
  h.repo.deleteBranch("feature");

  const response = await updateBaseline(h, cookie, sessionId);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "读不到 acme/widgets 分支 feature 的当前 head",
  });
  assert.deepEqual((await session(h, cookie, sessionId)).baselines, baselines);
  assert.equal((await recordsOf(h, cookie, sessionId)).length, 0);
});
