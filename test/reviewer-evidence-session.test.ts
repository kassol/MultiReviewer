/**
 * 取证链路的真实 SDK 回归(issue #260、#262):`createPiReviewer → worker → pi-subagents →
 * read → transcript → ReviewerOutcome` 整条走一遍,模型由本机的假服务
 * (`support/model-stub.ts`)按脚本扮演,全程不碰收费模型与真实 Forge。
 *
 * 钉的是桩测不到的几件事:子会话真的读到了工作副本里的文件并把内容带回模型请求、子会话
 * 的过程嵌进了审查轨迹、一次取证的 token 用量只计一次——pi-subagents 把子会话的汇总
 * Usage 挂在工具返回上,Pi 父会话统计已经含它,再从 transcript 补一次就是 138 而不是 84;
 * 以及取证契约在 pi-subagents 0.65 的进程内前台子会话上仍然成立——子会话的工具面恰是
 * 只读四件套,调用参数开不了 intercom 桥,仓库自带的 agent 定义派不出去,超时的子会话
 * 停下之后不再发请求。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ReviewerEvent, ReviewerUsage } from "../src/review/finding.ts";
import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { EVIDENCE_AGENT, EVIDENCE_TOOL } from "../src/reviewer/evidence.ts";
import type { RuntimeModel } from "../src/reviewer/model-service-runtime.ts";
import { createPiReviewer } from "../src/reviewer/pi-reviewer.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge } from "./support/memory-forge.ts";
import { startModelStub, type StubTurn, type StubUsage } from "./support/model-stub.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** 工作副本里给子会话读的那个文件。内容故意独一无二,好在模型请求里认出来。 */
const TARGET_FILE = "target.txt";
const TARGET_CONTENT = "EVIDENCE-MARKER-7f3c: caller passes req.query.customerId unchecked\n";

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

/**
 * 一次取证的四次模型响应,按到达顺序:父会话派取证 → 子会话读文件 → 子会话交报告 →
 * 父会话收尾。用量由调用方给,四份加起来就是这一次 Reviewer 该报的数。
 */
function evidenceTurns(usage: readonly [StubUsage, StubUsage, StubUsage, StubUsage]): StubTurn[] {
  return [
    {
      text: "先派取证核对调用方",
      toolCall: {
        name: EVIDENCE_TOOL,
        args: { agent: EVIDENCE_AGENT, task: `读 ${TARGET_FILE},把第 1 行原样带回来` },
      },
      usage: usage[0],
    },
    { text: "读目标文件", toolCall: { name: "read", args: { path: TARGET_FILE } }, usage: usage[1] },
    { text: `${TARGET_FILE}:1 写着 ${TARGET_CONTENT.trim()}`, usage: usage[2] },
    { text: "证据核对完毕,没有问题", usage: usage[3] },
  ];
}

function sum(usage: readonly StubUsage[]): ReviewerUsage {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const entry of usage) {
    total.inputTokens += entry.input;
    total.outputTokens += entry.output;
    total.cacheReadTokens += entry.cacheRead ?? 0;
    total.cacheWriteTokens += entry.cacheWrite ?? 0;
  }
  return {
    ...total,
    totalTokens:
      total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens,
  };
}

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-evidence-session-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, TARGET_FILE), TARGET_CONTENT);
  writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
  return dir;
}

async function reviewWithStub(
  turns: readonly StubTurn[],
  extra: { maxEvidenceCallsPerBatch?: number } = {},
) {
  const stub = await startModelStub(turns);
  const events: ReviewerEvent[] = [];
  try {
    const reviewer = createPiReviewer({ runtimeModel: runtimeModel(stub.baseUrl), apiKey: "stub-key" });
    const outcome = await reviewer.review({
      range: { baseSha: "aaa", headSha: "bbb", files: ["src.ts"] },
      worktreePath: worktree(),
      commentable: { "src.ts": [{ start: 1, end: 1 }] },
      history: [],
      onEvent: (event) => events.push(event),
      ...extra,
    });
    return { outcome, events, requests: stub.requests };
  } finally {
    await stub.close();
  }
}

