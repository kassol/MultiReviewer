/**
 * 修订提案队列与裁决(issue #207)。
 *
 * 两条缝:SQLite 临时库验提案状态机与三种变更类型各自的落库形态,面板 API 走真实 HTTP
 * 验知识集已确认时探索产出入队(含已确认的空知识集)、逐条裁决(原样采纳 / 改后采纳 /
 * 驳回)、采纳推进知识集版本与 `knowledge:write` 拦截。规则 agent 仍用脚本化实现注入,与
 * issue #205 同一个位置。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { PanelPermission } from "../src/panel/permissions.ts";
import { hashPassword } from "../src/panel/password.ts";
import { openStore, type RuleProposalInput } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem } from "../src/reviewer/rule-agent.ts";
import { makeDbPath } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  PANEL_PREFIX as PREFIX,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "proposal-test-password";
const AT = "2026-08-29T00:00:00.000Z";

type ProposalResponse = {
  id: number;
  change: "add" | "modify" | "retire";
  targetRuleId: number | null;
  scope: string;
  statement: string;
  layer: string;
  source: "baseline-exploration" | "disposition-feedback";
  sourceNote: string | null;
  state: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
};

type RuleSetResponse = {
  version: number | null;
  exploration: { state: "running" | "failed" | "completed" } | null;
  rules: { id: number; scope: string; statement: string; layer: string; origin: string }[];
  retired: { id: number; statement: string }[];
  draft: { id: number; statement: string }[];
  proposals: ProposalResponse[];
};

function proposal(overrides: Partial<RuleProposalInput> = {}): RuleProposalInput {
  return {
    type: "rule",
    change: "add",
    targetRuleId: null,
    traceTaskId: null,
    scope: "",
    statement: "新提的一条规范陈述",
    layer: "架构",
    source: "baseline-exploration",
    sourceNote: null,
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
  const response = await fetch(`${h.serverUrl}/${PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

function get(h: PanelHarness, cookie: string, path: string): Promise<Response> {
  return fetch(`${h.serverUrl}/${PREFIX}/api${path}`, { headers: { cookie } });
}

function send(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/${PREFIX}/api${path}`, {
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

/**
 * 注册 harness 那个真仓库、确认一组生效规则,再把探索交给一份可后填的脚本化产出——
 * agent 要提「对照现有规则的变更」,而目标规则的标识只有建完规则才知道。
 */
async function confirmedHarness(items: RuleAgentItem[]): Promise<{
  h: PanelHarness;
  cookie: string;
  agent: { calls: number };
}> {
  const state = { calls: 0 };
  const agent: RuleAgent = async () => {
    state.calls += 1;
    return { items };
  };
  const h = await startReadyPanelHarness(cleanups, { ruleAgent: agent });
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  await h.worktreesPreparedAtLeast(1);
  const cookie = await scopedUser(h, "proposal-writer", [GITEA_REPO.id], ["knowledge:write"]);
  for (const rule of [
    { scope: "", statement: "会被改的那条", layer: "架构" },
    { scope: "", statement: "会被废止的那条", layer: "安全" },
  ]) {
    assert.equal((await send(h, cookie, "POST", `/repos/${GITEA_REPO.id}/rules`, rule)).status, 201);
  }
  return { h, cookie, agent: state };
}

test("提案状态机:待裁决只裁一次,驳回不动知识集", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 80, owner: "acme", repo: "queued", generation: 1, key: "k" });
    assert.deepEqual(store.getRuleProposals(80), []);
    // 没注册的仓库排不进提案。
    assert.equal(store.addRuleProposal(999, proposal()), undefined);

    const id = store.addRuleProposal(80, proposal())!;
    const queued = store.getRuleProposals(80);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.state, "pending");
    assert.equal(queued[0]!.decidedAt, null);
    assert.equal(queued[0]!.source, "baseline-exploration");
    assert.equal(queued[0]!.sourceNote, null);

    assert.equal(store.rejectRuleProposal(80, id), true);
    assert.equal(store.getRuleProposals(80)[0]!.state, "rejected");
    assert.notEqual(store.getRuleProposals(80)[0]!.decidedAt, null);
    // 驳回只改状态:一版都不推进,知识集仍然没有确认过。
    assert.equal(store.getRuleSet(80)?.version, null);
    // 裁决过的提案裁不了第二次。
    assert.equal(store.rejectRuleProposal(80, id), false);
    assert.equal(store.acceptRuleProposal(80, id), undefined);
  } finally {
    store.close();
  }
});

