/**
 * Agent 会话的工具面(issue #333):四个只读工具圈在会话根上,受控 git 按路径前缀选工作树。
 *
 * 打在工具函数的 `execute` 上,不起子进程(先例:`reviewer-contract.test.ts` 的契约用例)——
 * 「出根被拒」与「前缀选仓库」是这几个函数自己的判定,起一个 Pi 会话验不出更多东西。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { repoPrefixedGitArgs, sessionGitTool } from "../src/reviewer/git-tool.ts";
import { outsideSessionRoot, sessionReadOnlyTools } from "../src/reviewer/session-worker.ts";
import { makeRepo, testCleanups } from "./support/git-fixture.ts";

const cleanups = testCleanups();

/** 一个会话根:下面两棵「工作树」,外面一个会话读不到的文件。 */
function sessionRoot(): { root: string; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-session-tools-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const repo of ["acme/widgets", "acme/gadgets"]) {
    const path = join(dir, repo);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "answer.ts"), "export const answer = 1;\n");
  }
  const outside = join(dir, "..", "outside.txt");
  writeFileSync(outside, "secret\n");
  return { root: dir, outside };
}

/** 按工具名取那一个定义。四个只读工具在同一份清单里。 */
function tool(root: string, name: string) {
  const found = sessionReadOnlyTools(root).find((definition) => definition.name === name);
  assert.notEqual(found, undefined, `没有注册 ${name}`);
  return found!;
}

/** 跑一次工具调用。只读工具不用 signal / onUpdate / 扩展上下文。 */
function call(
  definition: ReturnType<typeof tool>,
  params: unknown,
): Promise<{ content: { type: string; text?: string }[] }> {
  return definition.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    undefined as never,
  ) as Promise<{ content: { type: string; text?: string }[] }>;
}

test("四个只读工具都圈在会话根上:绝对路径出根与 .. 出根一律拒", async () => {
  const { root, outside } = sessionRoot();
  // read 的措辞与 Reviewer 那侧同源(`numberedReadTool`),其余三个是圈过根的内建。
  for (const name of ["read", "grep", "find", "ls"]) {
    const definition = tool(root, name);
    for (const path of [outside, "../outside.txt", "acme/../../outside.txt", "/etc/hosts"]) {
      await assert.rejects(
        () => call(definition, { path, pattern: "answer" }),
        /cannot/,
        `${name} 放过了 ${path}`,
      );
    }
  }
});

test("会话根里的符号链接指到圈外也被拒:判的是 realpath,不是词法路径", async () => {
  const { root, outside } = sessionRoot();
  symlinkSync(outside, join(root, "acme", "widgets", "leak.txt"));
  await assert.rejects(
    () => call(tool(root, "ls"), { path: "acme/widgets/leak.txt" }),
    /cannot/,
  );
  assert.equal(outsideSessionRoot(root, "acme/widgets/leak.txt"), true);
  // 不存在的路径不算出根:那是「路径写错了」,由工具自己去说。
  assert.equal(outsideSessionRoot(root, "acme/widgets/missing.ts"), false);
  assert.equal(outsideSessionRoot(root, "acme/widgets/answer.ts"), false);
});

test("圈内的路径照常读:带行号的 read 与会话根的 ls", async () => {
  const { root } = sessionRoot();
  const read = await call(tool(root, "read"), { path: "acme/widgets/answer.ts" });
  assert.match(read.content[0]!.text!, /^1: export const answer = 1;/);
  const ls = await call(tool(root, "ls"), { path: "acme" });
  assert.match(ls.content[0]!.text!, /widgets/);
});

