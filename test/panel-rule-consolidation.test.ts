/**
 * 知识整理(issue #284,父 spec #280)。
 *
 * 两条缝:SQLite 临时库验两个直改动作的落地判据、与基点探索共用的互斥、重启改判与移除
 * 仓库的级联;面板 API 走真实 HTTP 验发起、agent 拿到的输入、动作落地、摘要与轨迹可见、
 * 整理期间照常裁决、409 与 `knowledge:write` 拦截。规则 agent 仍用脚本化实现注入,与
 * issue #205 / #207 / #208 同一个位置。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { PanelPermission } from "../src/panel/permissions.ts";
import { hashPassword } from "../src/panel/password.ts";
import {
  openStore,
  type RuleProposalInput,
  type RuleProposalSourceInput,
} from "../src/review/store.ts";
import type {
  ConsolidationProposal,
  RuleAgent,
  RuleAgentRequest,
  RuleConsolidationAction,
} from "../src/reviewer/rule-agent.ts";
import { makeDbPath } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "consolidation-test-password";
const AT = "2026-09-08T00:00:00.000Z";

type ProposalResponse = {
  id: number;
  type: "rule" | "fact";
  change: "add" | "modify" | "retire";
  targetRuleId: number | null;
  scope: string;
  statement: string;
  sources: {
    origin: "baseline-exploration" | "disposition-feedback" | "knowledge-consolidation";
    note: string | null;
  }[];
  state: "pending" | "accepted" | "rejected";
};

type ConsolidationResponse = {
  state: "running" | "failed" | "completed";
  model: string;
  thinkingLevel: string | null;
  traceTaskId: number | null;
  failure: string | null;
  merged: number | null;
  retargeted: number | null;
};

type RuleSetResponse = {
  version: number | null;
  rules: { id: number; type: "rule" | "fact"; statement: string }[];
  consolidation: ConsolidationResponse | null;
  proposals: ProposalResponse[];
};

function source(overrides: Partial<RuleProposalSourceInput> = {}): RuleProposalSourceInput {
  return { origin: "disposition-feedback", note: null, findingId: null, traceTaskId: null, ...overrides };
}

function proposal(overrides: Partial<RuleProposalInput> = {}): RuleProposalInput {
  return {
    type: "rule",
    change: "add",
    targetRuleId: null,
    scope: "",
    statement: "新提的一条规范陈述",
    sources: [source()],
    ...overrides,
  };
}

async function scopedUser(
  h: PanelHarness,
  username: string,
  repoIds: readonly number[],
  permissions: readonly PanelPermission[] = [],
): Promise<string> {
  const store = openStore(h.db.path);
  try {
    store.createPanelUser({
      username,
      displayName: null,
      passwordHash: await hashPassword(PASSWORD),
      mustChangePassword: false,
      createdAt: AT,
      isSystemAdmin: false,
      roleId: null,
    });
    store.setPanelUserAssignment(username, repoIds);
    if (permissions.length > 0) {
      const role = store.createPanelRole({
        name: `role-${username}`,
        permissions: [...permissions],
        createdAt: AT,
      });
      assert.equal(
        store.updatePanelUser(username, {
          displayName: null,
          roleId: role.id,
          isSystemAdmin: false,
        }),
        "updated",
      );
    }
  } finally {
    store.close();
  }
  const response = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

function get(h: PanelHarness, cookie: string, path: string): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, { headers: { cookie } });
}

function send(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function ruleSet(h: PanelHarness, cookie: string): Promise<RuleSetResponse> {
  const response = await get(h, cookie, `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(response.status, 200);
  return (await response.json()) as RuleSetResponse;
}

/** 脚本化整理 agent:记下每次收到的任务,产出由回调给出(提案标识建库之后才知道)。 */
function scriptedRuleAgent(
  produce: () => { actions?: RuleConsolidationAction[]; failure?: string } | Promise<{
    actions?: RuleConsolidationAction[];
    failure?: string;
  }>,
): RuleAgent & { calls: RuleAgentRequest[] } {
  const calls: RuleAgentRequest[] = [];
  const agent = async (request: RuleAgentRequest) => {
    calls.push(request);
    return { items: [], ...(await produce()) };
  };
  return Object.assign(agent, { calls });
}

