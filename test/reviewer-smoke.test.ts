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

import { resolvePiBuiltinProviderTarget } from "../src/reviewer/catalog.ts";
import { createPiReviewer } from "../src/reviewer/pi-reviewer.ts";
import {
  discoverModels,
  validateMinimalInference,
  type BuiltinModelServiceCandidate,
} from "../src/reviewer/model-service-runtime.ts";

const provider = process.env["MULTIREVIEWER_SMOKE_PROVIDER"];
const model = process.env["MULTIREVIEWER_SMOKE_MODEL"];
const envVar = process.env["MULTIREVIEWER_SMOKE_ENV"];
const secret = envVar === undefined ? undefined : process.env[envVar];

const skip =
  provider === undefined || model === undefined || envVar === undefined || secret === undefined
    ? "设置 MULTIREVIEWER_SMOKE_PROVIDER / _MODEL / _ENV 后运行"
    : false;

const FIXTURE = fileURLToPath(new URL("./fixture/reviewer-smoke", import.meta.url));

const SEVERITIES = new Set(["P0", "P1", "P2"]);
const CATEGORIES = new Set(["security", "bug", "maintainability", "design"]);

test("真实 provider 完成一次模型发现与一次最小推理", { skip }, async () => {
  const candidate: BuiltinModelServiceCandidate = {
    kind: "builtin",
    provider: provider!,
    credential: secret!,
  };
  const discovery = await discoverModels(candidate, { allowNetwork: true });
  assert.equal(discovery.ok, true, discovery.ok ? undefined : discovery.failure.message);
  if (!discovery.ok) return;
  const validationModel = discovery.models.find(({ id }) => id === model!);
  assert.ok(validationModel, `真实目录没有返回验证模型 ${provider}:${model}`);

  const inference = await validateMinimalInference(candidate, validationModel);
  assert.equal(inference.ok, true, inference.ok ? undefined : inference.failure.message);
});

test("真实模型经 report_finding 产出结构完整的 Finding", { skip }, async () => {
  const target = await resolvePiBuiltinProviderTarget(provider!);
  assert.ok(target, `Pi 内置 provider 不存在或没有运行目标: ${provider}`);
  const reviewer = createPiReviewer({
    runtimeModel: {
      provider: provider!,
      id: model!,
      name: model!,
      api: target.api,
      baseUrl: target.baseUrl,
      input: ["text"],
      reasoning: false,
      cost: undefined,
      contextWindow: 128_000,
      maxTokens: 16_000,
      sources: {
        name: "model-id",
        api: "service-target",
        baseUrl: "service-target",
        input: "runtime-baseline",
        reasoning: "runtime-baseline",
        cost: "unknown",
        contextWindow: "runtime-baseline",
        maxTokens: "runtime-baseline",
      },
    },
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
    assert.equal(finding.model, `${provider}:${model}`);
  }
});
