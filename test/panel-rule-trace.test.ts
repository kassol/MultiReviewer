/**
 * 知识轨迹(CONTEXT.md,issue #214)。
 *
 * 两条缝:SQLite 临时库验任务分配、序号、续读与级联;面板 API 走真实 HTTP 验基点探索与
 * 处置反哺各留下一条轨迹、提案回溯得到自己那一条、可见性与知识集读侧一致、以及结束之后
 * 连流回放完就发结束信号。规则 agent 仍用脚本化实现注入,与 issue #205 / #208 同一个位置。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem } from "../src/reviewer/rule-agent.ts";
import { confirmEmptyRuleSet, makeDbPath } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startReadyPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const AT = "2026-08-29T00:00:00.000Z";
const PASSWORD = "rule-trace-test-password";

type TraceEventResponse = { seq: number; taskId: number; at: string; kind: string; payload: Record<string, unknown> };

type ExplorationResponse = { state: string; traceTaskId: number | null };
type ProposalResponse = { id: number; statement: string; source: string; traceTaskId: number | null };
type RuleSetResponse = { exploration: ExplorationResponse | null; proposals: ProposalResponse[] };

/** 一个走完探索或反哺全程的脚本化 agent:说一段话、调一次工具、提一条规则。 */
function narratingRuleAgent(items: readonly RuleAgentItem[]): RuleAgent {
  return async (request) => {
    request.onEvent?.({ kind: "assistant_message", text: "先读一遍仓库文档" });
    request.onEvent?.({
      kind: "tool_call",
      tool: "grep",
      args: { pattern: "export function" },
      durationMs: 12,
      isError: false,
      error: null,
      resultLength: 40,
    });
    for (const item of items) request.onEvent?.({ kind: "rule_proposed", item });
    return { items: [...items] };
  };
}

async function ruleSet(h: PanelHarness): Promise<RuleSetResponse> {
  const response = await h.api("GET", `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(response.status, 200);
  return (await response.json()) as RuleSetResponse;
}

async function traceEvents(h: PanelHarness, taskId: number): Promise<TraceEventResponse[]> {
  const response = await h.api("GET", `/repos/${GITEA_REPO.id}/rule-traces/${taskId}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { events: TraceEventResponse[] }).events;
}

test("知识轨迹的任务分号、续读与级联", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 90, owner: "acme", repo: "traced", generation: 1, key: "k" }),
      true,
    );
    const first = store.startRuleTrace(90, "baseline-exploration", { model: "test:m" });
    const second = store.startRuleTrace(90, "disposition-feedback", { note: "备注原文" });
    // 两条轨迹各自一份序号,互不干扰。
    assert.notEqual(first, second);
    assert.equal(store.listRuleTrace(first).length, 1);
    assert.equal(store.listRuleTrace(first)[0]!.kind, "rule_agent_started");

    const appended = store.appendRuleTrace(first, {
      kind: "assistant_message",
      payload: { text: "说了一段" },
    });
    assert.equal(appended.seq, 2);
    assert.equal(appended.taskId, first);
    store.appendRuleTrace(first, { kind: "rule_agent_finished", payload: { items: 0 } });
    assert.deepEqual(
      store.listRuleTrace(first).map((event) => event.seq),
      [1, 2, 3],
    );
    // 断线续传按序号续。
    assert.deepEqual(
      store.listRuleTrace(first, 2).map((event) => event.kind),
      ["rule_agent_finished"],
    );
    assert.equal(store.listRuleTrace(second).length, 1);

    // 探索与它的轨迹显式关联(issue #214):写进 `rule_exploration` 那一行的就是这一次的
    // 轨迹,不按「这个仓库最近一条探索轨迹」反推。
    assert.equal(
      store.startRuleExploration(90, {
        baselineSha: "abc1234",
        model: "test:m",
        startedAt: "2026-08-29T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(store.getRuleExploration(90)?.traceTaskId, null);
    store.setRuleExplorationTrace(90, first);
    assert.equal(store.getRuleExploration(90)?.traceTaskId, first);
    // 重新探索是另一次任务:上一次的轨迹标识不留在这一行上,这一次轨迹起头失败时因此
    // 不会把上一次的过程挂到它名下。
    store.failRuleExploration(90, "停下", "2026-08-29T00:10:00.000Z");
    assert.equal(
      store.startRuleExploration(90, {
        baselineSha: "def5678",
        model: "test:m2",
        startedAt: "2026-08-29T01:00:00.000Z",
      }),
      true,
    );
    assert.equal(store.getRuleExploration(90)?.traceTaskId, null);

    assert.equal(store.ruleTraceRepo(first), 90);
    assert.equal(store.ruleTraceRepo(9999), undefined);

    // 知识集跟着仓库走,轨迹同理。
    store.removeRepo(90);
    assert.equal(store.listRuleTrace(first).length, 0);
    assert.equal(store.getRuleExploration(90), null);
  } finally {
    store.close();
  }
});