/** 已注册、已确认一条生效条目的仓库,外加一个有 `knowledge:write` 的人。 */
async function consolidatingHarness(
  agent: RuleAgent,
): Promise<{ h: PanelHarness; cookie: string }> {
  const h = await startReadyPanelHarness(cleanups, { ruleAgent: agent });
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  await h.worktreesPreparedAtLeast(1);
  const cookie = await scopedUser(h, "consolidation-writer", [GITEA_REPO.id], ["knowledge:write"]);
  assert.equal(
    (await send(h, cookie, "POST", `/repos/${GITEA_REPO.id}/rules`, {
      type: "rule",
      scope: "",
      statement: "入参要在边界上校验",
    })).status,
    201,
  );
  return { h, cookie };
}

/** 往队列里排几条提案。返回它们的标识,按排入顺序。 */
function seedProposals(dbPath: string, inputs: readonly RuleProposalInput[]): number[] {
  const store = openStore(dbPath);
  try {
    return inputs.map((input) => store.addRuleProposal(GITEA_REPO.id, input)!);
  } finally {
    store.close();
  }
}

function launch(h: PanelHarness, cookie: string): Promise<Response> {
  return send(h, cookie, "POST", `/repos/${GITEA_REPO.id}/rule-consolidation`, {
    provider: "test",
    model: "global-model",
  });
}

test("合并落地:保留 id 最小的一行,其余删除、附注全部并入、陈述覆盖", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 90, owner: "acme", repo: "tidied", generation: 1, key: "k" });
    const first = store.addRuleProposal(90, proposal({
      statement: "越界要在边界上判",
      sources: [source({ note: "第一条备注" })],
    }))!;
    const second = store.addRuleProposal(90, proposal({
      statement: "越界判在边界",
      sources: [source({ note: "第二条备注" })],
    }))!;
    const third = store.addRuleProposal(90, proposal({
      statement: "边界上判越界",
      sources: [source({ note: "第三条备注" })],
    }))!;

    // 保留哪一行不看给的顺序:落地一律留 id 最小的那一条。
    assert.equal(store.mergeRuleProposals(90, [third, second, first], "越界一律在边界上一次判掉"), true);
    const queue = store.getRuleProposals(90);
    assert.deepEqual(queue.map((row) => row.id), [first]);
    assert.equal(queue[0]!.statement, "越界一律在边界上一次判掉");
    assert.deepEqual(
      queue[0]!.sources.map((row) => row.note),
      ["第一条备注", "第二条备注", "第三条备注"],
    );
  } finally {
    store.close();
  }
});

test("合并的守门:少于两条、空陈述、已裁决的一条、以及不是同一件事的几条一律不合", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 91, owner: "acme", repo: "guarded", generation: 1, key: "k" });
    const rule = store.addReviewRule(91, { type: "rule", scope: "", statement: "已经生效的一条" })!;
    const add = store.addRuleProposal(91, proposal({ statement: "新增一条" }))!;
    const other = store.addRuleProposal(91, proposal({ statement: "新增另一条" }))!;
    const retire = store.addRuleProposal(91, proposal({
      change: "retire",
      targetRuleId: rule,
      statement: "废止那一条",
    }))!;
    const decided = store.addRuleProposal(91, proposal({ statement: "会被驳回的那条" }))!;

    assert.equal(store.mergeRuleProposals(91, [add], "只有一条"), false);
    assert.equal(store.mergeRuleProposals(91, [add, other], "   "), false);
    // 变更类型不同的不是重复:合并会把一条废止连同它的出处一起删掉。
    assert.equal(store.mergeRuleProposals(91, [add, retire], "混起来的一句"), false);

    // 整理期间人照常裁决:被并的一条已经不在待裁决队列里,那一次合并整个跳过。
    assert.equal(store.rejectRuleProposal(91, decided), true);
    assert.equal(store.mergeRuleProposals(91, [add, decided], "合不了的一句"), false);
    assert.deepEqual(
      store.getRuleProposals(91).map((row) => row.id),
      [add, other, retire, decided],
    );
    assert.equal(store.getRuleProposals(91)[0]!.statement, "新增一条");
  } finally {
    store.close();
  }
});

