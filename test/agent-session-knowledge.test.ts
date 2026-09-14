/**
 * 知识查询工具 `query_knowledge` 与提示里那份知识目录(issue #344)。
 *
 * 两段各打一条缝:
 *
 * 一、子进程那条真实链路(`POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 → 工具调用
 *    → IPC 查库 → 工具结果`,先例 `agent-session-findings.test.ts`):会话根里一个仓库,验
 *    提示只报条数、查询真的按仓库集合交集取产品条目、路径 glob 真的收窄仓库条目、会话根外
 *    的仓库问不到。
 * 二、主进程那一侧的查询函数(`sessionKnowledge`):两个仓库与封顶要的仓库数超出假 Gitea
 *    能服务的一个,那几条因此打在这个函数上——同一份判定,只是不经子进程。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { scopesOverlap } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { FINDING_QUERY_LIMIT } from "../src/reviewer/session-finding-tool.ts";
import { disposeAgentSessions, sessionKnowledge } from "../src/webhook/agent-session.ts";
import { makeDbPath, testCleanups } from "./support/git-fixture.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { seedReviewRule } from "./support/store-seed.ts";
import { startModelStub, type StubTurn } from "./support/model-stub.ts";

const PASSWORD = "agent-session-knowledge-password";
const AT = "2026-09-13T00:00:00.000Z";
const REPO = `${GITEA_REPO.owner}/${GITEA_REPO.repo}`;

/** 发给 agent 的那句话。 */
const MESSAGE = "订单金额的折算要改,先看看这块有什么约定";

/** 会话根里那个仓库的三条知识,作用范围各不相同。 */
const FINANCE_RULE = "折算金额一律按分存";
const WHOLE_REPO_FACT = "这个仓库的持久化只用 node:sqlite";
const WEB_RULE = "页面上的金额都过同一个格式化函数";

/** 另一个仓库的一条。会话根里没有它,它一条都不该回来。 */
const OTHER_REPO_RULE = "前端不直接拼 SQL";

/** 产品层两条:一条牵着会话根里那个仓库,一条不牵。 */
const PRODUCT_ROUTING = "订单服务经 /rates 取汇率,汇率表只在 acme/widgets 里改";
const PRODUCT_ELSEWHERE = "运营后台的报表直接读数仓,不过订单服务";

type Record = {
  seq: number;
  type: string;
  entry: { type: string; message?: { role: string; content: unknown } };
};

type Args = globalThis.Record<string, unknown>;

/** 一次查询的脚本响应。 */
function query(args: Args): StubTurn {
  return { toolCall: { name: "query_knowledge", args }, usage: { input: 10, output: 2 } };
}

/**
 * 往注册表里落一个仓库并归入这个产品。只为给产品知识的仓库集合凑出成员:会话根只挂创建者
 * 分配到的那些(spec #329),这几个因此不会被 clone。
 */
function attachRepo(
  dbPath: string,
  productId: number,
  repo: { id: number; owner: string; repo: string },
): number {
  const store = openStore(dbPath);
  try {
    assert.equal(
      store.registerRepo({
        repoId: repo.id,
        owner: repo.owner,
        repo: repo.repo,
        generation: 1,
        key: `key-${repo.id}`,
      }),
      true,
    );
    assert.equal(store.attachProductRepo(productId, repo.id, AT), "attached");
    return repo.id;
  } finally {
    store.close();
  }
}

/** 落一条生效的产品知识。 */
function seedProductKnowledge(
  dbPath: string,
  productId: number,
  statement: string,
  repoIds: readonly number[],
): void {
  const store = openStore(dbPath);
  try {
    store.addProductKnowledge({
      productId,
      statement,
      repoIds,
      state: "active",
      proposedBy: "member",
      at: AT,
    });
  } finally {
    store.close();
  }
}

/**
 * 起一套指向假模型服务的 harness,建好产品与一个开放对话会话,回会话 id 与创建者的 cookie。
 * 与 `agent-session-findings.test.ts` 那一份同形。
 */
