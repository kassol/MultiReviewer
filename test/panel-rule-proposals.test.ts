/**
 * 修订提案队列与裁决(issue #207)。
 *
 * 两条缝:SQLite 临时库验提案状态机与三种变更类型各自的落库形态,面板 API 走真实 HTTP
 * 验知识集已确认时探索产出入队(含已确认的空知识集)、逐条裁决(原样采纳 / 改后采纳 /
 * 驳回)、采纳推进知识集版本与 `knowledge:write` 拦截。规则 agent 仍用脚本化实现注入,与
 * issue #205 同一个位置。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { PanelPermission } from "../src/panel/permissions.ts";
import { hashPassword } from "../src/panel/password.ts";
import {
  openStore,
  type RuleProposalInput,
  type RuleProposalSourceInput,
} from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem } from "../src/reviewer/rule-agent.ts";
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

const PASSWORD = "proposal-test-password";
const AT = "2026-08-29T00:00:00.000Z";

type ProposalResponse = {
  id: number;
  type: "rule" | "fact";
  change: "add" | "modify" | "retire" | "merge";
  targetRuleIds: number[];
  scope: string;
  statement: string;
  /** 出处附注列表(issue #281)。一行一条,至少一条。 */
  sources: {
    origin: "baseline-exploration" | "disposition-feedback" | "knowledge-consolidation";
    note: string | null;
    evidence: string | null;
    findingId: number | null;
    findingStageId: string | null;
    traceTaskId: number | null;
  }[];
  state: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
};

type RuleSetResponse = {
  version: number | null;
  exploration: { state: "running" | "failed" | "completed" } | null;
  rules: { id: number; type: "rule" | "fact"; scope: string; statement: string; origin: string }[];
  retired: { id: number; statement: string }[];
  draft: { id: number; statement: string }[];
  proposals: ProposalResponse[];
};

function proposal(overrides: Partial<RuleProposalInput> = {}): RuleProposalInput {
  return {
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement: "新提的一条规范陈述",
    sources: [source()],
    ...overrides,
  };
}

/** 一条出处附注(CONTEXT.md 出处附注,issue #281)。不给即一条基点探索的。 */
function source(
  overrides: Partial<RuleProposalSourceInput> = {},
): RuleProposalSourceInput {
  return {
    origin: "baseline-exploration",
    note: null,
    evidence: null,
    findingId: null,
    traceTaskId: null,
    ...overrides,
  };
}

/** 库里现存的出处附注行数。取代与级联要看得出「附注跟着提案走」。 */
function proposalSourceRows(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS rows FROM rule_proposal_source").get()!["rows"]);
  } finally {
    db.close();
  }
}

/** 每条知识条目的生效版本与废止版本。合并要看得出「一起废止于新版、新行生效于同一版」。 */
function ruleVersions(dbPath: string): (number | null)[][] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, effective_version, retired_version FROM review_rule ORDER BY id")
      .all()
      .map((row) => [
        Number(row["id"]),
        Number(row["effective_version"]),
        row["retired_version"] === null ? null : Number(row["retired_version"]),
      ]);
  } finally {
    db.close();
  }
}

