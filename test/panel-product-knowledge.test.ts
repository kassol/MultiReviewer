/**
 * 产品知识的那一段面板接口:手写维护(CONTEXT.md 产品知识,ADR 0032,issue #343)与提案的
 * 确认与驳回(issue #346)。
 *
 * 三条缝照旧:面板 API 走真实 HTTP,仓库注册打到假 Gitea,产品与产品知识行落临时 SQLite。
 * 压的是两票的验收:手写落生效列表并扛得过重载、退役之后不在列表里、三道校验各说一句
 * 中文、权限与可见性、升级前的旧库开起来新表在且为空;确认新增陈述即生效、确认退役提案把
 * 目标退役、驳回删掉提案并记住那句话、退役提案的驳回不记忆、两个动作的门禁。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import { recordProductSurveyProposals } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  scopedUser,
  seedRepo,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const PASSWORD = "product-knowledge-test-password";
const AT = "2026-09-13T00:00:00.000Z";
const ALPHA = 101;

type KnowledgeEntry = { id: number; statement: string; repoIds: number[] };
/** 一条待确认的提案。`retiresId` 不为空即退役提案,它的陈述是退役的理由(issue #345)。 */
type Proposal = KnowledgeEntry & { retiresId: number | null };
type Product = {
  id: number;
  name: string;
  repos: { repoId: number; owner: string; repo: string; role: string | null }[];
};

/** 一个带两个仓库的产品:产品知识至少要说到两个仓库,一个仓库的产品写不出条目。 */
async function productWithTwoRepos(h: PanelHarness): Promise<Product> {
  seedRepo(h, ALPHA, "acme", "alpha");
  const response = await h.api("POST", "/products", { name: "报销系统" });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const { product } = JSON.parse(text) as { product: Product };
  // 归属行直接落库:走归入端点会自己开一场梳理(issue #347),而这几例压的是手写维护。
  const store = openStore(h.db.path);
  try {
    for (const repoId of [GITEA_REPO.id, ALPHA]) {
      assert.equal(store.attachProductRepo(product.id, repoId, AT), "attached");
    }
  } finally {
    store.close();
  }
  return product;
}

async function detail(
  h: PanelHarness,
  productId: number,
  cookie?: string,
): Promise<{ product: Product; knowledge: KnowledgeEntry[]; proposals: Proposal[] }> {
  const path = `/api/products/${productId}`;
  const response =
    cookie === undefined
      ? await h.api("GET", `/products/${productId}`)
      : await fetch(`${h.serverUrl}${path}`, { headers: { cookie } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as {
    product: Product;
    knowledge: KnowledgeEntry[];
    proposals: Proposal[];
  };
}

/**
 * 播种一批产品梳理提案(issue #346):落一行产品梳理会话,再走产品梳理交出那一批的同一条路
 * 落库。确认与驳回压的是落库之后的事,不必起真子进程——那一路在
 * `agent-session-subprocess.test.ts`。
 */
function handIn(
  h: PanelHarness,
  productId: number,
  proposals: {
    statements?: readonly { statement: string; repos: readonly string[] }[];
    retirements?: readonly { id: number; reason: string }[];
  },
): void {
  const store = openStore(h.db.path);
  let session;
  try {
    session = store.createAgentSession({
      productId,
      createdBy: "system",
      purpose: "product-survey",
      createdAt: AT,
    });
  } finally {
    store.close();
  }
  recordProductSurveyProposals({ dbPath: h.db.path, now: () => Date.parse(AT) }, session, {
    statements: proposals.statements ?? [],
    retirements: proposals.retirements ?? [],
  });
}

/** 两个仓库写成产品梳理交出来的那种形式:子进程手上只有 `<owner>/<repo>`。 */
const BOTH_REPOS = [`${GITEA_REPO.owner}/${GITEA_REPO.repo}`, "acme/alpha"] as const;

function write(h: PanelHarness, productId: number, body: unknown, cookie?: string): Promise<Response> {
  const url = `${h.serverUrl}/api/products/${productId}/knowledge`;
  return cookie === undefined
    ? h.api("POST", `/products/${productId}/knowledge`, body)
    : fetch(url, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
}

/** 写一条产品知识并取回它。非 201 即带上正文断言失败。 */
async function writeEntry(
  h: PanelHarness,
  productId: number,
  body: unknown,
  cookie?: string,
): Promise<KnowledgeEntry> {
  const response = await write(h, productId, body, cookie);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { entry: KnowledgeEntry }).entry;
}

test("手写一条产品知识:落生效列表、扛得过重载,退役之后不在列表里", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);

  const entry = await writeEntry(h, product.id, {
    statement: "acme/widgets 的订单接口由 acme/alpha 的网关转发,契约是 OpenAPI",
    repoIds: [ALPHA, GITEA_REPO.id, ALPHA],
  });
  // 仓库集合升序去重:同一个仓库写两遍只算一个。
  assert.deepEqual(entry.repoIds, [ALPHA, GITEA_REPO.id].sort((a, b) => a - b));

  // 重载即再读一次详情:同一条在生效列表里,产品列表那一份一格没多。
  const reloaded = await detail(h, product.id);
  assert.deepEqual(reloaded.knowledge, [entry]);
  const listed = await h.api("GET", "/products");
  assert.deepEqual(Object.keys(((await listed.json()) as { products: unknown[] }).products[0]!), [
    "id",
    "name",
    "createdAt",
    "repos",
  ]);

  // 退役:从生效列表里消失,再读一次还是不在(退役落库,不只是这一次响应)。
  assert.equal(
    (await h.api("DELETE", `/products/${product.id}/knowledge/${entry.id}`)).status,
    204,
  );
  assert.deepEqual((await detail(h, product.id)).knowledge, []);

  // 退役两次不算成功:第二次那一条已经不生效了。
  const again = await h.api("DELETE", `/products/${product.id}/knowledge/${entry.id}`);
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { error: "没有这条生效的产品知识" });
});

