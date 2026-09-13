/**
 * 会话系统提示里的产品名、仓库职责(CONTEXT.md 仓库职责,issue #341)与知识目录(issue #344)。
 *
 * 桩测这一份字符串:agent 选哪个仓库读、什么时候去查知识全凭这几行,职责没渲染上去它只能一个个
 * README 读过去,而整条真实链路(提示进模型请求)已经由 `agent-session-subprocess.test.ts` 钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OpenSessionRequest } from "../src/reviewer/session-protocol.ts";
import { sessionSystemPrompt } from "../src/reviewer/session-worker.ts";

const REQUEST: OpenSessionRequest = {
  sessionRoot: "/tmp/session-root",
  productName: "报销系统",
  purpose: "requirement-breakdown",
  productKnowledgeCount: 3,
  repos: [
    { owner: "acme", repo: "api", role: "后端 API(Node)", ruleCount: 4, factCount: 1 },
    { owner: "acme", repo: "web", role: null, ruleCount: 0, factCount: 0 },
  ],
  productKnowledge: [],
  // 提示这一份不读模型,这一格只为凑齐形状。
  runtimeModel: {
    provider: "stub",
    id: "stub-model",
    name: "Stub Model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_000,
    sources: {
      name: "trusted",
      api: "service-target",
      baseUrl: "service-target",
      input: "trusted",
      reasoning: "trusted",
      contextWindow: "trusted",
      maxTokens: "trusted",
    },
  },
};

test("系统提示写出产品名,有职责的仓库带破折号那一段,没有的只有仓库名", () => {
  const prompt = sessionSystemPrompt(REQUEST);

  assert.match(prompt, /^The product: 报销系统\.$/m);
  assert.match(prompt, /^- acme\/api — 后端 API\(Node\)$/m);
  assert.match(prompt, /^- acme\/web$/m);
  assert.match(
    prompt,
    /^The note after the dash says what that repository is for in this product; start from it to decide which repository to read\.$/m,
  );
});

test("没有一个仓库写过职责时,不写那句说破折号的话", () => {
  const prompt = sessionSystemPrompt({
    ...REQUEST,
    repos: REQUEST.repos.map((repo) => ({ ...repo, role: null })),
  });

  assert.match(prompt, /^- acme\/api$/m);
  assert.doesNotMatch(prompt, /The note after the dash/);
});

test("知识目录只有条数与那一句触发语,一条规则或事实的正文都不在提示里", () => {
  const prompt = sessionSystemPrompt(REQUEST);

  // 两层各有多少条:产品层一句,仓库层每个仓库一行。
  assert.match(prompt, /This product has 3 active product knowledge entries\./);
  assert.match(prompt, /^- acme\/api — 4 review rules, 1 project fact$/m);
  assert.match(prompt, /^- acme\/web — 0 review rules, 0 project facts$/m);
  // 什么时候去查,一句话。
  assert.match(
    prompt,
    /^When the task spans repositories or its scope is unclear, query the product layer first; otherwise query the repository and the paths the task touches\.$/m,
  );
  assert.match(prompt, /query_knowledge/);
  // 升级前按仓库分段注入的那几段不在了:提示里没有一条陈述,也没有那两段的标题。
  assert.doesNotMatch(prompt, /has agreed on/);
  assert.doesNotMatch(prompt, /^- \[\d+\] \(/m);
});

test("只有一条规则、一条事实时,计数那一行用单数", () => {
  const prompt = sessionSystemPrompt({
    ...REQUEST,
    productKnowledgeCount: 1,
    repos: [{ owner: "acme", repo: "api", role: null, ruleCount: 1, factCount: 1 }],
  });

  assert.match(prompt, /This product has 1 active product knowledge entry\./);
  assert.match(prompt, /^- acme\/api — 1 review rule, 1 project fact$/m);
});