test("一次基点探索留下一条轨迹:说的话、调的工具与提出的条目都在,知识集读得到它", async () => {
  const h = await startReadyPanelHarness(cleanups, {
    ruleAgent: narratingRuleAgent([{ type: "rule", scope: "", statement: "公开函数要有类型标注" }]),
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  await h.worktreesPreparedAtLeast(1);
  const started = await h.api("POST", `/repos/${GITEA_REPO.id}/rule-exploration`, {
    baseline: h.repo.headSha,
    provider: "test",
    model: "global-model",
  });
  assert.equal(started.status, 202);
  await h.explorationsAtLeast(1);

  const view = await ruleSet(h);
  const taskId = view.exploration?.traceTaskId ?? null;
  assert.notEqual(taskId, null);

  const events = await traceEvents(h, taskId!);
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "rule_agent_started",
      "assistant_message",
      "tool_call",
      "rule_proposed",
      "rule_agent_finished",
    ],
  );
  assert.equal(events[0]!.payload["source"], "baseline-exploration");
  assert.equal(events[0]!.payload["baselineSha"], h.repo.headSha);
  assert.equal(events[1]!.payload["text"], "先读一遍仓库文档");
  assert.equal(events[2]!.payload["tool"], "grep");
  assert.deepEqual(events[2]!.payload["args"], { pattern: "export function" });
  // 条目事件带 type(issue #222):面板轨迹里要说得出这一条提的是规则还是事实。
  assert.deepEqual(events[3]!.payload["item"], {
    type: "rule",
    scope: "",
    statement: "公开函数要有类型标注",
  });

  // 跑完之后连流:回放完直接收到结束信号,不挂着等。
  const stream = await fetch(
    `${h.serverUrl}/api/repos/${GITEA_REPO.id}/rule-traces/${taskId}/stream?after=4`,
    { headers: { cookie: h.cookie } },
  );
  assert.equal(stream.status, 200);
  const body = await stream.text();
  assert.match(body, /event: trace/);
  assert.match(body, /rule_agent_finished/);
  assert.match(body, /event: end/);
  // 已经读过的那几条不再回放。
  assert.equal(body.includes("assistant_message"), false);
});

test("一次处置反哺留下一条轨迹,提案回溯得到它", async () => {
  const items: RuleAgentItem[] = [
    { type: "rule", scope: "", statement: "边界上一次判掉越界" },
  ];
  const h = await startReadyPanelHarness(cleanups, {
    ruleAgent: narratingRuleAgent(items),
    buildReviewers: reportingReviewers,
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);

  const runs = (await (await h.api("GET", "/runs")).json()) as {
    runs: { findings: { id: number; commentId: string | null }[] }[];
  };
  const finding = runs.runs.flatMap((run) => run.findings).find((row) => row.commentId !== null);
  assert.notEqual(finding, undefined);
  assert.equal(
    (await h.api("POST", `/findings/${finding!.id}/resolve`, { note: "这类越界要在边界上判" }))
      .status,
    200,
  );
  await h.dispositionFeedbackAtLeast(1);

  const view = await ruleSet(h);
  const proposal = view.proposals.find((row) => row.source === "disposition-feedback");
  assert.notEqual(proposal, undefined);
  assert.notEqual(proposal!.traceTaskId, null);

  const events = await traceEvents(h, proposal!.traceTaskId!);
  assert.equal(events[0]!.kind, "rule_agent_started");
  assert.equal(events[0]!.payload["source"], "disposition-feedback");
  assert.equal(events[0]!.payload["note"], "这类越界要在边界上判");
  assert.equal(events.at(-1)!.kind, "rule_agent_finished");
});

test("知识轨迹的可见性与知识集读侧一致:分配外 404,别的仓库的任务也 404", async () => {
  const h = await startReadyPanelHarness(cleanups, {
    ruleAgent: narratingRuleAgent([]),
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  const store = openStore(h.db.path);
  let taskId: number;
  try {
    taskId = store.startRuleTrace(GITEA_REPO.id, "baseline-exploration", { model: "test:m" });
    store.createPanelUser({
      username: "outsider",
      displayName: null,
      passwordHash: await hashPassword(PASSWORD),
      mustChangePassword: false,
      createdAt: AT,
      isSystemAdmin: false,
      roleId: null,
    });
    store.setPanelUserAssignment("outsider", []);
  } finally {
    store.close();
  }
  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "outsider", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const denied = await fetch(
    `${h.serverUrl}/api/repos/${GITEA_REPO.id}/rule-traces/${taskId}`,
    { headers: { cookie } },
  );
  assert.equal(denied.status, 404);

  // 分到了仓库的人读得到它,但读不到挂在别处的任务。
  const mine = await h.api("GET", `/repos/${GITEA_REPO.id}/rule-traces/${taskId}`);
  assert.equal(mine.status, 200);
  const other = await h.api("GET", `/repos/${GITEA_REPO.id}/rule-traces/${taskId + 1}`);
  assert.equal(other.status, 404);
});

/** 两条落在 diff 里的 Finding,各自一条行级评论:处置要有可处置的载体。 */
const reportingReviewers: NonNullable<PanelHarnessOptions["buildReviewers"]> = (plans) =>
  plans.map((plan) =>
    scriptedReviewer(plan.spec.model, [
      {
        file: "src/answer.ts",
        line: 1,
        severity: "P1",
        category: "bug",
        description: "这里会越界",
      },
    ]),
  );