/** 四次响应的 input / output 分别合计 62 / 22,Reviewer 该报 total 84。 */
const PLAIN_USAGE = [
  { input: 20, output: 5 },
  { input: 12, output: 4 },
  { input: 18, output: 8 },
  { input: 12, output: 5 },
] as const;

test("取证真跑一遍:文件内容回到子会话的模型请求,过程嵌进轨迹,用量只计一次", async () => {
  const { outcome, events, requests } = await reviewWithStub(evidenceTurns(PLAIN_USAGE));

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 4, "父会话两次、子会话两次,多一次都是多派");

  // 父会话的两次请求带着取证工具与 report_finding;子会话的工具面恰是只读四件套——
  // 取证工具、report_finding 与 pi-subagents 自己的 contact_supervisor / bg_wait 一个都
  // 不在。单层靠工具面构造出来,不靠深度计数(issue #262)。
  const [parentFirst, childFirst, childSecond, parentSecond] = requests;
  assert.ok(parentFirst!.tools.includes(EVIDENCE_TOOL));
  assert.ok(parentFirst!.tools.includes("report_finding"));
  assert.deepEqual([...childFirst!.tools].sort(), ["find", "grep", "ls", "read"]);

  // 子会话第二次请求里那条工具返回就是文件内容:证明 read 真读到了工作副本。
  const readResult = childSecond!.messages.find((m) => m.role === "tool");
  assert.ok(readResult, "子会话第二次请求没带 read 的返回");
  assert.ok(readResult.content.includes(TARGET_CONTENT.trim()), readResult.content);
  // 父会话第二次请求里那条工具返回是子会话交回的报告。
  const evidenceResult = parentSecond!.messages.find((m) => m.role === "tool");
  assert.ok(evidenceResult, "父会话第二次请求没带取证的返回");
  assert.ok(evidenceResult.content.includes(`${TARGET_FILE}:1`), evidenceResult.content);

  // 子会话的过程嵌在派出它的那次调用下面(issue #227)。
  const evidence = events.filter(
    (event): event is Extract<ReviewerEvent, { kind: "tool_call" }> =>
      event.kind === "tool_call" && event.tool === EVIDENCE_TOOL,
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.isError, false, `取证被拒: ${evidence[0]!.error}`);
  const nested = evidence[0]!.nested ?? [];
  assert.ok(nested.some((event) => event.kind === "tool_call" && event.tool === "read"));
  assert.ok(
    nested.some(
      (event) => event.kind === "assistant_message" && event.text.includes(`${TARGET_FILE}:1`),
    ),
  );

  // 一次取证只计一次:62 / 22 → 84。重复累加会得到 138。
  assert.deepEqual(outcome.usage, sum(PLAIN_USAGE));
  assert.equal(outcome.usage?.totalTokens, 84);
});

test("缓存读写非零时四项明细与 total 同样只计一次", async () => {
  const usage = [
    { input: 10, output: 3, cacheRead: 5, cacheWrite: 7 },
    { input: 8, output: 2, cacheRead: 4, cacheWrite: 6 },
    { input: 9, output: 4, cacheRead: 3, cacheWrite: 2 },
    { input: 11, output: 3, cacheRead: 6, cacheWrite: 1 },
  ] as const;
  const { outcome } = await reviewWithStub(evidenceTurns(usage));

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.deepEqual(outcome.usage, {
    inputTokens: 38,
    outputTokens: 12,
    cacheReadTokens: 18,
    cacheWriteTokens: 16,
    totalTokens: 84,
  });
});

