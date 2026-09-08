/**
 * fileLines 的圈内判定。它是 read 工具与锚定校验共用的唯一读文件入口,符号链接出圈
 * 就是任意文件读,必须按 realpath 之后的真实位置钉死。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fileLines, streamHeartbeat } from "../src/reviewer/worker-tools.ts";

const base = mkdtempSync(join(tmpdir(), "multireviewer-worker-tools-"));
const worktree = join(base, "worktree");
mkdirSync(worktree);
writeFileSync(join(base, "outside-secret.txt"), "secret\n");
writeFileSync(join(worktree, "a.ts"), "line one\nline two\n");
symlinkSync(join(base, "outside-secret.txt"), join(worktree, "evil-link"));
symlinkSync(join(worktree, "a.ts"), join(worktree, "inner-link"));

after(() => rmSync(base, { recursive: true, force: true }));

test("普通文件照常读出,行数组不带结尾幽灵行", () => {
  assert.deepEqual(fileLines(worktree, "a.ts"), ["line one", "line two"]);
});

test("指向圈外的符号链接被拒:词法在圈内,真实位置不在", () => {
  assert.equal(fileLines(worktree, "evil-link"), undefined);
});

test("圈内互指的符号链接照常读:realpath 判定不误伤合法链接", () => {
  assert.deepEqual(fileLines(worktree, "inner-link"), ["line one", "line two"]);
});

test("词法出圈与不存在的文件仍然是 undefined", () => {
  assert.equal(fileLines(worktree, "../outside-secret.txt"), undefined);
  assert.equal(fileLines(worktree, "missing.ts"), undefined);
});

/**
 * 心跳的节流。它是子进程在长思考期间唯一的活着证据,发得太密会把 IPC 灌满,发得太疏
 * 静默闸就合上了。
 */
test("流式 delta 触发心跳,同一时刻的多条只发一条", () => {
  const sent: { kind: "heartbeat" }[] = [];
  const heartbeat = streamHeartbeat((message) => sent.push(message), 30_000, () => 1_000);

  heartbeat({ type: "message_update" });
  heartbeat({ type: "message_update" });
  heartbeat({ type: "message_update" });

  // 第一条立即发:上一条真消息之后可能已经沉默了一会儿。
  assert.deepEqual(sent, [{ kind: "heartbeat" }]);
});

test("超过间隔之后再发一条", () => {
  const sent: { kind: "heartbeat" }[] = [];
  let clock = 1_000;
  const heartbeat = streamHeartbeat((message) => sent.push(message), 30_000, () => clock);

  heartbeat({ type: "message_update" });
  clock += 29_999;
  heartbeat({ type: "message_update" });
  assert.equal(sent.length, 1);

  clock += 1;
  heartbeat({ type: "message_update" });
  assert.equal(sent.length, 2);
});

test("message_update 以外的事件不发心跳", () => {
  const sent: { kind: "heartbeat" }[] = [];
  const heartbeat = streamHeartbeat((message) => sent.push(message), 30_000, () => 1_000);

  heartbeat({ type: "message_end" });
  heartbeat({ type: "tool_execution_start" });
  heartbeat({ type: "tool_execution_end" });

  assert.deepEqual(sent, []);
});