/** `rule_proposal` 现在有哪几列。迁移后的形状要看得见。 */
function columnNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("PRAGMA table_info(rule_proposal)").all().map((row) => String(row["name"]));
  } finally {
    db.close();
  }
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
    { type: "rule", scope: "", statement: "会被改的那条" },
    { type: "rule", scope: "", statement: "会被废止的那条" },
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
    assert.deepEqual(
      queued[0]!.sources.map((row) => [row.origin, row.note, row.findingId, row.traceTaskId]),
      [["baseline-exploration", null, null, null]],
    );

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
    store.addReviewRule(81, { type: "rule", scope: "", statement: "会被改的那条" });
    assert.equal(store.addReviewRule(81, { type: "rule", scope: "", statement: "会被废止的那条" }), 2);
    const [target, doomed] = store.getRuleSet(81)!.rules;

    const added = store.addRuleProposal(81, proposal({ statement: "探索提的新规则", scope: "src/**" }))!;
    const modified = store.addRuleProposal(
      81,
      proposal({ change: "modify", targetRuleIds: [target!.id], statement: "改过的陈述" }),
    )!;
    const retired = store.addRuleProposal(
      81,
      proposal({ change: "retire", targetRuleIds: [doomed!.id], statement: "会被废止的那条" }),
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
      store.acceptRuleProposal(82, id, { type: "rule", scope: "src/**", statement: "改后的陈述" }),
      1,
    );
    assert.deepEqual(
      store.getRuleSet(82)!.rules.map((rule) => [rule.scope, rule.statement]),
      [["src/**", "改后的陈述"]],
    );
    const decided = store.getRuleProposals(82)[0]!;
    assert.equal(decided.statement, "改后的陈述");
    assert.equal(decided.scope, "src/**");
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
    store.addReviewRule(83, { type: "rule", scope: "", statement: "先有的那条" });
    const rule = store.getRuleSet(83)!.rules[0]!;
    const id = store.addRuleProposal(
      83,
      proposal({ change: "modify", targetRuleIds: [rule.id], statement: "改过的陈述" }),
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

test("合并型采纳:目标全部废止于新版、合成的那条生效于新版,出处记提案自己的", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 84, owner: "acme", repo: "merged", generation: 1, key: "k" });
    for (const statement of ["重复的甲", "重复的乙", "不相干的那条"]) {
      store.addReviewRule(84, { type: "rule", scope: "", statement });
    }
    const [first, second, other] = store.getRuleSet(84)!.rules;
    const id = store.addRuleProposal(
      84,
      proposal({
        change: "merge",
        targetRuleIds: [first!.id, second!.id],
        scope: "src/**",
        statement: "合起来的那一句",
        sources: [source({ origin: "disposition-feedback", note: "两条说的是同一件事" })],
      }),
    )!;

    assert.equal(store.acceptRuleProposal(84, id), 4);
    const after = store.getRuleSet(84)!;
    // 两条目标一起停止生效,合成的那一条以提案自己的出处进集(不沿用目标的 manual)。
    assert.deepEqual(
      after.rules.map((rule) => [rule.statement, rule.scope, rule.origin]),
      [
        ["不相干的那条", "", "manual"],
        ["合起来的那一句", "src/**", "disposition-feedback"],
      ],
    );
    assert.deepEqual(
      after.retired.map((rule) => rule.id).sort(),
      [first!.id, second!.id].sort(),
    );
    // 两条目标废止于新版,合成的那一条生效于同一版:合并在版本轴上是一格。
    assert.deepEqual(ruleVersions(db.path), [
      [first!.id, 1, 4],
      [second!.id, 2, 4],
      [other!.id, 3, null],
      [after.rules[1]!.id, 4, null],
    ]);
  } finally {
    store.close();
  }
});

test("合并型:任一目标已不生效即采纳不了,驳回照常;改后采纳同样成立", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 85, owner: "acme", repo: "merge-stale", generation: 1, key: "k" });
    for (const statement of ["甲", "乙", "丙", "丁"]) {
      store.addReviewRule(85, { type: "rule", scope: "", statement });
    }
    const [a, b, c, d] = store.getRuleSet(85)!.rules;
    const stale = store.addRuleProposal(
      85,
      proposal({ change: "merge", targetRuleIds: [a!.id, b!.id], statement: "合甲乙" }),
    )!;
    const edited = store.addRuleProposal(
      85,
      proposal({ change: "merge", targetRuleIds: [c!.id, d!.id], statement: "合丙丁" }),
    )!;
    // 一条目标被人先手工废止:那一条合并落下去会凭空复活它。
    assert.equal(store.retireReviewRule(85, b!.id), 5);

    assert.equal(store.acceptRuleProposal(85, stale), undefined);
    assert.equal(store.getRuleSet(85)!.version, 5);
    assert.equal(store.getRuleProposals(85)[0]!.state, "pending");
    // 目标没了仍然驳得回,与修改型同一条口径。
    assert.equal(store.rejectRuleProposal(85, stale), true);

    // 改后采纳:落进知识集与留在队列里的都是人改过的那一份。
    assert.equal(
      store.acceptRuleProposal(85, edited, {
        type: "rule",
        scope: "src/**",
        statement: "人改过的合并陈述",
      }),
      6,
    );
    const after = store.getRuleSet(85)!;
    assert.deepEqual(
      after.rules.map((rule) => rule.statement),
      ["甲", "人改过的合并陈述"],
    );
    assert.equal(store.getRuleProposals(85)[1]!.statement, "人改过的合并陈述");
  } finally {
    store.close();
  }
});

