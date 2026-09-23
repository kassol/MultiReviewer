/**
 * 产品 tracker 的那一段面板接口(CONTEXT.md 产品 tracker、spec、票、认领,ADR 0035,
 * issue #361、#363)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,spec 与票落这个测试文件自己那个
 * 临时 PostgreSQL 库。压的是两票的验收:产品页读到 spec 连它的票(标签、状态、认领人、
 * 阻塞者)、一条 spec 打得开全文、导出是一份票按依赖顺序排的 Markdown、看不到这个产品的人
 * 什么都读不到;人做得了认领与取消认领、改标签(只有五个)、开关 spec 与票、评论,
 * 正文与标题改不动。取消认领与抢认领同一道闸:只有认领人自己与系统管理员放得下那一格。
 *
 * 会话经工具写 tracker 那条路在 `agent-session-subprocess.test.ts`:这里只把行落进库,压的是
 * 读侧与人的动作。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  openStore,
  PRODUCT_TICKET_LABELS,
  type ProductTicketLabel,
} from "../src/review/store/index.ts";
import {
  GITEA_REPO,
  PANEL_ADMIN_USERNAME,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "product-tracker-test-password";
const AT = "2026-09-17T00:00:00.000Z";

type TrackerTicket = {
  id: number;
  title: string;
  label: ProductTicketLabel;
  state: string;
  claimedBy: string | null;
  blockedBy: number[];
};
type TrackerSpec = { id: number; title: string; state: string; tickets: TrackerTicket[] };
type Product = { id: number; name: string };

/** 建一个带一个仓库的产品。tracker 不要求仓库数,一个够判可见性。 */
async function product(h: PanelHarness): Promise<Product> {
  const response = await h.api("POST", "/products", { name: "报销系统" });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const created = (JSON.parse(text) as { product: Product }).product;
  const store = openStore(h.db.url);
  assert.equal(await store.attachProductRepo(created.id, GITEA_REPO.id, AT), "attached");
  return created;
}

/**
 * 播种一条 spec 与几张票(会话写下的那一份的形状)。回的是 spec 号与票号,按给的顺序。
 * `blocks` 是阻塞边,按票在 `tickets` 里的位置(从 0 起)写。
 */
async function seedSpec(
  h: PanelHarness,
  productId: number,
  spec: { title: string; body: string },
  tickets: readonly { title: string; body: string; label?: ProductTicketLabel }[] = [],
  blocks: readonly [number, number][] = [],
): Promise<{ specId: number; ticketIds: number[] }> {
  const store = openStore(h.db.url);
  const written = await store.createProductSpec({
    productId,
    title: spec.title,
    body: spec.body,
    sessionId: null,
    at: AT,
  });
  const ticketIds: number[] = [];
  for (const ticket of tickets) {
    const written1 = await store.createProductTicket({
      specId: written.id,
      title: ticket.title,
      body: ticket.body,
      label: ticket.label ?? "needs-triage",
      sessionId: null,
      at: AT,
    });
    ticketIds.push(written1.id);
  }
  for (const [blocked, blocker] of blocks) {
    await store.addProductTicketBlock(ticketIds[blocked]!, ticketIds[blocker]!);
  }
  return { specId: written.id, ticketIds };
}

