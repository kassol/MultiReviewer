/**
 * Agent 会话实体与它的面板接口(issue #332)。
 *
 * 缝与产品那一票相同:面板 API 走真实 HTTP,会话行落一次性 PostgreSQL 库。压的是票的验收:
 * `agent:chat` 独立一格、用途必填且只收需求拆分与开放对话、没有这一格建 / 删被挡、非创建者读 404、
 * 系统管理员读得到全部但发消息被拒,以及删会话与删产品级联的条数。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { effectivePanelPermissions, PANEL_PERMISSIONS } from "../src/panel/permissions.ts";
import { openStore } from "../src/review/store/index.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { withTestDb } from "./support/git-fixture.ts";

const PASSWORD = "agent-session-test-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";

type AgentSession = {
  id: number;
  productId: number;
  createdBy: string;
  purpose: string;
  status: string;
  createdAt: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  /** 这个会话每个仓库开在哪个 commit(issue #351)。 */
  baselines: AgentSessionBaseline[];
  /** 第一条用户消息的正文,读时派生(没发过消息时是 null)。 */
  title: string | null;
  /** 最后一次有动静的时刻,读时派生。 */
  lastActiveAt: string;
};

type AgentSessionBaseline = {
  owner: string;
  repo: string;
  sha: string;
  branch: string;
  kind: "branch" | "tag";
};

/** 以指定 cookie 发一次请求。`h.api()` 只带系统管理员那一份。 */
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

/** 建一个产品并把 harness 那个仓库归进去,回产品 id。会话都挂在它下面。 */
async function productWithRepo(h: PanelHarness, name: string): Promise<number> {
  const created = await h.api("POST", "/products", { name });
  const text = await created.text();
  assert.equal(created.status, 201, text);
  const { product } = JSON.parse(text) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  return product.id;
}

async function createSession(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<AgentSession> {
  const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
    purpose: PURPOSE,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: AgentSession }).session;
}

