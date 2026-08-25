/**
 * Reviewer 子进程的失败检测。用受控的 worker 脚本代替真实的 Pi 会话,
 * 驱动那些真实模型无法按需复现的路径:崩溃、被信号终止、只报畸形条目。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ReviewerEvent } from "../src/review/finding.ts";
import { runInChild } from "../src/reviewer/pi-reviewer.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const CONFIG = {
  runtimeModel: {
    provider: "test",
    id: "stub-model",
    name: "Pinned Stub",
    api: "openai-completions" as const,
    baseUrl: "https://pinned.example.test/v1",
    input: ["text"] as const,
    reasoning: false,
    cost: undefined,
    contextWindow: 128_000,
    maxTokens: 16_000,
    sources: {
      name: "model-id" as const,
      api: "service-target" as const,
      baseUrl: "service-target" as const,
      input: "runtime-baseline" as const,
      reasoning: "runtime-baseline" as const,
      cost: "unknown" as const,
      contextWindow: "runtime-baseline" as const,
      maxTokens: "runtime-baseline" as const,
    },
  },
  apiKey: "vendor-secret",
};
const RANGE = { baseSha: "aaa", headSha: "bbb", files: ["src/a.ts"] };

/** 把一段 worker 脚本写进临时目录并返回路径。 */
function worker(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-worker-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "worker.mjs");
  writeFileSync(path, body);
  return path;
}

const RAW = {
  file: "src/a.ts",
  line: 4,
  snippet: "for (let i = 0; i <= items.length; i++) {",
  severity: "critical",
  category: "logic_error",
  description: "越界",
};

test("子进程转发的过程事件经 IPC 逐条交给编排层", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "event", event: { kind: "assistant_message", text: "先读一遍" } });
  process.send({
    kind: "event",
    event: {
      kind: "tool_call",
      tool: "read",
      args: { path: "src/a.ts" },
      durationMs: 12,
      isError: false,
      error: null,
      resultLength: 40,
    },
  });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  const events: ReviewerEvent[] = [];
  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir(), [], (event) =>
    events.push(event),
  );

  assert.equal(outcome.failure, undefined);
  assert.deepEqual(events, [
    { kind: "assistant_message", text: "先读一遍" },
    {
      kind: "tool_call",
      tool: "read",
      args: { path: "src/a.ts" },
      durationMs: 12,
      isError: false,
      error: null,
      resultLength: 40,
    },
  ]);
});

test("子进程未回报即崩溃:退出码带回来,给失败事件用", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "event", event: { kind: "assistant_message", text: "崩之前说的" } });
  process.exit(7);
});
`);

  const events: ReviewerEvent[] = [];
  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir(), [], (event) =>
    events.push(event),
  );

  assert.match(outcome.failure ?? "", /退出码 7/);
  assert.equal(outcome.exitCode, 7);
  // 崩溃前转发上来的那条仍然作数:失败也要能追溯。
  assert.deepEqual(events, [{ kind: "assistant_message", text: "崩之前说的" }]);
});

test("正常回报的条目被归一化并附上模型标识", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "finding", raw: ${JSON.stringify(RAW)} });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.findings[0]!.severity, "P0");
  assert.equal(outcome.findings[0]!.category, "bug");
  assert.equal(outcome.findings[0]!.model, "test:stub-model");
  assert.deepEqual(outcome.anomalies, []);
});

test("归一化不了的条目进入 anomalies,不静默丢弃", async () => {
  const bad = { ...RAW, severity: "catastrophic" };
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "finding", raw: ${JSON.stringify(bad)} });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.anomalies.length, 1);
  assert.equal(outcome.anomalies[0]!.raw.severity, "catastrophic");
  assert.match(outcome.anomalies[0]!.reason, /severity/);
});

test("会话内可见的失败被回报为 failure", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0, failure: "402 dead credential" });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.failure, "402 dead credential");
  assert.deepEqual(outcome.findings, []);
});

test("子进程未回报结果即退出时,退出码是唯一的失败信号", async () => {
  const path = worker(`
process.on("message", () => {
  // 崩在回报之前:会话内的三处信号一处也发不出来。
  process.exit(3);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.notEqual(outcome.failure, undefined);
  assert.match(outcome.failure!, /退出码 3/);
});