test("知识集已确认时探索产出进提案队列,草案一行不动", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie, agent } = await confirmedHarness(items);
  const rules = (await ruleSet(h, cookie)).rules;
  items.push(
    { type: "rule", scope: "", statement: "改过的陈述", targetRuleIds: [rules[0]!.id] },
    { type: "rule", scope: "", statement: "会被废止的那条", targetRuleIds: [rules[1]!.id], retire: true },
    { type: "rule", scope: "src/**", statement: "全新的一条" },
    // 对不上现有规则的废止不成其为一条变更,丢掉。
    { type: "rule", scope: "", statement: "对不上目标的废止", targetRuleIds: [4242], retire: true },
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
    body.proposals.map((row) => [row.change, row.targetRuleIds, row.statement, row.state]),
    [
      ["modify", [rules[0]!.id], "改过的陈述", "pending"],
      ["retire", [rules[1]!.id], "会被废止的那条", "pending"],
      ["add", [], "全新的一条", "pending"],
    ],
  );
  // 探索产出各带一条基点探索附注:没有备注、没有 Finding,轨迹是这一次探索那条。
  for (const row of body.proposals) {
    assert.equal(row.sources.length, 1);
    assert.equal(row.sources[0]!.origin, "baseline-exploration");
    assert.equal(row.sources[0]!.note, null);
    assert.equal(row.sources[0]!.findingId, null);
    assert.equal(row.sources[0]!.findingStageId, null);
    assert.equal(typeof row.sources[0]!.traceTaskId, "number");
  }
  // 知识集本身还没动:提案要人裁决才落。
  assert.equal(body.version, 2);
  assert.equal(body.rules.length, 2);
});

test("多目标映射为合并型:认不出的目标丢掉,只剩一个即退化为修改,带废止标记的整条丢掉", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  // 合并要两条目标,退化那一档另要一条:确认好的那两条之外再加一条。
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rules`, {
      type: "rule",
      scope: "",
      statement: "第三条",
    })).status,
    201,
  );
  const rules = (await ruleSet(h, cookie)).rules;
  items.push(
    // 认得出两条目标即合并型。
    {
      type: "rule",
      scope: "src/**",
      statement: "合起来的那一句",
      targetRuleIds: [rules[0]!.id, rules[1]!.id],
    },
    // 认得出的只剩一条:退化为修改。
    { type: "rule", scope: "", statement: "只认得出一个", targetRuleIds: [rules[2]!.id, 4242] },
    // 一条都认不出:与不给目标同义,成为新增。
    { type: "rule", scope: "", statement: "目标全认不出", targetRuleIds: [4242, 4243] },
    // 废止只认单目标:认得出的目标不止一条,整条丢掉。
    {
      type: "rule",
      scope: "",
      statement: "废止两条",
      targetRuleIds: [rules[0]!.id, rules[2]!.id],
      retire: true,
    },
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
  assert.deepEqual(
    queued.map((row) => [row.change, row.targetRuleIds, row.statement]),
    [
      ["merge", [rules[0]!.id, rules[1]!.id], "合起来的那一句"],
      ["modify", [rules[2]!.id], "只认得出一个"],
      ["add", [], "目标全认不出"],
    ],
  );

  // 目标先被人手工废止:这一条合并采纳不了,404 那句话与修改型逐字相同。
  assert.equal(
    (await send(h, cookie, "DELETE", `${path}/rules/${rules[1]!.id}`)).status,
    200,
  );
  const stale = await send(h, cookie, "POST", `${path}/rule-proposals/${queued[0]!.id}/accept`);
  assert.equal(stale.status, 404);
  assert.match(
    ((await stale.json()) as { error: string }).error,
    /已经不再生效/,
  );
  // 驳回照常:队列不该留下裁不掉的条目。
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-proposals/${queued[0]!.id}/reject`)).status,
    200,
  );
});

