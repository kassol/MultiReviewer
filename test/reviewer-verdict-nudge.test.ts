/**
 * 复核结论给出少于应给时,Reviewer 在同一会话里续问一次(issue #431),走真实 SDK 加本机
 * 假模型服务。
 *
 * 钉的是桩测不到的那件事:模型把全部复核结论写成一段正文、一次 `review_prior_finding`
 * 都没调就正常收工(线上 claude-opus-5-5 的 Run 145 / 148 就停在这一档)——子进程要在收工前
 * 追问一句,续的那一回合跑在同一次会话里;续过仍一条没给即这一批失败。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HistoryFinding, ReviewerEvent } from "../src/review/finding.ts";
import type { RuntimeModel } from "../src/reviewer/model-service-runtime.ts";
import { createPiReviewer } from "../src/reviewer/pi-reviewer.ts";
import { NO_VERDICT_AFTER_NUDGE } from "../src/reviewer/worker.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { startModelStub, type StubRequest, type StubTurn } from "./support/model-stub.ts";

const cleanups = testCleanups();

const TARGET_FILE = "src.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-verdict-nudge-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, TARGET_FILE), "export const a = 1;\nexport const b = 2;\n");
  return dir;
}

function open(id: number, line: number): HistoryFinding {
  return {
    id,
    file: TARGET_FILE,
    line,
    title: `历史问题 ${id}`,
    disposition: "unresolved",
    severity: "P1",
    category: "bug",
    description: "描述",
  };
}

const HISTORY: readonly HistoryFinding[] = [open(11, 1), open(12, 2)];

const USAGE = { input: 20, output: 5 };

/** 把全部结论写在正文里、一次复核工具都不调的那一回合:线上出事的形状。 */
const PROSE: StubTurn = { text: "11 与 12 两条都仍然存在。", usage: USAGE };

function verdict(id: number): { name: string; args: unknown } {
  return { name: "review_prior_finding", args: { id, verdict: "present" } };
}

async function reviewWithStub(
  turns: readonly StubTurn[],
  history = HISTORY,
  mode: "full" | "verdict-only" = "verdict-only",
) {
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
      commentable: { [TARGET_FILE]: [{ start: 1, end: 2 }] },
      history,
      mode,
      onEvent: (event) => events.push(event),
    });
    return { outcome, events, requests: stub.requests };
  } finally {
    await stub.close();
  }
}

/** 这一次请求里最后一条用户消息:续问那一句要在这里出现。 */
function lastUser(request: StubRequest | undefined): string {
  return request?.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
}

test("正文写结论而没调工具时续问一次,续后补齐:无失败、结论齐全、记下续过", async () => {
  const { outcome, requests, events } = await reviewWithStub([
    PROSE,
    { toolCalls: [verdict(11), verdict(12)], usage: USAGE },
    { text: "已逐条给出。", usage: USAGE },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 3, "续问的那一回合跑在同一次会话里,再无多余请求");
  const nudge = lastUser(requests[1]);
  assert.match(nudge, /\[11\]/);
  assert.match(nudge, /\[12\]/);
  assert.match(nudge, /prose does not count/);
  assert.deepEqual(
    outcome.verdicts?.map((v) => v.findingId).sort(),
    [11, 12],
  );
  assert.deepEqual(outcome.verdictNudge, { missingBefore: 2 });
  // 续的那一回合照常进审查轨迹:三个模型回合都在,工具调用两次。
  assert.equal(events.filter((event) => event.kind === "assistant_message").length, 3);
  assert.equal(events.filter((event) => event.kind === "tool_call").length, 2);
});

test("续问之后仍一条复核结论都没给:这一批判失败,原因写明", async () => {
  const { outcome, requests } = await reviewWithStub([PROSE, PROSE]);

  assert.equal(requests.length, 2, "只续一次");
  assert.equal(outcome.failure, NO_VERDICT_AFTER_NUDGE);
  assert.deepEqual(outcome.verdictNudge, { missingBefore: 2 });
  assert.deepEqual(outcome.verdicts, []);
});

test("完整审查里报出过 Finding、续问后仍一条结论都没给:不判失败,Finding 保住", async () => {
  const { outcome, requests } = await reviewWithStub(
    [
      {
        toolCall: {
          name: "report_finding",
          args: {
            file: TARGET_FILE,
            line: 1,
            snippet: "export const a = 1;",
            severity: "P1",
            category: "bug",
            title: "新问题",
            description: "描述",
            impact: "影响",
            suggestion: "建议",
          },
        },
        usage: USAGE,
      },
      PROSE,
      PROSE,
    ],
    HISTORY,
    "full",
  );

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 3, "只续一次");
  assert.equal(outcome.findings.length, 1);
  assert.deepEqual(outcome.verdictNudge, { missingBefore: 2 });
  assert.deepEqual(outcome.verdicts, []);
});

test("续问之后给出一部分:不判失败,只续一次,缺的留给漏复核", async () => {
  const { outcome, requests } = await reviewWithStub([
    PROSE,
    { toolCall: verdict(11), usage: USAGE },
    { text: "12 我判断不了。", usage: USAGE },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 3, "第二次收尾时仍缺一条,但不再续");
  assert.deepEqual(outcome.verdicts?.map((v) => v.findingId), [11]);
  assert.deepEqual(outcome.verdictNudge, { missingBefore: 2 });
});

test("本来就给全的批次不续:请求数与没有这一票时相同,不带续问标记", async () => {
  const { outcome, requests } = await reviewWithStub([
    { toolCalls: [verdict(11), verdict(12)], usage: USAGE },
    { text: "已逐条给出。", usage: USAGE },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 2);
  assert.equal(outcome.verdictNudge, undefined);
  assert.ok(
    requests.every((request) => !/prose does not count/.test(lastUser(request))),
    "没续过就不该出现续问那一句",
  );
});

test("只有已处置历史(应给为 0)的批次不续", async () => {
  const { outcome, requests } = await reviewWithStub(
    [{ text: "没有要复核的。", usage: USAGE }],
    [{ ...open(21, 1), disposition: "resolved" }],
  );

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 1);
  assert.equal(outcome.verdictNudge, undefined);
});
