/**
 * 修订意图与无目标的人工提议(ADR 0028,issue #294)。
 *
 * 一条缝:提交端点走真实 HTTP,一条意图排一次后台解读,产出经与处置反哺同一套映射入队,
 * 出处标人工提议、备注原文放意图、依据放 agent 的理由;知识集未确认的仓库产出追加进
 * 草案。规则 agent 仍用脚本化实现注入,与反哺同一个位置;后台任务的结束等服务自己发的
 * 回调,不猜时序。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem, RuleAgentRequest } from "../src/reviewer/rule-agent.ts";
import { confirmEmptyRuleSet, makeDbPath, testCleanups } from "./support/git-fixture.ts";
import { scriptedReviewer, scriptedRuleAgent as scriptedRuleAgentRow } from "./support/memory-forge.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  scopedUser,
  seedAvailableModelService,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { putGlobalSettings, seedReviewRule } from "./support/store-seed.ts";

const cleanups = testCleanups();

const INTENT = "api 目录下的处理器都要先做入参校验";

type IntentRow = {
  id: number;
  text: string;
  submittedBy: string;
  targetKind: "none" | "rule" | "proposal" | "draft" | "finding";
  targetId: number | null;
  state: "running" | "failed" | "completed";
  failure: string | null;
  summary: string | null;
  model: string | null;
  traceTaskId: number | null;
  produced: { proposalIds: number[]; draftItemIds: number[] };
  finishedAt: string | null;
};

type ProposalRow = {
  id: number;
  type: "rule" | "fact";
  change: "add" | "modify" | "retire" | "merge";
  targetRuleIds: number[];
  scope: string;
  statement: string;
  sources: {
    origin:
      | "baseline-exploration"
      | "disposition-feedback"
      | "knowledge-consolidation"
      | "manual-proposal";
    note: string | null;
    evidence: string | null;
    findingId: number | null;
    traceTaskId: number | null;
  }[];
  state: "pending" | "accepted" | "rejected";
};

type RuleSetView = {
  version: number | null;
  rules: { id: number; statement: string }[];
  draft: { id: number; type: string; scope: string; statement: string; origin: string }[];
  proposals: ProposalRow[];
  intents: IntentRow[];
};

/** 脚本化规则 agent,记下每次收到的任务。产出由回调给出:现集的标识建库之后才知道。 */
function scriptedRuleAgent(
  produce: () => { items: RuleAgentItem[]; failure?: string },
  narrate?: string,
): RuleAgent & { calls: RuleAgentRequest[] } {
  return scriptedRuleAgentRow(produce, { emitEvents: true, ...(narrate === undefined ? {} : { narrate }) });
}

/** 一个已注册的仓库。`confirmed` 为 true 即知识集已确认(空集)。 */
async function harnessWithRepo(
  ruleAgent: RuleAgent,
  confirmed = true,
): Promise<PanelHarness> {
  const h = await startReadyPanelHarness({ ruleAgent });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  if (confirmed) confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  return h;
}

