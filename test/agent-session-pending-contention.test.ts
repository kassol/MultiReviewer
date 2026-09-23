/**
 * 排队消息的「取出即删」在两个连接上同时发生时,每条只被取走一次(issue #401 在 PG 上的
 * 对应物)。
 *
 * 「读出来再删掉」两句之间隔着一次往返:不锁的话两个连接会各读到同一批消息、各自投递一遍,
 * 人写下的一句话于是被 agent 跑两遍。`takeAgentSessionPendingMessages` 因此在事务里先对会话
 * 那一行 `SELECT … FOR UPDATE`,后到的那一个排在提交之后读,看到的是空队列。
 *
 * 要两条**连接**同时跑才测得出:同一条连接上的两次调用本来就是排队的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore } from "../src/review/store/index.ts";
import { makeTestDatabase, testCleanups } from "./support/git-fixture.ts";

const AT = "2026-09-12T00:00:00.000Z";

const cleanups = testCleanups();

test("两个连接同时取走同一会话的排队消息时,每条只被取走一次", async () => {
  const db = await makeTestDatabase();
  cleanups.push(() => db.cleanup());
  const store = openStore(db.url);

  const role = await store.createPanelRole({
    name: "拆需求的人",
    permissions: ["agent:chat"],
    createdAt: AT,
  });
  await store.createPanelUser({
    username: "member",
    displayName: null,
    passwordHash: "unused",
    mustChangePassword: false,
    createdAt: AT,
    isSystemAdmin: false,
    roleId: role.id,
  });
  const product = await store.createProduct({ name: "报销系统", createdAt: AT });
  const session = await store.createAgentSession({
    productId: product.id,
    createdBy: "member",
    purpose: "requirement-breakdown",
    createdAt: AT,
  });

  const queued = [
    { mode: "followUp", text: "排着的第一句" },
    { mode: "steer", text: "排着的第二句" },
  ];

  for (let round = 0; round < 50; round += 1) {
    await store.putAgentSessionPendingMessages(session.id, queued);
    // 同一个 store 的两次调用各自从连接池里取一条连接:真的两个连接在抢。
    const [left, right] = await Promise.all([
      store.takeAgentSessionPendingMessages(session.id),
      store.takeAgentSessionPendingMessages(session.id),
    ]);
    // 取走的合起来恰好是排着的那两条:一条都不少(谁都没丢),一条都不多(没人投两遍)。
    assert.deepEqual([...left, ...right], queued);
    // 取完队列是空的。
    assert.deepEqual(await store.listAgentSessionPendingMessages(session.id), []);
  }
});