test("改写为修改型:指向那条生效条目;目标不生效、不同型、不是新增型的一律丢弃", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 92, owner: "acme", repo: "retargeted", generation: 1, key: "k" });
    const rule = store.addReviewRule(92, { type: "rule", scope: "", statement: "已经生效的规则" })!;
    const fact = store.addReviewRule(92, { type: "fact", scope: "", statement: "已经生效的事实" })!;
    const add = store.addRuleProposal(92, proposal({ statement: "现集已经有的那条" }))!;
    const factAdd = store.addRuleProposal(92, proposal({ type: "fact", statement: "另一条事实" }))!;

    // 两者不同型时改写丢掉:不同型的修改采纳不了,改出来只剩一条裁不掉的。
    assert.equal(store.retargetRuleProposal(92, add, fact), false);
    // 目标不生效同样丢掉。
    assert.equal(store.retargetRuleProposal(92, add, 4242), false);

    assert.equal(store.retargetRuleProposal(92, add, rule), true);
    const retargeted = store.getRuleProposals(92).find((row) => row.id === add)!;
    assert.equal(retargeted.change, "modify");
    assert.equal(retargeted.targetRuleId, rule);
    assert.equal(retargeted.statement, "现集已经有的那条");
    // 已经是修改型的改不了第二次:改写只对新增型成立。
    assert.equal(store.retargetRuleProposal(92, add, rule), false);

    // 目标被人废止之后,这一条改写丢掉。
    assert.notEqual(store.retireReviewRule(92, fact), undefined);
    assert.equal(store.retargetRuleProposal(92, factAdd, fact), false);
  } finally {
    store.close();
  }
});

test("整理与探索共用同仓库同时只跑一个,重启改判失败,移除仓库把整理一并摘掉", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 93, owner: "acme", repo: "exclusive", generation: 1, key: "k" });
    assert.equal(store.getRuleConsolidation(93), null);
    // 没注册的仓库发起不了。
    assert.equal(store.startRuleConsolidation(999, { model: "test:m", startedAt: AT }), false);

    assert.equal(store.startRuleConsolidation(93, { model: "test:m", startedAt: AT }), true);
    assert.equal(store.getRuleConsolidation(93)?.state, "running");
    // 整理在跑:整理与探索都发起不了。
    assert.equal(store.startRuleConsolidation(93, { model: "test:m", startedAt: AT }), false);
    assert.equal(
      store.startRuleExploration(93, { baselineSha: "abc1234", model: "test:m", startedAt: AT }),
      false,
    );

    store.finishRuleConsolidation(93, { merged: 2, retargeted: 1 }, AT);
    const done = store.getRuleConsolidation(93)!;
    assert.equal(done.state, "completed");
    assert.equal(done.merged, 2);
    assert.equal(done.retargeted, 1);

    // 反过来也拦:探索在跑时整理发起不了。
    assert.equal(
      store.startRuleExploration(93, { baselineSha: "abc1234", model: "test:m", startedAt: AT }),
      true,
    );
    assert.equal(store.startRuleConsolidation(93, { model: "test:m", startedAt: AT }), false);
    store.finishRuleExploration(93, [], AT);

    // 重启改判失败,面板因此给得出重试入口;摘要清回没跑完的样子。
    assert.equal(
      store.startRuleConsolidation(93, { model: "test:m", thinkingLevel: "high", startedAt: AT }),
      true,
    );
    assert.equal(store.getRuleConsolidation(93)?.merged, null);
    store.failInterruptedRuleConsolidations("服务重启,上一次整理没跑完", AT);
    const failed = store.getRuleConsolidation(93)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure, "服务重启,上一次整理没跑完");
    assert.equal(failed.thinkingLevel, "high");

    store.removeRepo(93);
    assert.equal(store.getRuleConsolidation(93), null);
  } finally {
    store.close();
  }
});