async function sessions(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<AgentSession[]> {
  const response = await as(h, cookie, "GET", `/products/${productId}/sessions`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { sessions: AgentSession[] }).sessions;
}

test("agent:chat 独立一格:不蕴含别的格,也不被任何格蕴含", () => {
  assert.ok(PANEL_PERMISSIONS.includes("agent:chat"));
  // 只勾这一格即只有这一格:它不带出任何读权限。
  assert.deepEqual(effectivePanelPermissions(["agent:chat"]), ["agent:chat"]);
  // 勾齐其余全部格也勾不出它:没有哪一格蕴含它。
  const others = PANEL_PERMISSIONS.filter((permission) => permission !== "agent:chat");
  assert.ok(!effectivePanelPermissions(others).includes("agent:chat"));
});

test("建会话要用途,且只收需求拆分与开放对话", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);

  for (const body of [{}, { purpose: "" }, { purpose: "代码修复" }, { purpose: 42 }]) {
    const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: "会话用途必填,只能是需求拆分或开放对话",
    });
  }

  const session = await createSession(h, cookie, productId);
  assert.equal(session.productId, productId);
  assert.equal(session.createdBy, "member");
  assert.equal(session.purpose, PURPOSE);
  assert.equal(session.status, "idle");
  assert.equal(typeof session.createdAt, "string");
  assert.deepEqual(session.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  });

  // 读回来与建出来的那一份同形,跟着回一份空的排队列表(issue #334)、图片能力那一格
  // (issue #336:这套夹具的模型目录没声明看得了图)、「前 N 条不在上下文」那个数
  // (issue #335:一条记录都还没有,因此是 0),以及这一场写进产品 tracker 的 spec 与票
  // (issue #366:还一条都没写)。
  const read = await as(h, cookie, "GET", `/agent-sessions/${session.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    session,
    queue: [],
    imageInput: false,
    droppedFromContext: 0,
    wrote: { specs: [], tickets: [] },
  });
  assert.deepEqual(await sessions(h, cookie, productId), [session]);

  // 开放对话也收:它是第二个用途,与需求拆分同一条建会话的路。
  const open = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
    purpose: "open-conversation",
  });
  assert.equal(open.status, 201);
  const { session: chat } = (await open.json()) as { session: AgentSession };
  assert.equal(chat.purpose, "open-conversation");
  assert.deepEqual(await sessions(h, cookie, productId), [chat, session]);
});

test("没有 agent:chat 的人建会话与删会话都被挡,读不受影响", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const session = await createSession(h, owner, productId);
  // 有仓库分配、没有任何权限格的账号。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);

  for (const [method, path, body] of [
    ["POST", `/products/${productId}/sessions`, { purpose: PURPOSE }],
    ["DELETE", `/agent-sessions/${session.id}`, undefined],
    ["POST", `/agent-sessions/${session.id}/messages`, {}],
  ] as const) {
    const response = await as(h, reader, method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "没有这一格权限" });
  }

  // 这一格不管读:它只是别人的会话,所以落在 404 那一档上,而不是 403。
  assert.equal((await as(h, reader, "GET", `/agent-sessions/${session.id}`)).status, 404);
  assert.deepEqual(await sessions(h, reader, productId), []);
});

test("看不到产品的人建不了会话,也问不到它下面有没有会话", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const alpha = await seedRepo(h, 101, "acme", "alpha");
  // 有 agent:chat,但分配的是另一个仓库:这个产品对他不存在。
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [alpha], ["agent:chat"]);

  for (const [method, body] of [
    ["GET", undefined],
    ["POST", { purpose: PURPOSE }],
  ] as const) {
    const response = await as(h, outsider, method, `/products/${productId}/sessions`, body);
    assert.equal(response.status, 404, method);
    assert.deepEqual(await response.json(), { error: "没有这个产品" });
  }
});

test("会话只创建者读得到,系统管理员读得到所有人的但发消息被拒", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const other = await scopedUser(h, "other", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const session = await createSession(h, owner, productId);
  const otherSession = await createSession(h, other, productId);

  // 同事:会话不存在与不是我的同形 404,发消息与删除同样问不到。
  for (const [method, path] of [
    ["GET", `/agent-sessions/${session.id}`],
    ["DELETE", `/agent-sessions/${session.id}`],
    ["POST", `/agent-sessions/${session.id}/messages`],
    ["POST", `/agent-sessions/${session.id}/stop`],
    ["DELETE", `/agent-sessions/${session.id}/queue`],
  ] as const) {
    const response = await as(h, other, method, path, method === "GET" ? undefined : {});
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "没有这个 Agent 会话" });
  }
  // 「我的会话」就是我的:两个人各看到自己那一条。
  assert.deepEqual(
    (await sessions(h, other, productId)).map((row) => row.id),
    [otherSession.id],
  );

  // 系统管理员:读得到两个人的会话,写一律被拒。
  assert.deepEqual(
    (await sessions(h, h.cookie, productId)).map((row) => row.id),
    [otherSession.id, session.id],
  );
  assert.equal((await h.api("GET", `/agent-sessions/${session.id}`)).status, 200);
  for (const [method, path] of [
    ["POST", `/agent-sessions/${session.id}/messages`],
    ["DELETE", `/agent-sessions/${session.id}`],
    ["POST", `/agent-sessions/${session.id}/stop`],
    ["DELETE", `/agent-sessions/${session.id}/queue`],
  ] as const) {
    const response = await h.api(method, path, {});
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "只有会话的创建者能做" });
  }

  // 创建者发消息过了门禁,接着才判请求体(issue #333)。
  const message = await as(h, owner, "POST", `/agent-sessions/${session.id}/messages`, {});
  assert.equal(message.status, 400);
  assert.deepEqual(await message.json(), {
    error: "发消息要带 clientMessageId 与非空的 text",
  });
});

test("删会话只删那一条,删产品级联删掉它下面的全部会话并回条数", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const first = await createSession(h, owner, productId);
  const second = await createSession(h, owner, productId);
  const third = await createSession(h, owner, productId);

  assert.equal((await as(h, owner, "DELETE", `/agent-sessions/${first.id}`)).status, 204);
  const gone = await as(h, owner, "GET", `/agent-sessions/${first.id}`);
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { error: "没有这个 Agent 会话" });
  assert.equal((await as(h, owner, "DELETE", `/agent-sessions/${first.id}`)).status, 404);
  assert.deepEqual(
    (await sessions(h, owner, productId)).map((row) => row.id),
    [third.id, second.id],
  );

  const removed = await h.api("DELETE", `/products/${productId}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { cascade: { sessions: 2 } });
  // 会话跟着产品走:剩下那两条连读都读不到了。
  for (const id of [second.id, third.id]) {
    assert.equal((await as(h, owner, "GET", `/agent-sessions/${id}`)).status, 404);
  }
});

