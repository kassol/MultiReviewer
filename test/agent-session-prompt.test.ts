/**
 * 会话系统提示里的产品名与仓库职责(CONTEXT.md 仓库职责,issue #341)。
 *
 * 桩测这一份字符串:agent 选哪个仓库读全凭这几行,职责没渲染上去它只能一个个 README 读过去,
 * 而整条真实链路(提示进模型请求)已经由 `agent-session-subprocess.test.ts` 钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OpenSessionRequest } from "../src/reviewer/session-protocol.ts";
import { sessionSystemPrompt } from "../src/reviewer/session-worker.ts";

const REQUEST: OpenSessionRequest = {
  sessionRoot: "/tmp/session-root",
  productName: "报销系统",
  purpose: "requirement-breakdown",
  repos: [
    { owner: "acme", repo: "api", role: "后端 API(Node)", rules: [], facts: [] },
    { owner: "acme", repo: "web", role: null, rules: [], facts: [] },
  ],
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