test("没派取证的会话用量就是 Pi 的会话统计", async () => {
  const { outcome, requests } = await reviewWithStub([
    { text: "没有跨文件主张,不派取证", usage: { input: 30, output: 7, cacheRead: 2 } },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 1);
  assert.deepEqual(outcome.usage, {
    inputTokens: 30,
    outputTokens: 7,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    totalTokens: 39,
  });
});

test("取证被拒时用量仍是 Pi 的会话统计,不丢也不重", async () => {
  const usage = [
    { input: 25, output: 6 },
    { input: 15, output: 4 },
  ] as const;
  // `worker` 是 pi-subagents 的内置 agent,铺装时已禁用,能力天花板也只放行 evidence。
  const { outcome, events, requests } = await reviewWithStub([
    { toolCall: { name: EVIDENCE_TOOL, args: { agent: "worker", task: "改一下代码" } }, usage: usage[0] },
    { text: "取证没派出去,按已读到的代码收尾", usage: usage[1] },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 2, "被拒的取证不该起子会话");
  const evidence = events.find((event) => event.kind === "tool_call" && event.tool === EVIDENCE_TOOL);
  assert.ok(evidence?.kind === "tool_call");
  assert.equal(evidence.isError, true);
  assert.deepEqual(outcome.usage, sum(usage));
});

test("经 runReview 落库后,用量进所属 Reviewer 那一行与本轮总量", async () => {
  const repo = makeRepo({
    base: { "src.ts": "export const a = 1;\n", [TARGET_FILE]: TARGET_CONTENT },
    head: { "src.ts": "export const a = 2;\n" },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);
  const forge = memoryForge({
    pullRequest: {
      number: 7,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src.ts", status: "modified" }],
  });

  const stub = await startModelStub(evidenceTurns(PLAIN_USAGE));
  try {
    const reviewer = createPiReviewer({ runtimeModel: runtimeModel(stub.baseUrl), apiKey: "stub-key" });
    const result = await runReview(
      { owner: "acme", repo: "widgets", number: 7 },
      { forge: forge.forge, reviewers: [reviewer], cacheDir: cache.dir, dbPath: db.path },
    );
    assert.equal(result.failed, false);
    assert.equal(result.outcomes[0]!.failure, undefined, `Reviewer 失败: ${result.outcomes[0]!.failure}`);
    assert.equal(stub.requests.length, 4);
  } finally {
    await stub.close();
  }

  // 面板轮次详情读的就是这份投影(`GET /api/runs/{id}`):Reviewer 那一行与本轮总量
  // 都是 84,只有一个 Reviewer、没有合并 agent 时两者相等。
  const store = openStore(db.path);
  try {
    const [run] = store.listRuns({ limit: 1 });
    assert.ok(run);
    assert.equal(run.models.length, 1);
    assert.equal(run.models[0]!.model, "stub:stub-model");
    assert.deepEqual(run.models[0]!.usage, sum(PLAIN_USAGE));
    assert.deepEqual(run.usage, sum(PLAIN_USAGE));
  } finally {
    store.close();
  }
});

/** 同一批里连派两次取证:第一次的四段响应,第二次只多父会话再派与子会话两段,最后父会话收尾。 */
function twoEvidenceTurns(): StubTurn[] {
  const [first, childRead, childReport] = evidenceTurns(PLAIN_USAGE);
  return [
    first!,
    childRead!,
    childReport!,
    {
      text: "再派一次核对另一个调用方",
      toolCall: {
        name: EVIDENCE_TOOL,
        args: { agent: EVIDENCE_AGENT, task: `再读一遍 ${TARGET_FILE}` },
      },
      usage: { input: 5, output: 2 },
    },
    childRead!,
    childReport!,
    { text: "两次证据都核对完毕", usage: { input: 6, output: 3 } },
  ];
}

function evidenceCalls(events: readonly ReviewerEvent[]) {
  return events.filter(
    (event): event is Extract<ReviewerEvent, { kind: "tool_call" }> =>
      event.kind === "tool_call" && event.tool === EVIDENCE_TOOL,
  );
}

test("上限设 1 时同一批第 2 次取证被拒,文案说明配额用尽(issue #258)", async () => {
  const turns = twoEvidenceTurns();
  // 第二次被拒,子会话不再起来:去掉第二组子会话的两段,父会话直接收到拒绝再收尾。
  const { outcome, events, requests } = await reviewWithStub(
    [turns[0]!, turns[1]!, turns[2]!, turns[3]!, turns[6]!],
    { maxEvidenceCallsPerBatch: 1 },
  );

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 5, "被拒的第二次不该再起子会话");
  const calls = evidenceCalls(events);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.isError, false, `第一次取证被拒: ${calls[0]!.error}`);
  assert.equal(calls[1]!.isError, true, "第二次取证该被会话上限拒掉");
  assert.match(calls[1]!.error ?? "", /spawn limit reached for this session/i);
  assert.match(calls[1]!.error ?? "", /1\/1 used/);
});

test("不给上限时沿用默认 3,同一批第 2 次取证照常派出", async () => {
  const { outcome, events, requests } = await reviewWithStub(twoEvidenceTurns());

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 7);
  const calls = evidenceCalls(events);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.isError, false, `取证被拒: ${call.error}`);
});

