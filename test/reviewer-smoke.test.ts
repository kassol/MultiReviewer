/**
 * `report_finding` 与真实模型之间的契约,桩测不到。
 *
 * 默认跳过。它会真实调用一次模型,产生费用。fixture 来自 prototype 分支,
 * 两个文件里埋了四处缺陷。
 *
 *   MULTIREVIEWER_SMOKE_PROVIDER=anthropic \
 *   MULTIREVIEWER_SMOKE_MODEL=claude-haiku-4-5 \
 *   MULTIREVIEWER_SMOKE_ENV=ANTHROPIC_API_KEY \
 *   pnpm test
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createPiReviewer } from "../src/reviewer/pi-reviewer.ts";

const provider = process.env["MULTIREVIEWER_SMOKE_PROVIDER"];
const model = process.env["MULTIREVIEWER_SMOKE_MODEL"];
const envVar = process.env["MULTIREVIEWER_SMOKE_ENV"];
const secret = envVar === undefined ? undefined : process.env[envVar];

const skip =
  provider === undefined || model === undefined || envVar === undefined || secret === undefined
    ? "设置 MULTIREVIEWER_SMOKE_PROVIDER / _MODEL / _ENV 后运行"
    : false;

const FIXTURE = fileURLToPath(new URL("./fixture/reviewer-smoke", import.meta.url));

const SEVERITIES = new Set(["high", "medium", "low"]);
const CATEGORIES = new Set(["security", "bug", "maintainability", "design"]);

test("真实模型经 report_finding 产出结构完整的 Finding", { skip }, async () => {
  const reviewer = createPiReviewer({
    provider: provider!,
    model: model!,
    apiKey: secret!,
  });

  const outcome = await reviewer.review(
    { baseSha: "HEAD~1", headSha: "HEAD", files: ["src/db.js", "src/pagination.js"] },
    FIXTURE,
  );

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.ok(outcome.findings.length > 0, "至少要产出一条 Finding");
  // 契约成立的判据:模型原生就用对了枚举值,不需要归一化表兜底,也没有调用被拒。
  assert.equal(outcome.rejectedToolCalls, 0, "存在被拒的工具调用,说明契约失配");
  assert.deepEqual(outcome.anomalies, [], "存在归一化不了的条目");

  for (const finding of outcome.findings) {
    assert.ok(finding.file.length > 0);
    assert.ok(Number.isInteger(finding.line) && finding.line >= 1);
    assert.ok(SEVERITIES.has(finding.severity));
    assert.ok(CATEGORIES.has(finding.category));
    assert.ok(finding.description.length > 0);
    assert.equal(finding.model, model);
  }
});