test("三种变更类型各自的落库形态:新增进集、修改留下旧那版、废止只废止", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 81, owner: "acme", repo: "decided", generation: 1, key: "k" });
    store.addReviewRule(81, { type: "rule", scope: "", statement: "会被改的那条", layer: "架构" });
    assert.equal(store.addReviewRule(81, { type: "rule", scope: "", statement: "会被废止的那条", layer: "安全" }), 2);
    const [target, doomed] = store.getRuleSet(81)!.rules;

    const added = store.addRuleProposal(81, proposal({ statement: "探索提的新规则", scope: "src/**" }))!;
    const modified = store.addRuleProposal(
      81,
      proposal({ change: "modify", targetRuleId: target!.id, statement: "改过的陈述", layer: "架构" }),
    )!;
    const retired = store.addRuleProposal(
      81,
      proposal({ change: "retire", targetRuleId: doomed!.id, statement: "会被废止的那条", layer: "安全" }),
    )!;

    // 新增:出处沿用提案的出处,不记人工。
    assert.equal(store.acceptRuleProposal(81, added), 3);
    assert.deepEqual(
      store.getRuleSet(81)!.rules.map((rule) => [rule.statement, rule.origin]),
      [
        ["会被改的那条", "manual"],
        ["会被废止的那条", "manual"],
        ["探索提的新规则", "baseline-exploration"],
      ],
    );

    // 修改:旧行废止于新版、新内容作为新行生效,出处沿用旧行(改文字不改变它当初从哪来)。
    assert.equal(store.acceptRuleProposal(81, modified), 4);
    const afterModify = store.getRuleSet(81)!;
    assert.equal(afterModify.rules.find((rule) => rule.id === target!.id), undefined);
    const replacement = afterModify.rules.find((rule) => rule.statement === "改过的陈述")!;
    assert.equal(replacement.origin, "manual");
    assert.ok(afterModify.retired.some((rule) => rule.id === target!.id));

    // 废止:只让那一行停止生效,不写新行。
    assert.equal(store.acceptRuleProposal(81, retired), 5);
    const afterRetire = store.getRuleSet(81)!;
    assert.equal(afterRetire.rules.find((rule) => rule.id === doomed!.id), undefined);
    assert.deepEqual(
      afterRetire.rules.map((rule) => rule.statement),
      ["探索提的新规则", "改过的陈述"],
    );
    assert.deepEqual(
      store.getRuleProposals(81).map((row) => row.state),
      ["accepted", "accepted", "accepted"],
    );
  } finally {
    store.close();
  }
});

test("采纳前改内容:落库的是改后的那一份,队列里也留改后的", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 82, owner: "acme", repo: "edited", generation: 1, key: "k" });
    const id = store.addRuleProposal(82, proposal({ statement: "原样的陈述" }))!;
    assert.equal(
      store.acceptRuleProposal(82, id, { type: "rule", scope: "src/**", statement: "改后的陈述", layer: "安全" }),
      1,
    );
    assert.deepEqual(
      store.getRuleSet(82)!.rules.map((rule) => [rule.scope, rule.statement, rule.layer]),
      [["src/**", "改后的陈述", "安全"]],
    );
    const decided = store.getRuleProposals(82)[0]!;
    assert.equal(decided.statement, "改后的陈述");
    assert.equal(decided.layer, "安全");
  } finally {
    store.close();
  }
});