test("面板发起知识整理:agent 拿到现集与待裁决队列,合并与改写落地,摘要可见", async () => {
  let ids: number[] = [];
  const agent = scriptedRuleAgent(() => ({
    actions: [
      { kind: "merge", keepId: ids[0]!, mergedIds: [ids[0]!, ids[1]!], statement: "合成后的那一句" },
      { kind: "retarget", proposalId: ids[2]!, targetRuleId: 1 },
    ],
  }));
  const { h, cookie } = await consolidatingHarness(agent);
  ids = seedProposals(h.db.path, [
    proposal({ statement: "第一条", sources: [source({ note: "第一条备注" })] }),
    proposal({ statement: "第二条", sources: [source({ note: "第二条备注" })] }),
    proposal({ statement: "与现集重复的那条" }),
  ]);

  const started = await launch(h, cookie);
  assert.equal(started.status, 202);
  await h.consolidationsAtLeast(1);
  assert.deepEqual(h.consolidations, [{ repoId: GITEA_REPO.id }]);

  // 输入:现集与待裁决队列(连标识、变更类型、目标、陈述与附注),不派生工作树读代码。
  assert.equal(agent.calls.length, 1);
  const request = agent.calls[0]!;
  assert.equal(request.baselineSha, undefined);
  assert.deepEqual(
    request.existingKnowledge.map((entry) => [entry.type, entry.statement]),
    [["rule", "入参要在边界上校验"]],
  );
  assert.deepEqual(
    (request.consolidation?.proposals ?? []).map((row: ConsolidationProposal) => [
      row.id,
      row.change,
      row.targetRuleId,
      row.statement,
      row.sources.map((entry) => [entry.origin, entry.note]),
    ]),
    [
      [ids[0], "add", null, "第一条", [["disposition-feedback", "第一条备注"]]],
      [ids[1], "add", null, "第二条", [["disposition-feedback", "第二条备注"]]],
      [ids[2], "add", null, "与现集重复的那条", [["disposition-feedback", null]]],
    ],
  );

  const after = await ruleSet(h, cookie);
  assert.equal(after.consolidation?.state, "completed");
  assert.equal(after.consolidation?.model, "test:global-model");
  // 摘要:队列因此少了 1 行、改写了 1 条。
  assert.equal(after.consolidation?.merged, 1);
  assert.equal(after.consolidation?.retargeted, 1);
  assert.deepEqual(
    after.proposals.map((row) => [row.id, row.change, row.targetRuleId, row.statement]),
    [
      [ids[0], "add", null, "合成后的那一句"],
      [ids[2], "modify", after.rules[0]!.id, "与现集重复的那条"],
    ],
  );
  // 附注并入保留行:人据此看得出这一条被哪几件事提过。
  assert.deepEqual(
    after.proposals[0]!.sources.map((row) => row.note),
    ["第一条备注", "第二条备注"],
  );
});

