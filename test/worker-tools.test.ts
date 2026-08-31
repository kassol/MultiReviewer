/**
 * fileLines 的圈内判定。它是 read 工具与锚定校验共用的唯一读文件入口,符号链接出圈
 * 就是任意文件读,必须按 realpath 之后的真实位置钉死。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fileLines } from "../src/reviewer/worker-tools.ts";

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