async function detail(
  h: PanelHarness,
  productId: number,
  cookie?: string,
): Promise<{ tracker: { specs: TrackerSpec[] } }> {
  const response =
    cookie === undefined
      ? await h.api("GET", `/products/${productId}`)
      : await fetch(`${h.serverUrl}/api/products/${productId}`, { headers: { cookie } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as { tracker: { specs: TrackerSpec[] } };
}

test("产品页读到 spec 连它的票:标签、状态、认领人与阻塞者都在", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { specId, ticketIds } = await seedSpec(
    h,
    created.id,
    { title: "报销单可以撤回", body: "## Problem Statement\n\n提交之后改不了。" },
    [
      { title: "撤回接口", body: "PATCH /expenses/{id}", label: "ready-for-agent" },
      { title: "撤回按钮", body: "列表页每行一颗", label: "needs-info" },
    ],
    // 第二张票等第一张。
    [[1, 0]],
  );
  const store = openStore(h.db.url);
  assert.equal(await store.setProductTicketState(ticketIds[0]!, "closed", AT), true);

  const { tracker } = await detail(h, created.id);
  assert.equal(tracker.specs.length, 1);
  assert.equal(tracker.specs[0]!.id, specId);
  assert.equal(tracker.specs[0]!.title, "报销单可以撤回");
  assert.equal(tracker.specs[0]!.state, "open");
  assert.deepEqual(tracker.specs[0]!.tickets, [
    {
      id: ticketIds[0],
      title: "撤回接口",
      label: "ready-for-agent",
      state: "closed",
      claimedBy: null,
      blockedBy: [],
    },
    {
      id: ticketIds[1],
      title: "撤回按钮",
      label: "needs-info",
      state: "open",
      claimedBy: null,
      blockedBy: [ticketIds[0]],
    },
  ]);
});

test("一条 spec 打得开全文:正文、票的正文与评论都在", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { specId, ticketIds } = await seedSpec(
    h,
    created.id,
    { title: "报销单可以撤回", body: "## Problem Statement\n\n提交之后改不了。" },
    [{ title: "撤回接口", body: "PATCH /expenses/{id}\n\n验收:重复撤回回 409。" }],
  );
  const store = openStore(h.db.url);
  await store.addProductTicketComment({
    ticketId: ticketIds[0]!,
    author: null,
    sessionId: 7,
    body: "财务确认了只有草稿态能撤回。",
    at: AT,
  });

  const response = await h.api("GET", `/products/${created.id}/specs/${specId}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const read = JSON.parse(text) as {
    spec: { id: number; title: string; body: string; state: string };
    tickets: {
      id: number;
      body: string;
      blockedBy: number[];
      comments: { body: string; sessionId: number | null }[];
    }[];
  };
  assert.equal(read.spec.id, specId);
  assert.equal(read.spec.body, "## Problem Statement\n\n提交之后改不了。");
  assert.equal(read.tickets.length, 1);
  assert.match(read.tickets[0]!.body, /重复撤回回 409/);
  assert.deepEqual(read.tickets[0]!.comments.map((one) => one.body), [
    "财务确认了只有草稿态能撤回。",
  ]);

  // 别的产品的 spec 与不存在的说同一句话。
  const other = await h.api("POST", "/products", { name: "结算系统" });
  const otherId = ((await other.json()) as { product: Product }).product.id;
  const hidden = await h.api("GET", `/products/${otherId}/specs/${specId}`);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这条 spec" });
});

test("导出一条 spec:一份 text/markdown,票按依赖顺序", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { specId, ticketIds } = await seedSpec(
    h,
    created.id,
    { title: "报销单可以撤回", body: "提交之后改不了。" },
    [
      { title: "撤回按钮", body: "列表页每行一颗", label: "needs-info" },
      { title: "撤回接口", body: "PATCH /expenses/{id}", label: "ready-for-agent" },
    ],
    // 先建的那张票等后建的那张:导出因此不能按票号排。
    [[0, 1]],
  );

  const response = await h.api("GET", `/products/${created.id}/specs/${specId}/export`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(body, /^# 报销单可以撤回\n/);
  assert.match(body, /提交之后改不了。/);
  // 挡着别人的那一张排在前面。
  assert.ok(
    body.indexOf(`### #${ticketIds[1]} 撤回接口`) < body.indexOf(`### #${ticketIds[0]} 撤回按钮`),
    `票没按依赖顺序排:\n${body}`,
  );
  assert.match(body, /- 标签:ready-for-agent/);
  assert.match(body, new RegExp(`- 阻塞它的票:#${ticketIds[1]}`));
  assert.match(body, /- 认领人:无人认领/);
});

test("读随产品可见性:看不到这个产品的人一格都读不到", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { specId } = await seedSpec(h, created.id, { title: "报销单可以撤回", body: "提交之后改不了。" });

  // 有仓库分配、没有任何权限格:读得到 tracker——读随产品可见性,不挂权限格。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  assert.equal((await detail(h, created.id, reader)).tracker.specs.length, 1);

  // 对这个产品里一个仓库都没分配:产品详情、spec 全文与导出都与产品不存在同形回 404。
  const stranger = await seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger]);
  for (const path of [
    `/api/products/${created.id}`,
    `/api/products/${created.id}/specs/${specId}`,
    `/api/products/${created.id}/specs/${specId}/export`,
  ]) {
    const response = await fetch(`${h.serverUrl}${path}`, { headers: { cookie: outsider } });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "没有这个产品" });
  }
});

/** 当前 tracker 里那一张票(按票号找)。人的动作落没落下去看它。 */
async function ticketOf(h: PanelHarness, productId: number, ticketId: number): Promise<TrackerTicket> {
  const { tracker } = await detail(h, productId);
  const found = tracker.specs.flatMap((spec) => spec.tickets).find((one) => one.id === ticketId);
  assert.ok(found !== undefined, `tracker 里没有票 ${ticketId}`);
  return found;
}