test("受控 git 的路径参数必须带仓库前缀,前缀不在会话根里即拒", () => {
  const repos = ["acme/widgets", "acme/gadgets"];
  // 无前缀:选不出工作树。
  for (const args of [
    ["log", "--oneline", "-5"],
    ["diff", "HEAD", "--", "answer.ts"],
    ["show", "HEAD:answer.ts"],
  ]) {
    const picked = repoPrefixedGitArgs(args, repos);
    assert.ok("rejection" in picked, JSON.stringify(args));
  }
  // 产品外的仓库:前缀认不出来。
  const outside = repoPrefixedGitArgs(["diff", "HEAD", "--", "other/repo/answer.ts"], repos);
  assert.ok("rejection" in outside);
  assert.match(outside.rejection, /other\/repo is not a repository in this session/);
  // 一次调用一个仓库。
  const two = repoPrefixedGitArgs(
    ["diff", "HEAD", "--", "acme/widgets/a.ts", "acme/gadgets/b.ts"],
    repos,
  );
  assert.ok("rejection" in two);
  assert.match(two.rejection, /one call reads one repository/);

  // 认得出来的三种写法:前缀选仓库,参数里的前缀摘掉。
  const plain = repoPrefixedGitArgs(["diff", "HEAD", "--", "acme/widgets/src/a.ts"], repos);
  assert.deepEqual(plain, { repo: "acme/widgets", args: ["diff", "HEAD", "--", "src/a.ts"] });
  const colon = repoPrefixedGitArgs(["show", "HEAD:acme/gadgets/src/a.ts"], repos);
  assert.deepEqual(colon, { repo: "acme/gadgets", args: ["show", "HEAD:src/a.ts"] });
  const blame = repoPrefixedGitArgs(
    ["blame", "-L10,40:acme/widgets/src/a.ts", "HEAD"],
    repos,
  );
  assert.deepEqual(blame, { repo: "acme/widgets", args: ["blame", "-L10,40:src/a.ts", "HEAD"] });
  // 仓库根本身也是路径:`<owner>/<repo>` 与带斜杠的写法都指整个仓库,摘掉前缀后是 `.`。
  assert.deepEqual(repoPrefixedGitArgs(["log", "--oneline", "-5", "--", "acme/widgets/"], repos), {
    repo: "acme/widgets",
    args: ["log", "--oneline", "-5", "--", "."],
  });
  assert.deepEqual(repoPrefixedGitArgs(["ls-tree", "HEAD", "acme/gadgets"], repos), {
    repo: "acme/gadgets",
    args: ["ls-tree", "HEAD", "."],
  });
  // 会话根下只有一个仓库时,没有路径参数的调用就落在它上面。
  assert.deepEqual(repoPrefixedGitArgs(["log", "--oneline", "-5"], ["acme/widgets"]), {
    repo: "acme/widgets",
    args: ["log", "--oneline", "-5"],
  });
});

test("受控 git 在选中的那棵工作树上执行,白名单那几道闸一道不少", async () => {
  const fixture = makeRepo({
    base: { "src/answer.ts": "export const answer = 1;\n" },
    head: { "src/answer.ts": "export const answer = 2;\n" },
  });
  cleanups.push(fixture.cleanup);
  // 会话根的形状:`<owner>/<repo>` 一棵树。这里直接用夹具仓库当那棵树。
  const root = mkdtempSync(join(tmpdir(), "multireviewer-session-git-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "acme"), { recursive: true });
  symlinkSync(fixture.dir, join(root, "acme", "widgets"));
  const definition = sessionGitTool(root, ["acme/widgets"]);

  const log = await call(definition as never, { args: ["log", "--oneline", "--", "acme/widgets/src"] });
  assert.match(log.content[0]!.text!, /\w{7}/);

  // 写子命令与白名单外的 flag 照旧打回,措辞与 Reviewer 那一份同源。
  const push = await call(definition as never, { args: ["push", "--", "acme/widgets/src"] });
  assert.match(push.content[0]!.text!, /first argument must be one of/);
  const output = await call(definition as never, {
    args: ["diff", "--output=/tmp/x", "--", "acme/widgets/src/answer.ts"],
  });
  assert.match(output.content[0]!.text!, /not in the allowed set/);
});