test("单目标合并即改型:同型仍是修改,采纳把目标换成新型的那一条", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  const rules = (await ruleSet(h, cookie)).rules;
  items.push(
    // 一条目标而型与它不同:合并型,型由新陈述定(spec #286)。
    { type: "fact", scope: "src/**", statement: "写成事实的那一句", targetRuleIds: [rules[0]!.id] },
    // 同型仍是修改:改的只是措辞。
    { type: "rule", scope: "", statement: "同型只是改写", targetRuleIds: [rules[1]!.id] },
    // 同一个目标的第二条改型:第一条采纳后它的目标就不生效了。
    { type: "fact", scope: "", statement: "同一个目标的第二条", targetRuleIds: [rules[0]!.id] },
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
  assert.deepEqual(
    queued.map((row) => [row.change, row.type, row.targetRuleIds, row.statement]),
    [
      ["merge", "fact", [rules[0]!.id], "写成事实的那一句"],
      ["modify", "rule", [rules[1]!.id], "同型只是改写"],
      ["merge", "fact", [rules[0]!.id], "同一个目标的第二条"],
    ],
  );

  // 采纳:目标废止于新版,新陈述以新的型生效于同一版,版本加一。
  const accepted = await send(h, cookie, "POST", `${path}/rule-proposals/${queued[0]!.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { version: 3 });
  const after = await ruleSet(h, cookie);
  assert.equal(after.version, 3);
  assert.equal(after.rules.some((row) => row.id === rules[0]!.id), false);
  assert.equal(after.retired.some((row) => row.id === rules[0]!.id), true);
  assert.deepEqual(
    after.rules
      .filter((row) => row.statement === "写成事实的那一句")
      .map((row) => [row.type, row.scope]),
    [["fact", "src/**"]],
  );

  // 目标已经不生效:同一目标的第二条采纳不了,与多目标合并同一句话;驳回照常。
  const stale = await send(h, cookie, "POST", `${path}/rule-proposals/${queued[2]!.id}/accept`);
  assert.equal(stale.status, 404);
  assert.match(((await stale.json()) as { error: string }).error, /已经不再生效/);
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-proposals/${queued[2]!.id}/reject`)).status,
    200,
  );
});

test("逐条裁决:改后采纳、原样采纳与驳回,只有采纳推进知识集版本", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  const rules = (await ruleSet(h, cookie)).rules;
  items.push(
    { type: "rule", scope: "", statement: "agent 提的改法", targetRuleIds: [rules[0]!.id] },
    { type: "rule", scope: "", statement: "会被废止的那条", targetRuleIds: [rules[1]!.id], retire: true },
    { type: "rule", scope: "src/**", statement: "全新的一条" },
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
    })).status,
    400,
  );
});

test("没有 knowledge:write 的人裁决不了,但读得到提案队列", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  const rules = (await ruleSet(h, cookie)).rules;
  items.push({ type: "rule", scope: "", statement: "改过的陈述", targetRuleIds: [rules[0]!.id] });
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

  items.push({ type: "rule", scope: "", statement: "重探索提的那条" });
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
    body.proposals.map((row) => [row.change, row.targetRuleIds, row.statement, row.state]),
    [["add", [], "重探索提的那条", "pending"]],
  );
  assert.equal(body.version, 1);
  assert.deepEqual(body.rules, []);
});

