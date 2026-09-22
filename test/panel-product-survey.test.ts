/**
 * 开产品梳理与梳理会话的那一段面板接口(CONTEXT.md 产品梳理,issue #365)。
 *
 * 缝照旧:面板 API 走真实 HTTP,产品与会话行落这个测试文件自己那个临时 PostgreSQL 库。压的是
 * 票里不需要真子进程的那几条
 * 验收:开梳理的三种回绝(仓库不足两个、没有权限格、对这个产品一个仓库都没分配)、同一个
 * 产品已有一场没谈完时的回绝与谈完之后的放行、创建者记的是点下「梳理」的那个人、归入与移出
 * 仓库一场会话也不开、非创建者发消息回 403。真跑起来那一路(种子消息、提示里的全量知识与
 * 纪律段、子代理派单、提问轮次、从答案写知识、完成标记)在 `agent-session-subprocess.test.ts`。
 *
 * 按仓库选基点(issue #353)也在这一道缝上:带基点的那一场记下选定的 sha 与分支、工作树停在
 * 它上面,外仓库与解析不出的 sha 一场梳理也不开。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { openStore, type AgentSessionRecord } from "../src/review/store/index.ts";
import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  PANEL_ADMIN_USERNAME,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "product-survey-test-password";
const AT = "2026-09-13T00:00:00.000Z";
const ALPHA = 101;

type Product = { id: number; name: string; repos: { repoId: number }[] };

/** 建一个产品,按 `repoIds` 归入仓库。`ALPHA` 只落注册表,不建 hook。 */
async function product(h: PanelHarness, repoIds: readonly number[]): Promise<Product> {
  await seedRepo(h, ALPHA, "acme", "alpha");
  const created = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(created.status, 201);
  const { product: row } = (await created.json()) as { product: Product };
  for (const repoId of repoIds) {
    assert.equal((await h.api("PUT", `/products/${row.id}/repos/${repoId}`)).status, 204);
  }
  return row;
}

async function survey(h: PanelHarness, productId: number, cookie?: string): Promise<Response> {
  return cookie === undefined
    ? await h.api("POST", `/products/${productId}/survey`)
    : fetch(`${h.serverUrl}/api/products/${productId}/survey`, {
        method: "POST",
        headers: { cookie },
      });
}

/** 直接落一行产品梳理会话,创建者是给的那个人。不经接口建:这几例只要它在库里。 */
async function seedSurveySession(
  h: PanelHarness,
  productId: number,
  createdBy: string,
): Promise<AgentSessionRecord> {
  const store = openStore(h.db.url);
  try {
    return await store.createAgentSession({
      productId,
      createdBy,
      purpose: "product-survey",
      createdAt: AT,
    });
  } finally {
    await store.close();
  }
}

/** 把这一场梳理记成谈完了,与完成工具落的是同一格。 */
async function completeSession(h: PanelHarness, sessionId: number): Promise<void> {
  const store = openStore(h.db.url);
  try {
    await store.completeAgentSession(sessionId, AT);
  } finally {
    await store.close();
  }
}

async function sessionsOf(
  h: PanelHarness,
  productId: number,
  cookie: string,
): Promise<{ id: number; purpose: string; createdBy: string }[]> {
  const response = await fetch(`${h.serverUrl}/api/products/${productId}/sessions`, {
    headers: { cookie },
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { sessions: { id: number; purpose: string; createdBy: string }[] })
    .sessions;
}

test("仓库不足两个的产品梳理不了:回一句中文,一个会话也没建起来", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const one = await product(h, [GITEA_REPO.id]);

  const refused = await survey(h, one.id);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "产品梳理要这个产品有两个以上仓库,先把第二个仓库归入它",
  });
  assert.deepEqual(await sessionsOf(h, one.id, h.cookie), []);
});