async function ruleSet(h: PanelHarness): Promise<RuleSetView> {
  const response = await h.api("GET", `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(response.status, 200);
  return (await response.json()) as RuleSetView;
}

function submit(h: PanelHarness, body: unknown): Promise<Response> {
  return h.api("POST", `/repos/${GITEA_REPO.id}/revision-intents`, body);
}

/** 提交一条意图并等它跑完,回意图行的标识。 */
async function submitAndSettle(h: PanelHarness, text = INTENT): Promise<number> {
  const response = await submit(h, { text });
  assert.equal(response.status, 202);
  const intent = (await response.json()) as IntentRow;
  await h.revisionIntentsAtLeast(1);
  return intent.id;
}

/** 这个仓库知识轨迹上的事件,按落库顺序。没有列表端点,直接读库。 */
function ruleTraceRows(h: PanelHarness): { source: string; kind: string; payload: string }[] {
  const db = new DatabaseSync(h.db.path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT source, kind, payload FROM rule_trace WHERE repo_id = ? ORDER BY task_id, seq",
      )
      .all(GITEA_REPO.id)
      .map((row) => ({
        source: String(row["source"]),
        kind: String(row["kind"]),
        payload: String(row["payload"]),
      }));
  } finally {
    db.close();
  }
}

test("无目标意图:agent 拿到意图与现集,产出入队并带人工提议附注", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }), "已按 api 目录的现状定下作用范围");
  const h = await harnessWithRepo(agent);

  // 现集里先有一条:意图提的是对照它的变更,agent 因此要看得到它。
  const store = openStore(h.db.path);
  let ruleId: number;
  try {
    assert.notEqual(
      seedReviewRule(h.db.path, GITEA_REPO.id, {
        type: "rule",
        scope: "",
        statement: "入参要在边界上校验",
      }),
      undefined,
    );
    ruleId = store.getRuleSet(GITEA_REPO.id)!.rules[0]!.id;
  } finally {
    store.close();
  }
  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的处理器先校验入参再执行",
      reason: "  三个处理器都在开头校验  ",
    },
  ];

  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  // agent 拿到的是意图原文、无目标、现集与队列。
  assert.equal(agent.calls.length, 1);
  const request = agent.calls[0]!;
  assert.equal(request.intent?.text, INTENT);
  assert.deepEqual(request.intent?.target, { kind: "none" });
  assert.deepEqual(
    request.existingKnowledge.map((entry) => entry.id),
    [ruleId],
  );
  assert.deepEqual(request.pendingProposals, []);
  // 工作副本停在默认分支当前 head 上。夹具仓库的默认分支是 `main`,它指向 `baseSha`;
  // PR 的 head 在 `feature` 上,这一条因此同时证明它读的不是 PR 那一端。
  assert.equal(request.baselineSha, h.repo.baseSha);

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.change, "add");
  assert.equal(proposal.statement, "api 目录下的处理器先校验入参再执行");
  assert.equal(proposal.scope, "src/api/**");
  assert.equal(proposal.sources.length, 1);
  // 来源第四值,备注原文是意图,依据是 agent 的理由(去掉首尾空白)。
  assert.equal(proposal.sources[0]!.origin, "manual-proposal");
  assert.equal(proposal.sources[0]!.note, INTENT);
  assert.equal(proposal.sources[0]!.evidence, "三个处理器都在开头校验");
  assert.equal(proposal.sources[0]!.findingId, null);

  // 意图行完成,收尾是 agent 最后一段话,产出记下那条提案。
  const intent = view.intents.find((row) => row.id === intentId)!;
  assert.equal(intent.state, "completed");
  assert.equal(intent.summary, "已按 api 目录的现状定下作用范围");
  assert.deepEqual(intent.produced, { proposalIds: [proposal.id], draftItemIds: [] });
  assert.equal(intent.targetKind, "none");
  assert.equal(intent.targetId, null);
  assert.equal(intent.submittedBy, "panel-admin");
  // 轨迹来源同样是人工提议,附注与意图行指向同一条。
  assert.notEqual(intent.traceTaskId, null);
  assert.equal(proposal.sources[0]!.traceTaskId, intent.traceTaskId);
  const trace = ruleTraceRows(h);
  assert.ok(trace.length > 0);
  assert.ok(trace.every((row) => row.source === "manual-proposal"));
  assert.deepEqual(
    trace.map((row) => row.kind),
    ["rule_agent_started", "assistant_message", "rule_proposed", "rule_agent_finished"],
  );
});

test("agent 指名并入队列里已有的那一条:队列条数不变,附注多一条", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);

  const store = openStore(h.db.path);
  let queued: number;
  try {
    queued = store.addRuleProposal(GITEA_REPO.id, {
      type: "rule",
      change: "add",
      targetRuleIds: [],
      scope: "src/api/**",
      statement: "处理器要校验入参",
      sources: [
        {
          origin: "baseline-exploration",
          note: null,
          evidence: null,
          findingId: null,
          traceTaskId: null,
        },
      ],
    })!;
  } finally {
    store.close();
  }
  items = [
    {
      type: "rule",
      scope: "",
      statement: "api 目录下的处理器先校验入参再执行",
      proposalId: queued,
      reason: "与队列里那条说的是一件事",
    },
  ];

  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.id, queued);
  // 陈述换成合成后的那一句,作用范围与型不随并入改。
  assert.equal(proposal.statement, "api 目录下的处理器先校验入参再执行");
  assert.equal(proposal.scope, "src/api/**");
  assert.deepEqual(
    proposal.sources.map((source) => [source.origin, source.note]),
    [
      ["baseline-exploration", null],
      ["manual-proposal", INTENT],
    ],
  );
  const intent = view.intents.find((row) => row.id === intentId)!;
  assert.deepEqual(intent.produced, { proposalIds: [queued], draftItemIds: [] });
});

test("知识集未确认:产出追加进草案,原有草案条目留着", async () => {
  const agent = scriptedRuleAgent(() => ({
    items: [{ type: "fact", scope: "src/api/**", statement: "全局拦截器覆盖了这一层" }],
  }));
  const h = await harnessWithRepo(agent, false);

  const store = openStore(h.db.path);
  try {
    // 探索产出的那一条:草案手填已经撤掉(issue #299),原有条目只会是探索或意图落的。
    store.finishRuleExploration(
      GITEA_REPO.id,
      [{ type: "rule", scope: "", statement: "草案里原有的" }],
      "2026-09-08T00:00:00.000Z",
    );
  } finally {
    store.close();
  }

  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.version, null);
  assert.deepEqual(
    view.draft.map((item) => [item.statement, item.origin]),
    [
      ["草案里原有的", "baseline-exploration"],
      ["全局拦截器覆盖了这一层", "manual-proposal"],
    ],
  );
  assert.equal(view.proposals.length, 0);
  const intent = view.intents.find((row) => row.id === intentId)!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, {
    proposalIds: [],
    draftItemIds: [view.draft[1]!.id],
  });
});

test("未确认仓库上的处置反哺:产出排进提案队列,草案一字不动", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await startReadyPanelHarness({
    ruleAgent: agent,
    buildReviewers: (plans) =>
      plans.map((plan) =>
        scriptedReviewer(plan.spec.model, [
          { file: "src/answer.ts", line: 1, severity: "P1", category: "bug", description: "这里会越界" },
        ]),
      ),
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  // 门禁挡的是没确认过知识集的仓库(issue #206),要有一条可处置的 Finding 就得先确认、
  // 跑一轮。这条用例要的是「有 Finding 而知识集未确认」那一档,因此跑完再把那一版删掉。
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  const db = new DatabaseSync(h.db.path);
  try {
    db.prepare("DELETE FROM rule_set_version WHERE repo_id = ?").run(GITEA_REPO.id);
  } finally {
    db.close();
  }

  const store = openStore(h.db.path);
  try {
    // 草案里先有一条探索产出的:反哺不该动它。
    store.finishRuleExploration(
      GITEA_REPO.id,
      [{ type: "rule", scope: "", statement: "草案里原有的" }],
      "2026-09-08T00:00:00.000Z",
    );
  } finally {
    store.close();
  }

  const runs = (await (await h.api("GET", "/runs")).json()) as {
    runs: { findings: { id: number; commentId: string | null }[] }[];
  };
  const finding = runs.runs
    .flatMap((run) => run.findings)
    .find((row) => row.commentId !== null)!;
  assert.notEqual(finding, undefined);

  const note = "这类越界要在边界上一次判掉,不要每处再判";
  items = [{ type: "rule", scope: "src/**", statement: "边界上一次判空", reason: "越界在三处都有" }];
  assert.equal((await h.api("POST", `/findings/${finding.id}/resolve`, { note })).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.version, null);
  // 反哺的产出排进队列并标处置反哺,草案还是探索留下的那一条。
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.statement, "边界上一次判空");
  assert.deepEqual(
    proposal.sources.map((source) => [source.origin, source.note]),
    [["disposition-feedback", note]],
  );
  assert.deepEqual(
    view.draft.map((item) => [item.statement, item.origin]),
    [["草案里原有的", "baseline-exploration"]],
  );
  const intent = view.intents.find((row) => row.targetKind === "finding")!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, { proposalIds: [proposal.id], draftItemIds: [] });
});

test("陈述超过 100 字的产出被丢弃并记轨迹,意图仍完成", async () => {
  const agent = scriptedRuleAgent(() => ({
    items: [
      { type: "rule", scope: "", statement: "太".repeat(101) },
      { type: "rule", scope: "", statement: "留得下的那一条" },
    ],
  }));
  const h = await harnessWithRepo(agent);

  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.deepEqual(
    view.proposals.map((proposal) => proposal.statement),
    ["留得下的那一条"],
  );
  assert.equal(view.intents.find((row) => row.id === intentId)!.state, "completed");
  const dropped = ruleTraceRows(h).filter((row) => row.kind === "rule_proposal_dropped");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.payload, /陈述超过 100 字/);
});

test("零产出是完成,收尾写「未产出变更」", async () => {
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 0);
  const intent = view.intents.find((row) => row.id === intentId)!;
  assert.equal(intent.state, "completed");
  assert.equal(intent.summary, "未产出变更");
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [] });
});

test("agent 失败:意图行失败并带原因,队列一条不加", async () => {
  const h = await harnessWithRepo(
    scriptedRuleAgent(() => ({ items: [], failure: "模型调用被拒" })),
  );
  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, "模型调用被拒");

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 0);
  const intent = view.intents.find((row) => row.id === intentId)!;
  assert.equal(intent.state, "failed");
  assert.equal(intent.failure, "模型调用被拒");
  assert.equal(intent.summary, null);
});

test("提交校验:空、超长、分配外仓库各回自己那一档", async () => {
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));

  assert.equal((await submit(h, { text: "   " })).status, 400);
  assert.equal((await submit(h, {})).status, 400);
  assert.equal((await submit(h, { text: "字".repeat(501) })).status, 400);
  // 500 字整收下:上限是「不能超过」。
  const ok = await submit(h, { text: "字".repeat(500) });
  assert.equal(ok.status, 202);
  await h.revisionIntentsAtLeast(1);
  // 还没放开的目标类型仍 400:Finding 那一档由处置那一侧自己建行,不由人在这里提。
  assert.equal((await submit(h, { text: INTENT, target: { kind: "finding", id: 1 } })).status, 400);
  // 不在注册表里的仓库与分配外同形:404。
  assert.equal(
    (await h.api("POST", "/repos/999999/revision-intents", { text: INTENT })).status,
    404,
  );
});

test("选不出辅助模型时提交回 409,那句话指向两处配置", async () => {
  // 没有辅助模型、也没有全局模型组合:解析三级都给不出。注册要过「审查配置就绪」那道
  // 门禁,组合因此在注册之后才清掉。
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  const raw = new DatabaseSync(h.db.path);
  try {
    raw.prepare("DELETE FROM global_setting WHERE key = ?").run("reviewers");
  } finally {
    raw.close();
  }

  const response = await submit(h, { text: INTENT });
  assert.equal(response.status, 409);
  const error = ((await response.json()) as { error: string }).error;
  assert.match(error, /审查策略/);
  assert.match(error, /仓库配置/);
});

test("意图用这个仓库生效的辅助模型:与只读投影说的是同一处", async () => {
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  // 意图框读的就是这一份投影(issue #304),知识集读取不再另回一格模型。
  const view = await h.api("GET", `/repos/${GITEA_REPO.id}/auxiliary-model`);
  assert.equal(view.status, 200);
  assert.deepEqual(await view.json(), {
    identity: "test:global-model",
    thinkingLevel: null,
    source: "first-reviewer",
    available: true,
    unavailableReason: null,
  });
  assert.deepEqual((await ruleSet(h)).intents, []);

  assert.equal((await submit(h, { text: INTENT })).status, 202);
  await h.revisionIntentsAtLeast(1);
  const [intent] = (await ruleSet(h)).intents;
  assert.equal(intent!.model, "test:global-model");
});

test("删除意图:完成行与失败行删得掉,运行中 409,不存在 404", async () => {
  // agent 停在这里,意图因此停在运行中,直到用例放行。
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harnessWithRepo(async () => {
    await held;
    return { items: [] };
  });

  const running = (await submit(h, { text: INTENT })).json() as Promise<IntentRow>;
  const runningId = (await running).id;
  assert.equal(
    (await h.api("DELETE", `/repos/${GITEA_REPO.id}/revision-intents/${runningId}`)).status,
    409,
  );
  assert.equal(
    (await h.api("DELETE", `/repos/${GITEA_REPO.id}/revision-intents/999999`)).status,
    404,
  );

  release();
  await h.revisionIntentsAtLeast(1);
  assert.equal(
    (await h.api("DELETE", `/repos/${GITEA_REPO.id}/revision-intents/${runningId}`)).status,
    200,
  );
  assert.deepEqual((await ruleSet(h)).intents, []);
});

test("重启:停在运行中的意图改判失败", async () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 71, owner: "acme", repo: "legacy", generation: 1, key: "k" });
    assert.notEqual(
      store.startRuleIntent(71, {
        text: "跑一半就重启了",
        submittedBy: "someone",
        targetKind: "none",
        targetId: null,
        model: "test:global-model",
        startedAt: "2026-09-08T00:00:00.000Z",
      }),
      undefined,
    );
    // 反哺那一行同样是意图行,改判因此一并覆盖它(issue #296)。
    assert.notEqual(
      store.startRuleIntent(71, {
        text: "处置备注也跑了一半",
        submittedBy: "someone",
        targetKind: "finding",
        targetId: 9,
        model: "test:global-model",
        startedAt: "2026-09-08T00:00:30.000Z",
      }),
      undefined,
    );
  } finally {
    store.close();
  }

  const restarted = openStore(db.path);
  try {
    restarted.failInterruptedRuleIntents("服务重启,上一次提议没跑完", "2026-09-08T01:00:00.000Z");
    const listed = restarted.listRuleIntents(71);
    assert.deepEqual(
      listed.map((row) => [row.targetKind, row.state, row.failure, row.finishedAt]),
      [
        ["finding", "failed", "服务重启,上一次提议没跑完", "2026-09-08T01:00:00.000Z"],
        ["none", "failed", "服务重启,上一次提议没跑完", "2026-09-08T01:00:00.000Z"],
      ],
    );
  } finally {
    restarted.close();
  }
});

test("完成很久的意图仍列出,运行中与失败排在完成的前面", async () => {
  // 列表是这个仓库的全部意图(issue #317):处置时写的备注去了哪里,多久以后都查得到。
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 72, owner: "acme", repo: "legacy", generation: 1, key: "k" });
    const start = (text: string, startedAt: string): number =>
      store.startRuleIntent(72, {
        text,
        submittedBy: "someone",
        targetKind: "none",
        targetId: null,
        model: "test:global-model",
        startedAt,
      })!.id;
    const old = start("早就跑完了", "2026-09-01T00:00:00.000Z");
    store.finishRuleIntent(
      old,
      { summary: "已产出一条", produced: { proposalIds: [3], draftItemIds: [] } },
      "2026-09-01T00:01:00.000Z",
    );
    const failed = start("跑失败了", "2026-09-02T00:00:00.000Z");
    store.failRuleIntent(failed, "模型调用被拒", "2026-09-02T00:01:00.000Z");
    start("还在跑", "2026-09-03T00:00:00.000Z");
    // 开始得最晚的这一条已经完成:它排在运行中与失败之后,而不是按开始时刻排到最前。
    const recent = start("刚跑完", "2026-09-08T00:00:00.000Z");
    store.finishRuleIntent(
      recent,
      { summary: "未产出变更", produced: { proposalIds: [], draftItemIds: [] } },
      "2026-09-08T00:01:00.000Z",
    );

    const listed = store.listRuleIntents(72);
    assert.deepEqual(
      listed.map((row) => [row.text, row.state]),
      [
        ["还在跑", "running"],
        ["跑失败了", "failed"],
        ["刚跑完", "completed"],
        ["早就跑完了", "completed"],
      ],
    );
    assert.deepEqual(listed.at(-1)!.produced, { proposalIds: [3], draftItemIds: [] });
  } finally {
    store.close();
  }
});

/**
 * 目标为一条待裁决提案的修订意图(issue #295)。改写在原地发生:陈述与作用范围换新,
 * 附注追加一条,队列条数不变;型沿既有映射,废止型没有改写入口。
 */

/** 现集里加一条,回它的标识。 */
function seedRule(
  h: PanelHarness,
  rule: { type: "rule" | "fact"; scope: string; statement: string },
): number {
  const store = openStore(h.db.path);
  try {
    assert.notEqual(seedReviewRule(h.db.path, GITEA_REPO.id, rule), undefined);
    // `seedReviewRule` 回的是新的知识集版本,条目标识要从现集里读。
    return store.getRuleSet(GITEA_REPO.id)!.rules.at(-1)!.id;
  } finally {
    store.close();
  }
}

/** 队列里排一条待裁决提案,回它的标识。 */
function seedProposal(
  h: PanelHarness,
  input: {
    type: "rule" | "fact";
    change: "add" | "modify" | "retire" | "merge";
    targetRuleIds: number[];
    scope: string;
    statement: string;
  },
): number {
  const store = openStore(h.db.path);
  try {
    return store.addRuleProposal(GITEA_REPO.id, {
      ...input,
      sources: [
        {
          origin: "baseline-exploration",
          note: null,
          evidence: "第一次是探索提的",
          findingId: null,
          traceTaskId: null,
        },
      ],
    })!;
  } finally {
    store.close();
  }
}

/** 提交一条目标为提案的意图并等它跑完。 */
async function rewriteAndSettle(
  h: PanelHarness,
  proposalId: number,
  settled = 1,
  text = INTENT,
): Promise<IntentRow> {
  const response = await submit(h, { text, target: { kind: "proposal", id: proposalId } });
  assert.equal(response.status, 202);
  const intent = (await response.json()) as IntentRow;
  await h.revisionIntentsAtLeast(settled);
  return intent;
}

test("目标为待裁决提案:agent 拿到它的全部内容与附注,改写换陈述与作用范围并追加附注", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }), "已把范围收到导出函数上");
  const h = await harnessWithRepo(agent);

  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "入参要在边界上校验" });
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "modify",
    targetRuleIds: [ruleId],
    scope: "src/**",
    statement: "处理器都要校验入参",
  });
  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的导出处理器先校验入参再执行",
      proposalId,
      reason: "只有导出的那几个是入口",
    },
  ];

  const submitted = await rewriteAndSettle(h, proposalId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);
  assert.equal(submitted.targetKind, "proposal");
  assert.equal(submitted.targetId, proposalId);

  // agent 拿到的是目标提案的全部内容:变更类型、型、陈述、作用范围、目标条目与全部附注。
  const request = agent.calls[0]!;
  assert.equal(request.intent?.text, INTENT);
  assert.deepEqual(request.intent?.target, {
    kind: "proposal",
    proposal: {
      id: proposalId,
      change: "modify",
      type: "rule",
      scope: "src/**",
      statement: "处理器都要校验入参",
      targets: [{ id: ruleId, type: "rule", scope: "", statement: "入参要在边界上校验" }],
      sources: [
        {
          origin: "baseline-exploration",
          note: null,
          evidence: "第一次是探索提的",
          findingId: null,
        },
      ],
    },
  });

  const view = await ruleSet(h);
  // 队列条数不变:改写在原地发生。
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.id, proposalId);
  assert.equal(proposal.statement, "api 目录下的导出处理器先校验入参再执行");
  assert.equal(proposal.scope, "src/api/**");
  // 型与目标不换,变更类型仍是修改。
  assert.equal(proposal.type, "rule");
  assert.equal(proposal.change, "modify");
  assert.deepEqual(proposal.targetRuleIds, [ruleId]);
  assert.deepEqual(
    proposal.sources.map((source) => [source.origin, source.note, source.evidence]),
    [
      ["baseline-exploration", null, "第一次是探索提的"],
      ["manual-proposal", INTENT, "只有导出的那几个是入口"],
    ],
  );

  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, { proposalIds: [proposalId], draftItemIds: [] });
});

test("型规则:新增型提案换型成立", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "这一层要自己校验",
  });
  items = [{ type: "fact", scope: "", statement: "全局拦截器已经覆盖了这一层", proposalId }];

  await rewriteAndSettle(h, proposalId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const [proposal] = (await ruleSet(h)).proposals;
  assert.equal(proposal!.type, "fact");
  assert.equal(proposal!.change, "add");
  assert.deepEqual(proposal!.targetRuleIds, []);
});

test("型规则:修改型提案要换型即变成单目标合并型,目标不变", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const ruleId = seedRule(h, { type: "fact", scope: "", statement: "这一层由全局拦截器覆盖" });
  const proposalId = seedProposal(h, {
    type: "fact",
    change: "modify",
    targetRuleIds: [ruleId],
    scope: "",
    statement: "这一层由全局拦截器覆盖入参校验",
  });
  items = [{ type: "rule", scope: "src/api/**", statement: "api 目录下的处理器先校验入参", proposalId }];

  await rewriteAndSettle(h, proposalId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const [proposal] = (await ruleSet(h)).proposals;
  assert.equal(proposal!.type, "rule");
  assert.equal(proposal!.change, "merge");
  assert.deepEqual(proposal!.targetRuleIds, [ruleId]);
  assert.equal(proposal!.scope, "src/api/**");
});

test("型规则:合并型提案的型由新陈述定", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const first = seedRule(h, { type: "rule", scope: "", statement: "处理器要校验入参" });
  const second = seedRule(h, { type: "rule", scope: "", statement: "处理器要校验查询串" });
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "merge",
    targetRuleIds: [first, second],
    scope: "",
    statement: "处理器要校验全部入参",
  });
  items = [{ type: "fact", scope: "", statement: "处理器的入参由一层中间件统一校验", proposalId }];

  await rewriteAndSettle(h, proposalId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const [proposal] = (await ruleSet(h)).proposals;
  assert.equal(proposal!.type, "fact");
  assert.equal(proposal!.change, "merge");
  assert.deepEqual(proposal!.targetRuleIds, [first, second]);
});

test("没有指向目标的产出:全部丢弃并记轨迹,意图零产出完成", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "队列里原来那一句",
  });
  items = [
    { type: "rule", scope: "", statement: "顺手提的另一条" },
    { type: "rule", scope: "", statement: "改写那一条", proposalId },
    { type: "rule", scope: "", statement: "同一次里的第二条改写", proposalId },
  ];

  const submitted = await rewriteAndSettle(h, proposalId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  // 只落地那一条改写,别的一条都不排进队列。
  assert.equal(view.proposals.length, 1);
  assert.equal(view.proposals[0]!.statement, "改写那一条");
  assert.deepEqual(view.intents.find((row) => row.id === submitted.id)!.produced, {
    proposalIds: [proposalId],
    draftItemIds: [],
  });
  const dropped = ruleTraceRows(h).filter((row) => row.kind === "rule_proposal_dropped");
  assert.equal(dropped.length, 2);
});

test("一条指向目标的产出都没有:意图零产出完成,提案一字不动", async () => {
  const h = await harnessWithRepo(
    scriptedRuleAgent(() => ({ items: [{ type: "rule", scope: "", statement: "别的那一条" }] })),
  );
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "src/**",
    statement: "队列里原来那一句",
  });

  const submitted = await rewriteAndSettle(h, proposalId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 1);
  assert.equal(view.proposals[0]!.statement, "队列里原来那一句");
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [] });
});

test("目标在运行中被驳回:意图失败并留原因,提案一字不动", async () => {
  let harness: PanelHarness | undefined;
  let proposalId = 0;
  const h = await harnessWithRepo(async () => {
    // 解读到一半有人裁决了它:落地那一刻它已经不在待裁决队列里。
    assert.equal(
      (
        await harness!.api(
          "POST",
          `/repos/${GITEA_REPO.id}/rule-proposals/${proposalId}/reject`,
        )
      ).status,
      200,
    );
    return { items: [{ type: "rule", scope: "src/api/**", statement: "改写那一条", proposalId }] };
  });
  harness = h;
  proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "src/**",
    statement: "队列里原来那一句",
  });

  const submitted = await rewriteAndSettle(h, proposalId);
  assert.notEqual(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  const proposal = view.proposals.find((row) => row.id === proposalId)!;
  assert.equal(proposal.state, "rejected");
  assert.equal(proposal.statement, "队列里原来那一句");
  assert.equal(proposal.scope, "src/**");
  assert.equal(proposal.sources.length, 1);
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "failed");
  assert.match(intent.failure ?? "", /待裁决/);
});

test("目标在运行中被驳回而一条产出都不指向它:意图仍失败并留原因", async () => {
  let harness: PanelHarness | undefined;
  let proposalId = 0;
  const h = await harnessWithRepo(async () => {
    // 解读到一半有人裁决了它,而这一次 agent 一条指向它的产出都没给:零产出不等于
    // 「什么都没发生」——目标已经没了,这一次意图本来就落不下去。
    assert.equal(
      (
        await harness!.api(
          "POST",
          `/repos/${GITEA_REPO.id}/rule-proposals/${proposalId}/reject`,
        )
      ).status,
      200,
    );
    return { items: [{ type: "rule", scope: "", statement: "顺手提的另一条" }] };
  });
  harness = h;
  proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "src/**",
    statement: "队列里原来那一句",
  });

  const submitted = await rewriteAndSettle(h, proposalId);
  assert.notEqual(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  // 提案一字不动,顺手提的那一条也没排进队列。
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.id, proposalId);
  assert.equal(proposal.statement, "队列里原来那一句");
  assert.equal(proposal.sources.length, 1);
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "failed");
  assert.match(intent.failure ?? "", /待裁决/);
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [] });
});

test("连续两次意图:第二次的 agent 输入含第一次留下的那条附注", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "队列里原来那一句",
  });

  items = [{ type: "rule", scope: "src/**", statement: "第一次改成的那一句", proposalId, reason: "第一次的依据" }];
  await rewriteAndSettle(h, proposalId);
  items = [{ type: "rule", scope: "src/api/**", statement: "第二次改成的那一句", proposalId, reason: "第二次的依据" }];
  await rewriteAndSettle(h, proposalId, 2, "再收窄一点");

  assert.equal(agent.calls.length, 2);
  const target = agent.calls[1]!.intent!.target;
  assert.equal(target.kind, "proposal");
  assert.equal(target.kind === "proposal" ? target.proposal.statement : "", "第一次改成的那一句");
  assert.deepEqual(
    target.kind === "proposal"
      ? target.proposal.sources.map((source) => [source.origin, source.note, source.evidence])
      : [],
    [
      ["baseline-exploration", null, "第一次是探索提的"],
      ["manual-proposal", INTENT, "第一次的依据"],
    ],
  );

  const [proposal] = (await ruleSet(h)).proposals;
  assert.equal(proposal!.statement, "第二次改成的那一句");
  assert.equal(proposal!.sources.length, 3);
});

test("目标校验:不存在与已裁决 404,废止型 400,同目标运行中 409", async () => {
  // agent 停在这里,第一条意图因此停在运行中,直到用例放行。
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harnessWithRepo(async () => {
    await held;
    return { items: [] };
  });

  const target = (id: number): unknown => ({ text: INTENT, target: { kind: "proposal", id } });
  assert.equal((await submit(h, target(999999))).status, 404);

  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "现集里的那一条" });
  const retire = seedProposal(h, {
    type: "rule",
    change: "retire",
    targetRuleIds: [ruleId],
    scope: "",
    statement: "现集里的那一条",
  });
  // 废止型提案没有改写入口。
  assert.equal((await submit(h, target(retire))).status, 400);

  const rejected = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "已经被驳回的那一条",
  });
  assert.equal(
    (await h.api("POST", `/repos/${GITEA_REPO.id}/rule-proposals/${rejected}/reject`)).status,
    200,
  );
  assert.equal((await submit(h, target(rejected))).status, 404);

  const proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "队列里原来那一句",
  });
  assert.equal((await submit(h, target(proposalId))).status, 202);
  // 同一目标同时只跑一条。
  assert.equal((await submit(h, target(proposalId))).status, 409);
  // 目标形状不对的照旧 400。
  assert.equal((await submit(h, { text: INTENT, target: { kind: "proposal" } })).status, 400);

  release();
  await h.revisionIntentsAtLeast(1);
});

/**
 * 目标为一条生效知识条目的修订意图(issue #297)。产出只收一条指向它的变更——修改、废止
 * 或单目标合并改型,或者并入队列里已经指向它的那一条提案;改一条条目从此也走裁决与出处。
 */

/** 提交一条目标为知识条目的意图并等它跑完。 */
async function rewriteEntryAndSettle(
  h: PanelHarness,
  ruleId: number,
  settled = 1,
  text = INTENT,
): Promise<IntentRow> {
  const response = await submit(h, { text, target: { kind: "rule", id: ruleId } });
  assert.equal(response.status, 202);
  const intent = (await response.json()) as IntentRow;
  await h.revisionIntentsAtLeast(settled);
  return intent;
}

test("目标为知识条目:agent 拿到它与指向它的待裁决提案,产出修改型提案指向它", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }), "已按 api 目录的现状收窄");
  const h = await harnessWithRepo(agent);

  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  // 队列里另有一条指向它的提案:agent 要看得到它才判得出该并入还是另提一条。
  const queued = seedProposal(h, {
    type: "rule",
    change: "modify",
    targetRuleIds: [ruleId],
    scope: "src/**",
    statement: "队列里已经指向它的那一条",
  });
  // 别的条目与别的提案照常渲染给 agent:它要判得出这件事现集里还有没有别处说过。
  const otherRule = seedRule(h, { type: "fact", scope: "", statement: "另一条与它无关的" });

  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的处理器先校验入参再执行",
      targetRuleIds: [ruleId],
      reason: "只有 api 目录下那几个是入口",
    },
  ];

  const submitted = await rewriteEntryAndSettle(h, ruleId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);
  assert.equal(submitted.targetKind, "rule");
  assert.equal(submitted.targetId, ruleId);

  // agent 拿到目标条目的标识、型、陈述、作用范围,加队列里指向它的那一条的全部内容与附注。
  const request = agent.calls[0]!;
  assert.equal(request.intent?.text, INTENT);
  assert.deepEqual(request.intent?.target, {
    kind: "rule",
    rule: { id: ruleId, type: "rule", scope: "", statement: "处理器都要校验入参" },
    proposals: [
      {
        id: queued,
        change: "modify",
        type: "rule",
        scope: "src/**",
        statement: "队列里已经指向它的那一条",
        targets: [{ id: ruleId, type: "rule", scope: "", statement: "处理器都要校验入参" }],
        sources: [
          {
            origin: "baseline-exploration",
            note: null,
            evidence: "第一次是探索提的",
            findingId: null,
          },
        ],
      },
    ],
  });
  // 现集与队列照常整份给出。
  assert.deepEqual(
    request.existingKnowledge.map((entry) => entry.id),
    [ruleId, otherRule],
  );
  assert.deepEqual(
    request.pendingProposals?.map((proposal) => proposal.id),
    [queued],
  );

  const view = await ruleSet(h);
  const produced = view.proposals.find((row) => row.id !== queued)!;
  assert.equal(produced.change, "modify");
  assert.deepEqual(produced.targetRuleIds, [ruleId]);
  assert.equal(produced.statement, "api 目录下的处理器先校验入参再执行");
  assert.equal(produced.scope, "src/api/**");
  assert.equal(produced.type, "rule");
  assert.deepEqual(
    produced.sources.map((source) => [source.origin, source.note, source.evidence]),
    [["manual-proposal", INTENT, "只有 api 目录下那几个是入口"]],
  );

  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.equal(intent.summary, "已按 api 目录的现状收窄");
  assert.deepEqual(intent.produced, { proposalIds: [produced.id], draftItemIds: [] });
});

test("目标为知识条目:换型的产出成为指向它的单目标合并", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const ruleId = seedRule(h, { type: "fact", scope: "", statement: "这一层由全局拦截器覆盖" });
  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的处理器先校验入参",
      targetRuleIds: [ruleId],
    },
  ];

  await rewriteEntryAndSettle(h, ruleId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const [proposal] = (await ruleSet(h)).proposals;
  assert.equal(proposal!.change, "merge");
  assert.equal(proposal!.type, "rule");
  assert.deepEqual(proposal!.targetRuleIds, [ruleId]);
  assert.equal(proposal!.scope, "src/api/**");
});

test("目标为知识条目:带废止标记的产出成为指向它的废止型提案", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const ruleId = seedRule(h, { type: "rule", scope: "src/**", statement: "这条代码已经不支持了" });
  items = [
    {
      type: "rule",
      scope: "",
      statement: "这条代码已经不支持了",
      targetRuleIds: [ruleId],
      retire: true,
      reason: "那个模块已经删掉了",
    },
  ];

  await rewriteEntryAndSettle(h, ruleId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const [proposal] = (await ruleSet(h)).proposals;
  assert.equal(proposal!.change, "retire");
  assert.deepEqual(proposal!.targetRuleIds, [ruleId]);
  // 废止那一档的内容取目标条目的原样:队列里那条要说得出它废止的是什么。
  assert.equal(proposal!.scope, "src/**");
  assert.equal(proposal!.statement, "这条代码已经不支持了");
});

test("目标为知识条目:agent 指名并入指向它的那一条,队列仍一条、附注多一条", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  const queued = seedProposal(h, {
    type: "rule",
    change: "modify",
    targetRuleIds: [ruleId],
    scope: "src/**",
    statement: "队列里已经指向它的那一条",
  });
  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的处理器先校验入参再执行",
      proposalId: queued,
      reason: "队列里那条说的就是这件事",
    },
  ];

  const submitted = await rewriteEntryAndSettle(h, ruleId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.id, queued);
  assert.equal(proposal.statement, "api 目录下的处理器先校验入参再执行");
  assert.equal(proposal.scope, "src/api/**");
  assert.equal(proposal.change, "modify");
  assert.deepEqual(proposal.targetRuleIds, [ruleId]);
  assert.deepEqual(
    proposal.sources.map((source) => [source.origin, source.note]),
    [
      ["baseline-exploration", null],
      ["manual-proposal", INTENT],
    ],
  );
  assert.deepEqual(view.intents.find((row) => row.id === submitted.id)!.produced, {
    proposalIds: [queued],
    draftItemIds: [],
  });
});

test("目标为知识条目:指向它的废止型提案不作并入候选,指名它的产出被丢掉", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  // 队列里指向它的那一条是废止型:它说的就是废止哪一条,并进去只会把它改成别的意思
  // ——提交时那一档本来就 400,并入这条路径同一口径。
  const retire = seedProposal(h, {
    type: "rule",
    change: "retire",
    targetRuleIds: [ruleId],
    scope: "",
    statement: "代码已经不这么写了,废止它",
  });
  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的处理器先校验入参再执行",
      proposalId: retire,
      reason: "并进队列里那一条",
    },
  ];

  const submitted = await rewriteEntryAndSettle(h, ruleId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  // 给 agent 的「指向它的待裁决提案」里没有废止型那一条。
  const target = agent.calls[0]!.intent!.target;
  assert.deepEqual(target.kind === "rule" ? target.proposals : undefined, []);

  const view = await ruleSet(h);
  // 那一条废止型一字不动:陈述与附注都是排它进来时那一份。
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.equal(proposal.id, retire);
  assert.equal(proposal.change, "retire");
  assert.equal(proposal.statement, "代码已经不这么写了,废止它");
  assert.equal(proposal.sources.length, 1);
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [] });
  const dropped = ruleTraceRows(h).filter((row) => row.kind === "rule_proposal_dropped");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.payload, /知识条目/);
});

test("目标为知识条目:不指向它的产出丢弃并记轨迹,意图仍完成", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent);
  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  const other = seedRule(h, { type: "rule", scope: "", statement: "另一条与它无关的" });
  // 队列里那一条指向别的条目:并进去也不算指向目标。
  const elsewhere = seedProposal(h, {
    type: "rule",
    change: "modify",
    targetRuleIds: [other],
    scope: "",
    statement: "指向另一条的那一条",
  });
  items = [
    { type: "rule", scope: "", statement: "顺手提的新增" },
    { type: "rule", scope: "", statement: "改另一条", targetRuleIds: [other] },
    { type: "rule", scope: "", statement: "并到别处去", proposalId: elsewhere },
    {
      type: "rule",
      scope: "src/api/**",
      statement: "api 目录下的处理器先校验入参再执行",
      targetRuleIds: [ruleId],
    },
    { type: "rule", scope: "", statement: "同一次里的第二条", targetRuleIds: [ruleId] },
  ];

  const submitted = await rewriteEntryAndSettle(h, ruleId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  // 指向目标的那一条排进队列,别的一条都不落地;队列里原有那一条一字不动。
  const landed = view.proposals.filter((row) => row.id !== elsewhere);
  assert.deepEqual(
    landed.map((row) => row.statement),
    ["api 目录下的处理器先校验入参再执行"],
  );
  assert.equal(view.proposals.find((row) => row.id === elsewhere)!.statement, "指向另一条的那一条");
  assert.deepEqual(view.intents.find((row) => row.id === submitted.id)!.produced, {
    proposalIds: [landed[0]!.id],
    draftItemIds: [],
  });
  const dropped = ruleTraceRows(h).filter((row) => row.kind === "rule_proposal_dropped");
  assert.equal(dropped.length, 4);
  assert.match(dropped[0]!.payload, /知识条目/);
});

test("目标条目在运行中被直接废止:意图失败并留原因", async () => {
  let harness: PanelHarness | undefined;
  let ruleId = 0;
  const h = await harnessWithRepo(async () => {
    // 解读到一半有人直接废止了它:落地那一刻它已经不在生效条目里。
    assert.equal(
      (await harness!.api("DELETE", `/repos/${GITEA_REPO.id}/rules/${ruleId}`)).status,
      200,
    );
    return {
      items: [
        { type: "rule", scope: "src/api/**", statement: "改成这一句", targetRuleIds: [ruleId] },
      ],
    };
  });
  harness = h;
  ruleId = seedRule(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });

  const submitted = await rewriteEntryAndSettle(h, ruleId);
  assert.notEqual(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.proposals.length, 0);
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "failed");
  assert.match(intent.failure ?? "", /生效条目/);
});

test("目标校验:条目不存在与已废止 404,同目标运行中 409", async () => {
  // agent 停在这里,第一条意图因此停在运行中,直到用例放行。
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harnessWithRepo(async () => {
    await held;
    return { items: [] };
  });

  const target = (id: number): unknown => ({ text: INTENT, target: { kind: "rule", id } });
  assert.equal((await submit(h, target(999999))).status, 404);

  const retired = seedRule(h, { type: "rule", scope: "", statement: "马上就要废止的那一条" });
  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}/rules/${retired}`)).status, 200);
  assert.equal((await submit(h, target(retired))).status, 404);

  const ruleId = seedRule(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  assert.equal((await submit(h, target(ruleId))).status, 202);
  // 同一目标同时只跑一条。
  assert.equal((await submit(h, target(ruleId))).status, 409);
  // 目标形状不对的照旧 400。
  assert.equal((await submit(h, { text: INTENT, target: { kind: "rule" } })).status, 400);

  release();
  await h.revisionIntentsAtLeast(1);
});