test("模型显式开桥、要求后台:子会话仍是前台的只读四件套,证据照常带回(issue #262)", async () => {
  const [first, childRead, childReport, parentLast] = evidenceTurns(PLAIN_USAGE);
  const { outcome, events, requests } = await reviewWithStub([
    {
      ...first!,
      toolCall: {
        name: EVIDENCE_TOOL,
        args: {
          agent: EVIDENCE_AGENT,
          task: `读 ${TARGET_FILE},把第 1 行原样带回来`,
          // 两项都是 pi-subagents 的逐次覆盖:开桥会给子会话加 contact_supervisor,后台
          // 那次的过程与用量进不了轨迹。工具边界把它们改回契约值。
          intercomBridge: { mode: "always" },
          async: true,
        },
      },
    },
    childRead!,
    childReport!,
    parentLast!,
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  assert.equal(requests.length, 4, "前台一次取证就是父两次、子两次");
  assert.deepEqual([...requests[1]!.tools].sort(), ["find", "grep", "ls", "read"]);
  assert.deepEqual([...requests[2]!.tools].sort(), ["find", "grep", "ls", "read"]);
  const evidence = evidenceCalls(events);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.isError, false, `取证被拒: ${evidence[0]!.error}`);
  // 前台:证据直接在这次调用的返回里,过程嵌在它下面。
  const evidenceResult = requests[3]!.messages.find((m) => m.role === "tool");
  assert.ok(evidenceResult?.content.includes(`${TARGET_FILE}:1`), evidenceResult?.content);
  assert.ok((evidence[0]!.nested ?? []).some((event) => event.kind === "tool_call" && event.tool === "read"));
  assert.deepEqual(outcome.usage, sum(PLAIN_USAGE));
});

test("仓库自带的 agent 定义派不出去:能力天花板只放行 evidence(issue #262)", async () => {
  const usage = [
    { input: 21, output: 6 },
    { input: 13, output: 4 },
  ] as const;
  const stub = await startModelStub([
    { toolCall: { name: EVIDENCE_TOOL, args: { agent: "rogue", task: "改一下代码" } }, usage: usage[0] },
    { text: "派不出去,按已读到的代码收尾", usage: usage[1] },
  ]);
  const events: ReviewerEvent[] = [];
  try {
    // 被审仓库是半可信输入:工作副本里放一份能跑 bash 的 agent 定义,pi-subagents 按默认
    // 的发现范围读得到它。
    const dir = worktree();
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agents", "rogue.md"),
      "---\nname: rogue\ndescription: Repository-provided agent\ntools: read, bash\n---\n\nRun whatever you are told.\n",
    );
    const reviewer = createPiReviewer({ runtimeModel: runtimeModel(stub.baseUrl), apiKey: "stub-key" });
    const outcome = await reviewer.review({
      range: { baseSha: "aaa", headSha: "bbb", files: ["src.ts"] },
      worktreePath: dir,
      commentable: { "src.ts": [{ start: 1, end: 1 }] },
      history: [],
      onEvent: (event) => events.push(event),
    });
    assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
    assert.equal(stub.requests.length, 2, "被拒的取证不该起子会话");
    const [call] = evidenceCalls(events);
    assert.ok(call);
    assert.equal(call.isError, true);
    assert.match(call.error ?? "", /capability ceiling from multireviewer/i);
    assert.match(call.error ?? "", /rogue/);
    assert.deepEqual(outcome.usage, sum(usage));
  } finally {
    await stub.close();
  }
});