test("开梳理:创建者是点下它的那个人;那一场没谈完时第二次被回绝,谈完之后放行", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  try {
    const opened = await survey(h, two.id);
    const text = await opened.text();
    assert.equal(opened.status, 201, text);
    const { session } = JSON.parse(text) as { session: AgentSessionRecord };
    assert.equal(session.purpose, "product-survey");
    // 创建者是人:访谈的另一头是一个具体的人,只有他答得了题(CONTEXT.md 产品梳理)。
    assert.equal(session.createdBy, PANEL_ADMIN_USERNAME);
    assert.equal(session.completedAt, null);
    assert.deepEqual(
      (await sessionsOf(h, two.id, h.cookie)).map((row) => [row.id, row.purpose, row.createdBy]),
      [[session.id, "product-survey", PANEL_ADMIN_USERNAME]],
    );

    // 还没谈完:第二次回一句中文,不再开第二场。判据是那一格完成时刻,不是「在跑」——
    // 抛出一轮题的梳理正空闲着等人答,它照样挡住下一场。
    const again = await survey(h, two.id);
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), {
      error: "这个产品还有一场没谈完的产品梳理,先把它谈完",
    });
    assert.equal((await sessionsOf(h, two.id, h.cookie)).length, 1);

    // 谈完之后再开一场:新会话,上一场留着可读可续。
    await completeSession(h, session.id);
    const next = await survey(h, two.id);
    const nextText = await next.text();
    assert.equal(next.status, 201, nextText);
    const second = (JSON.parse(nextText) as { session: AgentSessionRecord }).session;
    assert.notEqual(second.id, session.id);
    assert.equal((await sessionsOf(h, two.id, h.cookie)).length, 2);
  } finally {
    await disposeAgentSessions();
  }
});

test("开梳理要 knowledge:write 加这个产品里的一个仓库分配", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);

  // 有仓库分配、没有这一格权限:403。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  const refused = await survey(h, two.id, reader);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "没有这一格权限" });

  // 有这一格权限、对这个产品里一个仓库都没分配:与产品不存在同形回 404。
  const stranger = await seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["knowledge:write"]);
  const hidden = await survey(h, two.id, outsider);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });

  // 两档回绝之后一场梳理也没开。
  assert.deepEqual(await sessionsOf(h, two.id, h.cookie), []);
});

test("梳理会话:产品可见者都读得到,只有创建者发得了消息", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  const owner = await scopedUser(h, "owner", PASSWORD, AT, [ALPHA], ["agent:chat"]);
  const session = await seedSurveySession(h, two.id, "owner");

  // 看得到产品、不是创建者的人:这一条在他的会话列表里,也读得开。
  const member = await scopedUser(h, "member", PASSWORD, AT, [ALPHA], ["agent:chat"]);
  assert.deepEqual(
    (await sessionsOf(h, two.id, member)).map((row) => [row.id, row.createdBy]),
    [[session.id, "owner"]],
  );
  const read = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}`, {
    headers: { cookie: member },
  });
  assert.equal(read.status, 200);

  // 发消息只有创建者做得了:别人读得到这一场,答不了它的题。
  const message = JSON.stringify({ clientMessageId: "c1", text: "第一题选 A" });
  const post = (cookie: string): Promise<Response> =>
    fetch(`${h.serverUrl}/api/agent-sessions/${session.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: message,
    });
  const refused = await post(member);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "只有会话的创建者能做" });

  // 系统管理员读得到,同样发不了:与别的用途同律。
  const admin = await h.api("POST", `/agent-sessions/${session.id}/messages`, {
    clientMessageId: "c2",
    text: "第一题选 A",
  });
  assert.equal(admin.status, 403);
  assert.deepEqual(await admin.json(), { error: "只有会话的创建者能做" });

  // 创建者发得出去:这一条起得了子进程,读完就把它连同工作树收掉。
  try {
    const sent = await post(owner);
    assert.equal(sent.status, 202, await sent.text());
  } finally {
    await disposeAgentSessions();
  }

  // 一个仓库都没分到的人看不到这个产品,也就问不到它的会话。
  const stranger = await seedRepo(h, 404, "acme", "delta");
  const nobody = await scopedUser(h, "nobody", PASSWORD, AT, [stranger], ["agent:chat"]);
  const hidden = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}`, {
    headers: { cookie: nobody },
  });
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个 Agent 会话" });
});

test("系统开的那几场梳理:系统管理员停得下、删得掉,别人一样只读", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  // 创建者是 `system`:升级前由系统开的那一档,没有哪个人续得了它。
  const session = await seedSurveySession(h, two.id, "system");

  // 看得到产品、有 agent:chat 的普通人:读得到,停不下也删不掉——他不是创建者。
  const member = await scopedUser(h, "member", PASSWORD, AT, [ALPHA], ["agent:chat"]);
  const asMember = (method: string, path: string): Promise<Response> =>
    fetch(`${h.serverUrl}/api/agent-sessions/${session.id}${path}`, {
      method,
      headers: { cookie: member },
    });
  for (const [method, path] of [
    ["POST", "/stop"],
    ["DELETE", ""],
  ] as const) {
    const refused = await asMember(method, path);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "只有会话的创建者能做" });
  }

  // 一个仓库都没分到的人连这一场在不在都问不出来。
  const stranger = await seedRepo(h, 505, "acme", "epsilon");
  const nobody = await scopedUser(h, "nobody", PASSWORD, AT, [stranger], ["agent:chat"]);
  const hidden = await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}/stop`, {
    method: "POST",
    headers: { cookie: nobody },
  });
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个 Agent 会话" });

  // 系统管理员停得下:没有人类创建者的梳理,跑飞了只有他停得了(issue #346)。
  const stopped = await h.api("POST", `/agent-sessions/${session.id}/stop`);
  const stoppedText = await stopped.text();
  assert.equal(stopped.status, 200, stoppedText);
  assert.deepEqual(JSON.parse(stoppedText), { stopped: false, queue: [] });

  // 也删得掉:交完卷的那一场不该谁都清不走。
  assert.equal((await h.api("DELETE", `/agent-sessions/${session.id}`)).status, 204);
  assert.deepEqual(await sessionsOf(h, two.id, h.cookie), []);
});