test("重探索只取代附注全部为基点探索的待裁决提案:带反哺与整理附注的、已裁决的留下", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 89, owner: "acme", repo: "overwritten", generation: 1, key: "k" });
    const staleId = store.addRuleProposal(89, proposal({ statement: "上一轮探索提的" }))!;
    const rejectedId = store.addRuleProposal(89, proposal({ statement: "早已驳回的" }))!;
    assert.equal(store.rejectRuleProposal(89, rejectedId), true);
    store.addRuleProposal(
      89,
      proposal({
        statement: "反哺提的",
        sources: [source({ origin: "disposition-feedback", note: "处置备注" })],
      }),
    );
    // 探索提出、之后被一次反哺再提到的那一条:附注不全是基点探索,取代不了它——人写
    // 的意见在这一条上,一次重探索不该把它抹掉。
    const mixedId = store.addRuleProposal(
      89,
      proposal({
        statement: "探索提的、反哺又提了一遍的",
        sources: [source(), source({ origin: "disposition-feedback", note: "又一条处置备注" })],
      }),
    )!;
    // 知识整理对现集提的那条同理(issue #285):它认出的重复不是一次重探索推得出来的。
    store.addRuleProposal(
      89,
      proposal({
        change: "retire",
        targetRuleIds: [7],
        statement: "整理提的废止",
        sources: [source({ origin: "knowledge-consolidation", note: "这一条现集已经过期" })],
      }),
    );

    store.finishRuleExplorationAsProposals(
      89,
      [proposal({ statement: "新一轮探索提的" })],
      "2026-08-30T00:00:00.000Z",
    );

    // 上一轮纯探索出处的待裁决行被这一批取代;驳回历史、反哺提案与混合出处的原地不动。
    const rows = store.getRuleProposals(89);
    assert.equal(rows.find((row) => row.id === staleId), undefined);
    assert.deepEqual(
      rows.map((row) => [row.statement, row.sources.map((entry) => entry.origin), row.state]),
      [
        ["早已驳回的", ["baseline-exploration"], "rejected"],
        ["反哺提的", ["disposition-feedback"], "pending"],
        [
          "探索提的、反哺又提了一遍的",
          ["baseline-exploration", "disposition-feedback"],
          "pending",
        ],
        ["整理提的废止", ["knowledge-consolidation"], "pending"],
        ["新一轮探索提的", ["baseline-exploration"], "pending"],
      ],
    );
    // 取代掉的那条连它的附注一起走,不留孤儿行。
    assert.deepEqual(
      rows.find((row) => row.id === mixedId)!.sources.map((entry) => entry.note),
      [null, "又一条处置备注"],
    );
    assert.equal(proposalSourceRows(db.path), 6);
  } finally {
    store.close();
  }
});

test("批量采纳一次只推进一个知识集版本;有一条落不下去就整组不做", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 84, owner: "acme", repo: "bulk", generation: 1, key: "k" });
    store.addReviewRule(84, { type: "rule", scope: "", statement: "会被改的那条" });
    const target = store.getRuleSet(84)!.rules[0]!;

    const ids = [
      store.addRuleProposal(84, proposal({ statement: "新提的第一条" }))!,
      store.addRuleProposal(84, proposal({ type: "fact", statement: "一条事实" }))!,
      store.addRuleProposal(
        84,
        proposal({ change: "modify", targetRuleIds: [target.id], statement: "改过的陈述" }),
      )!,
    ];

    // 空的一组不推版:一个空版本只会让版本轴多一格看不出来历的。
    assert.equal(store.acceptRuleProposals(84, []), undefined);
    // 同一条报两遍会被落两遍,库层自己拒,不指望端点那一道。
    assert.equal(store.acceptRuleProposals(84, [ids[0]!, ids[0]!]), undefined);
    assert.equal(store.rejectRuleProposals(84, [ids[0]!, ids[0]!]), false);
    // 有一条不在待裁决队列里就整组不做,一行都不改。
    assert.equal(store.acceptRuleProposals(84, [...ids, 4242]), undefined);
    assert.deepEqual(
      store.getRuleProposals(84).map((row) => row.state),
      ["pending", "pending", "pending"],
    );
    assert.equal(store.getRuleSet(84)!.version, 1);

    // 三条一起采纳:一个版本,不是三个。
    assert.equal(store.acceptRuleProposals(84, ids), 2);
    const after = store.getRuleSet(84)!;
    assert.equal(after.version, 2);
    assert.deepEqual(
      after.rules.map((entry) => [entry.type, entry.statement]),
      [
        ["rule", "新提的第一条"],
        ["fact", "一条事实"],
        ["rule", "改过的陈述"],
      ],
    );
    // 修改那一条的旧版本仍查得到:两态生命周期与逐条采纳同一条口径。
    assert.deepEqual(after.retired.map((entry) => entry.statement), ["会被改的那条"]);
    assert.deepEqual(
      store.getRuleProposals(84).map((row) => row.state),
      ["accepted", "accepted", "accepted"],
    );
    // 裁决过的裁不了第二次。
    assert.equal(store.acceptRuleProposals(84, ids), undefined);
  } finally {
    store.close();
  }
});

