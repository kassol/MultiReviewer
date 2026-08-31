/**
 * 受控 git 工具:参数闸门与只读执行。闸门是安全边界本身,每个封死的口子都要有一条
 * 测试钉住——白名单松一个 flag,只读保证就没了。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { rejectGitArgs, runGit, truncateOutput } from "../src/reviewer/git-tool.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 两个 commit 的仓库:第二个删掉一行守卫、删掉一个文件。删除可见性是这个工具的存在理由。 */
const repo = mkdtempSync(join(tmpdir(), "multireviewer-git-tool-"));
git(repo, "init", "-q");
git(repo, "config", "user.email", "t@example.com");
git(repo, "config", "user.name", "t");
writeFileSync(join(repo, "a.ts"), "function f(x) {\n  if (x == null) return 0;\n  return x + 1;\n}\n");
writeFileSync(join(repo, "doomed.ts"), "export const gone = 1;\n");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "base");
const baseSha = git(repo, "rev-parse", "HEAD");
writeFileSync(join(repo, "a.ts"), "function f(x) {\n  return x + 1;\n}\n");
rmSync(join(repo, "doomed.ts"));
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "head");
const headSha = git(repo, "rev-parse", "HEAD");

after(() => rmSync(repo, { recursive: true, force: true }));

test("diff 让模型看到被删的行与被删的文件", async () => {
  const out = await runGit(repo, ["diff", `${baseSha}..${headSha}`]);
  assert.match(out, /^-\s+if \(x == null\) return 0;/m);
  assert.match(out, /^-export const gone = 1;/m);
});

test("show <sha>:<path> 读得到旧版本与已删除的文件", async () => {
  const out = await runGit(repo, ["show", `${baseSha}:doomed.ts`]);
  assert.equal(out, "export const gone = 1;\n");
});

test("log 与 blame 走通", async () => {
  assert.match(await runGit(repo, ["log", "--oneline", `${baseSha}..${headSha}`]), /head/);
  assert.match(await runGit(repo, ["blame", "-L1,2", "HEAD", "--", "a.ts"]), /function f/);
});

test("git 自身的失败带 stderr 抛出", async () => {
  await assert.rejects(runGit(repo, ["show", "deadbeef".repeat(5)]), /bad object|missing/);
});

test("网络与写子命令被拒", () => {
  assert.match(rejectGitArgs(["fetch", "origin"])!, /rejected/);
  assert.match(rejectGitArgs(["push"])!, /rejected/);
  assert.match(rejectGitArgs(["checkout", "main"])!, /rejected/);
  assert.match(rejectGitArgs([])!, /rejected/);
});

test("写文件、读圈外、执行外部命令的 flag 一律默认拒绝", () => {
  for (const flag of ["--no-index", "--output=/tmp/x", "--ext-diff", "--textconv", "-c", "-O/etc/passwd", "--contents"]) {
    assert.match(rejectGitArgs(["diff", flag])!, /rejected/, flag);
  }
});

test("圈外路径与非 SHA 引用被拒", () => {
  assert.match(rejectGitArgs(["diff", "/etc/passwd"])!, /rejected/);
  assert.match(rejectGitArgs(["diff", "../outside.ts"])!, /rejected/);
  assert.match(rejectGitArgs(["show", `${baseSha}:../outside.ts`])!, /rejected/);
  assert.match(rejectGitArgs(["log", "-L1,5:/etc/passwd"])!, /rejected/);
});

test("常规审查调用全部放行", () => {
  assert.equal(rejectGitArgs(["diff", `${baseSha}..${headSha}`, "--stat"]), undefined);
  assert.equal(rejectGitArgs(["diff", "-U0", `${baseSha}..${headSha}`, "--", "src/a.ts"]), undefined);
  assert.equal(rejectGitArgs(["show", `${baseSha}:doomed.ts`]), undefined);
  assert.equal(rejectGitArgs(["log", "--oneline", "-n20", `${baseSha}..${headSha}`]), undefined);
  assert.equal(rejectGitArgs(["blame", "-L10,40", "HEAD", "--", "a.ts"]), undefined);
  assert.equal(rejectGitArgs(["log", "-Sneedle", "--", "a.ts"]), undefined);
});

test("超限输出截断并留续查提示", () => {
  const big = "x".repeat(150_000);
  assert.match(truncateOutput(big), /output truncated at 100000 characters/);
  assert.equal(truncateOutput("small"), "small");
});