/**
 * 目标为一条草案条目的修订意图(issue #298)。首次确认前也不用手写陈述:改写在草案那一行
 * 原地发生,型、陈述与作用范围换新,标识不变,其余行不动;只记轨迹,草案条目不挂附注。
 */

/** 草案里加一条,回它的标识。 */
function seedDraftItem(
  h: PanelHarness,
  item: { type: "rule" | "fact"; scope: string; statement: string },
): number {
  const store = openStore(h.db.path);
  try {
    const [id] = store.appendRuleDraftItems(GITEA_REPO.id, [item], "2026-09-08T00:00:00.000Z");
    assert.notEqual(id, undefined);
    return id!;
  } finally {
    store.close();
  }
}

/** 提交一条目标为草案条目的意图并等它跑完。 */
async function rewriteDraftAndSettle(
  h: PanelHarness,
  itemId: number,
  settled = 1,
  text = INTENT,
): Promise<IntentRow> {
  const response = await submit(h, { text, target: { kind: "draft", id: itemId } });
  assert.equal(response.status, 202);
  const intent = (await response.json()) as IntentRow;
  await h.revisionIntentsAtLeast(settled);
  return intent;
}

test("目标为草案条目:agent 拿到它与其余草案条目,那一行原地换型、陈述与作用范围", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }), "已按 api 目录的现状收窄");
  const h = await harnessWithRepo(agent, false);

  const itemId = seedDraftItem(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  const other = seedDraftItem(h, { type: "fact", scope: "src/**", statement: "另一条草案里的" });
  items = [
    {
      type: "fact",
      scope: "src/api/**",
      statement: "api 目录下的处理器由全局拦截器校验入参",
      targetRuleIds: [itemId],
      reason: "只有 api 目录下那几个是入口",
    },
  ];

  const submitted = await rewriteDraftAndSettle(h, itemId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);
  assert.equal(submitted.targetKind, "draft");
  assert.equal(submitted.targetId, itemId);

  // agent 拿到目标草案条目与其余草案条目:后者让它别产重复的那一条。
  const request = agent.calls[0]!;
  assert.equal(request.intent?.text, INTENT);
  assert.deepEqual(request.intent?.target, {
    kind: "draft",
    item: { id: itemId, type: "rule", scope: "", statement: "处理器都要校验入参" },
    others: [{ id: other, type: "fact", scope: "src/**", statement: "另一条草案里的" }],
  });

  const view = await ruleSet(h);
  assert.equal(view.version, null);
  // 那一行原地换新,标识不变;其余行一字不动;队列里一条都没多。
  assert.deepEqual(
    view.draft.map((row) => [row.id, row.type, row.scope, row.statement]),
    [
      [itemId, "fact", "src/api/**", "api 目录下的处理器由全局拦截器校验入参"],
      [other, "fact", "src/**", "另一条草案里的"],
    ],
  );
  assert.equal(view.proposals.length, 0);

  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.equal(intent.targetKind, "draft");
  assert.equal(intent.targetId, itemId);
  assert.equal(intent.summary, "已按 api 目录的现状收窄");
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [itemId] });
});

