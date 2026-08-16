import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { buildReviewers, loadConfig } from "../src/config.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function configFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "multireviewer.config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

const VALID = {
  reviewers: [
    { provider: "anthropic", model: "claude-haiku-4-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
    { provider: "deepseek", model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
  ],
};

test("模型组合从全局配置文件读取", () => {
  const config = loadConfig(configFile(VALID));
  assert.equal(config.reviewers.length, 2);
  assert.equal(config.reviewers[0]!.provider, "anthropic");
  assert.equal(config.reviewers[1]!.model, "deepseek-v4-flash");
});

test("配置里的每个条目建成一个 Reviewer,各自绑定自己的模型与凭据", () => {
  const reviewers = buildReviewers(
    loadConfig(configFile(VALID)).reviewers,
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
  const reviewers = buildReviewers(
    loadConfig(configFile(VALID)).reviewers,
    new Map([["anthropic", "a-secret"]]),
  );

  const outcome = await reviewers[1]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(outcome.failure ?? "", /deepseek/);
  assert.deepEqual(outcome.findings, []);
});

test("配置文件缺失、非法或没有 Reviewer 时报错", () => {
  assert.throws(() => loadConfig(join(tmpdir(), "no-such-multireviewer.json")), /配置文件/);
  assert.throws(() => loadConfig(configFile("{ not json")), /解析/);
  assert.throws(() => loadConfig(configFile({ reviewers: [] })), /至少配置一个/);
  assert.throws(
    () => loadConfig(configFile({ reviewers: [{ provider: "x", model: "y" }] })),
    /apiKeyEnv/,
  );
});

test("分批阈值可配置,不配置时留空由编排层取默认值", () => {
  assert.equal(loadConfig(configFile(VALID)).maxChangedLinesPerBatch, undefined);
  assert.equal(
    loadConfig(configFile({ ...VALID, maxChangedLinesPerBatch: 800 }))
      .maxChangedLinesPerBatch,
    800,
  );
  assert.throws(
    () => loadConfig(configFile({ ...VALID, maxChangedLinesPerBatch: 0 })),
    /maxChangedLinesPerBatch/,
  );
  assert.throws(
    () => loadConfig(configFile({ ...VALID, maxChangedLinesPerBatch: "800" })),
    /maxChangedLinesPerBatch/,
  );
});

test("同一个模型标识被配置两次时报错,否则 Finding 的模型标识无法区分来源", () => {
  assert.throws(
    () =>
      loadConfig(
        configFile({
          reviewers: [
            { provider: "a", model: "same", apiKeyEnv: "K1" },
            { provider: "a", model: "same", apiKeyEnv: "K2" },
          ],
        }),
      ),
    /重复: a:same/,
  );
});

test("同一个 model id 在两家 provider 下是两个 Reviewer,可共存", () => {
  const config = loadConfig(
    configFile({
      reviewers: [
        { provider: "a", model: "same", apiKeyEnv: "K1" },
        { provider: "b", model: "same", apiKeyEnv: "K2" },
      ],
    }),
  );
  const reviewers = buildReviewers(
    config.reviewers,
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
    loadConfig(
      configFile({
        reviewers: [
          { provider: "openrouter", model: "z-ai/glm-5.2:free", apiKeyEnv: "K1" },
        ],
      }),
    ).reviewers,
    new Map([["openrouter", "k1"]]),
  );
  assert.equal(reviewer!.model, "openrouter:z-ai/glm-5.2:free");
  const [provider, ...rest] = reviewer!.model.split(":");
  assert.equal(provider, "openrouter");
  assert.equal(rest.join(":"), "z-ai/glm-5.2:free");
});