/**
 * 建会话时按仓库选基点(issue #352)。压的是这一格在 HTTP 上的三条:选过的行记他选的那个
 * commit 与分支、没选的行回落生效的默认分支,以及两类回绝一条会话都不落。
 *
 * 夹具那个仓库的 Gitea 默认分支是 `main`(指向 `baseSha`),`feature` 指向 `headSha`。
 */
test("建会话按仓库选基点:选过的记他选的,没带分支名的记生效默认分支", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);

  const create = (baselines: unknown): Promise<Response> =>
    as(h, cookie, "POST", `/products/${productId}/sessions`, { purpose: PURPOSE, baselines });

  // 没动选择器:与这一票之前同律,跟随生效的默认分支。
  const untouched = await createSession(h, cookie, productId);
  assert.deepEqual(untouched.baselines, [
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.baseSha, branch: "main", kind: "branch" },
  ]);

  // 动过的那一行:记他选的 commit 与他浏览的那条分支。
  const picked = await create([
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "feature", kind: "branch" },
  ]);
  assert.equal(picked.status, 201, await picked.clone().text());
  assert.deepEqual(((await picked.json()) as { session: AgentSession }).session.baselines, [
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "feature", kind: "branch" },
  ]);

  // 从 Tag 里选的那一行(issue #355):来源记作 Tag,名字就是那个 Tag。建完的回应与读会话
  // 接口说的是同一份。
  const tagged = await create([
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "v1.0", kind: "tag" },
  ]);
  assert.equal(tagged.status, 201, await tagged.clone().text());
  const taggedSession = ((await tagged.json()) as { session: AgentSession }).session;
  const taggedRead = await as(h, cookie, "GET", `/agent-sessions/${taggedSession.id}`);
  assert.deepEqual(((await taggedRead.json()) as { session: AgentSession }).session.baselines, [
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "v1.0", kind: "tag" },
  ]);

  // 只给 sha 不给分支名:记生效的默认分支——他没换过分支。
  const noBranch = await create([
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha },
  ]);
  assert.equal(noBranch.status, 201, await noBranch.clone().text());
  assert.deepEqual(((await noBranch.json()) as { session: AgentSession }).session.baselines, [
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "main", kind: "branch" },
  ]);

  assert.equal((await sessions(h, cookie, productId)).length, 4);
});

test("建会话选基点:外仓库、解析不出的 sha 与形状不对都回绝,一条会话都不落", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  // 注册了但没归进这个产品的仓库:它的 commit 不该被这个会话读到。
  await seedRepo(h, 101, "acme", "alpha");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id, 101], [
    "agent:chat",
  ]);

  const rejected = async (baselines: unknown, error: string): Promise<void> => {
    const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
      purpose: PURPOSE,
      baselines,
    });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.deepEqual(JSON.parse(text), { error });
  };

  await rejected(
    [{ owner: "acme", repo: "alpha", sha: h.repo.headSha }],
    "选不了 acme/alpha 的基点:它不在这个产品里",
  );
  await rejected(
    [{ owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: "0".repeat(40) }],
    `${GITEA_REPO.owner}/${GITEA_REPO.repo} 里没有 ${"0".repeat(40)} 这个提交`,
  );
  const badKind = { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, kind: "commit" };
  for (const shape of ["main", [{ owner: "acme", repo: "widgets" }], [42], [badKind]]) {
    await rejected(shape, "baselines 要是一串 { owner, repo, sha },branch 可选");
  }

  // 回绝那几次一条会话都没落下。
  assert.deepEqual(await sessions(h, cookie, productId), []);
});