test("目标为草案条目:陈述超过 100 字的产出被丢弃,意图完成、草案不动", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent, false);

  const itemId = seedDraftItem(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  items = [{ type: "rule", scope: "src/api/**", statement: "太".repeat(101), targetRuleIds: [itemId] }];

  const submitted = await rewriteDraftAndSettle(h, itemId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.deepEqual(
    view.draft.map((row) => [row.scope, row.statement]),
    [["", "处理器都要校验入参"]],
  );
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [] });
  const dropped = ruleTraceRows(h).filter((row) => row.kind === "rule_proposal_dropped");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.payload, /陈述超过 100 字/);
});

test("目标为草案条目:不指向它的产出丢弃并记轨迹,意图零产出完成", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithRepo(agent, false);

  const itemId = seedDraftItem(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  const other = seedDraftItem(h, { type: "rule", scope: "", statement: "另一条草案里的" });
  items = [
    // 指向别的草案条目、一个目标都不给、目标不止一条:三条都不是人指着的那一件事。
    { type: "rule", scope: "", statement: "改的是另一条", targetRuleIds: [other] },
    { type: "rule", scope: "", statement: "顺手提的一条新的" },
    { type: "rule", scope: "", statement: "把两条并起来", targetRuleIds: [itemId, other] },
  ];

  const submitted = await rewriteDraftAndSettle(h, itemId);
  assert.equal(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.deepEqual(
    view.draft.map((row) => [row.id, row.statement]),
    [
      [itemId, "处理器都要校验入参"],
      [other, "另一条草案里的"],
    ],
  );
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "completed");
  assert.deepEqual(intent.produced, { proposalIds: [], draftItemIds: [] });
  const dropped = ruleTraceRows(h).filter((row) => row.kind === "rule_proposal_dropped");
  assert.equal(dropped.length, 3);
  assert.match(dropped[0]!.payload, /草案条目/);
});