test("人认领与取消认领一张票:认领落自己的名字,别人认领着的认不动", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { ticketIds } = await seedSpec(h, created.id, { title: "报销单可以撤回", body: "改不了。" }, [
    { title: "撤回接口", body: "PATCH /expenses/{id}" },
  ]);
  const ticketId = ticketIds[0]!;
  const path = `/products/${created.id}/tickets/${ticketId}`;

  const claimed = await h.api("PUT", path, { claimed: true });
  assert.equal(claimed.status, 200, await claimed.text());
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, PANEL_ADMIN_USERNAME);

  // 同一个人认领两次是同一个意思。
  assert.equal((await h.api("PUT", path, { claimed: true })).status, 200);

  // 别人认领着的票认不动:后一个不该把前一个顶掉。
  const other = await scopedUser(h, "zhangsan", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const stolen = await fetch(`${h.serverUrl}/api${path}`, {
    method: "PUT",
    headers: { cookie: other, "content-type": "application/json" },
    body: JSON.stringify({ claimed: true }),
  });
  assert.equal(stolen.status, 409);
  assert.deepEqual(await stolen.json(), { error: "这张票已经有人认领了" });
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, PANEL_ADMIN_USERNAME);

  // 取消认领之后那一格空着,别人就认得上了。
  assert.equal((await h.api("PUT", path, { claimed: false })).status, 200);
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, null);
  const retried = await fetch(`${h.serverUrl}/api${path}`, {
    method: "PUT",
    headers: { cookie: other, "content-type": "application/json" },
    body: JSON.stringify({ claimed: true }),
  });
  assert.equal(retried.status, 200, await retried.text());
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, "zhangsan");
});

