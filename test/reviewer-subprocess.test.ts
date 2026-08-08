/**
 * Reviewer 子进程的失败检测。用受控的 worker 脚本代替真实的 Pi 会话,
 * 驱动那些真实模型无法按需复现的路径:崩溃、被信号终止、只报畸形条目。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runInChild } from "../src/reviewer/pi-reviewer.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const CONFIG = { provider: "test", model: "stub-model", apiKey: "vendor-secret" };
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
  severity: "critical",
  category: "logic_error",
  description: "越界",
};

test("正常回报的条目被归一化并附上模型标识", async () => {
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "finding", raw: ${JSON.stringify(RAW)} });
  process.send({ kind: "done", rejectedToolCalls: 0 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.findings[0]!.severity, "high");
  assert.equal(outcome.findings[0]!.category, "bug");
  assert.equal(outcome.findings[0]!.model, "stub-model");
  assert.deepEqual(outcome.anomalies, []);
});

test("归一化不了的条目进入 anomalies,不静默丢弃", async () => {
  const bad = { ...RAW, severity: "catastrophic" };
  const path = worker(`
process.on("message", () => {
  process.send({ kind: "finding", raw: ${JSON.stringify(bad)} });
  process.send({ kind: "done", rejectedToolCalls: 0 });
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
  process.send({ kind: "done", rejectedToolCalls: 0, failure: "402 dead credential" });
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
  process.send({ kind: "done", rejectedToolCalls: 4 });
  process.exit(0);
});
`);

  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.rejectedToolCalls, 4);
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.failure, undefined);
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
  process.send({ kind: "done", rejectedToolCalls: 0 });
  process.exit(0);
});
`);

  // 父进程带着一把 forge 凭据与别家厂商凭据,子进程一个都不该看到。
  const saved = { ...process.env };
  process.env["GITHUB_TOKEN"] = "forge-secret";
  process.env["DEEPSEEK_API_KEY"] = "other-vendor-secret";
  let outcome;
  try {
    outcome = await runInChild(path, CONFIG, RANGE, tmpdir());
  } finally {
    process.env = saved;
  }

  const echoed = JSON.parse(outcome.findings[0]!.description);
  assert.deepEqual(echoed.credentialish, ["MULTIREVIEWER_MODEL_API_KEY"]);
  assert.equal(echoed.apiKey, "vendor-secret");
});

test("worker 收到的任务含 Review Range 与工作副本路径", async () => {
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
  process.send({ kind: "done", rejectedToolCalls: 0 });
  process.exit(0);
});
`);

  const workdir = mkdtempSync(join(tmpdir(), "multireviewer-worktree-"));
  cleanups.push(() => rmSync(workdir, { recursive: true, force: true }));

  const outcome = await runInChild(path, CONFIG, RANGE, workdir);

  const echoed = JSON.parse(outcome.findings[0]!.description);
  assert.deepEqual(echoed.range, RANGE);
  assert.equal(echoed.worktreePath, workdir);
  assert.equal(echoed.provider, "test");
  assert.equal(echoed.model, "stub-model");
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
  process.send({ kind: "done", rejectedToolCalls: 1 });
});
`);

  const started = Date.now();
  const outcome = await runInChild(path, CONFIG, RANGE, tmpdir());

  assert.equal(outcome.rejectedToolCalls, 1);
  assert.ok(Date.now() - started < 30_000, "应当在宽限期内结束,而不是等满超时");
});
