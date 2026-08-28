/**
 * 基点探索与规则确认(issue #205)。
 *
 * 两条缝:SQLite 临时库验探索状态机、草案覆盖与规则确认推进版本,面板 API 走真实 HTTP
 * 验发起、状态可见、草案逐条增删改、整组确认与 `rule:write` 拦截。规则 agent 用脚本化
 * 实现注入,对齐脚本化 Reviewer 先例;真模型链路由 smoke 覆盖。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { PanelPermission } from "../src/panel/permissions.ts";
import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem } from "../src/reviewer/rule-agent.ts";
import { makeDbPath } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  PANEL_PREFIX as PREFIX,
  startReadyPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "exploration-test-password";
const AT = "2026-08-28T00:00:00.000Z";

type ExplorationResponse = {
  state: "running" | "failed" | "completed";
  baselineSha: string;
  model: string;
  failure: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type DraftItemResponse = {
  id: number;
  scope: string;
  statement: string;
  layer: string;
  origin: string;
};

type RuleSetResponse = {
  version: number | null;
  rules: { id: number; scope: string; statement: string; layer: string; origin: string }[];
  retired: { id: number; statement: string }[];
  exploration: ExplorationResponse | null;
  draft: DraftItemResponse[];
};

function item(statement: string, layer = "架构", scope = ""): RuleAgentItem {
  return { scope, statement, layer };
}

/** 固定产出的规则 agent。脚本化实现,与脚本化 Reviewer 同一个位置上的注入。 */
function scriptedRuleAgent(
  result: { items: RuleAgentItem[]; failure?: string },
): RuleAgent & { calls: { worktreePath: string; baselineSha: string; model: string }[] } {
  const calls: { worktreePath: string; baselineSha: string; model: string }[] = [];
  const agent = async (request: Parameters<RuleAgent>[0]) => {
    calls.push({
      worktreePath: request.worktreePath,
      baselineSha: request.baselineSha,
      model: `${request.runtimeModel.provider}:${request.runtimeModel.id}`,
    });
    return result;
  };
  return Object.assign(agent, { calls });
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

/** 注册 harness 那个真仓库并等后台工作副本准备完,探索要在同一份副本上 checkout 基点。 */
async function registeredHarness(
  options: PanelHarnessOptions = {},
): Promise<{ h: PanelHarness; cookie: string }> {
  const h = await startReadyPanelHarness(cleanups, options);
  const registered = await h.api("POST", "/repos", {
    owner: GITEA_REPO.owner,
    repo: GITEA_REPO.repo,
  });
  assert.equal(registered.status, 201);
  await h.worktreesPreparedAtLeast(1);
  const cookie = await scopedUser(h, "rule-writer", [GITEA_REPO.id], ["rule:write"]);
  return { h, cookie };
}

async function ruleSet(h: PanelHarness, cookie: string): Promise<RuleSetResponse> {
  const response = await get(h, cookie, `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(response.status, 200);
  return (await response.json()) as RuleSetResponse;
}

test("探索状态机:运行中不重入,失败留原因可重试,完成落草案", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 70, owner: "acme", repo: "explored", generation: 1, key: "k" }),
      true,
    );
    assert.equal(store.getRuleExploration(70), null);

    assert.equal(
      store.startRuleExploration(70, { baselineSha: "abc1234", model: "test:m", startedAt: AT }),
      true,
    );
    assert.equal(store.getRuleExploration(70)?.state, "running");
    // 同仓库同时只跑一个。
    assert.equal(
      store.startRuleExploration(70, { baselineSha: "def5678", model: "test:m", startedAt: AT }),
      false,
    );

    store.failRuleExploration(70, "取不回代码", AT);
    const failed = store.getRuleExploration(70);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.failure, "取不回代码");

    // 失败之后可重试:同一个仓库再发起一次,原因清掉。
    assert.equal(
      store.startRuleExploration(70, { baselineSha: "def5678", model: "test:m2", startedAt: AT }),
      true,
    );
    assert.equal(store.getRuleExploration(70)?.failure, null);
    assert.equal(store.getRuleExploration(70)?.model, "test:m2");

    store.finishRuleExploration(70, [item("公开函数要有类型标注")], AT);
    assert.equal(store.getRuleExploration(70)?.state, "completed");
    assert.deepEqual(
      store.getRuleDraft(70).map((row) => [row.statement, row.origin]),
      [["公开函数要有类型标注", "baseline-exploration"]],
    );
    // 没注册的仓库发起不了。
    assert.equal(
      store.startRuleExploration(999, { baselineSha: "abc1234", model: "t:m", startedAt: AT }),
      false,
    );
  } finally {
    store.close();
  }
});

test("重探索覆盖未确认的旧草案,人手工加的那条一并被覆盖", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 71, owner: "acme", repo: "redone", generation: 1, key: "k" });
    store.startRuleExploration(71, { baselineSha: "abc1234", model: "test:m", startedAt: AT });
    store.finishRuleExploration(71, [item("第一次探索的规则")], AT);
    assert.notEqual(store.addRuleDraftItem(71, item("人手写的一条")), undefined);
    assert.equal(store.getRuleDraft(71).length, 2);

    store.startRuleExploration(71, { baselineSha: "def5678", model: "test:m", startedAt: AT });
    // 发起时草案还在:探索没跑出结果之前不该先把人手上那份删掉。
    assert.equal(store.getRuleDraft(71).length, 2);
    store.finishRuleExploration(71, [item("第二次探索的规则")], AT);
    assert.deepEqual(
      store.getRuleDraft(71).map((row) => row.statement),
      ["第二次探索的规则"],
    );
  } finally {
    store.close();
  }
});

test("规则确认整组生效:草案成为生效规则、推进一版、草案清空", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 72, owner: "acme", repo: "confirmed", generation: 1, key: "k" });
    // 没有草案时确认不动任何东西。
    assert.equal(store.confirmRuleDraft(72), undefined);

    store.startRuleExploration(72, { baselineSha: "abc1234", model: "test:m", startedAt: AT });
    store.finishRuleExploration(72, [item("公开函数要有类型标注", "架构", "src/**")], AT);
    const manual = store.addRuleDraftItem(72, item("入参要在边界上校验", "安全"))!;
    assert.equal(store.updateRuleDraftItem(72, manual, item("入参要在边界上校验并给原因", "安全")), true);

    // 规则确认产生这个仓库的第一个规则集版本(issue #206:注册不再落版本)。
    assert.equal(store.confirmRuleDraft(72), 1);
    const confirmed = store.getRuleSet(72)!;
    assert.equal(confirmed.version, 1);
    assert.deepEqual(
      confirmed.rules.map((rule) => [rule.scope, rule.statement, rule.layer, rule.origin]),
      [
        ["src/**", "公开函数要有类型标注", "架构", "baseline-exploration"],
        ["", "入参要在边界上校验并给原因", "安全", "manual"],
      ],
    );
    assert.deepEqual(store.getRuleDraft(72), []);
    // 确认之后不留第二份可确认的草案。
    assert.equal(store.confirmRuleDraft(72), undefined);
    // 探索记录本身留着:后续反哺要沿用这个仓库最近一次探索所用的模型。
    assert.equal(store.getRuleExploration(72)?.model, "test:m");
  } finally {
    store.close();
  }
});

test("草案条目逐条删除,移除仓库把探索与草案一并摘掉", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 73, owner: "acme", repo: "pruned", generation: 1, key: "k" });
    store.startRuleExploration(73, { baselineSha: "abc1234", model: "test:m", startedAt: AT });
    store.finishRuleExploration(73, [item("留下的"), item("要删的")], AT);
    const draft = store.getRuleDraft(73);
    assert.equal(store.deleteRuleDraftItem(73, draft[1]!.id), true);
    assert.equal(store.deleteRuleDraftItem(73, draft[1]!.id), false);
    assert.deepEqual(store.getRuleDraft(73).map((row) => row.statement), ["留下的"]);

    store.removeRepo(73);
    assert.equal(store.getRuleExploration(73), null);
    assert.deepEqual(store.getRuleDraft(73), []);
  } finally {
    store.close();
  }
});

test("重启时把停在运行中的探索改判失败,面板因此给得出重试入口", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    store.registerRepo({ repoId: 74, owner: "acme", repo: "restarted", generation: 1, key: "k" });
    store.startRuleExploration(74, { baselineSha: "abc1234", model: "test:m", startedAt: AT });
    store.failInterruptedRuleExplorations("服务重启,上一次探索没跑完", AT);
    const row = store.getRuleExploration(74);
    assert.equal(row?.state, "failed");
    assert.equal(row?.failure, "服务重启,上一次探索没跑完");
  } finally {
    store.close();
  }
});

test("面板发起基点探索:产出落草案、按重要性截断为 30 条", async () => {
  const many = Array.from({ length: 42 }, (_, index) => item(`第 ${index + 1} 条规范陈述`));
  const agent = scriptedRuleAgent({ items: many });
  const { h, cookie } = await registeredHarness({ ruleAgent: agent });

  const started = await send(h, cookie, "POST", `/repos/${GITEA_REPO.id}/rule-exploration`, {
    baseline: h.repo.baseSha,
    provider: "test",
    model: "global-model",
  });
  assert.equal(started.status, 202);
  await h.explorationsAtLeast(1);

  const body = await ruleSet(h, cookie);
  assert.equal(body.exploration?.state, "completed");
  assert.equal(body.exploration?.baselineSha, h.repo.baseSha);
  assert.equal(body.exploration?.model, "test:global-model");
  assert.equal(body.draft.length, 30);
  assert.equal(body.draft[0]!.statement, "第 1 条规范陈述");
  assert.equal(body.draft[29]!.statement, "第 30 条规范陈述");
  assert.equal(body.draft[0]!.origin, "baseline-exploration");
  // 规则集本身还没动:草案要人确认才生效,确认之前这个仓库都是「规则集未确认」。
  assert.equal(body.version, null);
  assert.deepEqual(body.rules, []);

  // agent 拿到的是基点上的工作副本与选定的模型。
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.baselineSha, h.repo.baseSha);
  assert.equal(agent.calls[0]!.model, "test:global-model");
});

test("面板逐条增删改草案后整组确认,生成第一个规则集版本", async () => {
  const agent = scriptedRuleAgent({ items: [item("探索出来的一条", "架构", "src/**")] });
  const { h, cookie } = await registeredHarness({ ruleAgent: agent });
  const path = `/repos/${GITEA_REPO.id}`;

  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-exploration`, {
      baseline: h.repo.baseSha,
      provider: "test",
      model: "global-model",
    })).status,
    202,
  );
  await h.explorationsAtLeast(1);

  const added = await send(h, cookie, "POST", `${path}/rule-draft`, {
    scope: "",
    statement: "人手写的一条",
    layer: "安全",
  });
  assert.equal(added.status, 201);
  const addedId = ((await added.json()) as { id: number }).id;

  const explored = (await ruleSet(h, cookie)).draft[0]!;
  assert.equal(
    (await send(h, cookie, "PUT", `${path}/rule-draft/${explored.id}`, {
      scope: "src/**",
      statement: "改过的那一条",
      layer: "架构",
    })).status,
    200,
  );
  assert.equal((await send(h, cookie, "DELETE", `${path}/rule-draft/${addedId}`)).status, 200);
  // 删掉的那条不再回来,坏 body 一律 400。
  assert.equal((await send(h, cookie, "DELETE", `${path}/rule-draft/${addedId}`)).status, 404);
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rule-draft`, { statement: " ", layer: "安全" })).status,
    400,
  );

  const kept = await send(h, cookie, "POST", `${path}/rule-draft`, {
    scope: "",
    statement: "保留下来的手写规则",
    layer: "安全",
  });
  assert.equal(kept.status, 201);

  const confirmed = await send(h, cookie, "POST", `${path}/rule-draft/confirm`);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { version: 1 });

  const after = await ruleSet(h, cookie);
  assert.equal(after.version, 1);
  assert.deepEqual(
    after.rules.map((rule) => [rule.scope, rule.statement, rule.layer, rule.origin]),
    [
      ["src/**", "改过的那一条", "架构", "baseline-exploration"],
      ["", "保留下来的手写规则", "安全", "manual"],
    ],
  );
  assert.deepEqual(after.draft, []);
  // 草案已经清空,再确认一次没有东西可确认。
  assert.equal((await send(h, cookie, "POST", `${path}/rule-draft/confirm`)).status, 409);
});

test("探索失败原因可见并可重试,运行中不接第二次发起", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempt = 0;
  const agent: RuleAgent = async () => {
    attempt += 1;
    if (attempt === 1) return { items: [], failure: "模型没有回结果" };
    await gate;
    return { items: [item("重试之后的一条")] };
  };
  const { h, cookie } = await registeredHarness({ ruleAgent: agent });
  const path = `/repos/${GITEA_REPO.id}`;
  const launch = (): Promise<Response> =>
    send(h, cookie, "POST", `${path}/rule-exploration`, {
      baseline: h.repo.baseSha,
      provider: "test",
      model: "global-model",
    });

  assert.equal((await launch()).status, 202);
  await h.explorationsAtLeast(1);
  const failed = await ruleSet(h, cookie);
  assert.equal(failed.exploration?.state, "failed");
  assert.equal(failed.exploration?.failure, "模型没有回结果");
  assert.deepEqual(failed.draft, []);

  // 重试:第二次卡在 gate 上,这期间第三次发起被挡下。
  assert.equal((await launch()).status, 202);
  const busy = await launch();
  assert.equal(busy.status, 409);
  release!();
  await h.explorationsAtLeast(2);
  const done = await ruleSet(h, cookie);
  assert.equal(done.exploration?.state, "completed");
  assert.deepEqual(done.draft.map((row) => row.statement), ["重试之后的一条"]);
});

test("规则集非空时不再走草案:产出排进修订提案队列(issue #207 的分界)", async () => {
  const agent = scriptedRuleAgent({ items: [item("探索提的一条")] });
  const { h, cookie } = await registeredHarness({ ruleAgent: agent });
  const path = `/repos/${GITEA_REPO.id}`;
  assert.equal(
    (await send(h, cookie, "POST", `${path}/rules`, {
      scope: "",
      statement: "已经生效的规则",
      layer: "安全",
    })).status,
    201,
  );

  const started = await send(h, cookie, "POST", `${path}/rule-exploration`, {
    baseline: h.repo.baseSha,
    provider: "test",
    model: "global-model",
  });
  assert.equal(started.status, 202);
  await h.explorationsAtLeast(1);
  assert.equal(agent.calls.length, 1);
  // 草案一行不动:裁决与队列的形态由 `panel-rule-proposals.test.ts` 验。
  assert.deepEqual((await ruleSet(h, cookie)).draft, []);
});

test("没有 rule:write 的人发起不了探索也确认不了,分配外的仓库同形 404", async () => {
  const agent = scriptedRuleAgent({ items: [] });
  const { h } = await registeredHarness({ ruleAgent: agent });
  const path = `/repos/${GITEA_REPO.id}`;
  const launch = { baseline: h.repo.baseSha, provider: "test", model: "global-model" };

  const reader = await scopedUser(h, "rules-reader", [GITEA_REPO.id]);
  // 读得到规则集与草案的人不等于发起得了探索。
  assert.equal((await get(h, reader, `${path}/rules`)).status, 200);
  assert.equal((await send(h, reader, "POST", `${path}/rule-exploration`, launch)).status, 403);
  assert.equal((await send(h, reader, "POST", `${path}/rule-draft`, {})).status, 403);
  assert.equal((await send(h, reader, "POST", `${path}/rule-draft/confirm`)).status, 403);

  const outsider = await scopedUser(h, "other-writer", [], ["rule:write"]);
  const outside = await send(h, outsider, "POST", `${path}/rule-exploration`, launch);
  assert.equal(outside.status, 404);
  assert.equal(agent.calls.length, 0);
});

test("发起要一个可用模型与一个 commit sha,坏入参一律 400", async () => {
  const agent = scriptedRuleAgent({ items: [] });
  const { h, cookie } = await registeredHarness({ ruleAgent: agent });
  const path = `/repos/${GITEA_REPO.id}/rule-exploration`;

  for (const payload of [
    {},
    { baseline: "not-a-sha", provider: "test", model: "global-model" },
    { baseline: h.repo.baseSha, provider: "test" },
    { baseline: h.repo.baseSha, provider: "nope", model: "missing-model" },
  ]) {
    const response = await send(h, cookie, "POST", path, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
  assert.equal(agent.calls.length, 0);

  // 可用模型清单与全局模型组合读的是同一份可用性判据。
  const models = await get(h, cookie, "/rule-models");
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()) as { models: unknown[] }, {
    models: [{ identity: "test:global-model", provider: "test", model: "global-model" }],
  });
});
