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
  const reviewers = buildReviewers(loadConfig(configFile(VALID)), {
    ANTHROPIC_API_KEY: "a-secret",
    DEEPSEEK_API_KEY: "d-secret",
  });

  assert.deepEqual(
    reviewers.map((r) => r.model),
    ["claude-haiku-4-5", "deepseek-v4-flash"],
  );
});

test("凭据环境变量缺失时立即报错,不留到审查跑起来才失败", () => {
  assert.throws(
    () => buildReviewers(loadConfig(configFile(VALID)), { ANTHROPIC_API_KEY: "a" }),
    /DEEPSEEK_API_KEY/,
  );
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

test("同一个模型被配置两次时报错,否则 Finding 的模型标识无法区分来源", () => {
  assert.throws(
    () =>
      loadConfig(
        configFile({
          reviewers: [
            { provider: "a", model: "same", apiKeyEnv: "K1" },
            { provider: "b", model: "same", apiKeyEnv: "K2" },
          ],
        }),
      ),
    /重复/,
  );
});