test("目标规则已经不生效时采纳不了,一版都不推进;移除仓库摘掉整条队列", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 83, owner: "acme", repo: "stale", generation: 1, key: "k" });
    store.addReviewRule(83, { type: "rule", scope: "", statement: "先有的那条", layer: "架构" });
    const rule = store.getRuleSet(83)!.rules[0]!;
    const id = store.addRuleProposal(
      83,
      proposal({ change: "modify", targetRuleId: rule.id, statement: "改过的陈述" }),
    )!;
    assert.equal(store.retireReviewRule(83, rule.id), 2);

    assert.equal(store.acceptRuleProposal(83, id), undefined);
    assert.equal(store.getRuleSet(83)!.version, 2);
    assert.equal(store.getRuleProposals(83)[0]!.state, "pending");
    // 目标没了仍然驳得回:队列不该留下裁不掉的条目。
    assert.equal(store.rejectRuleProposal(83, id), true);

    store.removeRepo(83);
    assert.deepEqual(store.getRuleProposals(83), []);
  } finally {
    store.close();
  }
});

test("知识集已确认时探索产出进提案队列,草案一行不动", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie, agent } = await confirmedHarness(items);
  const rules = (await ruleSet(h, cookie)).rules;
  items.push(
    { scope: "", statement: "改过的陈述", layer: "架构", targetRuleId: rules[0]!.id },
    { scope: "", statement: "会被废止的那条", layer: "安全", targetRuleId: rules[1]!.id, retire: true },
    { scope: "src/**", statement: "全新的一条", layer: "测试" },
    // 对不上现有规则的废止不成其为一条变更,丢掉。
    { scope: "", statement: "对不上目标的废止", layer: "架构", targetRuleId: 4242, retire: true },
  );

  const started = await send(h, cookie, "POST", `/repos/${GITEA_REPO.id}/rule-exploration`, {
    baseline: h.repo.baseSha,
    provider: "test",
    model: "global-model",
  });
  assert.equal(started.status, 202);
  await h.explorationsAtLeast(1);
  assert.equal(agent.calls, 1);

  const body = await ruleSet(h, cookie);
  assert.equal(body.exploration?.state, "completed");
  // 草案是「还没有知识集时那一整份」,这条链路不碰它。
  assert.deepEqual(body.draft, []);
  assert.deepEqual(
    body.proposals.map((row) => [row.change, row.targetRuleId, row.statement, row.source, row.state]),
    [
      ["modify", rules[0]!.id, "改过的陈述", "baseline-exploration", "pending"],
      ["retire", rules[1]!.id, "会被废止的那条", "baseline-exploration", "pending"],
      ["add", null, "全新的一条", "baseline-exploration", "pending"],
    ],
  );
  // 知识集本身还没动:提案要人裁决才落。
  assert.equal(body.version, 2);
  assert.equal(body.rules.length, 2);
});

test("逐条裁决:改后采纳、原样采纳与驳回,只有采纳推进知识集版本", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  const rules = (await ruleSet(h, cookie)).rules;
  items.push(
    { scope: "", statement: "agent 提的改法", layer: "架构", targetRuleId: rules[0]!.id },
    { scope: "", statement: "会被废止的那条", layer: "安全", targetRuleId: rules[1]!.id, retire: true },
    { scope: "src/**", statement: "全新的一条", layer: "测试" },
  );
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-exploration`, {
      baseline: h.repo.baseSha,
      provider: "test",
      model: "global-model",
    })).status,
    202,
  );
  await h.explorationsAtLeast(1);
  const queued = (await ruleSet(h, cookie)).proposals;
  assert.equal(queued.length, 3);

  // 改后采纳:落库的是人改过的那一份。
  const edited = await send(h, cookie, "POST", `${path}/rule-proposals/${queued[0]!.id}/accept`, {
    scope: "src/**",
    statement: "人改过的那条",
    layer: "架构",
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(await edited.json(), { version: 3 });

  // 原样采纳:不带 body 就按队列里那份落。
  const asIs = await send(h, cookie, "POST", `${path}/rule-proposals/${queued[1]!.id}/accept`);
  assert.equal(asIs.status, 200);
  assert.deepEqual(await asIs.json(), { version: 4 });

  // 驳回:只改状态,一版都不推进。
  const rejected = await send(h, cookie, "POST", `${path}/rule-proposals/${queued[2]!.id}/reject`);
  assert.equal(rejected.status, 200);

  const after = await ruleSet(h, cookie);
  assert.equal(after.version, 4);
  assert.deepEqual(
    after.rules.map((rule) => [rule.scope, rule.statement]),
    [["src/**", "人改过的那条"]],
  );
  assert.deepEqual(
    after.proposals.map((row) => [row.state, row.statement]),
    [
      ["accepted", "人改过的那条"],
      ["accepted", "会被废止的那条"],
      ["rejected", "全新的一条"],
    ],
  );
  // 裁决过的裁不了第二次,不存在的提案同形 404。
  assert.equal((await send(h, cookie, "POST", `${path}/rule-proposals/${queued[2]!.id}/accept`)).status, 404);
  assert.equal((await send(h, cookie, "POST", `${path}/rule-proposals/4242/reject`)).status, 404);
  // 改后采纳的 body 与手写规则同一道校验。
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-proposals/${queued[0]!.id}/accept`, {
      statement: " ",
      layer: "架构",
    })).status,
    400,
  );
});

