/**
 * 异步 Store 与回调式事务(spec #445)。断的是三件事:方法一律返回 Promise、中途回滚
 * 那一档把写进去的东西退回去、`startRuleTrace` 与 tracker 两条跨模块的路都跑得通。
 *
 * 其余各处的事务行为由既有用例守着:它们跑的是同一批方法,这一票只换了事务的写法。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { startRuleTrace } from "../src/review/trace.ts";
import { openStore, type Store } from "../src/review/store.ts";
import { runTrackerRequest } from "../src/webhook/product-tracker.ts";
import { makeDbPath, testCleanups } from "./support/git-fixture.ts";

const cleanups = testCleanups();
const AT = "2026-09-22T00:00:00.000Z";

function store(): Store {
  const db = makeDbPath();
  cleanups.push(() => db.cleanup());
  const opened = openStore(db.path);
  cleanups.push(() => opened.close());
  return opened;
}

test("每个方法返回 Promise,等出来的是它那一份记录", async () => {
  const opened = store();
  await opened.createPanelRole({ name: "评审", permissions: ["review:rerun"], createdAt: "2026-09-22T00:00:00.000Z" });

  const roles = opened.listPanelRoles();
  assert.ok(roles instanceof Promise, "listPanelRoles 该给回一个 Promise");
  assert.deepEqual(await roles, await opened.listPanelRoles());
  assert.equal(await opened.countPanelUsers(), 0);
});

test("方法里抛的错变成 reject", async () => {
  const opened = store();
  await assert.rejects(() => opened.getReviewRunSnapshot(404), /不在注册表里/);
});

test("中途回滚把这一笔写进去的东西退回去,返回值仍是调用方给的那一个", async () => {
  const opened = store();
  const created = "2026-09-22T00:00:00.000Z";
  assert.equal(
    await opened.registerFirstPanelUser({
      username: "first",
      displayName: null,
      passwordHash: "h",
      mustChangePassword: false,
      createdAt: created,
      isSystemAdmin: true,
      roleId: null,
    }),
    true,
  );
  // 库里已经有人,这一次在事务中途回滚:返回 false,而且没有留下第二行。
  assert.equal(
    await opened.registerFirstPanelUser({
      username: "second",
      displayName: null,
      passwordHash: "h",
      mustChangePassword: false,
      createdAt: created,
      isSystemAdmin: true,
      roleId: null,
    }),
    false,
  );
  assert.equal(await opened.countPanelUsers(), 1);
  assert.equal(await opened.getPanelUser("second"), undefined);
});

test("tracker 的读写走同一段判定,返回 Promise", async () => {
  const opened = store();
  const product = await opened.createProduct({ name: "评审验证产品", createdAt: AT });

  // 一次写、一次读、一次先读后写:三种形状各走一遍。
  const created = await runTrackerRequest(
    opened,
    product.id,
    1,
    { kind: "create-spec", title: "一条 spec", body: "正文" },
    AT,
  );
  assert.match(created, /^recorded as spec \d+;/);
  const specId = Number(created.match(/spec (\d+)/)![1]);

  assert.match(
    await runTrackerRequest(opened, product.id, 1, { kind: "list" }, AT),
    /1 spec\(s\) and 0 ticket\(s\)/,
  );
  assert.equal(
    await runTrackerRequest(
      opened,
      product.id,
      1,
      { kind: "close", target: { kind: "spec", id: specId } },
      AT,
    ),
    `spec ${specId} is closed`,
  );
  // 打回那一路同样走得通:别的产品的 spec 读作没有。
  assert.equal(
    await runTrackerRequest(
      opened,
      product.id + 1,
      1,
      { kind: "close", target: { kind: "spec", id: specId } },
      AT,
    ),
    `there is no spec ${specId} in this product's tracker; call tracker_list to see what is there`,
  );
  assert.equal((await opened.getProductSpec(specId))?.state, "closed");
});

test("startRuleTrace 的 withStore 是异步的,整条链路跟着返回 Promise", async () => {
  const opened = store();
  await opened.registerRepo({ repoId: 7, owner: "acme", repo: "widgets", generation: 1, key: "k" });
  const recorder = await startRuleTrace(
    (use) => use(opened),
    7,
    "baseline-exploration",
    { model: "test:m" },
  );
  assert.notEqual(recorder.taskId, null);
  await recorder.record("rule_proposed", { statement: "一句陈述" });
  recorder.end();

  const events = await opened.listRuleTrace(recorder.taskId!);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["rule_agent_started", "rule_proposed"],
  );
});