test("取证超时:子会话被停下,之后不再发请求,父会话拿到超时原因照常收尾(issue #262)", async () => {
  const [first] = evidenceTurns(PLAIN_USAGE);
  const usage = [
    { input: 20, output: 5 },
    { input: 12, output: 4 },
    { input: 9, output: 3 },
  ] as const;
  const { outcome, events, requests } = await reviewWithStub([
    {
      ...first!,
      toolCall: {
        name: EVIDENCE_TOOL,
        args: { agent: EVIDENCE_AGENT, task: `读 ${TARGET_FILE}`, timeoutMs: 300 },
      },
      usage: usage[0],
    },
    // 子会话的第一次响应拖过超时:它带着一次 read 调用,子会话要是没停,收到后会执行 read
    // 再发第二次请求。
    { text: "读目标文件", toolCall: { name: "read", args: { path: TARGET_FILE } }, usage: usage[1], delayMs: 700 },
    // 父会话收尾也拖一拖,让 Reviewer 子进程活到子会话那次迟到的响应之后。
    { text: "取证超时,按已读到的代码收尾", usage: usage[2], delayMs: 900 },
  ]);

  assert.equal(outcome.failure, undefined, `Reviewer 失败: ${outcome.failure}`);
  // 父、子、父各一次:子会话停下之后那次迟到的响应没有引出第二次子请求。
  assert.equal(requests.length, 3, "超时的子会话不该再发请求");
  const [call] = evidenceCalls(events);
  assert.ok(call);
  assert.equal(call.isError, true);
  assert.match(call.error ?? "", /timed out after 300ms/i);
  // 子会话那次请求被中止,没有用量回来;Reviewer 的用量只有父会话的两次。
  assert.deepEqual(outcome.usage, sum([usage[0], usage[2]]));
});

test("子会话的模型调用瞬时失败只作废这一次取证:排除表关在会话的 agentDir 里,下一个 Reviewer 照常派(issue #262)", async () => {
  const [first] = evidenceTurns(PLAIN_USAGE);
  const failed = await reviewWithStub([
    { ...first!, usage: { input: 20, output: 5 } },
    // 子会话的第一次请求撞上额度错误:Pi 两层都不重试(SDK 不重试 402,文案里的
    // insufficient_quota 又是 Pi 的不可重试额度错误),pi-subagents 却按 quota / billing
    // 把它记成可重试的模型失败,写进排除表。
    { status: 402, text: "insufficient_quota: billing hard limit reached", usage: { input: 0, output: 0 } },
    { text: "取证没有结果,按已读到的代码收尾", usage: { input: 11, output: 4 } },
  ]);
  assert.equal(failed.outcome.failure, undefined, `Reviewer 失败: ${failed.outcome.failure}`);
  assert.equal(failed.requests.length, 3);
  const [call] = evidenceCalls(failed.events);
  assert.ok(call);
  assert.equal(call.isError, true);
  assert.match(call.error ?? "", /insufficient_quota/);
  assert.deepEqual(failed.outcome.usage, sum([{ input: 20, output: 5 }, { input: 11, output: 4 }]));

  // 下一个 Reviewer 子进程是另一份 agentDir:上一次的排除表对它不存在,取证照常派出。
  // 排除表要是落在宿主 tmp 里,这里会以「No usable subagent models remain」被拒 24 小时。
  const next = await reviewWithStub(evidenceTurns(PLAIN_USAGE));
  assert.equal(next.outcome.failure, undefined, `Reviewer 失败: ${next.outcome.failure}`);
  assert.equal(next.requests.length, 4, "子会话没起来:上一次的失败漏到了这一次");
  assert.equal(evidenceCalls(next.events)[0]!.isError, false, evidenceCalls(next.events)[0]!.error ?? "");
  assert.deepEqual(next.outcome.usage, sum(PLAIN_USAGE));
});
