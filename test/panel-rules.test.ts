/**
 * 规则集落库与面板可见(issue #202),规则的手工增删改(issue #203)。
 *
 * 两条缝:SQLite 临时库验存量迁移、规则集版本推进与快照回溯,面板 API 走真实 HTTP 验
 * 读取、`rule:write` 拦截与仓库分配收窄。基点探索走 `panel-rule-exploration.test.ts`,
 * 这里的基点探索出处规则行由用例直接落进临时库;裁决那条写入链路是后续票的事。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
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

const PASSWORD = "rules-test-password";

type RuleResponse = {
  id: number;
  scope: string;
  statement: string;
  layer: string;
  origin: string;
};

type RuleSetResponse = {
  version: number | null;
  rules: RuleResponse[];
  retired: RuleResponse[];
  /** 基点探索与规则草案与规则集同一份读取(issue #205)。这一组用例里都还是空的。 */
  exploration: unknown;
  draft: unknown[];
};

/** 直接落一行注册表:这几条用例要的是仓库存在,不是它的 hook。 */
function seedRepo(h: PanelHarness, repoId: number, owner: string, repo: string): number {
  const store = openStore(h.db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId, owner, repo, generation: 1, key: `key-${repoId}` }),
      true,
    );
  } finally {
    store.close();
  }
  return repoId;
}

