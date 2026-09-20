/**
 * 模型回合在审查轨迹里的观测数据,走真实 SDK 加本机假模型服务(issue #407、#409)。
 *
 * 钉的是桩测不到的那件事:一个**真的**空回合——模型读完工具结果之后一个字都不说、正常
 * 结束——在轨迹里留得下一条。线上 Run #119 / #124 漏复核几十条,现场就停在这一档上,而
 * 当时轨迹里连一条事件都没有,只能从「每批最后一个事件是什么」反推。
 *
 * 与 `reviewer-evidence-session.test.ts` 同一套假模型服务,不派取证:这里验的是父会话
 * 自己的回合。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ReviewerEvent } from "../src/review/finding.ts";
import type { RuntimeModel } from "../src/reviewer/model-service-runtime.ts";
import { createPiReviewer } from "../src/reviewer/pi-reviewer.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { startModelStub, type StubTurn } from "./support/model-stub.ts";

const cleanups = testCleanups();

const TARGET_FILE = "src.ts";
const TARGET_CONTENT = "export const a = 1;\n";

function runtimeModel(baseUrl: string): RuntimeModel {
  return {
    provider: "stub",
    id: "stub-model",
    name: "Stub Model",
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_000,
    sources: {
      name: "trusted",
      api: "service-target",
      baseUrl: "service-target",
      input: "trusted",
      reasoning: "trusted",
      contextWindow: "trusted",
      maxTokens: "trusted",
    },
  };
}

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-turn-trace-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, TARGET_FILE), TARGET_CONTENT);
  return dir;
}

async function reviewWithStub(turns: readonly StubTurn[]) {
  const stub = await startModelStub(turns);
  const events: ReviewerEvent[] = [];
  try {
    const reviewer = createPiReviewer({
      runtimeModel: runtimeModel(stub.baseUrl),
      apiKey: "stub-key",
    });
    const outcome = await reviewer.review({
      range: { baseSha: "aaa", headSha: "bbb", files: [TARGET_FILE] },
      worktreePath: worktree(),
      commentable: { [TARGET_FILE]: [{ start: 1, end: 1 }] },
      history: [],
      onEvent: (event) => events.push(event),
    });
    return { outcome, events, requests: stub.requests };
  } finally {
    await stub.close();
  }
}

/** 轨迹里的模型回合,按发生顺序。 */
function turns(events: readonly ReviewerEvent[]) {
  return events.filter(
    (event): event is Extract<ReviewerEvent, { kind: "assistant_message" }> =>
      event.kind === "assistant_message",
  );
}

/** 轨迹里的自动重试事件,按发生顺序。 */
function retries(events: readonly ReviewerEvent[]) {
  return events.filter(
    (event): event is Extract<ReviewerEvent, { kind: "model_retry" }> =>
      event.kind === "model_retry",
  );
}

test("读完工具结果就无声结束的那一回合照样落进轨迹(issue #407)", async () => {
  const { outcome, requests, events } = await reviewWithStub([
    { text: "先读一眼改动", toolCall: { name: "read", args: { path: TARGET_FILE } }, usage: { input: 40, output: 9 } },
    // 第二次响应一个内容块都不给,正常结束:线上那几批就停在这里。
    { usage: { input: 55, output: 0 } },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 2);

  const [first, last] = turns(events);
  assert.equal(turns(events).length, 2, "空回合没进轨迹");

  // 说了话的那一回合:文本一字不变,新字段是追加。
  assert.equal(first?.text, "先读一眼改动");
  assert.equal(first?.stopReason, "toolUse");
  assert.deepEqual(first?.content, { text: 1, thinking: 0, toolCalls: 1, thinkingChars: 0 });
  assert.deepEqual(first?.usage, {
    inputTokens: 40,
    outputTokens: 9,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  // 空回合:文本是空串,停止原因与内容构成说得出「它是怎么结束的、产出了什么」。
  assert.equal(last?.text, "");
  assert.equal(last?.stopReason, "stop");
  assert.deepEqual(last?.content, { text: 0, thinking: 0, toolCalls: 0, thinkingChars: 0 });
  assert.deepEqual(last?.usage, {
    inputTokens: 55,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("瞬时的模型服务失败被重试吞掉之后,轨迹里留得下这次重试(issue #409)", async () => {
  const { outcome, requests, events } = await reviewWithStub([
    // 第一次请求回 5xx:Pi 判它可重试,等一轮退避再发第二次。
    { status: 503, text: "upstream temporarily unavailable", usage: { input: 0, output: 0 } },
    { text: "重试之后读到了改动,没有问题", usage: { input: 44, output: 11 } },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 2, "失败那一次与重试那一次,各一条请求");

  const [waiting, settled] = retries(events);
  assert.equal(waiting?.outcome, "waiting");
  assert.equal(waiting?.attempt, 1);
  assert.ok((waiting?.delayMs ?? 0) > 0, "等待时长该是 Pi 算出来的那个退避");
  assert.ok(
    waiting?.error?.includes("upstream temporarily unavailable"),
    `触发重试的错误原文没进事件: ${waiting?.error}`,
  );
  // 最终成功与最终放弃分得出来。
  assert.equal(settled?.outcome, "succeeded");
  assert.equal(settled?.attempt, 1);

  // 重试之后那一回合照常落进轨迹。
  assert.equal(turns(events).at(-1)?.text, "重试之后读到了改动,没有问题");
});
