/**
 * 知识集落库与面板可见(issue #202),直接废止一条条目(issue #203、#299)。
 *
 * 两条缝:SQLite 临时库验存量迁移、知识集版本推进与快照回溯,面板 API 走真实 HTTP 验
 * 读取、`knowledge:write` 拦截与仓库分配收窄。基点探索走 `panel-rule-exploration.test.ts`,
 * 这里的基点探索出处规则行由用例直接落进临时库;裁决那条写入链路是后续票的事。
 *
 * 直改那四个端点已经撤掉(issue #299,ADR 0028):人不再手写陈述、型与作用范围,写入口
 * 只剩修订意图(`panel-revision-intents.test.ts`)与这里的直接废止,四条旧路径回 404。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import { makeDbPath, testCleanups } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups = testCleanups();

const PASSWORD = "rules-test-password";

type RuleResponse = {
  id: number;
  /** 两型之一(ADR 0020,issue #221)。存量条目全部读成规则型。 */
  type: "rule" | "fact";
  scope: string;
  statement: string;
  origin: string;
};

type RuleSetResponse = {
  version: number | null;
  rules: RuleResponse[];
  retired: RuleResponse[];
  /**
   * 基点探索、知识草案与修订提案队列与知识集同一份读取(issue #205、#207)。这一组
   * 用例里都还是空的。
   */
  exploration: unknown;
  draft: unknown[];
  proposals: unknown[];
};

/** 直接落一行注册表:这几条用例要的是仓库存在,不是它的 hook。 */
/**
 * 落一条基点探索出处的评审规则。那条写入链路是后续票的范围,这里按 schema 直接写。
 * 顺带补上版本 1 那一行:有规则就说明这个仓库确认过知识集(issue #206 的门禁判据)。
 *
 * **INSERT 里没有 `type` 这一列**:升级前落的行就是这个样子,补列的 DEFAULT 因此就是
 * ADR 0020 的存量迁移本身——读出来的每一条都是规则型。
 *
 * **`layer` 写的是存量层标签的值**:层标签已经退役,新写的行一律空串,但库列还在、存量行
 * 也还带着当初填的那个标签。这里照旧写一个非空值,读出来的条目因此证明旧行照常读得出。
 */