test("子进程被信号终止时同样判定为失败", async () => {
  const path = worker(`
process.on("message", () => {
  process.kill(process.pid, "SIGKILL");
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.notEqual(outcome.failure, undefined);
  assert.match(outcome.failure!, /SIGKILL/);
});

test("已回报的 Finding 在子进程随后崩溃时不被当作完整结果", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "finding", raw: ${JSON.stringify(RAW)} });
  process.exit(1);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  // Finding 保留下来,但 failure 有值,调用方据此知道这次审查不完整。
  assert.equal(outcome.findings.length, 1);
  assert.notEqual(outcome.failure, undefined);
});

test("工具调用被拒而 Finding 为零,可由 outcome 判定为契约失配", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "done", rejectedToolCalls: 4, anchorRejections: 0 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.rejectedToolCalls, 4);
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.failure, undefined);
});

test("锚定打回次数经 IPC 回传,与被拒的工具调用各记各的", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "done", rejectedToolCalls: 1, anchorRejections: 3 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  // 两个数分列:契约失配与"位置报不准"是两种毛病,合成一个数就看不出该改哪头。
  assert.equal(outcome.anchorRejections, 3);
  assert.equal(outcome.rejectedToolCalls, 1);
});

test("固定价格来源决定 Pi 数字能不能成为产品费用", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({
    kind: "done",
    rejectedToolCalls: 0,
    anchorRejections: 0,
    usage: {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      totalTokens: 185,
      costUsd: 0.25,
    },
  });
  process.exit(0);
});
`);

  const unknown = await runInChild(path, CONFIG, RANGE, tmpdir());
  assert.deepEqual(unknown.usage, {
    inputTokens: 120,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    totalTokens: 185,
    costUsd: null,
    knownCostUsd: 0,
    costSource: "unknown",
  });

  const trustedConfig = {
    ...CONFIG,
    runtimeModel: {
      ...CONFIG.runtimeModel,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      sources: { ...CONFIG.runtimeModel.sources, cost: "trusted" as const },
    },
  };
  const knownPaid = await runInChild(path, trustedConfig, RANGE, tmpdir());
  assert.equal(knownPaid.usage?.costUsd, 0.25);
  assert.equal(knownPaid.usage?.knownCostUsd, 0.25);
  assert.equal(knownPaid.usage?.costSource, "trusted");

  const freePath = worker(`
process.on("message", () => {
  process.send({
    kind: "done",
    rejectedToolCalls: 0,
    anchorRejections: 0,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0,
    },
  });
  process.exit(0);
});
`);
  const freeConfig = {
    ...trustedConfig,
    runtimeModel: {
      ...trustedConfig.runtimeModel,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
  const knownFree = await runInChild(freePath, freeConfig, RANGE, tmpdir());
  assert.equal(knownFree.usage?.costUsd, 0);
  assert.equal(knownFree.usage?.knownCostUsd, 0);
  assert.equal(knownFree.usage?.costSource, "trusted");
});

test("子进程的环境里只有自家那一份模型凭据", async () => {
  const path = worker(`
process.on("message", () => {
  const credentialish = Object.keys(process.env).filter((name) =>
    /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH)(?:_|$)/i.test(name),
  );
  process.send({
    kind: "finding",
    raw: {
      file: "echo",
      line: 1,
      severity: "low",
      category: "design",
      description: JSON.stringify({
        credentialish,
        apiKey: process.env.MULTIREVIEWER_MODEL_API_KEY,
      }),
    },
  });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  // 父进程带着 Forge 凭据、别家模型凭据、主密钥与密文,子进程一个都不该看到。
  const saved = { ...process.env };
  process.env["GITHUB_TOKEN"] = "forge-secret";
  process.env["DEEPSEEK_API_KEY"] = "other-vendor-secret";
  process.env["MULTIREVIEWER_CREDENTIAL_MASTER_KEY"] = "master-secret";
  process.env["MODEL_CREDENTIAL_CIPHERTEXT"] = "v1.ciphertext-secret";
  let outcome;
  try {
    outcome = await runInChild(path, CONFIG, RANGE, tmpdir());
  } finally {
    process.env = saved;
  }

  const echoed = JSON.parse(outcome.findings[0]!.description);
  assert.deepEqual(echoed.credentialish, ["MULTIREVIEWER_MODEL_API_KEY"]);
  assert.equal(echoed.apiKey, "vendor-secret");
  assert.equal(echoed.credentialish.includes("MULTIREVIEWER_CREDENTIAL_MASTER_KEY"), false);
  assert.equal(echoed.credentialish.includes("MODEL_CREDENTIAL_CIPHERTEXT"), false);
});

test("worker 收到本轮固定运行模型、Review Range 与工作副本路径", async () => {
  const path = worker(`
process.on("message", (request) => {
  process.send({
    kind: "finding",
    raw: {
      file: "echo",
      line: 1,
      severity: "low",
      category: "design",
      description: JSON.stringify(request),
    },
  });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  const workdir = mkdtempSync(join(tmpdir(), "multireviewer-worktree-"));
  cleanups.push(() => rmSync(workdir, { recursive: true, force: true }));

  const outcome = await runInChild(path, CONFIG, RANGE, workdir);

  const echoed = JSON.parse(outcome.findings[0]!.description);
  assert.deepEqual(echoed.range, RANGE);
  assert.equal(echoed.worktreePath, workdir);
  assert.deepEqual(echoed.runtimeModel, JSON.parse(JSON.stringify(CONFIG.runtimeModel)));
  assert.equal(echoed.runtimeModel.baseUrl, "https://pinned.example.test/v1");
  // 模型凭据只走专用环境变量。IPC 里连字段和值都不能出现:消息可能进入日志或崩溃转储。
  assert.equal(Object.hasOwn(echoed, "apiKey"), false);
  assert.equal(JSON.stringify(echoed).includes(CONFIG.apiKey), false);
});

test("工作副本目录不存在时,失败落在这一个 Reviewer 上而不是抛给调用方", async () => {
  const path = worker(`process.on("message", () => process.exit(0));`);

  const outcome = await runInChild(
    path,
    CONFIG,
    RANGE,
    join(tmpdir(), "multireviewer-does-not-exist"),
  );

  assert.notEqual(outcome.failure, undefined);
});

test("子进程回报结果后赖着不退出,不拖到整体超时", async () => {
  // 不调用 process.exit,靠 IPC 通道把事件循环挂住——真实 worker 曾经就是这样。
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "done", rejectedToolCalls: 1, anchorRejections: 0 });
});
`);

  const started = Date.now();
  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.rejectedToolCalls, 1);
  assert.ok(Date.now() - started < 30_000, "应当在宽限期内结束,而不是等满超时");
});

test("子进程回的复核结论被归一化,同一条改口取后一条", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "verdict", raw: { id: 7, verdict: "STILL PRESENT" } });
  process.send({ kind: "verdict", raw: { id: 7, verdict: "fixed" } });
  process.send({ kind: "verdict", raw: { id: 9, verdict: "vibes" } });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir(), [
    { id: 7, file: "src/a.ts", line: 4, title: "越界", disposition: "unresolved" },
    { id: 9, file: "src/a.ts", line: 9, title: "没校验", disposition: "unresolved" },
  ]);

  assert.equal(outcome.failure, undefined);
  // 映射不上的词按无法判断收:保守优先,与漏给结论同一档(ADR 0016)。
  assert.deepEqual(outcome.verdicts, [
    { findingId: 7, verdict: "fixed" },
    { findingId: 9, verdict: "unclear" },
  ]);
});

test("子进程把本阶段的历史原样收在任务里:注入是它唯一的历史来源", async () => {
  const path = worker(`
process.on("message", (request) => {
  process.send({
    kind: "finding",
    raw: { ...${JSON.stringify(RAW)}, description: JSON.stringify(request.history) },
  });
  process.send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0 });
  process.exit(0);
});
`);

  const history = [
    { id: 3, file: "src/a.ts", line: 4, title: "越界", disposition: "unresolved" as const },
  ];
  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir(), history);

  assert.deepEqual(JSON.parse(outcome.findings[0]!.description), history);
});
