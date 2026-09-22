/**
 * 异步门面与回调式事务(issue #459,spec #445 的扩张那一步)。断的是三件事:同名异步
 * 方法与同步版本给出同一个值、中途回滚那一档把写进去的东西退回去、异步回调交到
 * `startRuleTrace` 手里时整条链路跟着变成 Promise。
 *
 * 其余各处的事务行为由既有用例守着:它们跑的是同一批方法,这一票只换了事务的写法。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { startRuleTrace } from "../src/review/trace.ts";
import { asyncStore, openStore, type Store } from "../src/review/store.ts";
import { makeDbPath, testCleanups } from "./support/git-fixture.ts";

const cleanups = testCleanups();

function store(): Store {
  const db = makeDbPath();
  cleanups.push(() => db.cleanup());
  const opened = openStore(db.path);
  cleanups.push(() => opened.close());
  return opened;
}

test("异步门面的方法同名同参,返回值与同步版本一样", async () => {
  const sync = store();
  const async = asyncStore(sync);
  sync.createPanelRole({ name: "评审", permissions: ["review:rerun"], createdAt: "2026-09-22T00:00:00.000Z" });

  const roles = await async.listPanelRoles();
  assert.deepEqual(roles, sync.listPanelRoles());
  assert.equal(await async.countPanelUsers(), 0);
});

test("同步方法抛的错在异步门面上变成 reject", async () => {
  const async = asyncStore(store());
  await assert.rejects(() => async.getReviewRunSnapshot(404), /不在注册表里/);
});

test("中途回滚把这一笔写进去的东西退回去,返回值仍是调用方给的那一个", () => {
  const opened = store();
  const created = "2026-09-22T00:00:00.000Z";
  assert.equal(
    opened.registerFirstPanelUser({
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
    opened.registerFirstPanelUser({
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
  assert.equal(opened.countPanelUsers(), 1);
  assert.equal(opened.getPanelUser("second"), undefined);
});

test("startRuleTrace 收到异步的 withStore 时整条链路返回 Promise", async () => {
  const opened = store();
  opened.registerRepo({ repoId: 7, owner: "acme", repo: "widgets", generation: 1, key: "k" });
  const async = asyncStore(opened);
  const recorder = await startRuleTrace(
    (use) => use(async as unknown as Store),
    7,
    "baseline-exploration",
    { model: "test:m" },
  );
  assert.notEqual(recorder.taskId, null);
  await recorder.record("rule_proposed", { statement: "一句陈述" });
  recorder.end();

  const events = opened.listRuleTrace(recorder.taskId!);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["rule_agent_started", "rule_proposed"],
  );
});