test("取消认领不是谁都做得了:只有认领人自己与系统管理员放得下那一格", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { ticketIds } = await seedSpec(h, created.id, { title: "报销单可以撤回", body: "改不了。" }, [
    { title: "撤回接口", body: "PATCH /expenses/{id}" },
  ]);
  const ticketId = ticketIds[0]!;
  const path = `/products/${created.id}/tickets/${ticketId}`;
  const zhangsan = await scopedUser(h, "zhangsan", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const lisi = await scopedUser(h, "lisi", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const put = (cookie: string, body: unknown): Promise<Response> =>
    fetch(`${h.serverUrl}/api${path}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await put(zhangsan, { claimed: true })).status, 200);

  // 别人取消不动:一块共用的板子上,手里的活不该被随手收走。
  const stolen = await put(lisi, { claimed: false });
  assert.equal(stolen.status, 409);
  assert.deepEqual(await stolen.json(), {
    error: "这张票是别人认领的,只有认领人自己或系统管理员取消得了",
  });
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, "zhangsan");

  // 认领人自己放得下。
  assert.equal((await put(zhangsan, { claimed: false })).status, 200);
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, null);

  // 系统管理员收得回走了的人占住的那一格。
  assert.equal((await put(zhangsan, { claimed: true })).status, 200);
  const byAdmin = await h.api("PUT", path, { claimed: false });
  assert.equal(byAdmin.status, 200, await byAdmin.text());
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, null);

  // 认领仍只落调用方自己的名字:系统管理员那一档只放开取消。
  assert.equal((await put(zhangsan, { claimed: true })).status, 200);
  const adminClaim = await h.api("PUT", path, { claimed: true });
  assert.equal(adminClaim.status, 409);
  assert.deepEqual(await adminClaim.json(), { error: "这张票已经有人认领了" });
  assert.equal((await ticketOf(h, created.id, ticketId)).claimedBy, "zhangsan");
});

test("人改标签:五个之内换得动,别的值回 400", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { ticketIds } = await seedSpec(h, created.id, { title: "报销单可以撤回", body: "改不了。" }, [
    { title: "撤回接口", body: "PATCH /expenses/{id}" },
  ]);
  const path = `/products/${created.id}/tickets/${ticketIds[0]!}`;

  for (const label of PRODUCT_TICKET_LABELS) {
    const response = await h.api("PUT", path, { label });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await ticketOf(h, created.id, ticketIds[0]!)).label, label);
  }

  // 不在这五个里的一律打回,那一格原样不动。
  for (const label of ["p0", "needs triage", "", 7]) {
    const refused = await h.api("PUT", path, { label });
    assert.equal(refused.status, 400, `${String(label)} 应该被打回`);
  }
  assert.equal((await ticketOf(h, created.id, ticketIds[0]!)).label, "wontfix");
});

test("人开关 spec 与票,并在票上评论", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { specId, ticketIds } = await seedSpec(
    h,
    created.id,
    { title: "报销单可以撤回", body: "改不了。" },
    [{ title: "撤回接口", body: "PATCH /expenses/{id}" }],
  );
  const ticketId = ticketIds[0]!;

  const closedTicket = await h.api("PUT", `/products/${created.id}/tickets/${ticketId}`, {
    state: "closed",
  });
  assert.equal(closedTicket.status, 200, await closedTicket.text());
  assert.equal((await ticketOf(h, created.id, ticketId)).state, "closed");
  // 再开回来。
  assert.equal(
    (await h.api("PUT", `/products/${created.id}/tickets/${ticketId}`, { state: "open" })).status,
    200,
  );
  assert.equal((await ticketOf(h, created.id, ticketId)).state, "open");

  const closedSpec = await h.api("PUT", `/products/${created.id}/specs/${specId}`, {
    state: "closed",
  });
  assert.equal(closedSpec.status, 200, await closedSpec.text());
  assert.equal((await detail(h, created.id)).tracker.specs[0]!.state, "closed");
  // 开或关之外的状态一律打回。
  assert.equal(
    (await h.api("PUT", `/products/${created.id}/specs/${specId}`, { state: "done" })).status,
    400,
  );

  const commented = await h.api("POST", `/products/${created.id}/tickets/${ticketId}/comments`, {
    text: "  财务说只有草稿态能撤回。  ",
  });
  assert.equal(commented.status, 201, await commented.text());
  // 空评论不收。
  assert.equal(
    (await h.api("POST", `/products/${created.id}/tickets/${ticketId}/comments`, { text: "   " }))
      .status,
    400,
  );

  // 评论整段随 spec 全文读回来,作者是写下它的那个人。
  const read = await h.api("GET", `/products/${created.id}/specs/${specId}`);
  const spec = (await read.json()) as {
    tickets: { comments: { author: string | null; body: string }[] }[];
  };
  assert.deepEqual(spec.tickets[0]!.comments, [
    { ...spec.tickets[0]!.comments[0], author: PANEL_ADMIN_USERNAME, body: "财务说只有草稿态能撤回。" },
  ]);
});

test("正文与标题改不动:带着它们来的请求回 400,别的产品的票同形回 404", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const created = await product(h);
  const { specId, ticketIds } = await seedSpec(
    h,
    created.id,
    { title: "报销单可以撤回", body: "改不了。" },
    [{ title: "撤回接口", body: "PATCH /expenses/{id}" }],
  );
  const ticketId = ticketIds[0]!;

  for (const [path, payload] of [
    [`/products/${created.id}/tickets/${ticketId}`, { body: "我自己写的正文" }],
    [`/products/${created.id}/tickets/${ticketId}`, { title: "我自己改的标题" }],
    [`/products/${created.id}/specs/${specId}`, { state: "closed", body: "换一份 spec" }],
  ] as const) {
    const refused = await h.api("PUT", path, payload);
    const said = await refused.text();
    assert.equal(refused.status, 400, said);
    assert.deepEqual(JSON.parse(said), { error: "spec 与票的正文与标题只由会话写" });
  }
  const read = await h.api("GET", `/products/${created.id}/specs/${specId}`);
  const spec = (await read.json()) as {
    spec: { body: string; state: string };
    tickets: { title: string; body: string }[];
  };
  assert.equal(spec.spec.body, "改不了。");
  assert.equal(spec.spec.state, "open");
  assert.equal(spec.tickets[0]!.title, "撤回接口");
  assert.equal(spec.tickets[0]!.body, "PATCH /expenses/{id}");

  // 别的产品下的同一个票号与根本没有这一张说同一句话。
  const other = await h.api("POST", "/products", { name: "结算系统" });
  const otherId = ((await other.json()) as { product: Product }).product.id;
  for (const [method, path, payload] of [
    ["PUT", `/products/${otherId}/tickets/${ticketId}`, { claimed: true }],
    ["POST", `/products/${otherId}/tickets/${ticketId}/comments`, { text: "越界" }],
  ] as const) {
    const hidden = await h.api(method, path, payload);
    assert.equal(hidden.status, 404, path);
    assert.deepEqual(await hidden.json(), { error: "没有这张票" });
  }
  const hiddenSpec = await h.api("PUT", `/products/${otherId}/specs/${specId}`, {
    state: "closed",
  });
  assert.equal(hiddenSpec.status, 404);
  assert.deepEqual(await hiddenSpec.json(), { error: "没有这条 spec" });
});