test("目标草案条目在运行中被删:意图失败并留原因", async () => {
  let harness: PanelHarness | undefined;
  let itemId = 0;
  const h = await harnessWithRepo(async () => {
    // 解读到一半有人把这条草案条目删了:落地那一刻它已经不在草案里。
    assert.equal(
      (await harness!.api("DELETE", `/repos/${GITEA_REPO.id}/rule-draft/${itemId}`)).status,
      200,
    );
    return {
      items: [
        { type: "rule", scope: "src/api/**", statement: "改成这一句", targetRuleIds: [itemId] },
      ],
    };
  }, false);
  harness = h;
  itemId = seedDraftItem(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });

  const submitted = await rewriteDraftAndSettle(h, itemId);
  assert.notEqual(h.revisionIntents[0]!.failure, undefined);

  const view = await ruleSet(h);
  assert.equal(view.draft.length, 0);
  const intent = view.intents.find((row) => row.id === submitted.id)!;
  assert.equal(intent.state, "failed");
  assert.match(intent.failure ?? "", /草案/);
});

test("目标校验:草案条目不存在 404,同目标运行中 409", async () => {
  // agent 停在这里,第一条意图因此停在运行中,直到用例放行。
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harnessWithRepo(async () => {
    await held;
    return { items: [] };
  }, false);

  const target = (id: number): unknown => ({ text: INTENT, target: { kind: "draft", id } });
  assert.equal((await submit(h, target(999999))).status, 404);

  const itemId = seedDraftItem(h, { type: "rule", scope: "", statement: "处理器都要校验入参" });
  assert.equal((await submit(h, target(itemId))).status, 202);
  // 同一目标同时只跑一条。
  assert.equal((await submit(h, target(itemId))).status, 409);
  // 目标形状不对的照旧 400。
  assert.equal((await submit(h, { text: INTENT, target: { kind: "draft" } })).status, 400);

  release();
  await h.revisionIntentsAtLeast(1);
});