test("写产品知识的三道校验各说一句中文", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const outside = seedRepo(h, 202, "acme", "beta");
  const statement = "acme/widgets 与 acme/alpha 共用一份订单状态枚举";

  const refusals: [unknown, string][] = [
    [{ statement, repoIds: [GITEA_REPO.id] }, "产品知识至少要说到这个产品里的两个仓库"],
    [{ statement, repoIds: [GITEA_REPO.id, GITEA_REPO.id] }, "产品知识至少要说到这个产品里的两个仓库"],
    [{ statement, repoIds: "两个" }, "产品知识至少要说到这个产品里的两个仓库"],
    [
      { statement, repoIds: [GITEA_REPO.id, outside] },
      `这个产品下没有 repo id 为 ${outside} 的仓库`,
    ],
    [{ statement: "   ", repoIds: [GITEA_REPO.id, ALPHA] }, "产品知识的陈述要是 1 到 100 个字符"],
    [
      { statement: "长".repeat(101), repoIds: [GITEA_REPO.id, ALPHA] },
      "产品知识的陈述要是 1 到 100 个字符",
    ],
  ];
  for (const [body, error] of refusals) {
    const response = await write(h, product.id, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error });
  }
  assert.deepEqual((await detail(h, product.id)).knowledge, []);

  // 100 字正好收下:上限与 agent 产出的陈述同一个数。
  await writeEntry(h, product.id, { statement: "长".repeat(100), repoIds: [GITEA_REPO.id, ALPHA] });
});

test("写与退役要 knowledge:write 加这个产品里的一个仓库分配,读不要", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const statement = "acme/widgets 的定时任务读 acme/alpha 落的那张队列表";
  const entry = await writeEntry(h, product.id, { statement, repoIds: [GITEA_REPO.id, ALPHA] });

  // 有仓库分配、没有这一格权限:读得到列表,写与退役一律 403。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  assert.deepEqual((await detail(h, product.id, reader)).knowledge, [entry]);
  const refused = await write(h, product.id, { statement, repoIds: [GITEA_REPO.id, ALPHA] }, reader);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "没有这一格权限" });
  const retire = await fetch(`${h.serverUrl}/api/products/${product.id}/knowledge/${entry.id}`, {
    method: "DELETE",
    headers: { cookie: reader },
  });
  assert.equal(retire.status, 403);
  assert.deepEqual(await retire.json(), { error: "没有这一格权限" });

  // 有这一格权限、却对这个产品里一个仓库都没分配:与产品不存在同形回 404。
  const stranger = seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["knowledge:write"]);
  const hidden = await write(
    h,
    product.id,
    { statement, repoIds: [GITEA_REPO.id, ALPHA] },
    outsider,
  );
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });

  // 有这一格权限又有产品内的仓库分配:写得进去。
  const writer = await scopedUser(h, "writer", PASSWORD, AT, [ALPHA], ["knowledge:write"]);
  await writeEntry(
    h,
    product.id,
    { statement: "acme/alpha 的网关把 acme/widgets 的错误码原样透出", repoIds: [GITEA_REPO.id, ALPHA] },
    writer,
  );
  assert.equal((await detail(h, product.id)).knowledge.length, 2);
});