/** 落一条基点探索出处的评审规则。那条写入链路是后续票的范围,这里按 schema 直接写。 */
function seedRule(
  dbPath: string,
  rule: {
    repoId: number;
    scope: string;
    statement: string;
    layer: string;
    origin?: string;
    retiredVersion?: number;
  },
): void {
  const db = new DatabaseSync(dbPath);
  const retired = rule.retiredVersion ?? null;
  db.prepare(
    `INSERT INTO review_rule
       (repo_id, scope, statement, layer, state, origin, effective_version, retired_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    rule.repoId,
    rule.scope,
    rule.statement,
    rule.layer,
    retired === null ? "active" : "retired",
    rule.origin ?? "baseline-exploration",
    retired,
    "2026-08-28T00:00:00.000Z",
  );
  db.close();
}

async function scopedUser(
  h: PanelHarness,
  username: string,
  repoIds: readonly number[],
): Promise<string> {
  const store = openStore(h.db.path);
  try {
    store.createPanelUser({
      username,
      displayName: null,
      passwordHash: await hashPassword(PASSWORD),
      mustChangePassword: false,
      createdAt: "2026-08-20T00:00:00.000Z",
      isSystemAdmin: false,
      roleId: null,
    });
    store.setPanelUserAssignment(username, repoIds);
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

/** 一个挂着 `rule:write` 角色、并分到这几个仓库的账号。 */
async function ruleWriterCookie(
  h: PanelHarness,
  username: string,
  repoIds: readonly number[],
): Promise<string> {
  const cookie = await scopedUser(h, username, repoIds);
  const store = openStore(h.db.path);
  try {
    const role = store.createPanelRole({
      name: `role-${username}`,
      permissions: ["rule:write"],
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    assert.equal(
      store.updatePanelUser(username, {
        displayName: null,
        roleId: role.id,
        isSystemAdmin: false,
      }),
      "updated",
    );
  } finally {
    store.close();
  }
  return cookie;
}

test("升级前注册的仓库开库后成为已确认空规则集", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);

  // 升级前的库:注册表里有行,规则集版本表还没有任何一行。
  const before = openStore(db.path);
  before.close();
  const raw = new DatabaseSync(db.path);
  raw.prepare("INSERT INTO repo (id, owner, repo, registered_at) VALUES (?, ?, ?, ?)").run(
    77,
    "acme",
    "legacy",
    "2026-01-01T00:00:00.000Z",
  );
  raw.prepare("DELETE FROM rule_set_version").run();
  raw.close();

  const after = openStore(db.path);
  try {
    assert.deepEqual(after.getRuleSet(77), { version: 1, rules: [], retired: [] });
    // 幂等:同一个库第二次打开不再叠版本。
    const again = openStore(db.path);
    assert.equal(again.getRuleSet(77)?.version, 1);
    again.close();
  } finally {
    after.close();
  }
});

test("注册仓库即得到已确认空规则集,移除仓库连规则一起摘掉", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 88, owner: "acme", repo: "fresh", generation: 1, key: "k" }),
      true,
    );
    assert.deepEqual(store.getRuleSet(88), { version: 1, rules: [], retired: [] });
    // 没注册的仓库没有规则集可读。
    assert.equal(store.getRuleSet(999), undefined);

    store.removeRepo(88);
    assert.equal(store.getRuleSet(88), undefined);
  } finally {
    store.close();
  }
});

test("规则集只给当前生效的规则,废止的那条不在集内", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  assert.equal(
    store.registerRepo({ repoId: 90, owner: "acme", repo: "layered", generation: 1, key: "k" }),
    true,
  );
  store.close();

  seedRule(db.path, { repoId: 90, scope: "", statement: "公开函数要有类型标注", layer: "架构" });
  seedRule(db.path, {
    repoId: 90,
    scope: "src/api/**",
    statement: "入参要在边界上校验",
    layer: "安全",
  });
  seedRule(db.path, {
    repoId: 90,
    scope: "",
    statement: "已经不作数的老规则",
    layer: "架构",
    retiredVersion: 2,
  });

  const reopened = openStore(db.path);
  try {
    const ruleSet = reopened.getRuleSet(90);
    assert.equal(ruleSet?.version, 1);
    assert.deepEqual(
      ruleSet?.rules.map((rule) => [rule.scope, rule.layer]),
      [["", "架构"], ["src/api/**", "安全"]],
    );
  } finally {
    reopened.close();
  }
});

test("面板按仓库读规则集:分配内可读,空规则集也给出当前版本", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const cookie = await scopedUser(h, "reader", [alpha]);

  const empty = await get(h, cookie, `/repos/${alpha}/rules`);
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()) as RuleSetResponse, {
    version: 1,
    rules: [],
    retired: [],
    exploration: null,
    draft: [],
  });

  seedRule(h.db.path, {
    repoId: alpha,
    scope: "src/api/**",
    statement: "入参要在边界上校验",
    layer: "安全",
  });
  const filled = await get(h, cookie, `/repos/${alpha}/rules`);
  assert.equal(filled.status, 200);
  const body = (await filled.json()) as RuleSetResponse;
  assert.equal(body.version, 1);
  assert.deepEqual(
    body.rules.map(({ id, ...rule }) => rule),
    [
      {
        scope: "src/api/**",
        statement: "入参要在边界上校验",
        layer: "安全",
        origin: "baseline-exploration",
      },
    ],
  );
});

test("分配外的仓库与没注册的 id 读规则集同形 404", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const beta = seedRepo(h, 102, "acme", "beta");
  const cookie = await scopedUser(h, "reader", [alpha]);

  const outside = await get(h, cookie, `/repos/${beta}/rules`);
  assert.equal(outside.status, 404);
  // 措辞与「没注册」逐字相同:仓库存在这件事不该从 404 里漏出去。
  assert.equal(
    ((await outside.json()) as { error: string }).error,
    `没有 repo id 为 ${beta} 的注册仓库`,
  );

  const missing = await get(h, cookie, `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { error: string }).error,
    `没有 repo id 为 ${GITEA_REPO.id} 的注册仓库`,
  );

  // 不登录读不到,也不能借 404 与 401 的差别探仓库。
  const anonymous = await fetch(`${h.serverUrl}/${PREFIX}/api/repos/${alpha}/rules`);
  assert.equal(anonymous.status, 401);
});

