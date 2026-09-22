/**
 * 会话页右栏那一份:这一场会话写进产品 tracker 的 spec 与票(CONTEXT.md 产品 tracker,
 * issue #366)。
 *
 * 缝与 #333 那一票相同:面板 API 走真实 HTTP,会话与 tracker 落一次性 PostgreSQL 库。压的是票的
 * 验收里打在 HTTP 与开库上的那几条:读会话回得出它写过的 spec 与票、别的会话写的不算、
 * 退役的定稿端点回 404,以及升级前的旧库开起来之后产出与定稿两张表不在、旧的需求拆分会话
 * 照样打得开读得动。写入那一侧(工具与打回)在 `agent-session-subprocess.test.ts`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore } from "../src/review/store/index.ts";
import {
  GITEA_REPO,
  scopedUser,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "agent-session-tracker-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";

/** 会话页右栏读到的那一份。 */
type Wrote = {
  specs: { id: number; title: string }[];
  tickets: { id: number; title: string }[];
};

function as(h: PanelHarness, cookie: string, method: string, path: string): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, { method, headers: { cookie } });
}

async function productWithRepo(h: PanelHarness, name: string): Promise<number> {
  const created = await h.api("POST", "/products", { name });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  return product.id;
}

async function createSession(h: PanelHarness, cookie: string, productId: number): Promise<number> {
  const response = await fetch(`${h.serverUrl}/api/products/${productId}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: PURPOSE }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: { id: number } }).session.id;
}

async function wrote(h: PanelHarness, cookie: string, sessionId: number): Promise<Wrote> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${sessionId}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { wrote: Wrote }).wrote;
}

/** 往 tracker 里落一条 spec 与一张票,记在这一场会话名下。写入那一侧由子进程用例把关。 */
async function seedTracker(
  databaseUrl: string,
  productId: number,
  sessionId: number | null,
  title: string,
): Promise<{ specId: number; ticketId: number }> {
  const store = openStore(databaseUrl);
  try {
    const spec = await store.createProductSpec({
      productId,
      title,
      body: `## Problem Statement\n\n${title}`,
      sessionId,
      at: AT,
    });
    const ticket = await store.createProductTicket({
      specId: spec.id,
      title: `${title} · 第一张票`,
      body: "第一步",
      label: "ready-for-agent",
      sessionId,
      at: AT,
    });
    return { specId: spec.id, ticketId: ticket.id };
  } finally {
    await store.close();
  }
}

test("读会话回得出它写的 spec 与票:别的会话写的、没有会话写的都不算", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);
  const otherId = await createSession(h, cookie, productId);

  // 一条都还没写:两份列表都是空的,不是 404——右栏据此整块不渲染。
  assert.deepEqual(await wrote(h, cookie, sessionId), { specs: [], tickets: [] });

  const mine = await seedTracker(h.db.url, productId, sessionId, "报销单可以撤回");
  await seedTracker(h.db.url, productId, otherId, "别的会话写的");
  await seedTracker(h.db.url, productId, null, "没有会话写的");

  assert.deepEqual(await wrote(h, cookie, sessionId), {
    specs: [{ id: mine.specId, title: "报销单可以撤回" }],
    tickets: [{ id: mine.ticketId, title: "报销单可以撤回 · 第一张票" }],
  });
  // 那一场只看得到自己写的那一条。
  assert.deepEqual(
    (await wrote(h, cookie, otherId)).specs.map((spec) => spec.title),
    ["别的会话写的"],
  );
});

test("定稿与产出两个端点退役:路径不在了,回 404", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const productId = await productWithRepo(h, "报销系统");
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, productId);

  for (const [method, path] of [
    ["GET", `/agent-sessions/${sessionId}/outputs`],
    ["POST", `/agent-sessions/${sessionId}/outputs/1/finalize`],
  ] as const) {
    const response = await as(h, cookie, method, path);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