test("知识集已确认的仓库没有草案:目标为草案条目回 404", async () => {
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  const response = await submit(h, { text: INTENT, target: { kind: "draft", id: 1 } });
  assert.equal(response.status, 404);
});

/**
 * 失败的修订意图可以重试(issue #316)。同一行原地再跑一次:原文、目标与提交人不变,上一次
 * 的结算清空,模型按此刻生效的辅助模型重新解析;校验与提交端点同一口径。
 */

function retry(h: PanelHarness, intentId: number): Promise<Response> {
  return h.api("POST", `/repos/${GITEA_REPO.id}/revision-intents/${intentId}/retry`);
}

/** 直接落一条失败的意图,回它的标识。拒绝面的用例不必先让 agent 真跑失败一次。 */
function seedFailedIntent(
  h: PanelHarness,
  targetKind: IntentRow["targetKind"],
  targetId: number | null,
): number {
  const store = openStore(h.db.path);
  try {
    const intent = store.startRuleIntent(GITEA_REPO.id, {
      text: INTENT,
      submittedBy: "someone",
      targetKind,
      targetId,
      model: "test:global-model",
      startedAt: "2026-09-11T00:00:00.000Z",
    })!;
    store.failRuleIntent(intent.id, "Connection error.", "2026-09-11T00:01:00.000Z");
    return intent.id;
  } finally {
    store.close();
  }
}

