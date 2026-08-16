import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertReviewerSpecs,
  buildReviewers,
  parseGlobalReviewers,
  type ReviewerSpec,
} from "../src/config.ts";

const VALID: ReviewerSpec[] = [
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
];

test("组合里的每个条目建成一个 Reviewer,各自绑定自己的模型与凭据", () => {
  const reviewers = buildReviewers(
    VALID,
    new Map([
      ["anthropic", "a-secret"],
      ["deepseek", "d-secret"],
    ]),
  );

  assert.deepEqual(
    reviewers.map((r) => r.model),
    ["anthropic:claude-haiku-4-5", "deepseek:deepseek-v4-flash"],
  );
});

test("缺凭据的 provider 不抛,建出的 Reviewer 一跑就报失败并写明缺哪一家", async () => {
  const reviewers = buildReviewers(VALID, new Map([["anthropic", "a-secret"]]));

  const outcome = await reviewers[1]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(outcome.failure ?? "", /deepseek/);
  assert.deepEqual(outcome.findings, []);
});

test("一个模型都没配时建出的 Reviewer 一跑就报失败,而不是零 Reviewer", async () => {
  const reviewers = buildReviewers([], new Map());
  assert.equal(reviewers.length, 1);

  const outcome = await reviewers[0]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(outcome.failure ?? "", /还没有配置模型组合/);
});

test("组合为空、条目缺字段时报错,报错指认来源层级", () => {
  assert.throws(() => assertReviewerSpecs([], "全局模型组合"), /全局模型组合至少要选一个模型/);
  assert.throws(
    () => assertReviewerSpecs([{ provider: "x" }], "仓库 7 的模型覆盖"),
    /仓库 7 的模型覆盖.*model/,
  );
  assert.throws(() => assertReviewerSpecs([{ model: "y" }], "全局模型组合"), /provider/);
});

test("同一个模型标识被配置两次时报错,否则 Finding 的模型标识无法区分来源", () => {
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
});

test("同一个 model id 在两家 provider 下是两个 Reviewer,可共存", () => {
  const specs = assertReviewerSpecs(
    [
      { provider: "a", model: "same" },
      { provider: "b", model: "same" },
    ],
    "全局模型组合",
  );
  const reviewers = buildReviewers(
    specs,
    new Map([
      ["a", "k1"],
      ["b", "k2"],
    ]),
  );
  assert.deepEqual(
    reviewers.map((r) => r.model),
    ["a:same", "b:same"],
  );
});

test("带斜杠的 model id 拆包无歧义:首个冒号即边界", () => {
  const [reviewer] = buildReviewers(
    [{ provider: "openrouter", model: "z-ai/glm-5.2:free" }],
    new Map([["openrouter", "k1"]]),
  );
  assert.equal(reviewer!.model, "openrouter:z-ai/glm-5.2:free");
  const [provider, ...rest] = reviewer!.model.split(":");
  assert.equal(provider, "openrouter");
  assert.equal(rest.join(":"), "z-ai/glm-5.2:free");
});

test("库里没写过全局组合时是空数组,写过的按同一套判据校验", () => {
  assert.deepEqual(parseGlobalReviewers(null), []);
  assert.deepEqual(parseGlobalReviewers(JSON.stringify(VALID)), VALID);
  // 全局这一层允许空组合:空库刚部署时它本来就是空的(issue #66)。
  assert.deepEqual(parseGlobalReviewers("[]"), []);
});
