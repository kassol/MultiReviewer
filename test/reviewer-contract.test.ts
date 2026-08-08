import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFinding } from "../src/reviewer/normalize.ts";
import { reviewerEnv } from "../src/reviewer/env.ts";

const RAW = {
  file: "src/db.js",
  line: 12,
  snippet: 'db.query("SELECT * FROM users WHERE id = " + id);',
  severity: "P0",
  category: "security",
  title: "SQL 注入",
  description: "SQL 拼接",
  impact: "任意查询可被注入",
  suggestion: "改用参数化查询",
};

test("模型自造的同义词被归一化到契约允许的值", () => {
  const cases: [string, string, string, string][] = [
    // 输入 severity, 输入 category, 期望 severity, 期望 category
    // 约定的取值原样通过,大小写与空白照常收拾。
    ["P0", "security", "P0", "security"],
    ["p1", "bug", "P1", "bug"],
    ["  P2  ", "design", "P2", "design"],
    // 形容词是模型不照约定时的退路,一并映射到 P 级。
    ["critical", "reliability", "P0", "bug"],
    ["major", "logic_error", "P0", "bug"],
    ["moderate", "correctness", "P1", "bug"],
    ["minor", "style", "P2", "maintainability"],
    ["info", "architecture", "P2", "design"],
    ["MEDIUM", "Performance", "P1", "bug"],
    ["  low  ", "logic error", "P2", "bug"],
  ];

  for (const [severity, category, expectedSeverity, expectedCategory] of cases) {
    const result = normalizeFinding({ ...RAW, severity, category }, "m");
    assert.equal(result.ok, true, `${severity}/${category} 应当能归一化`);
    if (!result.ok) continue;
    assert.equal(result.finding.severity, expectedSeverity);
    assert.equal(result.finding.category, expectedCategory);
  }
});

test("Finding 附带提出它的模型标识", () => {
  const result = normalizeFinding(RAW, "claude-haiku-4-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finding.model, "claude-haiku-4-5");
});

test("映射不上的条目记录为异常,不静默丢弃", () => {
  const unknownSeverity = normalizeFinding({ ...RAW, severity: "catastrophic" }, "m");
  assert.equal(unknownSeverity.ok, false);
  if (unknownSeverity.ok) return;
  assert.match(unknownSeverity.reason, /severity/);
  assert.equal(unknownSeverity.raw.severity, "catastrophic");

  const unknownCategory = normalizeFinding({ ...RAW, category: "vibes" }, "m");
  assert.equal(unknownCategory.ok, false);
  if (unknownCategory.ok) return;
  assert.match(unknownCategory.reason, /category/);
});

test("缺字段或行号非法的条目记录为异常", () => {
  for (const bad of [
    { ...RAW, file: "" },
    { ...RAW, description: "" },
    { ...RAW, line: 0 },
    { ...RAW, line: -3 },
    { ...RAW, line: 1.5 },
  ]) {
    const result = normalizeFinding(bad, "m");
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 应当被判为异常`);
  }
});

test("子进程只拿到自家厂商的凭据,拿不到 forge 凭据与其他厂商凭据", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/svc",
    GITHUB_TOKEN: "forge-secret",
    GITEA_TOKEN: "forge-secret-2",
    ANTHROPIC_API_KEY: "anthropic-secret",
    DEEPSEEK_API_KEY: "deepseek-secret",
  };

  const env = reviewerEnv(parent, { ANTHROPIC_API_KEY: "anthropic-secret" });

  assert.equal(env["ANTHROPIC_API_KEY"], "anthropic-secret");
  assert.equal(env["DEEPSEEK_API_KEY"], undefined);
  assert.equal(env["GITHUB_TOKEN"], undefined);
  assert.equal(env["GITEA_TOKEN"], undefined);
  // 非凭据的进程环境仍要传下去,否则子进程连 git 与 node 都找不到。
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["HOME"], "/home/svc");
});

test("父进程环境里的同名变量不会覆盖显式给定的厂商凭据", () => {
  const env = reviewerEnv(
    { ANTHROPIC_API_KEY: "stale-from-parent" },
    { ANTHROPIC_API_KEY: "the-one-for-this-reviewer" },
  );
  assert.equal(env["ANTHROPIC_API_KEY"], "the-one-for-this-reviewer");
});
