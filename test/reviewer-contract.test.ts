import assert from "node:assert/strict";
import { test } from "node:test";

import { anchorVerdict } from "../src/reviewer/anchor.ts";
import { normalizeFinding, normalizeVerdict } from "../src/reviewer/normalize.ts";
import { redactModelCredential, reviewerEnv } from "../src/reviewer/env.ts";
import { reviewPrompt } from "../src/reviewer/worker.ts";

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

test("复核结论的新位置只留在「仍在」这一档", () => {
  // 仍在带新位置:编排层据它在新位置合成本轮的一条去承接(issue #170)。
  assert.deepEqual(normalizeVerdict({ id: 4, verdict: "still present", line: 12 }), {
    findingId: 4,
    verdict: "present",
    line: 12,
  });
  // 已修与无法判断都没有可承接的位置,带着它只会让编排层在一处不成立的地方合成 Finding。
  assert.deepEqual(normalizeVerdict({ id: 4, verdict: "fixed", line: 12 }), {
    findingId: 4,
    verdict: "fixed",
  });
  assert.deepEqual(normalizeVerdict({ id: 4, verdict: "vibes", line: 12 }), {
    findingId: 4,
    verdict: "unclear",
  });
  // 行号不是正整数即定不出位置,只留结论。
  for (const line of [0, -3, 1.5]) {
    assert.deepEqual(normalizeVerdict({ id: 4, verdict: "present", line }), {
      findingId: 4,
      verdict: "present",
    });
  }
});

const PRIOR_LINES = [
  "export function recent(count) {",
  "  return history.slice(-count);",
  "}",
];

test("复核结论的新位置锚得上时不打回,给出校正后的行号", () => {
  // 模型报的行号偏了一行,snippet 抄得对,与 report_finding 同一道校正。
  assert.deepEqual(
    anchorVerdict(PRIOR_LINES, {
      file: "src/history.ts",
      line: 3,
      snippet: "return history.slice(-count);",
    }),
    { ok: true, line: 2 },
  );
});

test("复核结论的新位置锚不上时打回,措辞点名文件并要求重给行号", () => {
  const result = anchorVerdict(PRIOR_LINES, {
    file: "src/history.ts",
    line: 2,
    snippet: "return history.slice(count);",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 结论照收写在措辞里:打回的只是这个位置。
  assert.match(result.message, /verdict recorded, new line NOT recorded/);
  assert.match(result.message, /src\/history\.ts/);
});

test("复核结论带位置但文件读不出来时同样打回", () => {
  const result = anchorVerdict(undefined, {
    file: "src/gone.ts",
    line: 2,
    snippet: "return history.slice(-count);",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /src\/gone\.ts/);
});

test("复核结论没抄 snippet 时打回,不拿裸行号当位置", () => {
  const result = anchorVerdict(PRIOR_LINES, {
    file: "src/history.ts",
    line: 2,
    snippet: undefined,
  });
  assert.equal(result.ok, false);
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

test("子进程失败文本回传前抹掉本轮模型凭据", () => {
  const credential = "secret-run-credential";
  const failure = redactModelCredential(
    `request with Bearer ${credential} failed; credential=${credential}`,
    credential,
  );
  assert.equal(failure.includes(credential), false);
  assert.equal(failure, "request with Bearer [REDACTED] failed; credential=[REDACTED]");
});

const PROMPT_RANGE = { baseSha: "aaa", headSha: "bbb", files: ["src/a.ts"] };

test("空规则集不渲染规则段,prompt 与没有规则集时逐字一致", () => {
  const withoutRules = reviewPrompt({ range: PROMPT_RANGE, history: [] });
  const withEmptyRules = reviewPrompt({ range: PROMPT_RANGE, history: [], rules: [] });

  assert.equal(withEmptyRules, withoutRules);
  assert.equal(/rule/i.test(withoutRules), false);
});

test("注入的评审规则进 prompt,每条带标识与作用范围", () => {
  const prompt = reviewPrompt({
    range: PROMPT_RANGE,
    history: [],
    rules: [
      { id: 7, scope: "", statement: "对外接口的入参一律在边界处校验" },
      { id: 9, scope: "src/**/*.ts", statement: "禁止在 src 下写 any" },
    ],
  });

  assert.match(prompt, /\[7\]/);
  assert.match(prompt, /对外接口的入参一律在边界处校验/);
  assert.match(prompt, /\[9\]/);
  assert.match(prompt, /src\/\*\*\/\*\.ts/);
  assert.match(prompt, /禁止在 src 下写 any/);
  // 规则标识是模型自报命中的凭据,prompt 必须说清它要怎么带回来。
  assert.match(prompt, /ruleId/);
});

test("模型自报的规则标识经服务端校验:本轮注入过的留下,对不上的置空", () => {
  const injected = new Set([7, 9]);

  const hit = normalizeFinding({ ...RAW, ruleId: 9 }, "m", injected);
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.finding.ruleId, 9);

  // 编出来的标识不落库:命中统计要能当证据用,不能收模型的臆造。
  const invented = normalizeFinding({ ...RAW, ruleId: 42 }, "m", injected);
  assert.equal(invented.ok, true);
  if (invented.ok) assert.equal(invented.finding.ruleId, undefined);

  // 一条规则都没注入时,任何标识都对不上。
  const noRules = normalizeFinding({ ...RAW, ruleId: 9 }, "m");
  assert.equal(noRules.ok, true);
  if (noRules.ok) assert.equal(noRules.finding.ruleId, undefined);

  // 规则标识不参与 Finding 的取舍:对不上只置空,条目本身照收。
  assert.equal(normalizeFinding(RAW, "m", injected).ok, true);
});