function seedRule(
  dbPath: string,
  rule: {
    repoId: number;
    scope: string;
    statement: string;
    origin?: string;
    retiredVersion?: number;
  },
): void {
  const db = new DatabaseSync(dbPath);
  const retired = rule.retiredVersion ?? null;
  db.prepare(
    "INSERT OR IGNORE INTO rule_set_version (repo_id, version, created_at) VALUES (?, 1, ?)",
  ).run(rule.repoId, "2026-08-28T00:00:00.000Z");
  db.prepare(
    `INSERT INTO review_rule
       (repo_id, scope, statement, layer, state, origin, effective_version, retired_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    rule.repoId,
    rule.scope,
    rule.statement,
    "架构",
    retired === null ? "active" : "retired",
    rule.origin ?? "baseline-exploration",
    retired,
    "2026-08-28T00:00:00.000Z",
  );
  db.close();
}

/**
 * 落一条生效条目并回它的标识。写入口只剩裁决与草案确认(issue #299),用例要的现集条目
 * 因此直接落库。
 */
function seedActiveRule(
  h: PanelHarness,
  repoId: number,
  entry: { type: "rule" | "fact"; scope: string; statement: string },
): number {
  const store = openStore(h.db.path);
  try {
    assert.notEqual(store.addReviewRule(repoId, entry), undefined);
    return store.getRuleSet(repoId)!.rules.at(-1)!.id;
  } finally {
    store.close();
  }
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

/** 一个挂着 `knowledge:write` 角色、并分到这几个仓库的账号。 */
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
      permissions: ["knowledge:write"],
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

test("新注册的仓库知识集未确认,移除仓库连规则一起摘掉", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 88, owner: "acme", repo: "fresh", generation: 1, key: "k" }),
      true,
    );
    // 门禁分代(issue #206):注册不再落版本,知识确认才落第一版。
    assert.deepEqual(store.getRuleSet(88), { version: null, rules: [], retired: [] });
    // 没注册的仓库没有知识集可读。
    assert.equal(store.getRuleSet(999), undefined);

    store.removeRepo(88);
    assert.equal(store.getRuleSet(88), undefined);
  } finally {
    store.close();
  }
});

test("知识集只给当前生效的规则,废止的那条不在集内", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  assert.equal(
    store.registerRepo({ repoId: 90, owner: "acme", repo: "layered", generation: 1, key: "k" }),
    true,
  );
  store.close();

  seedRule(db.path, { repoId: 90, scope: "", statement: "公开函数要有类型标注" });
  seedRule(db.path, {
    repoId: 90,
    scope: "src/api/**",
    statement: "入参要在边界上校验",
  });
  seedRule(db.path, {
    repoId: 90,
    scope: "",
    statement: "已经不作数的老规则",
    retiredVersion: 2,
  });

  const reopened = openStore(db.path);
  try {
    const ruleSet = reopened.getRuleSet(90);
    assert.equal(ruleSet?.version, 1);
    assert.deepEqual(
      // 存量行带着退役的层标签值,条目照常读得出,读投影里不再有它。
      ruleSet?.rules.map((rule) => [rule.scope, rule.statement]),
      [
        ["", "公开函数要有类型标注"],
        ["src/api/**", "入参要在边界上校验"],
      ],
    );
  } finally {
    reopened.close();
  }
});

test("面板按仓库读知识集:分配内可读,未确认的仓库版本为 null", async () => {
  const h = await startReadyPanelHarness();
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const cookie = await scopedUser(h, "reader", [alpha]);

  const empty = await get(h, cookie, `/repos/${alpha}/rules`);
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()) as RuleSetResponse, {
    version: null,
    rules: [],
    retired: [],
    exploration: null,
    consolidation: null,
    draft: [],
    proposals: [],
    // 修订意图(issue #294)。没提过意图即空列表;它将用哪个模型由只读投影
    // `GET /repos/{id}/auxiliary-model` 单独回(issue #304)。
    intents: [],
  });

  seedRule(h.db.path, {
    repoId: alpha,
    scope: "src/api/**",
    statement: "入参要在边界上校验",
  });
  const filled = await get(h, cookie, `/repos/${alpha}/rules`);
  assert.equal(filled.status, 200);
  const body = (await filled.json()) as RuleSetResponse;
  assert.equal(body.version, 1);
  assert.deepEqual(
    body.rules.map(({ id, ...rule }) => rule),
    [
      {
        // 存量行没有这一列,补列的 DEFAULT 把它读成规则型(ADR 0020 的存量迁移)。
        type: "rule",
        scope: "src/api/**",
        statement: "入参要在边界上校验",
        origin: "baseline-exploration",
      },
    ],
  );
});

test("分配外的仓库与没注册的 id 读知识集同形 404", async () => {
  const h = await startReadyPanelHarness();
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
  const anonymous = await fetch(`${h.serverUrl}/api/repos/${alpha}/rules`);
  assert.equal(anonymous.status, 401);
});

test("直接废止推进一版,历史版本的快照仍取到废止前那一组", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 91, owner: "acme", repo: "edited", generation: 1, key: "k" }),
      true,
    );
    // 注册不落版本(issue #206),第一条条目落库就是这个仓库的第一版。
    assert.equal(
      store.addReviewRule(91, { type: "rule", scope: "", statement: "公开函数要有类型标注" }),
      1,
    );
    const added = store.getRuleSet(91)!;
    assert.equal(added.version, 1);
    const ruleId = added.rules[0]!.id;

    // 不在这个仓库生效规则里的标识废止不动,一版都不推进。
    assert.equal(store.retireReviewRule(91, 4242), undefined);

    assert.equal(store.retireReviewRule(91, ruleId), 2);
    const retired = store.getRuleSet(91)!;
    assert.equal(retired.version, 2);
    assert.deepEqual(retired.rules, []);
    // 废止的不再生效但可查。
    assert.deepEqual(retired.retired.map((rule) => rule.statement), ["公开函数要有类型标注"]);
    // 废止不了第二次。
    assert.equal(store.retireReviewRule(91, ruleId), undefined);
  } finally {
    store.close();
  }

  // 快照回溯:知识集版本 V 的那一组按 effective_version <= V 且未在 V 之前废止取。
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
  assert.deepEqual(snapshot(1), ["公开函数要有类型标注"]);
  assert.deepEqual(snapshot(2), []);
  raw.close();
});

test("面板直接废止一条条目:knowledge:write 放行,版本推进,废止的仍读得到", async () => {
  const h = await startReadyPanelHarness();
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const cookie = await ruleWriterCookie(h, "rule-writer", [alpha]);
  const ruleId = seedActiveRule(h, alpha, {
    type: "rule",
    scope: "src/api/**",
    statement: "入参要在边界上校验",
  });

  const retired = await send(h, cookie, "DELETE", `/repos/${alpha}/rules/${ruleId}`);
  assert.equal(retired.status, 200);
  assert.deepEqual(await retired.json(), { version: 2 });

  const afterRetire = (await (await get(h, cookie, `/repos/${alpha}/rules`)).json()) as
    RuleSetResponse;
  assert.equal(afterRetire.version, 2);
  assert.deepEqual(afterRetire.rules, []);
  assert.deepEqual(afterRetire.retired.map((rule) => rule.statement), ["入参要在边界上校验"]);

  // 已废止的那条废止不了第二次。
  assert.equal((await send(h, cookie, "DELETE", `/repos/${alpha}/rules/${ruleId}`)).status, 404);
});

test("直改那四个端点已经撤掉:手写条目与草案手填一律回 404", async () => {
  const h = await startReadyPanelHarness();
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const cookie = await ruleWriterCookie(h, "rule-writer", [alpha]);
  // 有 `knowledge:write` 也没有这四条路径了(issue #299,ADR 0028):人写的是修订意图,
  // 陈述、型与作用范围由 agent 产出。
  const body = { type: "rule", scope: "", statement: "入参要校验" };
  const gone: [string, string][] = [
    ["POST", `/repos/${alpha}/rules`],
    ["PUT", `/repos/${alpha}/rules/1`],
    ["POST", `/repos/${alpha}/rule-draft`],
    ["PUT", `/repos/${alpha}/rule-draft/1`],
  ];
  for (const [method, path] of gone) {
    const response = await send(h, cookie, method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(((await response.json()) as { error: string }).error, "没有这个端点");
  }
});

test("没有 knowledge:write 的人废止不动条目,分配外的仓库同形 404", async () => {
  const h = await startReadyPanelHarness();
  const alpha = seedRepo(h, 101, "acme", "alpha");
  const beta = seedRepo(h, 102, "acme", "beta");
  // 读得到知识集的人不等于改得动:这个账号有仓库分配,没有权限格。
  const readerCookie = await scopedUser(h, "rules-reader", [alpha]);
  assert.equal((await get(h, readerCookie, `/repos/${alpha}/rules`)).status, 200);
  assert.equal((await send(h, readerCookie, "DELETE", `/repos/${alpha}/rules/1`)).status, 403);

  // 有格但没分到那个仓库,与没注册同形 404。
  const writerCookie = await ruleWriterCookie(h, "rule-writer", [alpha]);
  const outside = await send(h, writerCookie, "DELETE", `/repos/${beta}/rules/1`);
  assert.equal(outside.status, 404);
  assert.equal(
    ((await outside.json()) as { error: string }).error,
    `没有 repo id 为 ${beta} 的注册仓库`,
  );
});

test("Review Run 的启动快照冻结知识集版本与当时那组规则,之后的变更不追上来", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 91, owner: "acme", repo: "frozen", generation: 1, key: "k" }),
      true,
    );
    assert.equal(
      store.addReviewRule(91, { type: "rule", scope: "src/**", statement: "src 下不写 any" }),
      1,
    );

    const snapshot = store.getReviewRunSnapshot(91);
    assert.equal(snapshot.ruleSetVersion, 1);
    assert.deepEqual(
      snapshot.rules.map((rule) => [rule.scope, rule.statement]),
      [["src/**", "src 下不写 any"]],
    );

    // 已开跑的那一轮拿着上面这份快照跑完,知识集在它跑的过程中变了也不跟。
    assert.equal(store.addReviewRule(91, { type: "rule", scope: "", statement: "新规则" }), 2);
    assert.equal(snapshot.ruleSetVersion, 1);
    assert.equal(snapshot.rules.length, 1);

    const next = store.getReviewRunSnapshot(91);
    assert.equal(next.ruleSetVersion, 2);
    assert.equal(next.rules.length, 2);
  } finally {
    store.close();
  }
});

test("启动快照按 type 把两型分开,同一个知识集版本一起冻结", () => {
  const db = makeDbPath();
  cleanups.push(db.cleanup);
  const store = openStore(db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId: 92, owner: "acme", repo: "typed", generation: 1, key: "k" }),
      true,
    );
    assert.equal(
      store.addReviewRule(92, {
        type: "rule",
        scope: "src/**",
        statement: "src 下不写 any",
      }),
      1,
    );
    assert.equal(
      store.addReviewRule(92, {
        type: "fact",
        scope: "",
        statement: "全局拦截器覆盖全部路由",
      }),
      2,
    );

    const snapshot = store.getReviewRunSnapshot(92);
    // 一个版本,两份注入:规则带标识(模型自报命中的凭据),事实同样带标识但不进 prompt。
    assert.equal(snapshot.ruleSetVersion, 2);
    assert.deepEqual(
      snapshot.rules.map((rule) => [rule.scope, rule.statement]),
      [["src/**", "src 下不写 any"]],
    );
    assert.deepEqual(
      snapshot.facts.map((fact) => [fact.scope, fact.statement]),
      [["", "全局拦截器覆盖全部路由"]],
    );

    // 纯规则集的事实那一份是空数组,行为与升级前逐字一致。
    assert.equal(store.retireReviewRule(92, snapshot.facts[0]!.id), 3);
    assert.deepEqual(store.getReviewRunSnapshot(92).facts, []);
  } finally {
    store.close();
  }
});
