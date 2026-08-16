/**
 * 模型凭据端点(issue #64,ADR 0008)。走面板 API 的真实 HTTP 缝,不碰内部 handler。
 *
 * 厂商验证请求打在 `stub-fetch` 上——它对 127.0.0.1 直通,面板自己的 HTTP 缝与假
 * Gitea 因此不受打桩影响,被拦下的只有外发到厂商的那一次。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { buildReviewers } from "../src/config.ts";
import { encryptCredential } from "../src/panel/credential-crypto.ts";
import type { ReviewerOutcome } from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  PANEL_CREDENTIAL_MASTER_KEY,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { stubFetch, type Route } from "./support/stub-fetch.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** anthropic 的验证端点,`credential-check.ts` 里写死的那一个。 */
const ANTHROPIC_CHECK = "GET /v1/models?limit=1";
/** deepseek 的验证端点,OpenAI 兼容形状。 */
const DEEPSEEK_CHECK = "GET /models";

/** 装一次打桩并登记还原,免得漏掉 restore 把后续测试带偏。 */
function stub(routes: Record<string, Route>): ReturnType<typeof stubFetch> {
  const handle = stubFetch(routes);
  cleanups.push(handle.restore);
  return handle;
}

test("写入成功:验证请求真发出去,再读只拿到尾 4 位", async () => {
  const h = await startPanelHarness(cleanups);
  const calls = stub({ [ANTHROPIC_CHECK]: { body: { data: [] } } });

  const put = await h.api("PUT", "/credentials/anthropic", {
    apiKey: "sk-ant-secret-value-7788",
  });
  assert.equal(put.status, 200);
  const saved = (await put.json()) as {
    provider: string;
    last4: string;
    configured: boolean;
    verified: boolean;
  };
  assert.equal(saved.provider, "anthropic");
  assert.equal(saved.configured, true);
  assert.equal(saved.verified, true);
  assert.equal(saved.last4, "7788");

  // 验证请求确实打在了厂商端点上,带的是那一家认的认证头。
  assert.equal(calls.calls.length, 1);
  assert.equal(calls.calls[0]!.url, "https://api.anthropic.com/v1/models?limit=1");

  const list = await h.api("GET", "/credentials");
  assert.equal(list.status, 200);
  const text = await list.text();
  assert.ok(!text.includes("sk-ant-secret-value-7788"), "列表不该回显明文");
  const { credentials } = JSON.parse(text) as {
    credentials: { provider: string; configured: boolean; last4: string; updatedAt: string }[];
  };
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]!.provider, "anthropic");
  assert.equal(credentials[0]!.configured, true);
  assert.equal(credentials[0]!.last4, "7788");
  assert.ok(Date.parse(credentials[0]!.updatedAt) > 0);
});

test("落库的是密文:直接读库读不到明文", async () => {
  const h = await startPanelHarness(cleanups);
  stub({ [DEEPSEEK_CHECK]: { body: { data: [] } } });

  assert.equal(
    (await h.api("PUT", "/credentials/deepseek", { apiKey: "sk-deep-plain-0011" })).status,
    200,
  );

  const store = openStore(h.db.path);
  const rows = store.listModelCredentials();
  store.close();
  assert.equal(rows.length, 1);
  assert.ok(!rows[0]!.apiKeyEncrypted.includes("sk-deep-plain-0011"), "库里不该有明文");
});

test("验证失败:不落库,回报原因", async () => {
  const h = await startPanelHarness(cleanups);
  stub({ [ANTHROPIC_CHECK]: { status: 401, body: { error: "invalid x-api-key" } } });

  const put = await h.api("PUT", "/credentials/anthropic", { apiKey: "sk-ant-wrong" });
  assert.equal(put.status, 400);
  const { error } = (await put.json()) as { error: string };
  assert.match(error, /没有保存/);
  assert.match(error, /401/);

  const { credentials } = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: unknown[];
  };
  assert.deepEqual(credentials, []);
});

