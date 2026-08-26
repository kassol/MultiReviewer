import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertReviewerSpecs,
  buildReviewers,
  parseGlobalReviewers,
  type ReviewerRuntimePlan,
  type ReviewerSpec,
} from "../src/config.ts";

const VALID: ReviewerSpec[] = [
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
];

function readyPlan(spec: ReviewerSpec, credential = `${spec.provider}-secret`): ReviewerRuntimePlan {
  return {
    spec,
    modelServiceVersion: 3,
    target: { api: "openai-completions", baseUrl: `https://${spec.provider}.example.test/v1` },
    runtimeModel: {
      provider: spec.provider,
      id: spec.model,
      name: spec.model,
      api: "openai-completions",
      baseUrl: `https://${spec.provider}.example.test/v1`,
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 16_000,
      sources: {
        name: "model-id",
        api: "service-target",
        baseUrl: "service-target",
        input: "runtime-baseline",
        reasoning: "runtime-baseline",
        contextWindow: "runtime-baseline",
        maxTokens: "runtime-baseline",
      },
    },
    credential,
    failure: null,
  };
}

function failedPlan(spec: ReviewerSpec, failure: string): ReviewerRuntimePlan {
  return {
    spec,
    modelServiceVersion: null,
    target: null,
    runtimeModel: null,
    credential: null,
    failure,
  };
}

test("完整运行计划各建成一个 Reviewer,身份取固定的 provider:model", () => {
  const reviewers = buildReviewers(VALID.map((spec) => readyPlan(spec)));
  assert.deepEqual(
    reviewers.map((reviewer) => reviewer.model),
    ["anthropic:claude-haiku-4-5", "deepseek:deepseek-v4-flash"],
  );
});

test("不可用的计划不抛,Reviewer 一跑就留下该项的稳定失败", async () => {
  const failure = "deepseek 的模型凭据待重新验证,deepseek:deepseek-v4-flash 这次没跑。";
  const reviewer = buildReviewers([failedPlan(VALID[1]!, failure)])[0]!;
  const outcome = await reviewer.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
    [],
  );
  assert.equal(outcome.failure, failure);
  assert.deepEqual(outcome.findings, []);
});

test("一个模型都没配时建出的 Reviewer 一跑就报失败,而不是零 Reviewer", async () => {
  const reviewers = buildReviewers([]);
  assert.equal(reviewers.length, 1);
  const outcome = await reviewers[0]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
    [],
  );
  assert.match(outcome.failure ?? "", /还没有配置模型组合/);
});

test("运行计划意外缺字段时也只失败自身,不掀掉可用同伴", async () => {
  const incomplete: ReviewerRuntimePlan = {
    ...readyPlan(VALID[0]!),
    credential: null,
  };
  const reviewers = buildReviewers([incomplete, readyPlan(VALID[1]!)]);
  assert.equal(reviewers.length, 2);
  const outcome = await reviewers[0]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
    [],
  );
  assert.match(outcome.failure ?? "", /不可变运行计划不完整/);
  assert.equal(reviewers[1]!.model, "deepseek:deepseek-v4-flash");
});

test("组合为空、条目缺字段时报错,报错指认来源层级", () => {
  assert.throws(() => assertReviewerSpecs([], "全局模型组合"), /全局模型组合至少要选一个模型/);
  assert.throws(
    () => assertReviewerSpecs([{ provider: "x" }], "仓库 7 的模型覆盖"),
    /仓库 7 的模型覆盖.*model/,
  );
  assert.throws(() => assertReviewerSpecs([{ model: "y" }], "全局模型组合"), /provider/);
});

test("同一个模型标识被配置两次时报错,跨 provider 的同 model id 可共存", () => {
  assert.throws(
    () =>
      assertReviewerSpecs(
        [
          { provider: "a", model: "same" },
          { provider: "a", model: "same" },
        ],
        "全局模型组合",
      ),
    /a:same 选了两次/,
  );
  assert.deepEqual(
    assertReviewerSpecs(
      [
        { provider: "a", model: "same" },
        { provider: "b", model: "same" },
      ],
      "全局模型组合",
    ),
    [
      { provider: "a", model: "same" },
      { provider: "b", model: "same" },
    ],
  );
});

test("带斜杠和冒号的 model id 在 Reviewer 身份里保持完整", () => {
  const spec = { provider: "openrouter", model: "z-ai/glm-5.2:free" };
  assert.equal(buildReviewers([readyPlan(spec)])[0]!.model, "openrouter:z-ai/glm-5.2:free");
});

test("库里没写过全局组合时是空数组,写过的按同一套判据校验", () => {
  assert.deepEqual(parseGlobalReviewers(null), []);
  assert.deepEqual(parseGlobalReviewers(JSON.stringify(VALID)), VALID);
  assert.deepEqual(parseGlobalReviewers("[]"), []);
});
