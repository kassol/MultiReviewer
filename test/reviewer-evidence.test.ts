/**
 * 取证子代理的铺装内容与它的两道闸(issue #226,ADR 0021)。
 *
 * 断言的是铺进 agentDir 的那几个文件与两个环境变量——它们就是「子代理能做什么」的全部
 * 依据,pi-subagents 在派出之前读的正是这几处。会不会真的派、报告长什么样是模型契约,
 * 由 `reviewer-smoke.test.ts` 的 opt-in 用例守。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MODEL_API_KEY_ENV } from "../src/reviewer/env.ts";
import {
  EVIDENCE_AGENT,
  EVIDENCE_FANOUT_BUDGET,
  EVIDENCE_SESSION_BUDGET,
  encodeEvidenceCeiling,
  evidenceAgentDefinition,
  evidenceCeiling,
  evidenceTranscriptEvents,
  installEvidenceKit,
  vendoredSubagentsPath,
} from "../src/reviewer/evidence.ts";
import type { RuntimeModel } from "../src/reviewer/model-service-runtime.ts";
import { SYSTEM_PROMPT } from "../src/reviewer/worker.ts";

const MODEL: RuntimeModel = {
  provider: "openrouter",
  id: "z-ai/glm-5.2",
  name: "GLM 5.2",
  api: "openai-completions",
  baseUrl: "https://openrouter.example/api/v1",
  input: ["text"],
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 32_000,
  thinkingLevelMap: { off: null, high: "high" },
  compat: { forceAdaptiveThinking: true },
  sources: {
    name: "trusted",
    api: "service-target",
    baseUrl: "service-target",
    input: "trusted",
    reasoning: "trusted",
    contextWindow: "trusted",
    maxTokens: "trusted",
    thinkingLevelMap: "trusted",
    compat: "trusted",
  },
};

function install(overrides: Partial<Parameters<typeof installEvidenceKit>[0]> = {}): string {
  const agentDir = mkdtempSync(join(tmpdir(), "multireviewer-evidence-test-"));
  installEvidenceKit({
    agentDir,
    runtimeModel: MODEL,
    thinkingLevel: "high",
    rules: [],
    facts: [],
    ...overrides,
  });
  return agentDir;
}

function read(agentDir: string, ...parts: string[]): string {
  return readFileSync(join(agentDir, ...parts), "utf8");
}

test("铺装之后取证 agent 就位,内置 agent 全部禁用", () => {
  const agentDir = install();

  const settings = JSON.parse(read(agentDir, "settings.json")) as {
    subagents?: { disableBuiltins?: unknown };
  };
  assert.equal(settings.subagents?.disableBuiltins, true);

  const definition = read(agentDir, "agents", `${EVIDENCE_AGENT}.md`);
  assert.match(definition, new RegExp(`^name: ${EVIDENCE_AGENT}$`, "m"));
  // 内置 agent 的名字一个都不该被这份定义带回来。
  for (const builtin of ["scout", "worker", "researcher", "oracle", "reviewer", "delegate"]) {
    assert.doesNotMatch(definition, new RegExp(`^name: ${builtin}$`, "m"));
  }
});

test("取证 agent 只读四件套,拿不到取证工具本身与 report_finding", () => {
  const definition = read(install(), "agents", `${EVIDENCE_AGENT}.md`);
  assert.match(definition, /^tools: read, grep, find, ls$/m);
  assert.doesNotMatch(definition, /^tools:.*\bsubagent\b/m);
  assert.doesNotMatch(definition, /^tools:.*\breport_finding\b/m);
  assert.doesNotMatch(definition, /^tools:.*\b(bash|edit|write)\b/m);
  // 再派生的两条路都封死:工具面里没有取证工具,授权开关也是关的。
  assert.match(definition, /^allowNestedSubagents: false$/m);
});

test("取证 agent 与 Reviewer 同模型同凭据同思考档位", () => {
  const agentDir = install({ thinkingLevel: "xhigh" });

  const definition = read(agentDir, "agents", `${EVIDENCE_AGENT}.md`);
  assert.match(definition, /^model: inherit$/m);
  assert.match(definition, /^thinking: xhigh$/m);

  const catalog = JSON.parse(read(agentDir, "models.json")) as {
    providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: unknown[] }>;
  };
  const provider = catalog.providers[MODEL.provider];
  assert.ok(provider, "子进程要读得到本轮固定的那一个模型服务");
  assert.equal(provider.baseUrl, MODEL.baseUrl);
  assert.equal(provider.api, MODEL.api);
  // 凭据是环境变量引用,明文不落盘。
  assert.equal(provider.apiKey, `$${MODEL_API_KEY_ENV}`);
  assert.deepEqual(provider.models, [
    {
      id: MODEL.id,
      name: MODEL.name,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.maxTokens,
      thinkingLevelMap: MODEL.thinkingLevelMap,
      compat: MODEL.compat,
    },
  ]);
});

test("能力天花板写死在代码里,不从会话工具面透传", () => {
  // 白名单是常量:Reviewer 那一面多一个工具,子代理的工具面不该跟着长。
  assert.deepEqual(evidenceCeiling(), {
    version: 1,
    allowedTools: ["find", "grep", "ls", "read"],
    allowedAgents: [EVIDENCE_AGENT],
    denyExtensions: true,
    sources: ["multireviewer"],
  });

  const agentDir = install();
  const encoded = process.env["PI_SUBAGENT_CAPABILITY_CEILING_V1"];
  assert.equal(encoded, encodeEvidenceCeiling());
  const decoded = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
  assert.deepEqual(decoded, evidenceCeiling());
  // 工作副本是半可信输入:被审仓库自带的 agent 定义即使被读到,也不在放行名单里。
  assert.deepEqual(decoded.allowedAgents, [EVIDENCE_AGENT]);
  assert.ok(!decoded.allowedTools.includes("subagent"));
  assert.ok(!decoded.allowedTools.includes("report_finding"));
  assert.ok(agentDir);
});

test("取证受两道上限约束:一次会话 3 次,单次调用内 fan-out 8", () => {
  install();
  // 会话上限管的是这个 Reviewer 子进程一共派几次取证,即每批每模型的总量。
  assert.equal(EVIDENCE_SESSION_BUDGET, 3);
  assert.equal(process.env["PI_SUBAGENT_MAX_SPAWNS_PER_SESSION"], "3");
  // fan-out 上限管的是一次 subagent 调用内部展开几个子任务,每次调用重新计数。
  assert.equal(EVIDENCE_FANOUT_BUDGET, 8);
  assert.equal(process.env["PI_SUBAGENT_MAX_SPAWNS_PER_RUN"], "8");
});

test("系统提示写明取证名额有限", () => {
  assert.match(SYSTEM_PROMPT, /Evidence calls are limited/);
});

test("取证子会话收到与 Reviewer 同一份知识注入", () => {
  const rules = [{ id: 7, scope: "src/api/**", statement: "处理器必须在边界校验请求体" }];
  const facts = [{ id: 9, scope: "", statement: "全局拦截器覆盖全部 /api 路由" }];
  const definition = read(install({ rules, facts }), "agents", `${EVIDENCE_AGENT}.md`);

  // 行格式与 Reviewer 那一份逐字相同:规则带标识,事实不带。
  assert.ok(definition.includes("- [7] (src/api/**) 处理器必须在边界校验请求体"));
  assert.ok(definition.includes("- (whole repository) 全局拦截器覆盖全部 /api 路由"));

  // 空知识集不渲染任何一段。
  const empty = read(install(), "agents", `${EVIDENCE_AGENT}.md`);
  assert.doesNotMatch(empty, /review rules/);
  assert.doesNotMatch(empty, /project facts/);
});

test("取证 agent 不产 Finding,只交带 file:line 的证据", () => {
  const definition = evidenceAgentDefinition({ thinkingLevel: "off", rules: [], facts: [] });
  assert.match(definition, /file:line|file and the line/);
  assert.match(definition, /do not decide|does not decide|not judge/);
});

test("vendor 的 pi-subagents 在镜像里解析得到", () => {
  const root = vendoredSubagentsPath();
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    pi?: { extensions?: unknown };
  };
  assert.equal(manifest.name, "pi-subagents");
  // 它是一个 pi 包,整个目录交给资源加载器即可发现其中的扩展。
  assert.ok(manifest.pi?.extensions);
});

/**
 * 一份子会话 transcript(issue #227)。行的形状照 pi-subagents 写下来的那一份:每条消息
 * 与每次工具调用各占一行,工具返回的正文由排在 `tool_end` **之后**的 `toolResult` 消息带。
 */