async function startSessionHarness(turns: readonly StubTurn[]): Promise<{
  h: PanelHarness;
  cookie: string;
  sessionId: number;
  productId: number;
  requests: Awaited<ReturnType<typeof startModelStub>>["requests"];
  close: () => Promise<void>;
}> {
  const stub = await startModelStub(turns);
  const h = await startPanelHarness();
  seedAvailableModelService(h, HARNESS_SPEC.provider, [HARNESS_SPEC.model], {}, stub.baseUrl);
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  const created = await h.api("POST", "/products", { name: "订单系统" });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const response = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "open-conversation" }),
  });
  assert.equal(response.status, 201);
  const { session } = (await response.json()) as { session: { id: number } };
  return {
    h,
    cookie,
    sessionId: session.id,
    productId: product.id,
    requests: stub.requests,
    close: stub.close,
  };
}

function send(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  clientMessageId: string,
  text: string,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId, text }),
  });
}

/** 等到这个会话回到空闲(一个回合跑完)。 */
async function idle(h: PanelHarness, cookie: string, sessionId: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      headers: { cookie },
    });
    const { session } = (await response.json()) as { session: { status: string } };
    if (session.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 60 秒,会话 ${sessionId} 还在执行`);
}

/** 这个会话记录表里每一次工具结果的正文,按时间顺序。 */
async function toolResults(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<string[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/records`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const { records } = (await response.json()) as { records: Record[] };
  return records
    .filter((row) => row.entry.message?.role === "toolResult")
    .map((row) => JSON.stringify(row.entry.message?.content));
}