test("重试失败的意图:同一行原地变回运行中再完成,模型按此刻的辅助模型解析,轨迹换新", async () => {
  let attempt = 0;
  const agent = scriptedRuleAgent(() => {
    attempt += 1;
    return attempt === 1
      ? { items: [], failure: "Connection error." }
      : {
          items: [
            {
              type: "rule",
              scope: "src/api/**",
              statement: "api 目录下的处理器先校验入参再执行",
              reason: "三个处理器都在开头校验",
            },
          ],
        };
  }, "已按 api 目录的现状定下作用范围");
  const h = await harnessWithRepo(agent);

  const intentId = await submitAndSettle(h);
  assert.equal(h.revisionIntents[0]!.failure, "Connection error.");
  const failed = (await ruleSet(h)).intents.find((row) => row.id === intentId)!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.model, "test:global-model");
  assert.notEqual(failed.traceTaskId, null);

  // 失败之后换了辅助模型:重试用此刻生效的那一处,不沿用第一次记下的那一处。
  seedAvailableModelService(h, "second", ["other-model"]);
  const store = openStore(h.db.path);
  try {
    assert.equal(
      putGlobalSettings(store, {
        auxiliaryModelJson: JSON.stringify({ provider: "second", model: "other-model" }),
      }),
      true,
    );
  } finally {
    store.close();
  }

  const response = await retry(h, intentId);
  assert.equal(response.status, 202);
  const rerun = (await response.json()) as IntentRow;
  // 同一行原地变回运行中:原文、目标与提交人不变,上一次的结算与轨迹清空。
  assert.equal(rerun.id, intentId);
  assert.equal(rerun.state, "running");
  assert.equal(rerun.text, INTENT);
  assert.equal(rerun.targetKind, "none");
  assert.equal(rerun.targetId, null);
  assert.equal(rerun.submittedBy, "panel-admin");
  assert.equal(rerun.model, "second:other-model");
  assert.equal(rerun.failure, null);
  assert.equal(rerun.finishedAt, null);
  assert.equal(rerun.summary, null);
  assert.equal(rerun.traceTaskId, null);
  assert.deepEqual(rerun.produced, { proposalIds: [], draftItemIds: [] });

  await h.revisionIntentsAtLeast(2);
  assert.equal(h.revisionIntents[1]!.intentId, intentId);
  assert.equal(h.revisionIntents[1]!.failure, undefined);
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1]!.runtimeModel.provider, "second");
  assert.equal(agent.calls[1]!.intent?.text, INTENT);

  const view = await ruleSet(h);
  // 还是那一行,没有多出第二行。
  assert.deepEqual(
    view.intents.map((row) => row.id),
    [intentId],
  );
  const intent = view.intents[0]!;
  assert.equal(intent.state, "completed");
  assert.equal(intent.failure, null);
  assert.equal(intent.summary, "已按 api 目录的现状定下作用范围");
  assert.equal(intent.model, "second:other-model");
  assert.equal(view.proposals.length, 1);
  const proposal = view.proposals[0]!;
  assert.deepEqual(intent.produced, { proposalIds: [proposal.id], draftItemIds: [] });
  // 附注来源沿用原来源,挂的是这一次的新轨迹。
  assert.deepEqual(
    proposal.sources.map((source) => [source.origin, source.note, source.findingId]),
    [["manual-proposal", INTENT, null]],
  );
  assert.notEqual(intent.traceTaskId, null);
  assert.notEqual(intent.traceTaskId, failed.traceTaskId);
  assert.equal(proposal.sources[0]!.traceTaskId, intent.traceTaskId);
});