test("手工新增、修改与废止各推进一版,历史版本的快照仍取到旧内容", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 91, owner: "acme", repo: "edited", generation: 1, key: "k" }),
      true,
    );
    // 注册那一版是 1,三次手工变更各推进一版。
    assert.equal(
      store.addReviewRule(91, { scope: "", statement: "公开函数要有类型标注", layer: "架构" }),
      2,
    );
    const added = store.getRuleSet(91)!;
    assert.equal(added.version, 2);
    assert.deepEqual(added.rules.map((rule) => [rule.statement, rule.origin]), [
      ["公开函数要有类型标注", "manual"],
    ]);

    const ruleId = added.rules[0]!.id;
    assert.equal(
      store.updateReviewRule(91, ruleId, {
        scope: "src/**",
        statement: "导出的函数要有类型标注",
        layer: "架构",
      }),
      3,
    );
    const edited = store.getRuleSet(91)!;
    assert.equal(edited.version, 3);
    assert.deepEqual(edited.rules.map((rule) => [rule.scope, rule.statement, rule.origin]), [
      ["src/**", "导出的函数要有类型标注", "manual"],
    ]);

    // 没注册的仓库、不在这个仓库里的规则与已废止的规则都写不动。
    assert.equal(store.addReviewRule(999, { scope: "", statement: "x", layer: "y" }), undefined);
    assert.equal(
      store.updateReviewRule(91, 4242, { scope: "", statement: "x", layer: "y" }),
      undefined,
    );
    assert.equal(store.retireReviewRule(91, ruleId), undefined);

    assert.equal(store.retireReviewRule(91, edited.rules[0]!.id), 4);
    const retired = store.getRuleSet(91)!;
    assert.equal(retired.version, 4);
    assert.deepEqual(retired.rules, []);
    // 废止的不再生效但可查:改之前那一版与刚废止的那条都在。
    assert.deepEqual(retired.retired.map((rule) => rule.statement), [
      "公开函数要有类型标注",
      "导出的函数要有类型标注",
    ]);
  } finally {
    store.close();
  }

  // 快照回溯:规则集版本 V 的那一组按 effective_version <= V 且未在 V 之前废止取。
  const raw = new DatabaseSync(db.path);
  const snapshot = (version: number): string[] =>
    raw
      .prepare(
        `SELECT statement FROM review_rule
          WHERE repo_id = 91 AND effective_version <= ?
            AND (retired_version IS NULL OR retired_version > ?)
          ORDER BY id`,
      )
      .all(version, version)
      .map((row) => String(row["statement"]));
  assert.deepEqual(snapshot(1), []);
  assert.deepEqual(snapshot(2), ["公开函数要有类型标注"]);
  assert.deepEqual(snapshot(3), ["导出的函数要有类型标注"]);
  assert.deepEqual(snapshot(4), []);
  raw.close();
});