test("知识查询按仓库集合交集取产品条目,路径 glob 只收窄仓库条目,会话根外的仓库问不到", async () => {
  const turns: StubTurn[] = [
    query({ repos: [REPO] }),
    query({ repos: [REPO], pathGlob: "src/finance/**" }),
    query({ repos: ["acme/elsewhere"] }),
    { text: "看完了,按这些约定改", usage: { input: 10, output: 2 } },
  ];
  const { h, cookie, sessionId, productId, requests, close } = await startSessionHarness(turns);
  try {
    seedReviewRule(h.db.path, GITEA_REPO.id, {
      type: "rule",
      scope: "src/finance/**",
      statement: FINANCE_RULE,
    });
    seedReviewRule(h.db.path, GITEA_REPO.id, {
      type: "fact",
      scope: "",
      statement: WHOLE_REPO_FACT,
    });
    seedReviewRule(h.db.path, GITEA_REPO.id, {
      type: "rule",
      scope: "web/**",
      statement: WEB_RULE,
    });
    // 产品里另两个仓库:会话根挂不到它们(创建者只分配了一个),但产品知识的仓库集合要用。
    const orders = attachRepo(h.db.path, productId, { id: 5001, owner: "acme", repo: "orders" });
    const console_ = attachRepo(h.db.path, productId, { id: 5002, owner: "acme", repo: "console" });
    seedReviewRule(h.db.path, orders, { type: "rule", scope: "", statement: OTHER_REPO_RULE });
    seedProductKnowledge(h.db.path, productId, PRODUCT_ROUTING, [GITEA_REPO.id, orders]);
    seedProductKnowledge(h.db.path, productId, PRODUCT_ELSEWHERE, [orders, console_]);

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    // 提示里只有条数与那一句触发语,一条陈述都没有。
    const system = requests[0]!.messages.find((message) => message.role === "system")!.content;
    assert.match(system, /This product has 2 active product knowledge entries\./);
    assert.match(system, /^- acme\/widgets — 2 review rules, 1 project fact$/m);
    assert.match(
      system,
      /^When the task spans repositories or its scope is unclear, query the product layer first; otherwise query the repository and the paths the task touches\.$/m,
    );
    for (const statement of [FINANCE_RULE, WHOLE_REPO_FACT, WEB_RULE, PRODUCT_ROUTING]) {
      assert.doesNotMatch(system, new RegExp(statement), `提示里不该有陈述:${statement}`);
    }

    const results = await toolResults(h, cookie, sessionId);
    assert.equal(results.length, 3, `工具结果条数不对:${results.join("\n")}`);

    // 只问这一个仓库:牵着它的那条产品知识回来,并带上它涉及的全部仓库;不牵它的那条不回。
    assert.match(results[0]!, /1 product knowledge entry involving acme\/widgets\./);
    assert.match(results[0]!, /product knowledge \(acme\/widgets, acme\/orders\)/);
    assert.match(results[0]!, new RegExp(PRODUCT_ROUTING));
    assert.equal(results[0]!.includes(PRODUCT_ELSEWHERE), false);
    // 这个仓库的三条都回来,层、所属仓库与作用范围都在行上。
    assert.match(results[0]!, /3 review rules and project facts of acme\/widgets\./);
    assert.match(results[0]!, new RegExp(`review rule of acme/widgets \\(src/finance/\\*\\*\\)`));
    assert.match(results[0]!, /project fact of acme\/widgets \(whole repository\)/);
    assert.match(results[0]!, new RegExp(WEB_RULE));
    // 别的仓库的一条都没有。
    assert.equal(results[0]!.includes(OTHER_REPO_RULE), false);
    assert.equal(results[0]!.includes("acme/console"), false);

    // 路径 glob:仓库条目收窄到作用范围与它重叠的那两条,产品条目一条不少。
    assert.match(results[1]!, /2 review rules and project facts of acme\/widgets\./);
    assert.match(results[1]!, new RegExp(FINANCE_RULE));
    assert.match(results[1]!, new RegExp(WHOLE_REPO_FACT));
    assert.equal(results[1]!.includes(WEB_RULE), false);
    assert.match(results[1]!, /1 product knowledge entry involving acme\/widgets\./);
    assert.match(results[1]!, new RegExp(PRODUCT_ROUTING));

    // 会话根外的仓库走正常返回一句打回理由,一条知识都不带。
    assert.match(
      results[2]!,
      /acme\/elsewhere is not a repository of this session; look in one of: acme\/widgets/,
    );
    assert.equal(results[2]!.includes(FINANCE_RULE), false);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/* ─────────────── 主进程那一侧的查询函数 ─────────────── */

const cleanups = testCleanups();

/** 四个仓库、一个产品的一套库。回产品 id 与四个 repo id。 */
function storeWithProduct(): { dbPath: string; productId: number; repoIds: number[] } {
  const db = makeDbPath();
  cleanups.push(() => db.cleanup());
  const store = openStore(db.path);
  let productId = 0;
  const repoIds: number[] = [];
  try {
    productId = store.createProduct({ name: "订单系统", createdAt: AT }).id;
    for (const [index, name] of ["widgets", "orders", "console", "docs"].entries()) {
      const repoId = 6000 + index;
      assert.equal(
        store.registerRepo({
          repoId,
          owner: "acme",
          repo: name,
          generation: 1,
          key: `key-${repoId}`,
        }),
        true,
      );
      assert.equal(store.attachProductRepo(productId, repoId, AT), "attached");
      repoIds.push(repoId);
    }
  } finally {
    store.close();
  }
  return { dbPath: db.path, productId, repoIds };
}

/** 这个产品的仓库归属行,`sessionKnowledge` 按它把名字换成 id。 */
function productRepos(dbPath: string, productId: number) {
  const store = openStore(dbPath);
  try {
    return store.getProduct(productId)!.repos;
  } finally {
    store.close();
  }
}

test("问两个仓库:两边的产品条目都回,两边的规则与事实都回,glob 不碰产品条目", () => {
  const { dbPath, productId, repoIds } = storeWithProduct();
  const [widgets, orders, console_, docs] = repoIds as [number, number, number, number];
  seedProductKnowledge(dbPath, productId, PRODUCT_ROUTING, [widgets, orders]);
  seedProductKnowledge(dbPath, productId, PRODUCT_ELSEWHERE, [orders, console_]);
  // 两个问到的仓库都不牵的那一条。
  seedProductKnowledge(dbPath, productId, "文档站的截图从 console 的演示库来", [console_, docs]);
  seedReviewRule(dbPath, widgets, {
    type: "rule",
    scope: "src/finance/**",
    statement: FINANCE_RULE,
  });
  seedReviewRule(dbPath, orders, { type: "rule", scope: "", statement: OTHER_REPO_RULE });
  const repos = productRepos(dbPath, productId);

  const both = sessionKnowledge(dbPath, productId, repos, {
    repos: ["acme/widgets", "acme/orders"],
  });
  assert.deepEqual(
    both.product.map((entry) => entry.statement),
    [PRODUCT_ELSEWHERE, PRODUCT_ROUTING],
  );
  assert.deepEqual(
    both.repo.map((entry) => `${entry.repo}:${entry.type}:${entry.statement}`),
    [`acme/widgets:rule:${FINANCE_RULE}`, `acme/orders:rule:${OTHER_REPO_RULE}`],
  );

  // 一个仓库:只有牵着它的那一条产品条目,只有它自己的规则。
  const one = sessionKnowledge(dbPath, productId, repos, { repos: ["acme/widgets"] });
  assert.deepEqual(
    one.product.map((entry) => entry.statement),
    [PRODUCT_ROUTING],
  );
  assert.deepEqual(one.product[0]!.repos, ["acme/widgets", "acme/orders"]);
  assert.deepEqual(
    one.repo.map((entry) => entry.statement),
    [FINANCE_RULE],
  );

  // 路径 glob:重叠不上的仓库条目被收掉,产品条目一条不少。
  const narrowed = sessionKnowledge(dbPath, productId, repos, {
    repos: ["acme/widgets", "acme/orders"],
    pathGlob: "src/finance/rate.ts",
  });
  assert.deepEqual(
    narrowed.product.map((entry) => entry.statement),
    [PRODUCT_ELSEWHERE, PRODUCT_ROUTING],
  );
  // 全仓库条目(空作用范围)照常回,范围对不上的那条不回。
  assert.deepEqual(
    narrowed.repo.map((entry) => entry.statement),
    [FINANCE_RULE, OTHER_REPO_RULE],
  );
  const elsewhere = sessionKnowledge(dbPath, productId, repos, {
    repos: ["acme/widgets"],
    pathGlob: "web/**",
  });
  assert.deepEqual(elsewhere.repo, []);
});

test("两层各自封顶在历史 Finding 查询那一个常量", () => {
  const { dbPath, productId, repoIds } = storeWithProduct();
  const [widgets, orders] = repoIds as [number, number, number, number];
  for (let index = 0; index < FINDING_QUERY_LIMIT + 10; index += 1) {
    seedReviewRule(dbPath, widgets, { type: "rule", scope: "", statement: `第 ${index} 条规则` });
    seedProductKnowledge(dbPath, productId, `第 ${index} 条产品知识`, [widgets, orders]);
  }
  const entries = sessionKnowledge(dbPath, productId, productRepos(dbPath, productId), {
    repos: ["acme/widgets"],
  });

  assert.equal(entries.product.length, FINDING_QUERY_LIMIT);
  assert.equal(entries.repo.length, FINDING_QUERY_LIMIT);
});

test("作用范围与查询 glob 的重叠判据:省略即全匹配,两个都给时逐段互判", () => {
  // 查询 glob 省略或为空:问的是整个仓库,每条都算重叠。
  assert.equal(scopesOverlap("src/finance/**", undefined), true);
  assert.equal(scopesOverlap("src/finance/**", ""), true);
  // 条目是全仓库条目:任何查询都该看到它。
  assert.equal(scopesOverlap("", "web/**"), true);
  // 条目范围当模式命中查询 glob 这个字面路径。
  assert.equal(scopesOverlap("src/**", "src/finance/rate.ts"), true);
  // 反过来:查询 glob 当模式命中条目范围这个字面路径。
  assert.equal(scopesOverlap("src/finance/rate.ts", "src/**"), true);
  assert.equal(scopesOverlap("src/finance/**", "src/**"), true);
  // 通配符落在不同路径段:`src/api/handler.ts` 两边都命中,逐段互判才看得出来。
  assert.equal(scopesOverlap("src/*/handler.ts", "src/api/**"), true);
  assert.equal(scopesOverlap("**/handler.ts", "src/api/*.ts"), true);
  assert.equal(scopesOverlap("src/*/handler.ts", "src/api/*.js"), false);
  assert.equal(scopesOverlap("src/*/handler.ts", "web/**"), false);
  // `**` 粘在字面上:评审链路里它跨 `/`,`src/api/x.ts` 与 `src/x.ts` 都命中 `src/**.ts`。
  assert.equal(scopesOverlap("src/**.ts", "src/api/x.ts"), true);
  assert.equal(scopesOverlap("src/**.ts", "src/x.ts"), true);
  assert.equal(scopesOverlap("**handler.ts", "src/api/handler.ts"), true);
  assert.equal(scopesOverlap("src/api/**", "src/**.ts"), true);
  assert.equal(scopesOverlap("src/**.ts", "src/api/x.js"), false);
  assert.equal(scopesOverlap("src/**.ts", "web/**"), false);
  // 两边都对不上。
  assert.equal(scopesOverlap("src/finance/**", "web/**"), false);
  assert.equal(scopesOverlap("web/page.ts", "src/finance/rate.ts"), false);
});