test("批量采纳里目标条目已经不生效:整组不做,一版都不推进", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 85, owner: "acme", repo: "stale-bulk", generation: 1, key: "k" });
    store.addReviewRule(85, { type: "rule", scope: "", statement: "先有的那条" });
    const rule = store.getRuleSet(85)!.rules[0]!;
    const ids = [
      store.addRuleProposal(85, proposal({ statement: "本来能落的那条" }))!,
      store.addRuleProposal(
        85,
        proposal({ change: "modify", targetRuleIds: [rule.id], statement: "改过的陈述" }),
      )!,
    ];
    assert.equal(store.retireReviewRule(85, rule.id), 2);

    assert.equal(store.acceptRuleProposals(85, ids), undefined);
    assert.equal(store.getRuleSet(85)!.version, 2);
    assert.deepEqual(
      store.getRuleProposals(85).map((row) => row.state),
      ["pending", "pending"],
    );
  } finally {
    store.close();
  }
});

test("批量驳回一组:全改状态,知识集一版都不推进", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 86, owner: "acme", repo: "bulk-reject", generation: 1, key: "k" });
    const ids = [
      store.addRuleProposal(86, proposal({ statement: "驳回的第一条" }))!,
      store.addRuleProposal(86, proposal({ statement: "驳回的第二条" }))!,
    ];

    assert.equal(store.rejectRuleProposals(86, []), false);
    assert.equal(store.rejectRuleProposals(86, [...ids, 4242]), false);
    assert.deepEqual(store.getRuleProposals(86).map((row) => row.state), ["pending", "pending"]);

    assert.equal(store.rejectRuleProposals(86, ids), true);
    assert.deepEqual(store.getRuleProposals(86).map((row) => row.state), ["rejected", "rejected"]);
    // 驳回不动知识集:这个仓库仍然没有确认过。
    assert.equal(store.getRuleSet(86)!.version, null);
  } finally {
    store.close();
  }
});

