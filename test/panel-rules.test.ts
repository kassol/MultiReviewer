/**
 * 规则集落库与面板可见(issue #202)。
 *
 * 两条缝:SQLite 临时库验存量迁移与规则集版本快照,面板 API 走真实 HTTP 验读取与
 * 仓库分配收窄。这一票只有读,规则的写入(规则确认、裁决)是后续票的事,用例因此
 * 直接把规则行落进临时库。
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

type RuleSetResponse = {
  version: number | null;
  rules: {
    id: number;
    scope: string;
    statement: string;
    layer: string;
    origin: string;
  }[];
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

/** 落一条评审规则。写侧接口是后续票的范围,这里按 schema 直接写。 */
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
    assert.deepEqual(after.getRuleSet(77), { version: 1, rules: [] });
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
    assert.deepEqual(store.getRuleSet(88), { version: 1, rules: [] });
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
  assert.deepEqual((await empty.json()) as RuleSetResponse, { version: 1, rules: [] });

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