test("重试:不在这个仓库 404,运行中与完成的 409", async () => {
  // agent 停在这里,意图因此停在运行中,直到用例放行。
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harnessWithRepo(async () => {
    await held;
    return { items: [] };
  });

  assert.equal((await retry(h, 999999)).status, 404);
  const running = (await (await submit(h, { text: INTENT })).json()) as IntentRow;
  assert.equal(
    (await h.api("POST", `/repos/999999/revision-intents/${running.id}/retry`)).status,
    404,
  );
  assert.equal((await retry(h, running.id)).status, 409);

  release();
  await h.revisionIntentsAtLeast(1);
  assert.equal((await ruleSet(h)).intents[0]!.state, "completed");
  // 完成的不重跑:再跑一次就是第二份产出。
  assert.equal((await retry(h, running.id)).status, 409);
});

test("重试:目标已裁决、已废止、草案条目或 Finding 不在 404,同目标运行中 409", async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harnessWithRepo(async () => {
    await held;
    return { items: [] };
  });

  const retired = seedRule(h, { type: "rule", scope: "", statement: "已经废止的那一条" });
  assert.equal((await h.api("DELETE", `/repos/${GITEA_REPO.id}/rules/${retired}`)).status, 200);
  const rejected = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "已经被驳回的那一条",
  });
  assert.equal(
    (await h.api("POST", `/repos/${GITEA_REPO.id}/rule-proposals/${rejected}/reject`)).status,
    200,
  );
  const gone: [IntentRow["targetKind"], number][] = [
    ["proposal", rejected],
    ["rule", retired],
    ["draft", 999999],
    ["finding", 999999],
  ];
  for (const [kind, id] of gone) {
    const failedId = seedFailedIntent(h, kind, id);
    assert.equal((await retry(h, failedId)).status, 404, kind);
  }
  // 被拒的那几行仍是失败:没有被改回运行中。
  assert.ok((await ruleSet(h)).intents.every((row) => row.state === "failed"));

  // 同一目标已有一条在跑:重试与提交同一道互斥。
  const proposalId = seedProposal(h, {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "队列里原来那一句",
  });
  const failedId = seedFailedIntent(h, "proposal", proposalId);
  assert.equal(
    (await submit(h, { text: INTENT, target: { kind: "proposal", id: proposalId } })).status,
    202,
  );
  assert.equal((await retry(h, failedId)).status, 409);

  release();
  await h.revisionIntentsAtLeast(1);
});

test("重试:辅助模型跑不了 409 且那一行仍失败,没有 knowledge:write 403", async () => {
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  const failedId = seedFailedIntent(h, "none", null);

  const reader = await scopedUser(
    h,
    "intent-reader",
    "intent-reader-password",
    "2026-09-11T00:00:00.000Z",
    [GITEA_REPO.id],
  );
  const forbidden = await fetch(
    `${h.serverUrl}/api/repos/${GITEA_REPO.id}/revision-intents/${failedId}/retry`,
    { method: "POST", headers: { cookie: reader } },
  );
  assert.equal(forbidden.status, 403);

  const raw = new DatabaseSync(h.db.path);
  try {
    raw.prepare("DELETE FROM global_setting WHERE key = ?").run("reviewers");
  } finally {
    raw.close();
  }
  const response = await retry(h, failedId);
  assert.equal(response.status, 409);
  const error = ((await response.json()) as { error: string }).error;
  assert.match(error, /审查策略/);
  assert.match(error, /仓库配置/);
  const [intent] = (await ruleSet(h)).intents;
  assert.equal(intent!.state, "failed");
  assert.equal(intent!.failure, "Connection error.");
});

test("重跑只认这个仓库的失败行:原地改回运行中,清掉上一次的结算,原文、目标与提交人不动", async () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 73, owner: "acme", repo: "legacy", generation: 1, key: "k" });
    const intent = store.startRuleIntent(73, {
      text: "跑过一次的那一段",
      submittedBy: "someone",
      targetKind: "proposal",
      targetId: 11,
      model: "test:global-model",
      startedAt: "2026-09-11T00:00:00.000Z",
    })!;
    const run = {
      model: "second:other-model",
      thinkingLevel: "high" as const,
      startedAt: "2026-09-11T01:00:00.000Z",
    };
    // 运行中与完成的都不重跑。
    assert.equal(store.rerunRuleIntent(73, intent.id, run), undefined);
    store.setRuleIntentTrace(intent.id, 5);
    store.finishRuleIntent(
      intent.id,
      { summary: "已产出一条", produced: { proposalIds: [3], draftItemIds: [] } },
      "2026-09-11T00:01:00.000Z",
    );
    assert.equal(store.rerunRuleIntent(73, intent.id, run), undefined);
    store.failRuleIntent(intent.id, "Connection error.", "2026-09-11T00:02:00.000Z");
    // 别的仓库认不出这一行。
    assert.equal(store.rerunRuleIntent(74, intent.id, run), undefined);

    const rerun = store.rerunRuleIntent(73, intent.id, run)!;
    assert.deepEqual(
      {
        id: rerun.id,
        text: rerun.text,
        submittedBy: rerun.submittedBy,
        targetKind: rerun.targetKind,
        targetId: rerun.targetId,
        state: rerun.state,
        failure: rerun.failure,
        summary: rerun.summary,
        model: rerun.model,
        thinkingLevel: rerun.thinkingLevel,
        traceTaskId: rerun.traceTaskId,
        produced: rerun.produced,
        startedAt: rerun.startedAt,
        finishedAt: rerun.finishedAt,
      },
      {
        id: intent.id,
        text: "跑过一次的那一段",
        submittedBy: "someone",
        targetKind: "proposal",
        targetId: 11,
        state: "running",
        failure: null,
        summary: null,
        model: "second:other-model",
        thinkingLevel: "high",
        traceTaskId: null,
        produced: { proposalIds: [], draftItemIds: [] },
        startedAt: "2026-09-11T01:00:00.000Z",
        finishedAt: null,
      },
    );
  } finally {
    store.close();
  }
});