test("整理期间的裁决照常:那一次合并跳过,别的动作照落,轨迹与摘要说得出结果", async () => {
  let ids: number[] = [];
  let cookieForReject = "";
  let harness: PanelHarness | undefined;
  const agent = scriptedRuleAgent(async () => {
    // agent 还在跑的这一刻有人裁掉了一条:整理不锁队列,裁决照常成立。
    const rejected = await send(
      harness!,
      cookieForReject,
      "POST",
      `/repos/${GITEA_REPO.id}/rule-proposals/${ids[1]}/reject`,
    );
    assert.equal(rejected.status, 200);
    return {
      actions: [
        { kind: "merge", keepId: ids[0]!, mergedIds: [ids[0]!, ids[1]!], statement: "合不成的那一句" },
        { kind: "retarget", proposalId: ids[2]!, targetRuleId: 1 },
      ],
    };
  });
  const { h, cookie } = await consolidatingHarness(agent);
  harness = h;
  cookieForReject = cookie;
  ids = seedProposals(h.db.path, [
    proposal({ statement: "第一条" }),
    proposal({ statement: "整理期间被驳回的那条" }),
    proposal({ statement: "与现集重复的那条" }),
  ]);

  assert.equal((await launch(h, cookie)).status, 202);
  await h.consolidationsAtLeast(1);

  const after = await ruleSet(h, cookie);
  // 被并的一条已经不待裁决:那一次合并整个跳过,第一条的陈述原样留着。
  assert.equal(after.consolidation?.merged, 0);
  assert.equal(after.consolidation?.retargeted, 1);
  assert.deepEqual(
    after.proposals.map((row) => [row.id, row.state, row.change, row.statement]),
    [
      [ids[0], "pending", "add", "第一条"],
      [ids[1], "rejected", "add", "整理期间被驳回的那条"],
      [ids[2], "pending", "modify", "与现集重复的那条"],
    ],
  );

  // 轨迹与探索同一张表,面板从这一行的 traceTaskId 点进去。
  const taskId = after.consolidation!.traceTaskId!;
  assert.equal(typeof taskId, "number");
  const trace = await get(h, cookie, `/repos/${GITEA_REPO.id}/rule-traces/${taskId}`);
  assert.equal(trace.status, 200);
  const events = ((await trace.json()) as { events: { kind: string; payload: unknown }[] }).events;
  assert.deepEqual(
    events.map((event) => event.kind),
    ["rule_agent_started", "rule_consolidated", "rule_consolidated", "rule_agent_finished"],
  );
  assert.deepEqual(events.at(-1)!.payload, { merged: 0, retargeted: 1 });
});

test("整理失败留原因,与探索互斥回 409", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempt = 0;
  const agent = scriptedRuleAgent(async () => {
    attempt += 1;
    if (attempt === 1) return { failure: "模型没有回结果" };
    await gate;
    return { actions: [] };
  });
  const { h, cookie } = await consolidatingHarness(agent);

  assert.equal((await launch(h, cookie)).status, 202);
  await h.consolidationsAtLeast(1);
  const failed = await ruleSet(h, cookie);
  assert.equal(failed.consolidation?.state, "failed");
  assert.equal(failed.consolidation?.failure, "模型没有回结果");
  assert.equal(failed.consolidation?.merged, null);

  // 重试:第二次卡在 gate 上,这期间整理与探索都发起不了。
  assert.equal((await launch(h, cookie)).status, 202);
  assert.equal((await launch(h, cookie)).status, 409);
  const exploration = await send(h, cookie, "POST", `/repos/${GITEA_REPO.id}/rule-exploration`, {
    baseline: h.repo.baseSha,
    provider: "test",
    model: "global-model",
  });
  assert.equal(exploration.status, 409);
  release!();
  await h.consolidationsAtLeast(2);
  assert.equal((await ruleSet(h, cookie)).consolidation?.state, "completed");
});

test("没有 knowledge:write 的人发起不了整理,分配外 404,坏 body 400", async () => {
  const agent = scriptedRuleAgent(() => ({ actions: [] }));
  const { h, cookie } = await consolidatingHarness(agent);
  const path = `/repos/${GITEA_REPO.id}/rule-consolidation`;

  const reader = await scopedUser(h, "consolidation-reader", [GITEA_REPO.id]);
  assert.equal((await get(h, reader, `/repos/${GITEA_REPO.id}/rules`)).status, 200);
  assert.equal(
    (await send(h, reader, "POST", path, { provider: "test", model: "global-model" })).status,
    403,
  );

  const outsider = await scopedUser(h, "consolidation-outsider", [], ["knowledge:write"]);
  assert.equal(
    (await send(h, outsider, "POST", path, { provider: "test", model: "global-model" })).status,
    404,
  );

  for (const body of [
    {},
    { provider: "test" },
    { provider: "nope", model: "missing-model" },
    { provider: "test", model: "global-model", thinkingLevel: "turbo" },
  ]) {
    assert.equal((await send(h, cookie, "POST", path, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(agent.calls.length, 0);
});