test("面板手工增删改规则:rule:write 放行,版本逐次推进,废止的仍读得到", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const cookie = await ruleWriterCookie(h, "rule-writer", [alpha]);

  const created = await send(h, cookie, "POST", `/repos/${alpha}/rules`, {
    scope: "src/api/**",
    statement: "入参要在边界上校验",
    layer: "安全",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { version: 2 });

  const afterCreate = (await (await get(h, cookie, `/repos/${alpha}/rules`)).json()) as
    RuleSetResponse;
  assert.equal(afterCreate.version, 2);
  assert.deepEqual(afterCreate.rules.map(({ id, ...rule }) => rule), [
    { scope: "src/api/**", statement: "入参要在边界上校验", layer: "安全", origin: "manual" },
  ]);
  const ruleId = afterCreate.rules[0]!.id;

  const updated = await send(h, cookie, "PUT", `/repos/${alpha}/rules/${ruleId}`, {
    scope: "",
    statement: "入参要在边界上校验并给出错误原因",
    layer: "安全",
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { version: 3 });

  const afterUpdate = (await (await get(h, cookie, `/repos/${alpha}/rules`)).json()) as
    RuleSetResponse;
  assert.deepEqual(afterUpdate.rules.map((rule) => rule.statement), [
    "入参要在边界上校验并给出错误原因",
  ]);
  const editedId = afterUpdate.rules[0]!.id;

  const retired = await send(h, cookie, "DELETE", `/repos/${alpha}/rules/${editedId}`);
  assert.equal(retired.status, 200);
  assert.deepEqual(await retired.json(), { version: 4 });

  const afterRetire = (await (await get(h, cookie, `/repos/${alpha}/rules`)).json()) as
    RuleSetResponse;
  assert.equal(afterRetire.version, 4);
  assert.deepEqual(afterRetire.rules, []);
  assert.deepEqual(afterRetire.retired.map((rule) => rule.statement), [
    "入参要在边界上校验",
    "入参要在边界上校验并给出错误原因",
  ]);

  // 已废止的那条改不动、也废止不了第二次。
  assert.equal(
    (await send(h, cookie, "DELETE", `/repos/${alpha}/rules/${editedId}`)).status,
    404,
  );
  assert.equal(
    (await send(h, cookie, "PUT", `/repos/${alpha}/rules/${editedId}`, {
      scope: "",
      statement: "再改一次",
      layer: "安全",
    })).status,
    404,
  );
});

test("规范陈述与层标签不能为空,坏 body 一律 400 且不推进版本", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const cookie = await ruleWriterCookie(h, "rule-writer", [alpha]);

  for (const payload of [
    {},
    { statement: "  ", layer: "安全" },
    { statement: "入参要校验", layer: "" },
    { statement: 42, layer: "安全" },
  ]) {
    const response = await send(h, cookie, "POST", `/repos/${alpha}/rules`, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
  const ruleSet = (await (await get(h, cookie, `/repos/${alpha}/rules`)).json()) as RuleSetResponse;
  assert.equal(ruleSet.version, 1);
  assert.deepEqual(ruleSet.rules, []);
});

test("没有 rule:write 的人写不动规则,分配外的仓库同形 404", async () => {
  const h = await startReadyPanelHarness(cleanups);
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const beta = seedRepo(h, 102, "acme", "beta");
  // 读得到规则集的人不等于改得动:这个账号有仓库分配,没有权限格。
  const readerCookie = await scopedUser(h, "rules-reader", [alpha]);
  assert.equal((await get(h, readerCookie, `/repos/${alpha}/rules`)).status, 200);
  const body = { scope: "", statement: "入参要校验", layer: "安全" };
  assert.equal((await send(h, readerCookie, "POST", `/repos/${alpha}/rules`, body)).status, 403);
  assert.equal((await send(h, readerCookie, "PUT", `/repos/${alpha}/rules/1`, body)).status, 403);
  assert.equal((await send(h, readerCookie, "DELETE", `/repos/${alpha}/rules/1`)).status, 403);

  // 有格但没分到那个仓库,与没注册同形 404。
  const writerCookie = await ruleWriterCookie(h, "rule-writer", [alpha]);
  const outside = await send(h, writerCookie, "POST", `/repos/${beta}/rules`, body);
  assert.equal(outside.status, 404);
  assert.equal(
    ((await outside.json()) as { error: string }).error,
    `没有 repo id 为 ${beta} 的注册仓库`,
  );
});

test("Review Run 的启动快照冻结规则集版本与当时那组规则,之后的变更不追上来", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 91, owner: "acme", repo: "frozen", generation: 1, key: "k" }),
      true,
    );
    assert.equal(
      store.addReviewRule(91, { scope: "src/**", statement: "src 下不写 any", layer: "工程" }),
      2,
    );

    const snapshot = store.getReviewRunSnapshot(91);
    assert.equal(snapshot.ruleSetVersion, 2);
    assert.deepEqual(
      snapshot.rules.map((rule) => [rule.scope, rule.statement]),
      [["src/**", "src 下不写 any"]],
    );

    // 已开跑的那一轮拿着上面这份快照跑完,规则集在它跑的过程中变了也不跟。
    assert.equal(store.addReviewRule(91, { scope: "", statement: "新规则", layer: "工程" }), 3);
    assert.equal(snapshot.ruleSetVersion, 2);
    assert.equal(snapshot.rules.length, 1);

    const next = store.getReviewRunSnapshot(91);
    assert.equal(next.ruleSetVersion, 3);
    assert.equal(next.rules.length, 2);
  } finally {
    store.close();
  }
});