test("来源种类之前记下的基点:行里没有 kind,读回来一律是分支", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const created = await createSession(h, owner, productId);
  // 直接播种这一票之前那种形状的行:只有 owner / repo / sha / branch。不回填,读时补上。
  await withTestDb(h.db.url, async (sql) => {
    await sql(
      "UPDATE agent_session SET baselines = $1 WHERE id = $2",
      JSON.stringify([
        { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "feature" },
      ]),
      created.id,
    );
  });

  const response = await as(h, owner, "GET", `/agent-sessions/${created.id}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual((JSON.parse(text) as { session: AgentSession }).session.baselines, [
    { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo, sha: h.repo.headSha, branch: "feature", kind: "branch" },
  ]);
});

test("会话记录分页:缺省回最后一页,before 往前翻,hasMore 说还有没有更早的", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const session = await createSession(h, owner, productId);

  // 五条记录,正文各不相同:哪一页回了哪几条认得出来。
  const store = openStore(h.db.url);
  for (let index = 1; index <= 5; index += 1) {
    await store.appendAgentSessionEntry(session.id, {
      type: "message",
      at: AT,
      entry: { id: `e${index}`, type: "message", message: { role: "user", content: `第 ${index} 条` } },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    });
  }
  await store.close();

  const page = async (
    query: string,
  ): Promise<{ seqs: number[]; hasMore: boolean }> => {
    const response = await as(h, owner, "GET", `/agent-sessions/${session.id}/records${query}`);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text) as { records: { seq: number }[]; hasMore: boolean };
    return { seqs: body.records.map((record) => record.seq), hasMore: body.hasMore };
  };

  // 缺省回最后一页(一共五条,一页装得下),没有更早的。
  assert.deepEqual(await page(""), { seqs: [1, 2, 3, 4, 5], hasMore: false });
  // 一页两条:最后一页是 4、5,它之前还有。
  assert.deepEqual(await page("?limit=2"), { seqs: [4, 5], hasMore: true });
  // 往前翻一页:seq 升序,仍然还有更早的。
  assert.deepEqual(await page("?limit=2&before=4"), { seqs: [2, 3], hasMore: true });
  // 翻到头:最后这一页之前没有了。
  assert.deepEqual(await page("?limit=2&before=2"), { seqs: [1], hasMore: false });
  // 认不出的参数回落到缺省:一页全回,不报错。
  assert.deepEqual(await page("?limit=abc&before=-3"), { seqs: [1, 2, 3, 4, 5], hasMore: false });
});

test("面板标题与最后动静:读时从记录派生,不落库", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);

  // 还没发过消息(刚建的会话):标题是 null,最后动静落建会话那一刻。
  const fresh = await createSession(h, owner, productId);
  assert.equal(fresh.title, null);
  assert.equal(fresh.lastActiveAt, fresh.createdAt);

  const withMessage = await createSession(h, owner, productId);
  const firstAt = "2026-09-12T00:10:00.000Z";
  const secondAt = "2026-09-12T00:20:00.000Z";
  const store = openStore(h.db.url);
  try {
    // 第一条用户消息带一张图,文字块排在图片块后面:标题不能假定文字在下标 0。正文里的
    // 连续空白与首尾空白折成一个空格。
    await store.appendAgentSessionEntry(withMessage.id, {
      type: "message",
      at: firstAt,
      entry: {
        id: "e1",
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "image-ref", imageId: "img-1", path: "/tmp/img-1.png", mimeType: "image/png" },
            { type: "text", text: "  这是   第一条\n用户消息  " },
          ],
        },
      },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    });
    // 之后一条 assistant 消息更晚:最后动静跟着它走,标题仍然是第一条用户消息。
    await store.appendAgentSessionEntry(withMessage.id, {
      type: "message",
      at: secondAt,
      entry: { id: "e2", type: "message", message: { role: "assistant", content: "收到" } },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    });
  } finally {
    await store.close();
  }

  const read = await sessions(h, owner, productId);
  const row = read.find((one) => one.id === withMessage.id)!;
  assert.equal(row.title, "这是 第一条 用户消息");
  assert.equal(row.lastActiveAt, secondAt);

  const other = read.find((one) => one.id === fresh.id)!;
  assert.equal(other.title, null);
});