test("厂商回 5xx 也不落库,原因写明状态码", async () => {
  const h = await startPanelHarness(cleanups);
  stub({ [ANTHROPIC_CHECK]: { status: 503, body: {} } });

  const put = await h.api("PUT", "/credentials/anthropic", { apiKey: "sk-ant-any" });
  assert.equal(put.status, 400);
  assert.match(((await put.json()) as { error: string }).error, /503/);
});

test("认不出的 provider:照样保存,标成未验证,一个验证请求都不发", async () => {
  const h = await startPanelHarness(cleanups);
  const calls = stub({});

  const put = await h.api("PUT", "/credentials/unknownvendor", { apiKey: "sk-x-9911" });
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { configured: boolean; verified: boolean; last4: string };
  assert.equal(saved.configured, true);
  assert.equal(saved.verified, false);
  assert.equal(saved.last4, "9911");
  assert.deepEqual(calls.calls, [], "认不出的厂商不该有外发请求");

  // 列表把这个状态透出去,面板据此标「未验证」。
  const { credentials } = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: { provider: string; verified: boolean }[];
  };
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]!.provider, "unknownvendor");
  assert.equal(credentials[0]!.verified, false);
});

test("认得的 provider 验证不通过时仍然不落库", async () => {
  const h = await startPanelHarness(cleanups);
  stub({ [ANTHROPIC_CHECK]: { status: 401, body: {} } });

  assert.equal(
    (await h.api("PUT", "/credentials/anthropic", { apiKey: "sk-ant-wrong" })).status,
    400,
  );
  const { credentials } = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: unknown[];
  };
  assert.deepEqual(credentials, []);
});

test("同 provider 二次写入是覆盖,不是新增", async () => {
  const h = await startPanelHarness(cleanups);
  stub({ [DEEPSEEK_CHECK]: { body: { data: [] } } });

  assert.equal(
    (await h.api("PUT", "/credentials/deepseek", { apiKey: "sk-deep-first-1111" })).status,
    200,
  );
  assert.equal(
    (await h.api("PUT", "/credentials/deepseek", { apiKey: "sk-deep-second-2222" })).status,
    200,
  );

  const { credentials } = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: { provider: string; last4: string }[];
  };
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]!.last4, "2222");
});

test("解不开的密文按未配置透出,不抛", async () => {
  const h = await startPanelHarness(cleanups);
  // 主密钥换过之后库里留下的形态:密文还在,现在这把主密钥解不开。
  const store = openStore(h.db.path);
  store.putModelCredential("openai", "v1.aaaa.bbbb.cccc", "2026-08-16T00:00:00.000Z", true);
  store.close();

  const list = await h.api("GET", "/credentials");
  assert.equal(list.status, 200);
  const { credentials } = (await list.json()) as {
    credentials: { provider: string; configured: boolean; last4: string | null }[];
  };
  assert.deepEqual(credentials, [
    {
      provider: "openai",
      configured: false,
      verified: true,
      updatedAt: "2026-08-16T00:00:00.000Z",
      last4: null,
    },
  ] as unknown as typeof credentials);
});

test("删除:摘掉一家,再删一次照样 204", async () => {
  const h = await startPanelHarness(cleanups);
  stub({ [DEEPSEEK_CHECK]: { body: { data: [] } } });

  assert.equal(
    (await h.api("PUT", "/credentials/deepseek", { apiKey: "sk-deep-3333" })).status,
    200,
  );
  assert.equal((await h.api("DELETE", "/credentials/deepseek")).status, 204);
  assert.equal((await h.api("DELETE", "/credentials/deepseek")).status, 204);

  const { credentials } = (await (await h.api("GET", "/credentials")).json()) as {
    credentials: unknown[];
  };
  assert.deepEqual(credentials, []);
});

