/**
 * 取证子代理的铺装内容与它的两道闸(issue #226,ADR 0021)。
 *
 * 断言的是铺进 agentDir 的那几个文件与两个环境变量——它们就是「子代理能做什么」的全部
 * 依据,pi-subagents 在派出之前读的正是这几处。会不会真的派、报告长什么样是模型契约,
 * 由 `reviewer-smoke.test.ts` 的 opt-in 用例守。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MODEL_API_KEY_ENV } from "../src/reviewer/env.ts";
import {
  EVIDENCE_AGENT,
  EVIDENCE_SPAWN_BUDGET,
  encodeEvidenceCeiling,
  evidenceAgentDefinition,
  evidenceCeiling,
  installEvidenceKit,
  vendoredSubagentsPath,
} from "../src/reviewer/evidence.ts";
import type { RuntimeModel } from "../src/reviewer/model-service-runtime.ts";

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

test("单轮取证次数受预算 8 约束", () => {
  install();
  assert.equal(EVIDENCE_SPAWN_BUDGET, 8);
  assert.equal(process.env["PI_SUBAGENT_MAX_SPAWNS_PER_RUN"], "8");
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
