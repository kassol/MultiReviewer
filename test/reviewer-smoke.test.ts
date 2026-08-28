/**
 * `report_finding`、复核工具与真实模型之间的契约,桩测不到。
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

import type { HistoryFinding, ReviewerEvent } from "../src/review/finding.ts";
import { resolvePiBuiltinProviderTarget } from "../src/reviewer/catalog.ts";
import { createPiReviewer } from "../src/reviewer/pi-reviewer.ts";
import { createPiRuleAgent, RULE_LIMIT } from "../src/reviewer/rule-agent.ts";
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

async function smokeReviewer(): Promise<ReturnType<typeof createPiReviewer>> {
  const target = await resolvePiBuiltinProviderTarget(provider!);
  assert.ok(target, `Pi 内置 provider 不存在或没有运行目标: ${provider}`);
  return createPiReviewer({
    runtimeModel: {
      provider: provider!,
      id: model!,
      name: model!,
      api: target.api,
      baseUrl: target.baseUrl,
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
    apiKey: secret!,
  });
}

test("真实模型经 report_finding 产出结构完整的 Finding", { skip }, async () => {
  const reviewer = await smokeReviewer();

  // 轨迹的另一半契约(issue #171):真实子进程里那条订阅确实把 Pi 的会话事件转发上来。
  const events: ReviewerEvent[] = [];
  const outcome = await reviewer.review({
    range: { baseSha: "HEAD~1", headSha: "HEAD", files: ["src/db.js", "src/pagination.js"] },
    worktreePath: FIXTURE,
    history: [],
    rules: [],
    onEvent: (event) => events.push(event),
  });

  assert.ok(
    events.some((event) => event.kind === "assistant_message"),
    "至少要转发一条模型说的话",
  );
  assert.ok(
    events.some((event) => event.kind === "tool_call"),
    "至少要转发一次工具调用",
  );
  // 凭据不出现在任何事件正文里:轨迹会原样呈现给能看这一轮的人。
  assert.equal(
    JSON.stringify(events).includes(secret!),
    false,
    "事件正文里出现了本轮模型凭据",
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

/**
 * 一条历史 Finding,说的问题在 fixture 里根本不成立:`markShipped` 的 UPDATE 用的是
 * 占位符,不是拼接。模型据此该经复核工具回「已修」(ADR 0016)。
 */
const PRIOR: HistoryFinding = {
  id: 41,
  file: "src/db.js",
  line: 13,
  title: "UPDATE 拼接 orderId",
  disposition: "unresolved",
  severity: "P0",
  category: "security",
  description:
    "markShipped 把 orderId 直接拼进 UPDATE 语句,调用方传进来的值会被当成 SQL 执行。",
};

test("真实模型经复核工具对已修好的历史 Finding 回已修", { skip }, async () => {
  const reviewer = await smokeReviewer();

  const outcome = await reviewer.review({
    range: { baseSha: "HEAD~1", headSha: "HEAD", files: ["src/db.js"] },
    worktreePath: FIXTURE,
    history: [PRIOR],
  });

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  // 契约成立的判据:结论经工具回来、认得出注入时给的那个 id、用对了枚举值。
  assert.deepEqual(outcome.verdicts, [{ findingId: PRIOR.id, verdict: "fixed" }]);
  assert.equal(outcome.rejectedToolCalls, 0, "存在被拒的工具调用,说明契约失配");
});

/**
 * 规则 agent 与真实模型之间的契约(issue #205),桩测不到:propose_rule 的形状、
 * 「只收规范性陈述」这条要求以及 30 条上限,都要真模型跑一遍才知道立不立得住。
 */
test("真实模型经 propose_rule 推导出规范性的评审规则", { skip }, async () => {
  const target = await resolvePiBuiltinProviderTarget(provider!);
  assert.ok(target, `Pi 内置 provider 不存在或没有运行目标: ${provider}`);
  const result = await createPiRuleAgent()({
    worktreePath: FIXTURE,
    baselineSha: "HEAD",
    runtimeModel: {
      provider: provider!,
      id: model!,
      name: model!,
      api: target.api,
      baseUrl: target.baseUrl,
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
    apiKey: secret!,
    existingRules: [],
  });

  assert.equal(result.failure, undefined, `规则 agent 失败: ${result.failure}`);
  assert.ok(result.items.length > 0, "至少要产出一条规则");
  // 上限由服务端截断兜底,这里看的是模型自己有没有把它当回事。
  assert.ok(result.items.length <= RULE_LIMIT * 2, "产出条数远超上限,提示措辞没起作用");
  for (const item of result.items) {
    assert.ok(item.statement.trim().length > 0);
    assert.ok(item.layer.trim().length > 0);
  }
});
