/**
 * 会话 skill 的铺装与替代说明(CONTEXT.md 会话 skill,issue #364)。
 *
 * 桩测三件在子进程里看不清的事:一个用途的 agentDir `skills/` 下恰好是它那几个 skill、
 * 拷过去的 `SKILL.md` 不带 `disable-model-invocation`(Pi 认这一格,留着就整条从系统提示里
 * 摘掉),以及 `read` 够得着铺进去的正文。提示里那一段替代说明同样在这里钉——它进没进模型
 * 请求由 `agent-session-subprocess.test.ts` 那条真实链路管。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PRODUCT_TICKET_LABELS } from "../src/review/store.ts";
import { purposeSystemPrompt } from "../src/reviewer/session-purposes.ts";
import {
  installSessionSkills,
  sessionSkillNames,
  sessionSkillsDir,
  vendoredSkillsPath,
} from "../src/reviewer/session-skills.ts";
import { sessionReadOnlyTools } from "../src/reviewer/worker-tools.ts";
import { testCleanups } from "./support/git-fixture.ts";

const cleanups = testCleanups();

/** 一个空的 agentDir,跑完删掉。 */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-session-skills-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("每个用途的 agentDir skills/ 下恰好是它那几个 skill", () => {
  const expected: Record<string, string[]> = {
    "product-survey": ["domain-modeling", "grilling"],
    "requirement-breakdown": ["domain-modeling", "grilling", "to-spec", "to-tickets"],
    "open-conversation": ["ask-matt", "domain-modeling", "grilling", "to-spec", "to-tickets"],
  };
  for (const [purpose, names] of Object.entries(expected)) {
    const dir = agentDir();
    installSessionSkills(dir, purpose);
    assert.deepEqual(readdirSync(sessionSkillsDir(dir)).sort(), names, purpose);
    for (const name of names) {
      // 目录整个拷过去:domain-modeling 的两份格式文件是 skill 正文里的相对链接。
      assert.ok(
        readdirSync(join(sessionSkillsDir(dir), name)).includes("SKILL.md"),
        `${purpose} 的 ${name} 没有 SKILL.md`,
      );
    }
  }
});

test("domain-modeling 连它引用的两份格式文件一起铺", () => {
  const dir = agentDir();
  installSessionSkills(dir, "product-survey");
  assert.deepEqual(readdirSync(join(sessionSkillsDir(dir), "domain-modeling")).sort(), [
    "ADR-FORMAT.md",
    "CONTEXT-FORMAT.md",
    "SKILL.md",
  ]);
});

test("认不出的用途一个 skill 都不铺,目录仍建出来", () => {
  const dir = agentDir();
  assert.deepEqual(installSessionSkills(dir, "code-writing"), []);
  assert.deepEqual(readdirSync(sessionSkillsDir(dir)), []);
});

test("铺过去的 SKILL.md 摘掉 disable-model-invocation:留着它 Pi 就不把 skill 交给模型", () => {
  // vendor 的那一份是作者的原样副本,那一行还在;改写只发生在拷进 agentDir 那一步。
  const vendored = readFileSync(join(vendoredSkillsPath(), "to-spec", "SKILL.md"), "utf8");
  assert.match(vendored, /^disable-model-invocation: true$/m);

  const dir = agentDir();
  installSessionSkills(dir, "open-conversation");
  for (const name of sessionSkillNames("open-conversation")) {
    const laid = readFileSync(join(sessionSkillsDir(dir), name, "SKILL.md"), "utf8");
    assert.doesNotMatch(laid, /^disable-model-invocation:/m, name);
    // 摘的只有那一行:名字与描述照旧,Pi 靠它们生成 `<available_skills>`。
    assert.match(laid, new RegExp(`^name: ${name}$`, "m"), name);
    assert.match(laid, /^description: /m, name);
  }
});

test("read 够得着铺进 agentDir 的 skill 正文,搜与列目录仍只认会话根", async () => {
  const dir = agentDir();
  installSessionSkills(dir, "product-survey");
  const root = agentDir();
  const skillFile = join(sessionSkillsDir(dir), "grilling", "SKILL.md");
  const tools = sessionReadOnlyTools(root, [sessionSkillsDir(dir)]);
  const call = (name: string, params: unknown) =>
    tools
      .find((definition) => definition.name === name)!
      .execute("call-1", params as never, undefined, undefined, undefined as never) as Promise<{
      content: { text?: string }[];
    }>;

  const read = await call("read", { path: skillFile });
  assert.match(read.content[0]!.text!, /^1: ---$/m);
  // 放宽的只有 read:ls 仍按会话根判,skill 目录对它在圈外。
  await assert.rejects(() => call("ls", { path: skillFile }), /cannot/);
});

test("铺了 skill 的三个用途都带替代说明,写文件与 gh 被指回工具", () => {
  for (const purpose of ["product-survey", "requirement-breakdown", "open-conversation"]) {
    const prompt = purposeSystemPrompt(purpose, [])!;
    assert.match(prompt, /^## The skills in this session$/m, purpose);
    // 三样替代物各说一次:产品知识、产品 tracker、固定的五个标签。
    assert.match(prompt, /write_knowledge/, purpose);
    assert.match(prompt, /tracker_create_spec/, purpose);
    assert.match(prompt, new RegExp(PRODUCT_TICKET_LABELS.join(", ")), purpose);
    assert.match(prompt, /ask_question_round/, purpose);
    assert.match(prompt, /gh/, purpose);
    assert.match(prompt, /\.scratch\//, purpose);
    assert.match(prompt, /\/compact/, purpose);
    // 这个用途铺了哪几个,提示里点名:模型据它判断手上有没有那条路。
    for (const name of sessionSkillNames(purpose)) {
      assert.match(prompt, new RegExp(name), `${purpose} 没点名 ${name}`);
    }
  }
  // 认不出的用途既没有自己那一段,也没有替代说明。
  assert.equal(purposeSystemPrompt("code-writing", []), undefined);
});