test("面板批量采纳与批量驳回:一次一版,坏 body 一律 400", async () => {
  const items: RuleAgentItem[] = [];
  const { h, cookie } = await confirmedHarness(items);
  const path = `/repos/${GITEA_REPO.id}`;
  items.push(
    { type: "rule", scope: "", statement: "批量提的第一条" },
    { type: "fact", scope: "", statement: "批量提的一条事实" },
    { type: "rule", scope: "", statement: "要被驳回的那条" },
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

  const before = await ruleSet(h, cookie);
  assert.equal(before.proposals.length, 3);
  const queued = before.proposals.map((row) => row.id);
  // 手工建的两条生效规则已经推到版本 2,批量采纳应当只再推一版。
  assert.equal(before.version, 2);

  for (const body of [{}, { ids: [] }, { ids: [1, 1] }, { ids: [0] }, { ids: ["7"] }]) {
    assert.equal(
      (await send(h, cookie, "POST", `${path}/rule-proposals/accept`, body)).status,
      400,
      JSON.stringify(body),
    );
  }

  const rejected = await send(h, cookie, "POST", `${path}/rule-proposals/reject`, {
    ids: [queued[2]],
  });
  assert.equal(rejected.status, 200);

  const accepted = await send(h, cookie, "POST", `${path}/rule-proposals/accept`, {
    ids: [queued[0], queued[1]],
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { version: 3 });

  const after = await ruleSet(h, cookie);
  assert.equal(after.version, 3);
  assert.deepEqual(
    after.proposals.map((row) => row.state),
    ["accepted", "accepted", "rejected"],
  );
  assert.deepEqual(
    after.rules.map((row) => row.statement),
    ["会被改的那条", "会被废止的那条", "批量提的第一条", "批量提的一条事实"],
  );

  // 已经裁决过的那一组整次 404,一版都不推进。
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-proposals/accept`, { ids: [queued[0]] })).status,
    404,
  );
  assert.equal((await ruleSet(h, cookie)).version, 3);
});

test("批量采纳里两条指向同一个目标:整组不做,不让一条规则裂成两条", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 87, owner: "acme", repo: "same-target", generation: 1, key: "k" });
    store.addReviewRule(87, { type: "rule", scope: "", statement: "本来那条" });
    const rule = store.getRuleSet(87)!.rules[0]!;
    // 同一次探索报两条 `rule_id` 相同的变更,或两次反哺各排一条,队列里就会并存。
    const twoModify = [
      store.addRuleProposal(
        87,
        proposal({ change: "modify", targetRuleIds: [rule.id], statement: "改法甲" }),
      )!,
      store.addRuleProposal(
        87,
        proposal({ change: "modify", targetRuleIds: [rule.id], statement: "改法乙" }),
      )!,
    ];

    // 逐条采纳没有这个问题:第一条落完目标就废止了,第二条自然裁不了。批量采纳按同一
    // 时刻算完再一起落,两条都算得过,落下去就是「旧行废止一次、新行插两遍」。
    assert.equal(store.acceptRuleProposals(87, twoModify), undefined);
    assert.equal(store.getRuleSet(87)!.version, 1);
    assert.deepEqual(store.getRuleProposals(87).map((row) => row.state), ["pending", "pending"]);

    // 修改与废止指向同一条同理:废止的意图会被修改插回的新行抵消。
    const mixed = [
      twoModify[0]!,
      store.addRuleProposal(
        87,
        proposal({ change: "retire", targetRuleIds: [rule.id], statement: "本来那条" }),
      )!,
    ];
    assert.equal(store.acceptRuleProposals(87, mixed), undefined);
    assert.equal(store.getRuleSet(87)!.version, 1);

    // 各指各的目标照常成组落下去。
    assert.equal(store.acceptRuleProposals(87, [twoModify[0]!]), 2);
    assert.deepEqual(store.getRuleSet(87)!.rules.map((row) => row.statement), ["改法甲"]);
  } finally {
    store.close();
  }
});

test("modify 提案翻不了型:采纳一条把规则改成事实的提案落不下去", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 88, owner: "acme", repo: "type-flip", generation: 1, key: "k" });
    store.addReviewRule(88, { type: "rule", scope: "", statement: "边界要校验" });
    const rule = store.getRuleSet(88)!.rules[0]!;

    // agent 提的 modify 自带 type=fact:采纳会把一条生效规则悄悄变成项目事实,从此
    // 不再产 Finding。修改不许翻型,要改型走「废止 + 新增」两条,意图才看得见。
    const flip = store.addRuleProposal(
      88,
      proposal({ type: "fact", change: "modify", targetRuleIds: [rule.id], statement: "边界已有校验" }),
    )!;
    assert.equal(store.acceptRuleProposal(88, flip), undefined);
    assert.equal(store.acceptRuleProposals(88, [flip]), undefined);
    // 人「改后采纳」时把 type 改成 fact 同样落不下去:守卫按改后的内容判。
    assert.equal(
      store.acceptRuleProposal(88, flip, { type: "fact", scope: "", statement: "边界已有校验" }),
      undefined,
    );
    assert.equal(store.getRuleSet(88)!.version, 1);
    assert.deepEqual(store.getRuleProposals(88).map((row) => row.state), ["pending"]);
    assert.equal(store.getRuleSet(88)!.rules[0]!.type, "rule");

    // 同型的 modify 不受影响,照常落下去。
    const sameType = store.addRuleProposal(
      88,
      proposal({ change: "modify", targetRuleIds: [rule.id], statement: "边界要在入口校验" }),
    )!;
    assert.equal(store.acceptRuleProposals(88, [sameType]), 2);
  } finally {
    store.close();
  }
});

test("存量提案迁移:三列各合成一条出处附注,来源、备注与轨迹逐字回读", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  // 升级前的形状:出处三列写在提案上,一条提案至多说得出一次来源。先建一份这样的库。
  const first = openStore(db.path);
  try {
    first.registerRepo({ repoId: 90, owner: "acme", repo: "legacy", generation: 1, key: "k" });
  } finally {
    first.close();
  }
  const raw = new DatabaseSync(db.path);
  try {
    raw.exec(`
      DROP TABLE rule_proposal;
      CREATE TABLE rule_proposal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repo(id),
        type TEXT NOT NULL DEFAULT 'rule' CHECK (type IN ('rule', 'fact')),
        change TEXT NOT NULL CHECK (change IN ('add', 'modify', 'retire')),
        target_rule_id INTEGER,
        scope TEXT NOT NULL,
        statement TEXT NOT NULL,
        layer TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('baseline-exploration', 'disposition-feedback')),
        source_note TEXT,
        trace_task_id INTEGER,
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        CHECK ((state = 'pending') = (decided_at IS NULL)),
        CHECK ((change = 'add') = (target_rule_id IS NULL))
      );
      INSERT INTO rule_proposal
          (id, repo_id, type, change, target_rule_id, scope, statement, layer, source,
           source_note, trace_task_id, state, created_at, decided_at)
        VALUES
          (7, 90, 'rule', 'add', NULL, 'src/**', '探索提的那条', '', 'baseline-exploration',
           NULL, 3, 'pending', '2026-08-29T00:00:00.000Z', NULL),
          (8, 90, 'fact', 'add', NULL, '', '反哺提的那条', '', 'disposition-feedback',
           '这类越界在边界上判', NULL, 'accepted', '2026-08-30T00:00:00.000Z',
           '2026-08-31T00:00:00.000Z'),
          (9, 90, 'rule', 'modify', 5, '', '改现集里那条', '', 'baseline-exploration',
           NULL, NULL, 'pending', '2026-08-30T00:00:00.000Z', NULL);
    `);
  } finally {
    raw.close();
  }

  const store = openStore(db.path);
  try {
    // 每行恰有一条附注,来源、备注原文与轨迹与迁移前一致;提案本身连状态一起原样。
    assert.deepEqual(
      store.getRuleProposals(90).map((row) => [
        row.id,
        row.type,
        row.statement,
        row.state,
        row.createdAt,
        row.sources.map((entry) => [entry.origin, entry.note, entry.traceTaskId, entry.findingId]),
      ]),
      [
        [
          7,
          "rule",
          "探索提的那条",
          "pending",
          "2026-08-29T00:00:00.000Z",
          [["baseline-exploration", null, 3, null]],
        ],
        [
          8,
          "fact",
          "反哺提的那条",
          "accepted",
          "2026-08-30T00:00:00.000Z",
          [["disposition-feedback", "这类越界在边界上判", null, null]],
        ],
        [
          9,
          "rule",
          "改现集里那条",
          "pending",
          "2026-08-30T00:00:00.000Z",
          [["baseline-exploration", null, null, null]],
        ],
      ],
    );
    // 单值的目标列迁移成一元的目标列表(issue #282),新增那两条是空列表。
    assert.deepEqual(
      store.getRuleProposals(90).map((row) => row.targetRuleIds),
      [[], [], [5]],
    );
  } finally {
    store.close();
  }

  // 迁移完的库再开一次不重复搬:判据看建表语句原文,搬过即不再命中。
  const again = openStore(db.path);
  try {
    assert.equal(proposalSourceRows(db.path), 3);
    assert.equal(again.getRuleProposals(90).length, 3);
    // 那三列已经不在表上,契约里也就没有它们;单值的目标列同样换成了目标列表。
    const columns = columnNames(db.path);
    assert.equal(columns.includes("source"), false);
    assert.equal(columns.includes("source_note"), false);
    assert.equal(columns.includes("trace_task_id"), false);
    assert.equal(columns.includes("target_rule_id"), false);
    assert.equal(columns.includes("target_rule_ids"), true);
  } finally {
    again.close();
  }
});

test("存量出处附注迁移:升级前落的附注行读回依据为 null,投影照常", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const first = openStore(db.path);
  try {
    first.registerRepo({ repoId: 91, owner: "acme", repo: "sources", generation: 1, key: "k" });
    assert.notEqual(first.addRuleProposal(91, proposal({ statement: "升级前排的那条" })), undefined);
  } finally {
    first.close();
  }
  // 升级前的形状:附注表没有依据那一列(issue #287)。去掉它,再开一次即走补列那一路。
  const raw = new DatabaseSync(db.path);
  try {
    raw.exec("ALTER TABLE rule_proposal_source DROP COLUMN evidence");
  } finally {
    raw.close();
  }

  const store = openStore(db.path);
  try {
    // 补列没跑成的话这一句就查不出 `evidence`,直接抛「no such column」。
    assert.deepEqual(
      store.getRuleProposals(91).map((row) => [row.statement, row.sources.map((e) => e.evidence)]),
      [["升级前排的那条", [null]]],
    );
  } finally {
    store.close();
  }
});