test("升级前的旧库:开库建起产品知识表,列表为空、产品其它功能不变", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  await writeEntry(h, product.id, {
    statement: "acme/widgets 与 acme/alpha 的会话口令由同一个密钥签",
    repoIds: [GITEA_REPO.id, ALPHA],
  });

  // 把库退回升级之前的样子:那时这张表还不存在。
  const db = new DatabaseSync(h.db.path);
  db.exec("DROP TABLE product_knowledge");
  db.close();

  // 下一次开库把表建回来:一条条目都没有,产品与它的仓库一格不动。
  const after = await detail(h, product.id);
  assert.deepEqual(after.knowledge, []);
  assert.deepEqual(
    after.product.repos.map((row) => row.repoId),
    [ALPHA, GITEA_REPO.id].sort((a, b) => a - b),
  );
  assert.equal(after.product.name, "报销系统");
  // 新表空着,手写照样走得通。
  await writeEntry(h, product.id, {
    statement: "acme/alpha 的构建产物由 acme/widgets 的流水线发布",
    repoIds: [GITEA_REPO.id, ALPHA],
  });
  assert.equal((await detail(h, product.id)).knowledge.length, 1);
});

test("确认一条提案:新增陈述落生效,退役提案把目标退役、它自己消失", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const stale = await writeEntry(h, product.id, {
    statement: "acme/widgets 的订单接口由 acme/alpha 的网关转发",
    repoIds: [GITEA_REPO.id, ALPHA],
  });

  const fresh = "acme/alpha 的网关把 acme/widgets 的错误码原样透出";
  handIn(h, product.id, {
    statements: [{ statement: fresh, repos: BOTH_REPOS }],
    retirements: [{ id: stale.id, reason: "网关这一层已经撤掉了" }],
  });
  assert.equal((await detail(h, product.id)).proposals.length, 2);

  // 新增陈述那一档:确认即生效,提案列表少一条。
  const added = (await detail(h, product.id)).proposals.find((row) => row.retiresId === null)!;
  assert.equal(added.statement, fresh);
  assert.equal(
    (await h.api("POST", `/products/${product.id}/knowledge/${added.id}/accept`)).status,
    204,
  );
  const afterAdd = await detail(h, product.id);
  assert.deepEqual(
    afterAdd.knowledge.map((row) => row.statement).sort(),
    [fresh, stale.statement].sort(),
  );
  assert.equal(afterAdd.proposals.length, 1);

  // 退役提案那一档:目标从生效列表里消失,提案本身不留着——它不是一条要服务的知识。
  const retirement = afterAdd.proposals[0]!;
  assert.equal(retirement.retiresId, stale.id);
  assert.equal(
    (await h.api("POST", `/products/${product.id}/knowledge/${retirement.id}/accept`)).status,
    204,
  );
  const afterRetire = await detail(h, product.id);
  assert.deepEqual(
    afterRetire.knowledge.map((row) => row.statement),
    [fresh],
  );
  assert.deepEqual(afterRetire.proposals, []);

  // 同一条确认两遍不算成功:它已经不是提案了。
  const again = await h.api("POST", `/products/${product.id}/knowledge/${retirement.id}/accept`);
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { error: "没有这条待确认的产品知识提案" });
});

