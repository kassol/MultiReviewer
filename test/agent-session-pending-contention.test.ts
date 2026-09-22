/**
 * 排队消息的「取出即删」在别的连接正写库时不能当场报 `database is locked`(issue #401)。
 *
 * 延迟 `BEGIN` 先读后写:读拿了共享锁,轮到删要升级成写锁,而另一个连接正等着提交——SQLite
 * 认出这是死锁,不走 busy timeout 直接报忙。真实场景是排空那条用例:测试进程取排队消息的那
 * 一刻,`main.ts` 进程还在往同一个库里写会话记录。
 *
 * 只有另一个**进程**在写才测得出:同进程的同步调用插不进读与删之间。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";

const AT = "2026-09-12T00:00:00.000Z";

/** 不停地开写事务、提交,每次之间让出 1 毫秒:像一个正在落会话记录的服务进程。 */
const WRITER = `
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const upsert = db.prepare(
    "INSERT INTO global_setting (key, value) VALUES ('contention', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (let i = 0; ; i += 1) {
    db.exec("BEGIN IMMEDIATE");
    upsert.run(String(i));
    db.exec("COMMIT");
    Atomics.wait(pause, 0, 0, 1);
  }
`;

test("另一个进程不停写库时,排队消息的放与取都不报 database is locked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-pending-contention-"));
  const dbPath = join(dir, "multireviewer.db");
  const store = openStore(dbPath);
  const role = await store.createPanelRole({ name: "拆需求的人", permissions: ["agent:chat"], createdAt: AT });
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

  const writer = spawn(process.execPath, ["-e", WRITER, dbPath], { stdio: "ignore" });
  try {
    // 写进程连上库、开始写。
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 修复前每 3000 轮里稳定出 1–4 次。
    for (let round = 0; round < 3000; round += 1) {
      await store.putAgentSessionPendingMessages(session.id, [{ mode: "followUp", text: "排着的那一句" }]);
      assert.deepEqual(await store.takeAgentSessionPendingMessages(session.id), [
        { mode: "followUp", text: "排着的那一句" },
      ]);
    }
  } finally {
    writer.kill("SIGKILL");
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