test("建会话端点不收产品梳理:那一种从产品页上的「梳理」开", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  const member = await scopedUser(h, "member", PASSWORD, AT, [ALPHA], ["agent:chat"]);

  const refused = await fetch(`${h.serverUrl}/api/products/${two.id}/sessions`, {
    method: "POST",
    headers: { cookie: member, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "product-survey" }),
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), {
    error: "会话用途必填,只能是需求拆分或开放对话",
  });
  assert.deepEqual(await sessionsOf(h, two.id, member), []);
});

test("归入、移出与下线仓库都不开梳理:那一场由人在产品页上开", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const beta = await seedRepo(h, 202, "acme", "beta");
  await seedRepo(h, ALPHA, "acme", "alpha");
  const created = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(created.status, 201);
  const { product: row } = (await created.json()) as { product: Product };

  // 归入三个仓库:仓库集一路在变,一场会话也没开。
  for (const repoId of [GITEA_REPO.id, ALPHA, beta]) {
    assert.equal((await h.api("PUT", `/products/${row.id}/repos/${repoId}`)).status, 204);
  }
  assert.deepEqual(await sessionsOf(h, row.id, h.cookie), []);

  // 移出一个:回应一格没变,仍然没有会话。
  assert.equal((await h.api("DELETE", `/products/${row.id}/repos/${beta}`)).status, 204);
  assert.deepEqual(await sessionsOf(h, row.id, h.cookie), []);

  // 下线一个:与移出同律。
  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}`)).status, 204);
  assert.deepEqual(await sessionsOf(h, row.id, h.cookie), []);
});

/**
 * 会话根下那棵工作树停在哪个 commit,按仓库给出(issue #350)。
 *
 * 看的是 git 自己给出的答案:一棵工作树连着它的 HEAD,agent 的工具看到的就是这一份。
 * 备树在会话开起来之后的后台里跑,因此等到每个仓库都挂出一棵为止;**一遍读完全部仓库**
 * ——备树按仓库名顺序进行,而这个会话开不起来(模型服务地址是假的)时几棵树一起释放,
 * 分几遍读会让先备好的那一棵在读到它之前就被收掉。
 */
async function sessionWorktreeHeads(
  h: PanelHarness,
  refs: readonly { owner: string; repo: string }[],
): Promise<string[]> {
  const head = (ref: { owner: string; repo: string }): string | undefined => {
    const clone = join(h.cacheDir, ref.owner, ref.repo);
    // 缓存副本本身也是这一次备出来的:还没 clone 出来时当作还没挂树。
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

/** 一个会话记下的「开在哪个 commit」那一份(issue #351)。 */
async function baselinesOf(
  h: PanelHarness,
  sessionId: number,
): Promise<{ owner: string; repo: string; sha: string; branch: string; kind: string }[]> {
  const response = await h.api("GET", `/agent-sessions/${sessionId}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (
    JSON.parse(text) as {
      session: { baselines: { owner: string; repo: string; sha: string; branch: string; kind: string }[] };
    }
  ).session.baselines;
}