test("驳回一条提案:它消失、不生效,同一句话下一轮梳理不再提,同批其余几句照落", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const wrong = "acme/widgets 与 acme/alpha 共用一份订单状态枚举";
  const right = "acme/widgets 的定时任务读 acme/alpha 落的那张队列表";

  handIn(h, product.id, { statements: [{ statement: wrong, repos: BOTH_REPOS }] });
  const proposal = (await detail(h, product.id)).proposals[0]!;
  assert.equal(
    (await h.api("POST", `/products/${product.id}/knowledge/${proposal.id}/reject`)).status,
    204,
  );
  const after = await detail(h, product.id);
  assert.deepEqual(after.proposals, []);
  assert.deepEqual(after.knowledge, []);

  // 驳回两遍不算成功,与确认同一句回绝。
  const again = await h.api("POST", `/products/${product.id}/knowledge/${proposal.id}/reject`);
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { error: "没有这条待确认的产品知识提案" });

  // 下一轮梳理把同一句话连另一句一起交上来:被驳回过的那一句静默丢掉,另一句照落提案。
  handIn(h, product.id, {
    statements: [
      { statement: `  ${wrong}  `, repos: BOTH_REPOS },
      { statement: right, repos: BOTH_REPOS },
    ],
  });
  assert.deepEqual(
    (await detail(h, product.id)).proposals.map((row) => row.statement),
    [right],
  );
});

test("驳回一条退役提案不记忆:目标仍生效,下一轮梳理还提得动它", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  const entry = await writeEntry(h, product.id, {
    statement: "acme/widgets 的构建产物由 acme/alpha 的流水线发布",
    repoIds: [GITEA_REPO.id, ALPHA],
  });
  const reason = "流水线这一层已经换掉了";

  handIn(h, product.id, { retirements: [{ id: entry.id, reason }] });
  const first = (await detail(h, product.id)).proposals[0]!;
  assert.equal(
    (await h.api("POST", `/products/${product.id}/knowledge/${first.id}/reject`)).status,
    204,
  );
  // 目标仍生效:驳回的是提案,不是那条知识。
  assert.deepEqual((await detail(h, product.id)).knowledge, [entry]);

  // 再提一次提得动:目标下一轮梳理仍看得见,它再说一遍不成立本身是合理的。
  handIn(h, product.id, { retirements: [{ id: entry.id, reason }] });
  assert.deepEqual(
    (await detail(h, product.id)).proposals.map((row) => [row.statement, row.retiresId]),
    [[reason, entry.id]],
  );
});

test("确认与驳回要 knowledge:write 加这个产品里的一个仓库分配,读不要", async () => {
  const h = await startReadyPanelHarness({ registerRepo: true });
  const product = await productWithTwoRepos(h);
  handIn(h, product.id, {
    statements: [
      {
        statement: "acme/widgets 与 acme/alpha 的会话口令由同一个密钥签",
        repos: BOTH_REPOS,
      },
    ],
  });
  const proposal = (await detail(h, product.id)).proposals[0]!;
  const decide = (action: string, cookie: string): Promise<Response> =>
    fetch(`${h.serverUrl}/api/products/${product.id}/knowledge/${proposal.id}/${action}`, {
      method: "POST",
      headers: { cookie },
    });

  // 有仓库分配、没有这一格权限:读得到提案,两个动作一律 403。
  const reader = await scopedUser(h, "reader", PASSWORD, AT, [GITEA_REPO.id]);
  assert.equal((await detail(h, product.id, reader)).proposals.length, 1);
  for (const action of ["accept", "reject"]) {
    const refused = await decide(action, reader);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "没有这一格权限" });
  }

  // 有这一格权限、对这个产品里一个仓库都没分配:与产品不存在同形回 404。
  const stranger = seedRepo(h, 303, "acme", "gamma");
  const outsider = await scopedUser(h, "outsider", PASSWORD, AT, [stranger], ["knowledge:write"]);
  const hidden = await decide("accept", outsider);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "没有这个产品" });

  // 有这一格权限又有产品内的仓库分配:确认得动。
  const writer = await scopedUser(h, "writer", PASSWORD, AT, [ALPHA], ["knowledge:write"]);
  assert.equal((await decide("accept", writer)).status, 204);
  assert.equal((await detail(h, product.id)).knowledge.length, 1);
});
