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
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem, RuleAgentRequest } from "../src/reviewer/rule-agent.ts";
import { confirmEmptyRuleSet, makeDbPath } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

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
  intentModel: string | null;
};

/** 脚本化规则 agent,记下每次收到的任务。产出由回调给出:现集的标识建库之后才知道。 */
function scriptedRuleAgent(
  produce: () => { items: RuleAgentItem[]; failure?: string },
  narrate?: string,
): RuleAgent & { calls: RuleAgentRequest[] } {
  const calls: RuleAgentRequest[] = [];
  const agent = async (request: RuleAgentRequest) => {
    calls.push(request);
    if (narrate !== undefined) {
      request.onEvent?.({ kind: "assistant_message", text: narrate });
    }
    const result = produce();
    // 真实实现每提一条就发一条事件(`runRuleAgentChild`),脚本化的照做:轨迹上那几条
    // `rule_proposed` 是被测行为的一部分。
    for (const item of result.items) request.onEvent?.({ kind: "rule_proposed", item });
    return result;
  };
  return Object.assign(agent, { calls });
}

/** 一个已注册的仓库。`confirmed` 为 true 即知识集已确认(空集)。 */
async function harnessWithRepo(
  ruleAgent: RuleAgent,
  confirmed = true,
): Promise<PanelHarness> {
  const h = await startReadyPanelHarness(cleanups, { ruleAgent });
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
      store.addReviewRule(GITEA_REPO.id, {
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
    assert.notEqual(
      store.addRuleDraftItem(GITEA_REPO.id, { type: "rule", scope: "", statement: "草案里原有的" }),
      undefined,
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
      ["草案里原有的", "manual"],
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
  // 还没放开的目标类型仍 400。
  assert.equal((await submit(h, { text: INTENT, target: { kind: "draft", id: 1 } })).status, 400);
  // 不在注册表里的仓库与分配外同形:404。
  assert.equal(
    (await h.api("POST", "/repos/999999/revision-intents", { text: INTENT })).status,
    404,
  );
});

test("一个模型都选不出来时提交回 409,知识集读取的 intentModel 为 null", async () => {
  // 没有全局模型组合、也没有基点探索记录:模型规则两头都取不到。注册要过「审查配置就绪」
  // 那道门禁,组合因此在注册之后才清掉。
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  const raw = new DatabaseSync(h.db.path);
  try {
    raw.prepare("DELETE FROM global_setting WHERE key = ?").run("reviewers");
  } finally {
    raw.close();
  }

  const response = await submit(h, { text: INTENT });
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /模型/);
  assert.equal((await ruleSet(h)).intentModel, null);
});

test("知识集读取:意图将使用的模型即反哺那条规则选出来的那个", async () => {
  const h = await harnessWithRepo(scriptedRuleAgent(() => ({ items: [] })));
  const view = await ruleSet(h);
  assert.equal(view.intentModel, "test:global-model");
  assert.deepEqual(view.intents, []);
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
    const listed = restarted.listRuleIntents(71, "2026-09-08T01:00:00.000Z", 600_000);
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

test("完成的意图只在十分钟窗口内列出,库里的行留着", async () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 72, owner: "acme", repo: "legacy", generation: 1, key: "k" });
    const intent = store.startRuleIntent(72, {
      text: "早就跑完了",
      submittedBy: "someone",
      targetKind: "none",
      targetId: null,
      model: "test:global-model",
      startedAt: "2026-09-08T00:00:00.000Z",
    })!;
    store.finishRuleIntent(
      intent.id,
      { summary: "已产出一条", produced: { proposalIds: [3], draftItemIds: [] } },
      "2026-09-08T00:01:00.000Z",
    );
    assert.equal(store.listRuleIntents(72, "2026-09-08T00:05:00.000Z", 600_000).length, 1);
    assert.equal(store.listRuleIntents(72, "2026-09-08T00:30:00.000Z", 600_000).length, 0);
    // 行仍在库里:轨迹回溯读得到它。
    assert.equal(store.getRuleIntent(72, intent.id)?.summary, "已产出一条");
    assert.deepEqual(store.getRuleIntent(72, intent.id)?.produced, {
      proposalIds: [3],
      draftItemIds: [],
    });
  } finally {
    store.close();
  }
});

test("三个来源字面量的旧库打开后写得进第四个", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const first = openStore(db.path);
  try {
    first.registerRepo({ repoId: 73, owner: "acme", repo: "legacy", generation: 1, key: "k" });
  } finally {
    first.close();
  }
  // 升级前的形状:两张表的来源 CHECK 只有三个取值。
  const raw = new DatabaseSync(db.path);
  try {
    raw.exec(`
      DROP TABLE rule_trace;
      CREATE TABLE rule_trace (
        task_id INTEGER NOT NULL,
        repo_id INTEGER NOT NULL REFERENCES repo(id),
        source TEXT NOT NULL
          CHECK (source IN ('baseline-exploration', 'disposition-feedback', 'knowledge-consolidation')),
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
      INSERT INTO rule_trace (task_id, repo_id, source, seq, at, kind, payload)
        VALUES (1, 73, 'baseline-exploration', 1, '2026-09-01T00:00:00.000Z',
                'rule_agent_started', '{}');
      DROP TABLE rule_proposal_source;
      CREATE TABLE rule_proposal_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id INTEGER NOT NULL REFERENCES rule_proposal(id),
        origin TEXT NOT NULL
          CHECK (origin IN ('baseline-exploration', 'disposition-feedback', 'knowledge-consolidation')),
        note TEXT,
        evidence TEXT,
        finding_id INTEGER,
        trace_task_id INTEGER,
        created_at TEXT NOT NULL
      );
    `);
  } finally {
    raw.close();
  }

  const store = openStore(db.path);
  try {
    // 存量那一条原样保留。
    assert.deepEqual(
      store.listRuleTrace(1).map((event) => event.kind),
      ["rule_agent_started"],
    );
    // 第四个取值写得进两张表。
    const taskId = store.startRuleTrace(73, "manual-proposal", { source: "manual-proposal" });
    assert.equal(store.ruleTraceRepo(taskId), 73);
    const proposalId = store.addRuleProposal(73, {
      type: "rule",
      change: "add",
      targetRuleIds: [],
      scope: "",
      statement: "意图产出的那一条",
      sources: [
        {
          origin: "manual-proposal",
          note: "写下的那段话",
          evidence: "读过的代码",
          findingId: null,
          traceTaskId: taskId,
        },
      ],
    })!;
    assert.deepEqual(
      store.getRuleProposals(73).find((row) => row.id === proposalId)?.sources.map((s) => s.origin),
      ["manual-proposal"],
    );
  } finally {
    store.close();
  }

  // 迁移完的库再开一次不重复重建:判据看建表语句原文,重建过即不再命中。
  const again = openStore(db.path);
  try {
    assert.equal(again.listRuleTrace(1).length, 1);
    assert.equal(again.getRuleProposals(73).length, 1);
  } finally {
    again.close();
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
    assert.notEqual(store.addReviewRule(GITEA_REPO.id, rule), undefined);
    // `addReviewRule` 回的是新的知识集版本,条目标识要从现集里读。
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