function transcript(lines: readonly Record<string, unknown>[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

function writeTranscript(lines: readonly Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-transcript-test-"));
  const path = join(dir, "evidence_0_transcript.jsonl");
  writeFileSync(path, `${transcript(lines)}\n`);
  return path;
}

/** 一次取证调用的工具返回,只保留读取用得到的那一格。 */
function toolResult(...transcriptPaths: string[]): unknown {
  return {
    content: [{ type: "text", text: "证据已带回" }],
    details: { results: transcriptPaths.map((path) => ({ transcriptPath: path })) },
  };
}

test("子会话的话与工具调用转成与外层同形的事件", () => {
  const path = writeTranscript([
    { version: 1, recordType: "message", sourceEventType: "initial_prompt", role: "user", text: "谁调用 findOrdersByCustomer", ts: 100 },
    { version: 1, recordType: "message", sourceEventType: "message_end", role: "assistant", text: "先 grep 一遍调用方", ts: 110 },
    { version: 1, recordType: "tool_start", sourceEventType: "tool_execution_start", toolCallId: "k1", toolName: "grep", argsPayload: JSON.stringify({ pattern: "findOrdersByCustomer" }), ts: 120 },
    { version: 1, recordType: "tool_end", sourceEventType: "tool_execution_end", toolCallId: "k1", toolName: "grep", isError: false, ts: 155 },
    { version: 1, recordType: "message", sourceEventType: "tool_result_end", role: "toolResult", toolCallId: "k1", toolName: "grep", isError: false, text: "src/orders-api.js:8", ts: 156 },
    { version: 1, recordType: "message", sourceEventType: "message_end", role: "assistant", text: "src/orders-api.js:8 直接把 req.query.customerId 交了过去", ts: 200 },
  ]);

  assert.deepEqual(evidenceTranscriptEvents(toolResult(path)), [
    { kind: "assistant_message", text: "先 grep 一遍调用方" },
    {
      kind: "tool_call",
      tool: "grep",
      args: { pattern: "findOrdersByCustomer" },
      durationMs: 35,
      isError: false,
      error: null,
      // 工具返回的正文照旧不进轨迹,只记长度(ADR 0017)。
      resultLength: "src/orders-api.js:8".length,
    },
    { kind: "assistant_message", text: "src/orders-api.js:8 直接把 req.query.customerId 交了过去" },
  ]);
});

test("子会话里被拒的调用带上原因", () => {
  const path = writeTranscript([
    { version: 1, recordType: "tool_start", sourceEventType: "tool_execution_start", toolCallId: "k1", toolName: "read", argsPayload: JSON.stringify({ path: "/etc/passwd" }), ts: 10 },
    { version: 1, recordType: "tool_end", sourceEventType: "tool_execution_end", toolCallId: "k1", toolName: "read", isError: true, ts: 12 },
    { version: 1, recordType: "message", sourceEventType: "tool_result_end", role: "toolResult", toolCallId: "k1", isError: true, text: "cannot read outside the repository", ts: 13 },
  ]);

  const [call] = evidenceTranscriptEvents(toolResult(path));
  assert.ok(call?.kind === "tool_call");
  if (call?.kind !== "tool_call") return;
  assert.equal(call.isError, true);
  assert.equal(call.error, "cannot read outside the repository");
});

test("transcript 读不到或形状认不出时回空,取证本身照常", () => {
  assert.deepEqual(evidenceTranscriptEvents(toolResult("/nowhere/does-not-exist.jsonl")), []);
  assert.deepEqual(evidenceTranscriptEvents({ content: [], details: {} }), []);
  assert.deepEqual(evidenceTranscriptEvents(null), []);
  // 半行坏 JSON 只丢那一行,其余照转。
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-transcript-test-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(
    path,
    `{"recordType":"message","role":"assistant","text":"读到一半就断了"}\n{"recordType":\n`,
  );
  assert.deepEqual(evidenceTranscriptEvents(toolResult(path)), [
    { kind: "assistant_message", text: "读到一半就断了" },
  ]);
});

test("铺装写下 asyncByDefault=false,agent 定义带 async:false——取证默认前台", () => {
  const agentDir = install();
  const config = JSON.parse(
    readFileSync(join(agentDir, "extensions", "subagent", "config.json"), "utf8"),
  );
  assert.equal(config.asyncByDefault, false);
  const definition = readFileSync(join(agentDir, "agents", `${EVIDENCE_AGENT}.md`), "utf8");
  assert.match(definition, /^async: false$/m);
});