test("body 形状不对回 400,不发验证请求", async () => {
  const h = await startPanelHarness(cleanups);
  const calls = stub({});

  for (const body of [{}, { apiKey: "" }, { apiKey: 42 }]) {
    const put = await h.api("PUT", "/credentials/anthropic", body);
    assert.equal(put.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls.calls, []);
});

test("缺主密钥:凭据端点读写都拒绝并说明原因,其余面板照常", async () => {
  const h = await startPanelHarness(cleanups, { credentialMasterKey: undefined });

  for (const [method, path, body] of [
    ["GET", "/credentials", undefined],
    ["PUT", "/credentials/anthropic", { apiKey: "sk-ant-any" }],
    ["DELETE", "/credentials/anthropic", undefined],
  ] as const) {
    const response = await h.api(method, path, body);
    assert.equal(response.status, 503, `${method} ${path}`);
    const { error } = (await response.json()) as { error: string };
    assert.match(error, /MULTIREVIEWER_CREDENTIAL_MASTER_KEY/);
  }

  // 服务照常起、面板其余部分照常用——起不来就进不了面板,进不了面板就配不了凭据。
  assert.equal((await h.api("POST", "/repos", { owner: "acme", repo: "widgets" })).status, 201);
  const repos = await h.api("GET", "/repos");
  assert.equal(repos.status, 200);
  assert.equal(((await repos.json()) as { repoId: number }[])[0]!.repoId, GITEA_REPO.id);
});

/**
 * 凭据接进 Review Run(issue #65)。测在既有的组装缝上:harness 注入的
 * `buildReviewers` 就是服务真用的那一个入口,凭据快照是它的第二个入参。
 */

/** 直接落一把凭据,绕开面板的厂商验证——这几条测的是组装,不是保存。 */
function seedCredential(h: PanelHarness, provider: string, apiKey: string): void {
  const store = openStore(h.db.path);
  store.putModelCredential(
    provider,
    encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, apiKey),
    "2026-08-16T00:00:00.000Z",
    true,
  );
  store.close();
}

/** 等一个条件成立,超时即失败。轮询而非固定睡眠,慢机器上不会假失败。 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`等不到:${what}`);
}

test("缺凭据:投递照常受理,留下一条失败的 Review Run 并写明缺哪一家", async () => {
  // 真组装:库里一把凭据都没有,createPiReviewer 不会被建出来,也不起子进程。
  const h = await startPanelHarness(cleanups, { buildReviewers });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30 });
  store.close();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.failed, true);

  // 失败原因逐 Reviewer 落库,时间线上读得到缺的是哪一家。
  const sqlite = new DatabaseSync(h.db.path);
  try {
    const rows = sqlite.prepare("SELECT model, failure FROM reviewer_outcome").all() as {
      model: string;
      failure: string | null;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.model, "test:global-model");
    assert.match(rows[0]!.failure ?? "", /没有配置 test 的模型凭据/);
  } finally {
    sqlite.close();
  }
});

test("凭据在 Run 开始时快照一次,跑中改了不影响这一轮,下一次投递用新的", async () => {
  let release = (): void => {};
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await startPanelHarness(cleanups, {
    buildReviewers: (specs) =>
      specs.map((spec) => ({
        model: spec.model,
        review: async (): Promise<ReviewerOutcome> => {
          await gate;
          return {
            model: spec.model,
            findings: [],
            anomalies: [],
            rejectedToolCalls: 0,
            anchorRejections: 0,
          };
        },
      })),
  });
  seedCredential(h, "test", "key-one");
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await waitUntil(() => h.snapshots.length === 1, "第一轮取到凭据快照");

  // 这一轮还没跑完就轮转凭据。
  seedCredential(h, "test", "key-two");
  release();
  await h.settledAtLeast(1);

  // 快照只取一次,拿到的还是轮转前那一把。
  assert.equal(h.snapshots.length, 1);
  assert.deepEqual([...h.snapshots[0]!], [["test", "key-one"]]);

  gate = Promise.resolve();
  assert.equal((await h.deliverViaHook("sha-2")).status, 200);
  await h.settledAtLeast(2);
  assert.equal(h.snapshots.length, 2);
  assert.equal(h.snapshots[1]!.get("test"), "key-two");
});