/**
 * 开梳理按仓库选基点(issue #353)。人在弹窗里按仓库选过的那几行进请求体,校验与建会话同一份
 * (`resolveSessionBaselines`),仓库范围是产品的全部仓库——梳理读的正是这一份。
 *
 * 夹具那个仓库的 Gitea 默认分支是 `main`(指向 `baseSha`),`feature` 指向 `headSha`;
 * `acme/alpha` 没设过默认分支,因此跟随 `main`。
 */
test("开梳理带按仓库基点:会话记下选定的 sha 与分支,工作树停在它上面", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  try {
    const opened = await h.api("POST", `/products/${two.id}/survey`, {
      baselines: [{ ...GITEA_REPO, sha: h.repo.headSha, branch: "v1.0", kind: "tag" }],
    });
    const text = await opened.text();
    assert.equal(opened.status, 201, text);
    const { session } = JSON.parse(text) as { session: AgentSessionRecord };

    // 选过的那一行按他选的 commit 与他浏览的那个来源记(这里是 Tag,issue #355);没动过的那个仓库回落生效的默认分支。
    assert.deepEqual(await baselinesOf(h, session.id), [
      { owner: "acme", repo: "alpha", sha: h.repo.baseSha, branch: "main", kind: "branch" },
      { owner: "acme", repo: "widgets", sha: h.repo.headSha, branch: "v1.0", kind: "tag" },
    ]);

    // agent 的工具看到的就是这一份:工作树的 HEAD 停在会话记下的那个 commit 上。
    assert.deepEqual(
      await sessionWorktreeHeads(h, [{ owner: "acme", repo: "alpha" }, GITEA_REPO]),
      [h.repo.baseSha, h.repo.headSha],
    );
  } finally {
    await disposeAgentSessions();
  }
});

test("开梳理选基点:外仓库、解析不出的 sha 与形状不对都回绝,一场梳理也没开", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const two = await product(h, [GITEA_REPO.id, ALPHA]);
  // 注册了但没归进这个产品的仓库:它的 commit 不该被这一场梳理读到。
  await seedRepo(h, 303, "acme", "gamma");

  const rejected = async (baselines: unknown, error: string): Promise<void> => {
    const response = await h.api("POST", `/products/${two.id}/survey`, { baselines });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.deepEqual(JSON.parse(text), { error });
  };

  await rejected(
    [{ owner: "acme", repo: "gamma", sha: h.repo.headSha }],
    "选不了 acme/gamma 的基点:它不在这个产品里",
  );
  await rejected(
    [{ ...GITEA_REPO, sha: "0".repeat(40) }],
    `${GITEA_REPO.owner}/${GITEA_REPO.repo} 里没有 ${"0".repeat(40)} 这个提交`,
  );
  const badKind = { ...GITEA_REPO, sha: h.repo.headSha, kind: "commit" };
  for (const shape of ["main", [{ owner: "acme", repo: "widgets" }], [42], [badKind]]) {
    await rejected(shape, "baselines 要是一串 { owner, repo, sha },branch 可选");
  }

  // 回绝那几次一场梳理也没开:人看到的是「没梳起来 + 哪个仓库」,不是一个读错代码的会话。
  assert.deepEqual(await sessionsOf(h, two.id, h.cookie), []);
});