test("没有 knowledge:write 的人裁决不了,但读得到提案队列", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  const rules = (await ruleSet(h, cookie)).rules;
  items.push({ scope: "", statement: "改过的陈述", layer: "架构", targetRuleId: rules[0]!.id });
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-exploration`, {
      baseline: h.repo.baseSha,
      provider: "test",
      model: "global-model",
    })).status,
    202,
  );
  await h.explorationsAtLeast(1);
  const queued = (await ruleSet(h, cookie)).proposals[0]!;

  const reader = await scopedUser(h, "proposal-reader", [GITEA_REPO.id]);
  const read = await get(h, reader, `${path}/rules`);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as RuleSetResponse).proposals.length, 1);
  assert.equal((await send(h, reader, "POST", `${path}/rule-proposals/${queued.id}/accept`)).status, 403);
  assert.equal((await send(h, reader, "POST", `${path}/rule-proposals/${queued.id}/reject`)).status, 403);

  // 分配外的仓库与没注册同形 404。
  const outsider = await scopedUser(h, "proposal-outsider", [], ["knowledge:write"]);
  assert.equal(
    (await send(h, outsider, "POST", `${path}/rule-proposals/${queued.id}/accept`)).status,
    404,
  );
  assert.equal((await ruleSet(h, cookie)).proposals[0]!.state, "pending");
});

test("已确认的空知识集重探索:产出仍进提案队列,不回到草案", async () => {
  const items: RuleAgentItem[] = [];
  const agent: RuleAgent = async () => ({ items });
  const h = await startReadyPanelHarness(cleanups, { ruleAgent: agent });
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  await h.worktreesPreparedAtLeast(1);
  const cookie = await scopedUser(h, "empty-set-writer", [GITEA_REPO.id], ["knowledge:write"]);
  const path = `/repos/${GITEA_REPO.id}`;

  // 确认一个空知识集(issue #200):规则一条都没有,但这个仓库已经确认过了。
  assert.equal((await send(h, cookie, "POST", `${path}/rule-draft/confirm`)).status, 200);
  assert.equal((await ruleSet(h, cookie)).version, 1);

  items.push({ scope: "", statement: "重探索提的那条", layer: "架构" });
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-exploration`, {
      baseline: h.repo.baseSha,
      provider: "test",
      model: "global-model",
    })).status,
    202,
  );
  await h.explorationsAtLeast(1);

  // 分界按有没有知识集版本取:已确认的空集重探索走提案队列,不再产出草案。
  const body = await ruleSet(h, cookie);
  assert.deepEqual(body.draft, []);
  assert.deepEqual(
    body.proposals.map((row) => [row.change, row.targetRuleId, row.statement, row.state]),
    [["add", null, "重探索提的那条", "pending"]],
  );
  assert.equal(body.version, 1);
  assert.deepEqual(body.rules, []);
});
